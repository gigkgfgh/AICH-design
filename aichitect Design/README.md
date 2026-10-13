# AICH Design

桌面端 AI 建筑设计辅助工具。Electron 壳 + 独立 Node 服务进程：对话、图像表现图生成/编辑、案例调研，全部走本地回环网关，密钥经系统级加密保存。

**无离线兜底**：LLM/图像端点未配置或本地服务未就绪时，对应功能显式报错并给出配置引导，不产生任何模拟数据。

## 技术栈

| 层 | 选型 |
|---|---|
| 桌面壳 | Electron 35（`contextIsolation` + `nodeIntegration:false` + 渲染进程沙箱） |
| 渲染层 | React 18.3 + Vite 5 + TypeScript 5.6（无路由、无状态库，仅 hooks） |
| 服务进程 | Node ≥22.19 独立进程，HTTP/SSE 网关（`127.0.0.1` 随机端口 + Bearer token） |
| Agent 内核 | `@earendil-works/pi-agent-core@0.84.1` / `pi-ai@0.84.1`（npm registry，版本锁定） |
| 存储 | `node:sqlite`（`DatabaseSync`）meta.db + 会话 jsonl |
| 测试 | Vitest 2 |

## 目录结构

```
aichitect Design/
├── packages/
│   ├── app/              Electron 壳：主进程 / preload / React 渲染层
│   │   ├── electron/     主进程（spawn 服务、IPC 桥、密钥服务、会话读写）
│   │   └── src/         渲染层（hooks / components / gateway 客户端）
│   ├── agent-service/    独立 Node 服务进程（Agent 内核适配 + HTTP/SSE 网关）
│   ├── shared/           跨包契约（消息契约 / SSE 信封 / 错误码 / 端口接口）
│   ├── extensions/       产品工具扩展（image-tools：参数契约 + 约束校验）
│   ├── skills/           产品技能包（SKILL.md：image-gen / research）
│   └── storage/          meta.db 访问层（迁移体系 + Repository）
├── package.json          workspaces + postinstall 构建钩子
└── tsconfig.base.json    共享 TS 配置
```

## 快速开始

```bash
npm install        # 装依赖；postinstall 按拓扑构建各包 dist
npm run dev        # 渲染层 vite(5173) + electron 壳，热更新
```

> `npm install --ignore-scripts` 会跳过 postinstall，各包 `dist/` 不会生成，
> 届时 typecheck/test 会报 `Cannot find module '@aichdesign/shared'`，需手动 `npm run build`。

端点配置：启动后在「设置 → LLM 端点 / 图像端点」填写并保存，**保存即生效**（服务进程内热重载配置，不重启本地服务、不打断在途对话）。删除全部条目同样可保存，用于清除已存配置。
密钥经 Electron `safeStorage`（Windows DPAPI / macOS Keychain / Linux libsecret）加密存放，不落明文。

## 常用命令

| 命令 | 作用 |
|---|---|
| `npm run dev -w @aichdesign/app` | 开发模式（vite + electron） |
| `npm run build` | 全仓库构建（含渲染层产物） |
| `npm run typecheck` | 全仓库类型检查（含各包 test/） |
| `npm test` | 全仓库单元测试 |
| `npm run start:agent-service` | 单独跑服务进程（调试用） |

## 架构要点

- **端口与适配器**：`shared` 定义 `AgentRuntimePort`，`agent-service` 提供 `PiAgentCoreAdapter`；业务代码不依赖具体内核，换内核只改 adapter。
- **进程边界**：渲染层 → `contextBridge` → 主进程 IPC → `GatewayHttpClient` → 服务进程 HTTP/SSE。所有 IPC 通道校验调用方必须是本进程主窗口的主 frame（`AICH_IPC_STRICT=1` 时改为拒绝，默认仅记录）。
- **fail-closed**：端点未配置、依赖不可装、本地文件不在白名单，一律显式报错；不静默降级、不产出模拟数据。
- **SSRF 防护**：`fetch_page` 与 `http(s)` 参考图下载共用 `assertPublicHttpUrl`（协议白名单 + DNS 解析结果私网拒绝）。

## 测试

```bash
npm test                    # 全仓库
npm test -w @aichdesign/app # 单包
```

各包用例数：agent-service 8 文件 / app 8 文件 / extensions 1 文件 / storage 1 文件。
shared 与 skills 无运行时测试（契约与 SKILL.md 合规由 review 保证）。

## 相关文档

- [`packages/agent-service/README.md`](packages/agent-service/README.md) — 服务进程环境变量、网关端点、联调参数
- [`packages/extensions/README.md`](packages/extensions/README.md) — 图像工具契约与约束校验
- [`packages/storage/README.md`](packages/storage/README.md) — 迁移体系与 Repository
