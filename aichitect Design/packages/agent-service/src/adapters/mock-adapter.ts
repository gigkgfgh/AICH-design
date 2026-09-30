/**
 * MockAdapter：AgentRuntimePort 的零 pi 依赖兜底实现（依赖不可装 / AICH_ADAPTER=mock）。
 *
 * 行为与 PiAgentCoreAdapter 的 SSE 语义对齐：
 * - genImage → delta 提示 → image_generate 绑定 → ImageRegistry 落盘 → done(image)；
 * - editImage → delta 提示 → image_edit 绑定（参考图经 ImageRegistry resolve）→ done(image)；
 * - chat / research → delta + done(stream)（mock 确定性文案）；
 * - 取消（外部 signal）→ error(REQUEST_CANCELLED)。
 * usage/cost 按 mock 常量计算并走同一 usageSink 管线（C-6）。
 */

import type {
  AgentRuntimePort,
  AgentResponse,
  RunHandle,
  RunRequest,
  RunStatus,
  SseEventEnvelope,
} from "@aichdesign/shared";
import { ErrorCode, makeEnvelope } from "@aichdesign/shared";
import type { SseUsageData } from "@aichdesign/shared";
import { buildMockReply, MOCK_MODEL_COST } from "@aichdesign/mock-provider";
import { AsyncQueue } from "../runtime/async-queue.js";
import { JsonlSessionStore } from "../session/jsonl-store.js";
import type { UsageRecord } from "../telemetry/usage-tracker.js";
import { findBinding, promptOf, type ToolBinding } from "./common.js";
import type { ImageApiResult } from "./image-api.js";
import type { ImageRegistry, RegisteredImage } from "../image/image-registry.js";

export interface MockAdapterOptions {
  tools: ToolBinding[];
  usageSink: (r: UsageRecord) => void;
  sessionStore?: JsonlSessionStore;
  /** P012/B-4：图像产物落盘 + 会话元数据注册（genImage/editImage 链路）。 */
  imageRegistry?: ImageRegistry;
  /** 模拟延迟（毫秒），默认 30。 */
  delayMs?: number;
}

const MODEL_ID = "mock-model-0.1";
const PROVIDER = "mock";

export class MockAdapter implements AgentRuntimePort {
  private readonly options: MockAdapterOptions;
  private disposed = false;

  constructor(options: MockAdapterOptions) {
    this.options = options;
  }

  loadSkill(): void {
    // Mock 路径无技能加载语义（L1 元数据随系统提示词由主进程维护）。
  }

  registerExtension(): void {
    // 工具静态注册于 options.tools。
  }

  async dispose(): Promise<void> {
    this.disposed = true;
  }

  private sleep(ms: number, signal?: AbortSignal): Promise<void> {
    return new Promise((resolve) => {
      if (signal?.aborted) {
        resolve();
        return;
      }
      const timer = setTimeout(resolve, ms);
      signal?.addEventListener(
        "abort",
        () => {
          clearTimeout(timer);
          resolve();
        },
        { once: true },
      );
    });
  }

