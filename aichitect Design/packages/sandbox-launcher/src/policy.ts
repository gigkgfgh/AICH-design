/**
 * 声明式沙箱策略（P015，设计文档 §7）。
 *
 * 语义（fail-closed）：
 * - fsReadRoots / fsWriteRoots：绝对路径白名单（项目目录 + 临时目录）；**其余默认拒绝**；
 * - netLoopbackOnly：本轮必须为 true（仅豁免 loopback 网关；真实 AppContainer 落地前
 *   网络隔离是「语义声明 + 自检观察」，OS 级阻断不可用——见 README 降级登记）；
 * - capabilities：noNetRaw / noProcessInjection 能力语义占位（native helper 落地后生效）；
 * - validate()：任何非法值（相对路径/空根/非法 capability）抛错拒绝启动——fail-closed。
 */

import { isAbsolute, resolve, sep } from "node:path";

export interface SandboxPolicy {
  /** 只读根目录（绝对路径；如项目目录）。 */
  fsReadRoots: string[];
  /** 可写根目录（绝对路径；项目数据目录 + 临时目录）。 */
  fsWriteRoots: string[];
  /** 仅允许 loopback 网络（本轮必须 true）。 */
  netLoopbackOnly: boolean;
  /** 能力语义占位：禁止原始套接字（native helper 落地后生效）。 */
  noNetRaw: boolean;
  /** 能力语义占位：禁止进程注入/调试其它进程。 */
  noProcessInjection: boolean;
  /** 子进程环境变量白名单（大小写不敏感；见 launcher.DEFAULT_ENV_WHITELIST）。 */
  envWhitelist?: string[];
}

export class SandboxPolicyError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "SandboxPolicyError";
  }
}

/** 校验策略（fail-closed：非法即抛错，绝不静默放宽）。 */
export function validatePolicy(policy: SandboxPolicy): void {
  if (!Array.isArray(policy.fsReadRoots) || policy.fsReadRoots.length === 0) {
    throw new SandboxPolicyError("fsReadRoots 不能为空（默认拒绝模型下至少须声明项目目录）");
  }
  if (!Array.isArray(policy.fsWriteRoots) || policy.fsWriteRoots.length === 0) {
    throw new SandboxPolicyError("fsWriteRoots 不能为空（至少须声明临时目录）");
  }
  for (const root of [...policy.fsReadRoots, ...policy.fsWriteRoots]) {
    // 校验原始值（resolve 会把相对路径补成绝对——必须查写法本身，fail-closed）
    if (typeof root !== "string" || root.length === 0 || !isAbsolute(root)) {
      throw new SandboxPolicyError(`路径必须为绝对路径：${JSON.stringify(root)}`);
    }
  }
  if (policy.netLoopbackOnly !== true) {
    throw new SandboxPolicyError("netLoopbackOnly 必须为 true（本轮网络模型仅 loopback 豁免，fail-closed）");
  }
  if (policy.noNetRaw !== true || policy.noProcessInjection !== true) {
    throw new SandboxPolicyError("noNetRaw / noProcessInjection 必须为 true（能力语义占位，禁止声明放开）");
  }
  if (policy.envWhitelist !== undefined) {
    for (const name of policy.envWhitelist) {
      if (typeof name !== "string" || name.length === 0 || !/^[A-Za-z_][A-Za-z0-9_]*$/.test(name)) {
        throw new SandboxPolicyError(`环境变量白名单项非法：${JSON.stringify(name)}`);
      }
    }
  }
}

/** 路径是否在白名单根内（穿越后判定；供 launcher/self-test 判定文件访问）。 */
export function isPathAllowed(path: string, roots: readonly string[]): boolean {
  const resolved = resolve(path);
  return roots.some((root) => {
    const base = resolve(root);
    return resolved === base || resolved.startsWith(base + sep);
  });
}
