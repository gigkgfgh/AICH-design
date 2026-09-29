/**
 * createMockChatStream：满足 pi-agent-core StreamFn 形状的 mock 流式实现。
 *
 * 事件协议（pi-ai 0.84.1）：start → text_* / toolcall_* → done | error，终态消息
 * stopReason 为 "stop"（文本结束）或 "toolUse"（工具调用，Agent Loop 继续执行）。
 *
 * 闭环策略（两轮）：
 * - 第一轮（context 中无 toolResult）：draftPlan → 注入 render_plan_svg 工具调用
 *   （variants 可多方案）；editPlan → 注入 plan_patch 工具调用；其他 → 纯文本；
 * - 第二轮（loop 执行工具后带 toolResult 再来）：输出总结文本（stop）。
 * 依赖 @earendil-works/pi-ai 0.84.1（锁定）；本文件仅供真实内核路径使用，
 * 依赖不可安装时由 MockAdapter（零 pi 依赖）顶替。
 */

import type { Context, Model, SimpleStreamOptions } from "@earendil-works/pi-ai";
import { createAssistantMessageEventStream, type AssistantMessageEventStream } from "@earendil-works/pi-ai";
import type {
  AssistantMessage,
  TextContent,
  ToolCall,
  Usage,
} from "@earendil-works/pi-ai";
import type { Api } from "@earendil-works/pi-ai";
import type { AgentRequest } from "@aichdesign/shared";
import {
  buildMockReply,
  buildMockSummaryText,
  isEditIntent,
  type MockToolCall,
} from "./replies.js";

export interface MockStreamOptions {
  /** 每个文本分片之间的模拟延迟（毫秒），默认 8。 */
  delayMs?: number;
  /** 分片大小（字符），默认 6。 */
  chunkSize?: number;
}

const DEFAULT_OPTIONS: Required<MockStreamOptions> = { delayMs: 8, chunkSize: 6 };

/** mock 模型成本（$ / token 近似值，仅供埋点演示；真实成本以 provider 为准）。 */
export const MOCK_MODEL_COST = { input: 0.0000025, output: 0.00001, cacheRead: 0, cacheWrite: 0 };

/** 构造 mock Model（供 PiAgentCoreAdapter 在 mock provider 模式下使用）。 */
export function createMockModel(): Model<Api> {
  return {
    id: "mock-model-0.1",
    name: "AICH Design Mock",
    api: "openai-responses",
    provider: "mock",
    baseUrl: "builtin://mock",
    reasoning: false,
    input: ["text"],
    cost: { ...MOCK_MODEL_COST },
    contextWindow: 200000,
    maxTokens: 4096,
  };
}

/** 从 Context 提取最后一条用户消息文本（含多内容块拼接）。 */
export function extractLastUserText(context: Context): string {
  for (let i = context.messages.length - 1; i >= 0; i -= 1) {
    const msg = context.messages[i];
    if (msg?.role !== "user") continue;
    const content = msg.content;
    if (typeof content === "string") return content;
    return (content as { text?: string }[])
      .filter((c) => c.text !== undefined)
      .map((c) => c.text)
      .join("");
  }
  return "";
}

/** 提取已执行工具名（第二轮总结用）。 */
export function lastToolNames(context: Context): string[] {
  const names: string[] = [];
  for (const msg of context.messages) {
    if (msg.role === "toolResult") names.push(msg.toolName);
  }
  return names;
}

/** 构造 assistant 首次消息（start 事件用的空壳）。 */
function makePartial(model: Model<Api>): AssistantMessage {
  const usage: Usage = {
    input: 0,
    output: 0,
    cacheRead: 0,
    cacheWrite: 0,
    totalTokens: 0,
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
  };
  return {
    role: "assistant",
    content: [],
    api: model.api,
    provider: "mock",
    model: model.id,
    usage,
    stopReason: "pending",
    timestamp: Date.now(),
  };
}

