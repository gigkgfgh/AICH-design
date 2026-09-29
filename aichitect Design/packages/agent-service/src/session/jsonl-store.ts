/**
 * 会话 jsonl 存储（修订②：agent-service 仅直写 sessions/*.jsonl，meta.db 归主进程）。
 *
 * 布局：<sessionsDir>/<sessionId>.jsonl，每行 { ts, kind, requestId?, data }。
 * 用途：
 * - M1：会话消息流落盘（P006）；mock 全链路验证可人工检查文件；
 * - P019：rehydration 数据源（崩溃重启恢复会话与方案）。
 * 单写者：本进程内同步追加（fs.appendFileSync），避免并发交错。
 */

import { mkdirSync, appendFileSync, readFileSync, existsSync } from "node:fs";
import { join } from "node:path";

/**
 * sessionId 白名单（R007 双保险之一）：
 * 网关侧 validateRunRequest 已先校验；本类侧再校验（fail-closed），
 * 防止绕过网关直调 store 时 `../victim` 等路径穿越写入任意 .jsonl。
 */
export const SESSION_ID_RE = /^[A-Za-z0-9._-]{1,64}$/;

export type SessionEntryKind =
  | "user"
  | "assistant"
  | "tool"
  | "run"
  | "usage"
  | "error"
  | "event"
  /** P012/B-4：图像产物元数据条目（{ imageId, url, meta } 形状）。 */
  | "image";

export interface SessionEntry {
  ts: string;
  kind: SessionEntryKind;
  /** 运行 id（ADR-006 幂等键）；事件类条目必填。 */
  requestId?: string;
  data: unknown;
}

export class JsonlSessionStore {
  private readonly dir: string;

  constructor(dir: string) {
    this.dir = dir;
    mkdirSync(this.dir, { recursive: true });
  }

  /** 会话文件路径（不自动建目录，append 前 ensure）。R007：白名单校验（fail-closed）。 */
  private fileFor(sessionId: string): string {
    if (!SESSION_ID_RE.test(sessionId)) {
      throw new Error(`非法 sessionId（白名单 ^[A-Za-z0-9._-]{1,64}$）：${JSON.stringify(sessionId)}`);
    }
    return join(this.dir, `${sessionId}.jsonl`);
  }

  /** 追加一行（同步追加，单写者约定）。 */
  append(sessionId: string, kind: SessionEntryKind, data: unknown, requestId?: string): void {
    const entry: SessionEntry = { ts: new Date().toISOString(), kind, data, requestId };
    appendFileSync(this.fileFor(sessionId), `${JSON.stringify(entry)}\n`, "utf8");
  }

  /** 读取会话全量行（空/不存在返回 []）。 */
  readLines(sessionId: string): SessionEntry[] {
    const file = this.fileFor(sessionId);
    if (!existsSync(file)) return [];
    const raw = readFileSync(file, "utf8");
    const lines: SessionEntry[] = [];
    for (const line of raw.split("\n")) {
      if (line.trim() === "") continue;
      try {
        lines.push(JSON.parse(line) as SessionEntry);
      } catch {
        // 损坏行跳过（崩溃边缘写入）；P019 rehydration 时按容错策略处理。
      }
    }
    return lines;
  }

  /** 会话中最后 N 条非 usage 消息（rehydration 预留接口）。 */
  recentMessages(sessionId: string, limit = 20): SessionEntry[] {
    return this.readLines(sessionId)
      .filter((e) => e.kind !== "usage")
      .slice(-limit);
  }
}