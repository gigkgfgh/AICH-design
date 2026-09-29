/**
 * Repository 层（P017）：版本树 / 费用 / 图像元数据 / 会话元信息。
 *
 * - plan_version 读取时经 shared/migratePlanStructure 前向迁移（ADR-005），
 *   schema_version 列为写入时快照（快查/审计用）；
 * - cost_summary 以 (session_id, request_id) 为主键：同 requestId 重试
 *   ON CONFLICT DO NOTHING，存储层保证 ADR-006「重试不重复计费」；
 * - 写入 plan_version / image_version 前自举 session 行（INSERT OR IGNORE），
 *   满足外键约束，调用方无需保证写入顺序。
 */

import type { DatabaseSync } from "node:sqlite";
import type { ImageMeta, PlanStructure } from "@aichdesign/shared";
import { migratePlanStructure } from "@aichdesign/shared";

function nowIso(): string {
  return new Date().toISOString();
}

/** 会话行（P019 摘要/硬约束元数据可回写；主进程接线后由 ContextManager 使用）。 */
export interface SessionRecord {
  id: string;
  createdAt: string;
  updatedAt: string;
  summary: string | null;
  hardConstraints: string[] | null;
}

export class SessionRepository {
  constructor(private readonly db: DatabaseSync) {}

  /** 自举会话行（存在则仅刷新 updated_at）。 */
  touch(sessionId: string): void {
    const now = nowIso();
    this.db
      .prepare(
        "INSERT INTO session (id, created_at, updated_at) VALUES (?, ?, ?) " +
          "ON CONFLICT(id) DO UPDATE SET updated_at = excluded.updated_at",
      )
      .run(sessionId, now, now);
  }

  /** 回写会话元数据（summary / hardConstraints 传 null 即清除）。 */
  upsertMeta(sessionId: string, meta: { summary: string | null; hardConstraints: string[] | null }): void {
    this.touch(sessionId);
    this.db
      .prepare(
        "UPDATE session SET summary = ?, hard_constraints = ?, updated_at = ? WHERE id = ?",
      )
      .run(meta.summary, JSON.stringify(meta.hardConstraints), nowIso(), sessionId);
  }

  get(sessionId: string): SessionRecord | null {
    const row = this.db
      .prepare("SELECT id, created_at, updated_at, summary, hard_constraints FROM session WHERE id = ?")
      .get(sessionId) as Record<string, unknown> | undefined;
    if (!row) return null;
    const hc = row["hard_constraints"];
    return {
      id: String(row["id"]),
      createdAt: String(row["created_at"]),
      updatedAt: String(row["updated_at"]),
      summary: (row["summary"] as string | null) ?? null,
      hardConstraints: hc == null ? null : (JSON.parse(String(hc)) as string[]),
    };
  }
}

/** 方案版本（版本树节点）。 */
export interface PlanVersionRecord {
  versionId: string;
  sessionId: string;
  parentVersionId: string | null;
  structure: PlanStructure;
  svg: string | null;
  schemaVersion: number;
  createdAt: string;
}

export interface PlanVersionUpsert {
  versionId: string;
  sessionId: string;
  parentVersionId?: string | null;
  structure: PlanStructure;
  svg?: string | null;
  createdAt?: string;
}

export class PlanVersionRepository {
  constructor(private readonly db: DatabaseSync) {}

  /** 写入/覆盖一个版本节点（同 versionId 幂等覆盖——重试落库不产生重复节点）。 */
  upsert(rec: PlanVersionUpsert): PlanVersionRecord {
    const createdAt = rec.createdAt ?? nowIso();
    const schemaVersion = rec.structure.schemaVersion ?? 1;
    new SessionRepository(this.db).touch(rec.sessionId);
    this.db
      .prepare(
        "INSERT INTO plan_version (id, session_id, parent_version_id, structure, svg, schema_version, created_at) " +
          "VALUES (?, ?, ?, ?, ?, ?, ?) " +
          "ON CONFLICT(id) DO UPDATE SET parent_version_id = excluded.parent_version_id, " +
          "structure = excluded.structure, svg = excluded.svg, schema_version = excluded.schema_version",
      )
      .run(
        rec.versionId,
        rec.sessionId,
        rec.parentVersionId ?? null,
        JSON.stringify(rec.structure),
        rec.svg ?? null,
        schemaVersion,
        createdAt,
      );
    return this.get(rec.versionId)!;
  }

