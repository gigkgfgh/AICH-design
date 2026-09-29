/**
 * plan_patch：对 PlanStructure 应用增量补丁（P0-3：校验回环 ≤2 + 降级输出）。
 *
 * 流程：
 * 1. 应用补丁（宽松接受未知 op——未知 op 记为错误）；
 * 2. validatePlan → invalid 时进入自主修正回环（≤2 轮）：
 *    - 缺失 areaM2 → 按 w*h 推算；
 *    - 缺失 thicknessMm → 200；
 *    - adjacentTo 悬垂引用 → 移除；
 *    - openings.wallId 悬垂 → 移除该开口；
 * 3. 回环耗尽仍有错误 → degraded=true 降级交付（保留已修复结果，不放弃），
 *    结果中携带剩余 errors 供上层展示/请求 LLM 再次修正。
 */

import type { PlanStructure } from "@aichdesign/shared";
import { validatePlan } from "./validate.js";

export const PATCH_LOOP_LIMIT = 2;

export type PlanPatchOp =
  | { op: "resize"; roomId: string; factor: number }
  | { op: "move"; roomId: string; dx: number; dy: number }
  | { op: "set"; roomId: string; field: string; value: unknown }
  | { op: "add_room"; room: unknown }
  | { op: "remove_room"; roomId: string }
  | (Record<string, unknown> & { op?: unknown });

export interface PlanPatchResult {
  plan: PlanStructure | null;
  valid: boolean;
  errors: string[];
  warnings: string[];
  /** 修正回环执行轮数（0 = 无需修正；>0 = 自动修正生效）。 */
  loops: number;
  /** 回环超限仍失败：降级交付（保留尽力修复结果）。 */
  degraded: boolean;
}

function clone<T>(value: T): T {
  return JSON.parse(JSON.stringify(value)) as T;
}

/** 主入口：plan（unknown）与 patch（unknown）→ 结果。 */
export function applyPlanPatch(planInput: unknown, patchInput: unknown): PlanPatchResult {
  if (typeof planInput !== "object" || planInput === null) {
    return { plan: null, valid: false, errors: ["plan 必须为对象"], warnings: [], loops: 0, degraded: true };
  }
  if (!Array.isArray(patchInput)) {
    return {
      plan: clone(planInput as PlanStructure),
      valid: false,
      errors: ["patch 必须为数组"],
      warnings: [],
      loops: 0,
      degraded: true,
    };
  }

  let plan = clone(planInput as PlanStructure);
  const errors: string[] = [];

  // 应用补丁（尽力而为：逐条执行，失败的记录错误继续）。
  for (const entry of patchInput) {
    assertApplyEntry(plan, entry, errors);
  }

  // 校验前标准化 pre-pass：可自动修复项（面积/厚度/悬垂引用）无条件补齐——
  // 缺失字段样例（如 mockPlanStudio 无 areaM2）无需进入回环即交付可推算结果。
  const pre = autoRepair(plan, []);
  plan = pre.plan;
  let loops = pre.fixed > 0 ? 1 : 0;

  // 校验 → 修正回环（≤2）。
  let current = validatePlan(plan);
  while (!current.valid && loops < PATCH_LOOP_LIMIT) {
    const repaired = autoRepair(plan, current.errors);
    current = validatePlan(repaired.plan);
    plan = repaired.plan;
    loops += 1;
  }

  return {
    plan,
    valid: current.valid,
    errors: [...errors, ...current.errors],
    warnings: current.warnings,
    loops,
    degraded: !current.valid,
  };
}

