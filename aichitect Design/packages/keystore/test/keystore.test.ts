/**
 * P016 KeyStore 测试：加解密往返 / 篡改检测（GCM tag）/ 错口令拒读 /
 * 口令缺失构造失败 / has 与覆盖写 / 重开实例往返（持久化）。
 */

import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, rmSync, writeFileSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { AesGcmFileKeyStore, KeyStoreError, KEYSTORE_PASSPHRASE_ENV } from "../src/index.js";

let dir: string;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "aich-keystore-"));
});

afterEach(() => {
  delete process.env[KEYSTORE_PASSPHRASE_ENV];
  rmSync(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
});

const fastKdf = { N: 1024, r: 8, p: 1 }; // 测试加速（生产用默认 N=16384）
const storePath = () => join(dir, "keys.bin");

function makeStore(passphrase = "correct-horse-battery"):
  AesGcmFileKeyStore {
  return new AesGcmFileKeyStore({ filePath: storePath(), passphrase, kdf: fastKdf });
}

describe("AesGcmFileKeyStore", () => {
  it("write/read 往返；has；read 不存在返回 null", async () => {
    const store = makeStore();
    await store.write("openai.image", "sk-secret-123");
    expect(await store.read("openai.image")).toBe("sk-secret-123");
    expect(await store.has("openai.image")).toBe(true);
    expect(await store.has("other")).toBe(false);
    expect(await store.read("other")).toBeNull();
  });

  it("密文落盘：文件中不含明文", async () => {
    const store = makeStore();
    await store.write("openai.image", "sk-plaintext-marker");
    const raw = readFileSync(storePath(), "utf8");
    expect(raw.includes("sk-plaintext-marker")).toBe(false);
    expect(raw.includes("\"version\":1")).toBe(true);
  });

  it("重开实例（同口令）可读", async () => {
    const store = makeStore();
    await store.write("llm.key", "sk-abc");
    const reopened = makeStore();
    expect(await reopened.read("llm.key")).toBe("sk-abc");
  });

  it("错口令：重开可构造但 read 抛错（fail-closed，不返回猜测明文）", async () => {
    const store = makeStore();
    await store.write("llm.key", "sk-abc");
    const wrong = new AesGcmFileKeyStore({ filePath: storePath(), passphrase: "wrong-pass", kdf: fastKdf });
    await expect(wrong.read("llm.key")).rejects.toThrow(KeyStoreError);
  });

  it("篡改检测：密文字节翻转 → read 抛错", async () => {
    const store = makeStore();
    await store.write("llm.key", "sk-abc");
    const raw = JSON.parse(readFileSync(storePath(), "utf8")) as { entries: Record<string, { data: string }> };
    const entry = raw.entries["llm.key"]!;
    // 翻转密文首字符（base64 内一位 → 字节级扰动）
    entry.data = (entry.data[0] === "A" ? "B" : "A") + entry.data.slice(1);
    writeFileSync(storePath(), JSON.stringify(raw), "utf8");
    const tampered = makeStore();
    await expect(tampered.read("llm.key")).rejects.toThrow(/篡改或口令错误/);
  });

  it("条目互换攻击防护：AAD=keyRef——把条目 A 复制到 keyRef B 下解密失败", async () => {
    const store = makeStore();
    await store.write("ref.a", "secret-a");
    await store.write("ref.b", "secret-b");
    const raw = JSON.parse(readFileSync(storePath(), "utf8")) as { entries: Record<string, { iv: string; tag: string; data: string }> };
    raw.entries["ref.b"] = { ...raw.entries["ref.a"]! };
    writeFileSync(storePath(), JSON.stringify(raw), "utf8");
    const attacked = makeStore();
    await expect(attacked.read("ref.b")).rejects.toThrow(KeyStoreError);
  });

  it("口令缺失（无环境变量无参数）→ 构造抛错", () => {
    delete process.env[KEYSTORE_PASSPHRASE_ENV];
    expect(() => new AesGcmFileKeyStore({ filePath: storePath() })).toThrow(/AICH_KEYSTORE_PASSPHRASE/);
  });

  it("环境变量口令可用；verifyPassphrase 验证", async () => {
    process.env[KEYSTORE_PASSPHRASE_ENV] = "env-pass";
    const store = new AesGcmFileKeyStore({ filePath: storePath(), kdf: fastKdf });
    await store.write("k", "v");
    expect(store.verifyPassphrase("env-pass")).toBe(true);
    expect(store.verifyPassphrase("nope")).toBe(false);
  });

  it("非 JSON 损坏文件 → 构造抛错（fail-closed）", () => {
    writeFileSync(storePath(), "not-json", "utf8");
    expect(() => makeStore()).toThrow(/损坏/);
  });
});
