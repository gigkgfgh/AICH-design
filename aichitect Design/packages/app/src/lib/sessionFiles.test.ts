/**
 * sessionFiles 纯函数测试：列表摘要（标题/计数/时间）、完整解析（消息/图像）、
 * 遗留 plan 条目容错、损坏行容错、sessionId 白名单。
 */

import { describe, it, expect } from 'vitest';
import { parseSessionContent, summarizeSession, SESSION_ID_RE } from './sessionFiles';

const USER_LINE = (text: string, ts = '2026-08-24T01:00:00Z') =>
  JSON.stringify({ ts, kind: 'user', requestId: 'r1', data: { text, kind: 'chat' } });

/** 遗留 plan 条目（R7-1 前的数据；解析层应忽略而非报错） */
const LEGACY_PLAN_LINE = (versionId: string, ts = '2026-08-24T01:00:01Z') =>
  JSON.stringify({ ts, kind: 'assistant', requestId: 'r1', data: { kind: 'plan', versionId } });

const STREAM_LINE = (delta: string) =>
  JSON.stringify({ ts: '2026-08-24T01:00:02Z', kind: 'assistant', requestId: 'r1', data: { kind: 'stream', text: delta } });

const IMAGE_LINE = (imageId: string, url: string) =>
  JSON.stringify({
    ts: '2026-08-24T01:00:03Z',
    kind: 'image',
    requestId: 'r2',
    data: {
      imageId,
      url,
      meta: { prompt: 'p', model: 'm', provider: 'openai', createdAt: '2026-08-24T01:00:03Z' },
    },
  });

const USAGE_LINE = JSON.stringify({
  ts: '2026-08-24T01:00:04Z',
  kind: 'usage',
  requestId: 'r1',
  data: { costUsd: 0.01 },
});

describe('summarizeSession', () => {
  it('标题 = 首条用户消息（超长截断）；计数与最后时间', () => {
    const content = [
      USER_LINE('生成一张 12x8米 客厅的表现图，主卧朝南带卫生间，客厅要大一些采光好，还要有书房和南北阳台'),
      LEGACY_PLAN_LINE('v_1'),
      STREAM_LINE('正在解析…'),
      USAGE_LINE,
    ].join('\n');
    const s = summarizeSession('s1', content);
    expect(s.sessionId).toBe('s1');
    expect(s.title.endsWith('…')).toBe(true);
    expect(s.title.length).toBeLessThanOrEqual(41);
    expect(s.messageCount).toBe(3); // user + 2 assistant
    expect(s.lastTs).toBe('2026-08-24T01:00:04Z'); // usage 行 ts 也算最后活动
  });

  it('无用户消息 → 占位标题；空文件容错', () => {
    expect(summarizeSession('s2', '').messageCount).toBe(0);
    expect(summarizeSession('s2', '').title).toBe('（无标题会话）');
  });
});

