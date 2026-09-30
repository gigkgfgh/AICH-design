# -*- coding: utf-8 -*-
"""R7-2 CSS：标题栏修复/统一开关/用量指示器/画布控件可读性/菜单与编辑器。临时脚本，用后即删。"""
import io

p = "index.css"
s = io.open(p, encoding="utf-8").read()

# 1) 窄窗抽屉不再盖标题栏（top 从 0 → 标题栏下沿）
old = """@media (max-width: 1100px) {
  .app--work > .preview-dock {
    position: fixed;
    top: 0;
    right: 0;
    bottom: 0;
    width: min(480px, 92vw);
    z-index: 40;
    border-left: 1px solid var(--border);
    box-shadow: -16px 0 48px rgba(0, 0, 0, 0.5);
  }
}"""
new = """@media (max-width: 1100px) {
  .app--work > .preview-dock {
    position: fixed;
    /* R7-2：从标题栏下沿开始——原 top:0 全高抽屉会盖住最小化/最大化/关闭按钮 */
    top: var(--titlebar-h);
    right: 0;
    bottom: 0;
    width: min(480px, 92vw);
    z-index: 40;
    border-left: 1px solid var(--border);
    box-shadow: -16px 0 48px rgba(0, 0, 0, 0.5);
  }
}"""
assert old in s, "media"
s = s.replace(old, new)

# 2) titlebar 定位/z 提升（双保险）+ 右侧功能区容器
old = """.titlebar {
  flex: none;
  height: var(--titlebar-h);
  -webkit-app-region: drag;"""
new = """.titlebar {
  position: relative;
  /* R7-2：高于窄窗覆盖抽屉（z 40）——窗口按钮永不被业务面板遮挡 */
  z-index: 45;
  flex: none;
  height: var(--titlebar-h);
  -webkit-app-region: drag;"""
assert old in s, "titlebar"
s = s.replace(old, new)

