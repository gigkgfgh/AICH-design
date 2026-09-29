/**
 * image-tools（P012）用例：gpt-image-2 约束校验层 + 尺寸探测 + ToolDef 契约。
 * §6.2 适配要点覆盖：透明拒绝 / inputFidelity 省略 / 尺寸（16 倍数、≤3840、宽高比<3:1、
 * 像素范围）/ size 预设枚举 / outputFormat 枚举 / edits（images≤16、mask 同尺寸 alpha PNG）。
 */

import { describe, expect, it } from "vitest";
import { deflateSync } from "node:zlib";
import {
  IMAGE_EDIT_TOOL_DEF,
  IMAGE_GENERATE_TOOL_DEF,
  IMAGE_EDIT_MAX_IMAGES,
  checkImageDimension,
  decodeBase64DataUrl,
  probeImageFromDataUrl,
  probeImageBytes,
  probePngInfo,
  validateImageEditParams,
  validateImageGenerateParams,
} from "../src/image-tools/index";

/* ---------------- 测试内 PNG 编码 helper（RGBA，供 mask alpha 探测） ---------------- */

const CRC_TABLE = (() => {
  const t = new Int32Array(256);
  for (let n = 0; n < 256; n += 1) {
    let c = n;
    for (let k = 0; k < 8; k += 1) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    t[n] = c;
  }
  return t;
})();

function crc32(bytes: Uint8Array): number {
  let c = 0xffffffff;
  for (let i = 0; i < bytes.length; i += 1) c = CRC_TABLE[(c ^ bytes[i]!) & 0xff]! ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

function chunk(type: string, data: Uint8Array): Buffer {
  const tb = Buffer.from(type, "ascii");
  const len = Buffer.alloc(4);
  len.writeUInt32BE(data.length);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(Buffer.concat([tb, Buffer.from(data)])));
  return Buffer.concat([len, tb, Buffer.from(data), crc]);
}

function makePngDataUrl(width: number, height: number, alpha: boolean): string {
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(width, 0);
  ihdr.writeUInt32BE(height, 4);
  ihdr[8] = 8;
  ihdr[9] = alpha ? 6 : 2; // colorType：6=RGBA（带 alpha）、2=RGB
  const bpp = alpha ? 4 : 3;
  const raw = Buffer.alloc(height * (1 + width * bpp));
  for (let y = 0; y < height; y += 1) {
    const rowStart = y * (1 + width * bpp);
    raw[rowStart] = 0;
    for (let x = 0; x < width; x += 1) {
      const off = rowStart + 1 + x * bpp;
      raw[off] = (x * 7) % 256;
      raw[off + 1] = (y * 13) % 256;
      raw[off + 2] = 128;
      if (alpha) raw[off + 3] = x % 2 === 0 ? 255 : 0; // alpha=0 区域（重绘语义）
    }
  }
  const buf = Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk("IHDR", ihdr),
    chunk("IDAT", deflateSync(raw, { level: 6 })),
    chunk("IEND", Buffer.alloc(0)),
  ]);
  return `data:image/png;base64,${buf.toString("base64")}`;
}

/* ---------------- image_generate（§6.1 契约 + §6.2） ---------------- */

describe("validateImageGenerateParams", () => {
  it("合法参数 normalize：缺省 size/quality/outputFormat/n", () => {
    const r = validateImageGenerateParams({ prompt: "北欧风客厅表现图" });
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.value).toEqual({ prompt: "北欧风客厅表现图", size: "1024x1024", quality: "medium", outputFormat: "png", n: 1 });
    }
  });

  it("size 非法枚举拒绝", () => {
    const r = validateImageGenerateParams({ prompt: "x", size: "512x512" });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.errors.some((e) => e.includes("size 必须是预设枚举"))).toBe(true);
  });

  it("quality / outputFormat 非法拒绝", () => {
    expect(validateImageGenerateParams({ prompt: "x", quality: "ultra" }).ok).toBe(false);
    expect(validateImageGenerateParams({ prompt: "x", outputFormat: "gif" }).ok).toBe(false);
  });

  it("n 非法（0 / 11 / 1.5 / 字符串）拒绝", () => {
    for (const n of [0, 11, 1.5, "2"]) {
      const r = validateImageGenerateParams({ prompt: "x", n });
      expect(r.ok, `n=${String(n)}`).toBe(false);
    }
  });

  it("prompt 缺失 / 非对象拒绝", () => {
    expect(validateImageGenerateParams({}).ok).toBe(false);
    expect(validateImageGenerateParams(null).ok).toBe(false);
    expect(validateImageGenerateParams("x").ok).toBe(false);
  });

  it("透明背景请求拒绝（background:transparent / transparent:true / alpha:transparent）", () => {
    for (const params of [
      { prompt: "x", background: "transparent" },
      { prompt: "x", transparent: true },
      { prompt: "x", alpha: "transparent" },
    ]) {
      const r = validateImageGenerateParams(params);
      expect(r.ok).toBe(false);
      if (!r.ok) expect(r.errors.some((e) => e.includes("透明"))).toBe(true);
    }
  });
});

