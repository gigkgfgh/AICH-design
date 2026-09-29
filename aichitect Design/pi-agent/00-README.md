# pi-agent 上游源码/包获取记录（task P001）

本目录存放 pi 项目上游源码与 npm 发布包，供 AICH Design 二次开发使用（设计文档 §3.1 内核基座）。
许可证：MIT（Copyright 2025 Mario Zechner），二次开发须保留版权声明。

## 目录布局

```
pi-agent/
├─ pi-main/                  # GitHub pi monorepo 全量源码（TS 源码 + 测试 + skills + docs），1366 文件
│  ├─ packages/agent         # → @earendil-works/pi-agent-core 源码
│  ├─ packages/ai            # → @earendil-works/pi-ai 源码
│  ├─ packages/{client,server,protocol,telemetry,tui,coding-agent,evals,session-backends}
│  └─ package.json           # pi-monorepo (private, npm workspaces)
├─ npm-packages/             # npm 发布包（可直接集成用）
│  ├─ pi-agent-core-0.84.1-src/   # 发布包解压（dist JS + .d.ts 声明）
│  ├─ pi-ai-0.84.1-src/           # 发布包解压（dist JS + .d.ts 声明）
│  ├─ pi-agent-core-0.84.1.tgz    # 原始 tarball
│  ├─ pi-ai-0.84.1.tgz            # 原始 tarball
│  ├─ pi-ai-latest.json           # registry /latest 元数据（version=0.84.1）
│  └─ pi-main-codeload.tar.gz     # GitHub 源码 tarball（codeload 通道）
└─ 00-README.md              # 本文件
```

## 获取记录（2026-08-12）

| 项 | 状态 | 通道 |
|---|---|---|
| GitHub 源码 main 分支 | ✅ 成功（5.87MB） | codeload.github.com（github.com 直连被网络阻断；npm registry 可达） |
| @earendil-works/pi-agent-core 0.84.1 | ✅ 成功（HEAD 200） | registry.npmjs.org（curl） |
| @earendil-works/pi-ai 0.84.1 | ✅ 成功（HEAD 200） | registry.npmjs.org（curl） |
| SHA1 本地校验 | 未执行 | registry shasum：core `a611675f…b9625c7`，ai `e3e63183…b779f4`（实机 Get-FileHash 可核对） |

## 二次开发入口建议

- 内核适配（AgentRuntimePort / PiAgentCoreAdapter）：`pi-main/packages/agent/src/`（Agent、agentLoop、subscribe、streamProxy）
- Provider/模型配置：`pi-main/packages/ai/src/`（Model.cost 可供成本埋点）
- 会话/存储参考：`pi-main/packages/agent/src/session/`、`packages/session-backends/`
- 直接集成 npm 包：以 `npm-packages/*-src/package/` 目录为本地依赖即可

## 详见交接文档

- `HANDOFF-20260812-0632-planner-backend-P001.md`（原始任务）
- `HANDOFF-20260812-0638-backend-planner-P001.md`（backend 回执）