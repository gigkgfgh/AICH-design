/**
 * 业务错误码与 HTTP 状态码映射（全产品统一）。
 *
 * 约定（AGENTS.md backend 输出规范）：
 * - 业务错误码与 HTTP 状态码分离：同一错误码在不同传输层可映射不同状态；
 * - 错误响应结构固定为 { code, message, data }（HTTP JSON 响应与 SSE error 载荷同构）；
 * - 新增错误码必须在本表登记并写入交接文档「依赖信息」。
 *
 * 唯一权威声明（2026-08-12 R1-REV 裁决，R001）：本表 10 码为全产品唯一错误码权威，
 * HTTP 映射以 httpStatusFor() 为准。早期 P000 阶段 7 码草案（ERR_AUTH / ERR_INVALID /
 * ERR_NOT_FOUND / ERR_CONFLICT / ERR_CANCELLED / ERR_RUNNER / ERR_INTERNAL）作废不落地；
 * frontend toHttpError 须对齐本表（禁散用字面量），SSE 错误信封 code 字段亦取本表值。
 */

export const ErrorCode = {
  /** 请求参数缺失 / 类型错误 / 非法值。 */
  INVALID_REQUEST: "INVALID_REQUEST",
  /** Bearer token 缺失或无效。 */
  UNAUTHORIZED: "UNAUTHORIZED",
  /** 请求的资源不存在（session / requestId / versionId 等）。 */
  NOT_FOUND: "NOT_FOUND",
  /** 幂等冲突（requestId 已存在且处于终态，语义见 ADR-006）。 */
  CONFLICT: "CONFLICT",
  /** 运行被用户取消（POST /v1/cancel 成功后的终态错误码）。 */
  REQUEST_CANCELLED: "REQUEST_CANCELLED",
  /** Agent Loop 运行失败（上游模型错误、工具执行错误等）。 */
  RUNNER_ERROR: "RUNNER_ERROR",
  /** 上游 Provider 不可用（断网 / 端点失败 / 鉴权失败）。 */
  PROVIDER_UNAVAILABLE: "PROVIDER_UNAVAILABLE",
  /** 图像成本护栏：会话图像已用成本 + 单次预估超过上限（P018，AICH_IMAGE_COST_LIMIT_USD）。 */
  IMAGE_COST_LIMIT_EXCEEDED: "IMAGE_COST_LIMIT_EXCEEDED",
  /** 未知内部错误（兜底）。 */
  INTERNAL_ERROR: "INTERNAL_ERROR",
} as const;

export type ErrorCode = (typeof ErrorCode)[keyof typeof ErrorCode];

/** 统一错误响应结构（HTTP JSON 与 SSE error 信封的 data 同构）。 */
export interface ErrorResponse {
  code: ErrorCode | string;
  message: string;
  data?: unknown;
}

/** HTTP 状态码映射（默认值；网关可按传输层覆写）。 */
export function httpStatusFor(code: ErrorCode | string): number {
  switch (code) {
    case ErrorCode.INVALID_REQUEST:
      return 400;
    case ErrorCode.UNAUTHORIZED:
      return 401;
    case ErrorCode.NOT_FOUND:
      return 404;
    case ErrorCode.CONFLICT:
    case ErrorCode.REQUEST_CANCELLED:
      return 409;
    case ErrorCode.IMAGE_COST_LIMIT_EXCEEDED:
      return 429;
    case ErrorCode.PROVIDER_UNAVAILABLE:
      return 503;
    case ErrorCode.RUNNER_ERROR:
      return 502;
    case ErrorCode.INTERNAL_ERROR:
    default:
      return 500;
  }
}

/** 构造错误响应（data 可选，默认按 code 归一化 message 兜底）。 */
export function makeError(code: ErrorCode | string, message: string, data?: unknown): ErrorResponse {
  return { code, message, data };
}