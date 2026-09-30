/**
 * adapter 公共形状：工具绑定与运行产物（与 pi 实现解耦）。
 */

import type { AgentRequest, AgentResponse, SseEventEnvelope, ToolDef, RunStatus } from "@aichdesign/shared";

/** 工具执行的简化结果（adapter 各自适配为内核工具结果形状）。 */
export interface ToolExecuteResult {
  /** 返回给模型的内容文本。 */
  text: string;
  /** 结构化 details（产品工具结果载体，如 image_generate 的 ImageApiResult）。 */
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

/** 从 AgentRequest 提取用户可见的提示文本（会话记录用）。 */
export function promptOf(request: AgentRequest): string {
  switch (request.kind) {
    case "chat":
    case "genImage":
    case "editImage":
    case "research":
      return request.prompt;
  }
}
