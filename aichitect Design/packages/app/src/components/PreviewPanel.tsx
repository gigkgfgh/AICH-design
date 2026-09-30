/**
 * PreviewPanel —— 右侧图像画布坞（R7-2）：
 * 「收起」移入标题栏统一开关（TitlebarToggle），本面板只保留弹出浮层；
 * 「生成图像」入口移除——生成一律在对话中进行。
 */

import { useEffect, type ReactElement } from 'react';
import { ImageCanvas, type ImageCanvasProps } from './ImageCanvas';

export interface PreviewPanelProps {
  /** 弹出为全屏浮层（null = 停靠） */
  poppedOut: boolean;
  onTogglePopOut: () => void;
  /** 图像数量徽标 */
  imageCount: number;
  /** 画布内容（图像流状态） */
  canvas: Omit<ImageCanvasProps, 'onOpen' | 'onEdit' | 'onReference' | 'onRemove' | 'onDuplicate'>;
  onOpenImage: ImageCanvasProps['onOpen'];
  onEditImage: ImageCanvasProps['onEdit'];
  onReferenceImage: ImageCanvasProps['onReference'];
  onRemoveImage: ImageCanvasProps['onRemove'];
  onDuplicateImage: ImageCanvasProps['onDuplicate'];
}

export function PreviewPanel(props: PreviewPanelProps): ReactElement {
  const { poppedOut, onTogglePopOut, imageCount, canvas, onOpenImage, onEditImage, onReferenceImage, onRemoveImage, onDuplicateImage } = props;

  // 浮层打开时 Esc 关闭
  useEffect(() => {
    if (!poppedOut) return;
    const onKey = (e: KeyboardEvent): void => {
      if (e.key === 'Escape') onTogglePopOut();
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [poppedOut, onTogglePopOut]);

  const panel = (
    <section className={`preview-panel ${poppedOut ? 'preview-panel--popped' : ''}`} aria-label="图像画布">
      <header className="preview-panel__tabs" role="toolbar" aria-label="画布工具条">
        <span className="preview-panel__tab is-active" aria-current="true">
          图像画布
          {imageCount > 0 && <span className="preview-panel__badge">{imageCount}</span>}
        </span>
        <span className="preview-panel__spacer" />
        <button
          type="button"
          className="preview-panel__action"
          onClick={onTogglePopOut}
          title={poppedOut ? '收起浮层（Esc）' : '弹出全屏画布'}
        >
          {poppedOut ? '✕ 收起' : '⤢ 弹出'}
        </button>
      </header>
      <div className="preview-panel__body preview-panel__body--canvas">
        <ImageCanvas
          {...canvas}
          onOpen={onOpenImage}
          onEdit={onEditImage}
          onReference={onReferenceImage}
          onRemove={onRemoveImage}
          onDuplicate={onDuplicateImage}
        />
      </div>
    </section>
  );

  if (poppedOut) {
    return (
      <div className="preview-overlay" role="dialog" aria-modal="true" aria-label="全屏图像画布">
        <div className="preview-overlay__backdrop" onClick={onTogglePopOut} aria-hidden="true" />
        {panel}
      </div>
    );
  }
  return panel;
}
