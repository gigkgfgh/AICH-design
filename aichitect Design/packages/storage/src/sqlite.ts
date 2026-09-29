/**
 * node:sqlite 运行时加载器。
 *
 * 绕过 vite 5（vitest 2.x）的模块归一化：vite 会剥掉 `node:` 前缀后调
 * isBuiltin('sqlite')，而 Node 24 上该形式返回 false（仅 'node:sqlite' 算内置），
 * 导致测试环境解析失败。createRequire 的字符串参数不经过 vite 变换，
 * 生产构建路径不受影响。
 */

import { createRequire } from "node:module";

const require_ = createRequire(import.meta.url);

export const nodeSqlite: typeof import("node:sqlite") = require_("node:sqlite");
