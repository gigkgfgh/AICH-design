/**
 * P013 mock 图像生成（确定性、离线可用）
 *
 * 用途：P012 image-tools 契约未就绪前的本地 mock 先行路径（TODO-API-STUB），
 * 以 canvas 绘制「带 prompt 文本的渐变/参考图叠加」dataURL，供 ImageGallery /
 * 图像版本树演示「方案 → 表现图 → 回退」闭环。
 *
 * 设计要点：
 * - 确定性：同 prompt → 同种子 → 同配色/装饰布局（可测试、可复现）
 * - canvas 注入式：复用 svgToPng 同款 CanvasLike 能力，测试传 mock canvas
 * - 参考图语义（B-3）：传入 refDataUrl（当前 plan 的 PNG dataURL）时先绘制为底图，
 *   再叠加半透明渐变与 prompt 文本 —— 模拟「平面 → 表现图」联动
 * - P012 契约就绪后切换：App 走网关 SSE done.image（见 App.tsx runImageRequest），本模块仅 mock 期使用
 */
import type { CanvasContextLike, CanvasLike, ImageLike } from './svgToPng';
import { loadImageLike } from './svgToPng';

export interface MockImageOptions {
  /** 输出宽（px），默认 1024（gpt-image-2 默认 size） */
  width?: number;
  /** 输出高（px），默认 1024 */
  height?: number;
  /** 参考图 dataURL（当前 plan PNG；B-3 语义），可为空 */
  refDataUrl?: string | null;
  /** 注入式 canvas 工厂（测试传 mock；生产默认 document.createElement） */
  canvasFactory?: () => CanvasLike;
  /** 注入式 PNG 读取器（默认 canvas.toDataURL('image/png')） */
  toPngDataUrl?: (canvas: CanvasLike) => string;
  /** 注入式图片加载器（参考图 dataURL → Image-like；测试传 mock） */
  loadImage?: (src: string) => Promise<ImageLike>;
  /** 注入式图片工厂（参考图加载用） */
  imageFactory?: () => ImageLike;
}

/** FNV-1a 32bit 哈希：prompt → 确定性种子 */
function hashString(s: string): number {
  let h = 2166136261 >>> 0;
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  return h >>> 0;
}

/** 确定性伪随机（mulberry32）：同种子 → 同序列 */
function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a |= 0;
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const PALETTES: Array<[string, string]> = [
  ['#e8f1fd', '#1d5fb2'],
  ['#fdf1e4', '#b85c1d'],
  ['#eaf8ef', '#2d7d3a'],
  ['#f6e8fb', '#8b3fb8'],
  ['#e8f7f9', '#1d7f8f'],
  ['#fdeeee', '#c0392b'],
];

/** 按目标长度截断文本（中文友好：中文按 2 个半角计宽） */
function ellipsize(text: string, maxLen: number): string {
  let width = 0;
  let out = '';
  for (const ch of text) {
    width += ch.charCodeAt(0) > 255 ? 2 : 1;
    if (width > maxLen) {
      break;
    }
    out += ch;
  }
  return out.length < text.length ? `${out}…` : out;
}

/** mock 图像绘制所需的最小 2D 上下文（真实 CanvasRenderingContext2D 亦满足） */
interface MockCtx extends CanvasContextLike {
  font: string;
  textAlign: string;
  fillText(text: string, x: number, y: number): void;
  createLinearGradient(x0: number, y0: number, x1: number, y1: number): {
    addColorStop(offset: number, color: string): void;
  };
}

function fallbackCanvasFactory(): CanvasLike {
  return document.createElement('canvas') as unknown as CanvasLike;
}

function fallbackImageFactory(): ImageLike {
  return new Image() as unknown as ImageLike;
}

/**
 * 生成确定性 mock 表现图 dataURL（P013 mock 先行）。
 *
 * 布局：参考图（可选）为底 → 确定性渐变/装饰 → 顶部 prompt 文本。
 * 同 prompt（同 refDataUrl）生成结果逐像素确定（装饰布局由种子决定）。
 */
