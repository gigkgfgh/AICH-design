/**
 * PlusMenu —— 输入区左下角加号菜单（R6-4）：
 * - 📎 添加附件（图片 ≤20MB / 文本 ≤50KB，经 ingestFiles 共享管线）
 * - ⧉ 选择技能（子菜单列出外部技能；选定后作为 chip 展示，发送时注入 prompt）
 */

import { useRef, useState, type ChangeEvent, type ReactElement } from 'react';
import type { Attachment } from '../../types/contracts';
import { Dropdown } from './Selectors';
import { ATTACHMENT_ACCEPT, ingestFiles } from './AttachmentBar';

export interface SelectedSkill {
  name: string;
  description: string;
}

export interface PlusMenuProps {
  /** 添加附件回调 */
  onAddAttachment: (a: Attachment) => void;
  /** 图片注册回调（bridge 可用时经 /v1/images） */
  onRegisterImage?: (dataUrl: string, name: string) => Promise<{ imageId: string; url: string } | null>;
  /** 加载外部技能列表（懒加载；mock/无 bridge 返回 []） */
  onLoadSkills: () => Promise<Array<{ name: string; description: string }>>;
  /** 当前选定的技能（高亮 + 再次点击取消） */
  selectedSkill: SelectedSkill | null;
  onSelectSkill: (skill: SelectedSkill | null) => void;
  disabled?: boolean;
}

export function PlusMenu(props: PlusMenuProps): ReactElement {
  const { onAddAttachment, onRegisterImage, onLoadSkills, selectedSkill, onSelectSkill, disabled } = props;
  const fileRef = useRef<HTMLInputElement>(null);
  const [error, setError] = useState<string | null>(null);
  const [skills, setSkills] = useState<Array<{ name: string; description: string }> | null>(null);

  function handleFiles(e: ChangeEvent<HTMLInputElement>): void {
    setError(null);
    const files = Array.from(e.target.files ?? []);
    e.target.value = ''; // 允许重复选择同一文件
    void ingestFiles(files, {
      onAdd: onAddAttachment,
      onRegisterImage,
      onError: (msg) => setError(msg),
    });
  }

  return (
    <div className="plus-menu">
      <input
        ref={fileRef}
        type="file"
        multiple
        accept={ATTACHMENT_ACCEPT}
        style={{ display: 'none' }}
        onChange={handleFiles}
        aria-label="上传附件"
      />
      <Dropdown
        label={
          <span className="plus-menu__trigger" title="添加附件 / 选择技能">
            ＋
          </span>
        }
      >
        {(close) => (
          <div className="composer-menu__list plus-menu__list">
            <button
              type="button"
              className="composer-menu__item composer-menu__item--row"
              disabled={disabled}
              onClick={() => {
                close();
                fileRef.current?.click();
              }}
            >
              <span>📎 添加附件</span>
              <span className="composer-menu__item-tag">图片≤20MB / 文本≤50KB</span>
            </button>

            <button
              type="button"
              className={`composer-menu__item composer-menu__item--row ${selectedSkill ? 'is-active' : ''}`}
              disabled={disabled}
              onClick={() => {
                // 懒加载技能列表（一次会话缓存）
                if (skills === null) {
                  void onLoadSkills().then(setSkills).catch(() => setSkills([]));
                }
              }}
            >
              <span>⧉ 选择技能</span>
              {selectedSkill ? (
                <span className="composer-menu__item-tag" title={selectedSkill.name}>
                  {selectedSkill.name} ✕
                </span>
              ) : (
                <span className="composer-menu__caret">▸</span>
              )}
            </button>

            {/* 技能列表（点击「选择技能」后展开；再点已选技能 = 取消） */}
            {skills !== null && (
              <div className="plus-menu__skills">
                {skills.length === 0 ? (
                  <p className="plus-menu__empty">暂无外部技能（设置 → 外部技能 安装后重启服务）</p>
                ) : (
                  skills.map((s) => (
                    <button
                      key={s.name}
                      type="button"
                      className={`composer-menu__item ${selectedSkill?.name === s.name ? 'is-active' : ''}`}
                      disabled={disabled}
                      title={s.description || s.name}
                      onClick={() => {
                        onSelectSkill(selectedSkill?.name === s.name ? null : { name: s.name, description: s.description });
                        close();
                      }}
                    >
                      <span className="composer-menu__item-head">
                        <span className="composer-menu__item-name">{s.name}</span>
                        {selectedSkill?.name === s.name && <span className="composer-menu__check">✓</span>}
                      </span>
                      {s.description && <span className="composer-menu__item-desc">{s.description}</span>}
                    </button>
                  ))
                )}
              </div>
            )}

            {error && <p className="plus-menu__error">{error}</p>}
          </div>
        )}
      </Dropdown>
    </div>
  );
}
