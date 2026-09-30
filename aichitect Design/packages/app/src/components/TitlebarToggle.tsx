/**
 * TitlebarToggle —— 标题栏统一开关按钮（R7-2）：
 * 左侧边栏（左上）与右侧图像画布（右上）共用同一组件/样式/操作逻辑——
 * 单击切换、图标表意（面板开合）、tooltip 提示当前动作、no-drag 可点。
 */

import type { ReactElement } from 'react';

export interface TitlebarToggleProps {
  /** 面板当前是否展开 */
  open: boolean;
  /** side=left → 左栏图标；side=right → 右栏图标 */
  side: 'left' | 'right';
  onClick: () => void;
}

/** 面板开合图标（展开 = 面板实心侧在对应方向；收起 = 面板线框贴近边缘）。 */
function PanelIcon({ side, open }: { side: 'left' | 'right'; open: boolean }): ReactElement {
  // 16×16 viewBox：外框 + 侧板（实心 = 展开）
  const panelX = side === 'left' ? 2 : 9.5;
  const panelW = open ? 4.5 : 2.5;
  const boardX = side === 'left' ? 7.5 : 2;
  const boardW = open ? 6.5 : 12;
  return (
    <svg width="16" height="16" viewBox="0 0 16 16" aria-hidden="true">
      <rect x={boardX} y="2.5" width={boardW} height="11" rx="1.5" fill="none" stroke="currentColor" strokeWidth="1.4" />
      <rect x={panelX} y="2.5" width={panelW} height="11" rx="1.2" fill="currentColor" opacity={open ? 0.9 : 0.45} />
    </svg>
  );
}

export function TitlebarToggle(props: TitlebarToggleProps): ReactElement {
  const { open, side, onClick } = props;
  const label = side === 'left' ? (open ? '收起侧边栏' : '展开侧边栏') : (open ? '收起图像画布' : '展开图像画布');
  return (
    <button type="button" className="titlebar-toggle" onClick={onClick} title={label} aria-label={label} aria-pressed={open}>
      <PanelIcon side={side} open={open} />
    </button>
  );
}
