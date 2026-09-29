/**
 * ImageApiPort：图像端口抽象（P012，§6.1/6.2）。
 *
 * 实现：
 * - MockImageProvider：确定性 PNG dataURL + mock cost（离线全链路，无 Key 兜底）；
 * - OpenAiImageApi：真实 OpenAI Image API（R6-16：用户在设置中填写**完整端点 URL**，
 *   本类原样使用、零拼接——生成 POST {generationsUrl}，编辑 POST {editsUrl}）。
 *
 * 配置（独立于 LLM，§6.2 合规端点可配）：
 * - AICH_IMAGE_BASE_URL（默认 https://api.openai.com/v1）
 * - AICH_IMAGE_API_KEY
 * - AICH_IMAGE_MODEL（默认 gpt-image-2）
 * - AICH_IMAGE_MOCK=1 或 Key 缺失 → MockImageProvider（与 AICH_ADAPTER 降级链同构）
 *
 * 契约：工具返回 { text, details, isError }（details 为 ImageApiResult 形状，
 * adapter 在工具执行成功后经 ImageRegistry 落盘并产生 SSE done image 载荷）。
 */

import { randomUUID, createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { resolve as pathResolve, sep } from "node:path";
import { fileURLToPath } from "node:url";
import { deflateSync } from "node:zlib";
import type { ImageMeta } from "@aichdesign/shared";
import { ErrorCode } from "@aichdesign/shared";
import type { ImageOutputFormat, ImageQuality, ImageSizePreset } from "@aichdesign/extensions";
import { decodeBase64DataUrl } from "@aichdesign/extensions";
import { withRetry } from "../runtime/retry.js";
import type { RetryPolicy } from "../runtime/retry.js";

/** image_generate 标准化入参（已过约束校验层）。 */
export interface ImageGenerateParams {
  prompt: string;
  size: ImageSizePreset;
  quality: ImageQuality;
  outputFormat: ImageOutputFormat;
  n: number;
}

/** image_edit 标准化入参（已过约束校验层）。 */
export interface ImageEditParams {
  images: string[];
  prompt: string;
  mask?: string;
  size: ImageSizePreset;
  quality: ImageQuality;
  outputFormat: ImageOutputFormat;
  n: number;
}

/** 图像端口产物：url 为 dataURL（落盘由 ImageRegistry 负责）；meta 复用 shared 冻结结构。 */
export interface ImageApiResult {
  imageId: string;
  url: string;
  format: ImageOutputFormat;
  meta: ImageMeta;
}

/** 图像端口抽象（真实 http 与 mock 可替换）。 */
export interface ImageApiPort {
  readonly label: string;
  generate(params: ImageGenerateParams): Promise<ImageApiResult>;
  edit(params: ImageEditParams): Promise<ImageApiResult>;
}

/* ---------------- MockImageProvider（离线确定性 mock） ---------------- */

export interface MockImageProviderOptions {
  /** mock 模型 id（ImageMeta.model）。 */
  modelId?: string;
  /** 每百万像素成本（$），默认 0.04（演示口径，README 已登记）。 */
  costPerMpUsd?: number;
}

/** mock 模型/提供者常量（ImageMeta 登记用）。 */
export const MOCK_IMAGE_MODEL_ID = "mock-image-0.1";
export const MOCK_IMAGE_PROVIDER = "mock-image";

/** 从 size 预设解析像素宽高（预设天然满足 §6.2 尺寸约束）。 */
export function parseSizePreset(size: ImageSizePreset): { width: number; height: number } {
  const [w, h] = size.split("x").map((v) => Number(v));
  return { width: w ?? 1024, height: h ?? 1024 };
}

/** 确定性 seed（同 prompt+size 同图，离线可复现）。 */
export function imageSeed(...parts: (string | number)[]): number {
  const hash = createHash("sha1").update(parts.join("|")).digest();
  return hash[0]! * 0x1000000 + hash[1]! * 0x10000 + hash[2]! * 0x100 + hash[3]!;
}

const CRC_TABLE: Int32Array = (() => {
  const table = new Int32Array(256);
  for (let n = 0; n < 256; n += 1) {
    let c = n;
    for (let k = 0; k < 8; k += 1) {
      c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    }
    table[n] = c;
  }
  return table;
})();

/** 自实现 CRC32（zlib.crc32 在部分 Node 版本签名差异；此处独立实现，无歧义）。 */
function crc32Of(bytes: Uint8Array): number {
  let crc = 0xffffffff;
  for (let i = 0; i < bytes.length; i += 1) {
    crc = CRC_TABLE[(crc ^ bytes[i]!) & 0xff]! ^ (crc >>> 8);
  }
  return (crc ^ 0xffffffff) >>> 0;
}

function pngChunk(type: string, data: Uint8Array): Buffer {
  const typeBuf = Buffer.from(type, "ascii");
  const len = Buffer.alloc(4);
  len.writeUInt32BE(data.length);
  const crcBuf = Buffer.alloc(4);
  crcBuf.writeUInt32BE(crc32Of(Buffer.concat([typeBuf, Buffer.from(data)])));
  return Buffer.concat([len, typeBuf, Buffer.from(data), crcBuf]);
}

/**
 * 编码 PNG（RGB，8bit，无 alpha）。纯色/渐变图 deflate 后体积可控，
 * 1024x1024 mock 图 dataURL 仅数 KB（可离线演示与落盘）。
 */
export function encodePngRgb(width: number, height: number, pixelFn: (x: number, y: number) => [number, number, number]): Buffer {
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(width, 0);
  ihdr.writeUInt32BE(height, 4);
  ihdr[8] = 8; // bit depth
  ihdr[9] = 2; // color type RGB
  // raw: 每行 filter byte 0 + RGB 三通道。
  const raw = Buffer.alloc(height * (1 + width * 3));
  for (let y = 0; y < height; y += 1) {
    const rowStart = y * (1 + width * 3);
    raw[rowStart] = 0;
    for (let x = 0; x < width; x += 1) {
      const [r, g, b] = pixelFn(x, y);
      const off = rowStart + 1 + x * 3;
      raw[off] = r;
      raw[off + 1] = g;
      raw[off + 2] = b;
    }
  }
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    pngChunk("IHDR", ihdr),
    pngChunk("IDAT", deflateSync(raw, { level: 6 })),
    pngChunk("IEND", Buffer.alloc(0)),
  ]);
}

