/**
 * ImageEditorModal —— 图片手动编辑器（R7-2 自研轻量版；TASK-20261004 交互重做）：
 * 全屏无边框浮层（暗背景 + 大图居中 + 底部悬浮工具栏，视觉对齐放大预览）；
 * 双层 Canvas（base 底图层 + overlay 标注层）；工具：画笔 / 橡皮擦（恢复原图像素）/
 * 直线 / 箭头 / 方框 / 文字 / 取色器 / 裁切（全图初始选区 + 8 把手向内收缩 + 比例锁定），
 * 旋转 90°、水平翻转、撤销 / 重做 / 清除全部；颜色 + 粗细（映射字号）。
 * Esc 分层：文字输入中 → 取消文字；裁切中 → 退出裁切；其余 → 关闭编辑器。
 * 与「图生图」的区分：本编辑器为用户本地手动修改（产物为新图像版本，parentImageId 保留血缘）；
 * 图生图在对话中由 AI 按描述重新生成。onSave 产出 dataURL → registerImage → 入画布。
 */

import { useCallback, useEffect, useRef, useState, type ReactElement } from 'react';
import {
  fullCrop,
  parseCropRatio,
  refitRatio,
  resizeCrop,
  type CropHandle,
  type CropRatio,
  type CropRect,
} from '../lib/editorCrop';

export interface ImageEditorModalProps {
  /** 已解析的可显示 src（dataURL；file:// 需上层先经 resolveImageSrcs 转换） */
  src: string;
  /** 图像名（保存文件名用） */
  name: string;
  onClose: () => void;
  onSave: (dataUrl: string) => void;
}

type Tool = 'brush' | 'eraser' | 'line' | 'arrow' | 'rect' | 'text' | 'picker' | 'crop';

interface Pt {
  x: number;
  y: number;
}

/** 撤销快照：标注操作只存 overlay；像素变换（旋转/翻转/裁切）连 base 一起存 */
interface Snapshot {
  base?: ImageData;
  overlay: ImageData;
}

const MAX_UNDO = 30;
/** 超大图钳制（防 canvas 内存放大；与图像产物量级匹配） */
const MAX_DIM = 4096;
const DEFAULT_COLOR = '#ff3b30';
const CROP_RATIOS: CropRatio[] = ['free', '1:1', '4:3', '3:4', '16:9', '9:16'];
const CROP_HANDLES: CropHandle[] = ['nw', 'n', 'ne', 'e', 'se', 's', 'sw', 'w'];
const TOOL_TITLES: Record<Tool, string> = {
  brush: '画笔',
  eraser: '橡皮擦',
  line: '直线',
  arrow: '箭头',
  rect: '方框',
  text: '文字',
  picker: '取色器',
  crop: '裁切',
};

/** 工具图标（stroke 随按钮文字色；无 emoji） */
function ToolIcon({ d }: { d: string[] }): ReactElement {
  return (
    <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      {d.map((p, i) => (
        <path key={i} d={p} />
      ))}
    </svg>
  );
}

const ICONS: Record<string, string[]> = {
  brush: ['M9.06 11.9l8.07-8.06a2.85 2.85 0 1 1 4.03 4.03l-8.06 8.08', 'M7.07 14.94c-1.66 0-3 1.35-3 3.02 0 1.33-2.5 1.52-2 2.02 1.08 1.1 2.49 2.02 4 2.02 2.2 0 4-1.8 4-4.04a3.01 3.01 0 0 0-3-3.02z'],
  eraser: ['m7 21-4.3-4.3c-1-1-1-2.5 0-3.4l9.6-9.6c1-1 2.5-1 3.4 0l5.6 5.6c1 1 1 2.5 0 3.4L13 21', 'M22 21H7'],
  line: ['M5 19L19 5'],
  arrow: ['M5 19L19 5', 'M19 5h-6', 'M19 5v6'],
  rect: ['M4 5h16v14H4z'],
  text: ['M4 7V4h16v3', 'M9 20h6', 'M12 4v16'],
  picker: ['m2 22 1-1h3l9-9', 'M3 21v-3l9-9', 'm15 6 3.4-3.4a2.1 2.1 0 1 1 3 3L18 9l.4.4a2.1 2.1 0 1 1-3 3l-3.8-3.8a2.1 2.1 0 1 1 3-3l.4.4Z'],
  crop: ['M6 2v14a2 2 0 0 0 2 2h14', 'M2 6h14a2 2 0 0 1 2 2v14'],
  rotate: ['M21 12a9 9 0 1 1-2.64-6.36', 'M21 3v6h-6'],
  flip: ['M12 2v20', 'M8 7 3 12l5 5', 'M16 7l5 5-5 5'],
  undo: ['M1 4v6h6', 'M3.51 15a9 9 0 1 0 2.13-9.36L1 10'],
  redo: ['M23 4v6h-6', 'M20.49 15a9 9 0 1 1-2.12-9.36L23 10'],
  trash: ['M3 6h18', 'M19 6v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6', 'M8 6V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2'],
  close: ['M18 6 6 18', 'M6 6l12 12'],
};

