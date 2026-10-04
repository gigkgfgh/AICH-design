/**
 * 裁切几何纯函数测试（TASK-20261004）。
 */

import { describe, it, expect } from 'vitest';
import { fullCrop, resizeCrop, refitRatio, parseCropRatio, MIN_CROP, type CropRect } from './editorCrop';

const R = (x: number, y: number, w: number, h: number): CropRect => ({ x, y, w, h });
const CW = 1000;
const CH = 800;

describe('fullCrop / parseCropRatio', () => {
  it('初始选区 = 全图；free → null，"4:3" → 4/3', () => {
    expect(fullCrop(CW, CH)).toEqual({ x: 0, y: 0, w: CW, h: CH });
    expect(parseCropRatio('free')).toBeNull();
    expect(parseCropRatio('4:3')).toBeCloseTo(4 / 3);
  });
});

describe('resizeCrop: move', () => {
  it('平移并钳制在画布内', () => {
    expect(resizeCrop('move', R(100, 100, 200, 100), 50, 30, null, CW, CH)).toEqual(R(150, 130, 200, 100));
    expect(resizeCrop('move', R(850, 700, 200, 100), 500, 500, null, CW, CH)).toEqual(R(800, 700, 200, 100));
  });
});

describe('resizeCrop: 角把手（自由）', () => {
  it('se 向内收：锚点 (x,y) 固定，w/h 随 delta', () => {
    expect(resizeCrop('se', R(100, 100, 400, 300), -100, -50, null, CW, CH)).toEqual(R(100, 100, 300, 250));
  });
  it('nw 向内收：锚点 (右下) 固定', () => {
    expect(resizeCrop('nw', R(100, 100, 400, 300), 80, 60, null, CW, CH)).toEqual(R(180, 160, 320, 240));
  });
  it('拖过头：钳制到 MIN_CROP', () => {
    const r = resizeCrop('se', R(100, 100, 400, 300), -500, -500, null, CW, CH);
    expect(r.w).toBe(MIN_CROP);
    expect(r.h).toBe(MIN_CROP);
  });
});

describe('resizeCrop: 角把手（等比）', () => {
  it('se 拖 1:1：宽主导 → 高=宽', () => {
    const r = resizeCrop('se', R(0, 0, 500, 500), 200, 40, 1, CW, CH);
    expect(r.w).toBe(700);
    expect(r.h).toBe(700);
    expect(r.x).toBe(0);
    expect(r.y).toBe(0);
  });
  it('nw 拖 4:3 且越画布上界：等比回推', () => {
    const r = resizeCrop('nw', R(500, 500, 400, 300), -200, -600, 4 / 3, CW, CH);
    expect(r.w / r.h).toBeCloseTo(4 / 3, 1);
    expect(r.y).toBeGreaterThanOrEqual(0);
    expect(r.x).toBeGreaterThanOrEqual(0);
    expect(r.x + r.w).toBeLessThanOrEqual(CW);
  });
});

describe('resizeCrop: 边把手（等比）', () => {
  it('e 拖 16:9：宽驱动、垂直中心保持', () => {
    const start = R(100, 200, 320, 180);
    const r = resizeCrop('e', start, 160, 999, 16 / 9, CW, CH);
    expect(r.w).toBe(480);
    expect(r.h).toBe(270);
    expect(r.y).toBe(200 + 90 - 135); // 中心保持
    expect(r.x).toBe(100);
  });
  it('s 拖 1:1：高驱动、水平中心保持', () => {
    const start = R(400, 100, 200, 200);
    const r = resizeCrop('s', start, 0, 150, 1, CW, CH);
    expect(r.h).toBe(350);
    expect(r.w).toBe(350);
    expect(r.x).toBe(400 + 100 - 175);
  });
});

describe('refitRatio', () => {
  it('中心保持切到目标比例', () => {
    const r = refitRatio(R(100, 100, 400, 300), 1, CW, CH);
    expect(r.w).toBe(300);
    expect(r.h).toBe(300);
    expect(r.x).toBe(150);
    expect(r.y).toBe(100);
  });
  it('横图切 9:16（竖比例）取高驱动', () => {
    const r = refitRatio(R(0, 0, 800, 400), 9 / 16, CW, CH);
    expect(r.w / r.h).toBeCloseTo(9 / 16, 1);
    expect(r.h).toBeLessThanOrEqual(400);
  });
  it('结果钳制在画布内', () => {
    const r = refitRatio(R(900, 700, 100, 100), 1, CW, CH);
    expect(r.x + r.w).toBeLessThanOrEqual(CW);
    expect(r.y + r.h).toBeLessThanOrEqual(CH);
  });
});
