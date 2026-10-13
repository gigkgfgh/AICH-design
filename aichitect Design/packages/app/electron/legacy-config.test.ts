import { describe, expect, it } from 'vitest';
import { legacyRefsToPurgeOnEmpty, shouldFallBackToLegacy } from './legacy-config.js';

describe("端点删除的遗留字段清理规则", () => {
  it("条目清空时清除全部 LLM/图像旧单字段", () => {
    const purge = legacyRefsToPurgeOnEmpty(0, {});
    expect(purge.secrets).toContain('llm.apiKey');
    expect(purge.secrets).toContain('image.apiKey');
    expect(purge.settings).toContain('llm.baseUrl');
    expect(purge.settings).toContain('llm.model');
    expect(purge.settings).toContain('image.baseUrl');
    expect(purge.settings).toContain('image.model');
  });

  it("条目未清空时不动旧字段（保留老用户兼容回退）", () => {
    expect(legacyRefsToPurgeOnEmpty(1, {})).toEqual({ secrets: [], settings: [] });
    expect(legacyRefsToPurgeOnEmpty(3, { 'search.provider': 'deepseek' })).toEqual({ secrets: [], settings: [] });
  });

  it("search.provider 为 deepseek 时一并清除（它复用模型条目凭据）", () => {
    const purge = legacyRefsToPurgeOnEmpty(0, { 'search.provider': 'deepseek' });
    expect(purge.settings).toContain('search.provider');
  });

  it("search.provider 为其它值时保留（如用户自配 searxng）", () => {
    const purge = legacyRefsToPurgeOnEmpty(0, { 'search.provider': 'searxng' });
    expect(purge.settings).not.toContain('search.provider');
  });

  it("未设置 search.provider 时不产生该key（避免写入无意义的删除记录）", () => {
    const purge = legacyRefsToPurgeOnEmpty(0, {});
    expect(purge.settings.filter((s) => s === 'search.provider')).toHaveLength(0);
  });
});

describe("旧单字段回退的准入判定", () => {
  it("有可注入条目 → 不回退（走新链路）", () => {
    expect(shouldFallBackToLegacy(2, 2)).toEqual({ allow: false, reason: 'ok' });
  });

  it("条目全部校验失败 → 不回退，避免'假接线'", () => {
    // 这是「删除端点后依然可用」的第二道闸：条目存在但注入列表为空时，
    // 若回退旧字段就会把已删除/已损坏的端点重新接上。
    expect(shouldFallBackToLegacy(0, 1)).toEqual({ allow: false, reason: 'entries-invalid' });
  });

  it("从未配置过任何条目 → 允许回退（老用户兼容路径）", () => {
    expect(shouldFallBackToLegacy(0, 0)).toEqual({ allow: true, reason: 'no-config' });
  });

  it("回归：条目被清空后 configuredEntries 也为 0，判定为 no-config", () => {
    // 清空路径的完整推演：saveModels([]) 已删除旧字段，此处读到全 0 → 允许回退，
    // 但回退分支读到的 llmKey 也是 null，最终不注入任何 LLM 配置。
    expect(shouldFallBackToLegacy(0, 0).allow).toBe(true);
  });
});