/**
 * plan-tools 用例（P008 验收：三个工具单测通过；修正回环 ≤2 护栏生效）。
 * 数据基准：@aichdesign/mock-provider 的 mockPlanStructures（合规样例 1-3）。
 */

import { describe, expect, it } from "vitest";
import {
  mockPlanFamilyHouse,
  mockPlanSmallApartment,
  mockPlanStructures,
  mockPlanStudio,
} from "@aichdesign/mock-provider";
import { applyPlanPatch, PATCH_LOOP_LIMIT } from "../src/plan-tools/patch";
import { PlanRenderError, renderSvgPlan, RENDER_SCALE } from "../src/plan-tools/render";
import { isPlanValid, validatePlan, validatePlanStrict } from "../src/plan-tools/validate";

/* ---------------- validate_plan ---------------- */

describe("validate_plan", () => {
  it("合规样例全部通过（2~3 个 mockPlanStructures）", () => {
    for (const plan of mockPlanStructures) {
      const result = validatePlan(plan);
      expect(result.valid, JSON.stringify(result.errors)).toBe(true);
    }
  });

  it("缺 schemaVersion 视为合规（缺省 = 1，ADR-005）", () => {
    const { schemaVersion: _sv, ...noVersion } = mockPlanStudio;
    expect(isPlanValid(noVersion)).toBe(true);
  });

  it("schemaVersion 超前（2 > 当前 1）报错（不支持降级）", () => {
    const result = validatePlan({ ...mockPlanStudio, schemaVersion: 2 });
    expect(result.valid).toBe(false);
    expect(result.errors.some((e) => e.includes("不支持降级"))).toBe(true);
  });

  it("rooms.type 枚举非法 → 错误", () => {
    const bad = structuredClone(mockPlanStudio);
    (bad.rooms[0] as { type: string }).type = "garage";
    const result = validatePlan(bad);
    expect(result.valid).toBe(false);
    expect(result.errors.some((e) => e.includes("type 非法"))).toBe(true);
  });

  it("rooms.orientation 枚举非法 → 错误", () => {
    const bad = structuredClone(mockPlanStudio);
    (bad.rooms[0] as { orientation: string }).orientation = "UP";
    const result = validatePlan(bad);
    expect(result.valid).toBe(false);
  });

  it("房间引用完整性：adjacentTo 悬垂 → 错误", () => {
    const bad = structuredClone(mockPlanSmallApartment);
    bad.rooms = bad.rooms.map((r) => ({ ...r, adjacentTo: [...(r.adjacentTo ?? []), "ghost-room"] }));
    const result = validatePlan(bad);
    expect(result.valid).toBe(false);
    expect(result.errors.some((e) => e.includes("adjacentTo 引用了不存在的房间"))).toBe(true);
  });

  it("开口引用完整性：openings.wallId 悬垂 → 错误", () => {
    const bad = structuredClone(mockPlanSmallApartment);
    bad.openings = [{ kind: "door", wallId: "no-such-wall" }];
    const result = validatePlan(bad);
    expect(result.valid).toBe(false);
    expect(result.errors.some((e) => e.includes("wallId 引用了不存在的墙"))).toBe(true);
  });

  it("几何越界记为警告而非错误（宽松渲染）", () => {
    const bad = structuredClone(mockPlanSmallApartment);
    bad.rooms[0] = { ...bad.rooms[0], x: 9, w: 5 }; // 9 + 5 > widthM 10
    const result = validatePlan(bad);
    expect(result.valid).toBe(true);
    expect(result.warnings.some((w) => w.includes("超出 bounds"))).toBe(true);
  });

  it("非对象输入直接失败", () => {
    expect(validatePlan(null).valid).toBe(false);
    expect(validatePlan("plan").valid).toBe(false);
    expect(validatePlan([{ id: "r1" }]).valid).toBe(false);
  });
});

/* ---------------- validate_plan 严格档（P011，R2） ---------------- */

