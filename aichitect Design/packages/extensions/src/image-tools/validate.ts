/**
 * gpt-image-2 约束校验层（P012，§6.2 适配要点全部内建）。
 *
 * 冻结契约（R2 计划 §7.1）：
 * - image_generate: { prompt, size?, quality?, outputFormat?, n? }
 * - image_edit:     { images[], prompt, mask?, inputFidelity?, size?, quality?, n? }
 *
 * 校验策略：
 * - 两档同构：未知/非法枚举 → errors（阻断）；「可探测但未满足」的物理约束（如 mask 同尺寸）
 *   在可探测时 errors、不可探测时降级 warning（README「已知边界」登记：外部 URI 由上游校验）；
 * - 透明背景拒绝（background:"transparent" / transparent:true / alpha 指示透明）；
 * - input_fidelity 显式提供 → 拒绝（§6.2：本阶段省略该参数，联调后按官方 reference 回归）；
 * - 尺寸约束内建 checkImageDimension()：16 的倍数、单边 ≤3840、宽高比 <3:1、像素 655,360–8,294,400；
 * - size 仅接受官方预设枚举（1024x1024 / 1536x1024 / 1024x1536 / auto——2048x2048 非 gpt-image 官方值，勿加）。
 */

import { probeImageFromDataUrl } from "./size-probe.js";

export const IMAGE_SIZE_PRESETS = ["1024x1024", "1536x1024", "1024x1536", "auto"] as const;
export type ImageSizePreset = (typeof IMAGE_SIZE_PRESETS)[number];

export const IMAGE_QUALITIES = ["low", "medium", "high"] as const;
export type ImageQuality = (typeof IMAGE_QUALITIES)[number];

export const IMAGE_OUTPUT_FORMATS = ["png", "jpeg", "webp"] as const;
export type ImageOutputFormat = (typeof IMAGE_OUTPUT_FORMATS)[number];

/** gpt-image-2 尺寸约束（§6.2）：单边 16 的倍数 / ≤3840 / 宽高比 <3:1 / 像素 655,360–8,294,400。 */
export const IMAGE_SIDE_STEP = 16;
export const IMAGE_SIDE_MAX = 3840;
export const IMAGE_ASPECT_RATIO_MAX = 3;
export const IMAGE_PIXELS_MIN = 655_360;
export const IMAGE_PIXELS_MAX = 8_294_400;

/** edits 入参：image 最多 16 张（§6.2）。 */
export const IMAGE_EDIT_MAX_IMAGES = 16;
/** 单次生成数量上限（OpenAI images n ∈ 1..10）。 */
export const IMAGE_N_MAX = 10;

/** 编辑参考图允许的格式（§6.2：png/webp/jpg）。 */
export const IMAGE_EDIT_INPUT_FORMATS = ["png", "webp", "jpeg", "jpg"] as const;

export interface NormalizedImageGenerateParams {
  prompt: string;
  size: ImageSizePreset;
  quality: ImageQuality;
  outputFormat: ImageOutputFormat;
  n: number;
}

export interface NormalizedImageEditParams {
  images: string[];
  prompt: string;
  mask?: string;
  size: ImageSizePreset;
  quality: ImageQuality;
  outputFormat: ImageOutputFormat;
  n: number;
}

/** 校验结果：ok=false 时 errors 阻断执行；warnings 仅为提示（不可探测的物理约束）。 */
export type ImageParamValidation<T> =
  | { ok: true; value: T; warnings: string[] }
  | { ok: false; errors: string[]; warnings: string[] };

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

/** 校验尺寸物理约束（§6.2）。返回违反项列表（空 = 合规）。 */
export function checkImageDimension(width: number, height: number): string[] {
  const errors: string[] = [];
  if (!Number.isInteger(width) || !Number.isInteger(height) || width <= 0 || height <= 0) {
    return [`尺寸必须为正整数，收到 ${width}x${height}`];
  }
  if (width % IMAGE_SIDE_STEP !== 0 || height % IMAGE_SIDE_STEP !== 0) {
    errors.push(`尺寸必须为 ${IMAGE_SIDE_STEP} 的倍数，收到 ${width}x${height}`);
  }
  if (width > IMAGE_SIDE_MAX || height > IMAGE_SIDE_MAX) {
    errors.push(`单边不得超过 ${IMAGE_SIDE_MAX}px，收到 ${width}x${height}`);
  }
  const aspect = Math.max(width, height) / Math.min(width, height);
  if (aspect >= IMAGE_ASPECT_RATIO_MAX) {
    errors.push(`宽高比必须 < ${IMAGE_ASPECT_RATIO_MAX}:1，收到 ${width}x${height}（比值 ${aspect.toFixed(2)}）`);
  }
  const pixels = width * height;
  if (pixels < IMAGE_PIXELS_MIN || pixels > IMAGE_PIXELS_MAX) {
    errors.push(`像素总数必须在 ${IMAGE_PIXELS_MIN}–${IMAGE_PIXELS_MAX}，收到 ${pixels}（${width}x${height}）`);
  }
  return errors;
}

