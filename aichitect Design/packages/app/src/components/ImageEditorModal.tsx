/**
 * ImageEditorModal —— 图片手动编辑器（R7-2，react-filerobot-image-editor 封装）：
 * 裁切 / 旋转 / 翻转 / 画笔 / 箭头 / 文字标注 / 形状。
 * 与「图生图」的区分：本编辑器为用户本地手动修改（产物为新图像版本，parentImageId
 * 保留血缘）；图生图在对话中由 AI 按描述重新生成。
 * onSave 产出 dataURL → 上层经 registerImage 注册 → addRegisteredImage 入画布。
 */

import { useMemo, type ReactElement } from 'react';
import FilerobotImageEditor, { TABS, TOOLS } from 'react-filerobot-image-editor';

export interface ImageEditorModalProps {
  /** 已解析的可显示 src（dataURL；file:// 需上层先经 resolveImageSrcs 转换） */
  src: string;
  /** 图像名（保存文件名用） */
  name: string;
  onClose: () => void;
  onSave: (dataUrl: string) => void;
}

export function ImageEditorModal(props: ImageEditorModalProps): ReactElement {
  const { src, name, onClose, onSave } = props;

  const config = useMemo(
    () => ({
      source: src,
      // 工具集：调整（裁切/旋转/翻转）+ 微调 + 标注（画笔/箭头/文字/形状，Annotate 标签页原生提供）+ 尺寸
      tabsIds: [TABS.ADJUST, TABS.FINETUNE, TABS.ANNOTATE, TABS.RESIZE],
      defaultTabId: TABS.ADJUST,
      defaultToolId: TOOLS.CROP,
      annotationsCommon: { fill: '#ff4d4f' },
      savingPixelRatio: 1,
      previewPixelRatio: 1,
      useBackendImageResizer: false,
      onSave: (editedImage: { imageBase64?: string; imageCanvas?: HTMLCanvasElement; fullName?: string }) => {
        if (editedImage.imageBase64) {
          onSave(editedImage.imageBase64.startsWith('data:') ? editedImage.imageBase64 : `data:image/png;base64,${editedImage.imageBase64}`);
          return;
        }
        if (editedImage.imageCanvas) {
          onSave(editedImage.imageCanvas.toDataURL('image/png'));
        }
      },
      onClose,
    }),
    [src, onSave, onClose],
  );

  return (
    <div className="preview-overlay editor-overlay" role="dialog" aria-modal="true" aria-label={`编辑图像：${name}`}>
      <div className="preview-overlay__backdrop" onClick={onClose} aria-hidden="true" />
      <div className="editor-shell">
        <header className="editor-shell__bar">
          <span className="editor-shell__title">编辑图像（手动修改 · 保存为新版本）</span>
          <span className="editor-shell__name">{name}</span>
          <button type="button" className="editor-shell__close" onClick={onClose} aria-label="关闭编辑器">✕</button>
        </header>
        <div className="editor-shell__body">
          <FilerobotImageEditor {...config} />
        </div>
      </div>
    </div>
  );
}