  async run(req: RunRequest): Promise<RunHandle> {
    if (this.disposed) {
      throw new Error("adapter 已关闭");
    }
    const { tools, usageSink, sessionStore, imageRegistry, delayMs } = this.options;
    const queue = new AsyncQueue<SseEventEnvelope>();
    const startedAt = Date.now();
    const { requestId, sessionId, signal } = req;
    const userPrompt = promptOf(req.request);
    sessionStore?.append(sessionId, "user", { text: userPrompt, kind: req.request.kind }, requestId);

    const outcomePromise = (async () => {
      let final: AgentResponse;
      try {
        if (signal?.aborted) {
          throwObject(ErrorCode.REQUEST_CANCELLED, "请求已取消");
        }

        if (req.request.kind === "genImage" || req.request.kind === "editImage") {
          // P012：图像请求 → image_generate / image_edit 工具绑定 → 落盘 → done(image)。
          const phase = req.request.kind === "genImage" ? "image_generate" : "image_edit";
          const label = req.request.kind === "genImage" ? "图像生成" : "图像编辑";
          queue.push(
            makeEnvelope(requestId, sessionId, "delta", {
              delta: req.request.kind === "genImage" ? "正在生成建筑表现图…" : "正在基于参考图编辑表现图…",
            }),
          );
          // P1 修复（R2-REV 前回退）：图像工具执行期间发 progress（契约 SseProgressData.phase
          // 含 image_generate/image_edit，shared contracts.ts L157；done 前必发，冒烟断言 sawProgress）。
          queue.push(
            makeEnvelope(requestId, sessionId, "progress", {
              phase,
              percent: 30,
              message: `${label}中（30%）…`,
            }),
          );
          await this.sleep(delayMs ?? 30, signal);
          if (signal?.aborted) throwObject(ErrorCode.REQUEST_CANCELLED, "请求已取消");
          const toolName = req.request.kind === "genImage" ? "image_generate" : "image_edit";
          const binding = findBinding(tools, toolName);
          if (!binding) {
            throwObject(ErrorCode.RUNNER_ERROR, `mock 链路缺少工具绑定 ${toolName}`);
          }
          const params: Record<string, unknown> =
            req.request.kind === "genImage"
              ? { prompt: req.request.prompt, size: "1024x1024", quality: "medium", outputFormat: "png", n: 1 }
              : imageEditParams(req.request, imageRegistry);
          // percent 递增（30 → 80），done 前至少 1 条（契约 SseProgressData）。
          queue.push(
            makeEnvelope(requestId, sessionId, "progress", {
              phase,
              percent: 80,
              message: `${label}合成中（80%）…`,
            }),
          );
          const result = await binding.execute(params, signal);
          if (signal?.aborted) throwObject(ErrorCode.REQUEST_CANCELLED, "请求已取消");
          if (result.isError) {
            throwObject(ErrorCode.RUNNER_ERROR, `mock 图像工具执行失败：${result.text}`);
          }
          const details = result.details as ImageApiResult | undefined;
          if (details?.imageId && details.url && details.meta) {
            const stored: RegisteredImage = imageRegistry
              ? imageRegistry.store(sessionId, details, imageContext(req.request))
              : { imageId: details.imageId, url: details.url, meta: details.meta };
            final = { kind: "image", imageId: stored.imageId, url: stored.url, meta: stored.meta };
          } else {
            final = { kind: "stream", delta: result.text };
          }
        } else if (req.request.kind === "research" || req.request.kind === "chat") {
          // R5/R7-1：调研与通用对话（mock 确定性文案；真实路径走对应预设 + 工具）。
          queue.push(makeEnvelope(requestId, sessionId, "delta", { delta: "正在整理回复…" }));
          await this.sleep(delayMs ?? 30, signal);
          if (signal?.aborted) throwObject(ErrorCode.REQUEST_CANCELLED, "请求已取消");
          const reply =
            req.request.kind === "research"
              ? `【调研纪要（mock）】${userPrompt}\n\n1. 案例参考与规范要点建议以实时检索为准。\n\n（联网检索未启用：在「设置 → 联网检索」配置后可获取实时案例与来源链接）`
              : buildMockReply(req.request).text;
          queue.push(makeEnvelope(requestId, sessionId, "delta", { delta: reply }));
          final = { kind: "stream", delta: reply };
        } else {
          const reply = buildMockReply(req.request);
          queue.push(makeEnvelope(requestId, sessionId, "delta", { delta: reply.text }));
          await this.sleep(delayMs ?? 30, signal);
          if (signal?.aborted) throwObject(ErrorCode.REQUEST_CANCELLED, "请求已取消");
          final = { kind: "stream", delta: reply.text };
        }
      } catch (error) {
        // NOTICE：imageEditParams 可能抛 INVALID_REQUEST（参考图未注册）——保留原业务码，
        // 而非笼统归 RUNNER_ERROR（错误码表见 shared/src/errors.ts）。
        const code = isCancelledError(error)
          ? ErrorCode.REQUEST_CANCELLED
          : ((error as { code?: string }).code ?? ErrorCode.RUNNER_ERROR);
        const message = error instanceof Error ? error.message : String(error);
        final = { kind: "error", code, message };
      }

      // usage/cost 埋点（mock 常量成本，仅供演示聚合）。
      const tokens = 120 + (final.kind === "stream" ? final.delta.length : 128);
      const rec: UsageRecord = {
        sessionId,
        requestId,
        requestKind: req.request.kind,
        model: MODEL_ID,
        provider: PROVIDER,
        promptTokens: 120,
        completionTokens: tokens - 120,
        cacheReadTokens: 0,
        cacheWriteTokens: 0,
        totalTokens: tokens,
        costUsd: 120 * MOCK_MODEL_COST.input + (tokens - 120) * MOCK_MODEL_COST.output,
        latencyMs: Date.now() - startedAt,
        ok: final.kind !== "error",
        code: final.kind === "error" ? final.code : undefined,
        ts: new Date().toISOString(),
      };
      usageSink(rec);
      sessionStore?.append(sessionId, "usage", rec, requestId);

      // R7-2：mock 合成用量（确定性近似值；真实链路为 API 实报值）。
      const mockOutput = final.kind === "stream" ? final.delta.length : 128;
      const mockUsage: SseUsageData = {
        promptTokens: 1200 + Math.floor(userPrompt.length / 4),
        completionTokens: mockOutput,
        cacheReadTokens: 0,
        cacheWriteTokens: 0,
        totalTokens: 1200 + Math.floor(userPrompt.length / 4) + mockOutput,
        context: { systemTokens: 320, toolTokens: 900, contextWindow: 128_000 },
      };
      queue.push(makeEnvelope(requestId, sessionId, "usage", mockUsage));
      if (final.kind === "error") {
        queue.push(makeEnvelope(requestId, sessionId, "error", { code: final.code, message: final.message }));
      } else {
        queue.push(makeEnvelope(requestId, sessionId, "done", final));
        sessionStore?.append(
          sessionId,
          "assistant",
          {
            kind: final.kind,
            text: final.kind === "stream" ? final.delta : undefined,
            imageId: final.kind === "image" ? final.imageId : undefined,
            url: final.kind === "image" ? final.url : undefined,
          },
          requestId,
        );
      }
      queue.close();
      return final;
    })();

    return {
      events: queue,
      result: outcomePromise,
      status: "running" as RunStatus,
    };
  }
}

