/**
 * LLM 端点设置页（R6-14：自 KeysPane 拆出；纵向卡片列表，ZCode Provider 配置模式）。
 *
 * - 状态自持（不再上提 Modal）；secrets 身份变化时同步表单，保存后回写。
 * - 多模型来源条目：每条一张卡片（名称/BaseURL/模型 id + 思考档/Key 留空保持不变）；
 *   StatusDot 绿 = Key 已配置；「设为默认」radio 决定激活条目；删除需确认。
 * - 显式保存（busy/校验失败禁用）走 secrets:saveModels，保存即重启服务。
 */
import { useEffect, useState, type ReactElement } from 'react';
import type { SecretsStatus } from '../../types/contracts';
import { StatusDot } from './StatusDot';

export interface LlmEndpointsPaneProps {
  secrets: SecretsStatus | null;
  noBridge: boolean;
  /** 保存成功后回传最新状态（Modal 刷新 secrets + 网关状态）。 */
  onSaved: (status: SecretsStatus) => void;
}

interface ModelDraft {
  id?: string;
  name: string;
  baseUrl: string;
  model: string;
  /** undefined = 未触碰（保留原 Key）；'' = 显式清除。 */
  apiKey?: string;
  thinking: string;
  /** R7-1：图像输入开关（默认开启；纯文本端点关闭）。 */
  imageInput: boolean;
  /** R7-2：最大上下文窗口（表单字符串；'' = 留空使用服务端默认）。 */
  contextWindow: string;
  hasKey?: boolean;
}

const THINKING_OPTIONS: Array<{ value: string; label: string }> = [
  { value: 'off', label: '思考：关' },
  { value: 'low', label: '思考：low' },
  { value: 'medium', label: '思考：medium' },
  { value: 'high', label: '思考：high' },
  { value: 'xhigh', label: '思考：xhigh' },
  { value: 'max', label: '思考：max' },
];