/** 确定性 mock 图样：seed 决定配色（背景 + 对角色带），避免纯色块误导展示。 */
export function createMockPngDataUrl(width: number, height: number, seed: number): string {
  const hueShift = seed % 360;
  const base = [hueShift % 256, (hueShift * 7) % 256, (hueShift * 13) % 256];
  const buf = encodePngRgb(width, height, (x, y) => {
    const band = ((x + y) / Math.max(1, (width + height) / 8)) % 1;
    const accent = band > 0.75 ? 40 : band > 0.5 ? 20 : 0;
    return [
      Math.min(255, base[0]! + accent),
      Math.min(255, base[1]! + accent),
      Math.min(255, base[2]! + accent),
    ];
  });
  return `data:image/png;base64,${buf.toString("base64")}`;
}

/**
 * MockImageProvider：确定性 PNG dataURL + mock cost。
 * 同参数同输出（可复现）；imageId 随机唯一（会话版本树可区分同 prompt 多次生成）。
 */
export class MockImageProvider implements ImageApiPort {
  readonly label = MOCK_IMAGE_PROVIDER;
  private readonly options: Required<MockImageProviderOptions>;

  constructor(options: MockImageProviderOptions = {}) {
    this.options = { modelId: options.modelId ?? MOCK_IMAGE_MODEL_ID, costPerMpUsd: options.costPerMpUsd ?? 0.04 };
  }

  async generate(params: ImageGenerateParams): Promise<ImageApiResult> {
    const { width, height } = parseSizePreset(params.size);
    const seed = imageSeed("generate", params.prompt, params.size, params.quality, params.outputFormat);
    // mock 恒为 PNG dataURL（不模拟 jpeg/webp 编码；format 与实际字节一致，供 ImageRegistry 落盘扩展名）。
    const url = createMockPngDataUrl(width, height, seed);
    return this.toResult(url, params.prompt, width, height, "png", seed);
  }

  /** mock 编辑：不真正读参考图/遮罩（离线演示），按 prompt+size 生成确定性变体图。 */
  async edit(params: ImageEditParams): Promise<ImageApiResult> {
    const { width, height } = parseSizePreset(params.size);
    const seed = imageSeed("edit", params.prompt, params.size, params.quality, params.outputFormat);
    const url = createMockPngDataUrl(width, height, seed);
    const meta = this.toResult(url, params.prompt, width, height, "png", seed).meta;
    return {
      imageId: `img_${randomUUID()}`,
      url,
      format: "png",
      meta,
    };
  }

