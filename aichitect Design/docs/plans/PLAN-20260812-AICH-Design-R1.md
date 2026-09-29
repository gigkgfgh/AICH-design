# 开发计划 PLAN-20260812-AICH-Design-R1

> 版本：v0.2（执行轮 R1）　|　创建：2026-08-12 06:20　|　作者：planner（指挥模式 auto）　|　修订：2026-08-12 迁移至项目目录
> 关联总计划：`docs/plans/PLAN-20260812-AICH-Design开发计划.md`（v0.1，P001-P024 全周期）
> 来源：AICH Design 详细设计文档 v0.2 + 总计划 v0.1；本计划为**本轮 auto 可执行范围**的细化与契约冻结，是 reviewer 核对「实现是否符合计划」的依据。
> 代码落点：`aichitect Design/`（本项目根）；计划 `docs/plans/`、交接 `.handoffs/` 均位于本目录下（2026-08-12 由工作区根迁移归位，主 Agent 执行）

## 1. 背景与目标

- 需求来源：`aichitect Design/docs/AICH-Design-Detailed-Design-精简版.md`（v0.2），上游 PRD v1.3；总计划 v0.1
- 业务目标：桌面端 AI 建筑平面方案设计工具——自然语言起草/迭代平面方案（SVG）、一键表现图、版本管理与回退、本地优先与密钥保护
- **本轮（R1）目标**：跑通 **M1 内核最小闭环 + M3 方案起草能力前半**（总计划 P004-P010），含：monorepo 骨架、shared 契约冻结与 mock-provider、agent-service 最小闭环（本地网关 HTTP/SSE + mock 全链路）、Electron 壳 + React UI（ChatPanel / PlanCanvas / VersionTree + 对话修改流）、plan-tools extension（validate_plan / render_plan_svg / plan_patch）、plan-draft SKILL.md
- **验收口径（可量化）**：
  - 契约层：AgentRequest/AgentResponse、SSE 信封、PlanStructure（含顶层 `schemaVersion`）与设计文档 §5.2 / §8.3 / ADR-004 一致，错误码表唯一语义（HANDOFF-SPEC §6 红线）
  - backend：mock 全链路「输入一句话 → 本地网关 SSE 流式返回 → 会话 jsonl 落盘 → usage/cost 埋点」代码路径完整；plan-tools 三工具按 §5.3 渲染规范实现，vitest 用例存在（能跑则跑，不能跑降级记录）
  - frontend：mock 直连下「一句话 → 方案 SVG → 改一句 → 新版本 → 回退」交互闭环；加载/空/错误态齐备
  - 语法自测：`node --check` 对可检查文件全绿；`npm.cmd` 自测按用户口述修正优先尝试，被权限拒绝或网络失败则记录降级
  - **最终实机验证由主 Agent/用户执行**（ENVIRONMENT.md 验证职责归属）

## 2. 范围界定

- **做（R1）**：
  - P004 monorepo 骨架（npm workspaces 根配置 + 目录与设计 §2.2 一致）
  - P005 shared 契约冻结 + mock-provider 包
  - P006 agent-service：AgentRuntimePort adapter + 本地网关（127.0.0.1 随机端口 + 一次性 bearer token、SSE、cancel）+ 会话 jsonl + 成本埋点 + mock 全链路
  - P007 Electron 壳（main/preload/IPC 桥）+ React+Vite 渲染 + ChatPanel（mock 直连）
  - P008 plan-tools extension：validate_plan / render_plan_svg / plan_patch（§5.3 渲染规范）
  - P009 plan-draft SKILL.md（Anthropic 格式，§4.1 合规）
  - P010 PlanCanvas + VersionTree + 对话修改流 UI（mock 先行，契约对接 P005/P008）
- **不做（R1，留后续轮）**：P001-P003 技术 Spike（需实机/联网）、P011 严格 json_schema 模式、P012/P013 图像 Extension 与图库（依赖图像端口实测）、P014 PNG 栅格化、P015 沙箱落地、P016 KeyStore 注入、P017 SQLite 实装、P018 任务队列、P019 Session/Context Manager、P020-P024 安全审查/E2E/打包/指标/终审——在总计划 v0.1 中已编号，留待 R2+ 或用户实机轮

## 3. 技术选型及理由（沿用总计划 v0.1 §3，本轮执行落定点）

