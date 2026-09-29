# 开发计划 PLAN-20260812-AICH-Design-R3

> 版本：v0.1（执行轮 R3）　|　创建：2026-08-12　|　作者：planner（指挥模式 /auto）
> 关联总计划：`docs/plans/PLAN-20260812-AICH-Design开发计划.md`（v0.1，P001-P024 全周期）
> 来源：总计划 v0.1 P015-P020 + 设计文档 §7（沙箱）/§9（SQLite）/ADR-003（会话生命周期）/ADR-005（迁移）/ADR-006（可恢复任务）/§8.1（主进程职责）；本计划为 **R3（Phase 3 安全与存储轮）** 细化与契约变更冻结
> 代码落点：`aichitect Design/`（项目根）；`docs/plans/`、`.handoffs/` 均在本目录

## 1. 背景与目标

- 需求来源：总计划 v0.1「Phase 3 M4 安全与存储（P015→P016‖P017 先行→P018‖P019→P020）」，出口=「沙箱越权自测通过、崩溃恢复、迁移 fixture」；R1/R2 已闭环 P004-P014
- **本轮（R3）目标**：跑通 **M4 客户端与沙箱**（P015/P016/P017/P018/P019 + P020 安全专项审查）成对交付；含 P002 Spike 前置实测（P015 依赖项，此前 R1/R2 因「需实机/联网」未跑，现环境已实机可用）
- 验收口径（可量化）：
  - P002 Spike：Windows 原语启动 Node 的**可行性结论 + sandbox-launcher 技术要点**落盘（不支持 → fail-closed 记录，总计划 P002 既有语义）
  - P015：声明式策略(sandbox/policy.ts) + launcher（真实原语可行则实现，否则最小权限启动包装 + fail-closed 自检）+ 越权自测（路径/网络白名单语义测试）
  - P016：KeyStore 抽象（read/get 不落地）+ 每会话 token 轮换（网关侧支持，契约变更冻结）；「沙箱内进程永不见真实 Key」语义在案
  - P017：`@aichdesign/storage` 包（node:sqlite + PRAGMA user_version + migrations 幂等 + 备份）+ fixture 往返测试（旧库可开）
  - P018：任务队列补强（指数退避重试、死信、图像成本护栏）接入 RunManager
  - P019：Session/Context Manager（两层记忆、70% 压缩预估、硬约束抽取、rehydration 自崩溃 jsonl 恢复）
  - P020（reviewer）：安全专项审查报告无 P0/P1
  - 自测：typecheck / vitest / build / 冒烟尽量跑通，失败按铁律 8 记录

## 2. 范围界定

- **做（R3）**：
  - P002 Spike 实测（backend，Windows AppContainer/restricted-token 启动 node 可行性）
  - P015 sandbox-launcher（backend）
  - P016 KeyStore 抽象 + 会话 token 轮换（backend）
  - P017 storage 包（backend；落 `packages/storage` 新 workspace 包，Electron 主进程接线登记为联调 TODO——单写者=主进程物理位置，接线由主 Agent/后续轮 + frontend 在主进程侧挂接）
  - P018 任务队列补强（backend）
  - P019 Session/Context Manager（backend，rehydration 基于 jsonl——不阻塞等 SQLite）
  - frontend：G8 修复（dev 模式 file:// 图像黑图 → dataURL 兜底）+ P016 会话 token 契约适配（mock 先行，契约以 backend 交接「依赖信息」为准）
  - P020 安全专项审查（reviewer）
- **不做（R3，登记降级）**：Electron 主进程 SQLite 接线（P017 交付 storage 包 + 冒烟，接线归后续轮）、真实 Keystore native（Windows Credential Manager 需 native，本轮 KeyStore 抽象 + 加密文件实现在案，CM 接入登记）、inference proxy 凭据注入（真实 Key 经代理注入路线登记降级——本轮 agent-service 仍可持 Key，Key 来源=主进程 KeyStore 注入环境变量）、真实 AppContainer（若 P002 结论不可行则 fail-closed 记录 + 最小权限降级方案）
- **前置事实**：Node 24 + npm.cmd + Electron 已实机可用（ENVIRONMENT.md 2026-08-12）；R024 实机复核（cancel 终态码）与前轮观察项可在 P018/R024 收尾一并核

## 3. 技术选型及理由（R3 落定点）

