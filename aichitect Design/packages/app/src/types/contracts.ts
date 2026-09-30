/**
 * 跨层统一消息契约 —— 本地入口（R012：存根对齐 shared）
 *
 * 类型唯一权威：`@aichdesign/shared`（backend 冻结落盘，含 AgentRequest/
 * AgentResponse/SSE 信封（SseEventEnvelope/SseDeltaData/SseProgressData/SseErrorData/
 * SsePartialData）/ImageMeta/错误码 ErrorCode），本文件一律 re-export，禁止本地重复定义。
 *
 * 本文件仅保留**前端视图模型扩展**（非契约，mock 层与 UI 共用）：
 * ChatMessage / ImageVersion / AgentServiceStatus / GatewayStatus。
 * R7-1：方案/版本树相关视图模型随方案链路移除。
 * 若 shared 契约变更，本文件无需改动（消费方直接获得新类型）。
 */
export * from '@aichdesign/shared';
import type { SubAgentId, ThinkingLevel } from '@aichdesign/shared';

/* ---------------- 前端视图模型（非契约，mock 层与 UI 共用） ---------------- */

import type { ImageMeta } from '@aichdesign/shared';

/** 图像版本节点（P013 视图模型；meta 契约权威在 shared.ImageMeta）。 */
export interface ImageVersion {
  imageId: string;
  /** 图像地址：mock 阶段为 dataURL；P012 落盘后可为 file:// 或 http url */
  url: string;
  /** 图像元数据（prompt/model/provider/费用/耗时 等） */
  meta: ImageMeta;
  /** 本地创建时间兜底（meta.createdAt 优先） */
  createdAt: string;
}

/** 聊天消息（前端会话视图模型） */
export interface ChatMessage {
  id: string;
  role: 'user' | 'assistant' | 'system';
  text: string;
  /** 错误消息标记（用于错误态视觉） */
  isError?: boolean;
  /** R6-6：模型思考内容（thinking 事件累积；展示受设置开关控制） */
  thinking?: string;
  /** R6-6：工具调用记录（tool 事件累积） */
  tools?: Array<{ toolName: string; phase: 'start' | 'end'; error?: string }>;
  /** R6-9：主 Agent 分派到的子 agent（UI 徽标） */
  dispatchedAgent?: SubAgentId;
  /** R6-15：可重试错误（attempt=下次重试序号；attempt>max 不再显示重试按钮） */
  retry?: { attempt: number; max: number };
  /** R6-19 补充：用户消息携带的图片附件预览（dataURL，仅展示用） */
  images?: string[];
}

/* ---------------- 网关状态（主进程 → 渲染进程） ---------------- */

export type AgentServiceStatus = 'ready' | 'stub' | 'unavailable';

export interface GatewayStatus {
  /** agent-service 是否已就绪（ready=可走本地 HTTP 桥；stub=占位未拉起，渲染层走 mock） */
  agentService: AgentServiceStatus;
  /** 渲染侧网关模式：mock = 本地 mock 数据层；bridge = Electron IPC 桥 → 主进程网关 */
  gateway: 'mock' | 'bridge';
  /** 网关地址（bridge 模式有效） */
  gatewayUrl?: string;
  /** 会话数据目录（bridge 模式有效；设置面板展示/图像兜底白名单根） */
  sessionsDir?: string;
  /** 外部技能目录（bridge 模式有效；<dir>/<name>/SKILL.md） */
  skillsDir?: string;
  /** Agent 日志目录（R6-6） */
  logsDir?: string;
}

/* ---------------- 会话历史（P-R3 前端重构：主进程读 sessions/*.jsonl） ---------------- */

/** 会话列表项（sessions:list 返回） */
export interface SessionSummary {
  sessionId: string;
  /** 标题 = 首条用户消息截断（无用户消息时回退占位） */
  title: string;
  /** 最后活动时间（ISO8601，取最后一条可解析行 ts） */
  lastTs: string;
  /** 消息条数（user/assistant） */
  messageCount: number;
}

/** 恢复的会话消息（sessions:read 返回；id 为恢复期合成，非原始 requestId） */
export interface RestoredMessage {
  id: string;
  role: 'user' | 'assistant';
  text: string;
  /** R7-2：用户消息携带的图片（file:// url，来自 jsonl user.imageIds × image 条目回填） */
  images?: string[];
}

/** 恢复的会话内容（sessions:read 返回） */
export interface SessionContent {
  sessionId: string;
  title: string;
  messages: RestoredMessage[];
  /** 图像条目（file:// url，显示经 readImageAsDataUrl 兜底） */
  images: ImageVersion[];
  /**
   * R7-2：会话用量聚合（jsonl usage 行回填；与 useConversation.SessionUsage 同构）。
   * 旧会话/无 usage 行时缺省；context 段为落盘时的静态估算快照（旧数据无此段 → 0，UI 显示 —）。
   */
  usage?: RestoredUsage;
}

