/**
 * 密钥服务（用户需求：无需建口令）。
 *
 * 方案：Electron safeStorage（Windows=DPAPI 绑定当前系统用户；macOS=Keychain；Linux=libsecret）——
 * 密钥保存即系统级加密落盘，启动即可用，无需任何口令建立/解锁步骤。
 * - secrets（apiKey）：safeStorage.encryptString → base64 存 userData/secrets.json；
 * - settings（baseUrl/model）：非密，明文 JSON 同文件；
 * - safeStorage 不可用（异构 Linux 无 libsecret 等）：fail-closed 拒绝保存密钥（设置项仍可存）。
 *
 * 边界：密钥与操作系统用户账户绑定（换用户/换机不可解密——符合本产品「本地优先」定位）；
 * 原 @aichdesign/keystore（口令派生方案）保留为独立交付，app 不再使用（登记于计划文档）。
 */
import { safeStorage } from 'electron';
import * as path from 'node:path';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
export const SECRETS_REFS = {
    llmApiKey: 'llm.apiKey',
    llmBaseUrl: 'llm.baseUrl',
    llmModel: 'llm.model',
    imageApiKey: 'image.apiKey',
    imageBaseUrl: 'image.baseUrl',
    imageModel: 'image.model',
    /** R5：联网检索（research agent）——search.provider: 'disabled'|'searxng'|'duckduckgo'；search.baseUrl: SearXNG 端点。 */
    searchProvider: 'search.provider',
    searchBaseUrl: 'search.baseUrl',
};
const SECRET_REFS = new Set([SECRETS_REFS.llmApiKey, SECRETS_REFS.imageApiKey]);
const EMPTY_FILE = { version: 1, secrets: {}, settings: {} };
/**
 * R6-18：思考档位归一——minimal 档已删除，存量条目值归一为 low（读与写路径都收敛）。
 */
function normalizeThinking(value) {
    return value === 'minimal' ? 'low' : (value ?? 'off');
}
let modelSeq = 0;
export function newModelId() {
    modelSeq += 1;
    return `m-${Date.now().toString(36)}-${modelSeq}`;
}
let imageModelSeq = 0;
export function newImageModelId() {
    imageModelSeq += 1;
    return `img-${Date.now().toString(36)}-${imageModelSeq}`;
}
/**
 * R6-16 数据迁移（一次性转换既有数据，非运行时拼接）：旧 baseUrl（API Base，如 https://x/v1/）
 * → 完整端点 URL。不添加版本段——用户填的 Base 已含 /v1（此前运行时无条件补 /v1 正是 bug 根源）。
 */
