/**
 * adapter 公共形状：工具绑定与运行产物（与 pi 实现解耦）。
 */

import type { AgentRequest, AgentResponse, SseEventEnvelope, ToolDef, RunStatus } from "@aichdesign/shared";
import { randomUUID } from "node:crypto";

/** 工具执行的简化结果（adapter 各自适配为内核工具结果形状）。 */
export interface ToolExecuteResult {
  /** 返回给模型的内容文本。 */
  text: string;
  /** 结构化 details（产品工具结果载体，如 render_plan_svg 的 {svg, structure}）。 */
  details?: unknown;
  isError?: boolean;
}

/** 工具绑定：产品级定义 + 执行函数（由 main 从 extensions 组装）。 */
export interface ToolBinding {
  def: ToolDef;
  execute: (params: Record<string, unknown>, signal?: AbortSignal) => Promise<ToolExecuteResult>;
}

/** adapter 运行产物（push 事件 + 终局）。 */
export interface RunStream {
  events: AsyncIterable<SseEventEnvelope>;
  result: Promise<AgentResponse>;
  status: RunStatus;
}

/** 按名称查找绑定（未注册返回 null）。 */
export function findBinding(tools: ToolBinding[], name: string): ToolBinding | null {
  return tools.find((t) => t.def.name === name) ?? null;
}

/** 生成 versionId（无外部 uuid 依赖）。 */
export function newVersionId(): string {
  return `v_${randomUUID()}`;
}

/** 从 AgentRequest 提取用户可见的提示文本（会话记录用）。
 * listVersions（R009 登记）：R1 不返回列表——版本树由主进程/UI 会话内维护，P019 后回归；
 * 此处返回的仅为会话记录的占位文本（不参与 LLM 对话）。 */
export function promptOf(request: AgentRequest): string {
  switch (request.kind) {
    case "draftPlan":
      return request.prompt;
    case "editPlan":
      return request.instruction;
    case "genImage":
    case "editImage":
      return request.prompt;
    case "research":
      return request.prompt;
    case "listVersions":
      return "（列表查询）R1 不返回列表，版本树由主进程/UI 会话内维护（P019 后回归）";
  }
}