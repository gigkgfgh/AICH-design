/**
 * @aichdesign/agent-service 入口
 * 导出：start()（库方式启动网关，测试用）、buildImageToolBindings()/resolveImagePort()、buildSystemPrompt()。
 * bin 直跑入口在 src/main.ts（AICH_GATEWAY_READY 就绪协议输出 stdout）。
 */

export * from "./adapters/common.js";
export { PiAgentCoreAdapter, RUN_IDLE_TIMEOUT_MS, RUN_TOTAL_TIMEOUT_MS } from "./adapters/pi-agent-core-adapter.js";
export { MockAdapter } from "./adapters/mock-adapter.js";
export { RunManager } from "./runtime/run-manager.js";
export { AsyncQueue } from "./runtime/async-queue.js";
export { JsonlSessionStore } from "./session/jsonl-store.js";
export { UsageTracker } from "./telemetry/usage-tracker.js";
export { createHttpGateway } from "./gateway/http-server.js";
export { start, buildImageToolBindings, resolveImagePort, buildSystemPrompt } from "./main.js";