/**
 * P017 storage 测试：迁移幂等 / fixture 往返（v0 库 → open 升级 → 数据可读）/
 * 备份先行 / fail-closed / WAL PRAGMA / Repository（图像元数据、费用幂等记账）。
 * R7-1：plan_version 仓储随方案链路移除。
 */

import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, rmSync, readdirSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { nodeSqlite } from "../src/sqlite.js";
import {
  openStorage,
  readUserVersion,
  STORAGE_SCHEMA_VERSION,
  SessionRepository,
  ImageMetaRepository,
  CostRepository,
} from "../src/index.js";
import type { ImageMeta } from "@aichdesign/shared";

let dir: string;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "aich-storage-"));
});

afterEach(() => {
  // WAL 模式残留 -wal/-shm 文件在 Windows 上短暂占用目录，需重试。
  rmSync(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
});

const dbPath = () => join(dir, "meta.db");

describe("openStorage：迁移与 PRAGMA", () => {
  it("新库：迁移到最新版本，幂等重开不重复应用", () => {
    const h = openStorage(dbPath());
    expect(h.migrations.applied).toEqual([1]);
    expect(readUserVersion(h.db)).toBe(STORAGE_SCHEMA_VERSION);
    expect(h.backupPath).toBeNull();
    h.close();

    const h2 = openStorage(dbPath());
    expect(h2.migrations).toEqual({ from: 1, to: 1, applied: [] });
    const applied = h2.db
      .prepare("SELECT COUNT(*) AS n FROM migrations")
      .get() as { n: number };
    expect(applied.n).toBe(1); // 审计表只有一条（幂等，不重复登记）
    h2.close();
  });

  it("WAL/foreign_keys PRAGMA 生效", () => {
    const h = openStorage(dbPath());
    const journal = h.db.prepare("PRAGMA journal_mode").get() as { journal_mode: string };
    const fk = h.db.prepare("PRAGMA foreign_keys").get() as { foreign_keys: number };
    expect(journal.journal_mode.toLowerCase()).toBe("wal");
    expect(fk.foreign_keys).toBe(1);
    h.close();
  });

  it("fixture 往返：手工 v0 空库 → open 升级到最新 → 写读一致", () => {
    // 手工构建旧库：无表、user_version=0（模拟 v1 迁移出现前的库文件）
    const path = dbPath();
    const legacy = new nodeSqlite.DatabaseSync(path);
    legacy.close();

    const h = openStorage(path);
    expect(h.migrations.applied).toEqual([1]);
    expect(existsSync(path)).toBe(true);

    // 升级后写入并读回（数据可读）
    const costs = new CostRepository(h.db);
    costs.record({ sessionId: "s1", requestId: "r1", requestKind: "chat", model: "m", provider: "mock", promptTokens: 1, completionTokens: 1, totalTokens: 2, costUsd: 0.01, latencyMs: 1, ok: true, ts: "2026-08-12T00:00:00Z" });
    expect(costs.forSession("s1").length).toBe(1);
    h.close();
  });

  it("备份先行：存在待应用迁移的旧库 → 备份后再迁移，备份保留旧版本", () => {
    const path = dbPath();
    // 手工构建 v1 之前的旧库：pre-v1 自有表 + 数据、user_version=0、无 v1 表
    const legacy = new nodeSqlite.DatabaseSync(path);
    legacy.exec("CREATE TABLE legacy_meta (k TEXT NOT NULL)");
    legacy.prepare("INSERT INTO legacy_meta VALUES (?)").run("seed");
    legacy.close();

    const h = openStorage(path);
    expect(h.backupPath).not.toBeNull();
    expect(existsSync(h.backupPath!)).toBe(true);
    expect(readUserVersion(h.db)).toBe(STORAGE_SCHEMA_VERSION);

    // 备份内容 = 迁移前快照（user_version=0 + 旧表数据）
    const bak = new nodeSqlite.DatabaseSync(h.backupPath!);
    expect(readUserVersion(bak)).toBe(0);
    const seed = bak.prepare("SELECT k FROM legacy_meta").get() as { k: string };
    expect(seed.k).toBe("seed");
    bak.close();
    h.close();

    // 备份文件命名形如 meta.db.bak-<ts>
    const baks = readdirSync(dir).filter((f) => f.startsWith("meta.db.bak-"));
    expect(baks.length).toBe(1);
  });

  it("fail-closed：user_version 落后但 v1 表已存在（版本标记损坏）→ 报错不静默重建", () => {
    const path = dbPath();
    const seed = openStorage(path);
    seed.close();
    const tampered = new nodeSqlite.DatabaseSync(path);
    tampered.exec("PRAGMA user_version = 0");
    tampered.close();
    expect(() => openStorage(path)).toThrow(/已回滚/);
  });

  it("fail-closed：库版本超前（user_version 超过当前支持）→ 打开报错", () => {
    const path = dbPath();
    const future = new nodeSqlite.DatabaseSync(path);
    future.exec(`PRAGMA user_version = ${STORAGE_SCHEMA_VERSION + 5}`);
    future.close();
    expect(() => openStorage(path)).toThrow(/fail-closed/);
  });
});

describe("Repository：图像 / 费用", () => {
  it("image_version：ImageMeta 全量落库/读取，父链字段保留", () => {
    const h = openStorage(dbPath());
    const images = new ImageMetaRepository(h.db);
    const meta: ImageMeta = {
      prompt: "现代风格客厅表现图",
      model: "gpt-image-2",
      provider: "openai",
      parentVersionId: "v1",
      width: 1024,
      height: 768,
      costUsd: 0.04,
      status: "succeeded",
    };
    images.upsert({ imageId: "img1", sessionId: "s1", parentVersionId: "v1", meta });

    const got = images.get("img1");
    expect(got?.meta.prompt).toBe("现代风格客厅表现图");
    expect(got?.meta.model).toBe("gpt-image-2");
    expect(got?.parentVersionId).toBe("v1");
    expect(got?.createdAt).toBeTruthy();

    expect(images.listBySession("s1").length).toBe(1);
    expect(images.listBySession("s2").length).toBe(0);
    h.close();
  });

  it("cost_summary：requestId 幂等记账（重试不重复计费，ADR-006）", () => {
    const h = openStorage(dbPath());
    const costs = new CostRepository(h.db);
    const rec = {
      sessionId: "s1",
      requestId: "req-1",
      requestKind: "chat",
      model: "mock-model",
      provider: "mock",
      promptTokens: 100,
      completionTokens: 50,
      totalTokens: 150,
      costUsd: 0.01,
      latencyMs: 30,
      ok: true,
      ts: "2026-08-12T00:00:00Z",
    };
    expect(costs.record(rec)).toEqual({ inserted: true });
    // 同 requestId 重试入账 → 忽略
    expect(costs.record({ ...rec, costUsd: 0.99 })).toEqual({ inserted: false });

    expect(costs.totalCostUsd("s1")).toBeCloseTo(0.01);
    expect(costs.totalCostUsd()).toBeCloseTo(0.01);
    expect(costs.forSession("s1").length).toBe(1);
    h.close();
  });

  it("session：touch 自举 + 元数据回写/读取", () => {
    const h = openStorage(dbPath());
    const sessions = new SessionRepository(h.db);
    sessions.touch("s1");
    expect(sessions.get("s1")?.id).toBe("s1");

    sessions.upsertMeta("s1", { summary: "[摘要] 两室一厅迭代", hardConstraints: ["总尺寸 10m x 8m", "主卧朝南"] });
    const got = sessions.get("s1");
    expect(got?.summary).toBe("[摘要] 两室一厅迭代");
    expect(got?.hardConstraints).toEqual(["总尺寸 10m x 8m", "主卧朝南"]);
    h.close();
  });

  it("持久化往返：close → 重开 → 全部数据可读（jsonl 之外的 meta.db 快照）", () => {
    const path = dbPath();
    const h = openStorage(path);
    new ImageMetaRepository(h.db).upsert({ imageId: "img1", sessionId: "s1", meta: { prompt: "p", model: "m", provider: "mock" } });
    new CostRepository(h.db).record({
      sessionId: "s1", requestId: "req-1", requestKind: "chat", model: "m", provider: "mock",
      promptTokens: 1, completionTokens: 1, totalTokens: 2, costUsd: 0.02, latencyMs: 5, ok: true,
      ts: "2026-08-12T00:00:00Z",
    });
    h.close();

    const h2 = openStorage(path);
    expect(new CostRepository(h2.db).forSession("s1").length).toBe(1);
    expect(new ImageMetaRepository(h2.db).listBySession("s1").length).toBe(1);
    expect(new CostRepository(h2.db).totalCostUsd("s1")).toBeCloseTo(0.02);
    h2.close();
  });
});
