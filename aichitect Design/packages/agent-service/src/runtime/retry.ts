/**
 * 通用指数退避重试（P018，ADR-006 可恢复任务）。
 *
 * - 只重试「瞬态失败」（网络类）：errno 白名单 + PROVIDER_UNAVAILABLE 业务码 + fetch 网络消息；
 *   业务错误（INVALID_REQUEST / PLAN_VALIDATE_FAILED / REQUEST_CANCELLED 等）与未知错误不重试；
 * - 退避：baseDelayMs * 2^attempt（500 → 1000 → …），上限 maxDelayMs；
 * - sleep 可注入（测试零等待）；fn 收到 attempt 序号（0 起）便于断言。
 */

import { ErrorCode } from "@aichdesign/shared";

export interface RetryPolicy {
  /** 额外重试次数（不含首次尝试），默认 2。 */
  maxRetries: number;
  /** 首次退避基数（毫秒），默认 500。 */
  baseDelayMs: number;
  /** 单次退避上限（毫秒），默认 4000。 */
  maxDelayMs: number;
  /** 睡眠函数（测试注入用零等待实现）。 */
  sleep?: (ms: number) => Promise<void>;
}

export const DEFAULT_RETRY_POLICY: Readonly<RetryPolicy> = {
  maxRetries: 2,
  baseDelayMs: 500,
  maxDelayMs: 4000,
};

/** 网络类 errno 白名单（Node 系统错误码）。 */
const TRANSIENT_ERRNOS = new Set([
  "ECONNRESET",
  "ECONNREFUSED",
  "ECONNABORTED",
  "ETIMEDOUT",
  "ENOTFOUND",
  "EAI_AGAIN",
  "EPIPE",
  "ENETUNREACH",
  "EHOSTUNREACH",
]);

/** 瞬态失败判定：重试安全；其余（业务错误/未知）fail-fast。 */
export function isTransientError(err: unknown): boolean {
  if (!(err instanceof Error)) return false;
  const coded = err as Error & { code?: string };
  if (coded.code === ErrorCode.PROVIDER_UNAVAILABLE) return true;
  if (coded.code && TRANSIENT_ERRNOS.has(coded.code)) return true;
  return /fetch failed|network|socket hang up|aborted.*timeout/i.test(err.message);
}

export interface RetryOutcome<T> {
  value: T;
  /** 实际尝试次数（含首次；=1 表示未重试）。 */
  attempts: number;
}

function defaultSleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * 带退避的重试执行。isRetryable 缺省用 isTransientError。
 * 重试耗尽后抛出最后一次错误（调用方决定死信登记）。
 */
export async function withRetry<T>(
  fn: (attempt: number) => Promise<T>,
  policy?: Partial<RetryPolicy>,
  isRetryable: (err: unknown) => boolean = isTransientError,
): Promise<RetryOutcome<T>> {
  const p = { ...DEFAULT_RETRY_POLICY, ...policy };
  const sleep = p.sleep ?? defaultSleep;
  let attempt = 0;
  for (;;) {
    try {
      const value = await fn(attempt);
      return { value, attempts: attempt + 1 };
    } catch (err) {
      if (attempt >= p.maxRetries || !isRetryable(err)) throw err;
      const delay = Math.min(p.baseDelayMs * 2 ** attempt, p.maxDelayMs);
      await sleep(delay);
      attempt += 1;
    }
  }
}
