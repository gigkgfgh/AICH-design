/**
 * 轻量编辑器纯函数测试：arrowHead（箭头头部）。
 * 裁切几何见 lib/editorCrop.test.ts；toCanvasPoint 依赖 DOM canvas 不在 node 测。
 */

import { describe, it, expect } from 'vitest';
import { arrowHead } from './ImageEditorModal';

const P = (x: number, y: number) => ({ x, y });

describe('arrowHead', () => {
  it('水平向右箭头：两端点在终点后方对称展开', () => {
    const [a, b] = arrowHead(P(0, 0), P(100, 0), 4);
    expect(a.x).toBeLessThan(100);
    expect(b.x).toBeLessThan(100);
    expect(a.y).toBeGreaterThan(0);
    expect(b.y).toBeLessThan(0);
    expect(a.x).toBeCloseTo(b.x);
  });
});
