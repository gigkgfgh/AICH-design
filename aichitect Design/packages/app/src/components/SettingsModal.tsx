/**
 * SettingsModal —— 设置（R6-4 分类分页结构）。
 *
 * 结构：左侧分类导航 + 右侧内容面板。**新增设置项必须落为一个分类页**（SECTIONS 登记），
 * 不允许再回退为单页长滚动。
 *
 * - 通用：网关状态 / 数据目录 / 版本 / 安全说明（只读）
 * - LLM 端点：多模型来源卡片（Key/BaseURL/模型/思考档；R6-14 自 KeysPane 拆出）
 * - 图像端点：多图像服务商卡片（R6-14：修复"保存不出图像配置"缺陷 + 多条目升级）
 * - 联网检索：搜索服务选择（SearXNG / DuckDuckGo / DeepSeek / 禁用；独立保存）
 * - 外部技能 / Agent / 界面显示 / 日志
 */

import { useEffect, useState, type FormEvent, type ReactElement } from 'react';
import type { GatewayStatus, SecretsStatus } from '../types/contracts';
import { ImageEndpointsPane } from './settings/ImageEndpointsPane';
import { LlmEndpointsPane } from './settings/LlmEndpointsPane';

export interface SettingsModalProps {
  status: GatewayStatus | null;
  onClose: () => void;
  /** Key 保存（触发服务重启）后刷新网关状态 */
  onGatewayRefresh?: () => void;
  /** R6-6：界面显示偏好（localStorage 持久化） */
  uiPrefs?: { showThinking: boolean; showToolCalls: boolean };
  onUiPrefChange?: (key: "showThinking" | "showToolCalls", value: boolean) => void;
}

type SettingsSection = 'general' | 'llm' | 'image' | 'search' | 'skills' | 'agent' | 'ui' | 'logs';

const SECTIONS: Array<{ id: SettingsSection; icon: string; label: string; description: string }> = [
  { id: 'general', icon: '◈', label: '通用', description: '网关状态与版本信息' },
  { id: 'llm', icon: '🔑', label: 'LLM 端点', description: '对话与分析模型来源' },
  { id: 'image', icon: '🖼', label: '图像端点', description: '表现图生成服务' },
  { id: 'search', icon: '◎', label: '联网检索', description: '案例调研的搜索服务' },
  { id: 'skills', icon: '⧉', label: '外部技能', description: '扩展助手能力' },
  { id: 'agent', icon: '⚙', label: 'Agent', description: '运行行为与死循环防护' },
  { id: 'ui', icon: '◐', label: '界面显示', description: '思考与工具调用展示' },
  { id: 'logs', icon: '≡', label: '日志', description: 'Agent 运行日志排查' },
];

function statusLabel(s: GatewayStatus | null): { text: string; ok: boolean } {
  if (!s) return { text: '探测中…', ok: false };
  if (s.gateway === 'bridge') return { text: `本地网关已连接（${s.gatewayUrl ?? ''}）`, ok: true };
  if (s.agentService === 'stub') return { text: 'agent-service 握手失败（渲染层走 mock 直连）', ok: false };
  return { text: 'agent-service 不可用（渲染层走 mock 直连）', ok: false };
}

