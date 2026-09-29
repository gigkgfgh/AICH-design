/**
 * preload（CJS/sandbox）→ contracts 的类型桥。
 *
 * sandbox preload 必须 CJS；直接 `import type ... from ESM` 会触发 TS1479
 * （CJS require 不能引入 ESM 模块）。本文件为纯声明（type-only re-export），
 * 编译期被擦除，无运行时 require，类型仍与 contracts.ts 单一来源绑定。
 */
export type {
  AgentRequest,
  GatewayStatus,
  KeyConfigInput,
  RunOptions,
  SecretsStatus,
  SessionContent,
  SessionSummary,
  SseEventEnvelope,
  StoragePlanRecord,
  UploadedImage,
} from '../src/types/contracts.js';
