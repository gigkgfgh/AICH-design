/**
 * image-tools Extension（P012，§6.1/6.2 契约）：
 * - 工具定义 image_generate / image_edit（ToolDef，与 plan-tools 同构，parameters 为 JSON Schema）；
 * - gpt-image-2 约束校验层（validate.ts）+ 图像字节尺寸探测（size-probe.ts）。
 *
 * 与 plan-tools 的差异：本 Extension 不含纯执行逻辑——图像生成/编辑经
 * agent-service 的 ImageApiPort（真实 OpenAI / MockImageProvider）执行；
 * 本包负责参数契约与 §6.2 全部约束校验（透明背景拒绝 / inputFidelity 省略 /
 * 尺寸 / 像素 / 宽高比 / 枚举 / edits 入参约束）。
 */

import type { ToolDef } from "@aichdesign/shared";
import { IMAGE_EDIT_MAX_IMAGES, IMAGE_N_MAX, IMAGE_OUTPUT_FORMATS, IMAGE_QUALITIES, IMAGE_SIZE_PRESETS } from "./validate.js";

export * from "./validate.js";
export * from "./size-probe.js";

/** image_generate 工具定义（契约冻结：prompt, size?, quality?, outputFormat?, n?）。 */
export const IMAGE_GENERATE_TOOL_DEF: ToolDef = {
  name: "image_generate",
  description:
    "根据提示词生成建筑表现图（gpt-image-2，OpenAI Image API）。参数：prompt 必填；size 预设 1024x1024/1536x1024/1024x1536/auto；quality low|medium|high；outputFormat png|jpeg|webp；n 1-10。不支持透明背景；不支持自定义尺寸。",
  label: "生成表现图",
  parameters: {
    type: "object",
    properties: {
      prompt: { type: "string" },
      size: { type: "string", enum: [...IMAGE_SIZE_PRESETS] },
      quality: { type: "string", enum: [...IMAGE_QUALITIES] },
      outputFormat: { type: "string", enum: [...IMAGE_OUTPUT_FORMATS] },
      n: { type: "integer", minimum: 1, maximum: IMAGE_N_MAX },
    },
    required: ["prompt"],
    additionalProperties: false,
  },
};

/** image_edit 工具定义（契约冻结：images[], prompt, mask?, inputFidelity?, size?, quality?, n?；inputFidelity 拒绝显式传值）。 */
export const IMAGE_EDIT_TOOL_DEF: ToolDef = {
  name: "image_edit",
  description:
    "基于参考图编辑/生成表现图（gpt-image-2，OpenAI Image API /v1/images/edits multipart）。images[] 为参考图 URI（1-16 张 png/webp/jpg）；mask 为同尺寸 alpha PNG；inputFidelity 当前版本不支持请省略；其余参数同 image_generate。",
  label: "编辑表现图",
  parameters: {
    type: "object",
    properties: {
      images: { type: "array", items: { type: "string" }, minItems: 1, maxItems: IMAGE_EDIT_MAX_IMAGES },
      prompt: { type: "string" },
      mask: { type: "string" },
      inputFidelity: { type: "string", enum: ["high", "low"] },
      size: { type: "string", enum: [...IMAGE_SIZE_PRESETS] },
      quality: { type: "string", enum: [...IMAGE_QUALITIES] },
      outputFormat: { type: "string", enum: [...IMAGE_OUTPUT_FORMATS] },
      n: { type: "integer", minimum: 1, maximum: IMAGE_N_MAX },
    },
    required: ["images", "prompt"],
    additionalProperties: false,
  },
};

export interface ImageToolDefs {
  generate: ToolDef;
  edit: ToolDef;
}

/** 两个图像工具的 ToolDef 集合（main.ts 组装绑定用）。 */
export function imageToolDefs(): ImageToolDefs {
  return { generate: IMAGE_GENERATE_TOOL_DEF, edit: IMAGE_EDIT_TOOL_DEF };
}