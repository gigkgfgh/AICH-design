/**
 * mock 样例 PlanStructure（P007/P010 mock 数据层）
 *
 * TODO-API-STUB: backend 的 packages/mock-provider 将导出 mockPlanStructures()，
 * 就绪后此处改为引用 shared 样例（或继续本地复制以解耦，由契约核对后定）。
 * 坐标自洽约定：墙中心线 = 房间矩形外沿 ± 半墙厚（默认 200mm）；单位均为米。
 */
import type { PlanStructure } from '../types/contracts';

/** 样例 A：三居（10m × 8m）—— 客厅/主卧/厨房/卫生间/书房 */
const SAMPLE_A: PlanStructure = {
  schemaVersion: 1,
  bounds: { widthM: 10, heightM: 8 },
  rooms: [
    { id: 'living', name: '客厅', type: 'living', x: 0.2, y: 0.2, w: 6.6, h: 4.5, orientation: 'S', areaM2: 29.7, adjacentTo: ['master', 'kitchen', 'bath'] },
    { id: 'master', name: '主卧', type: 'bedroom', x: 6.8, y: 0.2, w: 3.0, h: 4.5, orientation: 'N', areaM2: 13.5, adjacentTo: ['living'] },
    { id: 'bath', name: '卫生间', type: 'bath', x: 0.2, y: 4.7, w: 2.4, h: 3.0, orientation: 'S', areaM2: 7.2, adjacentTo: ['living', 'kitchen'] },
    { id: 'kitchen', name: '厨房', type: 'kitchen', x: 2.6, y: 4.7, w: 4.0, h: 3.0, orientation: 'S', areaM2: 12.0, adjacentTo: ['living', 'bath', 'study'] },
    { id: 'study', name: '书房', type: 'study', x: 6.8, y: 4.7, w: 3.0, h: 3.0, orientation: 'S', areaM2: 9.0, adjacentTo: ['kitchen', 'master'] },
  ],
  walls: [
    { id: 'w-top', x1: 0, y1: 0.1, x2: 10, y2: 0.1, thicknessMm: 200, hasWindow: true },
    { id: 'w-bottom', x1: 0, y1: 7.9, x2: 10, y2: 7.9, thicknessMm: 200, hasDoor: true, hasWindow: true },
    { id: 'w-left', x1: 0.1, y1: 0, x2: 0.1, y2: 8, thicknessMm: 200, hasWindow: true },
    { id: 'w-right', x1: 9.9, y1: 0, x2: 9.9, y2: 8, thicknessMm: 200, hasWindow: true },
    { id: 'w-v1', x1: 6.8, y1: 0.1, x2: 6.8, y2: 4.7, thicknessMm: 200, hasDoor: true },
    { id: 'w-h1', x1: 0.1, y1: 4.7, x2: 6.8, y2: 4.7, thicknessMm: 200, hasDoor: true },
    { id: 'w-v2', x1: 6.8, y1: 4.7, x2: 6.8, y2: 7.9, thicknessMm: 200, hasDoor: false },
  ],
  openings: [
    { kind: 'door', wallId: 'w-bottom', offsetM: 4.55, widthM: 0.9 }, // 入户门
    { kind: 'door', wallId: 'w-v1', offsetM: 1.5, widthM: 0.8 }, // 客厅→主卧
    { kind: 'door', wallId: 'w-h1', offsetM: 3.0, widthM: 0.8 }, // 客厅→厨房
    { kind: 'window', wallId: 'w-top', offsetM: 7.6, widthM: 1.2 }, // 主卧窗
    { kind: 'window', wallId: 'w-right', offsetM: 1.0, widthM: 1.2 }, // 主卧侧窗
    { kind: 'window', wallId: 'w-left', offsetM: 1.0, widthM: 1.4 }, // 客厅侧窗
    { kind: 'window', wallId: 'w-left', offsetM: 5.4, widthM: 0.9 }, // 卫生间侧窗
    { kind: 'window', wallId: 'w-bottom', offsetM: 7.2, widthM: 1.4 }, // 书房窗
    { kind: 'window', wallId: 'w-right', offsetM: 5.4, widthM: 1.2 }, // 书房侧窗
  ],
};