| 决策点 | 选择 | 理由 | 备选 |
|---|---|---|---|
| 内核基座 | pi-agent-core（锁 0.84.x，通过 AgentRuntimePort 抽象） | 工具调用+状态管理+事件流，MIT，可替换（G3） | 自研最小 loop（本轮 mock adapter 即兜底实现） |
| LLM 接入 | pi-ai（统一多 Provider） | Model.cost 供成本埋点 | 直接 OpenAI SDK |
| 桌面框架 | Electron | 主/渲染进程分层符合安全模型 | Tauri（否决） |
| UI | React + TypeScript + Vite（自研） | pi monorepo 无 pi-web-ui | — |
| 平面输出 | SVG（JSON 中间层先行，PlanStructure） | 可编辑/可校验/确定性渲染 | LLM 直出 SVG（否决） |
| 进程通信 | Electron IPC（渲染↔主）+ 本地 HTTP/SSE（主↔agent-service） | 跨边界最自然、可测试（ADR-004） | WebSocket（否决） |
| 本地通信 | 127.0.0.1 随机端口 + 每会话一次性 bearer token | 免 hosts/证书信任链；loopback 天然只连网关 | 域名+证书（否决） |
| 包管理 | npm workspaces（`npm.cmd` 可用） | 环境修正：PowerShell 限制 .ps1 包装，.cmd 直通 | pnpm（未验证） |
| mock | mock-provider 共享包（M1 建立） | frontend/backend 并行 + 离线测试（C-7）依赖 | 各包自写假数据（否决） |

## 4. 任务拆解（R1）

> task-id 沿用总计划编号；R1 执行顺序由本表依赖决定。共享文件（根 package.json、tsconfig.base.json）**归 backend 单写**，frontend 只写 `packages/app/**`（铁律 4：禁止两窗口同时写同一文件）。

