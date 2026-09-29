/**
 * 任务队列补强（P018，ADR-006 可恢复任务）：RetryingRuntime 包裹内层 adapter。
 *
 * 职责：
 * - 图像成本护栏：genImage/editImage 启动前检查已用成本 + 单次预估，
 *   超上限直接拒绝（IMAGE_COST_LIMIT_EXCEEDED + needUserConfirmation 占位），
 *   不触达内层 adapter（不产生任何计费）；
 * - 启动级指数退避重试：内层 adapter.run 抛出瞬态错误（网络类）时退避重试
 *   （500ms → 1000ms，AICH_RUN_MAX_RETRIES 可配）；业务错误不重试；
 *   幂等键 = requestId（RunManager 已保证同键不重复启动，重试发生在同一 requestId 内）；
 * - 死信登记：重试耗尽 / 终态 error（用户主动取消除外）→ 内存清单 + 会话 jsonl
 *   kind:'error' 条目（deadQueue:true 元数据）；
 * - R024：REQUEST_CANCELLED 优先——取消不重试、不进死信（用户意图，非故障）。
 */

import type {
  AgentResponse,
  AgentRuntimePort,
  RunHandle,
  RunRequest,
  SseEventEnvelope,
} from "@aichdesign/shared";
import { ErrorCode, makeEnvelope } from "@aichdesign/shared";
import { AsyncQueue } from "./async-queue.js";
import { DEFAULT_RETRY_POLICY, isTransientError, withRetry } from "./retry.js";
import type { RetryPolicy } from "./retry.js";
import type { JsonlSessionStore } from "../session/jsonl-store.js";

/** 死信条目（重试耗尽或终态错误的登记详情）。 */
export interface DeadLetterEntry {
  requestId: string;
  sessionId: string;
  requestKind: string;
  code: string;
  message: string;
  /** 启动尝试次数（仅启动级重试路径有意义；终态错误路径为 1）。 */
  attempts: number;
  ts: string;
}

export interface TaskQueueOptions {
  inner: AgentRuntimePort;
  /** 启动级重试策略（默认 2 次退避 500ms 起）。 */
  policy?: Partial<RetryPolicy>;
  /** 会话 jsonl 存储（死信落盘；缺省仅内存清单）。 */
  sessionStore?: JsonlSessionStore;
  /** 图像成本护栏上限（美元）；≤0 关闭护栏。默认 0.5（AICH_IMAGE_COST_LIMIT_USD）。 */
  imageCostLimitUsd?: number;
  /** 已用图像成本查询（P018 接 UsageTracker.costUsdByKinds）。 */
  imageCostUsed?: () => number;
  /** 单次图像请求成本预估（美元）；默认 mock 口径 0.04（1024x1024 ≈ 1MP × $0.04/MP）。 */
  imageRequestEstimateUsd?: number;
}

/** 默认单次图像成本预估（gpt-image-2 medium 1024x1024 量级，README 登记口径）。 */
export const DEFAULT_IMAGE_REQUEST_ESTIMATE_USD = 0.04;

export class RetryingRuntime implements AgentRuntimePort {
  private readonly inner: AgentRuntimePort;
  private readonly policy: RetryPolicy;
  private readonly sessionStore?: JsonlSessionStore;
  private readonly imageCostLimitUsd: number;
  private readonly imageCostUsed?: () => number;
  private readonly imageRequestEstimateUsd: number;
  private readonly dead: DeadLetterEntry[] = [];

  constructor(options: TaskQueueOptions) {
    this.inner = options.inner;
    this.policy = { ...DEFAULT_RETRY_POLICY, ...options.policy };
    this.sessionStore = options.sessionStore;
    this.imageCostLimitUsd = options.imageCostLimitUsd ?? 0.5;
    this.imageCostUsed = options.imageCostUsed;
    this.imageRequestEstimateUsd = options.imageRequestEstimateUsd ?? DEFAULT_IMAGE_REQUEST_ESTIMATE_USD;
  }

  loadSkill(skill: Parameters<AgentRuntimePort["loadSkill"]>[0]): void {
    this.inner.loadSkill(skill);
  }

  registerExtension(ext: Parameters<AgentRuntimePort["registerExtension"]>[0]): void {
    this.inner.registerExtension(ext);
  }

  async dispose(): Promise<void> {
    await this.inner.dispose();
  }