/* ---------------- image_edit（§6.1 契约 + §6.2 edits 入参约束） ---------------- */

describe("validateImageEditParams", () => {
  const ref = makePngDataUrl(64, 64, false);
  const maskAlpha = makePngDataUrl(64, 64, true);
  const maskNoAlpha = makePngDataUrl(64, 64, false);

  it("合法参数（images + prompt）通过", () => {
    const r = validateImageEditParams({ images: [ref], prompt: "改成暖色调" });
    expect(r.ok).toBe(true);
  });

  it("images 缺失 / 空 / 超 16 张拒绝", () => {
    expect(validateImageEditParams({ prompt: "x" }).ok).toBe(false);
    expect(validateImageEditParams({ images: [], prompt: "x" }).ok).toBe(false);
    const many = Array.from({ length: IMAGE_EDIT_MAX_IMAGES + 1 }, () => ref);
    const r = validateImageEditParams({ images: many, prompt: "x" });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.errors.some((e) => e.includes("最多 16 张"))).toBe(true);
  });

  it("images 元素非字符串拒绝", () => {
    expect(validateImageEditParams({ images: [123], prompt: "x" }).ok).toBe(false);
  });

  it("inputFidelity 显式提供拒绝（§6.2 本阶段省略）", () => {
    const r = validateImageEditParams({ images: [ref], prompt: "x", inputFidelity: "high" });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.errors.some((e) => e.includes("inputFidelity"))).toBe(true);
  });

  it("mask 非 PNG 拒绝", () => {
    const r = validateImageEditParams({ images: [ref], prompt: "x", mask: "data:image/jpeg;base64,AA==" });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.errors.some((e) => e.includes("mask 必须为 PNG"))).toBe(true);
  });

  it("mask PNG 无 alpha 通道拒绝", () => {
    const r = validateImageEditParams({ images: [ref], prompt: "x", mask: maskNoAlpha });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.errors.some((e) => e.includes("alpha"))).toBe(true);
  });

  it("mask 与参考图同尺寸且带 alpha 通过", () => {
    const r = validateImageEditParams({ images: [ref], prompt: "x", mask: maskAlpha });
    expect(r.ok).toBe(true);
  });

  it("mask 与参考图尺寸不一致拒绝", () => {
    const maskOtherSize = makePngDataUrl(32, 32, true);
    const r = validateImageEditParams({ images: [ref], prompt: "x", mask: maskOtherSize });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.errors.some((e) => e.includes("同尺寸"))).toBe(true);
  });

  it("mask 为外部 URI（无法本地探测）→ ok 且附 warning（上游校验）", () => {
    const r = validateImageEditParams({ images: ["file:///tmp/ref.png"], prompt: "x", mask: "file:///tmp/mask.png" });
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.warnings.some((w) => w.includes("上游 API 校验"))).toBe(true);
  });
});

/* ---------------- checkImageDimension（§6.2 尺寸物理约束） ---------------- */

describe("checkImageDimension", () => {
  it("合规尺寸：1024x1024 / 3840x2160", () => {
    expect(checkImageDimension(1024, 1024)).toEqual([]);
    expect(checkImageDimension(3840, 2160)).toEqual([]);
  });
  it("16 的倍数违反", () => {
    expect(checkImageDimension(1025, 1024).some((e) => e.includes("16 的倍数"))).toBe(true);
  });
  it("单边超 3840", () => {
    expect(checkImageDimension(4000, 1024).some((e) => e.includes("3840"))).toBe(true);
  });
  it("宽高比 ≥3:1", () => {
    expect(checkImageDimension(3200, 1024).some((e) => e.includes("宽高比"))).toBe(true);
    // 边界 3.0 本身不合格（要求 <3:1）
    expect(checkImageDimension(3072, 1024).some((e) => e.includes("宽高比"))).toBe(true);
  });
  it("像素范围（655,360–8,294,400）", () => {
    expect(checkImageDimension(1024, 512).some((e) => e.includes("像素总数"))).toBe(true); // 524,288 < min
    expect(checkImageDimension(3840, 2176).some((e) => e.includes("像素总数"))).toBe(true); // 8,355,840 > max
    expect(checkImageDimension(640, 1024)).toEqual([]); // 655,360 恰好
  });
});

