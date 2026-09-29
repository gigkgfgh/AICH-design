/**
 * P019 Session/Context Manager 测试：
 * - estimateTokens：CJK/ASCII 估算口径；
 * - extractHardConstraints：尺寸/面积/朝向/层高/硬性措辞，去重与保守抽取；
 * - snapshot：未超预算不压缩；超 70% 触发压缩（近期轮次保留、早期入摘要、
 *   硬约束段完整并入摘要——protectHardConstraints）；
 * - 结构化层（版本树/图像）原样保留不参与压缩；
 * - rehydration 冒烟 A：手工 jsonl → 新实例 recoverSession 同构；
 * - rehydration 冒烟 B：MockAdapter 真实跑 draftPlan/genImage 落盘 →
 *   「重启」（新 store/新 ContextManager 实例）→ recoverSession 恢复消息/版本/图像。
 */

import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { JsonlSessionStore } from "../src/session/jsonl-store.js";
import {
  ContextManager,
  estimateTokens,
  extractHardConstraints,
  DEFAULT_CONTEXT_BUDGET_TOKENS,
} from "../src/session/context-manager.js";
import { MockAdapter } from "../src/adapters/mock-adapter.js";
import { UsageTracker } from "../src/telemetry/usage-tracker.js";
import { ImageRegistry } from "../src/image/image-registry.js";
import { buildPlanToolBindings, buildImageToolBindings, resolveImagePort } from "../src/main.js";
import { MockImageProvider } from "../src/adapters/image-api.js";
import { loadConfig } from "../src/config.js";

let dir: string;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "aich-ctx-"));
});

