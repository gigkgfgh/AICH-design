/**
 * 零依赖 mock 对话策略：关键词 → 回复意图（文本 / 计划工具调用 / 修改工具调用）。
 *
 * 本文件不依赖任何 pi 包类型，供两条路径共享：
 * - createMockChatStream（pi-ai 事件流，PiAgentCoreAdapter 的 streamFn）；
 * - MockAdapter（依赖不可装时的兜底实现，直接消费本文件产物）。
 */

import type { AgentRequest, PlanStructure } from "@aichdesign/shared";
import { mockPlanFamilyHouse, mockPlanSmallApartment, mockPlanStudio } from "./plans.js";

/** 工具调用的本地结构形状（与 pi-ai ToolCall 结构兼容，adapter 断言转换）。 */
export interface MockToolCall {
  type: "toolCall";
  id: string;
  name: "render_plan_svg" | "plan_patch" | "image_generate" | "image_edit" | string;
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

/** 是否命中「起草方案」意图。 */
export function isDraftIntent(prompt: string): boolean {
  return /方案|户型|平面|布局|设计|起草|房子|公寓|一居|两居|三居/.test(prompt);
}

/** 是否命中「修改方案」意图（editPlan 迭代流）。 */
export function isEditIntent(prompt: string): boolean {
  return /改|调|加大|缩小|移动|删除|增加|去掉|换个|调整/.test(prompt);
}

/** 选择 mock 结构的确定性策略：按 prompts 哈希取模，保证同输入同输出（可复现测试）。 */
export function pickMockPlan(prompt: string, variant = 0): PlanStructure {
  const pool = [mockPlanSmallApartment, mockPlanStudio, mockPlanFamilyHouse] as const;
  let seed = 0;
  for (const ch of prompt) seed = (seed * 31 + ch.codePointAt(0)!) % 2147483647;
  return pool[(seed + variant) % pool.length]!;
}

/**
 * 构造 mock 工具调用（第一轮）：draftPlan → render_plan_svg（可多方案）；
 * editPlan → plan_patch（复用样例结构）。返回空数组时调用方回退文本回复。
 */
export function buildMockToolCalls(request: AgentRequest): MockToolCall[] {
  if (request.kind === "draftPlan") {
    const variants = Math.min(Math.max(request.variants ?? 1, 1), 3);
    const calls: MockToolCall[] = [];
    for (let i = 0; i < variants; i += 1) {
      calls.push({
        type: "toolCall",
        id: mockId("tc"),
        name: "render_plan_svg",
        arguments: { plan: pickMockPlan(request.prompt, i) },
      });
    }
    return calls;
  }
  if (request.kind === "editPlan") {
    return [
      {
        type: "toolCall",
        id: mockId("tc"),
        name: "plan_patch",
        arguments: {
          plan: pickMockPlan(request.instruction),
          patch: [{ op: "resize", roomId: "r1", factor: 1.1, reason: request.instruction }],
        },
      },
    ];
  }
  // P012：genImage → image_generate；editImage → image_edit（参考图 id 占位，
  // 经 ImageRegistry 解析为已注册 file URL；mock 层不真正读取参考图内容）。
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
  if (request.kind === "draftPlan") {
    return `已用 ${toolNames.join("/")} 生成平面方案（mock 数据，离线可复现）。可继续描述调整需求，例如「把主卧加大」或「客厅换个朝向」。`;
  }
  if (request.kind === "editPlan") {
    return `已应用修改指令（${request.instruction}），方案已更新为新版本（mock 修正，回环护栏内）。`;
  }
  if (request.kind === "genImage" || request.kind === "editImage") {
    return `已${request.kind === "genImage" ? "生成表现图" : "基于参考图完成编辑"}（mock 图像，离线可复现）。可继续调整提示词，或在版本树中选择图像进行编辑（image_edit）。`;
  }
  return `（mock）收到请求 ${request.kind}，本轮已完成。`;
}

/** 无工具调用意图时的纯文本回复（问候/其他）。 */
export function buildMockTextReply(prompt: string): string {
  const t = prompt.trim();
  if (/你好|嗨|hello|hi/i.test(t)) {
    return "你好，我是 AICH Design 助手。可以用自然语言描述你想要的户型，例如「帮我设计一个两室一厅 90 平米的家」。";
  }
  if (isDraftIntent(t)) {
    return "我可以为你起草平面方案：输入「帮我设计……」并尽量描述房间数量、面积与朝向偏好。";
  }
  if (isEditIntent(t)) {
    return "可以基于现有方案修改：说明要改的房间与变化（如「主卧加大到 15 平米」）。";
  }
  return `收到：「${t.length > 40 ? `${t.slice(0, 40)}…` : t}」（mock 回复。描述户型细节可获得结构化方案）。`;
}

/** 统一入口：按请求判定回复计划。 */
export function buildMockReply(request: AgentRequest): MockReplyPlan {
  if (request.kind === "draftPlan" || request.kind === "editPlan" || request.kind === "genImage" || request.kind === "editImage") {
    const toolCalls = buildMockToolCalls(request);
    return { toolCalls, text: "" };
  }
  // listVersions（R009 登记）：R1 不返回列表（版本树由主进程/UI 会话内维护，P019 后回归）。
  // 显式兜底文案，避免落入 buildMockTextReply("") 的误导回复。
  if (request.kind === "listVersions") {
    return {
      toolCalls: [],
      text: "（mock）listVersions 在当前版本不返回列表：方案版本树由主进程/UI 会话内维护，P019 后回归。",
    };
  }
  return { toolCalls: [], text: buildMockTextReply("") };
}