# 3) 追加 R7-2 全部新样式
s += """

/* ---------------- R7-2：标题栏统一开关 + 分隔线 ---------------- */

.titlebar-toggle {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  width: 30px;
  height: var(--titlebar-h);
  border: none;
  background: transparent;
  color: var(--text-2);
  cursor: pointer;
  -webkit-app-region: no-drag;
  transition: background var(--dur-1) ease, color var(--dur-1) ease;
}

.titlebar-toggle:hover {
  background: var(--bg-2, rgba(255, 255, 255, 0.06));
  color: var(--text-0);
}

.titlebar-toggle:active {
  transform: scale(0.96);
}

.titlebar__right {
  display: flex;
  align-items: center;
  -webkit-app-region: no-drag;
}

.titlebar__divider {
  width: 1px;
  height: 18px;
  margin: 0 6px;
  background: var(--border);
  opacity: 0.7;
}

/* ---------------- R7-2：用量指示器（DSH 风格胶囊 + 明细面板） ---------------- */

.usage-indicator {
  position: relative;
  display: flex;
  justify-content: flex-start;
  padding: 0 12px 8px;
}

.usage-pill {
  display: inline-flex;
  align-items: center;
  gap: 6px;
  padding: 3px 10px;
  border: 1px solid var(--border);
  border-radius: 999px;
  background: var(--bg-1);
  color: var(--text-2);
  font-size: 11px;
  cursor: pointer;
  transition: border-color var(--dur-1) ease, color var(--dur-1) ease;
}

.usage-pill:hover {
  border-color: var(--accent);
  color: var(--text-0);
}

.usage-pill__icon {
  font-size: 11px;
  opacity: 0.85;
}

.usage-pill__ring {
  color: var(--accent);
}

.usage-pill__pct {
  font-variant-numeric: tabular-nums;
}

.usage-popover {
  position: absolute;
  bottom: calc(100% + 6px);
  left: 12px;
  width: 264px;
  padding: 4px 0;
  border: 1px solid var(--border);
  border-radius: var(--radius-m);
  background: var(--bg-1);
  box-shadow: var(--shadow-3);
  z-index: calc(var(--z-menu) + 10);
  animation: fade-in var(--dur-2) var(--ease-out, ease);
}

.usage-popover__section {
  padding: 8px 12px;
}

.usage-popover__section + .usage-popover__section {
  border-top: 1px solid var(--border);
}

.usage-popover__head {
  display: flex;
  justify-content: space-between;
  align-items: baseline;
  color: var(--text-0);
  font-size: 12px;
  margin-bottom: 6px;
}

.usage-popover__head b {
  color: var(--accent);
}

.usage-popover__value {
  color: var(--text-1);
  font-variant-numeric: tabular-nums;
  font-size: 11px;
}

.usage-popover__bar {
  height: 4px;
  border-radius: 2px;
  background: var(--bg-2, rgba(255, 255, 255, 0.08));
  overflow: hidden;
  margin-bottom: 8px;
}

.usage-popover__bar span {
  display: block;
  height: 100%;
  border-radius: 2px;
  background: var(--accent);
}

.usage-popover__rows {
  list-style: none;
  margin: 0;
  padding: 0;
  display: flex;
  flex-direction: column;
  gap: 4px;
}

.usage-popover__rows li {
  display: flex;
  align-items: center;
  gap: 6px;
  color: var(--text-1);
  font-size: 11px;
}

.usage-popover__rows li > span:last-child {
  margin-left: auto;
  color: var(--text-0);
  font-variant-numeric: tabular-nums;
}

.usage-popover__dot {
  width: 8px;
  height: 8px;
  border-radius: 2px;
  flex: none;
}

.usage-popover__dot--sys {
  background: var(--text-2);
}

.usage-popover__dot--tool {
  background: #b48cf2;
}

.usage-popover__dot--msg {
  background: var(--accent);
}

/* ---------------- R7-2：React Flow Controls 深色可读性 ---------------- */

.image-canvas .react-flow__controls {
  box-shadow: var(--shadow-2);
  border-radius: var(--radius-s);
  overflow: hidden;
}

.image-canvas .react-flow__controls button {
  background: var(--bg-1);
  border-bottom: 1px solid var(--border);
  color: var(--text-1);
  width: 26px;
  height: 26px;
  cursor: pointer;
}

.image-canvas .react-flow__controls button:hover {
  background: var(--bg-2, rgba(255, 255, 255, 0.08));
  color: var(--text-0);
}

.image-canvas .react-flow__controls button svg {
  fill: currentColor;
  max-width: 12px;
  max-height: 12px;
}

.image-canvas .react-flow__controls button.react-flow__controls-interactive,
.image-canvas .react-flow__controls button:disabled {
  pointer-events: none;
}

/* ---------------- R7-2：画布卡片补充（拖拽把手/引用按钮/选中态） ---------------- */

.image-node__thumb-wrap {
  position: relative;
  cursor: grab;
  border-radius: calc(var(--radius-m) - 2px);
}

.image-node__thumb-wrap:active {
  cursor: grabbing;
}

.image-node__drag-hint {
  position: absolute;
  right: 6px;
  bottom: 6px;
  padding: 1px 6px;
  border-radius: var(--radius-s);
  background: rgba(0, 0, 0, 0.55);
  color: rgba(255, 255, 255, 0.85);
  font-size: 10px;
  opacity: 0;
  transition: opacity var(--dur-1) ease;
  pointer-events: none;
}

.image-node__thumb-wrap:hover .image-node__drag-hint {
  opacity: 1;
}

.image-node__ref {
  margin-top: 4px;
  width: 100%;
  padding: 4px 0;
  border: 1px solid var(--border);
  border-radius: var(--radius-s);
  background: transparent;
  color: var(--text-1);
  font-size: 11px;
  cursor: pointer;
  transition: background var(--dur-1) ease, border-color var(--dur-1) ease;
}

.image-node__ref:hover {
  background: var(--accent-soft);
  border-color: var(--accent);
  color: var(--accent);
}

.image-node.is-active {
  border-color: var(--accent);
  box-shadow: 0 0 0 1px var(--accent), var(--shadow-2);
}

/* ---------------- R7-2：画布右键菜单 ---------------- */

.canvas-menu {
  position: fixed;
  min-width: 176px;
  padding: 4px;
  border: 1px solid var(--border);
  border-radius: var(--radius-m);
  background: var(--bg-1);
  box-shadow: var(--shadow-3);
  z-index: calc(var(--z-menu) + 20);
  animation: fade-in var(--dur-1) var(--ease-out, ease);
}

.canvas-menu button {
  display: flex;
  align-items: center;
  gap: 8px;
  width: 100%;
  padding: 6px 10px;
  border: none;
  border-radius: var(--radius-s);
  background: transparent;
  color: var(--text-1);
  font-size: 12px;
  text-align: left;
  cursor: pointer;
}

.canvas-menu button:hover {
  background: var(--accent-soft);
  color: var(--text-0);
}

.canvas-menu__danger {
  color: var(--danger) !important;
}

.canvas-menu__danger:hover {
  background: color-mix(in srgb, var(--danger) 12%, transparent) !important;
}

.canvas-menu__kbd {
  margin-left: auto;
  padding: 1px 5px;
  border: 1px solid var(--border);
  border-radius: 4px;
  color: var(--text-2);
  font-size: 10px;
}

.canvas-menu__divider {
  height: 1px;
  margin: 4px 6px;
  background: var(--border);
}

/* ---------------- R7-2：图像参数信息浮层 ---------------- */

.image-info {
  position: absolute;
  top: 50%;
  left: 50%;
  transform: translate(-50%, -50%);
  width: min(480px, 92vw);
  max-height: 80vh;
  display: flex;
  flex-direction: column;
  border: 1px solid var(--border);
  border-radius: var(--radius-l);
  background: var(--bg-1);
  box-shadow: var(--shadow-3);
  z-index: calc(var(--z-menu) + 10);
  overflow: hidden;
}

.image-info__bar {
  display: flex;
  align-items: center;
  gap: 8px;
  padding: 10px 14px;
  border-bottom: 1px solid var(--border);
}

.image-info__title {
  color: var(--text-0);
  font-size: 13px;
  font-weight: 600;
}

.image-info__close {
  margin-left: auto;
  padding: 2px 8px;
  border: none;
  background: transparent;
  color: var(--text-2);
  cursor: pointer;
  border-radius: var(--radius-s);
}

.image-info__close:hover {
  background: var(--bg-2, rgba(255, 255, 255, 0.08));
  color: var(--text-0);
}

.image-info__rows {
  margin: 0;
  padding: 8px 14px 14px;
  overflow-y: auto;
}

.image-info__row {
  display: flex;
  gap: 12px;
  padding: 5px 0;
  border-bottom: 1px solid color-mix(in srgb, var(--border) 55%, transparent);
}

.image-info__row dt {
  flex: none;
  width: 72px;
  color: var(--text-2);
  font-size: 12px;
}

.image-info__row dd {
  margin: 0;
  color: var(--text-0);
  font-size: 12px;
  word-break: break-all;
  user-select: text;
}

/* ---------------- R7-2：图片编辑器浮层 ---------------- */

.editor-overlay {
  z-index: calc(var(--z-modal) + 5);
}

.editor-shell {
  position: absolute;
  top: 50%;
  left: 50%;
  transform: translate(-50%, -50%);
  width: min(1080px, 94vw);
  height: min(760px, 90vh);
  display: flex;
  flex-direction: column;
  border: 1px solid var(--border);
  border-radius: var(--radius-l);
  background: var(--bg-1);
  box-shadow: var(--shadow-3);
  overflow: hidden;
}

.editor-shell__bar {
  display: flex;
  align-items: center;
  gap: 10px;
  padding: 8px 14px;
  border-bottom: 1px solid var(--border);
}

.editor-shell__title {
  color: var(--text-0);
  font-size: 13px;
  font-weight: 600;
}

.editor-shell__name {
  color: var(--text-2);
  font-size: 12px;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.editor-shell__close {
  margin-left: auto;
  padding: 2px 10px;
  border: none;
  background: transparent;
  color: var(--text-2);
  font-size: 14px;
  cursor: pointer;
  border-radius: var(--radius-s);
}

.editor-shell__close:hover {
  background: var(--bg-2, rgba(255, 255, 255, 0.08));
  color: var(--text-0);
}

.editor-shell__body {
  flex: 1;
  min-height: 0;
}

.editor-shell__body .FilerobotImageEditor-root_label,
.editor-shell__body [class*='FilerobotImageEditor'] {
  height: 100%;
}

/* ---------------- R7-2：设置高级设置折叠区 ---------------- */

.settings__advanced {
  margin: 6px 0;
  border: 1px solid var(--border);
  border-radius: var(--radius-s);
}

.settings__advanced-summary {
  padding: 6px 10px;
  color: var(--text-2);
  font-size: 12px;
  cursor: pointer;
  user-select: none;
  list-style: none;
}

.settings__advanced-summary::before {
  content: '▸ ';
}

.settings__advanced[open] .settings__advanced-summary::before {
  content: '▾ ';
}

.settings__advanced-summary:hover {
  color: var(--text-0);
}

.settings__advanced-body {
  display: flex;
  flex-direction: column;
  gap: 8px;
  padding: 4px 10px 10px;
  border-top: 1px solid var(--border);
}

.settings__advanced-row {
  display: flex;
  align-items: center;
  gap: 10px;
}

.settings__advanced-label {
  flex: none;
  width: 72px;
  color: var(--text-2);
  font-size: 12px;
}
"""

io.open(p, "w", encoding="utf-8", newline="").write(s)
print("css ok")
