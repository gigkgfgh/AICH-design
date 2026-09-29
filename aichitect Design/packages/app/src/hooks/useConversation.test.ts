/**
 * R5 渲染层路由纯函数测试：classifyAgentIntent（主 Agent 意图路由）与
 * composePromptWithAttachments（文本附件注入 / 图片附件说明）。
 */

import { describe, it, expect } from 'vitest';
import { classifyAgentIntent, composePromptWithAttachments } from './useConversation';
import type { Attachment } from '../types/contracts';

describe('classifyAgentIntent（主 Agent 自动路由）', () => {
  it('图像意图 → image-gen', () => {
    expect(classifyAgentIntent('为当前方案生成一张客厅表现图')).toBe('image-gen');
    expect(classifyAgentIntent('渲染一下效果图')).toBe('image-gen');
    expect(classifyAgentIntent('把这张图重新生成为现代风格')).toBe('image-gen');
  });
  it('调研意图 → research', () => {
    expect(classifyAgentIntent('调研一下小户型开放式厨房的案例')).toBe('research');
    expect(classifyAgentIntent('帮我查下住宅设计规范对采光的要求')).toBe('research');
    expect(classifyAgentIntent('这些材料的造价行情如何')).toBe('research');
  });
  it('设计/修改意图 → plan-draft', () => {
    expect(classifyAgentIntent('设计一个 12x8米 两室一厅')).toBe('plan-draft');
    expect(classifyAgentIntent('把厨房扩大一些')).toBe('plan-draft');
  });
});

describe('composePromptWithAttachments（附件注入）', () => {
  it('无附件原样返回', () => {
    expect(composePromptWithAttachments('你好')).toBe('你好');
  });
  it('文本附件内容拼接；图片附件仅说明', () => {
    const text: Attachment = { id: 'a1', type: 'text', name: '需求.md', content: '三室两厅，两个卫生间' };
    const img: Attachment = { id: 'a2', type: 'image', name: '参考.png', imageId: 'img_up_x', url: 'data:image/png;base64,x' };
    const out = composePromptWithAttachments('按附件设计', [text, img]);
    expect(out.startsWith('按附件设计')).toBe(true);
    expect(out).toContain('[附件：需求.md]');
    expect(out).toContain('三室两厅，两个卫生间');
    expect(out).toContain('[参考图]');
    expect(out).toContain('参考.png');
    expect(out).not.toContain('未注册'); // 已注册图片不提示
  });
  it('未注册图片提示说明', () => {
    const img: Attachment = { id: 'a3', type: 'image', name: 'x.png' };
    expect(composePromptWithAttachments('看图', [img])).toContain('部分未注册');
  });
});
