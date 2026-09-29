/**
 * Session/Context Manager（P019，ADR-003 会话生命周期）。
 *
 * 两层记忆：
 * - 结构化层（PlanStructure 版本树 / 图像元数据）：原样保留，永不摘要；
 * - 消息层（user/assistant/tool 对话流）：仅在估算体量超过预算 70% 时，
 *   将较早轮次压缩为 `[摘要]` 紧凑文本，近期轮次原样保留。
 *
 * 硬约束保护（ADR-003 Consequence）：从用户消息抽取显式尺寸/朝向/面积/硬性限制
 * → 会话元数据 hardConstraints；压缩摘要注入时硬约束段完整保留，不得被摘要吞掉。
 *
 * rehydration：以 sessions/*.jsonl 为唯一数据源（与 JsonlSessionStore 同构），
 * recoverSession 从磁盘重建快照（消息/版本树引用/摘要状态/硬约束），
 * 崩溃重启后新实例恢复到同构状态。无内部可变状态——快照确定性可复现。
 *
 * 估算口径（粗略 BPE 近似，注释即口径）：中日韩字符 ≈ 1 token/字，
 * 其余 ASCII ≈ 0.25 token/字符（4 字符折 1 token）。
 */

import type { SessionEntry, SessionEntryKind } from "./jsonl-store.js";
import { JsonlSessionStore } from "./jsonl-store.js";

/** 默认上下文预算（估算 token；AICH_CONTEXT_BUDGET_TOKENS 可覆盖）。 */
export const DEFAULT_CONTEXT_BUDGET_TOKENS = 8000;

/** 压缩触发阈值（估算体量 / 预算）。 */
export const CONTEXT_TRIGGER_RATIO = 0.7;

/** 消息层参与压缩的条目类型（usage/error/event 不计入对话上下文）。 */
const MESSAGE_KINDS: ReadonlySet<SessionEntryKind> = new Set(["user", "assistant", "tool"]);

export interface PlanVersionRef {
  versionId: string;
  ts: string;
}

export interface ImageRef {
  imageId: string;
  url: string;
  ts: string;
}

/** 会话快照：rehydration / 上下文注入的完整产物。 */
export interface SessionSnapshot {
  sessionId: string;
  /** 近期消息（原样保留部分；被压缩轮次不在此列）。 */
  messages: SessionEntry[];
  /** 当前压缩摘要（null = 未触发压缩）；硬约束段已并入。 */
  summary: string | null;
  /** 用户显式硬约束（protectHardConstraints 抽取产物）。 */
  hardConstraints: string[];
  /** 结构化层：方案版本引用（按时间升序）。 */
  planVersions: PlanVersionRef[];
  /** 结构化层：图像条目（按时间升序）。 */
  images: ImageRef[];
  /** 消息层估算体量（token 口径见文件头）。 */
  estimatedTokens: number;
  /** 是否触发了压缩。 */
  compressed: boolean;
}

export interface ContextManagerOptions {
  /** 上下文预算（估算 token）；缺省 DEFAULT_CONTEXT_BUDGET_TOKENS。 */
  budgetTokens?: number;
  /** 触发阈值；缺省 0.7。 */
  triggerRatio?: number;
  /** 摘要中用户文本截断长度；缺省 40。 */
  summaryExcerptChars?: number;
}

/** token 估算（口径见文件头注释；纯启发式，不追求精确）。 */
export function estimateTokens(text: string): number {
  let cjk = 0;
  let other = 0;
  for (const ch of text) {
    const code = ch.codePointAt(0)!;
    // CJK 统一表意文字 + 常用全角标点区间。
    if ((code >= 0x4e00 && code <= 0x9fff) || (code >= 0x3000 && code <= 0x303f) || (code >= 0xff00 && code <= 0xffef)) {
      cjk += 1;
    } else {
      other += 1;
    }
  }
  return cjk + Math.ceil(other / 4);
}

/**
 * 硬约束抽取：从用户消息文本识别显式尺寸/面积/朝向/层高/硬性要求原句。
 * 规则口径（保守，宁可漏抽不可错抽）：
 * - 尺寸：`12x8` / `12米x8米` / `12m × 8m`（数字 + 分隔 + 数字 + 单位可选）；
 * - 面积：`89平米` / `89平方米` / `89㎡` / `89 m²`；
 * - 朝向：`朝南/朝北/朝东/朝西/坐北朝南/南向/北向` 等；
 * - 层高：`层高3米` / `层高 2.8m`；
 * - 硬性措辞：含「必须/不许/不能/不要/硬性要求」的句子整句保留。
 */