/* ---------------- 尺寸探测（size-probe） ---------------- */

describe("size-probe", () => {
  it("decodeBase64DataUrl 非法返回 null", () => {
    expect(decodeBase64DataUrl("not-a-dataurl")).toBeNull();
    expect(decodeBase64DataUrl("data:image/gif;base64,AAAA")).toBeNull();
  });

  it("PNG dataURL 探测尺寸与 alpha", () => {
    const rgba = makePngDataUrl(64, 32, true);
    const info = probeImageFromDataUrl(rgba);
    expect(info).toEqual({ width: 64, height: 32, format: "png", alphaPng: true });
    const rgb = makePngDataUrl(16, 16, false);
    expect(probeImageFromDataUrl(rgb)?.alphaPng).toBe(false);
  });

  it("JPEG SOF 尺寸探测（手工构造头部）", () => {
    // FF D8 + SOF0 段（len=0x0011、precision=8、height=0x0100、width=0x0200）
    const bytes = new Uint8Array([
      0xff, 0xd8, 0xff, 0xc0, 0x00, 0x11, 0x08, 0x01, 0x00, 0x02, 0x00, 0x03, 0x01, 0x22, 0x00, 0x02, 0x11, 0x01, 0x03, 0x11, 0x01, 0xff, 0xd9,
    ]);
    const info = probeImageBytes(bytes);
    expect(info).toEqual({ width: 512, height: 256, format: "jpeg" });
  });

  it("WebP VP8X 尺寸探测（手工构造头部）", () => {
    // RIFF(4) + size(4) + WEBP(4) + VP8X(4) + data(10)：canvas 宽 24bit LE、高 24bit LE
    const bytes = new Uint8Array(30);
    bytes.set([0x52, 0x49, 0x46, 0x46], 0);
    bytes.set([0x1a, 0x00, 0x00, 0x00], 4);
    bytes.set([0x57, 0x45, 0x42, 0x50], 8);
    bytes.set([0x56, 0x50, 0x38, 0x58], 12);
    // offset 20 起：width=1024 (0x400) LE24、height=768 (0x300) LE24
    bytes[20] = 0x00; bytes[21] = 0x04; bytes[22] = 0x00;
    bytes[23] = 0x00; bytes[24] = 0x03; bytes[25] = 0x00;
    const info = probeImageBytes(bytes);
    expect(info).toEqual({ width: 1024, height: 768, format: "webp" });
  });

  it("probePngInfo 对非 PNG 返回 null", () => {
    expect(probePngInfo(new Uint8Array([1, 2, 3]))).toBeNull();
  });
});

/* ---------------- ToolDef 契约（§6.1 冻结） ---------------- */

describe("image-tools ToolDef", () => {
  it("image_generate 契约：required=[prompt]，size/quality/outputFormat 枚举，additionalProperties=false", () => {
    const p = IMAGE_GENERATE_TOOL_DEF.parameters as {
      required?: string[];
      properties: Record<string, { enum?: unknown[] }>;
      additionalProperties?: boolean;
    };
    expect(IMAGE_GENERATE_TOOL_DEF.name).toBe("image_generate");
    expect(p.required).toEqual(["prompt"]);
    expect(p.properties.size?.enum).toEqual(["1024x1024", "1536x1024", "1024x1536", "auto"]);
    expect(p.properties.quality?.enum).toEqual(["low", "medium", "high"]);
    expect(p.properties.outputFormat?.enum).toEqual(["png", "jpeg", "webp"]);
    expect(p.additionalProperties).toBe(false);
  });

  it("image_edit 契约：required=[images,prompt]，images 上限 16", () => {
    const p = IMAGE_EDIT_TOOL_DEF.parameters as {
      required?: string[];
      properties: Record<string, { maxItems?: number; enum?: unknown[] }>;
    };
    expect(IMAGE_EDIT_TOOL_DEF.name).toBe("image_edit");
    expect(p.required).toEqual(["images", "prompt"]);
    expect(p.properties.images?.maxItems).toBe(16);
  });
});