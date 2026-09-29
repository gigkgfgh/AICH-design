/**
 * PreviewPanel —— 右侧预览坞（P-R3 三列重构）：
 * Tab 切换（方案/表现图/版本树）+ 折叠 + 「弹出」全屏浮层（Esc 关闭）。
 * 面板内容由 App 注入（ReactNode 插槽），组件只管壳与状态。
 */

import { useEffect, type ReactElement, type ReactNode } from 'react';

export type PreviewTab = 'plan' | 'images' | 'versions';

export interface PreviewPanelProps {
  activeTab: PreviewTab;
  onTabChange: (tab: PreviewTab) => void;
  collapsed: boolean;
  onToggleCollapse: () => void;
  /** 弹出为全屏浮层（null = 停靠） */
  poppedOut: boolean;
  onTogglePopOut: () => void;
  /** 各 Tab 内容（App 注入） */
  planNode: ReactNode;
  imagesNode: ReactNode;
  versionsNode: ReactNode;
  /** Tab 徽标计数（如图像数量；缺省不显示） */
  badges?: Partial<Record<PreviewTab, number>>;
}

const TABS: Array<{ key: PreviewTab; label: string }> = [
  { key: 'plan', label: '方案' },
  { key: 'images', label: '表现图' },
  { key: 'versions', label: '版本树' },
];

export function PreviewPanel(props: PreviewPanelProps): ReactElement {
  const { activeTab, onTabChange, collapsed, onToggleCollapse, poppedOut, onTogglePopOut, badges } = props;

  // 浮层打开时 Esc 关闭 + 阻止背景滚动
  useEffect(() => {
    if (!poppedOut) return;
    const onKey = (e: KeyboardEvent): void => {
      if (e.key === 'Escape') onTogglePopOut();
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [poppedOut, onTogglePopOut]);

  if (collapsed) {
    return (
      <button
        type="button"
        className="preview-rail"
        onClick={onToggleCollapse}
        title="展开预览面板"
        aria-label="展开预览面板"
      >
        ◀
      </button>
    );
  }

  const content = activeTab === 'plan' ? props.planNode : activeTab === 'images' ? props.imagesNode : props.versionsNode;

  const panel = (
    <section className={`preview-panel ${poppedOut ? 'preview-panel--popped' : ''}`} aria-label="预览面板">
      <header className="preview-panel__tabs" role="tablist">
        {TABS.map((t) => (
          <button
            key={t.key}
            type="button"
            role="tab"
            aria-selected={activeTab === t.key}
            className={`preview-panel__tab ${activeTab === t.key ? 'is-active' : ''}`}
            onClick={() => onTabChange(t.key)}
          >
            {t.label}
            {badges?.[t.key] !== undefined && badges[t.key]! > 0 && (
              <span className="preview-panel__badge">{badges[t.key]}</span>
            )}
          </button>
        ))}
        <span className="preview-panel__spacer" />
        <button
          type="button"
          className="preview-panel__action"
          onClick={onTogglePopOut}
          title={poppedOut ? '收起浮层（Esc）' : '弹出全屏预览'}
        >
          {poppedOut ? '✕ 收起' : '⤢ 弹出'}
        </button>
        {!poppedOut && (
          <button
            type="button"
            className="preview-panel__action"
            onClick={onToggleCollapse}
            title="折叠预览面板"
          >
            ▶
          </button>
        )}
      </header>
      <div className="preview-panel__body">{content}</div>
    </section>
  );

  if (poppedOut) {
    return (
      <div className="preview-overlay" role="dialog" aria-modal="true" aria-label="全屏预览">
        <div className="preview-overlay__backdrop" onClick={onTogglePopOut} aria-hidden="true" />
        {panel}
      </div>
    );
  }
  return panel;
}
