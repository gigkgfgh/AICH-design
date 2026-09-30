/**
 * 零依赖 mock 对话策略：请求 kind / 关键词 → 回复意图（文本 / 图像工具调用）。
 *
 * 本文件不依赖任何 pi 包类型，供两条路径共享：
 * - createMockChatStream（pi-ai 事件流，PiAgentCoreAdapter 的 streamFn）；
 * - MockAdapter（依赖不可装时的兜底实现，直接消费本文件产物）。
 *
 * R7-1：方案（draftPlan/editPlan）mock 分支随方案链路移除；chat 走纯文本回复。
 */

import type { AgentRequest } from "@aichdesign/shared";

/** 工具调用的本地结构形状（与 pi-ai ToolCall 结构兼容，adapter 断言转换）。 */
export interface MockToolCall {
  type: "toolCall";
  id: string;
  name: "image_generate" | "image_edit" | string;
  arguments: Record<string, unknown>;
}

/** 回复意图判定与构造结果。 */
export interface MockReplyPlan {
  /** 应注入的工具调用（Agent Loop 会继续执行并进入下一轮）。 */
  toolCalls: MockToolCall[];
  /** 直接文本回复（无工具调用时使用）。 */
  text: string;
}

/** 简单确定性 id（避免依赖 uuid 包）。 */
function mockId(prefix: string): string {
  return `${prefix}_${Date.now().toString(36)}_${Math.floor(Math.random() * 1e9).toString(36)}`;
}

/**
 * 构造 mock 工具调用（第一轮）：
 * genImage → image_generate；editImage → image_edit（参考图 id 占位，
 * 经 ImageRegistry 解析为已注册 file URL；mock 层不真正读取参考图内容）。
 * 返回空数组时调用方回退文本回复。
 */
export function buildMockToolCalls(request: AgentRequest): MockToolCall[] {
  if (request.kind === "genImage") {
    return [
      {
        type: "toolCall",
        id: mockId("tc"),
        name: "image_generate",
        arguments: { prompt: request.prompt, size: "1024x1024", quality: "medium", outputFormat: "png", n: 1 },
      },
    ];
  }
  if (request.kind === "editImage") {
    return [
      {
        type: "toolCall",
        id: mockId("tc"),
        name: "image_edit",
        arguments: { images: [`mock-image-ref:${request.imageId}`], prompt: request.prompt, size: "1024x1024", quality: "medium", outputFormat: "png", n: 1 },
      },
    ];
  }
  return [];
}

/** 构造最终总结文本（第二轮，工具结果后的收尾）。 */
export function buildMockSummaryText(request: AgentRequest, toolNames: string[]): string {
  if (request.kind === "genImage" || request.kind === "editImage") {
    return `已${request.kind === "genImage" ? "生成表现图" : "基于参考图完成编辑"}（mock 图像，离线可复现）。可继续调整提示词，或在图像画布中选择图像进行编辑（image_edit）。`;
  }
  return `（mock）已用 ${toolNames.join("/")} 完成请求 ${request.kind}，本轮已完成。`;
}

/** 无工具调用意图时的纯文本回复（问候/其他）。 */
export function buildMockTextReply(prompt: string): string {
  const t = prompt.trim();
  if (/你好|嗨|hello|hi/i.test(t)) {
    return "你好，我是 AICH Design 助手。描述你的设计需求即可开始；需要表现图时切换「图像生成」或直接描述画面。";
  }
  return `收到：「${t.length > 40 ? `${t.slice(0, 40)}…` : t}」（mock 回复。配置真实 LLM 端点后可获得完整对话能力）。`;
}

/** 统一入口：按请求判定回复计划。 */
export function buildMockReply(request: AgentRequest): MockReplyPlan {
  if (request.kind === "genImage" || request.kind === "editImage") {
    return { toolCalls: buildMockToolCalls(request), text: "" };
  }
  // chat / research：mock 确定性文本回复（research 真实路径走 research 预设 + 检索工具）。
  const prompt = request.kind === "chat" || request.kind === "research" ? request.prompt : "";
  return { toolCalls: [], text: buildMockTextReply(prompt) };
}
