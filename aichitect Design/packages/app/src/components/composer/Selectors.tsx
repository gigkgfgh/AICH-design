/**
 * Composer 选择器（R5，ZCode 风格输入区下边缘）：
 * - AgentSelector：左下角子 agent 选择（主 Agent 自动路由 / 方案起草 / 图像生成 / 案例调研）
 * - ModelSelector：右下角模型选择（服务端缺省 + 已配置模型 + 常用预设）
 * - ThinkingSelector：思考深度档位（off/low/medium/high/xhigh/max；R6-18 删除 minimal）
 */

import { useEffect, useRef, useState, type ReactElement } from 'react';
import type { SubAgentId, ThinkingLevel } from '../../types/contracts';

/* ---------------- 下拉菜单通用壳（PlusMenu 复用） ---------------- */

export function Dropdown(props: { label: ReactElement; children: (close: () => void) => ReactElement }): ReactElement {
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (!open) return;
    const onDown = (e: MouseEvent): void => {
      if (ref.current && !ref.current.contains(e.target as Node)) setOpen(false);
    };
    const onKey = (e: KeyboardEvent): void => {
      if (e.key === 'Escape') setOpen(false);
    };
    window.addEventListener('mousedown', onDown);
    window.addEventListener('keydown', onKey);
    return () => {
      window.removeEventListener('mousedown', onDown);
      window.removeEventListener('keydown', onKey);
    };
  }, [open]);
  return (
    <div className="composer-menu" ref={ref}>
      <button type="button" className="composer-menu__trigger" onClick={() => setOpen((v) => !v)}>
        {props.label}
      </button>
      {open && <div className="composer-menu__panel">{props.children(() => setOpen(false))}</div>}
    </div>
  );
}

/* ---------------- Agent 选择器 ---------------- */

const AGENTS: Array<{ id: SubAgentId; icon: string; name: string; description: string; beta?: boolean }> = [
  { id: 'main', icon: '✦', name: '主 Agent', description: '通用对话；按意图自动分派图像 / 调研' },
  { id: 'image-gen', icon: '▣', name: '图像生成', description: '生成与编辑建筑表现图（首要功能）' },
  { id: 'research', icon: '◎', name: '案例调研', description: '联网检索案例 / 规范 / 材料参考' },
];

export function AgentSelector(props: { value: SubAgentId; onChange: (v: SubAgentId) => void; disabled?: boolean }): ReactElement {
  const current = AGENTS.find((a) => a.id === props.value) ?? AGENTS[0]!;
  return (
    <Dropdown
      label={
        <>
          <span className="composer-menu__icon">{current.icon}</span>
          <span>{current.name}</span>
          <span className="composer-menu__caret">▾</span>
        </>
      }
    >
      {(close) => (
        <ul className="composer-menu__list">
          {AGENTS.map((a) => (
            <li key={a.id}>
              <button
                type="button"
                className={`composer-menu__item ${a.id === props.value ? 'is-active' : ''}`}
                disabled={props.disabled}
                onClick={() => {
                  props.onChange(a.id);
                  close();
                }}
              >
                <span className="composer-menu__item-head">
                  <span className="composer-menu__icon">{a.icon}</span>
                  <span className="composer-menu__item-name">{a.name}</span>
                  {a.beta && <span className="composer-menu__item-beta">Beta</span>}
                  {a.id === props.value && <span className="composer-menu__check">✓</span>}
                </span>
                <span className="composer-menu__item-desc">{a.description}</span>
              </button>
            </li>
          ))}
        </ul>
      )}
    </Dropdown>
  );
}

/* ---------------- 模型选择器（R6-7：仅已配置模型；无配置时仅显示默认项，仍可见） ---------------- */

export function ModelSelector(props: {
  /** '' = 服务端缺省（激活模型） */
  value: string;
  onChange: (v: string) => void;
  /** 已配置的自定义模型 id 列表（密钥管理页维护） */
  configuredModels?: Array<{ id: string; model: string; name: string }>;
  disabled?: boolean;
}): ReactElement {
  const configured = props.configuredModels ?? [];
  const models = [
    { id: '', label: '默认模型' },
    ...configured.map((m) => ({ id: m.model, label: `${m.name || m.model}（${m.model}）` })),
  ];
  const current = models.find((m) => m.id === props.value) ?? models[0]!;
  return (
    <Dropdown
      label={
        <>
          <span className="composer-menu__icon">⌘</span>
          <span className="composer-menu__name">{current.label}</span>
          <span className="composer-menu__caret">▾</span>
        </>
      }
    >
      {(close) => (
        <ul className="composer-menu__list">
          {models.map((m) => (
            <li key={m.id || '__default'}>
              <button
                type="button"
                className={`composer-menu__item composer-menu__item--row ${m.id === props.value ? 'is-active' : ''}`}
                disabled={props.disabled}
                onClick={() => {
                  props.onChange(m.id);
                  close();
                }}
              >
                <span>{m.label}</span>
                {m.id === props.value && <span className="composer-menu__check">✓</span>}
              </button>
            </li>
          ))}
        </ul>
      )}
    </Dropdown>
  );
}

/* ---------------- 思考深度选择器（pi-ai 原生档位） ---------------- */

const THINKING_LEVELS: Array<{ id: ThinkingLevel; label: string; hint: string }> = [
  { id: 'off', label: '关闭', hint: '不传 reasoning（最快）' },
  { id: 'low', label: '低', hint: 'low' },
  { id: 'medium', label: '中', hint: 'medium' },
  { id: 'high', label: '高', hint: 'high' },
  { id: 'xhigh', label: '很高', hint: 'xhigh' },
  { id: 'max', label: '最大', hint: 'max' },
];

export function ThinkingSelector(props: { value: ThinkingLevel; onChange: (v: ThinkingLevel) => void; disabled?: boolean }): ReactElement {
  const current = THINKING_LEVELS.find((t) => t.id === props.value) ?? THINKING_LEVELS[0]!;
  return (
    <Dropdown
      label={
        <>
          <span className="composer-menu__icon">✎</span>
          <span>思考：{current.label}</span>
          <span className="composer-menu__caret">▾</span>
        </>
      }
    >
      {(close) => (
        <ul className="composer-menu__list">
          {THINKING_LEVELS.map((t) => (
            <li key={t.id}>
              <button
                type="button"
                className={`composer-menu__item composer-menu__item--row ${t.id === props.value ? 'is-active' : ''}`}
                disabled={props.disabled}
                onClick={() => {
                  props.onChange(t.id);
                  close();
                }}
              >
                <span>思考深度：{t.label}</span>
                <span className="composer-menu__item-tag">{t.hint}</span>
              </button>
            </li>
          ))}
        </ul>
      )}
    </Dropdown>
  );
}
