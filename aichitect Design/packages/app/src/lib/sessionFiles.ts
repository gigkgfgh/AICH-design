/**
 * 会话 jsonl 解析纯函数（P-R3 前端重构：主进程 sessions:list/read 的解析层）。
 *
 * 数据源与 agent-service JsonlSessionStore 同构：每行 { ts, kind, requestId?, data }。
 * - user 行 data: { text, kind }
 * - assistant 行 data: { kind: 'image'|'stream', text?, imageId?, url? }（R7-1：plan 条目为遗留数据，解析时忽略）
 * - image 行 data: { imageId, url, meta }（ImageRegistry 落盘回执）
 * 本层不接触 fs（可单测）；损坏行容错跳过（与 JsonlSessionStore.readLines 同策略）。
 */

import type { ImageMeta, ImageVersion, RestoredMessage, RestoredUsage, SessionContent, SessionSummary } from '../types/contracts.js';

/** jsonl 原始行形状（宽松解析后判别） */
interface RawEntry {
  ts?: unknown;
  kind?: unknown;
  requestId?: unknown;
  data?: unknown;
}

export function parseEntryLine(line: string): RawEntry | null {
  const trimmed = line.trim();
  if (trimmed === '') return null;
  try {
    const parsed = JSON.parse(trimmed) as RawEntry;
    if (parsed && typeof parsed === 'object') return parsed;
    return null;
  } catch {
    return null; // 崩溃边缘写入的损坏行
  }
}

const TITLE_MAX_CHARS = 40;

function asRecord(data: unknown): Record<string, unknown> | null {
  return data && typeof data === 'object' ? (data as Record<string, unknown>) : null;
}

function str(v: unknown): string | undefined {
  return typeof v === 'string' && v.length > 0 ? v : undefined;
}

/** 标题：首条 user 消息文本截断；无则「（无标题会话）」 */
function titleFrom(entries: RawEntry[]): string {
  for (const e of entries) {
    if (e.kind === 'user') {
      const text = str(asRecord(e.data)?.['text']);
      if (text) return text.length > TITLE_MAX_CHARS ? `${text.slice(0, TITLE_MAX_CHARS)}…` : text;
    }
  }
  return '（无标题会话）';
}

/** 解析一个会话文件内容 → 列表摘要（sessions:list 用；不解析全量消息文本）。 */
export function summarizeSession(sessionId: string, content: string): SessionSummary {
  const entries = content.split('\n').map(parseEntryLine).filter((e): e is RawEntry => e !== null);
  let messageCount = 0;
  let lastTs = '';
  for (const e of entries) {
    if (e.kind === 'user' || e.kind === 'assistant') messageCount += 1;
    const ts = str(e.ts);
    if (ts && ts > lastTs) lastTs = ts; // ISO 字符串字典序即时间序
  }
  return {
    sessionId,
    title: titleFrom(entries),
    lastTs: lastTs || new Date(0).toISOString(),
    messageCount,
  };
}

