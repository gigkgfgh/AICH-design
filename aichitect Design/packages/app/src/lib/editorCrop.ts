/**
 * 裁切几何纯函数（TASK-20261004：标准裁切交互——全图初始选区 + 把手向内收缩 + 比例锁定）。
 * 所有坐标均为画布自然像素（显示缩放换算由组件层 toCanvasPoint 负责）；无 DOM 依赖，可 node 单测。
 */

export type CropHandle = 'nw' | 'n' | 'ne' | 'e' | 'se' | 's' | 'sw' | 'w' | 'move';

export interface CropRect {
  x: number;
  y: number;
  w: number;
  h: number;
}

/** 选区最小边长（防拖没） */
export const MIN_CROP = 16;

/** 进入裁切：初始选区 = 全图（用户从全图向内拖把手收缩） */
export function fullCrop(canvasW: number, canvasH: number): CropRect {
  return { x: 0, y: 0, w: canvasW, h: canvasH };
}

/** 裁切比例（'free' = 自由；其余 "w:h" → w/h） */
export type CropRatio = 'free' | '1:1' | '4:3' | '3:4' | '16:9' | '9:16';

export function parseCropRatio(r: CropRatio): number | null {
  if (r === 'free') return null;
  const [w, h] = r.split(':').map(Number);
  return w! / h!;
}

const clamp = (v: number, lo: number, hi: number): number => Math.min(hi, Math.max(lo, v));

/**
 * 拖动把手 / 整体移动选区。
 * - move：平移，钳制在画布内；
 * - 角把手（nw/ne/se/sw）：对角锚点固定；等比时主导轴驱动（宽按比例换算高更大 → 宽驱动）；
 * - 边把手（n/s/e/w）：非等比仅动该边；等比时沿边驱动、对侧轴按比例联动且中垂线保持；
 * - 越界：先钳可用空间（等比回推另一轴），最后保证 ≥ MIN_CROP。
 */
export function resizeCrop(
  handle: CropHandle,
  start: CropRect,
  dx: number,
  dy: number,
  ratio: number | null,
  canvasW: number,
  canvasH: number,
): CropRect {
  if (handle === 'move') {
    return {
      x: clamp(start.x + dx, 0, Math.max(0, canvasW - start.w)),
      y: clamp(start.y + dy, 0, Math.max(0, canvasH - start.h)),
      w: start.w,
      h: start.h,
    };
  }

  const isCorner = handle.length === 2;
  const anchorX = handle.includes('w') ? start.x + start.w : start.x;
  const anchorY = handle.includes('n') ? start.y + start.h : start.y;
  // 拖动方向上的可用空间（锚点 → 画布边）
  const availW = handle.includes('w') ? anchorX : canvasW - anchorX;
  const availH = handle.includes('n') ? anchorY : canvasH - anchorY;

  if (isCorner) {
    const wFree = handle.includes('e') ? start.w + dx : start.w - dx;
    const hFree = handle.includes('s') ? start.h + dy : start.h - dy;
    let w: number;
    let h: number;
    if (ratio !== null) {
      // 等比：主导轴驱动 → 一次性按可用空间比例系数回推（双向独立钳制会破坏比例）
      let w0: number;
      let h0: number;
      if (wFree / ratio >= hFree) {
        w0 = wFree;
        h0 = wFree / ratio;
      } else {
        h0 = hFree;
        w0 = hFree * ratio;
      }
      const k = Math.min(availW / w0, availH / h0, 1);
      w = Math.max(w0 * k, Math.min(MIN_CROP, availW));
      h = Math.max(h0 * k, Math.min(MIN_CROP, availH));
    } else {
      w = clamp(wFree, Math.min(MIN_CROP, availW), Math.max(MIN_CROP, availW));
      h = clamp(hFree, Math.min(MIN_CROP, availH), Math.max(MIN_CROP, availH));
    }
    return {
      x: handle.includes('w') ? anchorX - w : anchorX,
      y: handle.includes('n') ? anchorY - h : anchorY,
      w,
      h,
    };
  }

  // 边把手
  if (handle === 'e' || handle === 'w') {
    let w = handle.includes('e') ? start.w + dx : start.w - dx;
    w = clamp(w, Math.min(MIN_CROP, availW), Math.max(MIN_CROP, availW));
    if (ratio === null) {
      return { x: handle.includes('w') ? anchorX - w : anchorX, y: start.y, w, h: start.h };
    }
    let h = w / ratio;
    if (h > canvasH) {
      h = canvasH;
      w = h * ratio;
    }
    const y = clamp(start.y + start.h / 2 - h / 2, 0, canvasH - h);
    return { x: handle.includes('w') ? anchorX - w : anchorX, y, w, h };
  }

  // n / s
  let h = handle.includes('s') ? start.h + dy : start.h - dy;
  h = clamp(h, Math.min(MIN_CROP, availH), Math.max(MIN_CROP, availH));
  if (ratio === null) {
    return { x: start.x, y: handle.includes('n') ? anchorY - h : anchorY, w: start.w, h };
  }
  let w = h * ratio;
  if (w > canvasW) {
    w = canvasW;
    h = w / ratio;
  }
  const x = clamp(start.x + start.w / 2 - w / 2, 0, canvasW - w);
  return { x, y: handle.includes('n') ? anchorY - h : anchorY, w, h };
}

/** 切换比例档位：保持选区中心，取当前选区内最大等比矩形（再钳制进画布） */
export function refitRatio(rect: CropRect, ratio: number, canvasW: number, canvasH: number): CropRect {
  let w = Math.min(rect.w, rect.h * ratio);
  let h = w / ratio;
  const cx = rect.x + rect.w / 2;
  const cy = rect.y + rect.h / 2;
  let x = cx - w / 2;
  let y = cy - h / 2;
  if (x < 0) {
    w += x * ratio;
    h = w / ratio;
    x = 0;
  }
  if (y < 0) {
    h += y / ratio;
    w = h * ratio;
    y = 0;
  }
  if (x + w > canvasW) {
    w = canvasW - x;
    h = w / ratio;
  }
  if (y + h > canvasH) {
    h = canvasH - y;
    w = h * ratio;
  }
  return { x: clamp(Math.round(x), 0, canvasW), y: clamp(Math.round(y), 0, canvasH), w: Math.round(w), h: Math.round(h) };
}
