/**
 * AttachmentBar —— 附件 chips（R6-4：上传按钮移入加号菜单，本组件只管 chips 展示与移除；
 * ingestFiles 为共享的文件处理管线，供 PlusMenu 调用）。
 */

import type { ReactElement } from 'react';
import type { Attachment } from '../../types/contracts';

const IMAGE_TYPES = ['image/png', 'image/jpeg', 'image/webp'];
const MAX_TEXT_BYTES = 50 * 1024;
const MAX_IMAGE_BYTES = 20 * 1024 * 1024;

export const ATTACHMENT_ACCEPT = `${IMAGE_TYPES.join(',')},.txt,.md,.json,.log,.csv`;

let attachSeq = 0;
function nextAttachmentId(): string {
  attachSeq += 1;
  return `att-${Date.now().toString(36)}-${attachSeq}`;
}

function readFileAsDataUrl(file: File): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(String(reader.result));
    reader.onerror = () => reject(reader.error ?? new Error('文件读取失败'));
    reader.readAsDataURL(file);
  });
}

/** 共享文件处理管线：图片 → dataURL + 可选注册；文本 → 内容读取。失败经 onError 上报（不中断其余文件）。 */
export async function ingestFiles(
  files: File[],
  ctx: {
    onAdd: (a: Attachment) => void;
    onRegisterImage?: (dataUrl: string, name: string) => Promise<{ imageId: string; url: string } | null>;
    onError?: (message: string) => void;
  },
): Promise<void> {
  for (const file of files) {
    try {
      if (IMAGE_TYPES.includes(file.type)) {
        if (file.size > MAX_IMAGE_BYTES) {
          ctx.onError?.(`「${file.name}」超过 20MB 上限`);
          continue;
        }
        const dataUrl = await readFileAsDataUrl(file);
        let imageId: string | undefined;
        if (ctx.onRegisterImage) {
          const registered = await ctx.onRegisterImage(dataUrl, file.name).catch((err: Error) => {
            ctx.onError?.(`图片注册失败：${err.message}`);
            return null;
          });
          if (registered) imageId = registered.imageId;
        }
        ctx.onAdd({ id: nextAttachmentId(), type: 'image', name: file.name, imageId, url: dataUrl });
      } else if (file.size <= MAX_TEXT_BYTES) {
        const content = await file.text();
        ctx.onAdd({ id: nextAttachmentId(), type: 'text', name: file.name, content });
      } else {
        ctx.onError?.(`「${file.name}」超过 50KB 文本上限（图片上限 20MB）`);
      }
    } catch (err) {
      ctx.onError?.(`「${file.name}」处理失败：${(err as Error).message}`);
    }
  }
}

export interface AttachmentBarProps {
  attachments: Attachment[];
  onRemove: (id: string) => void;
}

/** 附件 chips 行（图片缩略图/文本图标 + 移除按钮；空列表不渲染）。 */
export function AttachmentBar(props: AttachmentBarProps): ReactElement {
  const { attachments, onRemove } = props;
  if (attachments.length === 0) return <></>;
  return (
    <div className="attachment-bar">
      {attachments.map((a) => (
        <span key={a.id} className={`attachment-chip attachment-chip--${a.type}`} title={a.name}>
          {a.type === 'image' && a.url ? (
            <img className="attachment-chip__thumb" src={a.url} alt={a.name} />
          ) : (
            <span className="attachment-chip__icon">📄</span>
          )}
          <span className="attachment-chip__name">{a.name}</span>
          {a.type === 'image' && !a.imageId && <span className="attachment-chip__tag">未注册</span>}
          <button
            type="button"
            className="attachment-chip__remove"
            aria-label={`移除 ${a.name}`}
            onClick={() => onRemove(a.id)}
          >
            ✕
          </button>
        </span>
      ))}
    </div>
  );
}
