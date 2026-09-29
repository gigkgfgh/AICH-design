/**
 * PlanStructure 迁移注册表（ADR-005.1）。
 *
 * 规则：
 * - 仅前向、幂等：探测当前 schemaVersion，按 vN → vN+1 顺序补齐缺失步骤一次；
 * - 不支持降级；迁移前调用方自行备份；
 * - 当前版本 = PLAN_SCHEMA_VERSION（1），注册表为空骨架，P017 起随演进填充。
 *
 * 关联存储：SQLite 侧迁移（PRAGMA user_version + migrations）归主进程（修订②），
 * 本文件只管 PlanStructure JSON 中间表示的版本演进。
 */

import type { PlanStructure } from "./contracts.js";

/** 当前冻结的 PlanStructure schema 版本（对应 planschema.json 的 schemaVersion 默认值）。 */
export const PLAN_SCHEMA_VERSION = 1;

/** vN → vN+1 前向变换器（幂等：探测当前版本，跳过已应用的步骤）。 */
export type PlanMigration = (plan: PlanStructure) => PlanStructure;

/** 迁移注册表：key = 源版本号（升序）。 */
export const PLAN_MIGRATIONS: ReadonlyMap<number, PlanMigration> = new Map<number, PlanMigration>([
  // 示例骨架（无内容）：1 → 2 时在此登记变换器并同步 PLAN_SCHEMA_VERSION。
]);

/** 将任意 PlanStructure 前向迁移到当前版本；缺省 schemaVersion 视为 1。 */
export function migratePlanStructure(input: PlanStructure): PlanStructure {
  let plan = input;
  let version = input.schemaVersion ?? 1;
  if (version === PLAN_SCHEMA_VERSION) return plan;
  if (version > PLAN_SCHEMA_VERSION) {
    throw new Error(
      `PlanStructure schemaVersion ${version} 高于当前支持版本 ${PLAN_SCHEMA_VERSION}（不支持降级，需更新客户端）`,
    );
  }
  while (version < PLAN_SCHEMA_VERSION) {
    const step = PLAN_MIGRATIONS.get(version);
    if (!step) {
      throw new Error(`缺少 PlanStructure 迁移步骤 v${version} → v${version + 1}，请检查迁移注册表`);
    }
    plan = step(plan);
    version += 1;
  }
  return { ...plan, schemaVersion: PLAN_SCHEMA_VERSION };
}