  /** 读取单个版本（structure 前向迁移到当前 PlanStructure 版本）。 */
  get(versionId: string): PlanVersionRecord | null {
    const row = this.db
      .prepare(
        "SELECT id, session_id, parent_version_id, structure, svg, schema_version, created_at " +
          "FROM plan_version WHERE id = ?",
      )
      .get(versionId) as Record<string, unknown> | undefined;
    return row ? planRowToRecord(row) : null;
  }

  /** 会话版本树（created_at 升序，同刻按写入序；版本树可查）。 */
  listBySession(sessionId: string): PlanVersionRecord[] {
    const rows = this.db
      .prepare(
        "SELECT id, session_id, parent_version_id, structure, svg, schema_version, created_at " +
          "FROM plan_version WHERE session_id = ? ORDER BY created_at ASC, rowid ASC",
      )
      .all(sessionId) as Array<Record<string, unknown>>;
    return rows.map(planRowToRecord);
  }
}

function planRowToRecord(row: Record<string, unknown>): PlanVersionRecord {
  const raw = JSON.parse(String(row["structure"])) as PlanStructure;
  // migratePlanStructure 对已是当前版本的输入原样返回（不回填缺省号），此处统一补齐。
  const structure = { ...migratePlanStructure(raw), schemaVersion: raw.schemaVersion ?? 1 };
  return {
    versionId: String(row["id"]),
    sessionId: String(row["session_id"]),
    parentVersionId: (row["parent_version_id"] as string | null) ?? null,
    structure: migratePlanStructure(structure),
    svg: (row["svg"] as string | null) ?? null,
    schemaVersion: Number(row["schema_version"]),
    createdAt: String(row["created_at"]),
  };
}

/** 图像版本（ImageMeta 全量 JSON 落库，保留索引演进空间 ADR-005.4）。 */
export interface ImageVersionRecord {
  imageId: string;
  sessionId: string;
  parentVersionId: string | null;
  parentImageId: string | null;
  meta: ImageMeta;
  createdAt: string;
}

export class ImageMetaRepository {
  constructor(private readonly db: DatabaseSync) {}

  /** 写入/覆盖图像元数据（同 imageId 幂等覆盖）。createdAt 缺省取 meta.createdAt。 */
  upsert(rec: {
    imageId: string;
    sessionId: string;
    parentVersionId?: string | null;
    parentImageId?: string | null;
    meta: ImageMeta;
  }): ImageVersionRecord {
    const createdAt = rec.meta.createdAt ?? nowIso();
    const meta = { ...rec.meta, createdAt };
    new SessionRepository(this.db).touch(rec.sessionId);
    this.db
      .prepare(
        "INSERT INTO image_version (id, session_id, parent_version_id, parent_image_id, meta, created_at) " +
          "VALUES (?, ?, ?, ?, ?, ?) " +
          "ON CONFLICT(id) DO UPDATE SET parent_version_id = excluded.parent_version_id, " +
          "parent_image_id = excluded.parent_image_id, meta = excluded.meta",
      )
      .run(
        rec.imageId,
        rec.sessionId,
        rec.parentVersionId ?? null,
        rec.parentImageId ?? null,
        JSON.stringify(meta),
        createdAt,
      );
    return this.get(rec.imageId)!;
  }

  get(imageId: string): ImageVersionRecord | null {
    const row = this.db
      .prepare(
        "SELECT id, session_id, parent_version_id, parent_image_id, meta, created_at " +
          "FROM image_version WHERE id = ?",
      )
      .get(imageId) as Record<string, unknown> | undefined;
    return row ? imageRowToRecord(row) : null;
  }

  /** 会话图像版本树（created_at 升序，同刻按写入序）。 */
  listBySession(sessionId: string): ImageVersionRecord[] {
    const rows = this.db
      .prepare(
        "SELECT id, session_id, parent_version_id, parent_image_id, meta, created_at " +
          "FROM image_version WHERE session_id = ? ORDER BY created_at ASC, rowid ASC",
      )
      .all(sessionId) as Array<Record<string, unknown>>;
    return rows.map(imageRowToRecord);
  }
}