function throwObject(code: string, message: string): never {
  const err = new Error(message);
  (err as { code?: string }).code = code;
  throw err;
}

function isCancelledError(error: unknown): boolean {
  return error instanceof Error && (error as { code?: string }).code === ErrorCode.REQUEST_CANCELLED;
}

/** editImage：参考图/遮罩经 ImageRegistry 解析为已注册 file:// URL（版本树回退/编辑链路）。 */
function imageEditParams(request: Extract<RunRequest["request"], { kind: "editImage" }>, registry?: ImageRegistry): Record<string, unknown> {
  const referenceUrl = registry?.resolveUrl(request.imageId);
  if (!referenceUrl) {
    throwObject(ErrorCode.INVALID_REQUEST, `image_edit 参考图不存在：${request.imageId}（会话内未注册）`);
  }
  const maskUrl = request.maskId ? registry?.resolveUrl(request.maskId) : undefined;
  if (request.maskId && !maskUrl) {
    throwObject(ErrorCode.INVALID_REQUEST, `image_edit 遮罩不存在：${request.maskId}（会话内未注册）`);
  }
  return {
    images: [referenceUrl],
    prompt: request.prompt,
    mask: maskUrl,
    size: "1024x1024",
    quality: "medium",
    outputFormat: "png",
    n: 1,
  };
}

/** B-4 注册上下文（editImage → parentImageId/maskId）。 */
function imageContext(request: RunRequest["request"]): { parentImageId?: string; maskId?: string } {
  if (request.kind === "editImage") {
    return { parentImageId: request.imageId, maskId: request.maskId };
  }
  return {};
}