/**
 * P014 SVG → PNG 栅格化（渲染进程 Chromium canvas；浏览器直开兼容）
 *
 * 冻结签名（R2 契约 §7.5）：
 *   svgToPngDataUrl(svg: string, opts?: { scale?: number; background?: string }): Promise<string>
 *
 * 设计要点：
 * - 纯函数核心 `drawImageToPngDataUrl`：输入已加载的 Image-like + canvas-like，不依赖真实 DOM，vitest 传 mock 可测
 * - 装配函数 `svgToPngDataUrl`：SVG 字符串 → Image 加载（blob URL 优先，data URL 兜底）→ 绘制 → PNG dataURL
 * - 注入式依赖（可选第三个参数 deps）：测试环境传 mock canvas / mock image / mock toDataURL，
 *   生产环境（Electron 渲染进程 / 浏览器）用默认实现（document / new Image / URL.createObjectURL）
 * - XML 命名空间兜底：SVG 字符串缺 xmlns 时补充（防止部分浏览器以旧版命名空间缩放异常）
 * - scale 默认 2（2x 细腻度）；background 默认 '#ffffff'；'transparent' 时清空画布底色（输出透明 PNG）
 */
export interface SvgToPngOptions {
  /** 输出倍率（相对 SVG 自然尺寸），默认 2；非法值（<=0 / NaN）回退 2 */
  scale?: number;
  /** 背景色，默认 '#ffffff'（白色）；传 'transparent' 输出透明底 */
  background?: string;
}

/** canvas-like 最小形状（真实 HTMLCanvasElement 与之结构兼容；mock 亦实现） */
export interface CanvasLike {
  width: number;
  height: number;
  getContext(contextId: string): CanvasContextLike | null;
  toDataURL(type?: string): string;
}

/** 2D 上下文最小形状（真实 CanvasRenderingContext2D 结构兼容） */
export interface CanvasContextLike {
  fillStyle: string | CanvasGradient | CanvasPattern;
  clearRect(x: number, y: number, w: number, h: number): void;
  fillRect(x: number, y: number, w: number, h: number): void;
  drawImage(image: CanvasImageSource, dx: number, dy: number, dw: number, dh: number): void;
}

/** image-like 最小形状（真实 HTMLImageElement 结构兼容；mock 亦实现） */
export interface ImageLike {
  naturalWidth: number;
  naturalHeight: number;
  src: string;
  onload: (() => void) | null;
  onerror: ((ev: unknown) => void) | null;
}

/** 注入式依赖（测试传 mock；生产省略使用默认实现） */
export interface SvgToPngDeps {
  /** 创建 canvas（默认 document.createElement('canvas')） */
  canvasFactory?: () => CanvasLike;
  /** 创建 Image（默认 new Image()） */
  imageFactory?: () => ImageLike;
  /** SVG 字符串 → 可加载的 src（默认 blob URL，降级 data URL） */
  createSvgSrc?: (svg: string) => string;
  /** 释放 src 资源（默认 revokeObjectURL；data URL 无需释放） */
  revokeSvgSrc?: (src: string) => void;
  /** 取 PNG dataURL（默认 canvas.toDataURL('image/png')） */
  toPngDataUrl?: (canvas: CanvasLike) => string;
}

/** 默认 canvas 工厂（渲染进程/浏览器环境；测试注入 mock 不使用） */
export function defaultCanvasFactory(): CanvasLike {
  return document.createElement('canvas') as unknown as CanvasLike;
}

/** 默认 Image 工厂（渲染进程/浏览器环境；测试注入 mock 不使用） */
export function defaultImageFactory(): ImageLike {
  return new Image() as unknown as ImageLike;
}

/** 默认 PNG 读取器 */
export function defaultToPngDataUrl(canvas: CanvasLike): string {
  return canvas.toDataURL('image/png');
}

/** 默认 src 释放：仅 blob URL 需要 revoke */
export function defaultRevokeSvgSrc(src: string): void {
  if (src.startsWith('blob:') && typeof URL !== 'undefined' && typeof URL.revokeObjectURL === 'function') {
    URL.revokeObjectURL(src);
  }
}

/** XML 命名空间兜底：缺 xmlns 时补充（防老版本命名空间导致的 CSS/缩放异常） */
export function ensureSvgNamespace(svg: string): string {
  if (/<svg[^>]*\bxmlns\s*=/i.test(svg)) {
    return svg;
  }
  return svg.replace(/<svg/i, '<svg xmlns="http://www.w3.org/2000/svg"');
}

/**
 * 默认 SVG → src：优先 blob URL（内存友好、无 data URL 长度上限），
 * 环境不支持时降级 data URL（encodeURIComponent 转义，含 xmlns 规范）。
 */