/** 从预设枚举解析像素宽高（预设天然满足尺寸物理约束）。 */
export function parseImageSizePreset(size: ImageSizePreset): { width: number; height: number } {
  const [w, h] = size.split("x").map((v) => Number(v));
  return { width: w ?? 1024, height: h ?? 1024 };
}

/** 透明背景请求拒绝（§6.2：gpt-image-2 不支持透明 PNG；需要透明走 gpt-image-1.5 双模型路径）。 */
function transparencyErrors(params: Record<string, unknown>): string[] {
  const errors: string[] = [];
  if (params.background === "transparent") {
    errors.push("background=transparent 不支持：gpt-image-2 拒绝透明背景（§6.2），请省略该参数");
  }
  if (params.transparent === true) {
    errors.push("transparent=true 不支持：gpt-image-2 拒绝透明背景（§6.2），请省略该参数");
  }
  if (params.alpha === "transparent") {
    errors.push("alpha=transparent 不支持：gpt-image-2 拒绝透明背景（§6.2），请省略该参数");
  }
  return errors;
}

function normalizeCommon(params: Record<string, unknown>): ImageParamValidation<{
  prompt: string;
  size: ImageSizePreset;
  quality: ImageQuality;
  outputFormat: ImageOutputFormat;
  n: number;
}> {
  const errors: string[] = [];
  const warnings: string[] = [];

  const prompt = params.prompt;
  if (typeof prompt !== "string" || prompt.trim().length === 0) {
    errors.push("prompt 必须为非空字符串");
  }

  const sizeRaw = params.size === undefined ? "1024x1024" : params.size;
  let size: ImageSizePreset = "1024x1024";
  if (typeof sizeRaw !== "string" || !(IMAGE_SIZE_PRESETS as readonly string[]).includes(sizeRaw)) {
    errors.push(`size 必须是预设枚举 ${IMAGE_SIZE_PRESETS.join(" / ")}，收到：${String(sizeRaw)}`);
  } else {
    size = sizeRaw as ImageSizePreset;
  }

  const qualityRaw = params.quality === undefined ? "medium" : params.quality;
  let quality: ImageQuality = "medium";
  if (typeof qualityRaw !== "string" || !(IMAGE_QUALITIES as readonly string[]).includes(qualityRaw)) {
    errors.push(`quality 必须是 ${IMAGE_QUALITIES.join(" / ")}，收到：${String(qualityRaw)}`);
  } else {
    quality = qualityRaw as ImageQuality;
  }

  const formatRaw = params.outputFormat === undefined ? "png" : params.outputFormat;
  let outputFormat: ImageOutputFormat = "png";
  if (typeof formatRaw !== "string" || !(IMAGE_OUTPUT_FORMATS as readonly string[]).includes(formatRaw)) {
    errors.push(`outputFormat 必须是 ${IMAGE_OUTPUT_FORMATS.join(" / ")}，收到：${String(formatRaw)}`);
  } else {
    outputFormat = formatRaw as ImageOutputFormat;
  }

  const nRaw = params.n === undefined ? 1 : params.n;
  let n = 1;
  if (typeof nRaw !== "number" || !Number.isInteger(nRaw) || nRaw < 1 || nRaw > IMAGE_N_MAX) {
    errors.push(`n 必须是 1–${IMAGE_N_MAX} 的整数，收到：${String(nRaw)}`);
  } else {
    n = nRaw;
  }

  errors.push(...transparencyErrors(params));
  if (errors.length > 0) return { ok: false, errors, warnings };
  return { ok: true, value: { prompt: String(prompt), size, quality, outputFormat, n }, warnings };
}

/** image_generate 参数校验（§6.1 契约 + §6.2 约束内建）。 */
export function validateImageGenerateParams(input: unknown): ImageParamValidation<NormalizedImageGenerateParams> {
  if (!isRecord(input)) {
    return { ok: false, errors: ["参数必须为对象"], warnings: [] };
  }
  const common = normalizeCommon(input);
  if (!common.ok) return common;
  return { ok: true, value: { ...common.value }, warnings: common.warnings };
}

