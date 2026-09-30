/**
 * ImageRegistry（P012/B-4 会话图像元数据注册，2026-08-12）。
 *
 * 职责：
 * - 图像落盘到 sessions 邻近 images/ 目录（路径随 JsonlSessionStore.sessionsDir 派生，避免魔法路径）：
 *   `<sessionsDir>/images/<imageId>.png`；
 * - 会话内注册表：图像元数据（imageId / prompt / model / provider / cost / 父版本 / 参考图）随会话
 *   jsonl 同步追加（kind="image"，与 JsonlSessionStore 既有同步追加模式一致）；
 * - imageId → file:// URL 内存映射：供 image_edit 的 images[] 参考解析（回退/编辑链路）。
 *
 * 字段映射（§6.4 / ImageMeta 冻结结构）：
 * - parentImageId / refImageId / maskId 直接映射同名字段
 *   （R7-1：refPlanVersionId 随方案链路移除；ImageMeta.parentVersionId 保留为冻结字段但不再写入）。
 */

import { existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import type { ImageMeta } from "@aichdesign/shared";
import { decodeBase64DataUrl } from "@aichdesign/extensions";
import type { ImageApiResult } from "../adapters/image-api.js";
import type { JsonlSessionStore } from "../session/jsonl-store.js";

/** B-4 注册附加上下文（源自 AgentRequest 的父图/参考图/遮罩引用）。 */
export interface ImageRegisterContext {
  /** 来源图像版本 id（editImage.imageId，B-4 版本树父节点）。 */
  parentImageId?: string;
  /** 参考图 id（genImage.refImageId，落盘回填）。 */
  refImageId?: string;
  /** 编辑遮罩 id（editImage.maskId，落盘回填）。 */
  maskId?: string;
}

/** 注册后产物（done image 载荷形状，AgentResponse.kind="image"）。 */
export interface RegisteredImage {
  imageId: string;
  /** 本地 file:// URL（落盘后），与冻结文本「url 为本地 file:// 或 dataURL」一致。 */
  url: string;
  meta: ImageMeta;
}

export class ImageRegistry {
  private readonly sessionsDir: string;
  private readonly imagesDir: string;
  private readonly byId = new Map<string, string>();

  /** sessionsDir 派生 images 目录（避免魔法路径；与 JsonlSessionStore.sessionsDir 同源）。 */
  constructor(
    sessionsDir: string,
    private readonly sessionStore?: JsonlSessionStore | null,
  ) {
    this.sessionsDir = sessionsDir;
    this.imagesDir = join(sessionsDir, "images");
  }

  /** images/ 目录（供外部校验/清理）。 */
  get dir(): string {
    return this.imagesDir;
  }

  /**
   * 落盘 + 注册（同步写，单写者约定——与 JsonlSessionStore.appendFileSync 同模式）。
   * result.url 为 dataURL（端口产物）；落盘后 url 替换为 file:// 并随会话 jsonl 登记。
   */
  store(sessionId: string, result: ImageApiResult, context?: ImageRegisterContext): RegisteredImage {
    const bytes = decodeBase64DataUrl(result.url)?.bytes;
    if (!bytes) {
      throw new Error(`ImageRegistry.store 仅接受 dataURL 图像产物：${result.imageId}`);
    }
    mkdirSync(this.imagesDir, { recursive: true });
    const ext = result.format === "jpeg" ? "jpg" : result.format;
    const file = join(this.imagesDir, `${result.imageId}.${ext}`);
    writeFileSync(file, Buffer.from(bytes));

    const meta: ImageMeta = {
      ...result.meta,
      parentImageId: context?.parentImageId ?? result.meta.parentImageId,
      refImageId: context?.refImageId ?? result.meta.refImageId,
      maskId: context?.maskId ?? result.meta.maskId,
      status: "succeeded",
      createdAt: result.meta.createdAt ?? new Date().toISOString(),
    };
    const url = pathToFileURL(file).href;
    this.byId.set(result.imageId, url);

    this.sessionStore?.append(
      sessionId,
      "image",
      { imageId: result.imageId, url, meta },
      // requestId 由工具执行上下文决定；注册条目允许缺省（SessionEntry.requestId 可选）。
      undefined,
    );
    return { imageId: result.imageId, url, meta };
  }

  /** imageId → 已注册 file:// URL（image_edit 参考解析用；未注册返回 undefined）。 */
  resolveUrl(imageId: string): string | undefined {
    return this.byId.get(imageId);
  }

  /**
   * R7-1：从会话 jsonl 重建 imageId → file:// 映射（启动时调用一次）。
   * 修复根因：byId 纯内存，服务重启（设置保存即重启）后全部 imageId 失效——
   * analysisImages 组装与 image_edit 参考解析静默落空，图片"上传成功却读不到"。
   * 只回填文件仍存在的条目；返回回填数量。
   */
  rehydrate(): number {
    let entries: Array<import("node:fs").Dirent>;
    try {
      entries = readdirSync(this.sessionsDir, { withFileTypes: true });
    } catch {
      return 0;
    }
    let restored = 0;
    for (const entry of entries) {
      if (!entry.isFile() || !entry.name.endsWith(".jsonl")) continue;
      let raw: string;
      try {
        raw = readFileSync(join(this.sessionsDir, entry.name), "utf8");
      } catch {
        continue;
      }
      for (const line of raw.split("\n")) {
        const trimmed = line.trim();
        if (trimmed === "") continue;
        try {
          const parsed = JSON.parse(trimmed) as { kind?: unknown; data?: unknown };
          if (parsed.kind !== "image") continue;
          const data = parsed.data as { imageId?: unknown; url?: unknown } | null;
          if (typeof data?.imageId !== "string" || typeof data?.url !== "string") continue;
          if (!data.url.startsWith("file://") || this.byId.has(data.imageId)) continue;
          if (!existsSync(fileURLToPath(data.url))) continue;
          this.byId.set(data.imageId, data.url);
          restored += 1;
        } catch {
          // 损坏行跳过（与 JsonlSessionStore 容错一致）。
        }
      }
    }
    return restored;
  }
}