| 决策点 | 选择 | 理由 | 备选/降级 |
|---|---|---|---|
| SQLite 驱动 | **node:sqlite**（Node 24 内置，DatabaseSync） | 免 better-sqlite3 native ABI（M4 前置验证项，npm 源受限风险高）；总计划已列备选；同步 API 契合主进程单写者 | better-sqlite3（若 node:sqlite 在 24.19 不可用则回退，先实测） |
| 沙箱原语 | P002 实测后定：AppContainer / restricted-token + 低 IL | 设计 §7 语义；纯托管栈可行性存疑 → spike 后 fail-closed 决策 | 最小权限启动包装（去除特权+低权限 UAC）+ 声明式策略 + 自检；真实原语留 native helper（P022） |
| KeyStore | KeyStorePort 抽象 + 加密文件实现（AES-GCM，Key 派生自主进程首启口令/环境） | 纯 Node 无 CM native；验收「进程内不见真实 Key」语义在设计在案 | Windows Credential Manager（native，P016 后缘）；inference proxy 注入（登记） |
| 会话 token 轮换 | 主进程向网关注册会话令牌：`POST /v1/authorize` `{sessionId}` → 一次性 token；run/stream/cancel 用会话 token | 会话级隔离 + 可轮换；渲染层不持 token（主进程经 IPC 桥） | 进程级单 token（现状，P016 前兼容） |
| 迁移体系 | PRAGMA user_version + migrations 表 + 幂等脚本（shared/migrations 语义迁到 storage 包内） | ADR-005 冻结 | — |
| 会话恢复 | jsonl 导入 + 版本树重建（rehydration） | 不阻塞 SQLite；storage 就绪后 meta.db 只补版本/费用查询 | — |

## 4. 任务拆解（R3）

> task-id 沿用总计划；**新增编号** R3-P 前缀仅指本计划内执行顺序，不占用总计划 ID。backend 分两路并行（A=沙箱/凭据链，B=存储/队列/会话链），`packages/storage` 为 A、B、frontend 三方共享只读依赖（A/B 不写对方包）。共享文件 backend 单写（铁律 4）。

| ID | 任务 | 角色 | 依赖 | 验收标准 |
|---|---|---|---|---|
| P002-SP | P002 Spike 实测：Windows 下受限令牌/低 IL/AppContainer 启动 node 的可行性探测（用 PowerShell 原语与 node 组合验证），产出「可行性结论 + sandbox-launcher 技术要点」落 README/spike 记录 | backend-A | 实机环境 | 结论具体（成功/失败/需 native helper），技术要点清单，fail-closed 语义明确 |
| P015 | sandbox-launcher：`packages/sandbox-launcher`（新包或 agent-service 内模块，建议独立包）：sandbox/policy.ts 声明式策略（单项目目录+临时授权、loopback 豁免、fail-closed 默认拒绝）+ launch(entry,policy)（按 P002 结论实现真实原语或降级最小权限包装）+ self-test（越权自测：读 KeyStore/.ssh 被拒断言、网络仅 loopback 断言） | backend-A | P002-SP | 策略翻译与 self-test 可测；越权路径拒绝（测试断言）；P002 结论引用 |
| P016 | KeyStore 抽象（`packages/agent-service/src/keystore/` 或 storage 上层）+ 加密文件实现（AES-GCM）+ 会话 token 轮换：网关 `POST /v1/authorize {sessionId}` 颁发/轮换会话 token，run/stream/cancel 校验会话 token；契约变更回写交接「依赖信息」通知 frontend 主进程适配 | backend-A | P015 | token 轮换 vitest（不同会话异 token、轮换后旧 token 失效）；KeyStore 加解密往返测试；契约落盘 |
| P017 | `packages/storage`（node:sqlite）：meta.db（版本树/费用/图像元数据 表草图 §9.2）+ PRAGMA user_version + migrations（幂等）+ 备份（copy before migrate）+ fixture 往返测试（旧 schema 库可打开升级） | backend-B | 实机 node:sqlite 可用性 | 迁移 fixture 往返通过；node:sqlite 冒烟（DatabaseSync open/read） |
| P018 | 任务队列补强（agent-service RunManager）：指数退避重试（转瞬态失败误判）、死信（终态错误详情登记）、图像成本护栏（重试前成本上限检查 + 用户确认语义占位）；R024 cancel 终态码实机复核一并收尾 | backend-B | P006 | 退避/死信/护栏 vitest；cancel 终态码实测记录 |
| P019 | Session/Context Manager（agent-service）：两层记忆（结构化原样、消息流超预算压缩）、70% 窗口预估触发、硬约束抽取（§5 字段+显式需求）、rehydration（jsonl 导入恢复 Agent/session 状态） | backend-B | P006, P017(非阻塞) | 压缩/硬约束 vitest；rehydration：写 jsonl→新进程/新实例恢复会话与版本树 冒烟 |
| G8-fix | dev 模式 file:// 图像黑图兜底：渲染层 image 加载失败 → 经主进程读文件转 dataURL（IPC dataURL 通道）或本地直接兜底 | frontend | P013 | dev 模式网关图像正常显示（实机目检） |
| P016-front | 会话 token 适配：主进程 gatewayClient/请求头携带会话 token（backend `POST /v1/authorize` 契约落盘后）；mock 先行（MockGateway 生成会话 token 语义对齐） | frontend | P016 契约 | typecheck/buid 通过；网关请求带会话 token（目检/代码核对） |
| P020 | 安全专项审查（密钥路径、网络白名单、迁移脚本、护栏、token 轮换） | reviewer | R3 全部 | 报告无 P0/P1；签署通过/回退 |

