/**
 * 跨层统一消息契约（冻结文本）——唯一权威来源
 *
 * 契约来源（冻结依据，禁止单方面扩展字段语义）：
 * - 设计文档 §8.3 AgentRequest / AgentResponse（跨两层统一消息契约）
 * - 设计文档 ADR-004 SSE 事件信封 { requestId, sessionId, type, data }
 *
 * 变更纪律（AGENTS.md 铁律 3）：任何字段重命名 / 增删 / 语义变化必须写入
 * 交接文档「依赖信息」并通知 frontend / reviewer 窗口。
 *
 * R7-1（2026-09-29）：方案（PlanStructure）/版本树全链路移除——应用聚焦「对话 + 图像生成」；
 * 请求新增 kind:"chat"（通用对话），draftPlan/editPlan/listVersions 与响应 plan 分支删除。
 */

/* ---------------- AgentRequest / AgentResponse（§8.3 冻结文本） ---------------- */

/**
 * 客户端 → Agent Service 的统一请求（冻结文本）。
 * requestId 由主进程生成（幂等键，ADR-006），经 POST /v1/run 信封携带，
 * 不放入本类型内（本类型为业务载荷）。
 */
export type AgentRequest =
  /** 通用对话（R7-1：原 draftPlan/editPlan 的主路径收敛为 chat，由 main Agent 承接）。 */
  | { kind: "chat"; sessionId: string; prompt: string }
  | { kind: "genImage"; sessionId: string; prompt: string; refImageId?: string }
  | { kind: "editImage"; sessionId: string; prompt: string; imageId: string; maskId?: string }
  /**
   * 案例调研（R5 子 agent 系统）：LLM 文本分析（research 预设挂载 web_search/fetch_page 检索工具；
   * 无检索配置时退化为模型知识分析）。
   */
  | { kind: "research"; sessionId: string; prompt: string };

/**
 * 图像元数据（§6.4：prompt/父版本/参考图/模型/耗时/费用）。
 * 保留索引签名以兼容输出格式演进（ADR-005.4），禁止删除已知字段。
 */
export interface ImageMeta {
  /** 生成/编辑该图像所用的提示词。 */
  prompt: string;
  /** 图像模型 id（如 gpt-image-2）。 */
  model: string;
  /** Provider id（如 openai / openai-compatible）。 */
  provider: string;
  /** 来源计划版本 id（平面 → 表现图联动，B-3）。 */
  parentVersionId?: string;
  /** 来源图像版本 id（图像编辑，B-4）。 */
  parentImageId?: string;
  /** 参考图 id（genImage.refImageId 落盘回填）。 */
  refImageId?: string;
  /** 编辑遮罩 id（editImage.maskId 落盘回填）。 */
  maskId?: string;
  /** 输出宽度（px）。 */
  width?: number;
  /** 输出高度（px）。 */
  height?: number;
  /** 耗时（毫秒）。 */
  durationMs?: number;
  /** 成本（美元）；无成本信息的 mock 场景可缺省。 */
  costUsd?: number;
  /** 任务终态（ADR-006 UI 状态映射）。 */
  status?: "queued" | "running" | "succeeded" | "failed" | "cancelled";
  /** 创建时间（ISO8601）。 */
  createdAt?: string;
  [key: string]: unknown;
}

/** Agent Service → 客户端 的统一响应（冻结文本）。 */
export type AgentResponse =
  | { kind: "image"; imageId: string; url: string; meta: ImageMeta }
  | { kind: "stream"; delta: string }
  | { kind: "error"; code: string; message: string };

/* ---------------- SSE 事件信封（ADR-004 冻结） ---------------- */

/** ADR-004：事件类型（R6-6 增补：thinking/tool；R7-2 增补：usage 模型用量；只增不改）。 */
export type SseEventType = "delta" | "progress" | "done" | "error" | "partial" | "thinking" | "tool" | "usage";

/** delta 载荷：对话增量文本。 */
export interface SseDeltaData {
  delta: string;
}

/** progress 载荷（图像生成等长任务；LLM 文本阶段可发 { phase: "llm" } 心跳）。 */
export interface SseProgressData {
  phase: "llm" | "image_generate" | "image_edit";
  percent?: number;
  message?: string;
}

/** error 载荷：业务错误码 + 人类可读消息（错误码表见 src/errors.ts）。 */
export interface SseErrorData {
  code: string;
  message: string;
}

/** partial 载荷：部分可持久化结果（M1 为对话增量落盘确认）。 */
export interface SsePartialData {
  kind: "transcript_saved";
  lineCount: number;
}

/** thinking 载荷（R6-6）：模型思考增量（渲染层可折叠展示，开关控制）。 */
export interface SseThinkingData {
  delta: string;
}

/** tool 载荷（R6-6）：工具调用可见性（开始/结束；渲染层可折叠展示）。 */
export interface SseToolData {
  toolName: string;
  phase: "start" | "end";
  /** 结束且出错时给出简短提示。 */
  error?: string;
  /** R6-9：dispatch_agent 工具的分派目标（渲染层据此自动接续）。 */
  dispatchAgent?: string;
}

/**
 * usage 载荷（R7-2）：每次 LLM 调用（turn）的模型用量，API 实报值（DSH 对标口径）。
 * - DeepSeek 映射：prompt_cache_hit_tokens→cacheReadTokens、未缓存输入（miss）→promptTokens−cacheRead−cacheWrite；
 * - context 为静态估算（系统提示词/工具定义，启发式；对话消息 = promptTokens − 两者，渲染层推得）；
 * - contextWindow：模型条目配置优先，留空用服务端默认（DeepSeek 官方 1M）。
 */
export interface SseUsageData {
  promptTokens: number;
  completionTokens: number;
  cacheReadTokens: number;
  cacheWriteTokens: number;
  reasoningTokens?: number;
  totalTokens: number;
  context: {
    systemTokens: number;
    toolTokens: number;
    contextWindow: number;
  };
}

/**
 * ADR-004 事件信封：每个事件含 { requestId, sessionId, type, data }。
 * 渲染进程增量渲染，主进程逐帧转发不缓冲整条流。
 */
export interface SseEventEnvelope {
  requestId: string;
  sessionId: string;
  type: SseEventType;
  data: unknown;
}

/** 各 type 的 data 载荷映射（人肉映射表，运行时以结构判别）。 */
export interface SseEventDataByType extends Record<SseEventType, unknown> {
  delta: SseDeltaData;
  progress: SseProgressData;
  done: AgentResponse;
  error: SseErrorData;
  partial: SsePartialData;
  thinking: SseThinkingData;
  tool: SseToolData;
  usage: SseUsageData;
}

/** 便捷构造函数：生成一个完整信封（网关/测试共用，避免手拼错误）。 */
export function makeEnvelope<T extends SseEventType>(
  requestId: string,
  sessionId: string,
  type: T,
  data: SseEventDataByType[T],
): SseEventEnvelope {
  return { requestId, sessionId, type, data };
}