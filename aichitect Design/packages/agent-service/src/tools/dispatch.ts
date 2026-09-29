/**
 * dispatch_agent 工具（R6-9）：主 Agent 的 LLM 自主请求分派到子 agent。
 * 宿主（渲染层 useConversation）监听 tool 事件中的 dispatchAgent，自动以该子 agent 接续执行。
 */

import type { ToolBinding } from "../adapters/common.js";

const DISPATCH_AGENTS = ["image-gen", "plan-draft", "research"] as const;

export function buildDispatchToolBinding(): ToolBinding {
  return {
    def: {
      name: "dispatch_agent",
      description:
        "把当前用户请求分派给专职子 agent 处理（image-gen=生成/编辑表现图；plan-draft=Beta 平面方案起草；research=案例/规范/材料调研）。" +
        "当用户意图明确属于上述专职领域、且超出通用助手能力时调用本工具；分派后宿主会自动让子 agent 接手同一请求。每次只分派一个。",
      label: "分派子 Agent",
      parameters: {
        type: "object",
        properties: {
          agent: { type: "string", enum: [...DISPATCH_AGENTS], description: "目标子 agent" },
          reason: { type: "string", description: "一句话分派原因（展示给用户）" },
        },
        required: ["agent", "reason"],
      },
    },
    execute: async (params) => {
      const agent = typeof params["agent"] === "string" ? params["agent"] : "";
      const reason = typeof params["reason"] === "string" ? params["reason"].slice(0, 200) : "";
      if (!(DISPATCH_AGENTS as readonly string[]).includes(agent)) {
        return { text: `dispatch_agent 参数错误：agent 必须为 ${DISPATCH_AGENTS.join(" / ")}`, isError: true };
      }
      return {
        text: `已请求分派到 ${agent}（${reason || "意图匹配"}）。宿主将自动让该子 agent 接手当前请求，请勿重复调用。`,
        details: { dispatchAgent: agent, reason },
      };
    },
  };
}