function assertApplyEntry(plan: PlanStructure, entry: unknown, errors: string[]): void {
  if (typeof entry !== "object" || entry === null) {
    errors.push("patch 条目必须为对象");
    return;
  }
  const op = entry as Record<string, unknown>;
  switch (op.op) {
    case "resize": {
      const room = findRoom(plan, op.roomId);
      if (!room) {
        errors.push(`resize.roomId 不存在：${String(op.roomId)}`);
        return;
      }
      const factor = Number(op.factor);
      if (!Number.isFinite(factor) || factor <= 0) {
        errors.push(`resize.factor 必须为正数`);
        return;
      }
      room.w = Math.round(room.w * factor * 1000) / 1000;
      room.h = Math.round(room.h * factor * 1000) / 1000;
      room.areaM2 = Math.round(room.w * room.h * 100) / 100;
      return;
    }
    case "move": {
      const room = findRoom(plan, op.roomId);
      if (!room) {
        errors.push(`move.roomId 不存在：${String(op.roomId)}`);
        return;
      }
      const dx = Number(op.dx);
      const dy = Number(op.dy);
      if (!Number.isFinite(dx) || !Number.isFinite(dy)) {
        errors.push(`move.dx/dy 必须为数字`);
        return;
      }
      room.x = Math.round((room.x + dx) * 1000) / 1000;
      room.y = Math.round((room.y + dy) * 1000) / 1000;
      return;
    }
    case "set": {
      const room = findRoom(plan, op.roomId);
      if (!room) {
        errors.push(`set.roomId 不存在：${String(op.roomId)}`);
        return;
      }
      const field = op.field;
      if (typeof field !== "string") {
        errors.push(`set.field 必须为字符串`);
        return;
      }
      (room as unknown as Record<string, unknown>)[field] = op.value;
      return;
    }
    case "add_room": {
      const room = op.room as Record<string, unknown> | undefined;
      if (typeof room !== "object" || room === null) {
        errors.push(`add_room.room 必须为对象`);
        return;
      }
      plan.rooms.push(room as unknown as PlanStructure["rooms"][number]);
      return;
    }
    case "remove_room": {
      const idx = plan.rooms.findIndex((r) => r.id === op.roomId);
      if (idx < 0) {
        errors.push(`remove_room.roomId 不存在：${String(op.roomId)}`);
        return;
      }
      plan.rooms.splice(idx, 1);
      return;
    }
    default:
      errors.push(`未知 patch op：${String((op as { op?: unknown }).op)}`);
  }
}

function findRoom(plan: PlanStructure, roomId: unknown): PlanStructure["rooms"][number] | null {
  return plan.rooms.find((r) => r.id === roomId) ?? null;
}

/** 自主修正（回环内单轮）：处理可自动修复项，返回修复后的 plan。 */
function autoRepair(plan: PlanStructure, errors: string[]): { plan: PlanStructure; fixed: number } {
  let fixed = 0;
  for (const room of plan.rooms) {
    if (room.areaM2 === undefined || !Number.isFinite(room.areaM2)) {
      room.areaM2 = Math.round(room.w * room.h * 100) / 100;
      fixed += 1;
    }
  }
  for (const wall of plan.walls) {
    if (wall.thicknessMm === undefined || wall.thicknessMm <= 0) {
      wall.thicknessMm = 200;
      fixed += 1;
    }
  }
  // adjacentTo 悬垂引用移除。
  const roomIds = new Set(plan.rooms.map((r) => r.id));
  for (const room of plan.rooms) {
    if (room.adjacentTo) {
      const before = room.adjacentTo.length;
      room.adjacentTo = room.adjacentTo.filter((ref) => ref === room.id || roomIds.has(ref));
      if (room.adjacentTo.length !== before) fixed += 1;
    }
  }
  // openings.wallId 悬垂移除。
  const wallIds = new Set(plan.walls.map((w) => w.id));
  if (plan.openings) {
    const before = plan.openings.length;
    plan.openings = plan.openings.filter((o) => wallIds.has(o.wallId));
    if (plan.openings.length !== before) fixed += 1;
  }
  // 结构错误（如缺失字段）不属于可自动修复项：回环主要用于上述降级推算。
  void errors;
  return { plan, fixed };
}