export async function generateMockImageDataUrl(
  prompt: string,
  opts: MockImageOptions = {}
): Promise<string> {
  const width = opts.width ?? 1024;
  const height = opts.height ?? 1024;
  const canvasFactory = opts.canvasFactory ?? fallbackCanvasFactory;
  const toPngDataUrl = opts.toPngDataUrl ?? ((c: CanvasLike) => c.toDataURL('image/png'));

  const canvas = canvasFactory();
  canvas.width = width;
  canvas.height = height;
  const ctx = canvas.getContext('2d') as MockCtx | null;
  if (!ctx) {
    throw new Error('mock 图像生成失败：无法获取 2D 上下文');
  }

  const seed = hashString(prompt || '表现图');
  const rand = mulberry32(seed);
  const [light, dark] = PALETTES[seed % PALETTES.length];

  // 参考图（B-3：当前 plan PNG）→ 绘制为底图
  if (opts.refDataUrl) {
    try {
      const loadImage = opts.loadImage ?? ((src: string) => loadImageLike(opts.imageFactory ?? fallbackImageFactory, src));
      const ref = await loadImage(opts.refDataUrl);
      ctx.drawImage(ref as unknown as CanvasImageSource, 0, 0, width, height);
      // 半透明渐变遮罩：保留底图轮廓，同时统一表现图调性
      const veil = ctx.createLinearGradient(0, 0, width, height);
      veil.addColorStop(0, 'rgba(255,255,255,0.16)');
      veil.addColorStop(1, 'rgba(255,255,255,0)');
      ctx.fillStyle = veil;
      ctx.fillRect(0, 0, width, height);
    } catch {
      // 参考图加载失败不阻塞：降级纯渐变底图
      const fallback = ctx.createLinearGradient(0, 0, width, height);
      fallback.addColorStop(0, light);
      fallback.addColorStop(1, dark);
      ctx.fillStyle = fallback;
      ctx.fillRect(0, 0, width, height);
    }
  } else {
    const gradient = ctx.createLinearGradient(0, 0, width, height);
    gradient.addColorStop(0, light);
    gradient.addColorStop(1, dark);
    ctx.fillStyle = gradient;
    ctx.fillRect(0, 0, width, height);
  }

  // 确定性装饰：半透明白色矩形块（模拟家具/隔断布局，同 prompt 复现）
  ctx.fillStyle = 'rgba(255,255,255,0.42)';
  const blockCount = 5 + (seed % 4);
  for (let i = 0; i < blockCount; i++) {
    const bx = Math.round(width * (0.08 + rand() * 0.6));
    const by = Math.round(height * (0.18 + rand() * 0.6));
    const bw = Math.round(width * (0.06 + rand() * 0.12));
    const bh = Math.round(height * (0.05 + rand() * 0.1));
    ctx.fillRect(bx, by, bw, bh);
  }
  // 细线分隔（模拟墙面）
  ctx.fillStyle = 'rgba(255,255,255,0.28)';
  for (let i = 0; i < 2; i++) {
    const lx = Math.round(width * (0.2 + rand() * 0.5));
    ctx.fillRect(lx, Math.round(height * 0.12), 3, Math.round(height * 0.7));
  }

  // prompt 文本（顶部，多行截断）
  const fontSize = Math.round(width * 0.032);
  ctx.fillStyle = 'rgba(15,23,42,0.86)';
  ctx.font = `600 ${fontSize}px system-ui, 'Microsoft YaHei', sans-serif`;
  ctx.textAlign = 'left';
  const maxChars = Math.max(8, Math.floor((width * 0.8) / (fontSize * 0.9)));
  const firstLine = ellipsize(prompt || '室内表现图', maxChars);
  const secondLine = ellipsize('AICH Design · 表现图预览', maxChars);
  ctx.fillText(firstLine, Math.round(width * 0.08), Math.round(height * 0.1));
  ctx.font = `400 ${Math.round(fontSize * 0.72)}px system-ui, 'Microsoft YaHei', sans-serif`;
  ctx.fillText(secondLine, Math.round(width * 0.08), Math.round(height * 0.1 + fontSize * 1.5));

  return toPngDataUrl(canvas);
}