describe("validate_plan（严格档 P011）", () => {
  it("宽容用例反转为拒绝：缺省 schemaVersion（宽容通过，严格拒绝）", () => {
    const { schemaVersion: _sv, ...noVersion } = mockPlanStudio;
    expect(isPlanValid(noVersion)).toBe(true); // 宽容：缺省视为 1（ADR-005）
    const result = validatePlanStrict(noVersion);
    expect(result.valid).toBe(false);
    expect(result.errors.some((e) => e.includes("schemaVersion 缺失"))).toBe(true);
  });

  it("严格档拒绝缺省 rooms.areaM2（mockPlanStudio 本就缺 areaM2，宽容通过）", () => {
    expect(isPlanValid(mockPlanStudio)).toBe(true); // 宽容：渲染按 w*h 推算
    const result = validatePlanStrict(mockPlanStudio);
    expect(result.valid).toBe(false);
    expect(result.errors.some((e) => e.includes("areaM2 缺失"))).toBe(true);
  });

  it("严格档拒绝缺省 walls.thicknessMm（宽容默认 200）", () => {
    const result = validatePlanStrict(mockPlanStudio); // studio walls 均无 thicknessMm
    expect(result.valid).toBe(false);
    expect(result.errors.some((e) => e.includes("thicknessMm 缺失"))).toBe(true);
  });

  it("严格档将几何越界从警告提升为错误（宽容仅 warning）", () => {
    const bad = structuredClone(mockPlanSmallApartment);
    bad.rooms[0] = { ...bad.rooms[0], x: 9, w: 5 }; // 9 + 5 > widthM 10
    const lenient = validatePlan(bad);
    expect(lenient.valid).toBe(true);
    expect(lenient.warnings.some((w) => w.includes("超出 bounds"))).toBe(true);
    const strictResult = validatePlanStrict(bad);
    expect(strictResult.valid).toBe(false);
    expect(strictResult.errors.some((e) => e.includes("越界为错误"))).toBe(true);
  });

  it("严格档悬垂引用报错（宽容同为错误，行为保持）", () => {
    const bad = structuredClone(mockPlanSmallApartment);
    bad.rooms = bad.rooms.map((r) => ({ ...r, adjacentTo: [...(r.adjacentTo ?? []), "ghost-room"] }));
    const result = validatePlanStrict(bad);
    expect(result.valid).toBe(false);
    expect(result.errors.some((e) => e.includes("adjacentTo 引用了不存在的房间"))).toBe(true);
  });

  it("validatePlan(input, { strict: true }) 与 validatePlanStrict 等价", () => {
    const a = validatePlan(mockPlanStudio, { strict: true });
    const b = validatePlanStrict(mockPlanStudio);
    expect(a.valid).toBe(b.valid);
    expect(a.errors).toEqual(b.errors);
  });

  it("严格档下合规完整样例（含 schemaVersion/areaM2/thicknessMm）通过", () => {
    // mockPlanSmallApartment 完整字段含 areaM2/thicknessMm/schemaVersion，且无越界 → 严格通过。
    expect(validatePlanStrict(mockPlanSmallApartment).valid).toBe(true);
  });

  it("严格档拒绝任一房间缺 areaM2（familyHouse 餐厅 r5 缺 areaM2，宽容通过）", () => {
    expect(isPlanValid(mockPlanFamilyHouse)).toBe(true);
    const result = validatePlanStrict(mockPlanFamilyHouse);
    expect(result.valid).toBe(false);
    expect(result.errors.some((e) => e.includes("rooms[4].areaM2 缺失"))).toBe(true);
  });
});

/* ---------------- render_plan_svg ---------------- */

describe("render_plan_svg", () => {
  it("渲染合规样例：viewBox 尺寸 = bounds × 50px/m（§5.3 比例尺）", () => {
    const svg = renderSvgPlan(mockPlanSmallApartment);
    const widthM = mockPlanSmallApartment.bounds.widthM;
    const heightM = mockPlanSmallApartment.bounds.heightM;
    expect(svg).toContain(`<svg`);
    // viewBox 高宽至少覆盖 bounds 等比缩放（含标注边距 28px×2 + 14）。
    expect(svg).toContain(`viewBox="0 0 ${widthM * RENDER_SCALE + 56 + 14}`);
  });

  it("图层顺序：墙体 → 房间 → 开口 → 标注 → 指北针（SVG 文档序）", () => {
    const svg = renderSvgPlan(mockPlanFamilyHouse);
    const walls = svg.indexOf("<!-- layer: walls -->");
    const rooms = svg.indexOf("<!-- layer: rooms -->");
    const openings = svg.indexOf("<!-- layer: openings -->");
    const annotations = svg.indexOf("<!-- layer: annotations -->");
    const compass = svg.indexOf("<!-- layer: compass -->");
    expect([walls, rooms, openings, annotations, compass].every((i) => i >= 0)).toBe(true);
    expect(walls).toBeLessThan(rooms);
    expect(rooms).toBeLessThan(openings);
    expect(openings).toBeLessThan(annotations);
    expect(annotations).toBeLessThan(compass);
  });

  it("样式冻结：墙体 fill:#333、房间 fill:#eef、文字 font-family:sans-serif", () => {
    const svg = renderSvgPlan(mockPlanSmallApartment);
    expect(svg).toContain('stroke="#333"');
    expect(svg).toContain('fill="#eef"');
    expect(svg).toContain('font-family="sans-serif"');
    expect(svg).toContain('fill="#4a90d9"'); // 门窗开口（蓝）
  });

  it("房间名称与面积标注出现；noXML 注入（名称转义）", () => {
    const withName = structuredClone(mockPlanStudio);
    withName.rooms[0].name = '工作室"<script>';
    const svg = renderSvgPlan(withName);
    expect(svg).toContain("工作室&quot;&lt;script&gt;");
    expect(svg).not.toContain("<script>");
  });

  it("缺 areaM2 的房间自动推算（w*h）并渲染", () => {
    const svg = renderSvgPlan(mockPlanStudio);
    // 5 m × 4 m = 20 m²
    expect(svg).toContain("20 m²");
  });

  it("非法输入渲染前拦截：抛 PlanRenderError（校验 → 修正回环上游）", () => {
    const bad = structuredClone(mockPlanStudio);
    (bad.rooms[0] as { type: string }).type = "garage";
    expect(() => renderSvgPlan(bad)).toThrow(PlanRenderError);
  });
});

