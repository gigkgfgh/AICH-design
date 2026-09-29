/**
 * KeyStore 主进程服务（P016 接线轮 + 用户自配 Key 设置面板）。
 *
 * 职责：
 * - 密钥库生命周期：首启建立（setup）/ 解锁（unlock，口令仅存主进程内存）/ 状态查询；
 * - Key 配置存取（LLM / 图像：apiKey 为密钥条目，baseUrl/model 为设置条目，全量 AES-GCM 落盘）；
 * - spawn 环境注入：解锁后把 Key 以环境变量注入 agent-service（保持 R2 边界：
 *   图像 Key 真实生效 resolveImagePort；LLM Key 已注入 config，真实流式接线为后续轮）。
 *
 * 安全：口令与 Key 永不返回渲染层（status 只回布尞/非密设置）；口令不做本地持久化。
 */
import * as path from 'node:path';
import { existsSync } from 'node:fs';
import { AesGcmFileKeyStore, KeyStoreError } from '@aichdesign/keystore';
/** 密钥库条目引用（keyRef；AAD 绑定）。 */
export const REFS = {
    llmApiKey: 'llm.apiKey',
    llmBaseUrl: 'llm.baseUrl',
    llmModel: 'llm.model',
    imageApiKey: 'image.apiKey',
    imageBaseUrl: 'image.baseUrl',
    imageModel: 'image.model',
};
/** 口令强度下限（登记边界：非复杂度策略，仅最短长度 + 非全同字符）。 */
function assertPassphraseQuality(passphrase) {
    if (passphrase.length < 8) {
        throw new Error('口令至少 8 个字符');
    }
    if (/^(.)\1+$/.test(passphrase)) {
        throw new Error('口令不能为单一重复字符');
    }
}
export class KeyStoreService {
    store = null;
    filePath;
    constructor(userDataDir) {
        this.filePath = path.join(userDataDir, 'keystore', 'keys.bin');
    }
    get unlocked() {
        return this.store !== null;
    }
    get keystoreFilePath() {
        return this.filePath;
    }
    /** 状态（含 Key 存在性与非密设置；未解锁时只报 exists/unlocked）。 */
    async status() {
        const exists = existsSync(this.filePath);
        if (!this.store) {
            return {
                exists,
                unlocked: false,
                hasLlmKey: false,
                hasImageKey: false,
                llmBaseUrl: '',
                llmModel: '',
                imageBaseUrl: '',
                imageModel: '',
            };
        }
        const read = async (ref) => {
            const v = await this.store.read(ref).catch(() => null);
            return v ?? '';
        };
        return {
            exists,
            unlocked: true,
            hasLlmKey: (await read(REFS.llmApiKey)).length > 0,
            hasImageKey: (await read(REFS.imageApiKey)).length > 0,
            llmBaseUrl: await read(REFS.llmBaseUrl),
            llmModel: await read(REFS.llmModel),
            imageBaseUrl: await read(REFS.imageBaseUrl),
            imageModel: await read(REFS.imageModel),
        };
    }
    /** 首启建立密钥库（已存在则抛错）。 */
    setup(passphrase) {
        assertPassphraseQuality(passphrase);
        if (existsSync(this.filePath)) {
            throw new Error('密钥库已存在（请用口令解锁，而非重新建立）');
        }
        this.store = new AesGcmFileKeyStore({ filePath: this.filePath, passphrase });
        // 立即落盘骨架（首启即产生文件；条目本身无意义但触发布盘）
        void this.store.write('__init__', new Date().toISOString());
    }
    /** 解锁（口令校验）；成功返回 true，错口令返回 false，文件损坏抛错。 */
    unlock(passphrase) {
        try {
            this.store = new AesGcmFileKeyStore({ filePath: this.filePath, passphrase });
            return true;
        }
        catch (err) {
            if (err instanceof KeyStoreError && /口令错误|篡改/.test(err.message))
                return false;
            throw err;
        }
    }
    /** 保存 Key 配置（须先解锁）。undefined 不改；'' 清除；返回最新状态。 */
    async saveKeys(input) {
        if (!this.store) {
            throw new Error('密钥库未解锁（先输入口令解锁）');
        }
        const entries = [
            [REFS.llmApiKey, input.llmApiKey],
            [REFS.llmBaseUrl, input.llmBaseUrl],
            [REFS.llmModel, input.llmModel],
            [REFS.imageApiKey, input.imageApiKey],
            [REFS.imageBaseUrl, input.imageBaseUrl],
            [REFS.imageModel, input.imageModel],
        ];
        for (const [ref, value] of entries) {
            if (value === undefined)
                continue;
            // 空串与其它值统一走 write（KeyStorePort 无 delete：空串 = 无 Key 语义）
            await this.store.write(ref, value);
        }
        return this.status();
    }
    /** 读取密钥（仅主进程内部注入用；未配置/已清除返回 null）。 */
    async readSecret(ref) {
        if (!this.store)
            return null;
        const v = await this.store.read(ref).catch(() => null);
        return v && v.length > 0 ? v : null;
    }
    /** 读取设置值（baseUrl/model；未配置返回 null）。 */
    async readSetting(ref) {
        return this.readSecret(ref);
    }
}
//# sourceMappingURL=keyStoreService.js.map