  private toResult(url: string, prompt: string, width: number, height: number, format: ImageOutputFormat, seed: number): ImageApiResult {
    const costUsd = ((width * height) / (1024 * 1024)) * this.options.costPerMpUsd;
    const meta: ImageMeta = {
      prompt,
      model: this.options.modelId,
      provider: MOCK_IMAGE_PROVIDER,
      width,
      height,
      durationMs: 80 + (seed % 120),
      costUsd,
      status: "succeeded",
      createdAt: new Date().toISOString(),
    };
    return { imageId: `img_${randomUUID()}`, url, format: format === "jpeg" ? "jpeg" : "png", meta };
  }
}

/* ---------------- OpenAiImageApi（真实链路，联调点待 Key/网络） ---------------- */

export interface OpenAiImageApiOptions {
  /** R6-16：图像生成完整端点 URL（原样使用，不做任何拼接/补全；通常以 /v1/images/generations 结尾）。 */
  generationsUrl: string;
  /** R6-16：图像编辑完整端点 URL（选填；缺省时 edit 报"未配置"明确错误）。 */
  editsUrl?: string;
  apiKey: string;
  /** 图像模型 id（默认 gpt-image-2，§6.2）。 */
  model?: string;
  /** 请求超时（毫秒），默认 180_000（§4.2 image.timeoutMs）。 */
  timeoutMs?: number;
  /** 本地参考图白名单根目录（G2 修复，R2-REV）：仅允许 images/ 已注册目录内 file:// 读取。 */
  allowedLocalRoots?: string[];
  /** fetch 实现（默认全局 fetch；测试注入计数用）。 */
  fetchImpl?: typeof fetch;
  /** 瞬态失败重试策略（P018：5xx/429/网络类指数退避，默认 2 次 500ms 起）。 */
  retryPolicy?: Partial<RetryPolicy>;
}

/**
 * 真实 OpenAI Image API 实现（§6.1/§6.2 契约）。
 * 联调点（README「已知边界」登记）：无 Key/网络受限，未实机联调；
 * 参数以 OpenAI 官方参考为准，Key 就绪后仅验证本类即可切换。
 */
export class OpenAiImageApi implements ImageApiPort {
  readonly label = "openai-image";
  private readonly options: Required<Omit<OpenAiImageApiOptions, "allowedLocalRoots" | "retryPolicy" | "editsUrl">> & {
    allowedLocalRoots?: string[];
    retryPolicy?: Partial<RetryPolicy>;
    editsUrl?: string;
  };

  constructor(options: OpenAiImageApiOptions) {
    this.options = {
      model: "gpt-image-2",
      timeoutMs: 180_000,
      fetchImpl: fetch,
      ...options,
    };
  }

  async generate(params: ImageGenerateParams): Promise<ImageApiResult> {
    const { generationsUrl, apiKey, model, timeoutMs, fetchImpl, retryPolicy } = this.options;
    const endpoint = generationsUrl;
    const res = await withRetry(
      () =>
        fetchImpl(endpoint, {
          method: "POST",
          headers: {
            "content-type": "application/json",
            authorization: `Bearer ${apiKey}`,
          },
          body: JSON.stringify({
            model,
            prompt: params.prompt,
            n: params.n,
            size: params.size,
            quality: params.quality,
            output_format: params.outputFormat,
          }),
          signal: AbortSignal.timeout(timeoutMs),
        }).then(assertOk("images/generations")),
      retryPolicy,
    ).then((o) => o.value);
    // R6-19：宽松解析（OpenAI 标准 + 常见中转形状）+ 异步任务探测轮询 + 错误含响应体摘录。
    const body: unknown = await res.json().catch(() => null);
    const url = await resolveImageDataUrl({
      body,
      label: "images/generations",
      generationsUrl,
      apiKey,
      fetchImpl,
      timeoutMs,
      outputFormat: params.outputFormat,
    });
    const { width, height } = parseSizePreset(params.size);
    const meta: ImageMeta = {
      prompt: params.prompt,
      model,
      provider: "openai",
      width,
      height,
      status: "succeeded",
      createdAt: new Date().toISOString(),
    };
    return { imageId: `img_${randomUUID()}`, url, format: params.outputFormat, meta };
  }

