/**
 * 图像端点设置页（R6-14：自 KeysPane 拆出；多图像服务商条目，与 LLM 页同构）。
 *
 * - 修复原 bug：此前图像 Key/BaseURL/模型没有提交出口（保存按钮只提交 LLM 列表），
 *   配置"保存成功"却从未写入——本页有独立保存通道 secrets:saveImageModels。
 * - 多服务商条目 + 激活 radio；旧单条目配置由主进程懒迁移为首条目，本页直接可见可改。
 * - 语义：apiKey undefined = 保留原 Key；'' = 清除；非空 = 覆盖。
 */
import { useEffect, useState, type ReactElement } from 'react';
import type { SecretsStatus } from '../../types/contracts';
import { StatusDot } from './StatusDot';

export interface ImageEndpointsPaneProps {
  secrets: SecretsStatus | null;
  noBridge: boolean;
  onSaved: (status: SecretsStatus) => void;
}

interface ImageModelDraft {
  id?: string;
  name: string;
  /** 完整生成端点 URL（用户填写，原样使用，零拼接） */
  url: string;
  /** 完整编辑端点 URL（选填；留空则图像编辑不可用） */
  editUrl: string;
  model: string;
  apiKey?: string;
  hasKey?: boolean;
}

export function ImageEndpointsPane({ secrets, noBridge, onSaved }: ImageEndpointsPaneProps): ReactElement {
  const [models, setModels] = useState<ImageModelDraft[]>([]);
  const [activeId, setActiveId] = useState('');
  const [busy, setBusy] = useState(false);
  const [notice, setNotice] = useState<{ kind: 'ok' | 'err'; text: string } | null>(null);

  useEffect(() => {
    if (!secrets) return;
    setModels(secrets.imageModels.map((m) => ({ id: m.id, name: m.name, url: m.url, editUrl: m.editUrl, model: m.model, hasKey: m.hasKey })));
    setActiveId(secrets.activeImageModelId);
  }, [secrets]);

  const patch = (i: number, part: Partial<ImageModelDraft>): void => {
    setModels((prev) => prev.map((m, j) => (j === i ? { ...m, ...part } : m)));
  };

  const removeModel = (i: number): void => {
    const target = models[i];
    if (!target) return;
    if (!window.confirm(`删除图像端点「${target.name || target.model || '未命名'}」？保存后生效。`)) return;
    setModels((prev) => prev.filter((_, j) => j !== i));
  };

  async function handleSave(): Promise<void> {
    // R6-16：零拼接——生成/编辑 URL 均由用户填写完整地址，系统原样使用。
    const badUrl = models.findIndex((m) => !/^https?:\/\/.+/i.test(m.url.trim()));
    if (badUrl >= 0) {
      setNotice({ kind: 'err', text: `第 ${badUrl + 1} 个条目的生成 URL 必须为完整端点地址（以 http:// 或 https:// 开头，通常以 /v1/images/generations 结尾）` });
      return;
    }
    const badEdit = models.findIndex((m) => m.editUrl.trim().length > 0 && !/^https?:\/\/.+/i.test(m.editUrl.trim()));
    if (badEdit >= 0) {
      setNotice({ kind: 'err', text: `第 ${badEdit + 1} 个条目的编辑 URL 必须为完整端点地址（留空表示不使用图像编辑）` });
      return;
    }
    const badModel = models.findIndex((m) => m.model.trim() === '');
    if (badModel >= 0) {
      setNotice({ kind: 'err', text: `第 ${badModel + 1} 个条目缺少模型 id（不需要的条目请删除）` });
      return;
    }
    if (!window.aichBridge?.saveImageModels) return;
    setBusy(true);
    setNotice(null);
    try {
      const st = await window.aichBridge.saveImageModels(
        models.map((m) => ({ id: m.id, name: m.name, url: m.url.trim(), editUrl: m.editUrl.trim(), model: m.model.trim(), apiKey: m.apiKey })),
        activeId,
      );
      setModels(st.imageModels.map((m) => ({ id: m.id, name: m.name, url: m.url, editUrl: m.editUrl, model: m.model, hasKey: m.hasKey })));
      setActiveId(st.activeImageModelId);
      onSaved(st);
      setNotice({
        kind: 'ok',
        text: `已保存 ${st.imageModels.length} 个图像端点，本地服务重启生效中…`,
      });
    } catch (err) {
      setNotice({ kind: 'err', text: `保存失败：${(err as Error).message}` });
    } finally {
      setBusy(false);
    }
  }

  if (noBridge) {
    return <p className="settings__note">当前环境（浏览器直开/mock）不支持端点配置。</p>;
  }

  return (
    <div className="settings__pane-form">
      <p className="settings__hint">
        配置表现图生成服务（OpenAI 图像 API 兼容端点），可保存多个来源并切换激活条目。
        生成/编辑 URL 均由你填写完整端点地址（通常分别以 /v1/images/generations、/v1/images/edits 结尾），
        系统原样使用、不做任何拼接；编辑 URL 留空则图像编辑不可用；Key 经系统级加密保存，留空表示保持不变。
      </p>
      {models.map((m, i) => (
        <div key={m.id ?? `draft-${i}`} className={`settings__model ${m.id !== undefined && m.id === activeId ? 'is-active' : ''}`}>
          <div className="settings__model-head">
            <label className="settings__model-radio">
              <input
                type="radio"
                name="image-active-model"
                checked={m.id !== undefined && m.id === activeId}
                onChange={() => m.id !== undefined && setActiveId(m.id)}
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
              placeholder="名称，如 OpenAI 官方"
              value={m.name}
              onChange={(e) => patch(i, { name: e.target.value })}
              aria-label="条目名称"
            />
            <input
              className="settings__input settings__input--grow"
              placeholder="必填：完整生成端点 URL（如 https://api.openai.com/v1/images/generations，原样使用不拼接）"
              value={m.url}
              onChange={(e) => patch(i, { url: e.target.value })}
              aria-label="图像生成 URL"
            />
          </div>
          <div className="settings__row-inline">
            <input
              className="settings__input settings__input--grow"
              placeholder="选填：完整编辑端点 URL（如 https://api.openai.com/v1/images/edits；留空则无法使用图像编辑）"
              value={m.editUrl}
              onChange={(e) => patch(i, { editUrl: e.target.value })}
              aria-label="图像编辑 URL"
            />
            <input
              className="settings__input settings__input--grow"
              placeholder="必填：模型 id（如 gpt-image-2，以服务商文档为准）"
              value={m.model}
              onChange={(e) => patch(i, { model: e.target.value })}
              aria-label="模型 id"
            />
          </div>
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
        onClick={() => setModels((prev) => [...prev, { name: '', url: '', editUrl: '', model: '' }])}
      >
        ＋ 添加图像端点
      </button>
      {notice !== null && <p className={`settings__notice ${notice.kind === 'ok' ? 'is-ok' : 'is-err'}`}>{notice.text}</p>}
      <button type="button" className="settings__btn" disabled={busy || models.length === 0} onClick={() => void handleSave()}>
        {busy ? '保存中…' : '保存并应用（重启本地服务）'}
      </button>
    </div>
  );
}
