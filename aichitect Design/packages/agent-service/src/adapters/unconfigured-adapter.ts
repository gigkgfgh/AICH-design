/**
 * UnconfiguredAdapter：LLM 端点未配置时的 AgentRuntimePort 实现（fail-closed）。
 *
 * 与 pi 内核路径的区别：本实现**不产生任何模拟/占位回复**，run() 立即返回一条
 * 明确的错误信封，引导用户完成配置。
 *
 * 之所以保留「服务照常启动」而非拒绝启动：未配置属于用户可自助修复的配置态，
 * 让服务保持就绪可在保存配置后仅重启服务即可恢复，无需重开应用。
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
import { AsyncQueue } from "../runtime/async-queue.js";

/** 未配置提示文案（UI 直接展示，须可操作）。 */
export const UNCONFIGURED_LLM_MESSAGE =
  "未配置 LLM 端点：请在「设置 → LLM 端点」填写 Base URL、模型与 API Key，保存后重启本地服务";

export class UnconfiguredAdapter implements AgentRuntimePort {
  loadSkill(): void {
    // 未配置态不加载技能。
  }

  registerExtension(): void {
    // 工具静态注册于调用方传入的绑定表。
  }

  async dispose(): Promise<void> {
    // 无资源可释放。
  }

  async run(req: RunRequest): Promise<RunHandle> {
    const { requestId, sessionId, signal } = req;
    const queue = new AsyncQueue<SseEventEnvelope>();

    const code = signal?.aborted ? ErrorCode.REQUEST_CANCELLED : ErrorCode.PROVIDER_UNAVAILABLE;
    const message = signal?.aborted ? "请求已取消" : UNCONFIGURED_LLM_MESSAGE;

    queue.push(makeEnvelope(requestId, sessionId, "error", { code, message }));
    queue.close();

    const response: AgentResponse = { kind: "error", code, message };
    return {
      events: queue,
      result: Promise.resolve(response),
      status: (signal?.aborted ? "cancelled" : "failed") as RunStatus,
    };
  }
}
