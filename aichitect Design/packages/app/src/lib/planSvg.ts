/**
 * PlanStructure → SVG 字符串渲染器（P010，对接设计文档 §5.3 渲染规范）
 *
 * 渲染规范（冻结文本）：
 * - 坐标系 viewBox="0 0 W H"（单位 px），比例尺 scale = 50 px/m
 * - 图层顺序：墙体（深色 #333，含门洞/窗洞）→ 房间填充（#eef + 名称 + 面积）→
 *   开口（门弧线/窗双线）→ 尺寸标注（轴线 + 数值）→ 指北针
 * - 文字 font-family: sans-serif
 *
 * TODO-API: P008 render_plan_svg 工具（backend）契约就绪后，AgentResponse.plan.svg 由
 * 后端渲染器产出，前端此处仅保留「直渲 svg 字符串」路径（PlanCanvas 优先使用传入 svg）；
 * 本地渲染器保留用于 mock 阶段与房间高亮重渲染。
 */
import type { PlanRoom, PlanStructure, PlanWall } from '../types/contracts';

/** 比例尺：50px/m（§5.3） */
export const SCALE_PX_PER_M = 50;

/** 渲染选项（非契约，PlanCanvas 交互状态） */
export interface RenderOptions {
  /** 高亮房间 id（选中态：描边 + 填充提亮） */
  selectedRoomId?: string;
}

const ROOM_FILL = '#eef';
const ROOM_FILL_SELECTED = '#ddeefc';
const ROOM_STROKE_SELECTED = '#0a5fd0';
const WALL_FILL = '#333';
const OPENING_COLOR = '#333';
const WINDOW_COLOR = '#4a6fa5';
const DIMENSION_COLOR = '#777';
const TEXT_COLOR = '#222';
const FONT = 'sans-serif';

/** XML 转义：svg 内文本（房间名等可能来自 LLM 输出）必须转义再嵌入 */
function escapeXml(value: string): string {
  return value
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&apos;');
}

function px(m: number): number {
  return m * SCALE_PX_PER_M;
}

function fmt1(v: number): string {
  return v.toFixed(1);
}

/** 圆整到 0.1px，避免浮点长尾 */
function r1(v: number): number {
  return Math.round(v * 10) / 10;
}

interface WallSegment {
  x1: number;
  y1: number;
  x2: number;
  y2: number;
}

/**
 * 把一面墙按开口切成若干完整墙段（墙体含门洞/窗洞，§5.3）。
 * 开口以 walls 上 hasDoor/hasWindow 兜底（缺省：门 0.9m、窗 1.5m、居中）。
 * 返回的段为墙中心线坐标（单位 m），绘图时按厚度扩展成矩形。
 */
function wallSegments(wall: PlanWall, openings: PlanStructure['openings']): WallSegment[] {
  const length = Math.hypot(wall.x2 - wall.x1, wall.y2 - wall.y1);
  if (length <= 0) {
    return [];
  }

  const wallOpenings = (openings ?? []).filter((o) => o.wallId === wall.id);
  // 兜底：墙上标记了门/窗但 openings 未列出的，按默认尺寸居中补一个
  if (wall.hasDoor && !wallOpenings.some((o) => o.kind === 'door')) {
    wallOpenings.push({ kind: 'door', wallId: wall.id, offsetM: length / 2 - 0.45, widthM: 0.9 });
  }
  if (wall.hasWindow && !wallOpenings.some((o) => o.kind === 'window')) {
    wallOpenings.push({ kind: 'window', wallId: wall.id, offsetM: length / 2 - 0.75, widthM: 1.5 });
  }

  if (wallOpenings.length === 0) {
    return [{ x1: wall.x1, y1: wall.y1, x2: wall.x2, y2: wall.y2 }];
  }

  const ux = (wall.x2 - wall.x1) / length; // 单位方向向量
  const uy = (wall.y2 - wall.y1) / length;
  // 开口区间（裁剪到墙范围内），按 offset 排序
  const gaps: Array<[number, number]> = wallOpenings
    .map((o) => {
      const off = Math.max(0, Math.min(length, o.offsetM ?? 0));
      const w = Math.max(0.3, Math.min(length - off, o.widthM ?? 1.0));
      return [off, off + w] as [number, number];
    })
    .sort((a, b) => a[0] - b[0]);

  const segments: WallSegment[] = [];
  let cursor = 0;
  for (const [g0, g1] of gaps) {
    if (g0 > cursor + 1e-6) {
      segments.push({
        x1: wall.x1 + ux * cursor,
        y1: wall.y1 + uy * cursor,
        x2: wall.x1 + ux * g0,
        y2: wall.y1 + uy * g0,
      });
    }
    cursor = Math.max(cursor, g1);
  }
  if (cursor < length - 1e-6) {
    segments.push({
      x1: wall.x1 + ux * cursor,
      y1: wall.y1 + uy * cursor,
      x2: wall.x2,
      y2: wall.y2,
    });
  }
  return segments;
}