function isUriLike(v: unknown): v is string {
  return typeof v === "string" && v.trim().length > 0;
}

function uriExtension(uri: string): string {
  const cleaned = uri.split(/[?#]/)[0] ?? "";
  const idx = cleaned.lastIndexOf(".");
  return idx >= 0 ? cleaned.slice(idx + 1).toLowerCase() : "";
}

function uriIsDataUrl(uri: string): boolean {
  return /^data:image\/(png|jpeg|webp);base64,/i.test(uri);
}

/** image_edit 参考图/mask 探测（dataURL 可探测；外部 URI 返回 null → 校验降级 warning）。 */
function probeUriInfo(uri: string): { width: number; height: number; alphaPng?: boolean } | null {
  if (uriIsDataUrl(uri)) {
    return probeImageFromDataUrl(uri);
  }
  return null;
}

/** image_edit 参数校验（§6.1 契约 + §6.2：images≤16、mask 同尺寸 alpha PNG）。 */
export function validateImageEditParams(input: unknown): ImageParamValidation<NormalizedImageEditParams> {
  if (!isRecord(input)) {
    return { ok: false, errors: ["参数必须为对象"], warnings: [] };
  }
  const errors: string[] = [];
  const warnings: string[] = [];

  const common = normalizeCommon(input);
  if (!common.ok) return common;

  // input_fidelity：§6.2 本阶段省略（联调核对官方 reference 后回归）。显式提供即拒绝。
  if (input.inputFidelity !== undefined) {
    errors.push("inputFidelity 本阶段不支持（§6.2：gpt-image-2 联调前省略该参数，请删除后重试）");
  }

  const images = input.images;
  if (!Array.isArray(images) || images.length === 0) {
    errors.push("images 必须为非空数组（参考图 URI / dataURL，1–16 张）");
  } else {
    if (images.length > IMAGE_EDIT_MAX_IMAGES) {
      errors.push(`images 最多 ${IMAGE_EDIT_MAX_IMAGES} 张，收到 ${images.length} 张`);
    }
    images.forEach((item, i) => {
      if (!isUriLike(item)) {
        errors.push(`images[${i}] 必须为非空 URI 字符串`);
        return;
      }
      const ext = uriExtension(item);
      if (!uriIsDataUrl(item) && ext !== "" && !(IMAGE_EDIT_INPUT_FORMATS as readonly string[]).includes(ext)) {
        errors.push(`images[${i}] 格式必须为 png/webp/jpg（§6.2），收到扩展名：${ext}`);
      }
    });
  }

  const mask = input.mask;
  if (mask !== undefined) {
    if (!isUriLike(mask)) {
      errors.push("mask 必须为 URI 字符串（同尺寸 alpha PNG，§6.2）");
    } else {
      const ext = uriExtension(mask);
      const isPng = /^data:image\/png;/i.test(mask) || ext === "png";
      if (!isPng) {
        errors.push(`mask 必须为 PNG（同尺寸 alpha PNG，§6.2），收到扩展名：${ext}`);
      } else {
        const maskInfo = probeUriInfo(mask);
        if (maskInfo) {
          if (maskInfo.alphaPng !== true) {
            errors.push("mask 必须带 alpha 通道（alpha=0 区域重绘，§6.2）；收到 PNG 不含 alpha");
          }
          const firstInfo =
            Array.isArray(images) && images.length > 0 && typeof images[0] === "string" ? probeUriInfo(images[0]) : null;
          if (firstInfo && (firstInfo.width !== maskInfo.width || firstInfo.height !== maskInfo.height)) {
            errors.push(
              `mask 必须与参考图同尺寸（§6.2）：mask=${maskInfo.width}x${maskInfo.height}，参考图=${firstInfo.width}x${firstInfo.height}`,
            );
          }
        } else {
          warnings.push("mask 为外部 URI，无法本地探测尺寸/alpha（§6.2 约束交由上游 API 校验）");
        }
      }
    }
  }

  if (errors.length > 0) return { ok: false, errors, warnings: [...common.warnings, ...warnings] };
  return {
    ok: true,
    value: { images: images as string[], prompt: common.value.prompt, mask: typeof mask === "string" ? mask : undefined, size: common.value.size, quality: common.value.quality, outputFormat: common.value.outputFormat, n: common.value.n },
    warnings: [...common.warnings, ...warnings],
  };
}