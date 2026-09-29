/**
 * 图像字节探测（P012）：从 dataURL / 原始字节解析 PNG / JPEG / WebP 尺寸与通道信息。
 *
 * 用途（§6.2 gpt-image-2 约束内建）：
 * - edits「mask 同尺寸 alpha PNG」校验：mask 与参考图尺寸一致 + alpha 通道检测；
 * - 尺寸/像素约束核验（宽、高、16 的倍数、宽高比、像素范围）。
 *
 * 实现要点：
 * - 纯函数、零 Node fs 依赖（dataURL 解码用全局 atob/Buffer 可交替）；仅解析头部，不做整图解码；
 * - 支持格式：PNG（IHDR，含 colorType→alpha 判定）、JPEG（SOF0-SOF3/SOF5-SOF7/SOF9-SOF11/SOF13-SOF15）、
 *   WebP（VP8X / VP8 / VP8L）；
 * - 无法解析返回 null（调用方按「无法探测→上游校验」策略处理）。
 */

/** 探测结果（format 与字节序无关的规范化信息）。 */
export interface ProbedImageInfo {
  width: number;
  height: number;
  format: "png" | "jpeg" | "webp";
  /** PNG 颜色类型是否含 alpha 通道（4=灰阶+alpha、6=RGBA）。 */
  alphaPng?: boolean;
}

/** 手写 base64 解码（保持零 Node 依赖：不依赖 atob/Buffer，纯 Uint8Array）。 */
export function base64ToBytes(b64: string): Uint8Array {
  const table = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";
  const clean = b64.replace(/=+$/, "");
  const out = new Uint8Array(Math.floor((clean.length * 3) / 4));
  let buffer = 0;
  let bits = 0;
  let idx = 0;
  for (const ch of clean) {
    const val = table.indexOf(ch);
    if (val < 0) continue; // 跳过非法字符（容错）
    buffer = (buffer << 6) | val;
    bits += 6;
    if (bits >= 8) {
      bits -= 8;
      out[idx] = (buffer >> bits) & 0xff;
      idx += 1;
    }
  }
  return out.subarray(0, idx);
}

/** 从 dataURL（`data:image/<fmt>;base64,<b64>`）解码出字节与格式；非法返回 null。 */
export function decodeBase64DataUrl(dataUrl: string): { bytes: Uint8Array; format: "png" | "jpeg" | "webp" } | null {
  const match = /^data:image\/(png|jpeg|webp);base64,([A-Za-z0-9+/=]+)$/.exec(dataUrl.trim());
  if (!match) return null;
  const format = match[1] as "png" | "jpeg" | "webp";
  const b64 = match[2] ?? "";
  try {
    return { bytes: base64ToBytes(b64), format };
  } catch {
    return null;
  }
}

/** 探测 PNG：IHDR（签名后：length(4) + "IHDR"(4) + width(4) + height(4) + bitDepth(1) + colorType(1)）。 */
export function probePngInfo(bytes: Uint8Array): ProbedImageInfo | null {
  if (bytes.length < 29) return null;
  const sig = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a];
  for (let i = 0; i < 8; i += 1) {
    if (bytes[i] !== sig[i]) return null;
  }
  if (bytes[12] !== 0x49 || bytes[13] !== 0x48 || bytes[14] !== 0x44 || bytes[15] !== 0x52) return null;
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const width = view.getUint32(16);
  const height = view.getUint32(20);
  const colorType = bytes[25] ?? 0;
  if (width === 0 || height === 0) return null;
  return { width, height, format: "png", alphaPng: colorType === 4 || colorType === 6 };
}

