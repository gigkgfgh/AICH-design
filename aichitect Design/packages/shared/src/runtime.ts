/**
 * 内核可替换运行时接口（设计文档 §3.3 G3）。
 *
 * 本文件定义与 pi-agent-core 解耦的产品级接口，agent-service 内部适配：
 * - PiAgentCoreAdapter：默认实现（锁 @earendil-works/pi-agent-core 0.84.x）；
 * - UnconfiguredAdapter：端点未配置时的 fail-closed 占位实现（下发明确错误，不产生模拟数据）。
 * 未来换内核只改 adapter，业务代码（网关 / 会话 / 埋点）不动。
 */

import type { AgentRequest, AgentResponse, SseEventEnvelope } from "./contracts.js";

/** 运行状态（ADR-006 UI 状态映射的服务器侧视图）。 */
export type RunStatus = "queued" | "running" | "succeeded" | "failed" | "cancelled";

/** 输入校验后的工具参数 JSON Schema（宽松：TypeBox schema 或 JSON Schema 均可）。 */
export interface ToolDef {
  name: string;
  description: string;
  /** 参数声明（JSON Schema 形状；实际取值可为 TypeBox schema）。 */
  parameters: unknown;
  /** 可读标签（UI 展示用）。 */
  label?: string;
}

/** Skill 定义（对齐 Anthropic Agent Skills 开放标准，§4.1）。 */
export interface SkillDef {
  /** 仅小写/数字/连字符，≤64 字符，与目录名一致。 */
  name: string;
  /** 第三人称，≤1024 字符：做什么 + 何时用（L1 元数据=发现依据）。 */
  description: string;
  /** L1 元数据之外的可选白名单。 */
  allowedTools?: string[];
}

/** Extension 定义：注册工具 + 事件钩子的 bundle 形态（§4.1）。 */
export interface ExtensionDef {
  name: string;
  description: string;
  tools: ToolDef[];
}

/** 子 agent id（R5：composer 左下选择 / 主 agent 自动路由；R7-1：plan-draft 移除）。 */
export type SubAgentId = "main" | "image-gen" | "research";

/**
 * 思考深度档位（R5）——采用 pi-ai 原生 ThinkingLevel 划分，信封透传不折算：
 * off = 不传 reasoning（缺省）；low/medium/high/xhigh/max 映射推理模型 effort（R6-18：minimal 已删除）。
 */
export type ThinkingLevel = "off" | "low" | "medium" | "high" | "xhigh" | "max";

/** 单次运行请求（requestId 为主进程生成的幂等键，ADR-006）。 */
export interface RunRequest {
  requestId: string;
  sessionId: string;
  request: AgentRequest;
  signal?: AbortSignal;
  /** R5：本次运行的子 agent（预设系统提示/工具白名单）；缺省 main。 */
  agent?: SubAgentId;
  /** R5：模型 id 覆盖（仅 LLM 文本阶段；未配置真实 LLM 时忽略）。 */
  model?: string;
  /** R5：思考深度；缺省 off。 */
  thinking?: ThinkingLevel;
  /** R6-11：随请求交给多模态 LLM 分析的图片（ImageRegistry 已注册 id；≤4 张）。 */
  analysisImageIds?: string[];
}

/** 运行句柄：事件流 + 终局结果。 */
export interface RunHandle {
  /** SSE 信封流（delta/progress/partial/done/error）。 */
  events: AsyncIterable<SseEventEnvelope>;
  /** 终局结果；取消/失败时 resolve 为 error kind 的 AgentResponse。 */
  result: Promise<AgentResponse>;
  /** 运行状态快照（供网关 / 埋点查询）。 */
  status: RunStatus;
}

/** 与 pi-agent-core 解耦的运行时端口（§3.3 冻结）。 */
export interface AgentRuntimePort {
  run(req: RunRequest): Promise<RunHandle>;
  loadSkill(skill: SkillDef): void;
  registerExtension(ext: ExtensionDef): void;
  /** 关闭运行时（中止所有在跑任务并释放资源）。 */
  dispose(): Promise<void>;
}

/** 端口可替换性的构建开关（P006 决策记录）：adapter 选择。 */
export interface AdapterFactory {
  /** 尝试创建默认（pi-agent-core）adapter；失败返回 null 由主流程降级 UnconfiguredAdapter。 */
  create(): Promise<AgentRuntimePort | null>;
}