| ID | 任务 | 所属角色 | 依赖 | 验收标准 | 评估量 |
|---|---|---|---|---|---|
| P004 | monorepo 骨架：根 package.json（workspaces: packages/*）、tsconfig.base.json、目录 packages/{shared,agent-service,mock-provider,extensions,skills,app}（app 仅目录占位由 frontend 填充）、.gitignore | backend | — | 目录与设计 §2.2 一致；根配置可被 npm.cmd 解析（或降级记录） | 0.5-1d |
| P005 | 契约冻结@shared：contracts.ts（AgentRequest/AgentResponse/SSE 信封/ToolDef/ImageMeta）、PlanStructure TS 类型+JSON Schema（含 schemaVersion）、错误码表（唯一语义）；mock-provider 包（mock 流式文本 + 2~3 个 PlanStructure 样例） | backend | P004 | 与 §5.2/§8.3/ADR-004/ADR-005 一致；错误码无歧义（HANDOFF-SPEC §6） | 1d |
| P006 | agent-service：AgentRuntimePort（run/loadSkill/registerExtension）+ PiAgentCoreAdapter 声明 + MockAdapter；本地网关 HTTP（POST /v1/run、GET SSE /v1/stream/:requestId、POST /v1/cancel，Bearer token）；会话 jsonl 落盘；usage/cost 埋点；mock 全链路 | backend | P005 | mock 全链路流式返回；取消可中止；jsonl/埋点路径完整；node --check 通过 | 3d |
| P007 | Electron 壳（main + preload + IPC 桥、网关客户端封装、spawn agent-service 占位）+ React+Vite 渲染 + ChatPanel（输入/流式展示/加载/空/错误态），mock 直连 | frontend | P005 契约（mock 先行） | 输入→流式展示交互闭环；加载/空/错误态齐备；typecheck/build 尝试或降级记录 | 2-3d |
| P008 | plan-tools extension：validate_plan（JSON Schema + 引用完整性）、render_plan_svg（scale=50px/m、墙体→房间→开口→标注→指北针图层序、fill:#333/#eef）、plan_patch（JSON Patch/覆盖 + 校验回环 ≤2 + 降级输出） | backend | P005 | 三工具与 §5.3 规范可逐条对照；vitest 用例存在（能跑则跑，不能跑降级记录） | 3d |
| P009 | plan-draft SKILL.md：frontmatter（name≤64 小写连字符、description≤1024 第三人称「做什么+何时用」、allowed_tools）+ L2 正文（工作流/约束/示例）+ references（schema+渲染规范） | backend | P008 | 与 §4.1 目录约定与字段约束逐条合规 | 1d |
| P010 | PlanCanvas（SVG 渲染/缩放平移/房间高亮）+ VersionTree + 对话修改流 UI（mock 先行；对接 §5.3 渲染规范与 P008 工具契约） | frontend | P005、P008 契约 | 一句话→方案 SVG→改一句→新版本→回退（mock）；typecheck 尝试或降级记录 | 4d |
| R1-REV | reviewer 审查 P005-P010 → P0/P1 回退修复（≤2 轮）→ 复审通过 | reviewer | 上述全部 | 报告无 P0/P1；验收标准全达成 | 1d |

## 5. 里程碑与顺序建议

- **R1-A（backend 单线）**：P004 → P005 → P006（并行前置）‖ P008（依赖 P005）→ P009（依赖 P008）
- **R1-B（frontend 单线，可并行）**：P007 ‖ P010（均 mock 先行，契约以交接文档「依赖信息」冻结文本为准；shared 未就绪时本地存根并标注 `// TODO-API-STUB`）
- **R1-C（审查闭环）**：R1-REV；P0/P1 按归属回退对应窗口，原 task_id resume 热续修复 ≤2 轮
- 关键路径：P005 → P006 / P008 为纵贯主线；frontend 全程 mock 先行并行缓解

## 6. 风险与假设清单

| 级别 | 风险/假设 | 应对 |
|---|---|---|
| 中 | npm.cmd 网络/源可能仍受限（原快照「网络/源受限」） | 优先尝试 `npm.cmd install`；失败按铁律 8 记录降级，静态交付不阻塞；user 口述修正已记录，ENVIRONMENT.md 改写入权归主 Agent |
| 中 | pi-agent-core/pi-ai 无法安装（网络） | AgentRuntimePort 抽象 + MockAdapter 兜底实现，实机接入后仅改 adapter（G3） |
| 中 | frontend/backend 契约并行不一致 | 契约以交接文档冻结文本+backend 落盘 shared 为准；reviewer 契约核对项（合规核对表） |
| 中 | 共享文件并发写 | 根 package.json/tsconfig.base.json 归 backend 单写；frontend 只写 packages/app/** |
| 低 | reviewer 模型 hy3 未配置（frontmatter 无 model 字段，planner 无 .opencode 编辑权） | 本轮 reviewer 以继承主会话模型执行；收尾汇报给出配置指引（`.opencode/agent/reviewer.md` 加 `model: hy3` 重启生效） |
| 假设 | 项目根 = `aichitect Design/`：代码在 `packages/**`，计划在 `docs/plans/`，交接在 `.handoffs/`（2026-08-12 已统一归位本目录） | reviewer 全部按 `aichitect Design/` 下相对路径核对 |
| 假设 | 本轮交付为静态代码+契约，最终实机验证（Electron 启动、网关联调、SVG 目检）由主 Agent/用户执行 | 交接文档如实标注「未能运行验证」；交付信号 = 实现+自测记录（或降级）+交接更新三要素 |

## 7. R1 契约冻结（写入双方交接文档「依赖信息」）

1. **消息类型**（shared/contracts.ts 落盘）：
   - `AgentRequest = draftPlan | editPlan | genImage | editImage | listVersions`（字段 §8.3）
   - `AgentResponse = plan | image | stream | error`（§8.3）
2. **SSE 信封**（ADR-004）：`{ requestId, sessionId, type: delta|progress|done|error|partial, data }`；requestId 主进程生成不可猜测，绑定会话 token；取消走独立 `POST /v1/cancel`
3. **HTTP 端点**：`POST /v1/run`（发请求→返回 requestId）、`GET /v1/stream/:requestId`（SSE）、`POST /v1/cancel`（{requestId}）；`Authorization: Bearer <sessionToken>`；仅 127.0.0.1 随机端口
4. **PlanStructure**：§5.2 schema + 顶层 `schemaVersion: <int>`（ADR-005）；render 比例尺 50px/m
5. **错误码表**（唯一语义，无歧义表述）：`ERR_AUTH | ERR_VALIDATE | ERR_TOOL | ERR_LLM | ERR_CANCEL | ERR_TIMEOUT | ERR_INTERNAL`
6. **mock-provider**：`packages/mock-provider` 导出 `createMockChatStream(messages)`（异步迭代流式文本）与 `mockPlanStructures()`