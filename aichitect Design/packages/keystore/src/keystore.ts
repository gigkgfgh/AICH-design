/**
 * KeyStore（P016，R3 计划 §7 契约 4）。
 *
 * 设计：
 * - `KeyStorePort` 抽象（read / has / write）——真实 Key 永不落日志、不经进程通信暴露
 *   （后续 in-proxy 语义：注入式凭据只在主进程 → 网关链路内替换占位符，沙箱进程不见原文）；
 * - `AesGcmFileKeyStore` 加密文件实现：
 *   - 口令来源：`AICH_KEYSTORE_PASSPHRASE` 环境变量（或构造参数；交互提示为 UI 层占位）；
 *   - 主密钥 = scrypt(口令, storeSalt, 32)（N=16384, r=8, p=1，防 GPU 暴破的内存参数）；
 *   - 条目加密 = AES-256-GCM（随机 12B IV，AAD=keyRef 防条目互换攻击）；
 *   - 落盘格式：版本化 JSON { version, kdf, entries }（base64 字段），0600 权限尽力设置；
 *   - 篡改/错口令 → GCM 认证失败 → 抛错（fail-closed，绝不返回猜测明文）。
 *
 * 本轮接线边界（README 登记）：agent-service 仍接收主进程环境变量注入的 Key（保持 R2 行为）；
 * 本包为 Electron 主进程后续轮接线准备的独立可测交付。
 */

import { createCipheriv, createDecipheriv, randomBytes, scryptSync, timingSafeEqual } from "node:crypto";
import { existsSync, readFileSync, writeFileSync, chmodSync, mkdirSync } from "node:fs";
import { dirname } from "node:path";

/** 密钥存储抽象（主进程持有；沙箱/渲染进程不可达）。 */
export interface KeyStorePort {
  /** 读取密钥（不存在返回 null；篡改/错口令抛错）。 */
  read(keyRef: string): Promise<string | null>;
  /** 是否存在该密钥条目。 */
  has(keyRef: string): Promise<boolean>;
  /** 写入/覆盖密钥条目（主进程注入链路用）。 */
  write(keyRef: string, secret: string): Promise<void>;
}

/** scrypt 参数（OWASP 2023 建议下限 N=2^14；防 GPU 暴破的内存硬度）。 */
export interface KdfParams {
  N: number;
  r: number;
  p: number;
  keyLen: number;
}

export const DEFAULT_KDF_PARAMS: Readonly<KdfParams> = Object.freeze({ N: 16384, r: 8, p: 1, keyLen: 32 });

/** 落盘格式（版本化；升级 = version 递增 + 迁移逻辑）。 */
interface StoreFile {
  version: 1;
  kdf: { name: "scrypt"; salt: string; N: number; r: number; p: number; keyLen: number };
  entries: Record<string, { iv: string; tag: string; data: string }>;
}

/** 环境变量口令名（首启口令；交互提示由 UI 层实现，此处只认环境/参数）。 */
export const KEYSTORE_PASSPHRASE_ENV = "AICH_KEYSTORE_PASSPHRASE";

/** 存储错误（fail-closed 语义统一类型）。 */
export class KeyStoreError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "KeyStoreError";
  }
}

export interface AesGcmFileKeyStoreOptions {
  /** 密钥库文件路径（如 <userData>/keystore/keys.bin）。 */
  filePath: string;
  /** 口令（缺省读 AICH_KEYSTORE_PASSPHRASE；无口令 → 构造抛错）。 */
  passphrase?: string;
  /** scrypt 参数覆写（测试加速用小参数；生产用默认）。 */
  kdf?: Partial<KdfParams>;
}

export class AesGcmFileKeyStore implements KeyStorePort {
  private readonly filePath: string;
  private readonly kdf: KdfParams;
  private storeSalt!: Buffer;

  constructor(options: AesGcmFileKeyStoreOptions) {
    this.filePath = options.filePath;
    this.kdf = { ...DEFAULT_KDF_PARAMS, ...options.kdf };
    const passphrase = options.passphrase ?? process.env[KEYSTORE_PASSPHRASE_ENV];
    if (!passphrase || passphrase.length === 0) {
      throw new KeyStoreError(
        `缺少口令：设置 ${KEYSTORE_PASSPHRASE_ENV} 或构造参数 passphrase（首启口令，UI 交互提示为占位）`,
      );
    }
    this.passphrase = passphrase;
    // 读盘/建库并派生主密钥（口令与 storeSalt 绑定；篡改/错口令在解密时 fail-closed）。
    this.loadOrCreate();
  }

