/**
 * 会话转录回放（R7-1，替代 P019 ContextManager）。
 *
 * 从 sessions/<sessionId>.jsonl 重建 pi-agent-core 内核转录（user/assistant 消息序列），
 * 在会话 Agent 创建时装入 initialState.messages——服务重启后 LLM 上下文与 UI 记忆重新对齐。
 * 全量保留、无压缩（用户决策：删除 ContextManager，上下文不裁剪）。
 *
 * 忠实度边界（登记）：jsonl 的 assistant 条目仅存最终文本（无 ToolCall/thinking 逐 turn 结构），
 * 回放为「user 文本(+图片引用) / assistant 文本」交替——对话连续性达成，工具循环不逐条还原。
 * 重试产生的重复 user 条目按原样回放。
 */

import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import type { JsonlSessionStore, SessionEntry } from "./jsonl-store.js";
import type { ImageRegistry } from "../image/image-registry.js";

/** 内核消息的结构最小集（AgentMessage 的 user/assistant 形状；结构化类型避免依赖内核导出面）。 */
type ReplayMessage =
  | {
      role: "user";
      content: string | Array<{ type: "text"; text: string } | { type: "image"; data: string; mimeType: string }>;
      timestamp: number;
    }
  | { role: "assistant"; content: Array<{ type: "text"; text: string }>; timestamp: number };

/** 单图读取上限（与适配器 analysisImages 组装口径一致：8MB）。 */
const MAX_IMAGE_BYTES = 8 * 1024 * 1024;

/**
 * 重建会话转录。错误条目（error kind）跳过——失败运行不进入后续 LLM 上下文；
 * 任何异常返回 []（回放失败不阻断运行）。
 */
export function replayTranscript(
  store: JsonlSessionStore,
  sessionId: string,
  registry?: ImageRegistry | null,
): ReplayMessage[] {
  const messages: ReplayMessage[] = [];
  let lines: SessionEntry[];
  try {
    lines = store.readLines(sessionId);
  } catch {
    return [];
  }
  for (const line of lines) {
    if (line.kind === "user") {
      const data = line.data as { text?: unknown; imageIds?: unknown } | null;
      const text = typeof data?.text === "string" ? data.text : "";
      const blocks: Array<{ type: "text"; text: string } | { type: "image"; data: string; mimeType: string }> = [];
      if (text.length > 0) blocks.push({ type: "text", text });
      const imageIds = Array.isArray(data?.imageIds) ? (data?.imageIds as unknown[]) : [];
      for (const imageId of imageIds) {
        if (typeof imageId !== "string") continue;
        const image = readRegisteredImage(registry, imageId);
        if (image) blocks.push(image);
      }
      if (blocks.length === 0) continue;
      const ts = timestampOf(line.ts);
      messages.push(
        blocks.every((b) => b.type === "text")
          ? { role: "user", content: blocks.map((b) => (b as { text: string }).text).join(""), timestamp: ts }
          : { role: "user", content: blocks, timestamp: ts },
      );
    } else if (line.kind === "assistant") {
      const data = line.data as { text?: unknown } | null;
      const text = typeof data?.text === "string" ? data.text.trim() : "";
      if (text.length === 0) continue;
      messages.push({ role: "assistant", content: [{ type: "text", text }], timestamp: timestampOf(line.ts) });
    }
  }
  return messages;
}

/** 已注册图片 → ImageContent（file:// 读盘 base64；缺失/超限/读盘失败返回 null 跳过）。 */
function readRegisteredImage(
  registry: ImageRegistry | null | undefined,
  imageId: string,
): { type: "image"; data: string; mimeType: string } | null {
  const url = registry?.resolveUrl(imageId);
  if (!url || !url.startsWith("file://")) return null;
  try {
    const bytes = readFileSync(fileURLToPath(url));
    if (bytes.length > MAX_IMAGE_BYTES) return null;
    const ext = url.split(".").pop()?.toLowerCase() ?? "";
    const mimeType = ext === "png" ? "image/png" : ext === "webp" ? "image/webp" : "image/jpeg";
    return { type: "image", data: bytes.toString("base64"), mimeType };
  } catch {
    return null;
  }
}

function timestampOf(iso: string): number {
  const t = Date.parse(iso);
  return Number.isFinite(t) ? t : Date.now();
}
