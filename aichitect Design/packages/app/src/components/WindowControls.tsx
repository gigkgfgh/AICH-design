/**
 * WindowControls（R6-14）：无边框窗口自绘控制按钮，ZCode DesktopWindowControls 同构。
 *
 * - 三按钮：最小化 / 最大化-还原 / 关闭（关闭 hover 红）；ghost 形态，无背景边框。
 * - isMaximized 初态查询 + win:chromeChanged 订阅；较晚返回的初态不覆盖用户刚触发的事件
 *   （receivedEvent 防护，照抄 ZCode 实现）。
 * - 容器 no-drag（父级 titlebar 为 drag 区）；图标为 10×10 Windows caption 风格内联 SVG。
 */
import { useEffect, useRef, useState, type ReactElement } from 'react';

function MinIcon(): ReactElement {
  return (
    <svg width="10" height="10" viewBox="0 0 10 10" aria-hidden="true">
      <path d="M0.5 5.5 H9.5" stroke="currentColor" strokeWidth="1" fill="none" />
    </svg>
  );
}

function MaxIcon(): ReactElement {
  return (
    <svg width="10" height="10" viewBox="0 0 10 10" aria-hidden="true">
      <rect x="0.5" y="0.5" width="9" height="9" stroke="currentColor" strokeWidth="1" fill="none" />
    </svg>
  );
}

function RestoreIcon(): ReactElement {
  return (
    <svg width="10" height="10" viewBox="0 0 10 10" aria-hidden="true">
      <rect x="0.5" y="2.5" width="7" height="7" stroke="currentColor" strokeWidth="1" fill="none" />
      <path d="M2.5 2.5 V0.5 H9.5 V7.5 H7.5" stroke="currentColor" strokeWidth="1" fill="none" />
    </svg>
  );
}

function CloseIcon(): ReactElement {
  return (
    <svg width="10" height="10" viewBox="0 0 10 10" aria-hidden="true">
      <path d="M0.5 0.5 L9.5 9.5 M9.5 0.5 L0.5 9.5" stroke="currentColor" strokeWidth="1" fill="none" />
    </svg>
  );
}

export function WindowControls(): ReactElement {
  const [maximized, setMaximized] = useState(false);
  const receivedEventRef = useRef(false);

  useEffect(() => {
    const bridge = window.aichBridge;
    if (!bridge?.getWindowChromeState || !bridge.onWindowChromeChanged) return;
    let disposed = false;
    // 订阅先行；初态查询晚到时不覆盖用户刚触发的事件（ZCode 同款防护）。
    const unsub = bridge.onWindowChromeChanged((state) => {
      receivedEventRef.current = true;
      setMaximized(state.isMaximized);
    });
    void bridge
      .getWindowChromeState()
      .then((state) => {
        if (!disposed && !receivedEventRef.current) setMaximized(state.isMaximized);
      })
      .catch(() => undefined);
    return () => {
      disposed = true;
      unsub();
    };
  }, []);

  const act = (fn: (() => Promise<void>) | undefined): void => {
    void fn?.().catch(() => undefined);
  };

  return (
    <div className="window-controls">
      <button
        type="button"
        className="window-controls__btn"
        aria-label="最小化"
        title="最小化"
        onClick={() => act(window.aichBridge?.windowMinimize)}
      >
        <MinIcon />
      </button>
      <button
        type="button"
        className="window-controls__btn"
        aria-label={maximized ? '还原' : '最大化'}
        title={maximized ? '向下还原' : '最大化'}
        data-maximized={maximized || undefined}
        onClick={() => act(window.aichBridge?.windowToggleMaximize)}
      >
        {maximized ? <RestoreIcon /> : <MaxIcon />}
      </button>
      <button
        type="button"
        className="window-controls__btn window-controls__btn--close"
        aria-label="关闭窗口"
        title="关闭"
        onClick={() => act(window.aichBridge?.windowClose)}
      >
        <CloseIcon />
      </button>
    </div>
  );
}