  async edit(params: ImageEditParams): Promise<ImageApiResult> {
    const { editsUrl, apiKey, model, timeoutMs, fetchImpl, retryPolicy } = this.options;
    if (!editsUrl || editsUrl.trim().length === 0) {
      throw new Error("图像编辑端点未配置：请在 设置 → 图像端点 填写完整的编辑 URL（通常以 /v1/images/edits 结尾）");
    }
    const endpoint = editsUrl;
    const fd = new FormData();
    for (let i = 0; i < params.images.length; i += 1) {
      const uri = params.images[i]!;
      const { bytes, format } = await bytesFromUri(uri, this.options.allowedLocalRoots);
      const ext = format === "jpeg" ? "jpg" : format;
      fd.append("image", new Blob([Buffer.from(bytes)], { type: `image/${format === "jpeg" ? "jpeg" : format}` }), `image_${i}.${ext}`);
    }
    if (params.mask) {
      const { bytes, format: maskFormat } = await bytesFromUri(params.mask, this.options.allowedLocalRoots);
      // 官方要求：mask 必须为 PNG（不透明区域 = 待编辑区域，透明区域保留）。
      if (maskFormat !== "png") {
        throw new Error("遮罩文件必须为 PNG 格式（不透明区域为待编辑区域）；请转换后重试");
      }
      fd.append("mask", new Blob([Buffer.from(bytes)], { type: "image/png" }), "mask.png");
    }
    fd.append("model", model);
    fd.append("prompt", params.prompt);
    fd.append("n", String(params.n));
    fd.append("size", params.size);
    fd.append("quality", params.quality);
    fd.append("output_format", params.outputFormat);

    const res = await withRetry(
      () =>
        fetchImpl(endpoint, {
          method: "POST",
          headers: { authorization: `Bearer ${apiKey}` },
          body: fd,
          signal: AbortSignal.timeout(timeoutMs),
        }).then(assertOk("images/edits")),
      retryPolicy,
    ).then((o) => o.value);
    // R6-19：同 generate 的宽松解析与任务轮询（轮询锚点用编辑端点自身的 URL）。
    const body: unknown = await res.json().catch(() => null);
    const url = await resolveImageDataUrl({
      body,
      label: "images/edits",
      generationsUrl: editsUrl,
      apiKey,
      fetchImpl,
      timeoutMs,
      outputFormat: params.outputFormat,
    });
    const { width, height } = parseSizePreset(params.size);
    const meta: ImageMeta = {
      prompt: params.prompt,
      model,
      provider: "openai",
      width,
      height,
      status: "succeeded",
      createdAt: new Date().toISOString(),
    };
    return { imageId: `img_${randomUUID()}`, url, format: params.outputFormat, meta };
  }
}

/**
 * HTTP 状态检查：5xx/429 → PROVIDER_UNAVAILABLE（瞬态，可重试，含 Retry-After 语义）；
 * 4xx → RUNNER_ERROR（业务失败，不重试）。编码进 err.code 供 isTransientError 判定。
 */
/* ---------------- R6-19：响应解析（宽松形状 + 异步任务轮询 + 错误透明化） ---------------- */

/** 响应体安全摘录（≤400 字符）：解析失败时把真实响应带进错误消息，消除"接受方式不明确"。 */
function bodyExcerpt(body: unknown): string {
  let text: string;
  if (typeof body === "string") text = body;
  else {
    try {
      text = JSON.stringify(body);
    } catch {
      text = String(body);
    }
  }
  const trimmed = text.slice(0, 400);
  return text.length > 400 ? `${trimmed}…（共 ${text.length} 字符）` : trimmed;
}

/** 图像引用：dataURL / 裸 base64 / http(s) URL。 */
interface ImageRef {
  kind: "dataUrl" | "b64" | "url";
  value: string;
}

