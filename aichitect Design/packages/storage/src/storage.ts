/**
 * 打开 meta.db（P017）：备份先行 → PRAGMA 配置 → 幂等迁移。
 *
 * 顺序（R3 计划 §4 P017）：
 * 1. 库文件已存在且有待应用迁移 → 先备份（copy 到 `<db>.bak-<ts>`）再动库；
 * 2. 打开后配置 WAL / foreign_keys / busy_timeout；
 * 3. 先迁移后使用（migrateDatabase 幂等、fail-closed）。
 * 单写者约定：主进程持有写连接（修订②），本包不做并发控制。
 */

import type { DatabaseSync } from "node:sqlite";
import { copyFileSync, existsSync } from "node:fs";
import { nodeSqlite } from "./sqlite.js";
import { hasPendingMigrations, migrateDatabase, readUserVersion } from "./migrations.js";
import type { MigrateResult } from "./migrations.js";

/** 已打开的 meta.db 句柄（单连接；close 后不可再用）。 */
export interface StorageHandle {
  readonly db: DatabaseSync;
  readonly migrations: MigrateResult;
  /** 本次 open 是否执行了迁移前备份（及备份路径）。 */
  readonly backupPath: string | null;
  close(): void;
}

/** 备份文件名时间戳（Windows 文件名安全：去除冒号与点）。 */
function backupTimestamp(): string {
  return new Date().toISOString().replace(/[:.]/g, "-");
}

function configurePragmas(db: DatabaseSync): void {
  db.exec("PRAGMA journal_mode = WAL");
  db.exec("PRAGMA synchronous = NORMAL");
  db.exec("PRAGMA foreign_keys = ON");
  db.exec("PRAGMA busy_timeout = 5000");
}

/**
 * 打开（必要时创建）meta.db 并迁移到最新 schema。
 * 迁移缺失/损坏/版本超前 → 抛错（fail-closed，不静默建新表）。
 */
export function openStorage(dbPath: string): StorageHandle {
  const isFile = dbPath !== ":memory:";
  const existed = isFile && existsSync(dbPath);

  // 备份先行：仅当库文件已存在且存在待应用迁移（避免每次 open 都复制）。
  let backupPath: string | null = null;
  if (existed) {
    const probe = new nodeSqlite.DatabaseSync(dbPath);
    let pending = false;
    try {
      pending = hasPendingMigrations(readUserVersion(probe));
    } finally {
      probe.close();
    }
    if (pending) {
      backupPath = `${dbPath}.bak-${backupTimestamp()}`;
      copyFileSync(dbPath, backupPath);
    }
  }

  const db = new nodeSqlite.DatabaseSync(dbPath);
  let migrations: MigrateResult;
  try {
    configurePragmas(db);
    migrations = migrateDatabase(db);
  } catch (err) {
    db.close();
    throw err;
  }
  return { db, migrations, backupPath, close: () => db.close() };
}
