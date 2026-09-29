/**
 * imageAccess 纯函数测试（G8 白名单语义与 backend G2 同构）：
 * toLocalPath 协议分流 / isInsideRoots 穿越防护 / sniffImageMime magic bytes / toDataUrl。
 */

import { describe, it, expect } from 'vitest';
import { isInsideRoots, sniffImageMime, toDataUrl, toLocalPath, IMAGE_MAX_BYTES } from './imageAccess';
import { resolve } from 'node:path';

describe('toLocalPath', () => {
  it('file:// → 本地路径；http/data → null（渲染层可直接显示不走兜底）', () => {
    expect(toLocalPath('file:///D:/data/sessions/images/img_1.png')).toBeTruthy();
    expect(toLocalPath('file:///D:/data/a.png')).toBe('D:\\data\\a.png');
    expect(toLocalPath('http://localhost:8080/a.png')).toBeNull();
    expect(toLocalPath('data:image/png;base64,AAAA')).toBeNull();
    expect(toLocalPath('file:///')).toBeNull(); // fileURLToPath 抛错 → null
    expect(toLocalPath('')).toBeNull();
  });
});

describe('isInsideRoots（穿越防护）', () => {
  const roots = ['D:\\data\\sessions\\images'];
  it('根内路径放行（含大小写规范化由 resolve 决定）', () => {
    expect(isInsideRoots('D:\\data\\sessions\\images\\img_1.png', roots, resolve)).toBe(true);
    expect(isInsideRoots('D:\\data\\sessions\\images\\sub\\img.png', roots, resolve)).toBe(true);
  });
  it('根外/穿越/盘符逃逸拒绝；空根拒绝', () => {
    expect(isInsideRoots('D:\\data\\sessions\\..\\..\\secrets.txt', roots, resolve)).toBe(false);
    expect(isInsideRoots('D:\\other\\img.png', roots, resolve)).toBe(false);
    expect(isInsideRoots('C:\\Windows\\system32\\x.png', roots, resolve)).toBe(false);
    // 前缀相似但非子目录（D:\data\sessions-images-evil）
    expect(isInsideRoots('D:\\data\\sessions-images-evil\\x.png', roots, resolve)).toBe(false);
    expect(isInsideRoots('D:\\data\\sessions\\images\\x.png', [], resolve)).toBe(false);
  });
});

describe('sniffImageMime', () => {
  it('png/jpeg/gif/webp magic bytes；未知/过短 → null（fail-closed）', () => {
    expect(sniffImageMime(new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0, 0, 0, 0, 0, 0, 0, 0]))).toBe('image/png');
    expect(sniffImageMime(new Uint8Array([0xff, 0xd8, 0xff, 0xe0, 0, 0, 0, 0, 0, 0, 0, 0]))).toBe('image/jpeg');
    expect(sniffImageMime(new Uint8Array([0x47, 0x49, 0x46, 0x38, 0, 0, 0, 0, 0, 0, 0, 0]))).toBe('image/gif');
    expect(sniffImageMime(new Uint8Array([0x52, 0x49, 0x46, 0x46, 0, 0, 0, 0, 0x57, 0x45, 0x42, 0x50]))).toBe('image/webp');
    expect(sniffImageMime(new Uint8Array([0x00, 0x01, 0x02, 0x03, 0, 0, 0, 0, 0, 0, 0, 0]))).toBeNull();
    expect(sniffImageMime(new Uint8Array([0x89]))).toBeNull();
    // 文本文件（如 jsonl 被当图像请求）→ null
    expect(sniffImageMime(new TextEncoder().encode('{"ts":"..."}'))).toBeNull();
  });
});

describe('toDataUrl', () => {
  it('base64 dataURL 编码', () => {
    const url = toDataUrl(new Uint8Array([1, 2, 3]), 'image/png');
    expect(url).toBe('data:image/png;base64,AQID');
  });
  it('大小上限常量 = 20MB', () => {
    expect(IMAGE_MAX_BYTES).toBe(20 * 1024 * 1024);
  });
});
