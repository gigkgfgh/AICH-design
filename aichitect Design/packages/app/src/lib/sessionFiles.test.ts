/**
 * sessionFiles 纯函数测试：列表摘要（标题/计数/时间）、完整解析（消息/图像/版本引用）、
 * 损坏行容错、sessionId 白名单。
 */

import { describe, it, expect } from 'vitest';
import { parseSessionContent, summarizeSession, SESSION_ID_RE } from './sessionFiles';

const USER_LINE = (text: string, ts = '2026-08-24T01:00:00Z') =>
  JSON.stringify({ ts, kind: 'user', requestId: 'r1', data: { text, kind: 'draftPlan' } });

const PLAN_LINE = (versionId: string, ts = '2026-08-24T01:00:01Z') =>
  JSON.stringify({ ts, kind: 'assistant', requestId: 'r1', data: { kind: 'plan', versionId } });

const STREAM_LINE = (delta: string) =>
  JSON.stringify({ ts: '2026-08-24T01:00:02Z', kind: 'assistant', requestId: 'r1', data: { kind: 'stream', text: delta } });

const IMAGE_LINE = (imageId: string, url: string, parentVersionId?: string) =>
  JSON.stringify({
    ts: '2026-08-24T01:00:03Z',
    kind: 'image',
    requestId: 'r2',
    data: {
      imageId,
      url,
      meta: { prompt: 'p', model: 'm', provider: 'mock', parentVersionId, createdAt: '2026-08-24T01:00:03Z' },
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
      USER_LINE('设计一个 12x8米 的两室一厅，主卧朝南带卫生间，客厅要大一些采光好，还要有书房和南北阳台'),
      PLAN_LINE('v_1'),
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
  it('消息流 + 版本引用 + 图像条目完整恢复', () => {
    const content = [
      USER_LINE('设计 12x8米 两室一厅'),
      PLAN_LINE('v_1'),
      IMAGE_LINE('img_1', 'file:///D:/data/sessions/images/img_1.png', 'v_1'),
      'not-json-line',
      STREAM_LINE('已完成'),
    ].join('\n');
    const c = parseSessionContent('s1', content);
    expect(c.messages.map((m) => m.role)).toEqual(['user', 'assistant', 'assistant']);
    expect(c.messages[1]?.planVersionId).toBe('v_1');
    expect(c.messages[1]?.text).toBe('已生成方案版本 v_1。');
    expect(c.versionRefs).toEqual([{ versionId: 'v_1', createdAt: '2026-08-24T01:00:01Z' }]);
    expect(c.images.length).toBe(1);
    expect(c.images[0]?.url).toBe('file:///D:/data/sessions/images/img_1.png');
    expect(c.images[0]?.parentPlanVersionId).toBe('v_1');
    expect(c.title).toBe('设计 12x8米 两室一厅');
  });

  it('usage/error 行不进消息流；损坏行跳过不抛错', () => {
    const content = [USER_LINE('你好'), USAGE_LINE, '{broken', PLAN_LINE('v_2')].join('\n');
    const c = parseSessionContent('s1', content);
    expect(c.messages.length).toBe(2);
    expect(c.versionRefs[0]?.versionId).toBe('v_2');
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