/** 宽松提取：OpenAI 标准（data[0].b64_json|url）+ 常见中转形状（url/image_url/image/images/result/output/base64/dataURL）。 */
function findImageRef(value: unknown, depth = 0): ImageRef | null {
  if (value == null || depth > 4) return null;
  if (typeof value === "string") {
    const v = value.trim();
    if (/^data:image\//i.test(v)) return { kind: "dataUrl", value: v };
    if (/^https?:\/\/\S+$/i.test(v)) return { kind: "url", value: v };
    if (v.length >= 512 && /^[A-Za-z0-9+/=\r\n]+$/.test(v)) return { kind: "b64", value: v.replace(/\s+/g, "") };
    return null;
  }
  if (Array.isArray(value)) {
    for (const item of value) {
      const hit = findImageRef(item, depth + 1);
      if (hit) return hit;
    }
    return null;
  }
  if (typeof value === "object") {
    const obj = value as Record<string, unknown>;
    // 键控 base64 字段：任意长度都接受（测试与真实响应均可能为短串；裸串启发式仅用于泛型值）
    for (const key of ["b64_json", "base64"]) {
      const v = obj[key];
      if (typeof v === "string" && v.trim().length > 0) {
        const t = v.trim();
        if (/^data:/i.test(t)) return { kind: "dataUrl", value: t };
        return { kind: "b64", value: t.replace(/\s+/g, "") };
      }
    }
    for (const key of ["url", "image_url", "image", "images", "result", "results", "output", "outputs", "data"]) {
      if (key in obj) {
        const hit = findImageRef(obj[key], depth + 1);
        if (hit) return hit;
      }
    }
  }
  return null;
}

/** 异步任务 id 探测（task_id/taskId/job_id；含 data/result/output 一层内嵌）。 */
function findTaskId(value: unknown, depth = 0): string | null {
  if (value == null || typeof value !== "object" || depth > 2) return null;
  const obj = value as Record<string, unknown>;
  for (const key of ["task_id", "taskId", "job_id"]) {
    const v = obj[key];
    if (typeof v === "string" && v.length > 0) return v;
  }
  for (const key of ["data", "result", "output"]) {
    const hit = findTaskId(obj[key], depth + 1);
    if (hit) return hit;
  }
  return null;
}

/** http(s) 图像下载 → dataURL（ImageRegistry 仅接受 dataURL 产物；上限 20MB）。 */
async function fetchImageAsDataUrl(
  url: string,
  apiKey: string,
  fetchImpl: typeof fetch,
  timeoutMs: number,
  authHost?: string,
): Promise<string> {
  // 结果图常托管在第三方文件域：仅当与生成端点同 host 时才携带 API Key（防凭据外泄）。
  const headers: Record<string, string> = {};
  try {
    if (authHost && new URL(url).host === authHost) headers.authorization = `Bearer ${apiKey}`;
  } catch {
    // 非法 URL 按无凭据处理
  }
  const res = await fetchImpl(url, {
    headers,
    signal: AbortSignal.timeout(Math.min(timeoutMs, 60_000)),
  });
  if (!res.ok) throw new Error(`图像结果下载失败 HTTP ${res.status}`);
  const buf = Buffer.from(await res.arrayBuffer());
  if (buf.length === 0) throw new Error("图像结果下载为空");
  if (buf.length > 20 * 1024 * 1024) throw new Error("图像结果超过 20MB 上限");
  const type = (res.headers.get("content-type") ?? "image/png").split(";")[0]!.trim() || "image/png";
  return `data:${type};base64,${buf.toString("base64")}`;
}

function refToDataUrl(ref: ImageRef, outputFormat: string): string {
  if (ref.kind === "dataUrl") return ref.value;
  if (ref.kind === "b64") return `data:image/${outputFormat};base64,${ref.value}`;
  return ref.value; // url 形态由调用方下载转 dataURL
}

/** 轮询间隔（测试可注入缩短）。 */
let IMAGE_POLL_INTERVAL_MS = 2_000;

/** 测试钩子：缩短轮询间隔（生产代码勿调）。 */
export function setImagePollIntervalForTests(ms: number): void {
  IMAGE_POLL_INTERVAL_MS = ms;
}

/** 异步任务轮询（P012 登记边界的落地）：GET {generationsUrl}/{taskId}，2s 间隔，上限 timeoutMs；404/405 快速失败。 */
async function pollImageTask(opts: {
  generationsUrl: string;
  taskId: string;
  apiKey: string;
  fetchImpl: typeof fetch;
  timeoutMs: number;
  outputFormat: string;
  authHost?: string;
}): Promise<string> {
  const base = opts.generationsUrl.replace(/\/+$/, "");
  const pollUrl = `${base}/${opts.taskId}`;
  const deadline = Date.now() + Math.max(opts.timeoutMs, 10_000);
  for (;;) {
    if (Date.now() > deadline) {
      throw new Error(`图像任务轮询超时（task ${opts.taskId}）：服务商任务端点未在时限内返回图像`);
    }
    await new Promise((resolve) => setTimeout(resolve, IMAGE_POLL_INTERVAL_MS));
    const res = await opts.fetchImpl(pollUrl, {
      method: "GET",
      headers: { authorization: `Bearer ${opts.apiKey}` },
      signal: AbortSignal.timeout(30_000),
    });
    if (res.status === 404 || res.status === 405) {
      throw new Error(`图像任务查询失败（GET ${pollUrl} → ${res.status}）：该服务商的任务查询端点未知；响应体：${await safeText(res)}`);
    }
    if (!res.ok) throw new Error(`图像任务查询失败 HTTP ${res.status}：${await safeText(res)}`);
    const body: unknown = await res.json().catch(() => null);
    const ref = findImageRef(body);
    if (ref) {
      return ref.kind === "url"
        ? await fetchImageAsDataUrl(ref.value, opts.apiKey, opts.fetchImpl, opts.timeoutMs, opts.authHost)
        : refToDataUrl(ref, opts.outputFormat);
    }
    const status = (body as { status?: unknown } | null)?.status;
    if (typeof status === "string" && /fail|error|cancel/i.test(status)) {
      throw new Error(`图像任务失败（status=${status}）：${bodyExcerpt(body)}`);
    }
    // pending/running → 继续轮询
  }
}

/**
 * 统一响应解析：宽松提取图像（OpenAI 标准与常见中转形状）；探测到异步任务 id 自动轮询；
 * 全部落空时抛出含响应体摘录的透明错误。
 */
async function resolveImageDataUrl(opts: {
  body: unknown;
  label: string;
  generationsUrl: string;
  apiKey: string;
  fetchImpl: typeof fetch;
  timeoutMs: number;
  outputFormat: string;
}): Promise<string> {
  const authHost = (() => {
    try {
      return new URL(opts.generationsUrl).host;
    } catch {
      return undefined;
    }
  })();
  const ref = findImageRef(opts.body);
  if (ref) {
    return ref.kind === "url"
      ? await fetchImageAsDataUrl(ref.value, opts.apiKey, opts.fetchImpl, opts.timeoutMs, authHost)
      : refToDataUrl(ref, opts.outputFormat);
  }
  const taskId = findTaskId(opts.body);
  if (taskId) {
    return pollImageTask({ ...opts, taskId, authHost });
  }
  throw new Error(
    `OpenAI ${opts.label} 响应无法解析（未找到图像数据，也未探测到异步任务 id）；响应体前 400 字符：${bodyExcerpt(opts.body)}`,
  );
}

function assertOk(label: string): (res: Response) => Promise<Response> {
  return async (res) => {
    if (!res.ok) {
      const err = new Error(`OpenAI ${label} ${res.status}：${await safeText(res)}`) as Error & { code?: string };
      err.code = res.status >= 500 || res.status === 429 ? ErrorCode.PROVIDER_UNAVAILABLE : ErrorCode.RUNNER_ERROR;
      throw err;
    }
    return res;
  };
}

/** 工具函数：dataURL / 本地文件 / http(s) 统一转为字节。
 *  allowedLocalRoots：本地（file:///相对路径）参考图白名单根目录（G2 修复，R2-REV）；
 *  仅允许 images/ 已注册落盘目录内文件，防 prompt 诱导读取任意本地文件。 */
export async function bytesFromUri(
  uri: string,
  allowedLocalRoots?: string[],
): Promise<{ bytes: Uint8Array; format: "png" | "jpeg" | "webp" }> {
  const decoded = decodeBase64DataUrl(uri);
  if (decoded) return { bytes: decoded.bytes, format: decoded.format };
  if (/^https?:\/\//i.test(uri)) {
    const res = await fetch(uri);
    if (!res.ok) throw new Error(`参考图下载失败：${uri} ${res.status}`);
    const raw = Buffer.from(await res.arrayBuffer());
    return { bytes: raw, format: sniffFormat(raw) };
  }
  // file:// 或相对路径（联调参数表：主进程透传的本地 URI）。
  const path = uri.startsWith("file://") ? fileURLToPath(uri) : uri;
  const resolved = pathResolve(path);
  if (allowedLocalRoots && allowedLocalRoots.length > 0) {
    const inside = allowedLocalRoots.some((root) => {
      const base = pathResolve(root);
      return resolved === base || resolved.startsWith(base + sep);
    });
    if (!inside) {
      throw new Error(`本地参考图路径不在白名单内（仅限 images/ 已注册目录）：${uri}`);
    }
  }
  const raw = readFileSync(resolved);
  return { bytes: raw, format: sniffFormat(raw) };
}

function sniffFormat(raw: Uint8Array): "png" | "jpeg" | "webp" {
  if (raw[0] === 0x89 && raw[1] === 0x50) return "png";
  if (raw[0] === 0xff && raw[1] === 0xd8) return "jpeg";
  return "webp";
}

async function safeText(res: Response): Promise<string> {
  try {
    return (await res.text()).slice(0, 300);
  } catch {
    return "<不可读响应体>";
  }
}