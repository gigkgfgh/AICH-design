/**
 * CanvasContextMenu —— 画布图片右键菜单（R7-2）：
 * fixed 定位（光标处，越界翻转）、外点/Esc 关闭。
 * 菜单项：删除 / 复制 / 编辑 / 在对话中引用 / 查看提示词与参数 / 放大预览。
 * 配套 ImageInfoOverlay：ImageMeta 只读信息浮层。
 */

import { useEffect, useRef, type ReactElement } from 'react';
import type { ImageVersion } from '../types/contracts';

export interface CanvasMenuActions {
  remove: (image: ImageVersion) => void;
  duplicate: (image: ImageVersion) => void;
  edit: (image: ImageVersion) => void;
  reference: (image: ImageVersion) => void;
  info: (image: ImageVersion) => void;
  open: (image: ImageVersion) => void;
}

export interface CanvasContextMenuProps {
  x: number;
  y: number;
  image: ImageVersion;
  actions: CanvasMenuActions;
  onClose: () => void;
}

const MENU_W = 176;
const MENU_H_EST = 216;

export function CanvasContextMenu(props: CanvasContextMenuProps): ReactElement {
  const { x, y, image, actions, onClose } = props;
  const ref = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const onDown = (e: MouseEvent): void => {
      if (ref.current && !ref.current.contains(e.target as Node)) onClose();
    };
    const onKey = (e: KeyboardEvent): void => {
      if (e.key === 'Escape') onClose();
    };
    window.addEventListener('mousedown', onDown, true);
    window.addEventListener('keydown', onKey);
    return () => {
      window.removeEventListener('mousedown', onDown, true);
      window.removeEventListener('keydown', onKey);
    };
  }, [onClose]);

  const left = Math.min(x, window.innerWidth - MENU_W - 8);
  const top = Math.min(y, window.innerHeight - MENU_H_EST - 8);

  const run = (fn: (img: ImageVersion) => void) => () => {
    onClose();
    fn(image);
  };

  return (
    <div className="canvas-menu" ref={ref} role="menu" style={{ left, top }}>
      <button type="button" role="menuitem" onClick={run(actions.open)}>🔍 放大预览</button>
      <button type="button" role="menuitem" onClick={run(actions.reference)}>💬 在对话中引用</button>
      <button type="button" role="menuitem" onClick={run(actions.edit)}>✎ 编辑</button>
      <button type="button" role="menuitem" onClick={run(actions.duplicate)}>⧉ 复制</button>
      <button type="button" role="menuitem" onClick={run(actions.info)}>ℹ 查看提示词与参数</button>
      <div className="canvas-menu__divider" role="separator" />
      <button type="button" role="menuitem" className="canvas-menu__danger" onClick={run(actions.remove)}>
        🗑 删除<span className="canvas-menu__kbd">Del</span>
      </button>
    </div>
  );
}

/** ImageMeta 只读信息浮层（查看提示词与参数）。 */
export function ImageInfoOverlay(props: { image: ImageVersion; onClose: () => void }): ReactElement {
  const { image, onClose } = props;
  useEffect(() => {
    const onKey = (e: KeyboardEvent): void => {
      if (e.key === 'Escape') onClose();
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [onClose]);

  const meta = image.meta;
  const rows: Array<[string, string]> = [
    ['提示词', meta.prompt || '（无）'],
    ['模型', meta.model || '—'],
    ['来源', meta.provider || '—'],
    ['尺寸', meta.width && meta.height ? `${meta.width} × ${meta.height}` : '—'],
    ['耗时', meta.durationMs ? `${(meta.durationMs / 1000).toFixed(1)}s` : '—'],
    ['费用', meta.costUsd !== undefined ? `$${meta.costUsd.toFixed(4)}` : '—'],
    ['创建时间', meta.createdAt ?? image.createdAt],
    ['父图像', meta.parentImageId ?? '—'],
    ['图像 id', image.imageId],
  ];

  return (
    <div className="preview-overlay" role="dialog" aria-modal="true" aria-label="图像参数">
      <div className="preview-overlay__backdrop" onClick={onClose} aria-hidden="true" />
      <div className="image-info">
        <header className="image-info__bar">
          <span className="image-info__title">提示词与参数</span>
          <button type="button" className="image-info__close" onClick={onClose} aria-label="关闭">✕</button>
        </header>
        <dl className="image-info__rows">
          {rows.map(([k, v]) => (
            <div key={k} className="image-info__row">
              <dt>{k}</dt>
              <dd title={v}>{v}</dd>
            </div>
          ))}
        </dl>
      </div>
    </div>
  );
}