function imageRowToRecord(row: Record<string, unknown>): ImageVersionRecord {
  return {
    imageId: String(row["id"]),
    sessionId: String(row["session_id"]),
    parentVersionId: (row["parent_version_id"] as string | null) ?? null,
    parentImageId: (row["parent_image_id"] as string | null) ?? null,
    meta: JSON.parse(String(row["meta"])) as ImageMeta,
    createdAt: String(row["created_at"]),
  };
}

/** 费用记录（与 agent-service UsageTracker 的 UsageRecord 形状对齐）。 */
export interface CostRecord {
  sessionId: string;
  requestId: string;
  requestKind: string;
  model: string;
  provider: string;
  promptTokens: number;
  completionTokens: number;
  totalTokens: number;
  costUsd: number;
  latencyMs: number;
  ok: boolean;
  code?: string;
  ts: string;
}

export class CostRepository {
  constructor(private readonly db: DatabaseSync) {}

  /**
   * 记账（幂等）：(session_id, request_id) 冲突时忽略。
   * 返回 inserted=false 表示该 requestId 已入账（重试不重复计费，ADR-006）。
   */
  record(rec: CostRecord): { inserted: boolean } {
    const result = this.db
      .prepare(
        "INSERT INTO cost_summary (" +
          "session_id, request_id, request_kind, model, provider, prompt_tokens, completion_tokens, " +
          "total_tokens, cost_usd, latency_ms, ok, code, ts) " +
          "VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?) " +
          "ON CONFLICT(session_id, request_id) DO NOTHING",
      )
      .run(
        rec.sessionId,
        rec.requestId,
        rec.requestKind,
        rec.model,
        rec.provider,
        rec.promptTokens,
        rec.completionTokens,
        rec.totalTokens,
        rec.costUsd,
        rec.latencyMs,
        rec.ok ? 1 : 0,
        rec.code ?? null,
        rec.ts,
      );
    return { inserted: Number(result.changes) === 1 };
  }

  /** 会话费用明细（ts 升序）。 */
  forSession(sessionId: string): CostRecord[] {
    const rows = this.db
      .prepare("SELECT * FROM cost_summary WHERE session_id = ? ORDER BY ts ASC, rowid ASC")
      .all(sessionId) as Array<Record<string, unknown>>;
    return rows.map(costRowToRecord);
  }


  /** 累计成本（美元）；sessionId 缺省统计全部（图像成本护栏 P018 读取点）。 */
  totalCostUsd(sessionId?: string): number {
    const row = sessionId
      ? (this.db
          .prepare("SELECT SUM(cost_usd) AS total FROM cost_summary WHERE session_id = ?")
          .get(sessionId) as Record<string, unknown> | undefined)
      : (this.db
          .prepare("SELECT SUM(cost_usd) AS total FROM cost_summary")
          .get() as Record<string, unknown> | undefined);
    const total = row?.["total"];
    return total == null ? 0 : Number(total);
  }
}

function costRowToRecord(row: Record<string, unknown>): CostRecord {
  return {
    sessionId: String(row["session_id"]),
    requestId: String(row["request_id"]),
    requestKind: String(row["request_kind"]),
    model: String(row["model"]),
    provider: String(row["provider"]),
    promptTokens: Number(row["prompt_tokens"]),
    completionTokens: Number(row["completion_tokens"]),
    totalTokens: Number(row["total_tokens"]),
    costUsd: Number(row["cost_usd"]),
    latencyMs: Number(row["latency_ms"]),
    ok: Number(row["ok"]) === 1,
    code: (row["code"] as string | null) ?? undefined,
    ts: String(row["ts"]),
  };
}

/** R6-9：删除会话级联（方案/图像/费用 + session 行；返回删除条数）。 */
export function deleteSessionCascade(db: DatabaseSync, sessionId: string): number {
  const r1 = db.prepare("DELETE FROM plan_version WHERE session_id = ?").run(sessionId);
  const r2 = db.prepare("DELETE FROM image_version WHERE session_id = ?").run(sessionId);
  const r3 = db.prepare("DELETE FROM cost_summary WHERE session_id = ?").run(sessionId);
  const r4 = db.prepare("DELETE FROM session WHERE id = ?").run(sessionId);
  return Number(r1.changes) + Number(r2.changes) + Number(r3.changes) + Number(r4.changes);
}
