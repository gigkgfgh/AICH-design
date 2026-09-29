/**
 * mockPlanStructures：离线可用的 PlanStructure 样例（M1 无网全链路 + 渲染/校验测试基准）。
 *
 * 样例设计意图（对应 P005 验收「mockPlanStructures 2~3 样例」）：
 * 1. 两室一厅小户型（完整字段：面积/朝向/相邻/门窗开口）
 * 2. 单间工作室（最小字段集：缺 areaM2 与 openings，验证降级推算路径）
 * 3. 三室两厅示范户型（多房间 + 多开口 + 相邻关系，验证渲染图层与标注）
 */

import type { PlanStructure } from "@aichdesign/shared";

/** 样例 1：两室一厅小户型（完整字段）。 */
export const mockPlanSmallApartment: PlanStructure = {
  schemaVersion: 1,
  bounds: { widthM: 10, heightM: 8 },
  rooms: [
    { id: "r1", name: "客厅", type: "living", x: 4, y: 4, w: 5, h: 3.6, orientation: "S", areaM2: 18, adjacentTo: ["r2", "r3"] },
    { id: "r2", name: "主卧", type: "bedroom", x: 0, y: 4, w: 3.6, h: 3.6, orientation: "S", areaM2: 12.96, adjacentTo: ["r1"] },
    { id: "r3", name: "厨房", type: "kitchen", x: 4, y: 0, w: 3.4, h: 3.4, orientation: "N", areaM2: 11.56, adjacentTo: ["r1"] },
    { id: "r4", name: "卫生间", type: "bath", x: 0, y: 0, w: 3.4, h: 3.4, orientation: "N", areaM2: 11.56 },
  ],
  walls: [
    { id: "w1", x1: 0, y1: 4, x2: 4, y2: 4, thicknessMm: 200, hasDoor: true },
    { id: "w2", x1: 4, y1: 4, x2: 9, y2: 4, thicknessMm: 200, hasDoor: true },
    { id: "w3", x1: 4, y1: 0, x2: 4, y2: 4, thicknessMm: 120 },
    { id: "w4", x1: 0, y1: 0, x2: 0, y2: 4, thicknessMm: 200 },
    { id: "w5", x1: 0, y1: 0, x2: 4, y2: 0, thicknessMm: 200 },
    { id: "w6", x1: 4, y1: 0, x2: 9, y2: 0, thicknessMm: 200 },
    { id: "w7", x1: 9, y1: 0, x2: 9, y2: 7.6, thicknessMm: 200, hasWindow: true },
    { id: "w8", x1: 0, y1: 7.6, x2: 4, y2: 7.6, thicknessMm: 200 },
    { id: "w9", x1: 4, y1: 7.6, x2: 9, y2: 7.6, thicknessMm: 200, hasWindow: true },
  ],
  openings: [
    { kind: "door", wallId: "w1", offsetM: 1.2, widthM: 0.9 },
    { kind: "door", wallId: "w2", offsetM: 2, widthM: 0.9 },
    { kind: "window", wallId: "w7", offsetM: 1.5, widthM: 1.8 },
  ],
};

/** 样例 2：单间工作室（最小字段集：缺 areaM2 / openings，验证降级推算 areaM2 = w*h）。 */
export const mockPlanStudio: PlanStructure = {
  schemaVersion: 1,
  bounds: { widthM: 6, heightM: 5 },
  rooms: [{ id: "r1", name: "工作室", type: "study", x: 0.3, y: 0.3, w: 5, h: 4, orientation: "E" }],
  walls: [
    { id: "w1", x1: 0, y1: 0, x2: 6, y2: 0 },
    { id: "w2", x1: 6, y1: 0, x2: 6, y2: 5 },
    { id: "w3", x1: 6, y1: 5, x2: 0, y2: 5 },
    { id: "w4", x1: 0, y1: 5, x2: 0, y2: 0 },
  ],
};

/** 样例 3：三室两厅示范户型（多房间 + 多开口 + 相邻关系）。 */
export const mockPlanFamilyHouse: PlanStructure = {
  schemaVersion: 1,
  bounds: { widthM: 12, heightM: 10 },
  rooms: [
    { id: "r1", name: "客厅", type: "living", x: 6, y: 5, w: 5.6, h: 4.6, orientation: "SE", areaM2: 25.76, adjacentTo: ["r2", "r4", "r5"] },
    { id: "r2", name: "主卧", type: "bedroom", x: 0, y: 5.2, w: 5.2, h: 4.4, orientation: "SW", areaM2: 22.88, adjacentTo: ["r1"] },
    { id: "r3", name: "次卧", type: "bedroom", x: 0, y: 0, w: 5.2, h: 4.4, orientation: "NW", areaM2: 22.88 },
    { id: "r4", name: "厨房", type: "kitchen", x: 6, y: 0, w: 5.6, h: 4.4, orientation: "NE", areaM2: 24.64, adjacentTo: ["r1"] },
    { id: "r5", name: "餐厅", type: "other", x: 0, y: 0, w: 0, h: 0, orientation: "N" },
  ],
  walls: [
    { id: "w1", x1: 5.2, y1: 0, x2: 5.2, y2: 5.2, thicknessMm: 200, hasDoor: true },
    { id: "w2", x1: 6, y1: 5.2, x2: 11.6, y2: 5.2, thicknessMm: 200, hasDoor: true },
    { id: "w3", x1: 0, y1: 5.2, x2: 5.2, y2: 5.2, thicknessMm: 200, hasDoor: true },
    { id: "w4", x1: 0, y1: 0, x2: 0, y2: 9.6, thicknessMm: 200 },
    { id: "w5", x1: 0, y1: 0, x2: 11.6, y2: 0, thicknessMm: 200, hasWindow: true },
    { id: "w6", x1: 11.6, y1: 0, x2: 11.6, y2: 9.6, thicknessMm: 200, hasWindow: true },
    { id: "w7", x1: 0, y1: 9.6, x2: 11.6, y2: 9.6, thicknessMm: 200 },
  ],
  openings: [
    { kind: "door", wallId: "w2", offsetM: 2.4, widthM: 1.2 },
    { kind: "window", wallId: "w5", offsetM: 3, widthM: 2.4 },
  ],
};

/** 合规样例数组（渲染/校验测试按索引取用）。 */
export const mockPlanStructures: readonly PlanStructure[] = [
  mockPlanSmallApartment,
  mockPlanStudio,
  mockPlanFamilyHouse,
];