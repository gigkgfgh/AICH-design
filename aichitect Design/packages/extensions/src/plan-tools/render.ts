/**
 * render_plan_svg：PlanStructure → SVG（§5.3 冻结渲染规范）。
 *
 * 规范（契约冻结）：
 * - 坐标系 viewBox="0 0 W H"，单位 px；比例尺 scale = 50 px/m（可配置）；
 * - 图层顺序（SVG 文档顺序 = 视觉层叠）：墙体 → 房间 → 开口 → 标注 → 指北针；
 * - 样式：墙体 fill:#333，房间 fill:#eef，文字 font-family:sans-serif；
 * - 校验：渲染前 validatePlan 拦截（校验失败抛 PlanRenderError，由调用方走修正回环）。
 */

import type { PlanRoom, PlanStructure, PlanWall } from "@aichdesign/shared";
import { validatePlan } from "./validate.js";

/** 比例尺常量（§5.3：50 px/m）。 */
export const RENDER_SCALE = 50;

export interface RenderOptions {
  scale?: number;
  /** 标注尺寸字体大小（px）。 */
  annotationFontSize?: number;
  /** 空白边距（px，标注区）。 */
  padding?: number;
}

export class PlanRenderError extends Error {
  /** 校验错误明细（Node strip-types 直跑兼容：避免参数属性语法）。 */
  readonly errors: string[];

  constructor(errors: string[]) {
    super(`PlanStructure 校验失败，无法渲染：${errors.join("；")}`);
    this.name = "PlanRenderError";
    this.errors = errors;
  }
}

const fmt = (v: number): number => Math.round(v * 100) / 100;

/** 渲染后校验输入：失败抛 PlanRenderError；成功返回规范化 PlanStructure（供细节推断）。 */
function assertRenderable(input: unknown): PlanStructure {
  const result = validatePlan(input);
  if (!result.valid) throw new PlanRenderError(result.errors);
  const plan = input as PlanStructure;
  return {
    ...plan,
    bounds: { widthM: plan.bounds.widthM, heightM: plan.bounds.heightM },
    rooms: plan.rooms.map(roomNormalized),
    walls: plan.walls.map(wallNormalized),
    openings: (plan.openings ?? []).map((o) => o),
  };
}

const roomNormalized = (r: PlanRoom): PlanRoom => ({
  ...r,
  areaM2: r.areaM2 ?? Math.round(r.w * r.h * 100) / 100,
});

const wallNormalized = (w: PlanWall): PlanWall => ({
  ...w,
  thicknessMm: w.thicknessMm ?? 200,
});

/** 主入口：unknown 输入（服务端先校验），返回 SVG 字符串。 */
export function renderSvgPlan(input: unknown, options: RenderOptions = {}): string {
  const plan = assertRenderable(input);
  const scale = options.scale ?? RENDER_SCALE;
  const padding = options.padding ?? 28; // 顶部标注 + 底部/左右预留
  const W = plan.bounds.widthM * scale;
  const H = plan.bounds.heightM * scale;
  const viewW = W + padding * 2 + 14;
  const viewH = H + padding * 2 + 14; // 底部高度标注行

  const layers: string[] = [];
  layers.push(`<!-- layer: walls -->`);
  layers.push(...renderWalls(plan, scale));
  layers.push(`<!-- layer: rooms -->`);
  layers.push(...renderRooms(plan, scale));
  layers.push(`<!-- layer: openings -->`);
  layers.push(...renderOpenings(plan, scale));
  layers.push(`<!-- layer: annotations -->`);
  layers.push(...renderAnnotations(plan, scale));
  layers.push(`<!-- layer: compass -->`);
  layers.push(renderCompass(viewW - 20, 20));

  return [
    `<?xml version="1.0" encoding="UTF-8"?>`,
    `<svg xmlns="http://www.w3.org/2000/svg" width="${fmt(viewW)}" height="${fmt(viewH)}" viewBox="0 0 ${fmt(viewW)} ${fmt(viewH)}" font-family="sans-serif">`,
    ...layers,
    `</svg>`,
  ].join("\n");
}

/** 墙体图层：深色实线（fill:#333），线宽 = 厚度(毫米→米→px)。 */
function renderWalls(plan: PlanStructure, scale: number): string[] {
  return plan.walls.map((w) => {
    const width = Math.max(((w.thicknessMm ?? 200) / 1000) * scale, 2);
    return `<line id="${escapeId(w.id)}" x1="${fmt(w.x1 * scale)}" y1="${fmt(w.y1 * scale)}" x2="${fmt(w.x2 * scale)}" y2="${fmt(w.y2 * scale)}" stroke="#333" stroke-width="${fmt(width)}" stroke-linecap="round"/>`;
  });
}

/** 房间图层：浅色填充 + 名称 + 面积；文字垂直居中。 */
function renderRooms(plan: PlanStructure, scale: number): string[] {
  const out: string[] = [];
  for (const room of plan.rooms) {
    const x = room.x * scale;
    const y = room.y * scale;
    const w = room.w * scale;
    const h = room.h * scale;
    const cx = x + w / 2;
    const cy = y + h / 2;
    const fontSize = Math.min(12, Math.max(h * 0.5, 9));
    out.push(
      `<rect id="${escapeId(room.id)}" x="${fmt(x)}" y="${fmt(y)}" width="${fmt(w)}" height="${fmt(h)}" fill="#eef" stroke="#999" stroke-width="1"/>`,
      `<text x="${fmt(cx)}" y="${fmt(cy - 1)}" text-anchor="middle" font-size="${fmt(fontSize)}" fill="#333">${escapeXml(room.name)}</text>`,
      `<text x="${fmt(cx)}" y="${fmt(cy + fontSize)}" text-anchor="middle" font-size="${fmt(Math.max(fontSize - 2, 8))}" fill="#666">${fmt(room.areaM2 ?? room.w * room.h)} m²</text>`,
    );
  }
  return out;
}

