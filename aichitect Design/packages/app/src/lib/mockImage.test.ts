/**
 * P013 mock 图像生成测试（vitest，注入式 mock canvas，无真实 DOM）
 *
 * 覆盖：确定性（同 prompt 同绘制记录）、prompt 差异产生不同种子、参考图底图叠加。
 */
import { describe, expect, it } from 'vitest';
import { generateMockImageDataUrl } from './mockImage';
import type { CanvasContextLike, CanvasLike, ImageLike } from './mockImage';

interface MockCanvas extends CanvasLike {
  log: string[];
}

/** mock canvas：支持 mockImage 所需方法（gradient / fillText / drawImage）并记录调用 */
function makeMockCanvas(): MockCanvas {
  const log: string[] = [];
  const gradient = {
    addColorStop: (offset: number, color: string) => {
      log.push(`addColorStop:${offset}:${color}`);
    },
  };
  const ctx = {
    fillStyle: '#000',
    font: '',
    textAlign: 'left',
    clearRect: () => undefined,
    fillRect: (x: number, y: number, w: number, h: number) => {
      log.push(`fillRect:${x},${y},${w},${h}`);
    },
    drawImage: () => {
      log.push('drawImage');
    },
    createLinearGradient: () => gradient,
    fillText: (text: string, x: number) => {
      log.push(`fillText:${text}:${x}`);
    },
  };
  const canvas: MockCanvas = {
    width: 0,
    height: 0,
    log,
    getContext: () => ctx as unknown as CanvasContextLike,
    toDataURL: (type?: string) => {
      log.push(`toDataURL:${type ?? 'image/png'}`);
      return 'data:image/png;base64,mock';
    },
  };
  return canvas;
}

function options(canvas: MockCanvas) {
  return {
    canvasFactory: () => canvas,
    toPngDataUrl: (c: CanvasLike) => c.toDataURL('image/png'),
  };
}

describe('generateMockImageDataUrl（P013 mock 生成）', () => {
  it('确定性：同 prompt 两次生成绘制记录一致，输出 dataURL', async () => {
    const a = makeMockCanvas();
    const b = makeMockCanvas();
    const ra = await generateMockImageDataUrl('客厅现代简约', { width: 512, height: 512, ...options(a) });
    await generateMockImageDataUrl('客厅现代简约', { width: 512, height: 512, ...options(b) });
    expect(ra).toBe('data:image/png;base64,mock');
    expect(a.width).toBe(512);
    expect(a.height).toBe(512);
    expect(a.log).toEqual(b.log);
  });

  it('不同 prompt 产生不同种子（绘制记录不同）', async () => {
    const a = makeMockCanvas();
    const b = makeMockCanvas();
    await generateMockImageDataUrl('客厅', { width: 512, height: 512, ...options(a) });
    await generateMockImageDataUrl('厨房', { width: 512, height: 512, ...options(b) });
    expect(a.log).not.toEqual(b.log);
  });

  it('含参考图：先绘制参考图（drawImage），再叠加渐变遮罩与文本', async () => {
    const c = makeMockCanvas();
    const loadImage = async (src: string): Promise<ImageLike> => ({
      naturalWidth: 100,
      naturalHeight: 100,
      src,
      onload: null,
      onerror: null,
    });
    const imageFactory = (): ImageLike => ({
      naturalWidth: 100,
      naturalHeight: 100,
      src: '',
      onload: null,
      onerror: null,
    });
    const out = await generateMockImageDataUrl('参考图表现', {
      width: 512,
      height: 512,
      refDataUrl: 'data:image/png;base64,abc',
      loadImage,
      imageFactory,
      ...options(c),
    });
    expect(out).toBe('data:image/png;base64,mock');
    expect(c.log).toContain('drawImage');
    // 绘制序列：drawImage 在首次 fillRect 之前（先底图后遮罩）
    const firstFill = c.log.findIndex((l) => l.startsWith('fillRect'));
    const drawIdx = c.log.findIndex((l) => l === 'drawImage');
    expect(drawIdx).toBeLessThan(firstFill);
    expect(c.log.some((l) => l.startsWith('fillText'))).toBe(true);
  });

  it('空 prompt 也能生成（回退默认标题）', async () => {
    const c = makeMockCanvas();
    await generateMockImageDataUrl('', { width: 512, height: 512, ...options(c) });
    expect(c.log.some((l) => l.startsWith('fillText'))).toBe(true);
    expect(c.log.some((l) => l.startsWith('toDataURL'))).toBe(true);
  });
});