  /** 死信清单（只读副本；P023 指标/人工排查用）。 */
  deadLetters(): readonly DeadLetterEntry[] {
    return [...this.dead];
  }

  async run(req: RunRequest): Promise<RunHandle> {
    // 1) 图像成本护栏（启动前，不触达内层 → 不计费）。
    if (req.request.kind === "genImage" || req.request.kind === "editImage") {
      const limit = this.imageCostLimitUsd;
      if (limit > 0) {
        const used = this.imageCostUsed?.() ?? 0;
        const estimate = this.imageRequestEstimateUsd;
        if (used + estimate > limit) {
          return rejectedRun(req, ErrorCode.IMAGE_COST_LIMIT_EXCEEDED, this.costGuardMessage(used, estimate, limit), {
            deadQueue: false,
            needUserConfirmation: true,
            usedUsd: Number(used.toFixed(4)),
            estimateUsd: estimate,
            limitUsd: limit,
          });
        }
      }
    }

    // 2) 启动级重试（仅瞬态网络类错误；业务错误原样抛给上层错误路径）。
    let handle: RunHandle;
    try {
      const outcome = await withRetry(() => this.inner.run(req), this.policy);
      handle = outcome.value;
    } catch (err) {
      // 重试耗尽（瞬态）或启动即业务失败 → 死信 + 终态 error 运行。
      // 错误码归一化：瞬态网络错误 → PROVIDER_UNAVAILABLE（errno 不是客户端语义）；
      // 业务错误保留原码；无码未知错误兜底 RUNNER_ERROR。
      const rawCode = (err as { code?: string }).code;
      const code = isTransientError(err)
        ? ErrorCode.PROVIDER_UNAVAILABLE
        : typeof rawCode === "string" && rawCode in ErrorCode
          ? (rawCode as ErrorCode)
          : ErrorCode.RUNNER_ERROR;
      const message = err instanceof Error ? err.message : String(err);
      const entry: DeadLetterEntry = {
        requestId: req.requestId,
        sessionId: req.sessionId,
        requestKind: req.request.kind,
        code,
        message,
        attempts: this.policy.maxRetries + 1,
        ts: new Date().toISOString(),
      };
      this.registerDeadLetter(entry);
      return rejectedRun(req, entry.code, `任务启动失败（已重试 ${entry.attempts} 次）：${entry.message}`, { deadQueue: true });
    }

    // 3) 终态观察：error 终局（非用户取消）→ 死信登记；结果原样透传不改动。
    void handle.result.then((response) => {
      if (response.kind === "error" && response.code !== ErrorCode.REQUEST_CANCELLED) {
        this.registerDeadLetter({
          requestId: req.requestId,
          sessionId: req.sessionId,
          requestKind: req.request.kind,
          code: response.code,
          message: response.message,
          attempts: 1,
          ts: new Date().toISOString(),
        });
      }
    });

    return handle;
  }

  private costGuardMessage(used: number, estimate: number, limit: number): string {
    return (
      `图像成本护栏：本会话图像已用约 $${used.toFixed(4)}，本次预估 $${estimate.toFixed(4)}，` +
      `超过上限 $${limit.toFixed(2)}（AICH_IMAGE_COST_LIMIT_USD）。已拒绝本次请求；` +
      `如需继续请在用户确认后上调上限或开启新会话。`
    );
  }

  private registerDeadLetter(entry: DeadLetterEntry): void {
    this.dead.push(entry);
    this.sessionStore?.append(
      entry.sessionId,
      "error",
      { deadQueue: true, code: entry.code, message: entry.message, attempts: entry.attempts, requestKind: entry.requestKind },
      entry.requestId,
    );
    process.stderr.write(
      `[task-queue] 死信登记 requestId=${entry.requestId} kind=${entry.requestKind} code=${entry.code} attempts=${entry.attempts}\n`,
    );
  }
}

/** 构造立即终态 error 的运行（护栏拒绝 / 死信）：单条 error 事件 + resolved error 结果。 */
function rejectedRun(
  req: RunRequest,
  code: string,
  message: string,
  extraData?: Record<string, unknown>,
): RunHandle {
  const queue = new AsyncQueue<SseEventEnvelope>();
  const response: AgentResponse = { kind: "error", code, message };
  queue.push(makeEnvelope(req.requestId, req.sessionId, "error", { code, message, ...extraData }));
  queue.close();
  return { events: queue, result: Promise.resolve(response), status: "failed" };
}