/** 开口图层：门（门扇线 + 90° 门弧）与窗（双平行线）。 */
function renderOpenings(plan: PlanStructure, scale: number): string[] {
  const out: string[] = [];
  for (const opening of plan.openings ?? []) {
    const wall = plan.walls.find((w) => w.id === opening.wallId);
    if (!wall) continue;
    const len = Math.hypot(wall.x2 - wall.x1, wall.y2 - wall.y1);
    if (len === 0) continue;
    const widthM = opening.widthM ?? 0.9;
    const offsetM = opening.offsetM ?? (len - widthM) / 2;
    const ux = (wall.x2 - wall.x1) / len;
    const uy = (wall.y2 - wall.y1) / len;
    // 开口中心（米）→ px。
    const cxM = wall.x1 + ux * (offsetM + widthM / 2);
    const cyM = wall.y1 + uy * (offsetM + widthM / 2);
    const cx = cxM * scale;
    const cy = cyM * scale;
    const radius = (widthM / 2) * scale;

    if (opening.kind === "window") {
      // 窗：墙法向的双平行蓝色条带（fill 矩形；测试冻结样式 fill="#4a90d9"）。
      const bandH = 3;
      const left = cx - radius;
      const width = radius * 2;
      out.push(
        `<rect x="${fmt(left)}" y="${fmt(cy - bandH)}" width="${fmt(width)}" height="${fmt(bandH)}" fill="#4a90d9"/>`,
        `<rect x="${fmt(left)}" y="${fmt(cy)}" width="${fmt(width)}" height="${fmt(bandH)}" fill="#4a90d9"/>`,
      );
    } else {
      // 门：垂直于墙的门扇线 + 90° 圆弧（铰接在侧边）。
      const nx = -uy;
      const ny = ux;
      const px = cx - radius * ux;
      const py = cy - radius * uy;
      out.push(
        `<line x1="${fmt(px)}" y1="${fmt(py)}" x2="${fmt(px + radius * nx)}" y2="${fmt(py + radius * ny)}" stroke="#333" stroke-width="1.5"/>`,
        `<path d="M ${fmt(px)} ${fmt(py)} A ${fmt(radius)} ${fmt(radius)} 0 0 1 ${fmt(px + radius * nx)} ${fmt(py + radius * ny)}" fill="none" stroke="#333" stroke-width="1"/>`,
      );
    }
  }
  return out;
}

/** 标注图层：总宽（顶部轴线）、总高（右侧轴线）+ 数值。 */
function renderAnnotations(plan: PlanStructure, scale: number): string[] {
  const W = plan.bounds.widthM * scale;
  const H = plan.bounds.heightM * scale;
  const pad = 28;
  const topY = pad - 10;
  const rightX = pad + W + 10;
  const tag = (text: string, x: number, y: number, anchor: "middle" | "start" | "end"): string =>
    `<text x="${fmt(x)}" y="${fmt(y)}" text-anchor="${anchor}" font-size="10" fill="#666">${text}</text>`;
  return [
    // 顶部尺寸线（宽度）。
    `<line x1="${fmt(pad)}" y1="${fmt(topY)}" x2="${fmt(pad + W)}" y2="${fmt(topY)}" stroke="#999" stroke-width="1" stroke-dasharray="3 3"/>`,
    `<line x1="${fmt(pad)}" y1="${fmt(topY - 4)}" x2="${fmt(pad)}" y2="${fmt(topY + 4)}" stroke="#999" stroke-width="1"/>`,
    `<line x1="${fmt(pad + W)}" y1="${fmt(topY - 4)}" x2="${fmt(pad + W)}" y2="${fmt(topY + 4)}" stroke="#999" stroke-width="1"/>`,
    tag(`${plan.bounds.widthM} m`, pad + W / 2, topY - 4, "middle"),
    // 右侧尺寸线（高度）。
    `<line x1="${fmt(rightX)}" y1="${fmt(pad)}" x2="${fmt(rightX)}" y2="${fmt(pad + H)}" stroke="#999" stroke-width="1" stroke-dasharray="3 3"/>`,
    `<line x1="${fmt(rightX - 4)}" y1="${fmt(pad)}" x2="${fmt(rightX + 4)}" y2="${fmt(pad)}" stroke="#999" stroke-width="1"/>`,
    `<line x1="${fmt(rightX - 4)}" y1="${fmt(pad + H)}" x2="${fmt(rightX + 4)}" y2="${fmt(pad + H)}" stroke="#999" stroke-width="1"/>`,
    tag(`${plan.bounds.heightM} m`, rightX + 6, pad + H / 2, "middle"),
  ];
}

/** 指北针：右上角圆 + 北箭头。 */
function renderCompass(cx: number, cy: number): string {
  return [
    `<g transform="translate(${fmt(cx)} ${fmt(cy)})">`,
    `<circle r="12" fill="#fff" stroke="#999" stroke-width="1"/>`,
    `<path d="M 0 -8 L 4 6 L 0 3 L -4 6 Z" fill="#c0392b"/>`,
    `<text y="-15" text-anchor="middle" font-size="9" fill="#666">N</text>`,
    `</g>`,
  ].join("");
}

/** XML 转义（房间名可能含用户文本）。 */
function escapeXml(text: string): string {
  return text
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&apos;");
}

function escapeId(id: string): string {
  return escapeXml(id);
}