  private readonly passphrase: string;
  private masterKeyBuf: Buffer = Buffer.alloc(0);
  private entries: StoreFile["entries"] = {};

  /** 主密钥派生：scrypt(口令, storeSalt)——与落盘 kdf 参数一致。 */
  private deriveMasterKey(salt: Buffer): Buffer {
    return scryptSync(this.passphrase, salt, this.kdf.keyLen, {
      N: this.kdf.N,
      r: this.kdf.r,
      p: this.kdf.p,
    });
  }

  /** 读盘（不存在 → 空库骨架 + 新 salt；存在 → 校验格式并派生主密钥）。 */
  private loadOrCreate(): void {
    if (!existsSync(this.filePath)) {
      this.storeSalt = randomBytes(16);
      this.masterKeyBuf = this.deriveMasterKey(this.storeSalt);
      this.entries = {};
      return;
    }
    let parsed: StoreFile;
    try {
      parsed = JSON.parse(readFileSync(this.filePath, "utf8")) as StoreFile;
    } catch {
      throw new KeyStoreError(`密钥库文件损坏（非 JSON）：${this.filePath}`);
    }
    if (parsed.version !== 1 || parsed.kdf?.name !== "scrypt" || typeof parsed.entries !== "object") {
      throw new KeyStoreError(`密钥库格式不识别（version=${String(parsed.version)}），fail-closed 拒绝`);
    }
    this.storeSalt = Buffer.from(parsed.kdf.salt, "base64");
    this.masterKeyBuf = this.deriveMasterKey(this.storeSalt);
    this.entries = parsed.entries;
  }

  /** 全量落盘（原子性：直接覆写；文件权限 0600 尽力设置，Windows 上为 no-op）。 */
  private flush(): void {
    const file: StoreFile = {
      version: 1,
      kdf: {
        name: "scrypt",
        salt: this.storeSalt.toString("base64"),
        N: this.kdf.N,
        r: this.kdf.r,
        p: this.kdf.p,
        keyLen: this.kdf.keyLen,
      },
      entries: this.entries,
    };
    mkdirSync(dirname(this.filePath), { recursive: true });
    writeFileSync(this.filePath, JSON.stringify(file), { encoding: "utf8", mode: 0o600 });
    try {
      chmodSync(this.filePath, 0o600);
    } catch {
      // Windows/受限环境 chmod 可能失败：尽力而为（文件已在本机用户目录内）
    }
  }

  private encrypt(keyRef: string, secret: string): StoreFile["entries"][string] {
    const iv = randomBytes(12);
    const cipher = createCipheriv("aes-256-gcm", this.masterKeyBuf, iv);
    cipher.setAAD(Buffer.from(keyRef, "utf8"));
    const data = Buffer.concat([cipher.update(secret, "utf8"), cipher.final()]);
    return { iv: iv.toString("base64"), tag: cipher.getAuthTag().toString("base64"), data: data.toString("base64") };
  }

  private decrypt(keyRef: string, entry: StoreFile["entries"][string]): string {
    const decipher = createDecipheriv("aes-256-gcm", this.masterKeyBuf, Buffer.from(entry.iv, "base64"));
    decipher.setAAD(Buffer.from(keyRef, "utf8"));
    decipher.setAuthTag(Buffer.from(entry.tag, "base64"));
    try {
      return Buffer.concat([decipher.update(Buffer.from(entry.data, "base64")), decipher.final()]).toString("utf8");
    } catch {
      throw new KeyStoreError(
        `密钥条目解密失败（篡改或口令错误）：${keyRef}（fail-closed，不返回猜测明文）`,
      );
    }
  }

  async read(keyRef: string): Promise<string | null> {
    const entry = this.entries[keyRef];
    if (!entry) return null;
    return this.decrypt(keyRef, entry);
  }

  async has(keyRef: string): Promise<boolean> {
    return this.entries[keyRef] !== undefined;
  }

  async write(keyRef: string, secret: string): Promise<void> {
    this.entries[keyRef] = this.encrypt(keyRef, secret);
    this.flush();
  }

  /** 条目数（诊断；不暴露任何密钥内容）。 */
  get size(): number {
    return Object.keys(this.entries).length;
  }

  /** 口令校验探针：候选口令按同参数派生后与主密钥恒定时间比对——首启口令确认 UI 用。 */
  verifyPassphrase(candidate: string): boolean {
    const derived = scryptSync(candidate, this.storeSalt, this.kdf.keyLen, {
      N: this.kdf.N,
      r: this.kdf.r,
      p: this.kdf.p,
    });
    return derived.length === this.masterKeyBuf.length && timingSafeEqual(derived, this.masterKeyBuf);
  }
}