const TOOL_HINTS: Partial<Record<Tool, string>> = {
  crop: '拖动边角把手向内收缩选区，可整体平移；Enter 或「应用」确认',
  picker: '点击画布位置取色，取色后自动切回画笔',
  eraser: '涂抹位置恢复为原图像素（只擦除标注）',
  text: '点击画布位置输入文字，Enter 确认 / Esc 取消',
};

/** pointer 事件坐标 → 画布内部像素坐标（显示缩放比换算） */
export function toCanvasPoint(e: { clientX: number; clientY: number }, canvas: HTMLCanvasElement): Pt {
  const rect = canvas.getBoundingClientRect();
  return {
    x: Math.round(((e.clientX - rect.left) * canvas.width) / rect.width),
    y: Math.round(((e.clientY - rect.top) * canvas.height) / rect.height),
  };
}

/** 箭头头部两端点（主线方向角 ±25°，长度 = max(12, 线宽×3)） */
export function arrowHead(from: Pt, to: Pt, lineWidth: number): [Pt, Pt] {
  const angle = Math.atan2(to.y - from.y, to.x - from.x);
  const len = Math.max(12, lineWidth * 3);
  const spread = Math.PI / 7;
  return [
    { x: to.x - len * Math.cos(angle - spread), y: to.y - len * Math.sin(angle - spread) },
    { x: to.x - len * Math.cos(angle + spread), y: to.y - len * Math.sin(angle + spread) },
  ];
}

