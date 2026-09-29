/**
 * SQLite 侧迁移体系（P017，设计文档 §9.2 表草案 + ADR-005 数据演进）。
 *
 * 语义：
 * - `PRAGMA user_version` 为版本唯一真源，migrations 表为应用审计（簿记自举，幂等）；
 * - 仅前向、幂等：user_version 已达 STORAGE_SCHEMA_VERSION 则跳过全部步骤；
 * - 连续性 fail-closed：缺步（注册表不连续）、库版本超前、迁移执行失败均抛错，
 *   绝不静默建表或降级（打开失败由调用方上报）；
 * - PlanStructure JSON 内部版本演进归 @aichdesign/shared/migrations（读取侧前向迁移，
 *   见 repositories.PlanVersionRepository）。
 */

import type { DatabaseSync } from "node:sqlite";

/** 迁移脚本：应用成功后 PRAGMA user_version = id。 */
export interface StorageMigration {
  id: number;
  name: string;
  up: (db: DatabaseSync) => void;
}

/** 当前存储 schema 版本（新增迁移时同步递增）。 */
export const STORAGE_SCHEMA_VERSION = 1;

/** v1：初始表（§9.2 草案落地；字段与 shared 契约 PlanStructure/ImageMeta 对齐）。 */
const migrationV1: StorageMigration = {
  id: 1,
  name: "initial-tables",
  up: (db) => {
    db.exec(`
      CREATE TABLE session (
        id TEXT PRIMARY KEY,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        summary TEXT,
        hard_constraints TEXT
      );

      CREATE TABLE plan_version (
        id TEXT PRIMARY KEY,
        session_id TEXT NOT NULL REFERENCES session(id),
        parent_version_id TEXT,
        structure TEXT NOT NULL,
        svg TEXT,
        schema_version INTEGER NOT NULL,
        created_at TEXT NOT NULL
      );
      CREATE INDEX idx_plan_version_session ON plan_version(session_id, created_at);

      CREATE TABLE image_version (
        id TEXT PRIMARY KEY,
        session_id TEXT NOT NULL REFERENCES session(id),
        parent_version_id TEXT,
        parent_image_id TEXT,
        meta TEXT NOT NULL,
        created_at TEXT NOT NULL
      );
      CREATE INDEX idx_image_version_session ON image_version(session_id, created_at);

      CREATE TABLE cost_summary (
        session_id TEXT NOT NULL,
        request_id TEXT NOT NULL,
        request_kind TEXT NOT NULL,
        model TEXT NOT NULL,
        provider TEXT NOT NULL,
        prompt_tokens INTEGER NOT NULL,
        completion_tokens INTEGER NOT NULL,
        total_tokens INTEGER NOT NULL,
        cost_usd REAL NOT NULL,
        latency_ms INTEGER NOT NULL,
        ok INTEGER NOT NULL,
        code TEXT,
        ts TEXT NOT NULL,
        PRIMARY KEY (session_id, request_id)
      );
    `);
  },
};

/** 迁移注册表（升序；id 必须从 1 起连续）。 */
export const STORAGE_MIGRATIONS: readonly StorageMigration[] = [migrationV1];

/** migrateDatabase 结果：from = 打开时版本，to = 迁移后版本，applied = 本次应用的步骤 id。 */
export interface MigrateResult {
  from: number;
  to: number;
  applied: number[];
}

/** 读取 PRAGMA user_version（缺失/异常按 0 处理）。 */
export function readUserVersion(db: DatabaseSync): number {
  const row = db.prepare("PRAGMA user_version").get() as { user_version?: number } | undefined;
  return row?.user_version ?? 0;
}

/** 是否存在待应用迁移（备份时机判断用）。 */
export function hasPendingMigrations(currentVersion: number): boolean {
  return currentVersion < STORAGE_SCHEMA_VERSION;
}

/**
 * 幂等迁移（fail-closed）：按注册表顺序应用 pending 步骤，每步一个事务
 * （DDL 在 SQLite 中事务性，失败回滚后抛错）。
 */
export function migrateDatabase(db: DatabaseSync): MigrateResult {
  db.exec(
    "CREATE TABLE IF NOT EXISTS migrations (" +
      "id INTEGER PRIMARY KEY, name TEXT NOT NULL, applied_at TEXT NOT NULL)",
  );

  const from = readUserVersion(db);
  if (from > STORAGE_SCHEMA_VERSION) {
    throw new Error(
      `meta.db 版本 user_version=${from} 高于当前支持版本 ${STORAGE_SCHEMA_VERSION}（不支持降级，需更新客户端），fail-closed 拒绝打开`,
    );
  }
  if (from === STORAGE_SCHEMA_VERSION) {
    return { from, to: from, applied: [] };
  }

  const pending = STORAGE_MIGRATIONS.filter((m) => m.id > from).sort((a, b) => a.id - b.id);
  let expect = from + 1;
  for (const m of pending) {
    if (m.id !== expect) {
      throw new Error(
        `迁移注册表不连续：缺 v${expect} 步骤（库当前 v${from}），fail-closed 拒绝静默建表`,
      );
    }
    expect += 1;
  }

  for (const m of pending) {
    db.exec("BEGIN");
    try {
      m.up(db);
      db.prepare("INSERT INTO migrations (id, name, applied_at) VALUES (?, ?, ?)").run(
        m.id,
        m.name,
        new Date().toISOString(),
      );
      db.exec(`PRAGMA user_version = ${m.id}`);
      db.exec("COMMIT");
    } catch (err) {
      db.exec("ROLLBACK");
      throw new Error(
        `迁移 v${m.id}（${m.name}）执行失败已回滚：${err instanceof Error ? err.message : String(err)}`,
      );
    }
  }

  return { from, to: readUserVersion(db), applied: pending.map((m) => m.id) };
}
