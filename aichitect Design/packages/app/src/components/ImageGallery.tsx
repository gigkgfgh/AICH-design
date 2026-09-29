/**
 * ImageGallery —— 表现图库（P013；P-R3 接入 SafeImage 兜底修复 G8）
 *
 * - 主图区：当前选中图像（无选中时取最新一张）；file:// 经 SafeImage 主进程白名单转 dataURL
 * - 元数据：prompt / 模型 / 费用 / 时间（meta:ImageMeta 字段，契约权威在 shared）
 * - 卡片流：历史图像缩略卡（点击选中）
 * - 操作：基于当前图编辑（editImage 入口）
 * - 状态覆盖：加载态（生成中…）、空态（暂无表现图）、错误态（最近一次请求错误）
 */
import type { ReactElement } from 'react';
import type { ImageVersion } from '../types/contracts';
import { formatCostUsd, formatTime, summarize } from '../lib/display';
import { SafeImage } from './SafeImage';

export interface ImageGalleryProps {
  images: ImageVersion[];
  currentImageId: string | null;
  /** 图像请求进行中（加载态） */
  loading: boolean;
  /** 最近一次图像请求错误信息（错误态） */
  error: string | null;
  /** 点击卡片选中为当前图 */
  onSelectImage: (image: ImageVersion) => void;
  /** 基于当前图发起编辑（editImage）；可省略（无入口） */
  onEditImage?: (image: ImageVersion) => void;
}

export function ImageGallery(props: ImageGalleryProps): ReactElement {
  const { images, currentImageId, loading, error, onSelectImage, onEditImage } = props;

  const current =
    images.find((img) => img.imageId === currentImageId) ?? images[images.length - 1] ?? null;

  return (
    <section className="image-gallery" aria-label="表现图库">
      <header className="image-gallery__header">
        <h2>表现图库</h2>
        <span className="image-gallery__count">
          {images.length > 0 ? `${images.length} 张` : '暂无'}
        </span>
      </header>

      {error && (
        <div className="image-gallery__error" role="alert">
          {error}
        </div>
      )}

      <div className="image-gallery__main">
        {current ? (
          <SafeImage
            className="image-gallery__hero"
            src={current.url}
            alt={current.meta.prompt || '表现图'}
          />
        ) : (
          <div className="image-gallery__empty">
            <p>暂无表现图</p>
            <p className="image-gallery__empty-hint">
              在画布工具栏点击「生成表现图」，即可将当前平面方案渲染为表现图（离线 mock 演示）。
            </p>
          </div>
        )}
      </div>

      {current && (
        <div className="image-gallery__meta">
          <p className="image-gallery__prompt" title={current.meta.prompt}>
            {summarize(current.meta.prompt, '表现图', 30)}
          </p>
          <p className="image-gallery__details">
            {current.meta.model ?? '—'} · {formatCostUsd(current.meta.costUsd)} ·{' '}
            {formatTime(current.createdAt)}
          </p>
          {onEditImage && (
            <button
              type="button"
              className="image-gallery__edit"
              disabled={loading}
              onClick={() => onEditImage(current)}
              title="以当前表现图为参考，生成一张新图"
            >
              {loading ? '生成中…' : '基于此图编辑'}
            </button>
          )}
        </div>
      )}

      {images.length > 0 && (
        <ul className="image-gallery__list">
          {[...images].reverse().map((img) => {
            const active = img.imageId === current?.imageId;
            return (
              <li key={img.imageId} className={`image-gallery__item ${active ? 'is-active' : ''}`}>
                <button
                  type="button"
                  className="image-gallery__thumb"
                  onClick={() => onSelectImage(img)}
                  title={img.meta.prompt || img.imageId}
                >
                  <SafeImage className="image-gallery__thumb-img" src={img.url} alt={img.meta.prompt || img.imageId} />
                  <span className="image-gallery__thumb-text">
                    {summarize(img.meta.prompt, img.imageId, 14)}
                  </span>
                </button>
              </li>
            );
          })}
        </ul>
      )}

      {loading && (
        <div className="image-gallery__loading" role="status">
          正在生成表现图…
        </div>
      )}
    </section>
  );
}