/** 样例 B：两居（7.5m × 6m）—— 客厅/卧室×2/厨房/卫生间 */
const SAMPLE_B: PlanStructure = {
  schemaVersion: 1,
  bounds: { widthM: 7.5, heightM: 6 },
  rooms: [
    { id: 'living', name: '客厅', type: 'living', x: 0.2, y: 0.2, w: 4.6, h: 4.2, orientation: 'S', areaM2: 19.3, adjacentTo: ['bed1', 'kitchen'] },
    { id: 'bed1', name: '卧室', type: 'bedroom', x: 4.8, y: 0.2, w: 2.5, h: 4.2, orientation: 'N', areaM2: 10.5, adjacentTo: ['living', 'bed2'] },
    { id: 'bath', name: '卫生间', type: 'bath', x: 0.2, y: 4.4, w: 2.2, h: 1.4, orientation: 'S', areaM2: 3.1, adjacentTo: ['living'] },
    { id: 'kitchen', name: '厨房', type: 'kitchen', x: 2.4, y: 4.4, w: 2.4, h: 1.4, orientation: 'S', areaM2: 3.4, adjacentTo: ['living', 'bed2'] },
    { id: 'bed2', name: '次卧', type: 'bedroom', x: 4.8, y: 4.4, w: 2.5, h: 1.4, orientation: 'S', areaM2: 3.5, adjacentTo: ['bed1', 'kitchen'] },
  ],
  walls: [
    { id: 'w-top', x1: 0, y1: 0.1, x2: 7.5, y2: 0.1, thicknessMm: 200, hasWindow: true },
    { id: 'w-bottom', x1: 0, y1: 5.9, x2: 7.5, y2: 5.9, thicknessMm: 200, hasDoor: true, hasWindow: true },
    { id: 'w-left', x1: 0.1, y1: 0, x2: 0.1, y2: 6, thicknessMm: 200, hasWindow: true },
    { id: 'w-right', x1: 7.4, y1: 0, x2: 7.4, y2: 6, thicknessMm: 200, hasWindow: true },
    { id: 'w-v1', x1: 4.8, y1: 0.1, x2: 4.8, y2: 4.4, thicknessMm: 200, hasDoor: true },
    { id: 'w-h1', x1: 0.1, y1: 4.4, x2: 4.8, y2: 4.4, thicknessMm: 200, hasDoor: true },
    { id: 'w-v2', x1: 4.8, y1: 4.4, x2: 4.8, y2: 5.9, thicknessMm: 200, hasDoor: true },
  ],
  openings: [
    { kind: 'door', wallId: 'w-bottom', offsetM: 3.0, widthM: 0.9 }, // 入户门
    { kind: 'door', wallId: 'w-v1', offsetM: 1.6, widthM: 0.8 }, // 客厅→卧室
    { kind: 'door', wallId: 'w-h1', offsetM: 2.0, widthM: 0.8 }, // 客厅→厨房
    { kind: 'door', wallId: 'w-v2', offsetM: 0.6, widthM: 0.8 }, // 次卧→厨房
    { kind: 'window', wallId: 'w-top', offsetM: 1.0, widthM: 1.4 }, // 客厅窗
    { kind: 'window', wallId: 'w-right', offsetM: 1.2, widthM: 1.2 }, // 卧室窗
    { kind: 'window', wallId: 'w-left', offsetM: 0.8, widthM: 1.2 }, // 客厅侧窗
    { kind: 'window', wallId: 'w-bottom', offsetM: 4.8, widthM: 1.4 }, // 次卧窗
    { kind: 'window', wallId: 'w-right', offsetM: 4.4, widthM: 1.0 }, // 次卧侧窗
  ],
};

/** 返回全部样例（供渲染器/演示使用） */
export function mockPlanStructures(): PlanStructure[] {
  return [SAMPLE_A, SAMPLE_B];
}

/**
 * 按需求文本选择种子样例（mock 规则：两室/小户/紧凑 → 样例 B，否则样例 A）。
 * TODO-API-STUB: 对齐 backend mock-provider 的选择策略；真实链路由 LLM 生成。
 */
export function pickSeedPlan(prompt: string): PlanStructure {
  const normalized = prompt.toLowerCase();
  if (/(两室|两居|一室|小户|紧凑|60平|六十平)/.test(normalized)) {
    return structuredClone(SAMPLE_B);
  }
  return structuredClone(SAMPLE_A);
}

/** 房间名 → 样例 rooms 中匹配的房间（主卧→bedroom，次卧→另一 bedroom，以此类推） */
export function findRoomByName(plan: PlanStructure, name: string): PlanStructure['rooms'][number] | undefined {
  const normalized = name.replace(/们|房|间/g, '');
  const room = plan.rooms.find((r) => r.name.includes(normalized));
  if (room) {
    return room;
  }
  // 主卧/次卧等别名映射到 bedroom 类型
  if (/主卧/.test(normalized)) {
    return plan.rooms.find((r) => r.type === 'bedroom' && r.id === 'master') ?? plan.rooms.find((r) => r.type === 'bedroom');
  }
  if (/次卧/.test(normalized)) {
    return plan.rooms.filter((r) => r.type === 'bedroom').slice(-1)[0];
  }
  return undefined;
}