/** 探测 JPEG：扫描段内 SOF0-SOF15（precision(1) + height(2) + width(2)）。 */
export function probeJpegSize(bytes: Uint8Array): ProbedImageInfo | null {
  if (bytes.length < 4 || bytes[0] !== 0xff || bytes[1] !== 0xd8) return null;
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  let offset = 2;
  while (offset + 9 < bytes.length) {
    // 跳到下一个 marker（跳过填充 FF）。
    if (bytes[offset] !== 0xff) {
      offset += 1;
      continue;
    }
    let marker = bytes[offset + 1] ?? 0;
    if (marker === 0xff) {
      offset += 1;
      continue;
    }
    offset += 2;
    // SOS（0xDA）/ EOI（0xD9）终止扫描；standalone marker（RST/DNL 等，无长度）跳过。
    if (marker === 0xda || marker === 0xd9) break;
    const len = view.getUint16(offset);
    const isSof =
      (marker >= 0xc0 && marker <= 0xc3) ||
      (marker >= 0xc5 && marker <= 0xc7) ||
      (marker >= 0xc9 && marker <= 0xcb) ||
      (marker >= 0xcd && marker <= 0xcf);
    if (isSof) {
      const height = view.getUint16(offset + 3);
      const width = view.getUint16(offset + 5);
      if (width === 0 || height === 0) return null;
      return { width, height, format: "jpeg" };
    }
    offset += len;
  }
  return null;
}

/** 探测 WebP：VP8X（canvas 宽高 24bit LE）/ VP8（lossy 帧头）/ VP8L（lossless 14bit LE）。 */
export function probeWebpSize(bytes: Uint8Array): ProbedImageInfo | null {
  if (bytes.length < 30) return null;
  const ascii = (o: number, len: number): string =>
    String.fromCharCode(...Array.from({ length: len }, (_, i) => bytes[o + i] ?? 0));
  if (ascii(0, 4) !== "RIFF" || ascii(8, 4) !== "WEBP") return null;
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const chunkType = ascii(12, 4);
  if (chunkType === "VP8X" && bytes.length >= 30) {
    // VP8X 头：flags(1) + reserved(3) + canvasWidth(24 LE) + canvasHeight(24 LE)，起点 offset 20。
    const width = bytes[20]! | (bytes[21]! << 8) | (bytes[22]! << 16);
    const height = bytes[23]! | (bytes[24]! << 8) | (bytes[25]! << 16);
    if (width === 0 || height === 0) return null;
    return { width, height, format: "webp" };
  }
  if (chunkType === "VP8 " && bytes.length >= 30) {
    // lossy 帧头：3 字节起始码 0x9D 0x01 0x2A 后跟 14bit 宽/高（LE）。
    if (bytes[23] === 0x9d && bytes[24] === 0x01 && bytes[25] === 0x2a) {
      const width = (bytes[26]! | ((bytes[27]! & 0x3f) << 8)) & 0x3fff;
      const height = ((bytes[27]! >> 6) | (bytes[28]! << 2)) & 0x3fff;
      if (width === 0 || height === 0) return null;
      return { width, height, format: "webp" };
    }
    return null;
  }
  if (chunkType === "VP8L" && bytes.length >= 25) {
    // lossless：signature byte 0x2F 后 4 字节：width-1（14bit）+ height-1（14bit，LE 位打包）。
    if (bytes[20] === 0x2f) {
      const packed = view.getUint32(21, true);
      const width = (packed & 0x3fff) + 1;
      const height = ((packed >> 14) & 0x3fff) + 1;
      if (width === 0 || height === 0) return null;
      return { width, height, format: "webp" };
    }
    return null;
  }
  return null;
}

/** 通用入口：从字节探测格式与尺寸；无法识别返回 null。 */
export function probeImageBytes(bytes: Uint8Array): ProbedImageInfo | null {
  if (bytes.length < 4) return null;
  if (bytes[0] === 0x89 && bytes[1] === 0x50) return probePngInfo(bytes);
  if (bytes[0] === 0xff && bytes[1] === 0xd8) return probeJpegSize(bytes);
  if (bytes[0] === 0x52 && bytes[1] === 0x49 && bytes[2] === 0x46 && bytes[3] === 0x46) return probeWebpSize(bytes);
  return null;
}

/** 便捷：从 dataURL 探测（PNG/JPEG/WebP base64）；无法解析返回 null。 */
export function probeImageFromDataUrl(dataUrl: string): ProbedImageInfo | null {
  const decoded = decodeBase64DataUrl(dataUrl);
  if (!decoded) return null;
  return probeImageBytes(decoded.bytes) ?? null;
}