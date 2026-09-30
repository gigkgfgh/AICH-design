/**
 * 渲染进程入口（P007；R7-2：启动诊断——模块加载/挂载异常写入 DOM 与标题，
 * 避免"黑屏无线索"。App 动态加载：import 链失败也能被捕获展示。）
 */
import { createRoot } from 'react-dom/client';
import './index.css';

function showFatal(message: string): void {
  const container = document.getElementById('root');
  if (container) {
    container.innerHTML = `<pre style="color:#f87171;font:12px/1.6 monospace;padding:16px;white-space:pre-wrap;user-select:text">启动失败：${message.replace(/[<>&]/g, (c) => ({'<':'&lt;','>':'&gt;','&':'&amp;'}[c] ?? c))}</pre>`;
  }
  document.title = 'AICH Design（启动异常）';
}

window.addEventListener('error', (e) => {
  if (document.getElementById('root')?.childElementCount === 0) {
    showFatal(`(error) ${e.message}\n${e.filename ?? ''}:${(e.lineno ?? 0)}:${(e.colno ?? 0)}`);
  }
});
window.addEventListener('unhandledrejection', (e) => {
  if (document.getElementById('root')?.childElementCount === 0) {
    showFatal(`(rejection) ${String(e.reason)}`);
  }
});

try {
  const container = document.getElementById('root');
  if (!container) {
    throw new Error('未找到 #root 挂载点');
  }
  void (async () => {
    try {
      const { App } = await import('./App');
      createRoot(container).render(<App />);
    } catch (err) {
      showFatal(err instanceof Error ? `${err.message}\n${err.stack ?? ''}` : String(err));
    }
  })();
} catch (err) {
  showFatal(err instanceof Error ? `${err.message}\n${err.stack ?? ''}` : String(err));
}