describe('parseSessionContent', () => {
  it('消息流 + 图像条目完整恢复；遗留 plan 条目忽略；损坏行跳过', () => {
    const content = [
      USER_LINE('生成一张客厅表现图'),
      LEGACY_PLAN_LINE('v_1'),
      IMAGE_LINE('img_1', 'file:///D:/data/sessions/images/img_1.png'),
      'not-json-line',
      STREAM_LINE('已完成'),
    ].join('\n');
    const c = parseSessionContent('s1', content);
    // 遗留 plan 条目（无文本）不产生消息；kind:"image" 行只进图像列表，不进消息流
    expect(c.messages.map((m) => m.role)).toEqual(['user', 'assistant']);
    expect(c.messages[1]?.text).toBe('已完成');
    expect(c.images.length).toBe(1);
    expect(c.images[0]?.url).toBe('file:///D:/data/sessions/images/img_1.png');
    expect(c.title).toBe('生成一张客厅表现图');
  });

  it('R7-2：user 条目 imageIds 经 image 条目回填为 file:// 图片（重启后历史图可预览）', () => {
    const content = [
      JSON.stringify({ ts: '2026-08-24T01:00:00Z', kind: 'image', data: { imageId: 'img_up_1', url: 'file:///D:/sessions/images/img_up_1.png', meta: { prompt: 'p', model: 'user-upload', provider: 'user' } } }),
      JSON.stringify({ ts: '2026-08-24T01:00:01Z', kind: 'user', requestId: 'r1', data: { text: '看这张图', kind: 'chat', imageIds: ['img_up_1'] } }),
    ].join('\n');
    const c = parseSessionContent('s1', content);
    expect(c.messages.length).toBe(1);
    expect(c.messages[0]?.images).toEqual(['file:///D:/sessions/images/img_up_1.png']);
    // 无 imageIds 的 user 消息不带 images 字段
    const c2 = parseSessionContent('s2', USER_LINE('你好'));
    expect(c2.messages[0]?.images).toBeUndefined();
  });

  it('R7-2 反馈：canvasRemoved 图片只移出画布——对话引用回填保留', () => {
    const imgLine = (id: string, removed: boolean) =>
      JSON.stringify({
        ts: '2026-08-24T01:00:00Z',
        kind: 'image',
        data: {
          imageId: id,
          url: `file:///D:/sessions/images/${id}.png`,
          meta: { prompt: 'p', model: 'm', provider: 'user' },
          ...(removed ? { canvasRemoved: true } : {}),
        },
      });
    const userLine = JSON.stringify({
      ts: '2026-08-24T01:00:01Z',
      kind: 'user',
      requestId: 'r1',
      data: { text: '看这两张图', kind: 'chat', imageIds: ['img_a', 'img_b'] },
    });
    const content = [imgLine('img_a', true), imgLine('img_b', false), userLine].join('\n');
    const c = parseSessionContent('s1', content);
    // 画布：仅保留未删除的 img_b
    expect(c.images.map((i) => i.imageId)).toEqual(['img_b']);
    // 对话：两张图引用都回填（不受画布删除影响）
    expect(c.messages.length).toBe(1);
    expect(c.messages[0]?.images).toEqual([
      'file:///D:/sessions/images/img_a.png',
      'file:///D:/sessions/images/img_b.png',
    ]);
  });

  it('usage/error 行不进消息流', () => {
    const content = [USER_LINE('你好'), USAGE_LINE, '{broken'].join('\n');
    const c = parseSessionContent('s1', content);
    expect(c.messages.length).toBe(1);
  });

  it('R7-2：usage 行聚合回填（重启后用量胶囊恢复；last* 对齐 SSE prompt 口径）', () => {
    const usageLine = (miss: number, hit: number, out: number, total: number, withCtx: boolean) =>
      JSON.stringify({
        ts: '2026-08-24T02:00:00Z',
        kind: 'usage',
        requestId: 'r1',
        data: {
          promptTokens: miss,
          completionTokens: out,
          cacheReadTokens: hit,
          cacheWriteTokens: 0,
          totalTokens: total,
          ...(withCtx ? { context: { systemTokens: 1200, toolTokens: 800, contextWindow: 1_000_000 } } : {}),
        },
      });
    // 两轮 usage：最后一行决定 last*；context 只在有该段时回填
    const withCtx = [
      USER_LINE('你好'),
      usageLine(500, 2000, 300, 2800, true),
      usageLine(800, 5000, 400, 6200, true),
    ].join('\n');
    const c = parseSessionContent('s1', withCtx);
    expect(c.messages.length).toBe(1);
    expect(c.usage).toBeDefined();
    expect(c.usage!.sessionInput).toBe(1300); // miss 累计
    expect(c.usage!.sessionCacheRead).toBe(7000);
    expect(c.usage!.sessionOutput).toBe(700);
    expect(c.usage!.sessionTotal).toBe(9000);
    expect(c.usage!.lastPromptTokens).toBe(800 + 5000); // miss + hit（SSE prompt_tokens 口径）
    expect(c.usage!.lastCompletionTokens).toBe(400);
    expect(c.usage!.contextWindow).toBe(1_000_000);
    expect(c.usage!.contextSystemTokens).toBe(1200);
    // 旧数据：usage 行无 context 段 → 窗口 0（UI 显示 —），仍回填累计
    const legacy = [USER_LINE('你好'), usageLine(500, 2000, 300, 2800, false)].join('\n');
    const c2 = parseSessionContent('s2', legacy);
    expect(c2.usage!.sessionTotal).toBe(2800);
    expect(c2.usage!.contextWindow).toBe(0);
    // 无 usage 行 → 不带 usage 字段（胶囊隐藏）
    const c3 = parseSessionContent('s3', USER_LINE('你好'));
    expect(c3.usage).toBeUndefined();
  });
});

describe('SESSION_ID_RE', () => {
  it('与后端白名单同源', () => {
    expect(SESSION_ID_RE.test('session-abc_1.2')).toBe(true);
    expect(SESSION_ID_RE.test('../victim')).toBe(false);
    expect(SESSION_ID_RE.test('')).toBe(false);
    expect(SESSION_ID_RE.test('a'.repeat(65))).toBe(false);
  });
});