afterEach(() => {
  rmSync(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
});

describe("estimateTokens", () => {
  it("CJK ≈ 1 token/字，ASCII ≈ 0.25 token/字符", () => {
    expect(estimateTokens("两室一厅")).toBe(4);
    expect(estimateTokens("abcd")).toBe(1);
    expect(estimateTokens("abc")).toBe(1); // ceil(3/4)
    expect(estimateTokens("")).toBe(0);
  });
});

describe("extractHardConstraints", () => {
  it("尺寸 / 面积 / 朝向 / 层高 / 硬性措辞", () => {
    const out = extractHardConstraints([
      "帮我设计 12x8米 的两室一厅，主卧朝南，建筑面积 89平米，层高3米。客厅必须朝南。",
    ]);
    expect(out).toContain("12x8米");
    expect(out).toContain("89平米");
    expect(out).toContain("朝南");
    expect(out).toContain("层高3米");
    expect(out.some((c) => c.includes("必须朝南"))).toBe(true);
  });

  it("去重 + 非约束文本不抽取", () => {
    const out = extractHardConstraints(["随便设计一个", "随便设计一个"]);
    expect(out).toEqual([]);
  });

  it("多种尺寸写法（米/m/全角×/空格）", () => {
    const out = extractHardConstraints(["地块 10.5m × 8m", "面宽 12米 x 9米"]);
    expect(out.some((c) => c.includes("10.5"))).toBe(true);
    expect(out.some((c) => c.includes("12米"))).toBe(true);
  });
});

describe("ContextManager.snapshot（压缩决策）", () => {
  it("未超预算：不压缩，消息全量保留", () => {
    const store = new JsonlSessionStore(dir);
    store.append("s1", "user", { text: "设计一个两室一厅" }, "r1");
    store.append("s1", "assistant", { kind: "plan", versionId: "v_1" }, "r1");
    const cm = new ContextManager(store, { budgetTokens: 8000 });
    const snap = cm.snapshot("s1");
    expect(snap.compressed).toBe(false);
    expect(snap.summary).toBeNull();
    expect(snap.messages.length).toBe(2);
    expect(snap.planVersions.map((v) => v.versionId)).toEqual(["v_1"]);
    expect(snap.hardConstraints).toEqual([]);
  });

  it("超 70% 预算：早期轮次入摘要，近期保留，硬约束段完整保留", () => {
    const store = new JsonlSessionStore(dir);
    // 第 1 轮（含硬约束，将被压缩——约束不得被吞）。
    store.append("s1", "user", { text: "设计 12x8米 两室一厅，主卧必须朝南" }, "r1");
    store.append("s1", "assistant", { kind: "plan", versionId: "v_1" }, "r1");
    // 中间多轮填充体量（触发压缩）。
    for (let i = 2; i <= 6; i += 1) {
      const filler = "把客厅扩大一些，增加一个书房，调整厨房布局，优化采光与通风，重复".repeat(8);
      store.append("s1", "user", { text: filler }, `r${i}`);
      store.append("s1", "assistant", { kind: "plan", versionId: `v_${i}` }, `r${i}`);
    }
    // 最后一轮（近期，应原样保留）。
    store.append("s1", "user", { text: "最后微调：卧室面积再大一点" }, "r7");
    store.append("s1", "assistant", { kind: "plan", versionId: "v_7" }, "r7");

    const cm = new ContextManager(store, { budgetTokens: 800 });
    const snap = cm.snapshot("s1");
    expect(snap.compressed).toBe(true);
    expect(snap.summary).not.toBeNull();
    // 摘要含轮次要点与硬约束段（protectHardConstraints）。
    expect(snap.summary).toContain("[摘要]");
    expect(snap.summary).toContain("硬约束");
    expect(snap.summary).toContain("12x8米");
    expect(snap.summary).toContain("必须朝南");
    // 硬约束元数据完整。
    expect(snap.hardConstraints).toContain("12x8米");
    // 近期轮次原样保留（最后的微调指令在 messages 中，不在摘要里丢失）。
    const lastUser = snap.messages.filter((m) => m.kind === "user").at(-1);
    expect(lastUser?.data).toMatchObject({ text: expect.stringContaining("最后微调") });
    // 结构化层：全部版本引用保留（含被压缩轮次的 v_1）。
    expect(snap.planVersions.map((v) => v.versionId)).toEqual(["v_1", "v_2", "v_3", "v_4", "v_5", "v_6", "v_7"]);
    expect(snap.compressed && snap.estimatedTokens >= 800 * 0.7).toBe(true);
  });

  it("压缩确定性：同一输入两次快照同构（无内部状态）", () => {
    const store = new JsonlSessionStore(dir);
    for (let i = 1; i <= 8; i += 1) {
      store.append("s1", "user", { text: `第${i}轮修改指令，`.repeat(30) }, `r${i}`);
      store.append("s1", "assistant", { kind: "plan", versionId: `v_${i}` }, `r${i}`);
    }
    const cm = new ContextManager(store, { budgetTokens: 600 });
    const a = cm.snapshot("s1");
    const b = new ContextManager(store, { budgetTokens: 600 }).snapshot("s1");
    expect(a).toEqual(b);
  });

  it("图像条目进结构化层（不参与消息层压缩）", () => {
    const store = new JsonlSessionStore(dir);
    store.append("s1", "user", { text: "生成客厅表现图" }, "r1");
    store.append("s1", "image", { imageId: "img_1", url: "file:///tmp/img_1.png", meta: { prompt: "客厅" } }, "r1");
    store.append("s1", "assistant", { kind: "image", imageId: "img_1", url: "file:///tmp/img_1.png" }, "r1");
    const cm = new ContextManager(store, { budgetTokens: 8000 });
    const snap = cm.snapshot("s1");
    expect(snap.images.map((i) => i.imageId)).toEqual(["img_1"]);
    expect(snap.messages.length).toBe(2); // user + assistant（image kind 不在消息层）
  });
});

describe("rehydration 冒烟", () => {
  it("A：jsonl → 新实例 recoverSession 同构", () => {
    const store = new JsonlSessionStore(dir);
    store.append("s1", "user", { text: "设计 12x8米 两室一厅，主卧朝南" }, "r1");
    store.append("s1", "assistant", { kind: "plan", versionId: "v_1" }, "r1");
    store.append("s1", "usage", { costUsd: 0.01 }, "r1");

    // 「重启」：新 store 指向同目录 + 新 ContextManager。
    const store2 = new JsonlSessionStore(dir);
    const cm2 = new ContextManager(store2, { budgetTokens: 8000 });
    const snap = cm2.recoverSession("s1");
    expect(snap.messages.map((m) => m.kind)).toEqual(["user", "assistant"]);
    expect(snap.planVersions[0]?.versionId).toBe("v_1");
    expect(snap.hardConstraints).toContain("12x8米");
    expect(snap.compressed).toBe(false);
  });

  it("B：MockAdapter 真实 draftPlan/genImage 落盘 → 重启 → 恢复消息/版本/图像", async () => {
    const store = new JsonlSessionStore(dir);
    const usageTracker = new UsageTracker();
    const imageRegistry = new ImageRegistry(dir, store);
    const config = loadConfig();
    const tools = [
      ...buildPlanToolBindings({ strictJson: config.strictJson }),
      ...buildImageToolBindings(resolveImagePort({ ...config, image: { ...config.image, mock: true } }, [imageRegistry.dir]).port),
    ];
    const adapter = new MockAdapter({
      tools,
      usageSink: (r) => usageTracker.recordOnce(r),
      sessionStore: store,
      imageRegistry,
      delayMs: 1,
    });

    // 会话内跑一轮方案 + 一轮图像。
    const planRun = await adapter.run({
      requestId: "r1",
      sessionId: "s9",
      request: { kind: "draftPlan", sessionId: "s9", prompt: "设计 12x8米 两室一厅，主卧必须朝南" },
    });
    const planResult = await planRun.result;
    expect(planResult.kind).toBe("plan");
    const imageRun = await adapter.run({
      requestId: "r2",
      sessionId: "s9",
      request: { kind: "genImage", sessionId: "s9", prompt: "客厅表现图" },
    });
    const imageResult = await imageRun.result;
    expect(imageResult.kind).toBe("image");

    // 「杀进程重启」：全新实例从 jsonl 恢复。
    const store2 = new JsonlSessionStore(dir);
    const cm2 = new ContextManager(store2, { budgetTokens: DEFAULT_CONTEXT_BUDGET_TOKENS });
    const snap = cm2.recoverSession("s9");
    expect(snap.messages.filter((m) => m.kind === "user").length).toBe(2);
    expect(snap.planVersions.length).toBe(1);
    expect(snap.planVersions[0]?.versionId).toBe((planResult as { versionId: string }).versionId);
    expect(snap.images.length).toBe(1);
    expect(snap.images[0]?.imageId).toBe((imageResult as { imageId: string }).imageId);
    expect(snap.hardConstraints).toContain("12x8米");
    expect(snap.hardConstraints.some((c) => c.includes("必须朝南"))).toBe(true);
    expect(snap.compressed).toBe(false);
  });
});
