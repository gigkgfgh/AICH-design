/**
 * StatusDot（R6-14）：状态圆点原语（ZCode settings/StatusDot 同构）——
 * ok=true 绿色（已配置/正常），否则灰色（未配置）。仅视觉指示，不承载交互。
 */
import type { ReactElement } from 'react';

export function StatusDot(props: { ok: boolean; title?: string }): ReactElement {
  return <span className={`status-dot ${props.ok ? 'status-dot--ok' : ''}`} title={props.title} aria-hidden="true" />;
}
