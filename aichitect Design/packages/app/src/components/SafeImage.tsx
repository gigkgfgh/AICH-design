/**
 * SafeImage —— G8 修复：file:// 图像的渲染层兜底。
 *
 * dev 模式渲染源为 http://localhost:5173，Chromium 阻止 <img src="file://…">（黑图）。
 * onError → 经 IPC 主进程白名单读取转 dataURL（仅会话数据目录内，fail-closed）；
 * 兜底结果模块级缓存（同 URL 不重复请求）；失败显示占位样式。dev/prod 统一本组件。
 */

import { useEffect, useState, type ReactElement } from 'react';

/** file:// → dataURL 兜底缓存（模块级，跨组件复用） */
const dataUrlCache = new Map<string, string>();
/** 正在兜底的 URL（防重复并发请求） */
const inflight = new Map<string, Promise<string | null>>();

function fetchFallback(uri: string): Promise<string | null> {
  const cached = dataUrlCache.get(uri);
  if (cached) return Promise.resolve(cached);
  const existing = inflight.get(uri);
  if (existing) return existing;
  const bridge = window.aichBridge;
  if (!bridge?.readImageAsDataUrl) return Promise.resolve(null);
  const p = bridge
    .readImageAsDataUrl(uri)
    .then((dataUrl) => {
      dataUrlCache.set(uri, dataUrl);
      return dataUrl;
    })
    .catch(() => null)
    .finally(() => {
      inflight.delete(uri);
    });
  inflight.set(uri, p);
  return p;
}

/** 批量解析图像地址为可显示 src（file:// → 缓存/IPC 兜底 dataURL；其余原样）。 */
export async function resolveImageSrcs(urls: string[]): Promise<Map<string, string>> {
  const out = new Map<string, string>();
  await Promise.all(
    urls.map(async (url) => {
      if (!url.startsWith('file://')) {
        out.set(url, url);
        return;
      }
      const resolved = await fetchFallback(url);
      if (resolved) out.set(url, resolved);
    }),
  );
  return out;
}

export interface SafeImageProps {
  src: string;
  alt: string;
  className: string;
}

export function SafeImage(props: SafeImageProps): ReactElement {
  const { src, alt, className } = props;
  const [fallback, setFallback] = useState<string | null>(() => dataUrlCache.get(src) ?? null);
  const [failed, setFailed] = useState(false);

  useEffect(() => {
    setFallback(dataUrlCache.get(src) ?? null);
    setFailed(false);
  }, [src]);

  // dataURL/http(s) 直接可显示；file:// 预取兜底（首次显示即无黑闪）
  useEffect(() => {
    if (src.startsWith('file://')) {
      void fetchFallback(src).then((url) => {
        if (url) setFallback(url);
      });
    }
  }, [src]);

  if (fallback) {
    return <img className={className} src={fallback} alt={alt} />;
  }
  if (failed) {
    return (
      <span className={`${className} safe-image--failed`} role="img" aria-label={alt}>
        ⚠ 图像不可用
      </span>
    );
  }
  return (
    <img
      className={className}
      src={src}
      alt={alt}
      onError={() => {
        void fetchFallback(src).then((url) => {
          if (url) {
            setFallback(url);
          } else {
            setFailed(true);
          }
        });
      }}
    />
  );
}
