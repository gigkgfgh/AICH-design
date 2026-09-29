/**
 * PlanCanvas —— 平面方案画布（P010）
 *
 * - SVG 渲染：优先以 PlanStructure 为数据源本地渲染（§5.3 规范，支持高亮），
 *   仅持 svg 字符串时直渲（TODO-API: P008 render_plan_svg 就绪后 svg 为后端产出）
 * - 缩放：滚轮（0.4x ~ 3.0x）+ 工具栏按钮
 * - 平移：鼠标拖拽
 * - 房间高亮：点击房间 → onSelectRoom（hit layer 事件委托）
 * - 导出 PNG（P014）：svgToPngDataUrl → 复制剪贴板，失败回退下载
 * - 生成表现图（P013）：App 侧编排 genImage（依赖当前 plan）
 * - 空态：无方案时展示引导文案
 */
import { useEffect, useRef, useState, type MouseEvent as ReactMouseEvent, type ReactElement } from 'react';
import type { PlanStructure } from '../types/contracts';
import { SCALE_PX_PER_M, renderPlanSvg, withRoomHitAreas } from '../lib/planSvg';
import { svgToPngDataUrl } from '../lib/svgToPng';

export interface PlanCanvasProps {
  plan: PlanStructure | null;
  /** 后端/本地渲染的 svg 字符串（TODO-API: P008 就绪后为唯一 svg 来源） */
  svg?: string | null;
  selectedRoomId?: string | null;
  onSelectRoom: (roomId: string | null) => void;
  /** 生成表现图（P013）；undefined 时不渲染该按钮 */
  onGenerateImage?: () => void;
  /** 图像请求进行中（禁用生成按钮） */
  imageGenerating?: boolean;
}

const MIN_SCALE = 0.4;
const MAX_SCALE = 3.0;