export function SettingsModal(props: SettingsModalProps): ReactElement {
  const { status, onClose, onGatewayRefresh, uiPrefs, onUiPrefChange } = props;
  const [section, setSection] = useState<SettingsSection>('general');
  const [secrets, setSecrets] = useState<SecretsStatus | null>(null);
  const [busy, setBusy] = useState(false);
  const [notice, setNotice] = useState<{ section: SettingsSection; kind: 'ok' | 'err'; text: string } | null>(null);

  // 联网检索表单
  const [searchProvider, setSearchProvider] = useState('disabled');
  const [searchBaseUrl, setSearchBaseUrl] = useState('');
  // R6-13：Agent 运行防护表单（工具调用轮次上限）
  const [maxToolCallsInput, setMaxToolCallsInput] = useState('25');
  // R6-6：会话目录输入（模型/图像条目编辑状态已下放各自 Pane）
  const [sessionsDirInput, setSessionsDirInput] = useState('');

  const refreshSecrets = async (): Promise<void> => {
    const bridge = window.aichBridge;
    if (!bridge?.secretsStatus) return;
    try {
      const s = await bridge.secretsStatus();
      setSecrets(s);
      setSearchProvider(s.searchProvider || 'disabled');
      setSearchBaseUrl(s.searchBaseUrl);
      if (typeof s.maxToolCalls === 'number' && s.maxToolCalls > 0) setMaxToolCallsInput(String(s.maxToolCalls));
      if (!sessionsDirInput) setSessionsDirInput(status?.sessionsDir ?? '');
    } catch {
      setSecrets(null);
    }
  };

  useEffect(() => {
    void refreshSecrets();
    const onKey = (e: KeyboardEvent): void => {
      if (e.key === 'Escape') onClose();
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  /** R6-14：端点 Pane 保存成功回调（刷新 Modal 级 secrets + 网关状态）。 */
  const handleEndpointsSaved = (st: SecretsStatus): void => {
    setSecrets(st);
    onGatewayRefresh?.();
  };

  async function handleSaveSearch(e: FormEvent): Promise<void> {
    e.preventDefault();
    const bridge = window.aichBridge;
    if (!bridge?.secretsSaveKeys) return;
    setBusy(true);
    setNotice(null);
    try {
      await bridge.secretsSaveKeys({
        searchProvider,
        searchBaseUrl: searchProvider === 'searxng' ? searchBaseUrl.trim() : '',
      });
      setNotice({ section: 'search', kind: 'ok', text: '已保存，本地服务重启生效中…' });
      await refreshSecrets();
      onGatewayRefresh?.();
    } catch (err) {
      setNotice({ section: 'search', kind: 'err', text: `保存失败：${(err as Error).message}` });
    } finally {
      setBusy(false);
    }
  }

  const Notice = ({ forSection }: { forSection: SettingsSection }): ReactElement =>
    notice?.section === forSection ? (
      <p className={`settings__notice ${notice.kind === 'ok' ? 'is-ok' : 'is-err'}`}>{notice.text}</p>
    ) : (
      <></>
    );

  /* ---------------- 各分类内容面板 ---------------- */

  const generalPane = (
    <>
    <Notice forSection="general" />
    <dl className="settings__list">
      <div className="settings__row">
        <dt>网关状态</dt>
        <dd className={statusLabel(status).ok ? 'is-ok' : 'is-warn'}>{statusLabel(status).text}</dd>
      </div>
      <div className="settings__row">
        <dt>会话数据目录</dt>
        <dd className="settings__path">{status?.sessionsDir ?? '（mock 模式无本地数据目录）'}</dd>
      </div>
      <div className="settings__row">
        <dt>版本</dt>
        <dd>AICH Design 0.1.0（开发版）</dd>
      </div>
      <div className="settings__row">
        <dt>会话存储位置</dt>
        <dd>
          <div className="settings__row-inline">
            <span className="settings__path settings__input--grow" title={sessionsDirInput || status?.sessionsDir}>
              {sessionsDirInput || status?.sessionsDir || "默认（userData/sessions）"}
            </span>
            <button
              type="button"
              className="settings__btn settings__btn--ghost settings__btn--sm"
              onClick={() => {
                void window.aichBridge?.browseSessionsDir?.().then((dir) => {
                  if (dir) setSessionsDirInput(dir);
                });
              }}
            >
              浏览…
            </button>
          </div>
          <button
            type="button"
            className="settings__btn settings__btn--ghost settings__btn--sm"
            disabled={busy}
            onClick={() => {
              void window.aichBridge
                ?.setSessionsDir?.(sessionsDirInput.trim())
                .then(() => {
                  setNotice({ section: 'general', kind: 'ok', text: '会话目录已更新，本地服务已重启（历史会话需手动迁移文件）' });
                  onGatewayRefresh?.();
                })
                .catch((err: Error) => setNotice({ section: 'general', kind: 'err', text: err.message }));
            }}
          >
            保存并重启服务
          </button>
        </dd>
      </div>
      <div className="settings__row">
        <dt>安全说明</dt>
        <dd>
          密钥经系统级加密（Windows DPAPI）保存在本机，仅注入本地 agent-service，不上传、不进渲染进程。
        </dd>
      </div>
    </dl>
    </>
  );

  const noBridge = !window.aichBridge?.secretsStatus;

  const llmPane = <LlmEndpointsPane secrets={secrets} noBridge={noBridge} onSaved={handleEndpointsSaved} />;
  const imagePane = <ImageEndpointsPane secrets={secrets} noBridge={noBridge} onSaved={handleEndpointsSaved} />;
  const searchPane = (
    <>
      <Notice forSection="search" />
      {noBridge ? (
        <p className="settings__note">当前环境（浏览器直开/mock）不支持检索配置。</p>
      ) : (
        <form className="settings__pane-form" onSubmit={(e) => void handleSaveSearch(e)}>
          <div className="settings__key-group">
            <p className="settings__key-title">搜索服务（案例调研 agent 使用）</p>
            <select
              className="settings__input"
              value={searchProvider}
              onChange={(e) => setSearchProvider(e.target.value)}
              aria-label="搜索服务"
            >
              <option value="disabled">禁用（调研退化为模型知识分析）</option>
              <option value="searxng">SearXNG（推荐：本地部署，结果聚合多引擎）</option>
              <option value="duckduckgo">DuckDuckGo（免部署，网络可达性受限）</option>
            <option value="deepseek">DeepSeek 官方联网（复用已配置的 DeepSeek 模型条目，服务端搜索）</option>
            </select>
            {searchProvider === 'searxng' && (
              <input
                className="settings__input"
                type="text"
                placeholder="SearXNG 搜索端点，如 http://127.0.0.1:8888/search"
                value={searchBaseUrl}
                onChange={(e) => setSearchBaseUrl(e.target.value)}
              />
            )}
            <p className="settings__hint">
              SearXNG 本地部署：docker run -p 8888:8080 searxng/searxng，并在 settings.yml 的 search.formats 加入 json。
            </p>
          </div>
          <button className="settings__btn" type="submit" disabled={busy}>
            {busy ? '保存中…' : '保存并应用（重启本地服务）'}
          </button>
        </form>
      )}
    </>
  );

  const skillsPane = (
    <div className="settings__key-group">
      <p className="settings__key-title">扩展助手能力</p>
      <p className="settings__hint">
        在技能文件夹中为每个技能建一个子目录，放入 SKILL.md（frontmatter 含 name/description + Markdown 正文，
        Anthropic Agent Skills 格式）。安装后点「重启本地服务」生效；助手会在需要时自动调用。
      </p>
      <div className="settings__row-inline">
        <button
          type="button"
          className="settings__btn settings__btn--ghost"
          onClick={() => {
            void window.aichBridge?.openSkillsDir?.().catch(() => undefined);
          }}
        >
          📂 打开技能文件夹
        </button>
        <button
          type="button"
          className="settings__btn settings__btn--ghost"
          disabled={busy}
          onClick={() => {
            void window.aichBridge
              ?.restartService?.()
              .then(() => {
                setNotice({ section: 'skills', kind: 'ok', text: '本地服务已重启（新技能已加载）' });
                onGatewayRefresh?.();
              })
              .catch((err: Error) => setNotice({ section: 'skills', kind: 'err', text: err.message }));
          }}
        >
          ⟳ 重启本地服务
        </button>
      </div>
      <p className="settings__path">{status?.skillsDir ?? '（mock 模式无技能目录）'}</p>
      <Notice forSection="skills" />
    </div>
  );

  const agentPane = (
    <div className="settings__key-group">
      <p className="settings__key-title">运行防护</p>
      <div className="settings__row-inline">
        <label htmlFor="max-tool-calls">单次运行工具调用轮次上限</label>
        <input
          id="max-tool-calls"
          className="settings__input settings__input--num"
          type="number"
          min={1}
          max={200}
          value={maxToolCallsInput}
          onChange={(e) => setMaxToolCallsInput(e.target.value)}
          aria-label="单次运行工具调用轮次上限"
        />
      </div>
      <p className="settings__hint">
        限制 Agent 在一次运行中最多调用工具的次数（默认 25，范围 1~200）。超出后运行自动中止并提示，
        防止模型陷入无限工具循环反复消耗调用；单次工具的执行时长不受影响（联网检索/图像生成照常）。
      </p>
      <button
        type="button"
        className="settings__btn"
        disabled={busy}
        onClick={() => {
          const n = Number(maxToolCallsInput);
          if (!Number.isFinite(n) || Math.floor(n) !== n || n < 1 || n > 200) {
            setNotice({ section: 'agent', kind: 'err', text: '请输入 1~200 之间的整数' });
            return;
          }
          setBusy(true);
          void window.aichBridge
            ?.setMaxToolCalls?.(Math.floor(n))
            .then(() => {
              setNotice({ section: 'agent', kind: 'ok', text: `已保存（上限 ${Math.floor(n)} 次），本地服务重启生效中…` });
              onGatewayRefresh?.();
            })
            .catch((err: Error) => setNotice({ section: 'agent', kind: 'err', text: err.message }))
            .finally(() => setBusy(false));
        }}
      >
        {busy ? '保存中…' : '保存并应用（重启本地服务）'}
      </button>
      <Notice forSection="agent" />
    </div>
  );

  const uiPane = (
    <div className="settings__key-group">
      <p className="settings__key-title">对话内容展示</p>
      <label className="settings__switch">
        <input
          type="checkbox"
          checked={uiPrefs?.showThinking ?? true}
          onChange={(e) => onUiPrefChange?.("showThinking", e.target.checked)}
        />
        <span>显示模型思考过程（可折叠）</span>
      </label>
      <label className="settings__switch">
        <input
          type="checkbox"
          checked={uiPrefs?.showToolCalls ?? true}
          onChange={(e) => onUiPrefChange?.("showToolCalls", e.target.checked)}
        />
        <span>显示工具调用记录（可折叠）</span>
      </label>
      <p className="settings__hint">关闭后正文中不再出现思考/工具区块（更沉浸）；两类内容与正文有层级区分，可随时收起/展开。</p>
    </div>
  );

  const logsPane = (
    <div className="settings__key-group">
      <p className="settings__key-title">Agent 运行日志</p>
      <p className="settings__hint">
        本地服务（agent-service）的 stdout/stderr 全量落盘（单文件 5MB 轮转），用于排查模型调用/工具执行问题。
      </p>
      <div className="settings__row-inline">
        <button
          type="button"
          className="settings__btn settings__btn--ghost settings__btn--sm"
          onClick={() => {
            void window.aichBridge?.openLogsDir?.().catch(() => undefined);
          }}
        >
          📂 打开日志文件夹
        </button>
      </div>
      <label className="settings__switch">
        <input type="checkbox" defaultChecked={localStorage.getItem('aich.loopLog') === '1'} onChange={(e) => { void window.aichBridge?.setLoopLogEnabled?.(e.target.checked); localStorage.setItem('aich.loopLog', e.target.checked ? '1' : '0'); }} />
        <span>记录完整 Agent Loops 上下文（每轮消息/工具调用/结果）</span>
      </label>
      <p className="settings__path">{status?.logsDir ?? "（mock 模式无日志）"}</p>
    </div>
  );

  const panes: Record<SettingsSection, ReactElement> = {
    general: generalPane,
    llm: llmPane,
    image: imagePane,
    search: searchPane,
    skills: skillsPane,
    agent: agentPane,
    ui: uiPane,
    logs: logsPane,
  };

  const active = SECTIONS.find((s) => s.id === section)!;

  return (
    <div className="modal" role="dialog" aria-modal="true" aria-label="设置">
      <div className="modal__backdrop" onClick={onClose} aria-hidden="true" />
      <div className="modal__body modal__body--settings">
        <header className="modal__header">
          <h2>设置</h2>
          <button type="button" className="modal__close" onClick={onClose} aria-label="关闭">
            ✕
          </button>
        </header>

        <div className="settings-layout">
          <nav className="settings-nav" aria-label="设置分类">
            {SECTIONS.map((s) => (
              <button
                key={s.id}
                type="button"
                className={`settings-nav__item ${section === s.id ? 'is-active' : ''}`}
                onClick={() => setSection(s.id)}
              >
                <span className="settings-nav__icon">{s.icon}</span>
                <span className="settings-nav__text">
                  <span className="settings-nav__label">{s.label}</span>
                  <span className="settings-nav__desc">{s.description}</span>
                </span>
              </button>
            ))}
          </nav>

          <div className="settings-content" role="tabpanel" aria-label={active.label}>
            <p className="settings-content__title">{active.label}</p>
            <div className="settings-content__scroll" key={section}>
              {panes[section]}
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}
