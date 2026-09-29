/**
 * 会话 token 管理（P016，R3 计划 §7 契约 1）。
 *
 * 语义：
 * - authorize(sessionId) 签发一次性会话 token 并**立即轮换**（旧 token 失效）；
 * - validate(sessionId, token) 绑定校验（token 只对签发它的会话有效）；
 * - 会话 token 仅在主进程内存持有/透传（渲染层不持，交接 T2 约束）；
 * - 与进程级 token 并存：进程级 token 为 bootstrap/兼容路径（旧路径登记废弃）。
 *
 * 安全：token 为 crypto 随机（48 hex）；比对用 timingSafeEqual（防时序侧信道）。
 */

import { randomBytes, timingSafeEqual } from "node:crypto";

/** 会话 token 前缀（与进程级 `aich_` 前缀区分，便于日志辨识）。 */
export const SESSION_TOKEN_PREFIX = "aichs_";

interface IssuedToken {
  token: string;
  issuedAt: number;
  /** 被轮换替换的旧 token（仅保留最近一枚，供「刚轮换」窗口内比对拒绝提示）。 */
  previous: string | null;
}

export class SessionTokenManager {
  private readonly issued = new Map<string, IssuedToken>();

  /**
   * 签发/轮换会话 token：同一 sessionId 再次调用即作废旧 token。
   * 返回新 token（`aichs_<48hex>`）。
   */
  authorize(sessionId: string): string {
    const token = `${SESSION_TOKEN_PREFIX}${randomBytes(24).toString("hex")}`;
    const existing = this.issued.get(sessionId);
    this.issued.set(sessionId, {
      token,
      issuedAt: Date.now(),
      previous: existing?.token ?? null,
    });
    return token;
  }

  /** 绑定校验：token 必须是该会话当前有效 token。 */
  validate(sessionId: string, token: string): boolean {
    const entry = this.issued.get(sessionId);
    if (!entry) return false;
    return safeEqual(entry.token, token);
  }

  /** 该 token 是否为该会话刚被轮换掉的旧 token（客户端 401 后重取凭据的判定辅助）。 */
  isRotated(sessionId: string, token: string): boolean {
    const entry = this.issued.get(sessionId);
    return entry?.previous != null && safeEqual(entry.previous, token);
  }

  /** 撤销会话 token（会话结束/登出语义；本轮主进程可不调用）。 */
  revoke(sessionId: string): void {
    this.issued.delete(sessionId);
  }

  /** 有效会话数（诊断）。 */
  get size(): number {
    return this.issued.size;
  }
}

/** 常量时间比对（长度不同直接 false，不抛错）。 */
function safeEqual(a: string, b: string): boolean {
  const bufA = Buffer.from(a, "utf8");
  const bufB = Buffer.from(b, "utf8");
  if (bufA.length !== bufB.length) return false;
  return timingSafeEqual(bufA, bufB);
}
