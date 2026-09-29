/**
 * validate_plan：PlanStructure 校验（结构 + 枚举 + 范围 + 引用完整性）。
 *
 * 校验级别：
 * - 错误（errors）：违反冻结 schema 的结构问题 / 枚举非法 / 引用悬垂 —— 阻断渲染；
 * - 警告（warnings）：几何越界（房间/墙超出 bounds）、面积与 w*h 不符等 —— 不阻断。
 * 与 planschema.json 一一对应；plan_patch 基于本结果做 ≤2 轮修正回环。
 *
 * P011 严格档（2026-08-12，R2）：
 * - validatePlan(input) 保持 R1 宽容行为（缺省字段 / 缺省 schemaVersion 宽容量化）；
 * - validatePlanStrict(input) / validatePlan(input, { strict: true }) 一切缺省、越界、
 *   悬垂引用均报错：schemaVersion 缺省、rooms[].areaM2 缺省、walls[].thicknessMm 缺省、
 *   几何越界（从警告提升为错误）均拒绝；悬垂引用宽容档已是错误、严格档保持。
 * 用法见 packages/extensions/README.md（宽容 vs 严格对照表）。
 */

import type { Orientation, RoomType } from "@aichdesign/shared";
import { PLAN_SCHEMA_VERSION } from "@aichdesign/shared";

export interface PlanValidationResult {
  valid: boolean;
  errors: string[];
  warnings: string[];
}

/** 校验选项（P011）。strict=false 为 R1 宽容行为（默认）。 */
export interface ValidateOptions {
  /** 严格档：一切缺省 / 越界 / 悬垂引用报错。 */
  strict?: boolean;
}

const ROOM_TYPES: readonly RoomType[] = ["bedroom", "living", "kitchen", "bath", "study", "balcony", "corridor", "other"];
const ORIENTATIONS: readonly Orientation[] = ["N", "S", "E", "W", "NE", "NW", "SE", "SW"];

function isNumber(v: unknown): v is number {
  return typeof v === "number" && Number.isFinite(v);
}