export function extractHardConstraints(userTexts: readonly string[]): string[] {
  const constraints: string[] = [];
  const seen = new Set<string>();
  const push = (s: string) => {
    const trimmed = s.trim();
    if (trimmed && !seen.has(trimmed)) {
      seen.add(trimmed);
      constraints.push(trimmed);
    }
  };

  for (const text of userTexts) {
    // 尺寸（允许全角×／x／*分隔）。
    const sizeRe = /\d+(?:\.\d+)?\s*(?:米|m|M|㎡)?\s*[x×*]\s*\d+(?:\.\d+)?\s*(?:米|m|M)/g;
    for (const m of text.matchAll(sizeRe)) push(m[0]);
    // 面积。
    const areaRe = /\d+(?:\.\d+)?\s*(?:平米|平方米|㎡|m²|m2)/g;
    for (const m of text.matchAll(areaRe)) push(m[0]);
    // 朝向。
    const orientRe = /(坐[南北]朝[南北]|[东南西北]向|朝[东南西北])/g;
    for (const m of text.matchAll(orientRe)) push(m[0]);
    // 层高。
    const heightRe = /层高\s*\d+(?:\.\d+)?\s*(?:米|m|M)?/g;
    for (const m of text.matchAll(heightRe)) push(m[0]);
    // 硬性措辞整句（按 。；;.!？? 换行 切句）。
    for (const sentence of text.split(/[。；;.!！?？\n]/)) {
      if (/(必须|不许|不能|不要|禁止|硬性要求)/.test(sentence)) push(sentence);
    }
  }
  return constraints;
}

export class ContextManager {
  private readonly budgetTokens: number;
  private readonly triggerRatio: number;
  private readonly excerptChars: number;

  constructor(
    private readonly store: JsonlSessionStore,
    options: ContextManagerOptions = {},
  ) {
    this.budgetTokens = options.budgetTokens ?? DEFAULT_CONTEXT_BUDGET_TOKENS;
    this.triggerRatio = options.triggerRatio ?? CONTEXT_TRIGGER_RATIO;
    this.excerptChars = options.summaryExcerptChars ?? 40;
  }

  /**
   * 重建会话快照（ADR-003 rehydration 入口）：
   * 崩溃/重启后调用，从 jsonl 恢复消息、版本树引用、摘要状态与硬约束。
   */
  recoverSession(sessionId: string): SessionSnapshot {
    return this.snapshot(sessionId);
  }

  /** 当前快照（超预算自动压缩；确定性——同输入同输出，无内部状态）。 */
  snapshot(sessionId: string): SessionSnapshot {
    const lines = this.store.readLines(sessionId);
    const messageLines = lines.filter((l) => MESSAGE_KINDS.has(l.kind));
    const hardConstraints = extractHardConstraints(
      messageLines.filter((l) => l.kind === "user").map((l) => userText(l.data)),
    );

    // 结构化层：版本树/图像引用原样收集（不参与压缩）。
    const planVersions: PlanVersionRef[] = [];
    const images: ImageRef[] = [];
    for (const line of lines) {
      if (line.kind === "assistant" && isPlanOutcome(line.data)) {
        planVersions.push({ versionId: line.data.versionId, ts: line.ts });
      } else if (line.kind === "image" && isImageEntry(line.data)) {
        images.push({ imageId: line.data.imageId, url: line.data.url, ts: line.ts });
      }
    }

    // 消息层体量估算与压缩决策。
    const estimatedTokens = messageLines.reduce((acc, l) => acc + estimateTokens(JSON.stringify(l.data)), 0);
    const threshold = Math.floor(this.budgetTokens * this.triggerRatio);
    if (estimatedTokens < threshold) {
      return {
        sessionId,
        messages: messageLines,
        summary: null,
        hardConstraints,
        planVersions,
        images,
        estimatedTokens,
        compressed: false,
      };
    }

    // 压缩：保留近期轮次（预算剩余 30% 容量内的最后若干轮），更早轮次并入摘要。
    const keepBudget = Math.max(1, Math.floor(this.budgetTokens * (1 - this.triggerRatio)));
    const rounds = splitRounds(messageLines);
    let kept: SessionEntry[] = [];
    let keptTokens = 0;
    let cutIndex = rounds.length; // 全部保留（不应发生：已超阈值）
    for (let i = rounds.length - 1; i >= 0; i -= 1) {
      const roundTokens = rounds[i]!.entries.reduce((acc, e) => acc + estimateTokens(JSON.stringify(e.data)), 0);
      if (kept.length > 0 && keptTokens + roundTokens > keepBudget) {
        cutIndex = i + 1;
        break;
      }
      kept = [...rounds[i]!.entries, ...kept];
      keptTokens += roundTokens;
    }
    const summarized = rounds.slice(0, cutIndex);
    const summary = this.buildSummary(summarized, hardConstraints);
    return {
      sessionId,
      messages: kept,
      summary,
      hardConstraints,
      planVersions,
      images,
      estimatedTokens,
      compressed: true,
    };
  }