export function LlmEndpointsPane({ secrets, noBridge, onSaved }: LlmEndpointsPaneProps): ReactElement {
  const [models, setModels] = useState<ModelDraft[]>([]);
  const [activeModelId, setActiveModelId] = useState('');
  const [busy, setBusy] = useState(false);
  const [notice, setNotice] = useState<{ kind: 'ok' | 'err'; text: string } | null>(null);

  useEffect(() => {
    if (!secrets) return;
    setModels(
      secrets.models.map((m) => ({ id: m.id, name: m.name, baseUrl: m.baseUrl, model: m.model, thinking: m.thinking, imageInput: m.imageInput, contextWindow: m.contextWindow > 0 ? String(m.contextWindow) : '', hasKey: m.hasKey })),
    );
    setActiveModelId(secrets.activeModelId);
  }, [secrets]);

  const patch = (i: number, part: Partial<ModelDraft>): void => {
    setModels((prev) => prev.map((m, j) => (j === i ? { ...m, ...part } : m)));
  };

  const removeModel = (i: number): void => {
    const target = models[i];
    if (!target) return;
    if (!window.confirm(`删除模型条目「${target.name || target.model || '未命名'}」？保存后生效。`)) return;
    setModels((prev) => prev.filter((_, j) => j !== i));
  };

  async function handleSave(): Promise<void> {
    const bad = models.findIndex((m) => m.baseUrl.trim() === '' || m.model.trim() === '');
    if (bad >= 0) {
      setNotice({ kind: 'err', text: `第 ${bad + 1} 个条目缺少 Base URL 或模型 id（不需要的条目请删除）` });
      return;
    }
    if (!window.aichBridge?.saveModels) return;
    setBusy(true);
    setNotice(null);
    try {
      const st = await window.aichBridge.saveModels(
        models.map((m) => ({
          id: m.id,
          name: m.name,
          baseUrl: m.baseUrl.trim(),
          model: m.model.trim(),
          apiKey: m.apiKey,
          thinking: m.thinking,
          imageInput: m.imageInput,
          contextWindow: Math.min(10_000_000, Math.max(0, Math.floor(Number(m.contextWindow) || 0))) || undefined,
        })),
        activeModelId,
      );
      setModels(st.models.map((m) => ({ id: m.id, name: m.name, baseUrl: m.baseUrl, model: m.model, thinking: m.thinking, imageInput: m.imageInput, contextWindow: m.contextWindow > 0 ? String(m.contextWindow) : '', hasKey: m.hasKey })));
      setActiveModelId(st.activeModelId);
      onSaved(st);
      setNotice({ kind: 'ok', text: `已保存 ${st.models.length} 个模型条目，本地服务重启生效中…` });
    } catch (err) {
      setNotice({ kind: 'err', text: `保存失败：${(err as Error).message}` });
    } finally {
      setBusy(false);
    }
  }

  if (noBridge) {
    return <p className="settings__note">当前环境未连接本地网关（Electron bridge 缺失），不支持端点配置。</p>;
  }

  return (
    <div className="settings__pane-form">
      <p className="settings__hint">
        配置多个对话/分析模型来源（OpenAI 兼容端点），可随时切换默认条目；Key 经系统级加密保存，留空表示保持不变。
      </p>
      {models.map((m, i) => (
        <div key={m.id ?? `draft-${i}`} className={`settings__model ${m.id !== undefined && m.id === activeModelId ? 'is-active' : ''}`}>
          <div className="settings__model-head">
            <label className="settings__model-radio">
              <input
                type="radio"
                name="llm-active-model"
                checked={m.id !== undefined && m.id === activeModelId}
                onChange={() => m.id !== undefined && setActiveModelId(m.id)}
              />
              设为默认
            </label>
            <StatusDot ok={m.hasKey === true} title={m.hasKey ? 'Key 已配置' : '未配置 Key'} />
            <span className="settings__tag">{m.hasKey ? 'Key 已存' : '未配 Key'}</span>
            <button type="button" className="settings__link settings__link--danger" disabled={busy} onClick={() => removeModel(i)}>
              删除
            </button>
          </div>
          <div className="settings__row-inline">
            <input
              className="settings__input settings__input--grow"
              placeholder="名称，如 DeepSeek 官方"
              value={m.name}
              onChange={(e) => patch(i, { name: e.target.value })}
              aria-label="条目名称"
            />
            <input
              className="settings__input settings__input--grow"
              placeholder="Base URL，如 https://api.deepseek.com/v1"
              value={m.baseUrl}
              onChange={(e) => patch(i, { baseUrl: e.target.value })}
              aria-label="Base URL"
            />
          </div>
          <div className="settings__row-inline">
            <input
              className="settings__input settings__input--grow"
              placeholder="模型 id，如 deepseek-chat"
              value={m.model}
              onChange={(e) => patch(i, { model: e.target.value })}
              aria-label="模型 id"
            />
            <select
              className="settings__input settings__select"
              value={m.thinking}
              onChange={(e) => patch(i, { thinking: e.target.value })}
              aria-label="思考档位"
            >
              {THINKING_OPTIONS.map((o) => (
                <option key={o.value} value={o.value}>
                  {o.label}
                </option>
              ))}
            </select>
          </div>
          <details className="settings__advanced">
            <summary className="settings__advanced-summary">高级设置</summary>
            <div className="settings__advanced-body">
              <label className="settings__advanced-row" title="本条目模型的最大上下文窗口（tokens）。留空使用服务端默认（DeepSeek 官方为 1M）；用于用量面板的上下文占比显示">
                <span className="settings__advanced-label">上下文窗口</span>
                <input
                  className="settings__input settings__input--grow"
                  type="number"
                  min={0}
                  step={1000}
                  placeholder="留空使用默认"
                  value={m.contextWindow}
                  onChange={(e) => patch(i, { contextWindow: e.target.value })}
                  aria-label="最大上下文窗口（tokens）"
                />
              </label>
              <label className="settings__advanced-row" title="端点支持图像输入时，上传/生成的图片将以视觉内容交给模型；纯文本端点请关闭（否则上游会报错）">
                <span className="settings__advanced-label">图像输入</span>
                <input
                  type="checkbox"
                  checked={m.imageInput}
                  onChange={(e) => patch(i, { imageInput: e.target.checked })}
                />
              </label>
            </div>
          </details>
          <input
            className="settings__input"
            type="password"
            placeholder={m.hasKey ? '输入新 Key 覆盖（留空保持不变）' : 'sk-…'}
            value={m.apiKey ?? ''}
            onChange={(e) => patch(i, { apiKey: e.target.value })}
            aria-label="API Key"
            autoComplete="off"
          />
        </div>
      ))}
      <button
        type="button"
        className="settings__btn settings__btn--ghost settings__btn--sm"
        disabled={busy}
        onClick={() => setModels((prev) => [...prev, { name: '', baseUrl: '', model: '', thinking: 'off', imageInput: true, contextWindow: '' }])}
      >
        ＋ 添加模型
      </button>
      {notice !== null && <p className={`settings__notice ${notice.kind === 'ok' ? 'is-ok' : 'is-err'}`}>{notice.text}</p>}
      <button type="button" className="settings__btn" disabled={busy || models.length === 0} onClick={() => void handleSave()}>
        {busy ? '保存中…' : '保存并应用（重启本地服务）'}
      </button>
    </div>
  );
}
