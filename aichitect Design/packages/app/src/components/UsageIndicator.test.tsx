/**
 * UsageIndicator 渲染冒烟（R7-2 双胶囊）：胶囊数量/SVG 图标/数值口径/无字符 emoji/contextWindow 缺失容错。
 * node 测试环境 → react-dom/server SSR 渲染（useEffect 不执行，仅验初始 DOM）。
 */

import { describe, it, expect } from 'vitest';
import { renderToStaticMarkup } from 'react-dom/server';
import { UsageIndicator } from './UsageIndicator';
import type { SessionUsage } from '../hooks/useConversation';

const baseUsage: SessionUsage = {
  lastPromptTokens: 30_000,
  lastCompletionTokens: 1200,
  lastCacheReadTokens: 22_000,
  contextWindow: 128_000,
  contextSystemTokens: 1500,
  contextToolTokens: 2500,
  sessionInput: 8000,
  sessionCacheRead: 22_000,
  sessionCacheWrite: 0,
  sessionOutput: 1200,
  sessionTotal: 31_200,
  sessionReasoning: 0,
};

describe('UsageIndicator（双胶囊）', () => {
  it('两枚胶囊 + 层叠 SVG 图标 + 中性环形，数值口径正确，无 emoji 字符', () => {
    const html = renderToStaticMarkup(<UsageIndicator usage={baseUsage} />);
    expect((html.match(/class="usage-pill"/g) ?? []).length).toBe(2);
    expect(html).toContain('usage-pill__svg');
    expect(html).toContain('usage-pill__ring');
    expect(html).toContain('31.2K tok · 缓存命中 73%'); // 累计 + 命中率（22000/30000）
    expect(html).toContain('>23%</'); // 上下文占比（30000/128000）
    // 用户要求：图标用 SVG，不得出现 ⛁ 等 emoji/字符图标
    expect(html).not.toContain('⛁');
  });

  it('contextWindow 缺失（旧会话数据）→ 环形胶囊与占比显示 —，不渲染 0%', () => {
    const legacy: SessionUsage = { ...baseUsage, contextWindow: 0, contextSystemTokens: 0, contextToolTokens: 0 };
    const html = renderToStaticMarkup(<UsageIndicator usage={legacy} />);
    expect(html).toContain('>—<');
    expect(html).not.toContain('>0%<');
  });
});