  /** 摘要注入文本（近期消息前的压缩段；硬约束段整段保留）。 */
  contextText(snapshot: SessionSnapshot): string {
    if (!snapshot.compressed || snapshot.summary === null) return "";
    return snapshot.summary;
  }

  /**
   * LLM 系统提示附加段（P019 注入链，ADR-003）：
   * 压缩摘要 + 硬约束（不得被吞）+ 版本树引用。空会话/无约束返回 ""（不附加）。
   */
  contextInjection(snapshot: SessionSnapshot): string {
    const parts: string[] = [];
    if (snapshot.compressed && snapshot.summary) {
      parts.push(snapshot.summary);
    }
    if (snapshot.hardConstraints.length > 0) {
      parts.push(["[硬约束]（用户显式要求，任何生成必须遵守）：", ...snapshot.hardConstraints.map((c) => `- ${c}`)].join("\n"));
    }
    if (snapshot.planVersions.length > 0) {
      const refs = snapshot.planVersions.slice(-5).map((v) => v.versionId).join("、");
      parts.push(`[会话历史] 本会话已生成方案版本：${refs}（修改应基于最新语义继续，勿重复早期已废弃布局）。`);
    }
    return parts.length > 0 ? parts.join("\n\n") : "";
  }

  /** 压缩摘要：`[摘要]` 头 + 轮次要点 + `[硬约束]` 段（protectHardConstraints）。 */
  private buildSummary(rounds: Round[], hardConstraints: string[]): string {
    const lines: string[] = [`[摘要] 此前 ${rounds.length} 轮对话已压缩：`];
    rounds.forEach((round, i) => {
      const user = round.user ? truncate(userText(round.user.data), this.excerptChars) : "（无用户输入）";
      lines.push(`第${i + 1}轮：用户「${user}」→ ${outcomeOf(round)}`);
    });
    if (hardConstraints.length > 0) {
      lines.push("[硬约束]（以下为用户显式要求，任何后续生成必须遵守，不得省略）：");
      for (const c of hardConstraints) lines.push(`- ${c}`);
    }
    return lines.join("\n");
  }
}

interface Round {
  user: SessionEntry | null;
  entries: SessionEntry[];
}

/** 轮次切分：一个 user 条目起一轮，直到下一个 user 条目。 */
function splitRounds(messages: SessionEntry[]): Round[] {
  const rounds: Round[] = [];
  let current: Round | null = null;
  for (const entry of messages) {
    if (entry.kind === "user" || current === null) {
      current = { user: entry.kind === "user" ? entry : null, entries: [entry] };
      rounds.push(current);
    } else {
      current.entries.push(entry);
    }
  }
  return rounds;
}

function outcomeOf(round: Round): string {
  for (let i = round.entries.length - 1; i >= 0; i -= 1) {
    const e = round.entries[i]!;
    if (e.kind === "assistant" && isPlanOutcome(e.data)) return `方案版本 ${e.data.versionId}`;
    if (e.kind === "assistant" && isImageOutcome(e.data)) return `表现图 ${e.data.imageId}`;
    if (e.kind === "image" && isImageEntry(e.data)) return `表现图 ${e.data.imageId}`;
  }
  const last = round.entries[round.entries.length - 1];
  const text = last ? userText(last.data) : "";
  return truncate(text, 24) || "（无输出）";
}

function userText(data: unknown): string {
  if (typeof data === "string") return data;
  if (data && typeof data === "object") {
    const d = data as Record<string, unknown>;
    if (typeof d["text"] === "string") return d["text"];
    if (typeof d["delta"] === "string") return d["delta"];
  }
  return JSON.stringify(data);
}

function isPlanOutcome(data: unknown): data is { kind: "plan"; versionId: string } {
  return (
    !!data && typeof data === "object" && (data as Record<string, unknown>)["kind"] === "plan" &&
    typeof (data as Record<string, unknown>)["versionId"] === "string"
  );
}

function isImageOutcome(data: unknown): data is { kind: "image"; imageId: string } {
  return (
    !!data && typeof data === "object" && (data as Record<string, unknown>)["kind"] === "image" &&
    typeof (data as Record<string, unknown>)["imageId"] === "string"
  );
}

function isImageEntry(data: unknown): data is { imageId: string; url: string } {
  return (
    !!data && typeof data === "object" &&
    typeof (data as Record<string, unknown>)["imageId"] === "string" &&
    typeof (data as Record<string, unknown>)["url"] === "string"
  );
}

function truncate(s: string, max: number): string {
  return s.length <= max ? s : `${s.slice(0, max)}…`;
}
