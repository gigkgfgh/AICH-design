/**
 * P015 sandbox-launcher 测试：策略 fail-closed 校验 / 路径白名单穿越防护 /
 * 环境裁剪（白名单 + 凭据硬剥离 + extras 拒绝凭据）/ launch 真实 spawn（环境已裁剪、cwd 正确）/
 * self-test 语义（可执行断言 + 已登记边界观察项）。
 */

import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, rmSync, writeFileSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { validatePolicy, isPathAllowed, SandboxPolicyError } from "../src/policy.js";
import type { SandboxPolicy } from "../src/policy.js";
import { scrubEnv, launch, DEFAULT_ENV_WHITELIST } from "../src/launcher.js";
import { runSelfTest } from "../src/self-test.js";

let dir: string;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "aich-sbx-"));
});

afterEach(() => {
  rmSync(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
});

function validPolicy(): SandboxPolicy {
  return {
    fsReadRoots: [dir],
    fsWriteRoots: [dir, tmpdir()],
    netLoopbackOnly: true,
    noNetRaw: true,
    noProcessInjection: true,
  };
}

describe("validatePolicy（fail-closed）", () => {
  it("合法策略通过", () => {
    expect(() => validatePolicy(validPolicy())).not.toThrow();
  });

  it("空根 / 相对路径 / 放开网络与能力 → 拒绝", () => {
    expect(() => validatePolicy({ ...validPolicy(), fsReadRoots: [] })).toThrow(SandboxPolicyError);
    expect(() => validatePolicy({ ...validPolicy(), fsReadRoots: ["relative/path"] })).toThrow(SandboxPolicyError);
    expect(() => validatePolicy({ ...validPolicy(), netLoopbackOnly: false })).toThrow(/netLoopbackOnly/);
    expect(() => validatePolicy({ ...validPolicy(), noNetRaw: false })).toThrow(/noNetRaw/);
    expect(() => validatePolicy({ ...validPolicy(), noProcessInjection: false })).toThrow(/noProcessInjection/);
    expect(() => validatePolicy({ ...validPolicy(), envWhitelist: ["1BAD"] })).toThrow(SandboxPolicyError);
  });
});

describe("isPathAllowed（穿越防护）", () => {
  it("根内放行；根外/穿越/相似前缀拒绝", () => {
    const roots = [dir];
    expect(isPathAllowed(join(dir, "a.txt"), roots)).toBe(true);
    expect(isPathAllowed(join(dir, "sub", "a.txt"), roots)).toBe(true);
    expect(isPathAllowed(resolve(dir, "..", "outside.txt"), roots)).toBe(false);
    expect(isPathAllowed(`${dir}-evil/a.txt`, roots)).toBe(false);
    expect(isPathAllowed("C:\\Windows\\System32\\x.txt", roots)).toBe(false);
  });
});

describe("scrubEnv（环境白名单裁剪）", () => {
  it("默认白名单保留、其余剥离、凭据硬剥离", () => {
    const scrubbed = scrubEnv({
      PATH: "C:\\bin",
      SYSTEMROOT: "C:\\Windows",
      NODE_OPTIONS: "--require=evil.js",
      AICH_IMAGE_API_KEY: "sk-secret",
      OPENAI_TOKEN: "t",
      MY_CUSTOM_VAR: "x",
    });
    expect(scrubbed["PATH"]).toBe("C:\\bin");
    expect(scrubbed["SYSTEMROOT"]).toBe("C:\\Windows");
    expect(scrubbed["NODE_OPTIONS"]).toBeUndefined();
    expect(scrubbed["AICH_IMAGE_API_KEY"]).toBeUndefined();
    expect(scrubbed["OPENAI_TOKEN"]).toBeUndefined();
    expect(scrubbed["MY_CUSTOM_VAR"]).toBeUndefined();
    expect(DEFAULT_ENV_WHITELIST).toContain("PATH");
  });

  it("extras 放行业务变量；凭据语义 extras 抛错拒绝", () => {
    const scrubbed = scrubEnv({ AICH_GATEWAY_URL: "http://127.0.0.1:1", SECRET_TOKEN: "x" }, ["AICH_GATEWAY_URL"]);
    expect(scrubbed["AICH_GATEWAY_URL"]).toBe("http://127.0.0.1:1");
    expect(scrubbed["SECRET_TOKEN"]).toBeUndefined();
    expect(() => scrubEnv({}, ["AICH_LLM_API_KEY"])).toThrow(/拒绝透传/);
  });
});

describe("launch（降级最小权限启动）", () => {
  it("spawn 子进程：cwd 正确、环境已裁剪（子进程内自证）", async () => {
    // 子进程入口：写 marker（证明 cwd 可写）+ 打印环境键（证明裁剪）
    const entry = join(dir, "child-entry.cjs");
    writeFileSync(
      entry,
      [
        "const fs = require('node:fs');",
        "fs.writeFileSync('marker.txt', 'ok');",
        "const cred = Object.keys(process.env).filter(k => /(KEY|TOKEN|SECRET|PASSPHRASE|PASSWORD)/i.test(k));",
        "const nodeEnv = Object.keys(process.env).filter(k => /^NODE_/i.test(k));",
        "console.log(JSON.stringify({ cwd: process.cwd(), cred, nodeEnv }));",
      ].join("\n"),
      "utf8",
    );
    const { child } = launch({
      policy: validPolicy(),
      entry,
      projectDir: dir,
      extraEnv: ["AICH_GATEWAY_URL"],
    });
    expect(child.pid).toBeTruthy();

    const stdout = await new Promise<string>((resolvePromise, reject) => {
      let out = "";
      child.stdout!.on("data", (c: Buffer) => (out += c.toString()));
      child.on("close", (code) => (code === 0 ? resolvePromise(out) : reject(new Error(`exit=${code}`))));
      child.on("error", reject);
    });
    const report = JSON.parse(stdout.trim().split("\n").at(-1)!) as {
      cwd: string;
      cred: string[];
      nodeEnv: string[];
    };
    expect(report.cwd).toBe(resolve(dir));
    expect(report.cred).toEqual([]);
    expect(report.nodeEnv).toEqual([]);
    expect(readFileSync(join(dir, "marker.txt"), "utf8")).toBe("ok");
  });

  it("projectDir 不在策略根内 → 抛错不启动（fail-closed）", () => {
    const entry = join(dir, "noop.cjs");
    writeFileSync(entry, "", "utf8");
    expect(() =>
      launch({ policy: validPolicy(), entry, projectDir: join(dir, "..", "..", "elsewhere") }),
    ).toThrow(/不在策略白名单根内/);
  });
});

describe("runSelfTest（能力边界报告）", () => {
  it("可执行断言全过；越权观察项如实记录（降级边界，非缺陷）", () => {
    const report = runSelfTest(validPolicy(), dir);
    expect(report.credentialEnvLeaked).toBe(false);
    expect(report.nodeEnvLeaked).toBe(false);
    expect(report.projectPathAllowed).toBe(true);
    expect(report.outsidePathDenied).toBe(true);
    expect(report.traversalDenied).toBe(true);
    expect(report.tempReadWriteOk).toBe(true);
    expect(report.passed).toBe(true);
    // writeUserProfileObserved 在降级模式下可能为 true（P002-SP 已登记边界；P020 评审项）
  });
});
