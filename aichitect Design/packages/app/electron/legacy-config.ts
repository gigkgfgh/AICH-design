/**
 * 端点条目清空时的**遗留字段清理**规则（纯逻辑，便于单测）。
 *
 * 问题背景：模型/图像端点有两套存储——新的多条目列表（`models` / `imageModels`）
 * 与历史的旧单字段（`settings['llm.*']` / `secrets['llm.apiKey']` 等）。
 * 主进程 `buildAgentServiceEnv` 在条目列表为空时会**回退读旧单字段**。
 * 若删除条目时不同步清除旧字段，就会出现「删除端点后依然可用」：
 * 用户以为删了，实际只是从新列表消失，旧的还在生效。
 *
 * 这也是本项目最隐蔽的一类"假删除"——UI 显示已清空，服务照常工作。
 */

/** 清空 LLM 条目时需清除的旧单字段（含联网检索的 deepseek 复用项）。 */
export const LLM_LEGACY_REFS = {
  secrets: ['llm.apiKey'] as const,
  settings: ['llm.baseUrl', 'llm.model'] as const,
  /** 条目为空时这些设置已无凭据支撑，需一并关闭/清除。 */
  settingsWhenEmpty: ['search.provider'] as const,
  /** 仅当 provider 为 deepseek 时清除（它复用模型条目的凭据）。 */
  settingsToClearIfValue: { 'search.provider': 'deepseek' } as Record<string, string>,
};

/** 清空图像条目时需清除的旧单字段。 */
export const IMAGE_LEGACY_REFS = {
  secrets: ['image.apiKey'] as const,
  settings: ['image.baseUrl', 'image.model'] as const,
};

/**
 * 依据「清空后条目数」计算需要清除的旧字段。
 *
 * @param remainingEntries 清空操作后剩余的条目数（0 = 全部删除）
 * @param currentSettings 当前 settings 快照（用于判断 search.provider 是否为 deepseek）
 */
export function legacyRefsToPurgeOnEmpty(
  remainingEntries: number,
  currentSettings: Record<string, string>,
): { secrets: string[]; settings: string[] } {
  if (remainingEntries > 0) {
    // 未清空：不动旧字段（老用户的历史配置仍应作为兼容回退保留）
    return { secrets: [], settings: [] };
  }
  const settings: string[] = [...LLM_LEGACY_REFS.settings, ...IMAGE_LEGACY_REFS.settings];
  const secrets: string[] = [...LLM_LEGACY_REFS.secrets, ...IMAGE_LEGACY_REFS.secrets];
  for (const [key, expected] of Object.entries(LLM_LEGACY_REFS.settingsToClearIfValue)) {
    if (currentSettings[key] === expected) settings.push(key);
  }
  return { secrets, settings };
}

/**
 * 旧单字段回退是否应当生效。
 *
 * 规则：条目列表为空、且没有「条目存在但校验未通过」的情形时，才允许回退。
 * `hasEntriesButAllInvalid` 对应 R7-2 的"假接线"防护——此时宁可不注入并告警。
 */
export function shouldFallBackToLegacy(
  injectableEntries: number,
  configuredEntries: number,
): { allow: boolean; reason: 'ok' | 'no-config' | 'entries-invalid' } {
  if (injectableEntries > 0) return { allow: false, reason: 'ok' };
  if (configuredEntries > 0) return { allow: false, reason: 'entries-invalid' };
  return { allow: true, reason: 'no-config' };
}