/**
 * 墙段 → 旋转矩形（中心线段 + 厚度扩展，px 坐标）。
 * 修复 R006：旧实现恒以 w=墙长/h=厚度构造矩形，竖直墙被画成水平横条；
 * 现按墙方向计算 angle，用 transform="rotate(angle, cx, cy)" 渲染，
 * 水平/竖直/对角墙均正确（与 backend render.ts <line stroke-width> 方案等效）。
 */
function wallRect(
  seg: WallSegment,
  halfW: number
): { x: number; y: number; w: number; h: number; angle: number; cx: number; cy: number } {
  const ax = px(seg.x1);
  const ay = px(seg.y1);
  const bx = px(seg.x2);
  const by = px(seg.y2);
  const w = r1(Math.hypot(bx - ax, by - ay));
  const cx = r1((ax + bx) / 2);
  const cy = r1((ay + by) / 2);
  // 墙方向角（度）；水平墙 0、竖直墙 ±90、对角墙按实际斜率
  const angle = Math.round((Math.atan2(by - ay, bx - ax) * 180) / Math.PI * 100) / 100;
  return { x: r1(cx - w / 2), y: r1(cy - halfW), w, h: r1(halfW * 2), angle, cx, cy };
}

/** 图层 1：墙体（深色 #333，含门洞/窗洞分段） */
function renderWalls(plan: PlanStructure): string {
  const parts: string[] = [];
  for (const wall of plan.walls) {
    const halfW = r1(px((wall.thicknessMm ?? 200) / 1000) / 2);
    for (const seg of wallSegments(wall, plan.openings)) {
      const rect = wallRect(seg, halfW);
      const transform =
        rect.angle === 0
          ? ''
          : ` transform="rotate(${rect.angle} ${rect.cx} ${rect.cy})"`;
      parts.push(
        `<rect x="${rect.x}" y="${rect.y}" width="${rect.w}" height="${rect.h}" fill="${WALL_FILL}"${transform}/>`
      );
    }
  }
  return parts.join('');
}

/** 图层 2：房间（#eef + 名称 + 面积；房间内缩墙半宽，避免盖住分隔墙） */
function renderRooms(plan: PlanStructure, options?: RenderOptions): string {
  const ins = 5; // 内缩 px（200mm 墙的半厚 @50px/m = 5px）
  const parts: string[] = [];
  for (const room of plan.rooms) {
    const x = px(room.x) + ins;
    const y = px(room.y) + ins;
    const w = px(room.w) - ins * 2;
    const h = px(room.h) - ins * 2;
    if (w <= 0 || h <= 0) {
      continue;
    }
    if (h < 34) {
      // 房间太小放不下两行文字：只显示名称
      parts.push(
        `<rect x="${r1(x)}" y="${r1(y)}" width="${r1(w)}" height="${r1(h)}" fill="${ROOM_FILL}" rx="1"/>` +
          `<text x="${r1(x + w / 2)}" y="${r1(y + h / 2 + 4)}" text-anchor="middle" font-family="${FONT}" font-size="11" fill="${TEXT_COLOR}">${escapeXml(room.name)}</text>`
      );
      continue;
    }
    const selected = room.id === options?.selectedRoomId;
    const fill = selected ? ROOM_FILL_SELECTED : ROOM_FILL;
    const stroke = selected ? ` stroke="${ROOM_STROKE_SELECTED}" stroke-width="2"` : '';
    const area = room.areaM2 ?? room.w * room.h;
    parts.push(
      `<rect x="${r1(x)}" y="${r1(y)}" width="${r1(w)}" height="${r1(h)}" fill="${fill}"${stroke} rx="1"/>` +
        `<text x="${r1(x + w / 2)}" y="${r1(y + h / 2 - 2)}" text-anchor="middle" font-family="${FONT}" font-size="13" fill="${TEXT_COLOR}">${escapeXml(room.name)}</text>` +
        `<text x="${r1(x + w / 2)}" y="${r1(y + h / 2 + 14)}" text-anchor="middle" font-family="${FONT}" font-size="10" fill="#889">${fmt1(area)} m²</text>`
    );
  }
  return parts.join('');
}

