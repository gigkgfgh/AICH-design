/**
 * 跨层统一消息契约 —— 本地入口（R012：存根对齐 shared）
 *
 * 类型唯一权威：`@aichdesign/shared`（backend 冻结落盘，含 PlanStructure/AgentRequest/
 * AgentResponse/SSE 信封（SseEventEnvelope/SseDeltaData/SseProgressData/SseErrorData/
 * SsePartialData）/ImageMeta/错误码 ErrorCode），本文件一律 re-export，禁止本地重复定义。
 *
 * 本文件仅保留**前端视图模型扩展**（非契约，mock 层与 UI 共用）：
 * ChatMessage / PlanVersion / AgentServiceStatus / GatewayStatus。
 * 若 shared 契约变更，本文件无需改动（消费方直接获得新类型）。
 */
export * from '@aichdesign/shared';
//# sourceMappingURL=contracts.js.map