/** 解析一个会话文件内容 → 完整恢复内容（sessions:read 用）。 */
export function parseSessionContent(sessionId: string, content: string): SessionContent {
  const entries = content.split('\n').map(parseEntryLine).filter((e): e is RawEntry => e !== null);
  const messages: RestoredMessage[] = [];
  const images: ImageVersion[] = [];
  // R7-2：imageId → file:// url 索引（image 条目落盘回执），用于恢复用户消息的图片附件
  const imageUrlById = new Map<string, string>();
  // R7-2：usage 行聚合（重启后用量胶囊恢复的数据源）；last* 取最后一行，session* 全程累计
  const usageAcc: RestoredUsage = {
    lastPromptTokens: 0,
    lastCompletionTokens: 0,
    lastCacheReadTokens: 0,
    contextWindow: 0,
    contextSystemTokens: 0,
    contextToolTokens: 0,
    sessionInput: 0,
    sessionCacheRead: 0,
    sessionCacheWrite: 0,
    sessionOutput: 0,
    sessionTotal: 0,
    sessionReasoning: 0,
  };
  let hasUsage = false;

  let seq = 0;
  for (const e of entries) {
    const data = asRecord(e.data);
    if (e.kind === 'user' && data) {
      const text = str(data['text']);
      const imageIds = Array.isArray(data['imageIds'])
        ? (data['imageIds'] as unknown[]).filter((x): x is string => typeof x === 'string')
        : [];
      const restoredImages = imageIds
        .map((id) => imageUrlById.get(id))
        .filter((u): u is string => typeof u === 'string');
      if (text || restoredImages.length > 0) {
        seq += 1;
        messages.push({
          id: `restore-${sessionId}-${seq}`,
          role: 'user',
          text: text ?? '',
          ...(restoredImages.length > 0 ? { images: restoredImages } : {}),
        });
      }
    } else if (e.kind === 'assistant' && data) {
      const kind = str(data['kind']);
      let text = str(data['text']);
      const imageId = str(data['imageId']);
      if (!text && kind === 'image' && imageId) text = `已生成表现图 ${imageId}。`;
      if (text) {
        seq += 1;
        messages.push({
          id: `restore-${sessionId}-${seq}`,
          role: 'assistant',
          text,
        });
      }
    } else if (e.kind === 'image' && data) {
      const imageId = str(data['imageId']);
      const url = str(data['url']);
      // 索引始终回填：对话消息（user.imageIds）的图片显示不随"移出画布"失效
      if (imageId && url) imageUrlById.set(imageId, url);
      const meta = asRecord(data['meta']) as ImageMeta | null;
      // canvasRemoved = 画布中已删除（仅移出画布；对话引用与磁盘文件保留）
      const canvasRemoved = data['canvasRemoved'] === true;
      if (imageId && url && meta && !canvasRemoved) {
        const ts = str(e.ts) ?? meta.createdAt ?? new Date(0).toISOString();
        images.push({
          imageId,
          url,
          meta,
          createdAt: meta.createdAt ?? ts,
        });
      }
    } else if (e.kind === 'usage' && data) {
      // R7-2：usage 行（UsageRecord 形状；promptTokens 为未缓存输入口径）→ 用量聚合回填
      const num = (key: string): number => (typeof data[key] === 'number' ? (data[key] as number) : 0);
      const miss = num('promptTokens');
      const completion = num('completionTokens');
      const cacheRead = num('cacheReadTokens');
      const cacheWrite = num('cacheWriteTokens');
      usageAcc.sessionInput += miss;
      usageAcc.sessionCacheRead += cacheRead;
      usageAcc.sessionCacheWrite += cacheWrite;
      usageAcc.sessionOutput += completion;
      usageAcc.sessionTotal += num('totalTokens');
      // last* 对齐 SSE 口径：prompt = 未缓存输入 + 缓存读取 + 缓存写入
      usageAcc.lastPromptTokens = miss + cacheRead + cacheWrite;
      usageAcc.lastCompletionTokens = completion;
      usageAcc.lastCacheReadTokens = cacheRead;
      const context = asRecord(data['context']);
      if (context) {
        usageAcc.contextWindow = typeof context['contextWindow'] === 'number' ? (context['contextWindow'] as number) : 0;
        usageAcc.contextSystemTokens =
          typeof context['systemTokens'] === 'number' ? (context['systemTokens'] as number) : 0;
        usageAcc.contextToolTokens =
          typeof context['toolTokens'] === 'number' ? (context['toolTokens'] as number) : 0;
      }
      hasUsage = true;
    }
    // error/tool/run/event 行不进恢复视图（审计数据，非对话内容）
  }

  return { sessionId, title: titleFrom(entries), messages, images, ...(hasUsage ? { usage: usageAcc } : {}) };
}

/** sessionId 白名单（与后端 SESSION_ID_RE 同源；主进程读文件前的防御校验）。 */
export const SESSION_ID_RE = /^[A-Za-z0-9._-]{1,64}$/;