## 5. 里程碑与顺序建议

- **R3-A（backend-A 沙箱/凭据链）**：P002-SP → P015 → P016（P016 契约变更后 frontend 启动 P016-front）
- **R3-B（backend-B 存储/队列/会话链，与 A 并行）**：node:sqlite 可用性冒烟 → P017 → P018 → P019（P019 用 jsonl rehydration，不等 storage 接线）
- **R3-C（frontend，并行）**：G8-fix → P016-front（契约就绪后）
- **R3-D（reviewer）**：P020 安全专项审查 → P0/P1 回退 → 复审 → 归档
- 关键路径：P002-SP → P015 → P016（会话 token 契约是 frontend 依赖）；P017/P018/P019 独立并行

## 6. 风险与假设清单

| 级别 | 风险/假设 | 应对 |
|---|---|---|
| 高 | AppContainer/restricted-token 纯托管栈不可行（需 native helper） | P002-SP 先行实测给结论；不可行 → P015 降级「最小权限包装 + 声明式策略 + fail-closed 自检」，真实原语登记 P022 native helper，README 如实标注 |
| 高 | node:sqlite 在 Node 24.19 不可用/实验警告影响 | P017 首步冒烟；不可用回退 better-sqlite3（需 npm 安装，install 后 postinstall 已可（ELECTRON 法），但 native 编译风险高）或标记降级 |
| 中 | token 轮换契约变更影响网关既有调用方（frontend gatewayClient/R2 smoke 脚本） | 契约回写交接「依赖信息」，frontend P016-front 适配；既有进程级 token 兼容保留（登记废弃路径） |
| 中 | P019 会话恢复需状态可序列化（pi Agent 内存态） | rehydration 以 jsonl 消息流重放重建（ADR-003 语义），pi Agent 内存态残缺登记 |
| 中 | KeyStore 「真实 Key 永不落 agent-service」与现有 AICH_IMAGE_API_KEY 直接注入冲突 | 本轮 KeyStore=抽象+加密文件（主进程），agent-service 仍可接收环境变量注入 Key（来源主进程）——inference proxy 全程注入路线显式登记为后续 |
| 低 | 共享文件并发（packages/storage 新包、agent-service 包内多任务） | 明确 A/B 两路不写对方包；storage 归 backend-B 单写；frontend 只写 packages/app |
| 假设 | 实机验证由主 Agent/用户兜底（ENVIRONMENT.md 验证职责归属） | 交接如实标注验证结果/降级 |

## 7. R3 契约变更冻结（写入双方交接「依赖信息」）

1. **会话 token 轮换（P016）**：新增网关端点 `POST /v1/authorize`：请求 `{ sessionId }` → 响应 `{ token }`（一次性、可轮换：再次调用使旧 token 失效）；`/v1/run`、`/v1/stream/:id`、`/v1/cancel` 校验会话 token（Bearer）；`/v1/health`、`/v1/metrics` 不变（进程 token 或免认证——以 backend 落盘为准）。渲染层不持 token（主进程负责）。兼容：既有进程级 token 在本轮保留，废弃路径登记。
2. **P017 迁移**：`PRAGMA user_version` + `migrations` 表语义迁入 `packages/storage`；迁移脚本幂等、先迁移后使用、迁移前备份；表草图 → 设计 §9.2 草案落地（以 backend 落盘为准）。
3. **P019 ADR-003**：两层记忆/70% 压缩/硬约束抽取/rehydration 语义落 agent-service；结构化（PlanStructure/版本树）原样，会话消息流超预算才压缩。
4. **KeyStore 契约**：`KeyStorePort` 抽象（`read(key)`/`has(key)`，不落日志）+ 加密文件实现（AES-GCM）；主进程唯一实例化；沙箱内进程永不见真实 Key 为后续 in-proxy 语义（本轮登记）。
5. **新增包**：`packages/storage`（node:sqlite 数据层）、`packages/sandbox-launcher`（策略 + launcher）——均 workspace 私有包，backend 单写，exports 指向 dist（沿用 R1 构建链约定）。