/**
 * 图像访问纯函数（G8 修复 + 主进程图像兜底读取的白名单层）。
 *
 * 安全语义与 backend G2（image-api.bytesFromUri 白名单）同构：
 * - 仅允许白名单根目录内的本地文件（防 ../ 穿越与绝对路径逃逸）；
 * - magic bytes 嗅探 mime（不信任扩展名/URL 声明）；
 * - 大小上限由调用方校验（默认 20MB）；
 * - fail-closed：任何无法判定的输入一律拒绝。
 */

import { sep } from 'node:path';
import { fileURLToPath } from 'node:url';

/** 图像大小上限（20MB；与图像产物量级匹配，防内存放大）。 */
export const IMAGE_MAX_BYTES = 20 * 1024 * 1024;

/** file:// URL 或本地路径 → 绝对规范化路径（非法 URL 抛错由调用方拒绝）。 */
export function toLocalPath(uri: string): string | null {
  if (uri.startsWith('file://')) {
    try {
      return fileURLToPath(uri);
    } catch {
      return null;
    }
  }
  if (uri.startsWith('http://') || uri.startsWith('https://') || uri.startsWith('data:')) {
    return null; // 非本地路径不走本兜底（http/data 渲染层可直接显示）
  }
  return uri.length > 0 ? uri : null;
}

/** 白名单判定：path 必须位于某个根目录内（含根本身；防穿越后判定）。 */
export function isInsideRoots(path: string, roots: readonly string[], pathResolve: (p: string) => string): boolean {
  if (roots.length === 0) return false;
  const resolved = pathResolve(path);
  return roots.some((root) => {
    const base = pathResolve(root);
    return resolved === base || resolved.startsWith(base + sep);
  });
}

/** magic bytes 嗅探（png/jpeg/webp/gif；无法识别返回 null → fail-closed）。 */
export function sniffImageMime(bytes: Uint8Array): 'image/png' | 'image/jpeg' | 'image/webp' | 'image/gif' | null {
  if (bytes.length < 12) return null;
  if (bytes[0] === 0x89 && bytes[1] === 0x50 && bytes[2] === 0x4e && bytes[3] === 0x47) return 'image/png';
  if (bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff) return 'image/jpeg';
  if (bytes[0] === 0x47 && bytes[1] === 0x49 && bytes[2] === 0x46) return 'image/gif';
  // RIFF....WEBP
  if (
    bytes[0] === 0x52 && bytes[1] === 0x49 && bytes[2] === 0x46 && bytes[3] === 0x46 &&
    bytes[8] === 0x57 && bytes[9] === 0x45 && bytes[10] === 0x42 && bytes[11] === 0x50
  ) {
    return 'image/webp';
  }
  return null;
}

/** 字节 → dataURL（Node Buffer base64）。 */
export function toDataUrl(bytes: Uint8Array, mime: string): string {
  return `data:${mime};base64,${Buffer.from(bytes).toString('base64')}`;
}
