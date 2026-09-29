/**
 * RunManager：requestId → 运行的注册表 + 状态机（ADR-006：幂等键 = requestId）。
 *
 * - start：首次注册并启动；重复 requestId 返回既有状态（断网重试不重复计费/生成）；
 * - 终态缓存：done/error 后保留事件缓冲（GET /v1/stream 重连可回放，ADR-004.3）；
 * - cancel：中止在途运行（外部 AbortController 信号），终态 error(REQUEST_CANCELLED)。
 */

import type { AgentResponse, SseEventEnvelope } from "@aichdesign/shared";
import { ErrorCode } from "@aichdesign/shared";
import type { AgentRuntimePort, RunRequest } from "@aichdesign/shared";
import { AsyncQueue } from "./async-queue.js";

export type RunState =
  | { status: "queued" | "running"; handle: RunHandleRecord }
  | { status: "succeeded" | "failed" | "cancelled"; response: AgentResponse; events: SseEventEnvelope[] };

interface RunHandleRecord {
  abort: () => void;
  events: AsyncIterable<SseEventEnvelope>;
  result: Promise<AgentResponse>;
  queuedAt: number;
}

export class RunManager {
  private readonly runs = new Map<string, RunState>();
  /** 终态落定时间（R014 清理依据；key 与 runs 中的终态条目一一对应）。 */
  private readonly terminalAt = new Map<string, number>();
  /** P016：requestId → sessionId 绑定（stream/cancel 会话 token 校验依据；随终态清理回收）。 */
  private readonly sessionIds = new Map<string, string>();

  /** 终态保留 TTL：10 分钟（R014 轻量版；P023 阶段正式落地指标/持久化）。 */
  private static readonly TERMINAL_TTL_MS = 10 * 60 * 1000;
  /** 终态缓存上限（R014：防长活内存线性增长）。 */
  private static readonly TERMINAL_CAP = 100;

  constructor(private readonly adapter: AgentRuntimePort) {}

  /**
   * 终态清理钩子（R014）：TTL 过期 + 容量上限（保留最新 N 条）。
   * 备注：TTL 过期后同 requestId 重发将视为新运行（幂等窗口 = 终态保留期）。
   */
  private sweepTerminals(): void {
    const now = Date.now();
    for (const [requestId, at] of this.terminalAt) {
      if (now - at > RunManager.TERMINAL_TTL_MS) {
        this.runs.delete(requestId);
        this.terminalAt.delete(requestId);
        this.sessionIds.delete(requestId);
      }
    }
    const overflow = this.terminalAt.size - RunManager.TERMINAL_CAP;
    if (overflow > 0) {
      const oldest = [...this.terminalAt.entries()].sort((a, b) => a[1] - b[1]);
      for (let i = 0; i < overflow; i += 1) {
        const [requestId] = oldest[i]!;
        this.runs.delete(requestId);
        this.terminalAt.delete(requestId);
        this.sessionIds.delete(requestId);
      }
    }
  }

  /** P016：requestId 所属会话（未注册/已清理返回 null）。 */
  sessionIdOf(requestId: string): string | null {
    this.sweepTerminals();
    return this.sessionIds.get(requestId) ?? null;
  }

  /** 已注册的 requestId（含终态；触发清理钩子）。 */
  has(requestId: string): boolean {
    this.sweepTerminals();
    return this.runs.has(requestId);
  }

  get(requestId: string): RunState | null {
    this.sweepTerminals();
    return this.runs.get(requestId) ?? null;
  }

  /**
   * 启动运行（幂等）：已存在返回既有状态；否则用 adapter.run 启动并登记。
   * 返回值：{ launched: boolean; state: RunState }。
   */
  async start(request: RunRequest): Promise<{ launched: boolean; state: RunState }> {
    this.sweepTerminals();
    const existing = this.runs.get(request.requestId);
    if (existing) {
      return { launched: false, state: existing };
    }

    const abortController = new AbortController();
    const runRequest: RunRequest = {
      ...request,
      signal: combineSignals(request.signal, abortController.signal),
    };
    const handle = await this.adapter.run(runRequest);
    const record: RunHandleRecord = {
      abort: () => abortController.abort(),
      events: handle.events,
      result: handle.result,
      queuedAt: Date.now(),
    };

    // 运行中的状态：pending，待 result settle 后切终态。
    this.runs.set(request.requestId, { status: "running", handle: record });
    this.sessionIds.set(request.requestId, request.sessionId);

    void handle.result.then(async (response) => {
      const finalStatus: RunState["status"] =
        response.kind === "error"
          ? response.code === ErrorCode.REQUEST_CANCELLED
            ? "cancelled"
            : "failed"
          : "succeeded";
      // R6-13：终态缓存改用队列全量存档（push 即记录）——原 collectEvents 以第二消费者身份
      // 与实时 SSE 消费者争抢单消费者队列，回放快照可能残缺。非 AsyncQueue 实现保留回退。
      const events =
        record.events instanceof AsyncQueue
          ? record.events.snapshot()
          : await collectEvents(record.events);
      this.runs.set(request.requestId, {
        status: finalStatus,
        response,
        events,
      });
      // R014：终态落定时间登记（供 TTL / 容量清理钩子）。
      this.terminalAt.set(request.requestId, Date.now());
    });

    return { launched: true, state: this.runs.get(request.requestId)! };
  }

  /** 取消在途运行；终态/不存在返回 false。 */
  cancel(requestId: string): boolean {
    this.sweepTerminals();
    const state = this.runs.get(requestId);
    if (!state) return false;
    if (state.status === "running" || state.status === "queued") {
      state.handle.abort();
      return true;
    }
    return false;
  }

  /** 在途运行数量（诊断/指标）。 */
  activeCount(): number {
    let n = 0;
    for (const state of this.runs.values()) {
      if (state.status === "queued" || state.status === "running") n += 1;
    }
    return n;
  }

  /** 全部 requestId（P023 指标仪表可枚举）。 */
  keys(): string[] {
    return [...this.runs.keys()];
  }
}

/** 收集 handle 事件为完整快照（终态缓存用）。 */
async function collectEvents(events: AsyncIterable<SseEventEnvelope>): Promise<SseEventEnvelope[]> {
  const list: SseEventEnvelope[] = [];
  for await (const event of events) {
    list.push(event);
  }
  return list;
}

/** 合并外部与内部取消信号（任一触发即取消）。 */
function combineSignals(a: AbortSignal | undefined, b: AbortSignal): AbortSignal {
  if (!a) return b;
  const controller = new AbortController();
  const onAbort = () => controller.abort();
  if (a.aborted) controller.abort();
  else a.addEventListener("abort", onAbort, { once: true });
  b.addEventListener("abort", onAbort, { once: true });
  return controller.signal;
}