/** 将 mock 工具调用转换为 pi ToolCall 块。 */
function toToolCall(tc: MockToolCall): ToolCall {
  return { type: "toolCall", id: tc.id, name: tc.name, arguments: tc.arguments };
}

const sleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

/**
 * 构造 StreamFn：入参为 pi-agent-core 期望的 (model, context, options)。
 * requestHint 为主进程传入的完整请求（精确意图；缺省时按 prompt 关键词推断）。
 * 返回 AssistantMessageEventStream；文本按模拟延迟逐片推送后以 done 收尾。
 */
export function createMockChatStream(
  mockOptions: MockStreamOptions = {},
  requestHint?: AgentRequest,
): (model: Model<Api>, context: Context, options?: SimpleStreamOptions) => AssistantMessageEventStream {
  const opts: Required<MockStreamOptions> = { ...DEFAULT_OPTIONS, ...mockOptions };

  return (model: Model<Api>, context: Context): AssistantMessageEventStream => {
    const stream = createAssistantMessageEventStream();
    const partial = makePartial(model);
    const prompt = extractLastUserText(context);
    const toolResultsSeen = context.messages.some((m) => m.role === "toolResult");
    const request: AgentRequest =
      requestHint ??
      ({
        kind: isEditIntent(prompt) ? "editPlan" : "draftPlan",
        sessionId: "",
        prompt,
      } as AgentRequest);

    // 异步推流（不阻塞 streamFn 返回）。
    void (async () => {
      try {
        if (toolResultsSeen) {
          // 第二轮：总结文本。
          const text = buildMockSummaryText(request, lastToolNames(context));
          await streamText(stream, partial, text, opts, "stop");
          return;
        }
        const reply = buildMockReply(request);
        if (reply.toolCalls.length > 0) {
          const calls = reply.toolCalls.map(toToolCall);
          partial.stopReason = "toolUse";
          partial.content = calls;
          stream.push({ type: "start", partial });
          for (const call of calls) {
            stream.push({
              type: "toolcall_delta",
              contentIndex: 0,
              delta: JSON.stringify(call.arguments),
              partial,
            });
          }
          const msg = { ...partial, stopReason: "toolUse" as const };
          stream.push({ type: "done", reason: "toolUse", message: msg });
          stream.end(msg);
          return;
        }
        await streamText(stream, partial, reply.text, opts, "stop");
      } catch (error) {
        partial.stopReason = "error";
        partial.errorMessage = error instanceof Error ? error.message : String(error);
        stream.push({ type: "error", reason: "error", error: partial });
        stream.end();
      }
    })();

    return stream;
  };
}

/** 逐片推送文本并终止。 */
async function streamText(
  stream: AssistantMessageEventStream,
  partial: AssistantMessage,
  text: string,
  opts: Required<MockStreamOptions>,
  reason: "stop" | "length",
): Promise<void> {
  const textContent: TextContent = { type: "text", text };
  const msg: AssistantMessage = {
    ...partial,
    content: [textContent],
    stopReason: reason,
    usage: {
      input: 120,
      output: text.length,
      cacheRead: 0,
      cacheWrite: 0,
      totalTokens: 120 + text.length,
      cost: {
        input: 120 * MOCK_MODEL_COST.input,
        output: text.length * MOCK_MODEL_COST.output,
        cacheRead: 0,
        cacheWrite: 0,
        total: 120 * MOCK_MODEL_COST.input + text.length * MOCK_MODEL_COST.output,
      },
    },
  };
  stream.push({ type: "start", partial: msg });
  if (text.length > 0) {
    stream.push({ type: "text_start", contentIndex: 0, partial: msg });
    for (let i = 0; i < text.length; i += opts.chunkSize) {
      const delta = text.slice(i, i + opts.chunkSize);
      stream.push({ type: "text_delta", contentIndex: 0, delta, partial: msg });
      if (opts.delayMs > 0) await sleep(opts.delayMs);
    }
    stream.push({ type: "text_end", contentIndex: 0, content: text, partial: msg });
  }
  stream.push({ type: "done", reason, message: msg });
  stream.end(msg);
}