/** 主入口：宽松输入（unknown）→ 校验结果。strict=true 走 P011 严格档。 */
export function validatePlan(input: unknown, opts?: ValidateOptions): PlanValidationResult {
  const strict = opts?.strict === true;
  const errors: string[] = [];
  const warnings: string[] = [];

  if (typeof input !== "object" || input === null || Array.isArray(input)) {
    return { valid: false, errors: ["plan 必须为对象"], warnings: [] };
  }
  const plan = input as Record<string, unknown>;

  // schemaVersion（ADR-005）：宽容缺省视为 1；P011 严格档要求显式声明。
  // 非法类型或 > 当前版本 → 错误（两档一致）。
  const sv = plan.schemaVersion;
  if (sv === undefined) {
    if (strict) {
      errors.push("schemaVersion 缺失（严格档：必须显式声明顶层版本号，ADR-005）");
    }
  } else if (typeof sv !== "number" || !Number.isInteger(sv) || sv < 1) {
    errors.push(`schemaVersion 必须为正整数，收到：${String(sv)}`);
  } else if (sv > PLAN_SCHEMA_VERSION) {
    errors.push(`schemaVersion ${sv} 高于当前支持版本 ${PLAN_SCHEMA_VERSION}（不支持降级）`);
  }

  // bounds。
  const bounds = plan.bounds as Record<string, unknown> | undefined;
  if (typeof bounds !== "object" || bounds === null) {
    errors.push("bounds 缺失或非对象");
  } else {
    for (const key of ["widthM", "heightM"] as const) {
      if (!isNumber(bounds[key]) || bounds[key] < 0) {
        errors.push(`bounds.${key} 必须为非负数`);
      }
    }
  }

  // rooms。
  const rooms = plan.rooms;
  const roomIds = new Set<string>();
  if (!Array.isArray(rooms)) {
    errors.push("rooms 必须为数组");
  } else {
    rooms.forEach((room, i) => {
      const prefix = `rooms[${i}]`;
      if (typeof room !== "object" || room === null) {
        errors.push(`${prefix} 必须为对象`);
        return;
      }
      const r = room as Record<string, unknown>;
      if (typeof r.id !== "string" || r.id.length === 0) {
        errors.push(`${prefix}.id 必须为非空字符串`);
      } else if (roomIds.has(r.id)) {
        errors.push(`${prefix}.id 重复：${r.id}`);
      } else {
        roomIds.add(r.id);
      }
      if (typeof r.name !== "string") errors.push(`${prefix}.name 必须为字符串`);
      if (!ROOM_TYPES.includes(r.type as RoomType)) {
        errors.push(`${prefix}.type 非法：${String(r.type)}（允许 ${ROOM_TYPES.join("/")}）`);
      }
      for (const key of ["x", "y", "w", "h"] as const) {
        if (!isNumber(r[key])) errors.push(`${prefix}.${key} 必须为数字`);
      }
      if (isNumber(r.w) && r.w < 0) errors.push(`${prefix}.w 必须 ≥ 0`);
      if (isNumber(r.h) && r.h < 0) errors.push(`${prefix}.h 必须 ≥ 0`);
      if (!ORIENTATIONS.includes(r.orientation as Orientation)) {
        errors.push(`${prefix}.orientation 非法：${String(r.orientation)}`);
      }
      // areaM2：宽容缺省（渲染按 w*h 推算）；P011 严格档要求显式提供。
      if (r.areaM2 === undefined && strict) {
        errors.push(`${prefix}.areaM2 缺失（严格档：必须显式提供，禁依赖推算）`);
      }
      if (r.areaM2 !== undefined && (!isNumber(r.areaM2) || r.areaM2 < 0)) {
        errors.push(`${prefix}.areaM2 必须为 ≥ 0 的数字`);
      }
      if (r.adjacentTo !== undefined) {
        if (!Array.isArray(r.adjacentTo) || !r.adjacentTo.every((x) => typeof x === "string")) {
          errors.push(`${prefix}.adjacentTo 必须为字符串数组`);
        }
      }
      // 几何越界：宽容为警告（不阻断渲染）；P011 严格档提升为错误。
      if (isNumber(r.x) && isNumber(r.y) && isNumber(r.w) && isNumber(r.h) && isNumber(bounds?.widthM) && isNumber(bounds?.heightM)) {
        if (r.x + r.w > bounds.widthM + 1e-6 || r.y + r.h > bounds.heightM + 1e-6) {
          const msg = `${prefix}（${r.id ?? "?"}）超出 bounds 边界`;
          if (strict) {
            errors.push(`${msg}（严格档：越界为错误）`);
          } else {
            warnings.push(msg);
          }
        }
      }
    });
  }

  // walls。
  const walls = plan.walls;
  const wallIds = new Set<string>();
  if (!Array.isArray(walls)) {
    errors.push("walls 必须为数组");
  } else {
    walls.forEach((wall, i) => {
      const prefix = `walls[${i}]`;
      if (typeof wall !== "object" || wall === null) {
        errors.push(`${prefix} 必须为对象`);
        return;
      }
      const w = wall as Record<string, unknown>;
      if (typeof w.id !== "string" || w.id.length === 0) {
        errors.push(`${prefix}.id 必须为非空字符串`);
      } else if (wallIds.has(w.id)) {
        errors.push(`${prefix}.id 重复：${w.id}`);
      } else {
        wallIds.add(w.id);
      }
      for (const key of ["x1", "y1", "x2", "y2"] as const) {
        if (!isNumber(w[key])) errors.push(`${prefix}.${key} 必须为数字`);
      }
      // thicknessMm：宽容缺省默认 200（渲染/补丁路径）；P011 严格档要求显式提供。
      if (w.thicknessMm === undefined && strict) {
        errors.push(`${prefix}.thicknessMm 缺失（严格档：必须显式提供，禁依赖默认值）`);
      }
      if (w.thicknessMm !== undefined && (!isNumber(w.thicknessMm) || w.thicknessMm <= 0)) {
        errors.push(`${prefix}.thicknessMm 必须为正数（毫米）`);
      }
      for (const key of ["hasDoor", "hasWindow"] as const) {
        if (w[key] !== undefined && typeof w[key] !== "boolean") errors.push(`${prefix}.${key} 必须为布尔`);
      }
    });
  }

  // openings（引用完整性）。
  const openings = plan.openings;
  if (openings !== undefined) {
    if (!Array.isArray(openings)) {
      errors.push("openings 必须为数组");
    } else {
      openings.forEach((opening, i) => {
        const prefix = `openings[${i}]`;
        if (typeof opening !== "object" || opening === null) {
          errors.push(`${prefix} 必须为对象`);
          return;
        }
        const o = opening as Record<string, unknown>;
        if (o.kind !== "door" && o.kind !== "window") {
          errors.push(`${prefix}.kind 必须为 door|window`);
        }
        if (typeof o.wallId !== "string") {
          errors.push(`${prefix}.wallId 必须为字符串`);
        } else if (!wallIds.has(o.wallId)) {
          errors.push(`${prefix}.wallId 引用了不存在的墙：${o.wallId}`);
        }
        if (o.offsetM !== undefined && (!isNumber(o.offsetM) || o.offsetM < 0)) {
          errors.push(`${prefix}.offsetM 必须为 ≥ 0 的数字`);
        }
        if (o.widthM !== undefined && (!isNumber(o.widthM) || o.widthM <= 0)) {
          errors.push(`${prefix}.widthM 必须为正数`);
        }
      });
    }
  }

  // adjacentTo 引用完整性（rooms 解码完后做）。
  if (Array.isArray(rooms)) {
    rooms.forEach((room, i) => {
      const r = room as Record<string, unknown>;
      if (Array.isArray(r.adjacentTo)) {
        for (const ref of r.adjacentTo) {
          if (typeof ref === "string" && ref !== r.id && !roomIds.has(ref)) {
            errors.push(`rooms[${i}].adjacentTo 引用了不存在的房间：${ref}`);
          }
        }
      }
    });
  }

  return { valid: errors.length === 0, errors, warnings };
}

/** 便捷：仅返回是否有效（工具文本提示用）。 */
export function isPlanValid(input: unknown): boolean {
  return validatePlan(input).valid;
}

/**
 * P011 严格档便捷导出：等价 validatePlan(input, { strict: true })。
 * 用法：agent-service 在 AICH_STRICT_JSON=1（默认）时经 validate_plan 工具走本档；
 * 宽容档 validatePlan(input) 保留 R1 行为（补丁回环 / 降级输出路径仍用宽容档）。
 */
export function validatePlanStrict(input: unknown): PlanValidationResult {
  return validatePlan(input, { strict: true });
}