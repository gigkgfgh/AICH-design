/**
 * 展示格式化工具（P013：VersionTree / ImageGallery 共用）
 */

/** ISO 时间 → 'MM-DD HH:mm'（非法输入返回空串） */
export function formatTime(iso: string): string {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) {
    return '';
  }
  const pad = (n: number): string => String(n).padStart(2, '0');
  return `${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

/** 长文本截断（超长加省略号；空文本回退 fallback） */
export function summarize(text: string | undefined, fallback: string, maxLen = 18): string {
  const value = (text ?? '').trim();
  if (value.length <= maxLen) {
    return value || fallback;
  }
  return `${value.slice(0, maxLen)}…`;
}

/** 费用（美元）格式化：未提供 → '—'；极小值给足小数位 */
export function formatCostUsd(v: number | undefined): string {
  if (v === undefined || !Number.isFinite(v)) {
    return '—';
  }
  if (v < 0.001) {
    return `$${v.toFixed(6)}`;
  }
  return `$${v.toFixed(4)}`;
}