/** 会话用量聚合的恢复形状（jsonl usage 行累计；last* 取最后一行，session* 为全程累计） */
export interface RestoredUsage {
  lastPromptTokens: number;
  lastCompletionTokens: number;
  lastCacheReadTokens: number;
  contextWindow: number;
  contextSystemTokens: number;
  contextToolTokens: number;
  sessionInput: number;
  sessionCacheRead: number;
  sessionCacheWrite: number;
  sessionOutput: number;
  sessionTotal: number;
  sessionReasoning: number;
}

/* ---------------- 运行选项（R5：子 agent / 模型覆盖 / 思考深度，随信封透传） ---------------- */

/** 单次运行的可选项（composer 选择；undefined 走服务端缺省）。 */
export interface RunOptions {
  agent?: SubAgentId;
  model?: string;
  thinking?: ThinkingLevel;
  /** R6-11：随请求交多模态 LLM 分析的已注册图片 id（≤4） */
  analysisImageIds?: string[];
}

/** 附件（composer 上传；图片经 /v1/images 注册、文本注入 prompt）。 */
export interface Attachment {
  id: string;
  type: 'image' | 'text';
  name: string;
  /** 图片：可作参考图的注册 id（genImage.refImageId/editImage.imageId）。 */
  imageId?: string;
  /** 图片：本地预览地址（dataURL/file://）。 */
  url?: string;
  /** 文本：内容（≤50KB，发送时注入 prompt）。 */
  content?: string;
}

/** 上传注册结果（upload:image IPC 返回）。 */
export interface UploadedImage {
  imageId: string;
  url: string;
}

/* ---------------- 密钥管理（设置面板自配 LLM/图像 Key；safeStorage 无口令方案） ---------------- */

/** 模型条目（密钥管理页；apiKey 只回 hasKey 布尔）。 */
export interface ModelEntry {
  id: string;
  name: string;
  baseUrl: string;
  model: string;
  thinking: string;
  /** R7-1：端点支持图像输入（默认 true；纯文本端点关闭）。 */
  imageInput: boolean;
  /** R7-2：最大上下文窗口（tokens；0/缺省 = 服务端默认）。 */
  contextWindow: number;
  hasKey: boolean;
}

/** R6-14/R6-16：图像条目（url=完整生成端点；editUrl=完整编辑端点，可空；apiKey 只回 hasKey）。 */
export interface ImageModelEntry {
  id: string;
  name: string;
  url: string;
  editUrl: string;
  model: string;
  hasKey: boolean;
}

/** 密钥状态（渲染层可见；不含任何密钥内容，仅布尔与非密设置）。 */
export interface SecretsStatus {
  /** 系统加密（safeStorage/DPAPI）是否可用；不可用时密钥保存被拒绝（fail-closed）。 */
  available: boolean;
  hasLlmKey: boolean;
  llmBaseUrl: string;
  llmModel: string;
  /** R5：联网检索配置（'disabled'（默认）| 'searxng' | 'duckduckgo' | 'deepseek'）。 */
  searchProvider: string;
  /** SearXNG 搜索端点（含 /search）。 */
  searchBaseUrl: string;
  /** R6-6：多来源模型条目。 */
  models: ModelEntry[];
  /** R6-6：默认激活条目 id。 */
  activeModelId: string;
  /** R6-14：多来源图像服务商条目（旧单条目配置懒迁移为首条目）。 */
  imageModels: ImageModelEntry[];
  /** R6-14：默认激活的图像条目 id。 */
  activeImageModelId: string;
  /** R6-6：自定义会话目录覆盖（空 = 默认 userData/sessions）。 */
  sessionsDirOverride: string;
  /** R6-13：单次运行工具调用轮次上限（设置 → Agent；默认 25）。 */
  maxToolCalls: number;
}

/** R6-14/R6-16：图像条目保存输入（完整 URL 由用户填写；apiKey：undefined 保留、'' 清除、非空覆盖）。 */
export interface ImageModelEntryInput {
  id?: string;
  name: string;
  url: string;
  editUrl?: string;
  model: string;
  apiKey?: string;
}

/** 用户提交的 Key 配置（undefined = 不改；'' = 清除）。 */
export interface KeyConfigInput {
  llmApiKey?: string;
  llmBaseUrl?: string;
  llmModel?: string;
  imageApiKey?: string;
  imageBaseUrl?: string;
  imageModel?: string;
  /** R5：联网检索（undefined 不改；''= 禁用）。 */
  searchProvider?: string;
  searchBaseUrl?: string;
}

/** R6-6：模型条目保存输入（apiKey：undefined 保留原值、'' 清除、非空覆盖）。 */
export interface ModelEntryInput {
  id?: string;
  name: string;
  baseUrl: string;
  model: string;
  apiKey?: string;
  thinking?: string;
  /** R7-1：图像输入开关（缺省 true）。 */
  imageInput?: boolean;
  /** R7-2：最大上下文窗口（tokens；留空 = 服务端默认）。 */
  contextWindow?: number;
}