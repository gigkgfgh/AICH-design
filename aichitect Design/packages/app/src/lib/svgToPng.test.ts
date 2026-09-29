/**
 * P014 svgToPng 核心逻辑测试（vitest，注入式 mock canvas / mock image，无真实 DOM）
 *
 * 运行：npm.cmd run test -w @aichdesign/app
 */
import { describe, expect, it } from 'vitest';
import {
  drawImageToPngDataUrl,
  ensureSvgNamespace,
  parseSvgSize,
  svgToPngDataUrl,
  type CanvasContextLike,
  type CanvasLike,
  type ImageLike,
} from './svgToPng';

interface MockCanvas extends CanvasLike {
  log: string[];
}

/** mock canvas：记录 width/height/绘制调用，toDataURL 返回固定值（可注入断言） */
function makeMockCanvas(): MockCanvas {
  const log: string[] = [];
  const ctx: CanvasContextLike = {
    fillStyle: '',
    clearRect: (x, y, w, h) => {
      log.push(`clearRect:${x},${y},${w},${h}`);
    },
    fillRect: (x, y, w, h) => {
      log.push(`fillRect:${x},${y},${w},${h}`);
    },
    drawImage: (_img, dx, dy, dw, dh) => {
      log.push(`drawImage:${dx},${dy},${dw},${dh}`);
    },
  };
  const canvas: MockCanvas = {
    width: 0,
    height: 0,
    log,
    getContext: () => ctx,
    toDataURL: (type) => {
      log.push(`toDataURL:${type ?? 'image/png'}`);
      return 'data:image/png;base64,mockpng';
    },
  };
  return canvas;
}

/**
 * mock image：src 赋值后触发 onload（可配置 onerror 模拟加载失败）。
 * 通过 getter/setter 实现 ImageLike.src / onload / onerror。
 */
function makeMockImage(width: number, height: number, fail = false): ImageLike {
  let src = '';
  let onload: (() => void) | null = null;
  let onerror: ((ev: unknown) => void) | null = null;
  const img: ImageLike = {
    naturalWidth: width,
    naturalHeight: height,
    get src() {
      return src;
    },
    set src(v: string) {
      src = v;
      queueMicrotask(() => {
        if (fail) {
          onerror?.('mock load error');
        } else {
          onload?.();
        }
      });
    },
    get onload() {
      return onload;
    },
    set onload(v) {
      onload = v;
    },
    get onerror() {
      return onerror;
    },
    set onerror(v) {
      onerror = v;
    },
  };
  return img;
}

/** 装配依赖：全部注入 mock（测试不触碰真实 DOM / blob） */
function deps(canvas: CanvasLike, img: ImageLike) {
  return {
    canvasFactory: () => canvas,
    imageFactory: () => img,
    createSvgSrc: (svg: string) => `data:image/svg+xml,${svg}`,
    revokeSvgSrc: () => undefined,
    toPngDataUrl: (c: CanvasLike) => c.toDataURL('image/png'),
  };
}

const SVG = '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 400 300"></svg>';

describe('svgToPngDataUrl（P014 装配）', () => {
  it('默认 scale=2：输出 2x 尺寸并填充白色背景', async () => {
    const canvas = makeMockCanvas();
    const img = makeMockImage(400, 300);
    const out = await svgToPngDataUrl(SVG, undefined, deps(canvas, img));
    expect(out).toBe('data:image/png;base64,mockpng');
    expect(canvas.width).toBe(800);
    expect(canvas.height).toBe(600);
    expect(canvas.log).toContain('fillRect:0,0,800,600');
    expect(canvas.log).toContain('drawImage:0,0,800,600');
  });

  it('scale=3 + 自定义背景色', async () => {
    const canvas = makeMockCanvas();
    const img = makeMockImage(400, 300);
    await svgToPngDataUrl(SVG, { scale: 3, background: '#abcdef' }, deps(canvas, img));
    expect(canvas.width).toBe(1200);
    expect(canvas.height).toBe(900);
    expect(canvas.log).toContain('fillRect:0,0,1200,900');
  });

  it('background=transparent：清空画布且不打底色', async () => {
    const canvas = makeMockCanvas();
    const img = makeMockImage(400, 300);
    await svgToPngDataUrl(SVG, { scale: 1, background: 'transparent' }, deps(canvas, img));
    expect(canvas.width).toBe(400);
    expect(canvas.height).toBe(300);
    expect(canvas.log).toContain('clearRect:0,0,400,300');
    expect(canvas.log.some((l) => l.startsWith('fillRect'))).toBe(false);
  });

  it('非法 scale（<=0 / NaN）回退默认 2', async () => {
    for (const bad of [0, -1, Number.NaN]) {
      const canvas = makeMockCanvas();
      const img = makeMockImage(100, 100);
      await svgToPngDataUrl(SVG, { scale: bad }, deps(canvas, img));
      expect(canvas.width).toBe(200);
      expect(canvas.height).toBe(200);
    }
  });

  it('图片加载失败 → reject 且不产出 dataURL', async () => {
    const canvas = makeMockCanvas();
    const img = makeMockImage(400, 300, true);
    await expect(svgToPngDataUrl(SVG, undefined, deps(canvas, img))).rejects.toThrow('SVG 栅格化失败');
    expect(canvas.log.some((l) => l.startsWith('toDataURL'))).toBe(false);
  });
});

describe('drawImageToPngDataUrl（同步纯函数核心）', () => {
  it('图像尺寸无效 → 抛错', () => {
    const canvas = makeMockCanvas();
    const img = makeMockImage(0, 0);
    expect(() =>
      drawImageToPngDataUrl(img, canvas, { scale: 2, background: '#ffffff' }, (c) => c.toDataURL())
    ).toThrow('尺寸无效');
  });

  it('输出尺寸 = naturalSize × scale，dataURL 由注入函数产出', () => {
    const canvas = makeMockCanvas();
    const img = makeMockImage(100, 50);
    const out = drawImageToPngDataUrl(
      img,
      canvas,
      { scale: 4, background: 'transparent' },
      () => 'data:image/png;base64,x'
    );
    expect(out).toBe('data:image/png;base64,x');
    expect(canvas.width).toBe(400);
    expect(canvas.height).toBe(200);
  });
});

describe('parseSvgSize', () => {
  it('优先解析 viewBox', () => {
    expect(parseSvgSize('<svg viewBox="0 0 500 400"></svg>')).toEqual({ width: 500, height: 400 });
  });

  it('无 viewBox 时解析 width/height 属性', () => {
    expect(parseSvgSize('<svg width="100" height="80"></svg>')).toEqual({ width: 100, height: 80 });
  });

  it('无法解析 → null', () => {
    expect(parseSvgSize('<svg></svg>')).toBeNull();
    expect(parseSvgSize('not svg')).toBeNull();
  });
});

describe('ensureSvgNamespace', () => {
  it('缺 xmlns 时补充命名空间', () => {
    const out = ensureSvgNamespace('<svg viewBox="0 0 1 1"></svg>');
    expect(out).toContain('xmlns="http://www.w3.org/2000/svg"');
  });

  it('已有 xmlns 不重复插入', () => {
    const svg = '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 1 1"></svg>';
    expect(ensureSvgNamespace(svg)).toBe(svg);
  });
});