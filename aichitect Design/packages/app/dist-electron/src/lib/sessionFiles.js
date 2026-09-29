/**
 * 会话 jsonl 解析纯函数（P-R3 前端重构：主进程 sessions:list/read 的解析层）。
 *
 * 数据源与 agent-service JsonlSessionStore 同构：每行 { ts, kind, requestId?, data }。
 * - user 行 data: { text, kind }
 * - assistant 行 data: { kind: 'plan'|'image'|'stream', versionId?, text?, imageId?, url? }
 * - image 行 data: { imageId, url, meta }（ImageRegistry 落盘回执）
 * 本层不接触 fs（可单测）；损坏行容错跳过（与 JsonlSessionStore.readLines 同策略）。
 */
export function parseEntryLine(line) {
    const trimmed = line.trim();
    if (trimmed === '')
        return null;
    try {
        const parsed = JSON.parse(trimmed);
        if (parsed && typeof parsed === 'object')
            return parsed;
        return null;
    }
    catch {
        return null; // 崩溃边缘写入的损坏行
    }
}
const TITLE_MAX_CHARS = 40;
function asRecord(data) {
    return data && typeof data === 'object' ? data : null;
}
function str(v) {
    return typeof v === 'string' && v.length > 0 ? v : undefined;
}
/** 标题：首条 user 消息文本截断；无则「（无标题会话）」 */
function titleFrom(entries) {
    for (const e of entries) {
        if (e.kind === 'user') {
            const text = str(asRecord(e.data)?.['text']);
            if (text)
                return text.length > TITLE_MAX_CHARS ? `${text.slice(0, TITLE_MAX_CHARS)}…` : text;
        }
    }
    return '（无标题会话）';
}
/** 解析一个会话文件内容 → 列表摘要（sessions:list 用；不解析全量消息文本）。 */
export function summarizeSession(sessionId, content) {
    const entries = content.split('\n').map(parseEntryLine).filter((e) => e !== null);
    let messageCount = 0;
    let lastTs = '';
    for (const e of entries) {
        if (e.kind === 'user' || e.kind === 'assistant')
            messageCount += 1;
        const ts = str(e.ts);
        if (ts && ts > lastTs)
            lastTs = ts; // ISO 字符串字典序即时间序
    }
    return {
        sessionId,
        title: titleFrom(entries),
        lastTs: lastTs || new Date(0).toISOString(),
        messageCount,
    };
}
/** 解析一个会话文件内容 → 完整恢复内容（sessions:read 用）。 */
export function parseSessionContent(sessionId, content) {
    const entries = content.split('\n').map(parseEntryLine).filter((e) => e !== null);
    const messages = [];
    const images = [];
    const versionRefs = [];
    let seq = 0;
    for (const e of entries) {
        const data = asRecord(e.data);
        if (e.kind === 'user' && data) {
            const text = str(data['text']);
            if (text) {
                seq += 1;
                messages.push({ id: `restore-${sessionId}-${seq}`, role: 'user', text });
            }
        }
        else if (e.kind === 'assistant' && data) {
            const kind = str(data['kind']);
            const ts = str(e.ts) ?? new Date(0).toISOString();
            let text = str(data['text']);
            const versionId = str(data['versionId']);
            const imageId = str(data['imageId']);
            if (!text) {
                if (kind === 'plan' && versionId)
                    text = `已生成方案版本 ${versionId}。`;
                else if (kind === 'image' && imageId)
                    text = `已生成表现图 ${imageId}。`;
                else
                    text = undefined;
            }
            if (kind === 'plan' && versionId) {
                versionRefs.push({ versionId, createdAt: ts });
            }
            if (text) {
                seq += 1;
                messages.push({
                    id: `restore-${sessionId}-${seq}`,
                    role: 'assistant',
                    text,
                    planVersionId: kind === 'plan' ? versionId : undefined,
                });
            }
        }
        else if (e.kind === 'image' && data) {
            const imageId = str(data['imageId']);
            const url = str(data['url']);
            const meta = asRecord(data['meta']);
            if (imageId && url && meta) {
                const ts = str(e.ts) ?? meta.createdAt ?? new Date(0).toISOString();
                images.push({
                    imageId,
                    url,
                    meta,
                    parentPlanVersionId: str(meta.parentVersionId) ?? null,
                    createdAt: meta.createdAt ?? ts,
                });
            }
        }
        // usage/error/tool/run/event 行不进恢复视图（审计数据，非对话内容）
    }
    return { sessionId, title: titleFrom(entries), messages, images, versionRefs };
}
/** sessionId 白名单（与后端 SESSION_ID_RE 同源；主进程读文件前的防御校验）。 */
export const SESSION_ID_RE = /^[A-Za-z0-9._-]{1,64}$/;
//# sourceMappingURL=sessionFiles.js.map