export function PlanCanvas(props: PlanCanvasProps): ReactElement {
  const { plan, svg, selectedRoomId, onSelectRoom, onGenerateImage, imageGenerating } = props;
  const [scale, setScale] = useState(1);
  const [offset, setOffset] = useState({ x: 0, y: 0 });
  const gestureRef = useRef<{ downX: number; downY: number; moved: boolean } | null>(null);
  /** 本手势发生过拖拽（mouseup 时置位，click 消费，避免拖拽结束误触房间选中） */
  const draggedRef = useRef(false);
  /** 导出/复制提示（P014） */
  const [exporting, setExporting] = useState(false);
  const [exportNote, setExportNote] = useState<string | null>(null);

  // 当前展示的 SVG：有 plan 时本地渲染（支持高亮 + 点选层），否则直渲传入 svg
  const displaySvg = plan
    ? withRoomHitAreas(renderPlanSvg(plan, { selectedRoomId: selectedRoomId ?? undefined }), plan)
    : (svg ?? null);

  // 导出/生成参考用的干净 SVG（无高亮、无点选层；避免把交互态栅格化进 PNG）
  const exportSvg = plan ? renderPlanSvg(plan) : (svg ?? null);
  const canExport = exportSvg !== null;
  const canGenerate = exportSvg !== null && !imageGenerating;

  // 滚轮缩放（非被动监听以阻止页面滚动）
  const canvasRef = useRef<HTMLDivElement>(null);
  useEffect(() => {
    const el = canvasRef.current;
    if (!el) {
      return;
    }
    const onWheel = (e: WheelEvent): void => {
      e.preventDefault();
      setScale((s) => Math.min(MAX_SCALE, Math.max(MIN_SCALE, s * (e.deltaY > 0 ? 0.9 : 1.1))));
    };
    el.addEventListener('wheel', onWheel, { passive: false });
    return () => el.removeEventListener('wheel', onWheel);
  }, []);

  function handleMouseDown(e: ReactMouseEvent): void {
    gestureRef.current = { downX: e.clientX, downY: e.clientY, moved: false };
    e.currentTarget.classList.add('is-dragging');
  }

  function handleMouseMove(e: ReactMouseEvent): void {
    const g = gestureRef.current;
    if (!g) {
      return;
    }
    const dx = e.clientX - g.downX;
    const dy = e.clientY - g.downY;
    if (!g.moved && Math.hypot(dx, dy) > 3) {
      g.moved = true;
    }
    setOffset((prev) => ({ x: prev.x + dx, y: prev.y + dy }));
    gestureRef.current = { ...g, downX: e.clientX, downY: e.clientY };
  }

  function endGesture(e: ReactMouseEvent): void {
    if (gestureRef.current?.moved) {
      draggedRef.current = true;
    }
    gestureRef.current = null;
    (e.currentTarget as HTMLElement).classList.remove('is-dragging');
  }

  function handleCanvasClick(e: ReactMouseEvent): void {
    if (draggedRef.current) {
      // 该手势为拖拽，消费标记，不触发房间选中
      draggedRef.current = false;
      return;
    }
    const target = e.target as Element | null;
    const hit = target?.closest?.('[data-room-id]');
    const roomId = hit?.getAttribute('data-room-id');
    onSelectRoom(roomId ?? null);
  }

  function resetView(): void {
    setScale(1);
    setOffset({ x: 0, y: 0 });
  }

  /** 触发浏览器下载（a[download]） */
  function downloadDataUrl(dataUrl: string, filename: string): void {
    const a = document.createElement('a');
    a.href = dataUrl;
    a.download = filename;
    a.click();
  }

  /** 复制 PNG 到剪贴板（ClipboardItem 路径；失败抛错由调用方回退下载） */
  async function copyPngToClipboard(dataUrl: string): Promise<void> {
    if (typeof navigator === 'undefined' || !navigator.clipboard || typeof ClipboardItem === 'undefined') {
      throw new Error('当前环境不支持剪贴板复制');
    }
    const blob = await (await fetch(dataUrl)).blob();
    await navigator.clipboard.write([new ClipboardItem({ 'image/png': blob })]);
  }

  /** P014：SVG → PNG dataURL → 复制剪贴板（失败回退下载） */
  async function handleExportPng(): Promise<void> {
    if (!exportSvg || exporting) {
      return;
    }
    setExporting(true);
    setExportNote(null);
    try {
      const dataUrl = await svgToPngDataUrl(exportSvg, { scale: 2, background: '#ffffff' });
      // TODO-API: P012 后作 image_edit 参考图源（导出结果 dataURL 可作 P013 图像 mock 与 P012 参考图）
      try {
        await copyPngToClipboard(dataUrl);
        setExportNote('PNG 已复制到剪贴板');
      } catch {
        const filename = `aich-plan-${Date.now().toString(36)}.png`;
        downloadDataUrl(dataUrl, filename);
        setExportNote(`已下载 ${filename}`);
      }
    } catch (err) {
      setExportNote(`导出失败：${(err as Error).message}`);
    } finally {
      setExporting(false);
    }
  }

  function handleGenerateImage(): void {
    if (!canGenerate) {
      return;
    }
    setExportNote(null);
    onGenerateImage?.();
  }

  return (
    <section className="plan-canvas" aria-label="平面方案画布">
      <header className="plan-canvas__toolbar">
        <h2>方案画布</h2>
        <div className="plan-canvas__controls">
          <button type="button" onClick={() => setScale((s) => Math.min(MAX_SCALE, s * 1.15))} title="放大">
            +
          </button>
          <button type="button" onClick={() => setScale((s) => Math.max(MIN_SCALE, s * 0.87))} title="缩小">
            −
          </button>
          <button type="button" onClick={resetView} title="重置视图">
            适应
          </button>
          <span className="plan-canvas__scale">
            {Math.round(scale * 100)}%（{SCALE_PX_PER_M}px/m）
          </span>
          {onGenerateImage && (
            <button
              type="button"
              className="plan-canvas__action"
              disabled={!canGenerate}
              onClick={handleGenerateImage}
              title={canGenerate ? '将当前平面方案渲染为表现图' : '请先生成平面方案'}
            >
              {imageGenerating ? '生成中…' : '生成表现图'}
            </button>
          )}
          <button
            type="button"
            className="plan-canvas__action"
            disabled={!canExport || exporting}
            onClick={() => void handleExportPng()}
            title={canExport ? '导出 PNG（复制到剪贴板，失败自动下载）' : '请先生成平面方案'}
          >
            {exporting ? '导出中…' : '导出 PNG'}
          </button>
          {exportNote && <span className="plan-canvas__note">{exportNote}</span>}
        </div>
      </header>

      <div
        ref={canvasRef}
        className="plan-canvas__viewport"
        onMouseDown={handleMouseDown}
        onMouseMove={handleMouseMove}
        onMouseUp={endGesture}
        onMouseLeave={endGesture}
        onClick={handleCanvasClick}
      >
        {displaySvg ? (
          <div
            className="plan-canvas__svg-wrap"
            style={{ transform: `translate(${offset.x}px, ${offset.y}px) scale(${scale})` }}
            // 注入的 SVG 由本地渲染器/后端产生，静态结构安全（escapeXml 已处理文本）
            dangerouslySetInnerHTML={{ __html: displaySvg }}
          />
        ) : (
          <div className="plan-canvas__empty">
            <p>暂无方案</p>
            <p className="plan-canvas__empty-hint">
              在左侧输入一句话描述户型需求，生成的平面方案（SVG）将显示在这里；
              点击房间可高亮选中。
            </p>
          </div>
        )}
      </div>
    </section>
  );
}