export function defaultCreateSvgSrc(svg: string): string {
  const normalized = ensureSvgNamespace(svg);
  if (
    typeof Blob !== 'undefined' &&
    typeof URL !== 'undefined' &&
    typeof URL.createObjectURL === 'function'
  ) {
    const blob = new Blob([normalized], { type: 'image/svg+xml;charset=utf-8' });
    return URL.createObjectURL(blob);
  }
  return `data:image/svg+xml;charset=utf-8,${encodeURIComponent(normalized)}`;
}

/** 从 SVG 字符串解析自然尺寸（单位 px；renderPlanSvg 输出含 viewBox，兜底解析 width/height 属性） */
export function parseSvgSize(svg: string): { width: number; height: number } | null {
  const viewBox = svg.match(/viewBox\s*=\s*["']0\s+0\s+([\d.]+)\s+([\d.]+)["']/i);
  if (viewBox) {
    const width = Number(viewBox[1]);
    const height = Number(viewBox[2]);
    if (isFinite(width) && isFinite(height) && width > 0 && height > 0) {
      return { width, height };
    }
  }
  const widthAttr = svg.match(/<svg[^>]*\bwidth\s*=\s*["']([\d.]+)["']/i);
  const heightAttr = svg.match(/<svg[^>]*\bheight\s*=\s*["']([\d.]+)["']/i);
  if (widthAttr && heightAttr) {
    const width = Number(widthAttr[1]);
    const height = Number(heightAttr[1]);
    if (isFinite(width) && isFinite(height) && width > 0 && height > 0) {
      return { width, height };
    }
  }
  return null;
}

/** 加载 Image-like（src 设置后触发 onload/onerror；两个回调置空防泄漏） */
export function loadImageLike(imageFactory: () => ImageLike, src: string): Promise<ImageLike> {
  return new Promise((resolve, reject) => {
    const img = imageFactory();
    const cleanup = (): void => {
      img.onload = null;
      img.onerror = null;
    };
    img.onload = () => {
      cleanup();
      resolve(img);
    };
    img.onerror = () => {
      cleanup();
      reject(new Error('SVG 栅格化失败：图片加载失败'));
    };
    img.src = src;
  });
}

/**
 * 纯函数核心（可脱离真实 DOM 测试）：Image-like + canvas-like → PNG dataURL。
 *
 * 调用链：检查尺寸 → 画布定尺（naturalSize × scale）→ 底色（透明清空 / 白底填充）→ drawImage → toDataURL。
 */
export function drawImageToPngDataUrl(
  img: ImageLike,
  canvas: CanvasLike,
  opts: { scale: number; background: string },
  toPngDataUrl: (canvas: CanvasLike) => string
): string {
  const scale = isFinite(opts.scale) && opts.scale > 0 ? opts.scale : 2;
  const sw = img.naturalWidth;
  const sh = img.naturalHeight;
  if (!isFinite(sw) || !isFinite(sh) || sw <= 0 || sh <= 0) {
    throw new Error('SVG 栅格化失败：图像尺寸无效');
  }
  const outWidth = Math.round(sw * scale);
  const outHeight = Math.round(sh * scale);

  canvas.width = outWidth;
  canvas.height = outHeight;
  const ctx = canvas.getContext('2d');
  if (!ctx) {
    throw new Error('SVG 栅格化失败：无法获取 2D 上下文');
  }

  if (opts.background === 'transparent') {
    ctx.clearRect(0, 0, outWidth, outHeight);
  } else {
    ctx.fillStyle = opts.background;
    ctx.fillRect(0, 0, outWidth, outHeight);
  }
  ctx.drawImage(img as unknown as CanvasImageSource, 0, 0, outWidth, outHeight);

  return toPngDataUrl(canvas);
}

/**
 * P014 主入口（冻结签名）：SVG 字符串 → PNG dataURL。
 *
 * opts.scale 默认 2；opts.background 默认 '#ffffff'（'transparent' → 透明底）。
 * deps 为注入式依赖（测试用 mock；生产省略）。
 */
export async function svgToPngDataUrl(
  svg: string,
  opts?: SvgToPngOptions,
  deps?: SvgToPngDeps
): Promise<string> {
  const {
    canvasFactory = defaultCanvasFactory,
    imageFactory = defaultImageFactory,
    createSvgSrc = defaultCreateSvgSrc,
    revokeSvgSrc = defaultRevokeSvgSrc,
    toPngDataUrl = defaultToPngDataUrl,
  } = deps ?? {};

  const { scale = 2, background = '#ffffff' } = opts ?? {};
  const safeScale = isFinite(scale) && scale > 0 ? scale : 2;

  const src = createSvgSrc(svg);
  try {
    const img = await loadImageLike(imageFactory, src);
    return drawImageToPngDataUrl(img, canvasFactory(), { scale: safeScale, background }, toPngDataUrl);
  } finally {
    revokeSvgSrc(src);
  }
}