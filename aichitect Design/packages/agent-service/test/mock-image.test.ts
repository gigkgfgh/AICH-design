/**
 * P012 图像链路单测：MockImageProvider 确定性 / ImageRegistry 落盘与会话元数据注册。
 * 运行：npm run test -w @aichdesign/agent-service（vitest --run 部分）。
 */

import { afterEach, describe, expect, it } from "vitest";
import { existsSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { MockImageProvider, imageSeed, parseSizePreset } from "../src/adapters/image-api";
import { MockAdapter } from "../src/adapters/mock-adapter.js";
import { ImageRegistry } from "../src/image/image-registry";
import { JsonlSessionStore } from "../src/session/jsonl-store";
import { probeImageFromDataUrl } from "@aichdesign/extensions";
import type { ToolBinding } from "../src/adapters/common.js";
import type { AgentResponse, SseEventEnvelope, SseProgressData } from "@aichdesign/shared";

const tmpDirs: string[] = [];

function makeTmpDir(): string {
  const dir = join(tmpdir(), `aich-image-test-${Date.now()}-${Math.floor(Math.random() * 1e6)}`);
  tmpDirs.push(dir);
  return dir;
}

afterEach(() => {
  for (const dir of tmpDirs.splice(0)) {
    rmSync(dir, { recursive: true, force: true });
  }
});

describe("MockImageProvider", () => {
  it("确定性：同 prompt+size 同 dataURL；不同 prompt 不同图", async () => {
    const port = new MockImageProvider();
    const a1 = await port.generate({ prompt: "客厅表现图", size: "1024x1024", quality: "medium", outputFormat: "png", n: 1 });
    const a2 = await port.generate({ prompt: "客厅表现图", size: "1024x1024", quality: "medium", outputFormat: "png", n: 1 });
    const b = await port.generate({ prompt: "卧室表现图", size: "1024x1024", quality: "medium", outputFormat: "png", n: 1 });
    expect(a1.url).toBe(a2.url);
    expect(a1.url).not.toBe(b.url);
    expect(a1.imageId).not.toBe(a2.imageId); // imageId 唯一（版本树可区分同 prompt 多次生成）
  });

  it("dataURL 为可探测 PNG 且尺寸与请求一致；meta 含 model/provider/costUsd", async () => {
    const port = new MockImageProvider();
    const result = await port.generate({ prompt: "客厅表现图", size: "1536x1024", quality: "high", outputFormat: "png", n: 1 });
    const info = probeImageFromDataUrl(result.url);
    expect(info).toEqual({ width: 1536, height: 1024, format: "png", alphaPng: false });
    expect(result.meta.model).toBe("mock-image-0.1");
    expect(result.meta.provider).toBe("mock-image");
    expect(result.meta.costUsd).toBeGreaterThan(0);
    expect(result.meta.prompt).toBe("客厅表现图");
    expect(result.meta.status).toBe("succeeded");
  });

  it("mock edit 不读取参考图，基于 prompt 生成变体", async () => {
    const port = new MockImageProvider();
    const result = await port.edit({ images: ["file:///tmp/ref.png"], prompt: "改成暖色", mask: "file:///tmp/mask.png", size: "1024x1024", quality: "medium", outputFormat: "png", n: 1 });
    expect(probeImageFromDataUrl(result.url)).not.toBeNull();
    expect(result.meta.prompt).toBe("改成暖色");
  });

  it("parseSizePreset / imageSeed 确定性", () => {
    expect(parseSizePreset("1024x1536")).toEqual({ width: 1024, height: 1536 });
    expect(imageSeed("a", "b")).toBe(imageSeed("a", "b"));
    expect(imageSeed("a", "b")).not.toBe(imageSeed("a", "c"));
  });
});

describe("ImageRegistry（B-4 会话图像元数据注册）", () => {
  it("落盘 images/ 邻近目录 + 会话 jsonl 记 image 条目 + file:// url", async () => {
    const dir = makeTmpDir();
    const sessionsDir = join(dir, "sessions");
    const store = new JsonlSessionStore(sessionsDir);
    const registry = new ImageRegistry(sessionsDir, store);

    const port = new MockImageProvider();
    const result = await port.generate({ prompt: "客厅表现图", size: "1024x1024", quality: "medium", outputFormat: "png", n: 1 });
    const registered = registry.store("s-1", result, { refPlanVersionId: "v_plan_1", refImageId: "ref-1" });

    expect(registered.url.startsWith("file:///")).toBe(true);
    const pngPath = join(sessionsDir, "images", `${result.imageId}.png`);
    expect(existsSync(pngPath)).toBe(true);

    const lines = store.readLines("s-1");
    const imageEntries = lines.filter((l) => l.kind === "image");
    expect(imageEntries.length).toBe(1);
    const entry = imageEntries[0]!.data as { imageId: string; url: string; meta: Record<string, unknown> };
    expect(entry.imageId).toBe(result.imageId);
    expect(entry.url).toBe(registered.url);
    expect(entry.meta.parentVersionId).toBe("v_plan_1");
    expect(entry.meta.refImageId).toBe("ref-1");
    expect(entry.meta.model).toBe("mock-image-0.1");
  });

  it("resolveUrl 供 image_edit 参考解析", async () => {
    const dir = makeTmpDir();
    const sessionsDir = join(dir, "sessions");
    const store = new JsonlSessionStore(sessionsDir);
    const registry = new ImageRegistry(sessionsDir, store);
    const port = new MockImageProvider();
    const result = await port.generate({ prompt: "客厅", size: "1024x1024", quality: "medium", outputFormat: "png", n: 1 });
    registry.store("s-1", result);
    expect(registry.resolveUrl(result.imageId)).toBeDefined();
    expect(registry.resolveUrl("img_missing")).toBeUndefined();
  });

  it("非 dataURL 产物拒绝（防错误路径）", () => {
    const dir = makeTmpDir();
    const registry = new ImageRegistry(join(dir, "sessions"));
    expect(() =>
      registry.store("s-1", { imageId: "img_x", url: "file:///tmp/x.png", format: "png", meta: { prompt: "x", model: "m", provider: "p" } }),
    ).toThrow("仅接受 dataURL");
  });
});

/* ---------------- R2 P1 修复：图像全链路 SSE 事件序列（progress 契约 SseProgressData，R2-REV 冒烟 sawProgress） ---------------- */

describe("MockAdapter 图像全链路（SSE 事件序列含 progress）", () => {
  it("genImage 序列 delta → progress(percent 递增, phase=image_generate) → done(kind=image)", async () => {
    const port = new MockImageProvider();
    const binding: ToolBinding = {
      def: {
        name: "image_generate",
        description: "生成建筑表现图",
        label: "image_generate",
        parameters: {},
      },
      execute: async (params) => {
        const result = await port.generate({
          prompt: String(params.prompt),
          size: "1024x1024",
          quality: "medium",
          outputFormat: "png",
          n: 1,
        });
        return { text: "image_generate ok", details: result, isError: false };
      },
    };
    const adapter = new MockAdapter({
      tools: [binding],
      usageSink: () => {},
      delayMs: 1,
    });
    const handle = await adapter.run({
      requestId: "r-img-seq-1",
      sessionId: "s-img-seq-1",
      request: { kind: "genImage", sessionId: "s-img-seq-1", prompt: "客厅表现图" },
    });
    const events: SseEventEnvelope[] = [];
    for await (const ev of handle.events) events.push(ev);
    await handle.result;

    expect(events.length).toBeGreaterThanOrEqual(3);
    const types = events.map((e) => e.type);
    expect(types[0]).toBe("delta");
    expect(types).toContain("progress");
    expect(types).toContain("done");

    const progresses = events.filter((e) => e.type === "progress").map((e) => e.data as SseProgressData);
    expect(progresses.length).toBeGreaterThanOrEqual(1);
    for (const p of progresses) {
      expect(p.phase).toBe("image_generate");
      expect(typeof p.percent).toBe("number");
      expect(typeof p.message).toBe("string");
      expect(p.message!.length).toBeGreaterThan(0);
    }
    // percent 递增（mock 路径 30 → 80）
    const percents = progresses.map((p) => p.percent ?? 0);
    expect([...percents].sort((a, b) => a - b)).toEqual(percents);

    // progress 全部在 done 前（done 前至少 1 条）
    const doneIdx = events.findIndex((e) => e.type === "done");
    const lastProgressIdx = events.reduce((m, e, i) => (e.type === "progress" ? i : m), -1);
    expect(lastProgressIdx).toBeGreaterThanOrEqual(0);
    expect(doneIdx).toBeGreaterThan(lastProgressIdx);

    const done = events[doneIdx]!.data as AgentResponse;
    expect(done.kind).toBe("image");
  });
});