/* ---------------- plan_patch ---------------- */

describe("plan_patch", () => {
  it("resize 补丁生效：宽高按 factor 缩放且 areaM2 重算", () => {
    const result = applyPlanPatch(mockPlanSmallApartment, [
      { op: "resize", roomId: "r1", factor: 1.2 },
    ]);
    expect(result.valid).toBe(true);
    expect(result.plan!.rooms[0]!.w).toBeCloseTo(5 * 1.2, 3);
    expect(result.plan!.rooms[0]!.h).toBeCloseTo(3.6 * 1.2, 3);
    expect(result.loops).toBe(0);
    expect(result.degraded).toBe(false);
  });

  it("修正回环护栏 ≤2：缺 areaM2 样例一次修正后 valid，loops=1", () => {
    const missingArea = structuredClone(mockPlanStudio);
    // studio 本就缺 areaM2：补丁触发校验 → 自动推算（loops ≥ 1）。
    const result = applyPlanPatch(missingArea, [{ op: "move", roomId: "r1", dx: 0, dy: 0.2 }]);
    expect(result.valid).toBe(true);
    expect(result.loops).toBeLessThanOrEqual(PATCH_LOOP_LIMIT);
    expect(result.plan!.rooms[0]!.areaM2).toBeCloseTo(5 * 4, 1);
  });

  it("补丁悬垂引用自动移除（adjacentTo / openings.wallId）", () => {
    const bad = structuredClone(mockPlanSmallApartment);
    bad.rooms[0].adjacentTo = [...(bad.rooms[0].adjacentTo ?? []), "ghost"];
    bad.openings = [...(bad.openings ?? []), { kind: "door", wallId: "ghost-wall" }];
    const result = applyPlanPatch(bad, []);
    expect(result.valid).toBe(true);
    expect(result.plan!.rooms[0]!.adjacentTo).not.toContain("ghost");
    expect(result.plan!.openings!.every((o) => o.wallId !== "ghost-wall")).toBe(true);
    expect(result.loops).toBeLessThanOrEqual(PATCH_LOOP_LIMIT);
  });

  it("不可修复错误：回环耗尽降级输出 degraded=true 且 loops=上限", () => {
    const bad = structuredClone(mockPlanStudio);
    (bad.rooms[0] as { type: string }).type = "garage"; // 枚举错误不可自动修复
    const result = applyPlanPatch(bad, []);
    expect(result.valid).toBe(false);
    expect(result.degraded).toBe(true);
    expect(result.loops).toBe(PATCH_LOOP_LIMIT);
    expect(result.errors.some((e) => e.includes("type 非法"))).toBe(true);
    // 降级不放弃：尽力修复后仍交付 plan（供上层展示/再次要求 LLM 修正）。
    expect(result.plan).not.toBeNull();
  });

  it("未知 op 报错但继续处理后续条目", () => {
    const result = applyPlanPatch(mockPlanStudio, [
      { op: "unknown_op" },
      { op: "move", roomId: "r1", dx: 1, dy: 0 },
    ]);
    expect(result.plan!.rooms[0]!.x).toBeCloseTo(0.3 + 1, 3);
    expect(result.errors.some((e) => e.includes("未知 patch op"))).toBe(true);
  });
});