/** 图层 3：开口 —— 门：90° 弧 + 门扇线；窗：双线玻璃示意（§5.3） */
function renderOpenings(plan: PlanStructure): string {
  const parts: string[] = [];
  for (const wall of plan.walls) {
    const length = Math.hypot(wall.x2 - wall.x1, wall.y2 - wall.y1);
    if (length <= 0) {
      continue;
    }
    const ux = (wall.x2 - wall.x1) / length;
    const uy = (wall.y2 - wall.y1) / length;
    const nx = -uy; // 法线（墙逆时针 90° 侧）
    const ny = ux;
    const wallOpenings = plan.openings?.filter((o) => o.wallId === wall.id) ?? [];

    for (const o of wallOpenings) {
      const off = o.offsetM ?? 0;
      const w = o.widthM ?? (o.kind === 'door' ? 0.9 : 1.5);
      const wPx = r1(px(w));
      // 洞口两端（px 坐标）
      const ax = r1(px(wall.x1 + ux * off));
      const ay = r1(px(wall.y1 + uy * off));
      const bx = r1(px(wall.x1 + ux * (off + w)));
      const by = r1(px(wall.y1 + uy * (off + w)));

      if (o.kind === 'door') {
        // 门：铰链在洞口起点 A，半径 = 洞宽，90° 弧扫向法线侧 + 门扇封边线 A→B
        const arcEndX = r1(ax + nx * wPx);
        const arcEndY = r1(ay + ny * wPx);
        parts.push(
          `<path d="M ${bx} ${by} A ${wPx} ${wPx} 0 0 1 ${arcEndX} ${arcEndY}" fill="none" stroke="${OPENING_COLOR}" stroke-width="1.4"/>` +
            `<line x1="${ax}" y1="${ay}" x2="${bx}" y2="${by}" stroke="${OPENING_COLOR}" stroke-width="1.2"/>`
        );
      } else {
        // 窗：洞口处双平行线（玻璃示意）
        const gap = 3;
        parts.push(
          `<line x1="${r1(ax + nx * gap)}" y1="${r1(ay + ny * gap)}" x2="${r1(bx + nx * gap)}" y2="${r1(by + ny * gap)}" stroke="${WINDOW_COLOR}" stroke-width="1.3"/>` +
            `<line x1="${r1(ax - nx * gap)}" y1="${r1(ay - ny * gap)}" x2="${r1(bx - nx * gap)}" y2="${r1(by - ny * gap)}" stroke="${WINDOW_COLOR}" stroke-width="1.3"/>`
        );
      }
    }
  }
  return parts.join('');
}

