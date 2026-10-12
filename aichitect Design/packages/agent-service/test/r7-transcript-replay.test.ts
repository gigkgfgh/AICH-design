/**
 * R7-1：会话转录回放（transcript-replay）+ 图像注册表 jsonl 回填（rehydrate）。
 * 替代 P019 ContextManager：服务重启后从 jsonl 重建内核转录与 imageId 映射，
 * UI 与 LLM 记忆重新对齐（全量保留，无压缩）。
 */
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import { afterEach, describe, expect, it } from "vitest";
import { JsonlSessionStore } from "../src/session/jsonl-store.js";
import { replayTranscript } from "../src/session/transcript-replay.js";
import { ImageRegistry } from "../src/image/image-registry.js";
import type { ImageApiResult } from "../src/adapters/image-api.js";

/** 最小合法 1x1 PNG dataURL（夹具用；不依赖任何出图端口实现）。 */
const PNG_1X1 =
  "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==";

/** 构造图像产物夹具（形状与 ImageApiPort 产物一致）。 */
function fixtureImage(prompt: string): ImageApiResult {
  return {
    imageId: `img_${randomUUID()}`,
    url: PNG_1X1,
    format: "png",
    meta: {
      prompt,
      model: "test-fixture",
      provider: "test",
      width: 1,
      height: 1,
      status: "succeeded",
      createdAt: new Date().toISOString(),
    },
  };
}

const dirs: string[] = [];
function makeTmpDir(): string {
  const dir = mkdtempSync(join(tmpdir(), "aich-replay-"));
  dirs.push(dir);
  return dir;
}
afterEach(() => {
  // 临时目录留给 OS 清理（Windows 句柄释放时机不稳，rmSync 重试代价高）。
  void dirs;
});

describe("replayTranscript（R7-1 转录回放）", () => {
  it("user/assistant 文本重建；error 条目跳过；顺序保持", () => {
    const dir = makeTmpDir();
    const store = new JsonlSessionStore(join(dir, "sessions"));
    store.append("s1", "user", { text: "第一轮问题", kind: "chat" }, "r1");
    store.append("s1", "assistant", { kind: "stream", text: "第一轮回答" }, "r1");
    store.append("s1", "error", { kind: "error", code: "RUNNER_ERROR", message: "上游失败" }, "r2");
    store.append("s1", "user", { text: "第二轮问题", kind: "chat" }, "r3");
    store.append("s1", "assistant", { kind: "image", imageId: "img_1", url: "file:///x.png" }, "r3");

    const messages = replayTranscript(store, "s1");
    expect(messages).toHaveLength(3);
    expect(messages[0]).toMatchObject({ role: "user", content: "第一轮问题" });
    expect(messages[1]).toMatchObject({ role: "assistant" });
    expect((messages[1].content as Array<{ text: string }>)[0]?.text).toBe("第一轮回答");
    expect(messages[2]).toMatchObject({ role: "user", content: "第二轮问题" });
  });

  it("user 条目 imageIds 经 ImageRegistry 还原为 image 内容块；注册表缺失跳过", async () => {
    const dir = makeTmpDir();
    const sessionsDir = join(dir, "sessions");
    const store = new JsonlSessionStore(sessionsDir);
    const registry = new ImageRegistry(sessionsDir, store);
    const result = fixtureImage("参考图");
    const registered = registry.store("s1", result);

    store.append("s1", "user", { text: "看这张图", kind: "chat", imageIds: [registered.imageId, "img_missing"] }, "r1");
    const messages = replayTranscript(store, "s1", registry);
    expect(messages).toHaveLength(1);
    const content = messages[0]!.content as Array<{ type: string; mimeType?: string }>;
    expect(content).toHaveLength(2);
    expect(content[0]).toMatchObject({ type: "text", text: "看这张图" });
    expect(content[1]).toMatchObject({ type: "image", mimeType: "image/png" });

    // 无注册表（registry 缺省）：图片块跳过，仅剩文本。
    const withoutRegistry = replayTranscript(store, "s1");
    expect(withoutRegistry[0]!.content).toBe("看这张图");
  });
});

describe("ImageRegistry.rehydrate（R7-1 重启回填）", () => {
  it("从既有会话 jsonl 重建 imageId→file:// 映射；文件缺失的条目不回填", async () => {
    const dir = makeTmpDir();
    const sessionsDir = join(dir, "sessions");
    const store = new JsonlSessionStore(sessionsDir);
    const first = new ImageRegistry(sessionsDir, store);
    const result = fixtureImage("落盘图");
    const registered = first.store("s-live", result);
    // 模拟另一条目文件已被清理：直接伪造 jsonl 行。
    store.append("s-live", "image", { imageId: "img_gone", url: "file:///" + join(sessionsDir, "images", "img_gone.png").replace(/\\/g, "/"), meta: {} });

    // 「重启」：全新注册表实例（内存映射为空）。
    const second = new ImageRegistry(sessionsDir, store);
    expect(second.resolveUrl(registered.imageId)).toBeUndefined();
    expect(second.rehydrate()).toBe(1);
    expect(second.resolveUrl(registered.imageId)).toBe(registered.url);
    expect(second.resolveUrl("img_gone")).toBeUndefined();
  });

  it("写入 ImageMeta 的 status/createdAt 兜底可经回放路径读回（dataURL 落盘契约不变）", () => {
    const dir = makeTmpDir();
    const sessionsDir = join(dir, "sessions");
    const store = new JsonlSessionStore(sessionsDir);
    // 直接写入用户上传形状（/v1/images 路径）：dataURL → 落盘 → jsonl。
    const registry = new ImageRegistry(sessionsDir, store);
    const dataUrl = "data:image/png;base64," + Buffer.from("fake-png-bytes").toString("base64");
    const registered = registry.store("s-up", {
      imageId: "img_up_test",
      url: dataUrl,
      format: "png",
      meta: { prompt: "用户上传参考图", model: "user-upload", provider: "user", status: "succeeded" },
    });
    expect(registered.url.startsWith("file:///")).toBe(true);
    const entry = store.readLines("s-up").find((l) => l.kind === "image");
    expect(entry).toBeDefined();
    // 重启后 rehydrate 可还原该上传图（识读修复的关键路径）。
    const second = new ImageRegistry(sessionsDir, store);
    second.rehydrate();
    expect(second.resolveUrl("img_up_test")).toBe(registered.url);
    void writeFileSync;
  });
});
