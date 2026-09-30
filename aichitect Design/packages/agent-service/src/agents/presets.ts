/**
 * 子 agent 注册表（R6-8 重构）：内置能力全部 SKILL.md 化后，
 * 本表只保留「agent id → 技能名」的路由映射与展示元数据；
 * 领域约束全部迁入 packages/skills/<name>/SKILL.md（与外部技能同机制：read_skill 渐进披露）。
 *
 * 主次（用户指令 2026-08-24）：图像生成为首要功能；plan-draft 降级为 Beta。
 */

import type { SubAgentId } from "@aichdesign/shared";

export interface AgentRegistration {
  id: SubAgentId;
  name: string;
  description: string;
  /** 钉住的内置技能名（undefined = 主 Agent 不钉技能，全工具可用）。 */
  skillName?: string;
  /** R6-8：解析技能后回填（工具白名单）。 */
  allowedTools?: string[];
  /** R6-8：解析技能后回填（SKILL.md 正文）。 */
  skillBody?: string;
}

export const AGENT_REGISTRATIONS: Readonly<Record<SubAgentId, AgentRegistration>> = {
  main: {
    id: "main",
    name: "主 Agent",
    description: "自动路由：按意图分派图像 / 调研（R7-1：通用对话直接承接）",
  },
  "image-gen": {
    id: "image-gen",
    name: "图像生成",
    description: "生成与编辑建筑表现图（首要功能）",
    skillName: "image-gen",
  },
  research: {
    id: "research",
    name: "案例调研",
    description: "联网检索案例 / 规范 / 材料参考",
    skillName: "research",
  },
};

/** agent id → 技能名（供宿主钉住技能正文/工具白名单）。 */
export function skillNameForAgent(agent: SubAgentId | undefined): string | undefined {
  return agent ? AGENT_REGISTRATIONS[agent]?.skillName : undefined;
}