/** 图层 4：尺寸标注（轴线 + 数值，§5.3） */
function renderDimensions(plan: PlanStructure): string {
  const wPx = px(plan.bounds.widthM);
  const hPx = px(plan.bounds.heightM);
  const yLine = hPx - 14;
  const xLine = wPx - 14;
  const label = `${fmt1(plan.bounds.widthM)}m × ${fmt1(plan.bounds.heightM)}m`;
  return (
    `<g stroke="${DIMENSION_COLOR}" stroke-width="1" fill="none">` +
    `<line x1="6" y1="${r1(yLine)}" x2="${r1(wPx - 6)}" y2="${r1(yLine)}"/>` +
    `<line x1="6" y1="${r1(yLine - 4)}" x2="6" y2="${r1(yLine + 4)}"/>` +
    `<line x1="${r1(wPx - 6)}" y1="${r1(yLine - 4)}" x2="${r1(wPx - 6)}" y2="${r1(yLine + 4)}"/>` +
    `<line x1="${r1(xLine)}" y1="6" x2="${r1(xLine)}" y2="${r1(hPx - 6)}"/>` +
    `<line x1="${r1(xLine - 4)}" y1="6" x2="${r1(xLine + 4)}" y2="6"/>` +
    `<line x1="${r1(xLine - 4)}" y1="${r1(hPx - 6)}" x2="${r1(xLine + 4)}" y2="${r1(hPx - 6)}"/>` +
    `</g>` +
    `<text x="${r1(wPx - 16)}" y="${r1(yLine - 8)}" text-anchor="end" font-family="${FONT}" font-size="10" fill="${DIMENSION_COLOR}">${label}</text>`
  );
}

/** 图层 5：指北针（右上角，避开尺寸标注区） */
function renderCompass(plan: PlanStructure): string {
  const cx = px(plan.bounds.widthM) - 26;
  const cy = 22;
  const r = 10;
  return (
    `<circle cx="${cx}" cy="${cy}" r="${r}" fill="none" stroke="#999" stroke-width="1"/>` +
    `<polygon points="${cx},${cy - r + 2} ${cx - 4.5},${cy + r - 3} ${cx + 4.5},${cy + r - 3}" fill="#c33"/>` +
    `<text x="${cx}" y="${cy + r + 11}" text-anchor="middle" font-family="${FONT}" font-size="9" fill="#555">N</text>`
  );
}

/** 按 §5.3 渲染规范生成 SVG 字符串（viewBox="0 0 W H" 严格遵循契约） */
export function renderPlanSvg(plan: PlanStructure, options?: RenderOptions): string {
  const w = r1(px(plan.bounds.widthM));
  const h = r1(px(plan.bounds.heightM));
  return (
    `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${w} ${h}" ` +
    `width="${w}" height="${h}" font-family="${FONT}">` +
    `<rect x="0" y="0" width="${w}" height="${h}" fill="#fff"/>` +
    `<g id="layer-walls">${renderWalls(plan)}</g>` +
    `<g id="layer-rooms">${renderRooms(plan, options)}</g>` +
    `<g id="layer-openings">${renderOpenings(plan)}</g>` +
    `<g id="layer-dimensions">${renderDimensions(plan)}</g>` +
    `<g id="layer-compass">${renderCompass(plan)}</g>` +
    `</svg>`
  );
}

/**
 * mock 阶段用：把渲染结果套上可点选的数据属性（data-room-id），
 * PlanCanvas 通过事件委托捕获点击 → 高亮房间。
 * TODO-API: 真实链路 svg 由 P008 后端产出后，高亮改由重渲染 svg 或事件委托统一处理。
 */
export function withRoomHitAreas(svg: string, plan: PlanStructure): string {
  if (plan.rooms.length === 0) {
    return svg;
  }
  const ins = 5;
  const hit = plan.rooms
    .map((room) => {
      const x = px(room.x) + ins;
      const y = px(room.y) + ins;
      const w = px(room.w) - ins * 2;
      const h = px(room.h) - ins * 2;
      if (w <= 0 || h <= 0) {
        return '';
      }
      return `<rect data-room-id="${escapeXml(room.id)}" x="${r1(x)}" y="${r1(y)}" width="${r1(w)}" height="${r1(h)}" fill="transparent"/>`;
    })
    .join('');
  return svg.replace('</svg>', `<g id="layer-hit-areas">${hit}</g></svg>`);
}

/** 供 UI 使用的类型守卫（房间对象判定） */
export function isPlanRoom(v: unknown): v is PlanRoom {
  return typeof v === 'object' && v !== null && typeof (v as PlanRoom).id === 'string';
}