/**
 * 越权自测（P015）——在目标运行环境内探测实际能力边界并**如实报告**。
 *
 * 降级边界（P002-SP 结论，README 登记）：本轮无 OS 级阻断（AppContainer/低完整性不可用），
 * 自测验证的是**可执行部分**：环境裁剪面（无凭据泄漏）、策略路径判定、loopback 语义；
 * 「读用户目录仍可能 ALLOWED」是已登记的已知边界，不是可修缺陷。
 */

import { appendFileSync, mkdtempSync, readFileSync, rmSync, writeFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { isPathAllowed, type SandboxPolicy } from "./policy.js";

export interface SelfTestReport {
  /** 环境面：当前进程环境中是否存在凭据类变量（应 false）。 */
  credentialEnvLeaked: boolean;
  /** 环境面：NODE_OPTIONS 等注入面是否残留（应 false）。 */
  nodeEnvLeaked: boolean;
  /** 策略面：项目内路径判定放行（应 true）。 */
  projectPathAllowed: boolean;
  /** 策略面：项目外路径判定拒绝（应 true = 拒绝生效）。 */
  outsidePathDenied: boolean;
  /** 策略面：穿越变体拒绝（应 true）。 */
  traversalDenied: boolean;
  /** 真实越权探测（已登记边界）：写用户配置目录是否成功（降级下可能 true——非缺陷，见 README）。 */
  writeUserProfileObserved: boolean;
  /** 临时目录读写（策略允许面，应成功）。 */
  tempReadWriteOk: boolean;
  /** 全部「可执行断言」是否通过（不含已登记边界项）。 */
  passed: boolean;
}

/** 凭据类变量探测模式（与 launcher.scrubEnv 同源）。 */
const CREDENTIAL_ENV_RE = /(KEY|TOKEN|SECRET|PASSPHRASE|PASSWORD|CREDENTIAL)/i;

/** NODE_ 注入面探测（NODE_OPTIONS/NODE_PATH/NODE_PRELOAD 等真实注入向量；NODE_ENV 良性不计）。 */
const NODE_INJECTION_ENV_RE = /^NODE_(OPTIONS|PATH|PRELOAD|REQUIRE|TLS|V8_COVERAGE)/i;

/** 运行越权自测（在子进程入口内调用；返回报告而非抛错，由调用方决定处置）。 */
export function runSelfTest(policy: SandboxPolicy, projectDir: string): SelfTestReport {
  // 1) 环境面：凭据/NODE_ 注入面泄漏
  const envKeys = Object.keys(process.env);
  const credentialEnvLeaked = envKeys.some((k) => CREDENTIAL_ENV_RE.test(k) && process.env[k] !== undefined);
  const nodeEnvLeaked = envKeys.some((k) => NODE_INJECTION_ENV_RE.test(k) && process.env[k] !== undefined);

  // 2) 策略面：路径判定（纯函数，可执行断言）
  const roots = [...policy.fsReadRoots, ...policy.fsWriteRoots];
  const projectPathAllowed = isPathAllowed(join(projectDir, "some", "file.txt"), roots);
  const outsidePathDenied = !isPathAllowed(join(projectDir, "..", "..", "outside-secret.txt"), roots) &&
    !isPathAllowed("C:\\Windows\\System32\\config.sys", roots);
  const traversalDenied = !isPathAllowed(`${projectDir}\\..\\..\\secrets`, roots);

  // 3) 真实越权观察（登记边界：降级下 OS 不阻断，记录事实）
  let writeUserProfileObserved = false;
  const probe = join(process.env.APPDATA ?? tmpdir(), "aich-selftest-probe.txt");
  try {
    writeFileSync(probe, "probe");
    writeUserProfileObserved = true;
    rmSync(probe, { force: true });
  } catch {
    writeUserProfileObserved = false;
  }

  // 4) 允许面：临时目录读写（策略声明 fsWriteRoots 含临时目录）
  let tempReadWriteOk = false;
  try {
    const dir = mkdtempSync(join(tmpdir(), "aich-selftest-"));
    const file = join(dir, "w.txt");
    writeFileSync(file, "x");
    appendFileSync(file, "y");
    tempReadWriteOk = readFileSync(file, "utf8") === "xy" && existsSync(file);
    rmSync(dir, { recursive: true, force: true });
  } catch {
    tempReadWriteOk = false;
  }

  const passed =
    !credentialEnvLeaked && !nodeEnvLeaked && projectPathAllowed && outsidePathDenied && traversalDenied && tempReadWriteOk;

  return {
    credentialEnvLeaked,
    nodeEnvLeaked,
    projectPathAllowed,
    outsidePathDenied,
    traversalDenied,
    writeUserProfileObserved,
    tempReadWriteOk,
    passed,
  };
}