function legacyBaseToFullUrls(base) {
    const b = base.trim().replace(/\/+$/, "");
    if (/\/images\/generations$/.test(b)) {
        return { url: b, editUrl: b.replace(/\/images\/generations$/, "/images/edits") };
    }
    return { url: `${b}/images/generations`, editUrl: `${b}/images/edits` };
}
export class SecretsService {
    filePath;
    cache = null;
    constructor(userDataDir) {
        this.filePath = path.join(userDataDir, 'secrets.json');
    }
    get secretsFilePath() {
        return this.filePath;
    }
    /** 系统加密是否可用（Windows/macOS 恒可用；缺 libsecret 的 Linux 为 false）。 */
    get encryptionAvailable() {
        try {
            return safeStorage.isEncryptionAvailable();
        }
        catch {
            return false;
        }
    }
    load() {
        if (this.cache)
            return this.cache;
        if (!existsSync(this.filePath)) {
            this.cache = { ...EMPTY_FILE, secrets: {}, settings: {} };
            return this.cache;
        }
        try {
            const parsed = JSON.parse(readFileSync(this.filePath, 'utf8'));
            // R6-14 修复：此前 load() 丢弃 models/activeModelId——重启后多模型配置从内存消失，
            // 且任何一次 flush 都会把无 models 的文件写回（配置丢失）。现完整保留条目字段。
            this.cache = {
                version: 1,
                secrets: parsed.secrets && typeof parsed.secrets === 'object' ? parsed.secrets : {},
                settings: parsed.settings && typeof parsed.settings === 'object' ? parsed.settings : {},
                models: Array.isArray(parsed.models) ? parsed.models : undefined,
                activeModelId: typeof parsed.activeModelId === 'string' ? parsed.activeModelId : undefined,
                imageModels: Array.isArray(parsed.imageModels) ? parsed.imageModels : undefined,
                activeImageModelId: typeof parsed.activeImageModelId === 'string' ? parsed.activeImageModelId : undefined,
            };
        }
        catch {
            process.stderr.write(`[secrets] secrets.json 损坏，按空库重建（旧文件不可读）\n`);
            this.cache = { ...EMPTY_FILE, secrets: {}, settings: {} };
        }
        return this.cache;
    }
    flush() {
        mkdirSync(path.dirname(this.filePath), { recursive: true });
        writeFileSync(this.filePath, JSON.stringify(this.load(), null, 2), 'utf8');
    }
    /**
     * R6-14/R6-16：图像条目视图。旧单条目配置（image.apiKey/baseUrl/model）懒合成为首条目，
     * 旧 baseUrl 字段经一次性迁移转换为完整端点 URL；无任何配置返回 []。
     */
    imageEntriesView(file) {
        if (file.imageModels && file.imageModels.length > 0) {
            return file.imageModels.map((m) => {
                if (m.url && m.url.length > 0) {
                    return { id: m.id, name: m.name, url: m.url, editUrl: m.editUrl ?? '', model: m.model, ...(m.apiKeyEnc ? { apiKeyEnc: m.apiKeyEnc } : {}) };
                }
                // 旧形态（baseUrl）迁移
                const legacy = m.baseUrl ?? '';
                const { url, editUrl } = legacyBaseToFullUrls(legacy);
                return { id: m.id, name: m.name, url, editUrl, model: m.model, ...(m.apiKeyEnc ? { apiKeyEnc: m.apiKeyEnc } : {}) };
            });
        }
        const legacyKey = file.secrets[SECRETS_REFS.imageApiKey];
        const legacyBase = file.settings[SECRETS_REFS.imageBaseUrl];
        const legacyModel = file.settings[SECRETS_REFS.imageModel];
        if (!legacyKey && !legacyBase && !legacyModel)
            return [];
        const { url, editUrl } = legacyBaseToFullUrls(legacyBase ?? 'https://api.openai.com/v1');
        return [
            {
                id: 'img_legacy',
                name: '默认图像端点',
                url,
                editUrl,
                model: legacyModel ?? 'gpt-image-2',
                ...(legacyKey ? { apiKeyEnc: legacyKey } : {}),
            },
        ];
    }
    /** 状态（不含密钥内容）。 */
    status() {
        const file = this.load();
        const readSetting = (ref) => file.settings[ref] ?? '';
        const imageEntries = this.imageEntriesView(file);
        const activeImageId = imageEntries.some((m) => m.id === file.activeImageModelId)
            ? (file.activeImageModelId ?? '')
            : (imageEntries[0]?.id ?? '');
        return {
            available: this.encryptionAvailable,
            hasLlmKey: (file.secrets[SECRETS_REFS.llmApiKey] ?? '').length > 0,
            llmBaseUrl: readSetting(SECRETS_REFS.llmBaseUrl),
            llmModel: readSetting(SECRETS_REFS.llmModel),
            searchProvider: readSetting(SECRETS_REFS.searchProvider),
            searchBaseUrl: readSetting(SECRETS_REFS.searchBaseUrl),
            models: (file.models ?? []).map((m) => ({
                id: m.id,
                name: m.name,
                baseUrl: m.baseUrl,
                model: m.model,
                thinking: normalizeThinking(m.thinking),
                hasKey: (m.apiKeyEnc ?? '').length > 0,
            })),
            activeModelId: file.activeModelId ?? '',
            imageModels: imageEntries.map((m) => ({
                id: m.id,
                name: m.name,
                url: m.url,
                editUrl: m.editUrl,
                model: m.model,
                hasKey: (m.apiKeyEnc ?? '').length > 0,
            })),
            activeImageModelId: activeImageId,
            sessionsDirOverride: file.settings['app.sessionsDir'] ?? '',
            maxToolCalls: Number(file.settings['app.agent.maxToolCalls']) > 0 ? Number(file.settings['app.agent.maxToolCalls']) : 25,
        };
    }
    /**
     * 保存多模型条目（R6-6）：全量替换。
     * apiKey 语义：undefined = 保留原 Key；'' = 清除；非空 = 覆盖（safeStorage 加密）。
     */
    saveModels(entries, activeModelId) {
        if (!Array.isArray(entries))
            throw new Error('模型列表必须为数组');
        const file = this.load();
        const old = new Map((file.models ?? []).map((m) => [m.id, m]));
        file.models = entries.map((e) => {
            const id = e.id && e.id.length > 0 ? e.id : newModelId();
            const prev = old.get(e.id ?? '');
            let apiKeyEnc = prev?.apiKeyEnc;
            if (e.apiKey !== undefined) {
                apiKeyEnc = e.apiKey.length === 0 ? undefined : this.encryptionAvailable
                    ? safeStorage.encryptString(e.apiKey).toString('base64')
                    : (() => {
                        throw new Error('系统加密不可用，拒绝明文保存 Key');
                    })();
            }
            return {
                id,
                name: (e.name || e.model || '未命名').slice(0, 60),
                baseUrl: (e.baseUrl ?? '').trim(),
                model: (e.model ?? '').trim(),
                apiKeyEnc,
                thinking: normalizeThinking(e.thinking),
            };
        });
        file.activeModelId = file.models.some((m) => m.id === activeModelId) ? activeModelId : (file.models[0]?.id ?? '');
        this.flush();
        return this.status();
    }
    /** 读取注入用模型条目（含解密 Key；仅主进程 spawn 注入用）。 */
    modelsForInjection() {
        const file = this.load();
        return (file.models ?? [])
            .map((m) => {
            let apiKey = '';
            if (m.apiKeyEnc && m.apiKeyEnc.length > 0) {
                try {
                    apiKey = safeStorage.decryptString(Buffer.from(m.apiKeyEnc, 'base64'));
                }
                catch {
                    apiKey = '';
                }
            }
            return { id: m.id, name: m.name, baseUrl: m.baseUrl, model: m.model, apiKey, thinking: normalizeThinking(m.thinking) };
        })
            .filter((m) => m.baseUrl.length > 0 && m.model.length > 0 && m.apiKey.length > 0);
    }
    activeModelId() {
        return this.load().activeModelId ?? '';
    }
    /**
     * 保存多图像服务商条目（R6-14）：全量替换，apiKey 语义同 saveModels
     * （undefined = 保留原 Key；'' = 清除；非空 = 覆盖）。
     * 未持久化的旧单条目迁移视图参与合并（保住其既有 Key）。
     */
    saveImageModels(entries, activeImageModelId) {
        if (!Array.isArray(entries))
            throw new Error('图像模型列表必须为数组');
        const file = this.load();
        const stored = new Map((file.imageModels ?? []).map((m) => [m.id, m]));
        const view = this.imageEntriesView(file);
        const prevMap = stored.size > 0 ? stored : new Map(view.map((m) => [m.id, m]));
        file.imageModels = entries.map((e) => {
            const id = e.id && e.id.length > 0 ? e.id : newImageModelId();
            const prev = prevMap.get(e.id ?? '');
            let apiKeyEnc = prev?.apiKeyEnc;
            if (e.apiKey !== undefined) {
                apiKeyEnc = e.apiKey.length === 0 ? undefined : this.encryptionAvailable
                    ? safeStorage.encryptString(e.apiKey).toString('base64')
                    : (() => {
                        throw new Error('系统加密不可用，拒绝明文保存 Key');
                    })();
            }
            return {
                id,
                name: (e.name || e.model || '未命名图像端点').slice(0, 60),
                url: (e.url ?? '').trim(),
                editUrl: (e.editUrl ?? '').trim(),
                model: (e.model ?? '').trim(),
                apiKeyEnc,
            };
        });
        file.activeImageModelId = file.imageModels.some((m) => m.id === activeImageModelId)
            ? activeImageModelId
            : (file.imageModels[0]?.id ?? '');
        this.flush();
        return this.status();
    }
    /** 读取注入用图像条目（含解密 Key；仅主进程 spawn 注入用；url/model/Key 齐备才有效）。 */
    imageModelsForInjection() {
        const file = this.load();
        return this.imageEntriesView(file)
            .map((m) => {
            let apiKey = '';
            if (m.apiKeyEnc && m.apiKeyEnc.length > 0) {
                try {
                    apiKey = safeStorage.decryptString(Buffer.from(m.apiKeyEnc, 'base64'));
                }
                catch {
                    apiKey = '';
                }
            }
            return { id: m.id, name: m.name, url: m.url, editUrl: m.editUrl, model: m.model, apiKey };
        })
            .filter((m) => m.url.length > 0 && m.model.length > 0 && m.apiKey.length > 0);
    }
    activeImageModelId() {
        return this.load().activeImageModelId ?? '';
    }
    /** 非密设置写入口（R6-6：自定义会话目录等）。 */
    setSetting(key, value) {
        const file = this.load();
        if (value.length === 0)
            delete file.settings[key];
        else
            file.settings[key] = value;
        this.flush();
    }
    /** 非密设置读取（同步；sessionsDir 覆盖等启动路径用）。 */
    getSetting(key) {
        return this.load().settings[key] ?? '';
    }
    /**
     * 保存配置（undefined 不改；'' 清除）。
     * 密钥条目需系统加密可用（fail-closed：不可用即抛错，设置项仍可保存）。
     */
    saveKeys(input) {
        if (!input || typeof input !== 'object')
            throw new Error('配置必须为对象');
        const file = this.load();
        const entries = [
            [SECRETS_REFS.llmApiKey, input.llmApiKey],
            [SECRETS_REFS.llmBaseUrl, input.llmBaseUrl],
            [SECRETS_REFS.llmModel, input.llmModel],
            [SECRETS_REFS.imageApiKey, input.imageApiKey],
            [SECRETS_REFS.imageBaseUrl, input.imageBaseUrl],
            [SECRETS_REFS.imageModel, input.imageModel],
            [SECRETS_REFS.searchProvider, input.searchProvider],
            [SECRETS_REFS.searchBaseUrl, input.searchBaseUrl],
        ];
        let touchedSecret = false;
        for (const [ref, value] of entries) {
            if (value === undefined)
                continue;
            if (SECRET_REFS.has(ref)) {
                if (value.length === 0) {
                    delete file.secrets[ref];
                    touchedSecret = true;
                }
                else {
                    if (!this.encryptionAvailable) {
                        throw new Error('系统加密不可用（safeStorage），拒绝明文保存密钥；Base URL/模型等设置项可正常保存');
                    }
                    file.secrets[ref] = safeStorage.encryptString(value).toString('base64');
                    touchedSecret = true;
                }
            }
            else {
                if (value.length === 0)
                    delete file.settings[ref];
                else
                    file.settings[ref] = value;
            }
        }
        this.flush();
        void touchedSecret;
        return this.status();
    }
    /** 读取密钥（仅主进程注入用；未配置/解密失败返回 null）。 */
    readSecret(ref) {
        const enc = this.load().secrets[ref];
        if (!enc || enc.length === 0)
            return null;
        try {
            const value = safeStorage.decryptString(Buffer.from(enc, 'base64'));
            return value.length > 0 ? value : null;
        }
        catch {
            process.stderr.write(`[secrets] 密钥解密失败（系统用户变更或文件损坏）：${ref}\n`);
            return null;
        }
    }
    /** 读取设置值（非密）。 */
    readSetting(ref) {
        const v = this.load().settings[ref] ?? '';
        return v.length > 0 ? v : null;
    }
}
//# sourceMappingURL=secretsService.js.map