export function ImageEditorModal(props: ImageEditorModalProps): ReactElement {
  const { src, name, onClose, onSave } = props;
  const baseRef = useRef<HTMLCanvasElement>(null);
  const overlayRef = useRef<HTMLCanvasElement>(null);
  const stageRef = useRef<HTMLDivElement>(null);
  const imgRef = useRef<HTMLImageElement | null>(null);
  const undoRef = useRef<Snapshot[]>([]);
  const redoRef = useRef<Snapshot[]>([]);
  const drawDragRef = useRef<{
    active: boolean;
    start: Pt;
    last: Pt;
    before?: ImageData;
  } | null>(null);
  const cropDragRef = useRef<{ handle: CropHandle; startRect: CropRect; startPt: Pt } | null>(null);
  const textInputRef = useRef<HTMLInputElement>(null);

  const [tool, setTool] = useState<Tool>('brush');
  const [color, setColor] = useState(DEFAULT_COLOR);
  const [size, setSize] = useState(4);
  const [cropRect, setCropRect] = useState<CropRect | null>(null);
  const [cropRatio, setCropRatio] = useState<CropRatio>('free');
  const [textEdit, setTextEdit] = useState<{ x: number; y: number; value: string } | null>(null);
  const [hint, setHint] = useState<string | null>(null);
  const [canUndo, setCanUndo] = useState(false);
  const [canRedo, setCanRedo] = useState(false);
  const [ready, setReady] = useState(false);
  const [imgSize, setImgSize] = useState<{ w: number; h: number } | null>(null);
  /** 画布自然 px → 屏幕 px 的显示缩放比（文字输入框字号换算用） */
  const [displayScale, setDisplayScale] = useState(1);

  const colorRef = useRef(color);
  colorRef.current = color;
  const sizeRef = useRef(size);
  sizeRef.current = size;
  const toolRef = useRef(tool);
  toolRef.current = tool;
  const cropRectRef = useRef(cropRect);
  cropRectRef.current = cropRect;
  const cropRatioRef = useRef(cropRatio);
  cropRatioRef.current = cropRatio;
  const prevToolRef = useRef<Tool>('brush');

  const showHint = useCallback((text: string) => {
    setHint(text);
    window.setTimeout(() => setHint((cur) => (cur === text ? null : cur)), 2600);
  }, []);

  /** 标注/变换完成后压栈（限制深度；同步刷新按钮态） */
  const pushSnapshot = useCallback((includeBase = false) => {
    const base = baseRef.current;
    const overlay = overlayRef.current;
    if (!base || !overlay) return;
    const snap: Snapshot = {
      overlay: overlay.getContext('2d')!.getImageData(0, 0, overlay.width, overlay.height),
      ...(includeBase ? { base: base.getContext('2d')!.getImageData(0, 0, base.width, base.height) } : {}),
    };
    undoRef.current.push(snap);
    if (undoRef.current.length > MAX_UNDO) undoRef.current.shift();
    redoRef.current = [];
    setCanUndo(true);
    setCanRedo(false);
  }, []);

  const undo = useCallback(() => {
    const snap = undoRef.current.pop();
    if (!snap) return;
    const base = baseRef.current;
    const overlay = overlayRef.current;
    if (!base || !overlay) return;
    const bctx = base.getContext('2d')!;
    const octx = overlay.getContext('2d')!;
    redoRef.current.push({
      overlay: octx.getImageData(0, 0, overlay.width, overlay.height),
      ...(snap.base ? { base: bctx.getImageData(0, 0, base.width, base.height) } : {}),
    });
    if (snap.base) bctx.putImageData(snap.base, 0, 0);
    octx.putImageData(snap.overlay, 0, 0);
    setCanUndo(undoRef.current.length > 0);
    setCanRedo(true);
  }, []);

  const redo = useCallback(() => {
    const snap = redoRef.current.pop();
    if (!snap) return;
    const base = baseRef.current;
    const overlay = overlayRef.current;
    if (!base || !overlay) return;
    const bctx = base.getContext('2d')!;
    const octx = overlay.getContext('2d')!;
    undoRef.current.push({
      overlay: octx.getImageData(0, 0, overlay.width, overlay.height),
      ...(snap.base ? { base: bctx.getImageData(0, 0, base.width, base.height) } : {}),
    });
    if (snap.base) bctx.putImageData(snap.base, 0, 0);
    octx.putImageData(snap.overlay, 0, 0);
    setCanUndo(true);
    setCanRedo(redoRef.current.length > 0);
  }, []);

  /** 像素变换通用：对 base 与 overlay 同时做几何变换（swap 尺寸用于 90° 旋转） */
  const transformPixels = useCallback(
    (fn: (src: HTMLCanvasElement) => HTMLCanvasElement) => {
      const base = baseRef.current;
      const overlay = overlayRef.current;
      if (!base || !overlay) return;
      pushSnapshot(true);
      const nb = fn(base);
      const no = fn(overlay);
      const bctx = base.getContext('2d')!;
      const octx = overlay.getContext('2d')!;
      base.width = nb.width;
      base.height = nb.height;
      bctx.clearRect(0, 0, base.width, base.height);
      bctx.drawImage(nb, 0, 0);
      overlay.width = no.width;
      overlay.height = no.height;
      octx.clearRect(0, 0, overlay.width, overlay.height);
      octx.drawImage(no, 0, 0);
      setImgSize({ w: nb.width, h: nb.height });
      setCropRect(null);
    },
    [pushSnapshot],
  );

  const rotate90 = useCallback(() => {
    transformPixels((src) => {
      const out = document.createElement('canvas');
      out.width = src.height;
      out.height = src.width;
      const ctx = out.getContext('2d')!;
      ctx.translate(src.height, 0);
      ctx.rotate(Math.PI / 2);
      ctx.drawImage(src, 0, 0);
      return out;
    });
  }, [transformPixels]);

  const flipH = useCallback(() => {
    transformPixels((src) => {
      const out = document.createElement('canvas');
      out.width = src.width;
      out.height = src.height;
      const ctx = out.getContext('2d')!;
      ctx.translate(src.width, 0);
      ctx.scale(-1, 1);
      ctx.drawImage(src, 0, 0);
      return out;
    });
  }, [transformPixels]);

  /** 应用裁切：base/overlay 同步裁掉选区外像素，完成后退出裁切模式 */
  const applyCrop = useCallback(() => {
    const rect = cropRectRef.current;
    if (!rect || rect.w < 4 || rect.h < 4) {
      showHint('请先调整裁切区域');
      return;
    }
    transformPixels((src) => {
      const out = document.createElement('canvas');
      out.width = rect.w;
      out.height = rect.h;
      out.getContext('2d')!.drawImage(src, -rect.x, -rect.y);
      return out;
    });
    setTool(prevToolRef.current);
    showHint('已裁切');
  }, [transformPixels, showHint]);

  /** 退出裁切（Esc / 取消按钮）：清除选区、切回进入前的工具 */
  const cancelCrop = useCallback(() => {
    setCropRect(null);
    setTool(prevToolRef.current);
  }, []);

  /** 清除全部：恢复初始底图 + 清空标注 */
  const clearAll = useCallback(() => {
    const img = imgRef.current;
    const base = baseRef.current;
    const overlay = overlayRef.current;
    if (!img || !base || !overlay) return;
    pushSnapshot(true);
    const scale = Math.min(1, MAX_DIM / Math.max(img.naturalWidth, img.naturalHeight));
    const w = Math.max(1, Math.round(img.naturalWidth * scale));
    const h = Math.max(1, Math.round(img.naturalHeight * scale));
    const bctx = base.getContext('2d')!;
    base.width = w;
    base.height = h;
    bctx.clearRect(0, 0, base.width, base.height);
    bctx.drawImage(img, 0, 0, w, h);
    const octx = overlay.getContext('2d')!;
    overlay.width = w;
    overlay.height = h;
    octx.clearRect(0, 0, overlay.width, overlay.height);
    setImgSize({ w, h });
    setCropRect(null);
    showHint('已恢复原图');
  }, [pushSnapshot, showHint]);

  /** 选工具；裁切为二段语义（已有选区再点 = 应用） */
  const pickTool = useCallback(
    (t: Tool) => {
      if (t === 'crop') {
        if (toolRef.current === 'crop') {
          applyCrop();
          return;
        }
        prevToolRef.current = toolRef.current;
        const overlay = overlayRef.current;
        if (!overlay) return;
        setCropRect(fullCrop(overlay.width, overlay.height));
        setTool('crop');
        showHint(TOOL_HINTS.crop!);
        return;
      }
      setTool(t);
      const hintText = TOOL_HINTS[t];
      if (hintText) showHint(hintText);
    },
    [applyCrop, showHint],
  );

  /** 切换比例档位：非自由时立即把当前选区重排为该比例（中心保持） */
  const pickRatio = useCallback((r: CropRatio) => {
    setCropRatio(r);
    const ratio = parseCropRatio(r);
    const overlay = overlayRef.current;
    const rect = cropRectRef.current;
    if (ratio !== null && overlay && rect) {
      setCropRect(refitRatio(rect, ratio, overlay.width, overlay.height));
    }
  }, []);

  /** 取色（读 base+overlay 合成像素），成功后写回颜色并切回画笔 */
  const pickColorAt = useCallback(
    (pt: Pt) => {
      const base = baseRef.current;
      const overlay = overlayRef.current;
      if (!base || !overlay) return;
      const tmp = document.createElement('canvas');
      tmp.width = base.width;
      tmp.height = base.height;
      const tctx = tmp.getContext('2d')!;
      tctx.drawImage(base, 0, 0);
      tctx.drawImage(overlay, 0, 0);
      const d = tctx.getImageData(pt.x, pt.y, 1, 1).data;
      const hex = `#${[d[0], d[1], d[2]].map((v) => v!.toString(16).padStart(2, '0')).join('')}`;
      setColor(hex);
      setTool('brush');
      showHint(`已取色 ${hex}`);
    },
    [showHint],
  );

  const overlaySnapshot = useCallback((): ImageData | null => {
    const overlay = overlayRef.current;
    return overlay ? overlay.getContext('2d')!.getImageData(0, 0, overlay.width, overlay.height) : null;
  }, []);

  const strokeStyleOf = useCallback((octx: CanvasRenderingContext2D) => {
    octx.lineCap = 'round';
    octx.lineJoin = 'round';
    octx.strokeStyle = colorRef.current;
    octx.lineWidth = sizeRef.current;
  }, []);

  const drawShape = useCallback(
    (octx: CanvasRenderingContext2D, from: Pt, to: Pt) => {
      strokeStyleOf(octx);
      octx.beginPath();
      if (toolRef.current === 'line' || toolRef.current === 'arrow') {
        octx.moveTo(from.x, from.y);
        octx.lineTo(to.x, to.y);
        octx.stroke();
        if (toolRef.current === 'arrow') {
          const [a, b] = arrowHead(from, to, sizeRef.current);
          octx.beginPath();
          octx.moveTo(a.x, a.y);
          octx.lineTo(to.x, to.y);
          octx.lineTo(b.x, b.y);
          octx.stroke();
        }
      } else if (toolRef.current === 'rect') {
        octx.rect(from.x, from.y, to.x - from.x, to.y - from.y);
        octx.stroke();
      }
    },
    [strokeStyleOf],
  );

  /** 裁切把手/选区盒按下（stopPropagation 防止 stage 绘制分支介入） */
  const startCropDrag = useCallback((e: React.PointerEvent, handle: CropHandle) => {
    e.stopPropagation();
    e.preventDefault();
    const overlay = overlayRef.current;
    const rect = cropRectRef.current;
    if (!overlay || !rect) return;
    (e.currentTarget as HTMLElement).setPointerCapture(e.pointerId);
    cropDragRef.current = { handle, startRect: { ...rect }, startPt: toCanvasPoint(e.nativeEvent, overlay) };
  }, []);

  const onPointerDown = useCallback(
    (e: React.PointerEvent<HTMLDivElement>) => {
      const overlay = overlayRef.current;
      if (!overlay || textEdit) return;
      // 裁切模式：选区由 DOM 把手/盒处理，stage 空白处不启动绘制
      if (toolRef.current === 'crop') return;
      const pt = toCanvasPoint(e.nativeEvent, overlay);
      const t = toolRef.current;
      if (t === 'picker') {
        pickColorAt(pt);
        return;
      }
      if (t === 'text') {
        // 阻止 mousedown 默认聚焦行为：否则随后的默认焦点处理会夺走刚 mount 的输入框焦点，
        // 触发 onBlur 空值关闭——输入框"闪现即消失"（概率性，取决于事件时序）
        e.preventDefault();
        setTextEdit({ x: pt.x, y: pt.y, value: '' });
        return;
      }
      (e.target as HTMLElement).setPointerCapture?.(e.pointerId);
      drawDragRef.current = {
        active: true,
        start: pt,
        last: pt,
        before: t === 'line' || t === 'arrow' || t === 'rect' ? (overlaySnapshot() ?? undefined) : undefined,
      };
      if (t === 'brush' || t === 'eraser') {
        const octx = overlay.getContext('2d')!;
        if (t === 'eraser') {
          octx.save();
          octx.globalCompositeOperation = 'destination-out';
          octx.beginPath();
          octx.arc(pt.x, pt.y, sizeRef.current, 0, Math.PI * 2);
          octx.fill();
          octx.restore();
        } else {
          strokeStyleOf(octx);
          octx.beginPath();
          octx.moveTo(pt.x, pt.y);
          octx.lineTo(pt.x + 0.01, pt.y + 0.01);
          octx.stroke();
        }
      }
    },
    [overlaySnapshot, pickColorAt, strokeStyleOf, textEdit],
  );

  const onPointerMove = useCallback(
    (e: React.PointerEvent<HTMLDivElement>) => {
      const overlay = overlayRef.current;
      if (!overlay) return;
      const pt = toCanvasPoint(e.nativeEvent, overlay);
      // 裁切拖动：把手/移动（capture 保证 move 不丢）
      const cropDrag = cropDragRef.current;
      if (cropDrag) {
        setCropRect(
          resizeCrop(
            cropDrag.handle,
            cropDrag.startRect,
            pt.x - cropDrag.startPt.x,
            pt.y - cropDrag.startPt.y,
            parseCropRatio(cropRatioRef.current),
            overlay.width,
            overlay.height,
          ),
        );
        return;
      }
      const drag = drawDragRef.current;
      if (!drag?.active) return;
      const octx = overlay.getContext('2d')!;
      if (drag.before) {
        octx.putImageData(drag.before, 0, 0);
        drawShape(octx, drag.start, pt);
      } else {
        if (toolRef.current === 'eraser') {
          octx.save();
          octx.globalCompositeOperation = 'destination-out';
          octx.lineWidth = sizeRef.current * 2;
          octx.lineCap = 'round';
          octx.beginPath();
          octx.moveTo(drag.last.x, drag.last.y);
          octx.lineTo(pt.x, pt.y);
          octx.stroke();
          octx.restore();
        } else {
          strokeStyleOf(octx);
          octx.beginPath();
          octx.moveTo(drag.last.x, drag.last.y);
          octx.lineTo(pt.x, pt.y);
          octx.stroke();
        }
      }
      drag.last = pt;
    },
    [drawShape, strokeStyleOf],
  );

  const endDrag = useCallback(() => {
    const drag = drawDragRef.current;
    if (drag?.active) {
      drag.active = false;
      pushSnapshot(false);
    }
    cropDragRef.current = null;
  }, [pushSnapshot]);

  /** 文字提交（Enter / 失焦）：写到 overlay 标注层（字号与输入框所见一致） */
  const commitText = useCallback(() => {
    const edit = textEdit;
    const overlay = overlayRef.current;
    if (!edit || !overlay) return;
    setTextEdit(null);
    const value = edit.value.trim();
    if (!value) return;
    const octx = overlay.getContext('2d')!;
    octx.save();
    octx.fillStyle = colorRef.current;
    octx.font = `${Math.max(12, sizeRef.current * 5)}px system-ui, sans-serif`;
    octx.textBaseline = 'top';
    octx.fillText(value, edit.x, edit.y);
    octx.restore();
    pushSnapshot(false);
  }, [textEdit, pushSnapshot]);

  /** 保存：base + overlay 合成导出（裁切激活时按当前选区导出） */
  const save = useCallback(() => {
    const base = baseRef.current;
    const overlay = overlayRef.current;
    if (!base || !overlay) return;
    const rect = toolRef.current === 'crop' ? cropRectRef.current : null;
    const useRect = rect && rect.w >= 4 && rect.h >= 4 ? rect : null;
    const out = document.createElement('canvas');
    out.width = useRect ? useRect.w : base.width;
    out.height = useRect ? useRect.h : base.height;
    const octx = out.getContext('2d')!;
    octx.drawImage(base, useRect ? -useRect.x : 0, useRect ? -useRect.y : 0);
    octx.drawImage(overlay, useRect ? -useRect.x : 0, useRect ? -useRect.y : 0);
    onSave(out.toDataURL('image/png'));
  }, [onSave]);

  // Esc 分层：文字输入 → 取消文字；裁切 → 退出裁切；其余 → 关闭编辑器。
  // Enter：裁切中应用。Ctrl+Z / Ctrl+Shift+Z：撤销/重做（输入框聚焦时跳过）。
  useEffect(() => {
    const onKey = (e: KeyboardEvent): void => {
      // IME 组合中（中文选字 Enter / 取候选 Esc）不处理任何编辑器快捷键——
      // 否则中文输入每确认一次候选就会误触提交/取消，文字输入完全不可用
      if (e.isComposing) return;
      const t = e.target as HTMLElement | null;
      const typing = !!t && (t.tagName === 'INPUT' || t.tagName === 'TEXTAREA' || t.isContentEditable);
      if (e.key === 'Escape') {
        if (textEdit) {
          setTextEdit(null);
          return;
        }
        if (toolRef.current === 'crop' && cropRectRef.current) {
          cancelCrop();
          return;
        }
        if (!typing) onClose();
        return;
      }
      if (typing) return;
      if (e.key === 'Enter' && toolRef.current === 'crop' && cropRectRef.current) {
        e.preventDefault();
        applyCrop();
        return;
      }
      if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'z') {
        e.preventDefault();
        if (e.shiftKey) redo();
        else undo();
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [textEdit, onClose, cancelCrop, applyCrop, undo, redo]);

  // 载入底图（钳制超大图）
  useEffect(() => {
    let cancelled = false;
    const img = new Image();
    img.onload = () => {
      if (cancelled) return;
      const scale = Math.min(1, MAX_DIM / Math.max(img.naturalWidth, img.naturalHeight));
      const w = Math.max(1, Math.round(img.naturalWidth * scale));
      const h = Math.max(1, Math.round(img.naturalHeight * scale));
      imgRef.current = img;
      const base = baseRef.current;
      const overlay = overlayRef.current;
      if (!base || !overlay) return;
      base.width = w;
      base.height = h;
      base.getContext('2d')!.drawImage(img, 0, 0, w, h);
      overlay.width = w;
      overlay.height = h;
      undoRef.current = [];
      redoRef.current = [];
      setImgSize({ w, h });
      setCanUndo(false);
      setCanRedo(false);
      setReady(true);
    };
    img.onerror = () => {
      if (!cancelled) showHint('图像加载失败');
    };
    img.src = src;
    return () => {
      cancelled = true;
    };
  }, [src, showHint]);

  // 文字输入框稳态聚焦：setTimeout(0) 避开点击当次的浏览器默认焦点处理（autoFocus 会被其覆盖）
  useEffect(() => {
    if (!textEdit) return;
    const id = window.setTimeout(() => textInputRef.current?.focus(), 0);
    return () => window.clearTimeout(id);
  }, [textEdit]);

  // 显示缩放比（文字输入框字号换算；随窗口/画布尺寸变化）
  useEffect(() => {
    const update = (): void => {
      const stage = stageRef.current;
      const overlay = overlayRef.current;
      if (stage && overlay && overlay.width > 0) {
        setDisplayScale(stage.getBoundingClientRect().width / overlay.width);
      }
    };
    update();
    window.addEventListener('resize', update);
    return () => window.removeEventListener('resize', update);
  }, [imgSize, ready]);

  const cursor = tool === 'text' ? 'text' : 'crosshair';
  const cw = imgSize?.w ?? 1;
  const ch = imgSize?.h ?? 1;
  const pctOf = (v: number, total: number): string => `${(v / total) * 100}%`;
  const cropBoxStyle = cropRect
    ? {
        left: pctOf(cropRect.x, cw),
        top: pctOf(cropRect.y, ch),
        width: pctOf(cropRect.w, cw),
        height: pctOf(cropRect.h, ch),
      }
    : undefined;

  return (
    <div className="editor-fullscreen" role="dialog" aria-modal="true" aria-label={`编辑图像：${name}`}>
      <div className="editor-stage">
        <div
          className="editor-canvas-stage"
          ref={stageRef}
          style={{ cursor, ...(imgSize ? { aspectRatio: `${imgSize.w} / ${imgSize.h}` } : {}) }}
          onPointerDown={onPointerDown}
          onPointerMove={onPointerMove}
          onPointerUp={endDrag}
          onPointerLeave={endDrag}
        >
          <canvas ref={baseRef} className="editor-canvas editor-canvas--base" />
          <canvas ref={overlayRef} className="editor-canvas editor-canvas--overlay" />
          {tool === 'crop' && cropRect && cropBoxStyle && (
            <div className="editor-crop-box" style={cropBoxStyle} onPointerDown={(e) => startCropDrag(e, 'move')}>
              {CROP_HANDLES.map((h) => (
                <div
                  key={h}
                  className={`editor-crop-handle editor-crop-handle--${h}`}
                  onPointerDown={(e) => startCropDrag(e, h)}
                  aria-hidden="true"
                />
              ))}
            </div>
          )}
          {textEdit && (
            <input
              className="editor-text-input"
              style={{
                left: pctOf(textEdit.x, cw),
                top: pctOf(textEdit.y, ch),
                fontSize: Math.max(11, Math.round(5 * size * displayScale)),
              }}
              ref={textInputRef}
              value={textEdit.value}
              placeholder="输入文字，Enter 确认"
              onPointerDown={(e) => e.stopPropagation()}
              onFocus={(e) => e.currentTarget.select()}
              onChange={(e) => setTextEdit((cur) => (cur ? { ...cur, value: e.target.value } : cur))}
              onKeyDown={(e) => {
                // IME 组合中的 Enter（确认候选）不提交
                if (e.key === 'Enter' && !e.nativeEvent.isComposing) commitText();
              }}
              onBlur={commitText}
            />
          )}
        </div>
      </div>
      <div className="editor-topbar">
        <span className="editor-mode-badge">编辑模式</span>
        <span className="editor-topbar__name">{name}</span>
        <button type="button" className="editor-icon-btn" onClick={onClose} aria-label="关闭编辑器" title="关闭（Esc）">
          <ToolIcon d={ICONS.close!} />
        </button>
      </div>
      {tool === 'crop' && (
        <div className="editor-crop-actions">
          {CROP_RATIOS.map((r) => (
            <button
              key={r}
              type="button"
              className={`editor-ratio-chip ${cropRatio === r ? 'is-active' : ''}`}
              onClick={() => pickRatio(r)}
              aria-pressed={cropRatio === r}
            >
              {r === 'free' ? '自由' : r}
            </button>
          ))}
          <span className="editor-crop-actions__sep" aria-hidden="true" />
          <button type="button" className="editor-ratio-chip editor-ratio-chip--apply" onClick={applyCrop}>
            ✓ 应用
          </button>
          <button type="button" className="editor-ratio-chip" onClick={cancelCrop}>
            ✕ 取消
          </button>
        </div>
      )}
      <div className="editor-toolbar editor-toolbar--floating">
        <div className="editor-tool-group" role="toolbar" aria-label="编辑工具">
          {(['brush', 'eraser', 'line', 'arrow', 'rect', 'text', 'picker', 'crop'] as Tool[]).map((t) => (
            <button
              key={t}
              type="button"
              className={`editor-tool-btn ${tool === t ? 'is-active' : ''}`}
              onClick={() => pickTool(t)}
              title={TOOL_TITLES[t]}
              aria-pressed={tool === t}
            >
              <ToolIcon d={ICONS[t]!} />
            </button>
          ))}
        </div>
        <div className="editor-tool-group">
          <label className="editor-color-picker" title="颜色">
            <input type="color" value={color} onChange={(e) => setColor(e.target.value)} />
          </label>
          <input
            type="range"
            className="editor-size-slider"
            min={1}
            max={30}
            value={size}
            title="粗细（文字字号随粗细）"
            onChange={(e) => setSize(Number(e.target.value))}
          />
          <span className="editor-size-label">{size}px</span>
        </div>
        <div className="editor-tool-group">
          <button type="button" className="editor-tool-btn" onClick={undo} disabled={!canUndo} title="撤销（Ctrl+Z）">
            <ToolIcon d={ICONS.undo!} />
          </button>
          <button type="button" className="editor-tool-btn" onClick={redo} disabled={!canRedo} title="重做（Ctrl+Shift+Z）">
            <ToolIcon d={ICONS.redo!} />
          </button>
          <button type="button" className="editor-tool-btn" onClick={rotate90} disabled={!ready} title="旋转 90°">
            <ToolIcon d={ICONS.rotate!} />
          </button>
          <button type="button" className="editor-tool-btn" onClick={flipH} disabled={!ready} title="水平翻转">
            <ToolIcon d={ICONS.flip!} />
          </button>
          <button type="button" className="editor-tool-btn" onClick={clearAll} disabled={!ready} title="清除全部（恢复原图）">
            <ToolIcon d={ICONS.trash!} />
          </button>
        </div>
        <div className="editor-tool-group editor-tool-group--end">
          <button type="button" className="editor-btn editor-btn--primary" onClick={save} disabled={!ready}>
            保存
          </button>
          <button type="button" className="editor-btn editor-btn--secondary" onClick={onClose}>
            取消
          </button>
        </div>
      </div>
      {(hint || !ready) && (
        <div className="editor-hint editor-hint--floating" role="status">
          {hint ?? '正在加载图像…'}
        </div>
      )}
    </div>
  );
}
