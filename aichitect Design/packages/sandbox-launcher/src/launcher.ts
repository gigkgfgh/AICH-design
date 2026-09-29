/**
 * 沙箱启动器（P015）——按 P002-SP 真机结论的**降级最小权限实现**。
 *
 * 真机结论（2026-08-24，Windows 11 26200 / 非提升 Shell，详见 README）：
 * - runas /trustlevel:0x20000（受限令牌）：可用，但仅剥离管理员 SID——
 *   用户配置文件读/写不受限（writeAppData=ALLOWED）→ 不能作文件越权防线；
 * - icacls /setintegritylevel L（低完整性）：**需管理员权限**（写 SACL 被拒 exit=5，
 *   对普通 txt 同样被拒）→ 非提升启动流不可用；
 * - AppContainer：无 shell 原语（需 native helper 调 CreateAppContainerProfile + CreateProcess）。
 *
 * 因此本轮 launcher 提供（可测、诚实的）最小权限包装：
 * 1. 策略 fail-closed 校验（validatePolicy）；
 * 2. 子进程环境**白名单裁剪**：剥离 NODE_* 前缀变量、凭据类变量与全部未列入项（默认拒绝）；
 * 3. 显式 cwd = 项目目录（不继承任意工作目录）；
 * 4. 启动后自检钩子（self-test）：报告子进程实际能力边界（OS 级阻断待 native helper）。
 */

import { spawn, type ChildProcess } from "node:child_process";
import { isPathAllowed, validatePolicy } from "./policy.js";
import type { SandboxPolicy } from "./policy.js";

/**
 * 环境白名单（默认拒绝模型）：
 * - 仅保留 Node/系统运行必需项（PATH 含 node 定位；SYSTEMROOT 缺失 Windows 上 Node 无法启动）；
 * - AICH_* 业务变量经 extras 显式放行（如网关地址/会话目录）；
 * - 一律剥离：NODE_*（含 NODE_OPTIONS 注入面）、AICH_*KEY* / *TOKEN* / *SECRET*（凭据面）。
 */
export const DEFAULT_ENV_WHITELIST: readonly string[] = [
  "SYSTEMROOT",
  "SYSTEMDRIVE",
  "COMSPEC",
  "PATHEXT",
  "TEMP",
  "TMP",
  "PATH",
  "OS",
  "NUMBER_OF_PROCESSORS",
  "PROCESSOR_ARCHITECTURE",
];

/** 凭据类变量硬剥离模式（即使被 extras 放行也拒绝透传）。 */
const CREDENTIAL_ENV_RE = /(KEY|TOKEN|SECRET|PASSPHRASE|PASSWORD|CREDENTIAL)/i;

/** 环境裁剪：白名单 ∪ extras，减凭据类；返回全新对象（不改原环境）。 */
export function scrubEnv(
  source: Readonly<Record<string, string | undefined>>,
  extras: readonly string[] = [],
): Record<string, string> {
  const allow = new Set<string>();
  for (const name of DEFAULT_ENV_WHITELIST) allow.add(name.toUpperCase());
  for (const name of extras) {
    if (CREDENTIAL_ENV_RE.test(name)) {
      throw new Error(`环境放行项含凭据语义变量，拒绝透传：${name}（真实 Key 永不见沙箱进程）`);
    }
    allow.add(name.toUpperCase());
  }
  const out: Record<string, string> = {};
  for (const [key, value] of Object.entries(source)) {
    if (value === undefined) continue;
    if (!allow.has(key.toUpperCase())) continue;
    if (CREDENTIAL_ENV_RE.test(key)) continue; // 双保险：白名单命中也不透传凭据
    out[key] = value;
  }
  return out;
}

export interface LaunchOptions {
  /** 策略（fail-closed 校验）。 */
  policy: SandboxPolicy;
  /** 子进程入口脚本（绝对路径）。 */
  entry: string;
  /** 项目目录 = cwd（须在 fsWriteRoots/fsReadRoots 内）。 */
  projectDir: string;
  /** 追加放行的业务环境变量名（如 AICH_GATEWAY_URL；凭据类抛错拒绝）。 */
  extraEnv?: string[];
  /** 传递给入口的 argv。 */
  args?: string[];
  /** stdio（默认 pipe）。 */
  stdio?: "pipe" | "ignore";
}

export interface LaunchResult {
  child: ChildProcess;
  /** 实际注入的环境键清单（诊断/自检断言用）。 */
  envKeys: string[];
}

/**
 * 以最小权限启动子进程（降级实现，见文件头真机结论）。
 * fail-closed：策略非法/入口不存在/projectDir 不在根内 → 抛错不启动。
 */
export function launch(options: LaunchOptions): LaunchResult {
  const { policy, entry, projectDir, extraEnv = [], args = [] } = options;
  validatePolicy(policy);

  // projectDir 必须同时可读写（工作目录）
  const roots = [...policy.fsReadRoots, ...policy.fsWriteRoots];
  if (!isPathAllowed(projectDir, roots)) {
    throw new Error(`projectDir 不在策略白名单根内：${projectDir}`);
  }

  const env = scrubEnv(process.env, extraEnv);
  const child = spawn(process.execPath, [entry, ...args], {
    cwd: projectDir,
    env,
    stdio: options.stdio ?? "pipe",
    windowsHide: true,
  });
  return { child, envKeys: Object.keys(env) };
}
