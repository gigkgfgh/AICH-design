# 开发计划 PLAN-20260812-AICH-Design开发计划

> 版本：v0.1　|　创建：2026-08-12　|　作者：planner
> 来源：AICH Design 详细设计文档 v0.2 评审（2026-08-12）——方案可执行性确认 + 评审问题修复
> 这是 reviewer 核对「实现是否符合计划」的依据，各阶段实现必须与本文档可对照。

## 1. 背景与目标

- 需求来源：AICH Design 详细设计文档 v0.2（`docs/AICH-Design-Detailed-Design-精简版.md`），上游 PRD v1.3
- 业务目标：桌面端 AI 建筑平面方案设计工具——自然语言起草/迭代平面方案（SVG）、一键生成表现图、方案/图像版本管理与回退、本地优先与密钥保护
- 评审结论：架构与选型成立，已核验 `@earendil-works/pi-agent-core` v0.84.1（MIT、周下载 200 万+）真实可用（Agent/agentLoop/事件订阅/TypeBox 工具/streamProxy，与 §3.3 端口抽象、§7 代理注入吻合）；三个未知数前置 Spike 消解
- 验收口径（可量化）：
  - M1：无网环境 mock 全链路跑通「输入一句话 → 流式返回 → 展示」，耗时/成功率/成本有记录
  - 最终：对话 → 方案 SVG → 对话修改 → 表现图 → 导出 SVG/PNG/JSON，离线可用，沙箱越权自测通过

## 2. 范围界定

- 做：
  - monorepo（app / agent-service / skills / extensions / shared / sandbox-launcher）
  - pi-agent-core 内核接入（AgentRuntimePort 抽象）、本地网关（推理代理 + HTTP 桥合一）
  - plan-draft Skill + plan-tools Extension 能力包（validate_plan / render_plan_svg / plan_patch）
  - image-tools Extension（image_generate / image_edit，独立图像端口，baseURL 可配）
  - Electron + React UI（ChatPanel / PlanCanvas / ImageGallery / VersionTree / 设置）
  - Windows 原生沙箱（AppContainer / restricted-token，fail-closed）、KeyStore + 凭据注入
  - SQLite 存储（唯一写者=主进程）+ 迁移体系 + 任务队列 + 成本埋点（C-6 自 M1 起步）
- 不做（明确排除）：
  - 本地轻量模型兜底（已取消）
  - DWG/IFC 导出（P2，仅预留 toDxf 扩展接口）
  - WebSocket（SSE + 独立控制请求即可）
  - 具体 UI 视觉稿、商业定价、法务合规深度审查

## 3. 技术选型及理由（沿用设计文档 §1，标注修订项）

| 决策点 | 选择 | 理由 | 备选 |
|---|---|---|---|
| 内核基座 | pi-agent-core（锁版本 0.84.x） | 已核验可用：工具调用+状态管理+事件流，MIT | 自研最小 loop（AgentRuntimePort 兜底） |
| LLM 接入 | pi-ai | 统一多 Provider，Model.cost 供成本埋点 | 直接 OpenAI SDK |
| 桌面框架 | Electron | 成熟、主进程+渲染进程分层符合安全模型 | Tauri（放弃，生态/生态不匹配） |
| UI | React + TypeScript（自研） | pi monorepo 无 pi-web-ui | — |
| 沙箱 | Windows 原生（AppContainer/restricted-token） | 零额外安装负担；Phase 0 S2 实测后定案 | Docker/WSL2（已否决） |
| 平面输出 | SVG（JSON 中间层先行） | 可编辑/可校验/确定性渲染/多视图派生 | LLM 直出 SVG（否决） |
| 图像模型 | gpt-image-2（Image API） | 2026-04 发布；Phase 0 S3 实测定参 | gpt-image-1.5 双模型路径（透明背景） |
| 本地存储 | SQLite（better-sqlite3）+ 文件 | 单写者=主进程；ABI 问题 M4 前置验证 | node:sqlite（Node 22 内置，备选） |
| 打包 | electron-builder（NSIS） | 成熟；EV 证书 Phase 1 并行采购 | AppX |
| 进程通信 | IPC（渲染↔主）+ 本地 HTTP/SSE（主↔沙箱内 agent-service） | 跨边界最自然、可测试 | WebSocket（否决） |
| **修订① 本地通信** | **统一 127.0.0.1:随机端口 + 每会话一次性 bearer token** | 删除 inference.local 域名，免 hosts/证书信任链；沙箱仅 loopback 豁免即天然只连网关 | 域名+证书（否决） |
| **修订② 存储写者** | **meta.db 唯一写者=主进程**；agent-service 仅直写 sessions/*.jsonl | 消除双写者缝隙；版本/费用经 HTTP 回报主进程入库 | agent-service 全权写（否决） |
| **修订③ mock** | **mock-provider 共享包（M1 建立）** | frontend/backend 并行 + 离线测试（C-7）依赖 | 各包自写假数据（否决） |

## 4. 任务拆解

> 阶段序号沿用设计文档 M1-M5；新增 Phase 0（评审引入的 Spike 前沿）。任务 ID 规划 P001-P0xx，最终由后续交接文档逐项细化编号。

| ID | 任务 | 所属角色 | 依赖 | 验收标准 | 评估量 |
|---|---|---|---|---|---|
| P001 | S1：pi-agent-core 嵌入冒烟（Agent+tools+streamProxy+事件订阅，锁版本） | backend | — | 最小 loop 跑通；API 摸查记录供 adapter 设计 | 1-2d |
| P002 | S2：AppContainer/restricted-token 跑 Node 实测（loopback 豁免、%TEMP%、spawn 子进程、Win 版本矩阵） | backend | — | 可行性结论 + sandbox-launcher 技术要点；不支持则 fail-closed 记录 | 2d |
| P003 | S3：gpt-image-2 generate/edit 实测（尺寸/透明/input_fidelity/计费） | 用户实机（本机 npm 不可用） | — | 参数确认表 + 双模型路径决策 | 1d |
| P004 | S4：monorepo 骨架（npm/pnpm workspaces 目录结构 + shared 契约骨架） | backend | — | 目录/包结构与设计 §2.2 一致 | 1d |
| P005 | 契约冻结：AgentRequest/Response、SSE 信封、PlanStructure@shared、mock-provider | planner | P004 | reviewer 契约审查通过 | 1d |
| P006 | agent-service：AgentRuntimePort adapter + 本地网关 HTTP/SSE + 会话 jsonl + 成本埋点 | backend | P001, P005 | mock 全链路流式返回；usage/cost 落库 | 3-4d |
| P007 | Electron 壳 + ChatPanel 最小版（mock 直连） | frontend | P005 | 输入→流式展示可演示 | 2-3d |
| P008 | plan-tools extension：validate_plan（Schema+引用完整性）、render_plan_svg（§5.3 规范）、plan_patch | backend | P004, P005 | 三个工具单测通过；修正回环 ≤2 次护栏生效 | 3-4d |
| P009 | plan-draft SKILL.md（L2 指令 + references：schema/渲染规范） | backend | P008 | frontmatter 合规；渐进披露注入验证 | 1-2d |
| P010 | PlanCanvas + 版本树 UI + 对话修改流（mock 先行） | frontend | P005, P008 契约 | 一句话→方案 SVG→改一句→新版本→回退 | 4-5d |
| P011 | 严格 json_schema 输出模式（联调决定启用） | backend | P008 | 校验失败率对比记录 | 1d |
| P012 | image-tools extension（generate/edit + gpt-image-2 适配 + 独立端口配置） | backend | P003, P005 | 参数确认表落地；端口隔离配置生效 | 3d |
| P013 | ImageGallery + 图像版本树（prompt/父版本/费用展示） | frontend | P012 契约 | 平面→表现图→入库回退演示 | 2-3d |
| P014 | B-3 联动：SVG→PNG 栅格化（shared 渲染管线） | backend | P008 | 平面 SVG→PNG→图像参考图 | 1d |
| P015 | sandbox-launcher 落地（按 P002 结论；单项目目录+临时授权；loopback 豁免；fail-closed 自检） | backend | P002, P006 | 越权自测：读 KeyStore/.ssh 被拒、直连外网被拒 | 3-4d |
| P016 | 本地网关：KeyStore 凭据注入（凭据永不出主进程）、每会话 token 轮换 | backend | P006, P015 | 沙箱内进程永不见真实 Key | 2d |
| P017 | SQLite 单写者 + 迁移体系（PRAGMA user_version + migrations、幂等、先迁移后使用、备份） | backend | P006 | 旧版本库可打开 fixture 往返 | 2d |
| P018 | 任务队列（ADR-006：幂等=requestId、指数退避、死信、图像成本护栏） | backend | P006 | 断网→恢复→重试不重复计费 | 2d |
| P019 | Session/Context Manager（ADR-003：两层记忆、70% 压缩、硬约束抽取、rehydration） | backend | P006, P017 | 崩溃重启恢复会话与方案 | 2-3d |
| P020 | 沙箱/安全专项审查（密钥路径、网络白名单、迁移脚本、护栏） | reviewer | P015-P019 | 报告无 P0/P1 | 1-2d |
| P021 | Playwright E2E（输入→方案→修改→表现图→导出） | frontend | P010-P014 | windows 矩阵全绿 | 2-3d |
| P022 | electron-builder NSIS + 签名 + electron-updater + CI | frontend/backend | P021 | 安装包可分发、更新可验证 | 2-3d |
| P023 | 内测指标仪表（激活/任务完成/图像成功/成本看板） | backend | P006 埋点 | 指标面板可查 | 1-2d |
| P024 | 终审（reviewer）→ 签署 done → 交接归档 | reviewer | P021-P023 | 报告无 P0/P1；验收标准全达成 | 1d |

## 5. 里程碑与顺序建议

- **Phase 0 技术 Spike（3-5 工作日）**：P001\|\|P002\|\|P003（三者可并行；S3 需用户实机）→ P004。出口：ADR 定稿（本地网关方案、沙箱实测结论）
- **Phase 1 M1 内核闭环（1-2 周）**：P005（契约冻结）→ P006（backend）\|\| P007（frontend 并行）。出口：无网环境 mock 全链路 + 埋点基线
- **Phase 2 核心能力（2-3 周，M3 优先、M2 并行）**：
  - 初段 M3：P008 → P009 → P010（frontend 与 P008 契约并行）\| P011（联调定）
  - 后段 M2：P012 → P013 \| P014。出口：对话→方案→表现图→回退全闭环，离线可用
- **Phase 3 M4 安全与存储（2 周）**：P015 → P016 \| P017 先行 → P018 \| P019 → P020（安全专项审查）。出口：沙箱越权自测通过、崩溃恢复、迁移 fixture
- **Phase 4 M5 工程化（1-2 周）**：P021 → P022 \| P023 → P024 终审归档。出口：安装包可分发

关键路径：P001→P006→P008→P015→P017 为纵贯主线，其余皆可并行缓解。

## 6. 风险与假设清单

| 级别 | 风险/假设 | 应对 |
|---|---|---|
| 高 | AppContainer 跑 Node 的 loopback/TEMP/spawn 行为未实测 | P002 Spike 消解；fail-closed 降级 restricted-token；仍不支持拒绝启动 |
| 高 | pi-agent-core API 仍在演进 | 锁版本 0.84.x + AgentRuntimePort 端口抽象（G3） |
| 高 | 本机 npm 不可用（ENVIRONMENT.md 快照） | 各窗口命令降级路径静态交付；实机验证由用户执行；S3 由用户有网实测 |
| 中 | gpt-image-2 约束（透明背景/input_fidelity/组织验证） | P003 实测；gpt-image-1.5 双模型路径备选 |
| 中 | LLM 结构化输出失败率 | 三重保险：严格 json_schema + 校验重试 ≤2 + 降级输出（bounds 包围盒推算） |
| 中 | 图像成本不可控（按 token） | C-6 埋点自 M1；图像重试需用户确认/设上限（ADR-006）；默认 medium |
| 中 | better-sqlite3 与 Electron ABI 不匹配 | M4 前置验证 electron-rebuild/prebuild；备选 node:sqlite |
| 低 | 本地网关单点故障 | 常驻主进程、轻量无外部依赖；故障 fail-closed |
| 低 | OpenAI 区域可用性 | 双端口 baseURL 可配兼容端点；合规由商务/法务 |
| 假设 | 开发机为 Windows 10/11（P002 实测确认 AppContainer 支持度） | 若旧版本系统降级 restricted-token 路径 |
| 假设 | EV 证书采购周期 2-4 周 | Phase 1 并行启动，不阻塞主线至 M5 前 |

## 7. 评审修复映射（v0.2 设计文档 → 本计划）

| # | 评审问题 | 修复落点 |
|---|---|---|
| P0-1 | §7.1/§8.3 通信矛盾 | 统一 127.0.0.1+token、本地网关合一（§3 修订①） |
| P0-2 | meta.db 双写者 | 唯一写者=主进程（§3 修订②） |
| P0-3 | 结构化输出加固 | P008 校验回环≤2 + 降级输出；P011 严格模式 |
| P0-4 | 埋点后置 | P006 成本埋点起点；P023 聚合展示 |
| P1-5 | 无共享 mock | P005 mock-provider 包 |
| P1-6 | 里程碑次序 | Phase 2 M3 优先 M2 并行 |
| P1-7 | 沙箱授权粒度 | P015 仅单项目目录+临时目录 |
| P1-8 | sqlite ABI | P017 前置验证 + node:sqlite 备选 |
| R-10 | plan-draft 封装 | Skill+Extension 能力包（P008/P009），Agent Loop 内修正闭环 |
| R-11 | JSON 中间层理由 | 设计文档 §5.1 补充说明（后续修订时执行） |
## R4-1 执行记录（2026-08-24，主进程接线轮）

- ✅ R3 收尾：sessions:read 新会话报错修复（返回空内容）；R3 三份 handoff 归档（status: done）。
- ✅ P016 KeyStore 主进程接线：`app/electron/keyStoreService.ts`（setup/unlock/saveKeys/status，口令仅内存）+
  4 个 keystore:* IPC；解锁后 spawn env 注入 LLM/图像 Key（图像真实生效；LLM Key 已注入 config，真实流式接线下轮）；
  Key 保存 → agent-service 自动重启生效（会话 token 随之轮换）。
- ✅ 设置面板密钥管理（用户新需求）：三态 UI（建立口令/解锁/Key 表单），LLM+图像（Key/BaseURL/模型），
  密钥永不回显（仅「已配置」标记），支持清除；保存即重启本地服务并刷新网关状态。
- ⚠️ P017 storage 接线（代码完成，运行时受限）：主进程单写者 meta.db + done 信封持久化已接线；真机自检发现 **Electron 内置 Node 20 无 node:sqlite**，主进程初始化走 fail-open（应用不受影响，仅不持久化）。待升级 Electron（捆绑 Node ≥22.5）后自动生效；边界已登记。
- ✅ P019 注入链：ContextManager.contextInjection（摘要+硬约束+版本树引用）→ pi-adapter 会话 Agent 创建时附加系统提示。
- ⏸ P015 sandbox-launcher 接线：**顺延至 in-proxy 轮**（凭据 env 注入与 scrubEnv 硬剥离冲突，见包 README 登记与 S-R3-4）。
- 验证：全仓 typecheck/build 0 错误；154/154 测试；dev 开窗握手成功（pi-adapter）无错误日志。
- 待用户目检：设置面板密钥管理三态/Key 保存重启生效/图像 Key 真实调用（需真实 Key）。
- 🔄 变更（2026-08-24 用户指令）：密钥管理**取消口令方案**——app 改用 Electron safeStorage（Windows=DPAPI 绑定系统用户）`electron/secretsService.ts`：保存即系统级加密、启动即生效，无建立/解锁步骤；IPC 改 secrets:status/saveKeys；`@aichdesign/keystore`（口令派生）保留为独立交付，app 不再依赖。验证：typecheck/build 0 错误，154/154 测试。

## R5 执行记录（2026-08-24，子 Agent 系统 + Composer 增强 + 真实 LLM + Electron 35 + 联网检索）

- ✅ 契约扩展（只增）：run 信封可选 `agent`/`model`/`thinking`（思考档采用 pi-ai 原生 ThinkingLevel：off/minimal/low/medium/high/xhigh/max，透传不折算）；新 kind `research`；`POST /v1/images`（上传参考图注册，28MB 上限，会话 token 绑定）。
- ✅ 真实 LLM 接线：`llm/model.ts` buildLlmModel（openai-completions，provider=aich-llm，0 费率登记）+ main.ts createProvider/openAICompletionsApi + models.streamSimple + getApiKey；配置齐备（设置面板 Key/BaseURL/模型）→ 真实流式，否则 mock 降级。
- ✅ 联网检索（开源方案 SearXNG）：`tools/search.ts` web_search（SearXNG JSON API / DuckDuckGo HTML 备用 / disabled 默认）+ fetch_page（HTML→文本 32KB）；**SSRF 防护**（协议白名单/loopback/私网/DNS 解析校验/2MB/15s）。设置面板「联网检索」配置 → AICH_SEARCH_* 注入。
- ✅ 子 agent 预设：`agents/presets.ts` 四套（main/plan-draft/image-gen/research——系统提示侧重 + 工具白名单）；pi-adapter 缓存键 sessionId|agent|model、按预设过滤工具、thinking 经 streamFn 包装注入 options.reasoning、model 覆盖重建 Model。
- ✅ Composer（ZCode 风格）：左下 AgentSelector（四 agent 菜单+描述）、右下 ModelSelector（mock/已配置/预设）+ ThinkingSelector（原生七档）+ 📎 附件（图片→/v1/images 注册→refImageId；文本≤50KB 注入 prompt）；主 Agent 意图路由 classifyAgentIntent；idle 态同样携带工具条。
- ✅ Electron 31→35.7.5：dev 真机自检通过（握手 OK、无 sqlite 报错）；**meta.db 持久化生效**；新 IPC `storage:plans` → 历史会话完整恢复方案版本树（结构+SVG；meta.db 不可用时降级引用级）。
- 验证：typecheck/build 0 错误；测试 185/185（agent-service 52 含 R5 8 / app 33 含路由 6 / extensions 55 / storage 11 / keystore 9 / sandbox 8…按包计）；真机 dev：Electron35 + composer 工具条 + mock 全链路。
- 待用户真机验收：composer 三选择器交互、上传注册（📎→发送 genImage）、research（配置 SearXNG 后联网）、真实 LLM 对话（已存 Key 时）。
- 边界登记：plan_version.parent_version_id 持久化暂为 null（信封无父版本，版本树平铺展示）；自定义模型 0 费率记账；DDG 网络可达性视环境；research 无检索配置时退化为模型知识分析。

## R6-1 执行记录（2026-08-24，消息渲染升级 + 在途请求重连）

- ✅ Markdown 渲染：react-markdown + remark-gfm（标题/列表/表格/代码/引用/链接）；assistant 消息全部走 Markdown（调研报告可读性）；**来源链接可点击 → 主进程 shell.openExternal 系统浏览器打开**（新 IPC `open:external`，仅 http/https 白名单，防任意协议）；不启用 rehype-raw（无原始 HTML 注入面）。
- ✅ plan 消息内嵌方案缩略图（SVG 直渲卡片）→ 点击全屏大图浮层（Esc/背景关闭）；SVG 为自家渲染产物（非用户 HTML）。
- ✅ 在途请求重连（结果永不丢）：
  - 主进程：事件泵改为**全窗口广播**（渲染层刷新后新窗口仍收到在途事件）；`requestSessions` 结构化（sessionId/kind/prompt 摘要，容量 300 上限）+ 在途泵去重（pumpActive）；
  - 新 IPC `gateway:activeRuns`（在途列表）+ `gateway:reattach`（终态则重新拉流回放缓存事件，在途则跳过——广播已覆盖）；
  - 渲染层：挂载/切会话后自动重挂当前会话在途请求（占位用户消息 + 「↻ 已重新挂接」提示，终态回放立即入结果树）。
- 验证：全仓 typecheck 0 错误、168/168 测试、dev 真机自检零错误（握手 OK）。
- 登记边界：重挂仅恢复结果与占位提示（飞行中已显示的增量文本不回补——jsonl 仅在终态落 assistant 行）；mock 直连（无 bridge）不参与重连。

## R6-3 执行记录（2026-08-24，Beta 标识 + 外部 Skill + 常驻侧栏 + 菜单中文化）

- ✅ plan-draft 定义为 Beta：Agent 菜单项加 Beta 徽标；基础提示词技能行标注（Beta）。
- ✅ 外部 Skill（Anthropic Agent Skills 开放格式）：`skills/loader.ts` 扫描 `<userData>/skills/<name>/SKILL.md`
  （frontmatter name/description，name 白名单 ^[a-z0-9-]{1,64}$，正文截断 64KB，fail-soft）；
  L1 元数据注入系统提示「外部技能」段 + `read_skill` 工具按需取全文（渐进式披露，对齐 Anthropic 机制）；
  read_skill 恒可用（不受子 agent 工具白名单限制）。设置面板「外部技能」区：打开技能文件夹（自动创建）/
  重启本地服务生效；env `AICH_SKILLS_DIR` 注入。
- ✅ idle 初始界面显示左侧边栏（历史/新建/设置全程可达）；侧栏头部 ‹ 按钮收起、细条 ▶ 展开（idle/work 共用状态）；
  移除 idle 右上角设置悬浮按钮。
- ✅ 应用菜单中文化：文件/编辑/视图/窗口（标准角色行为保留），移除 Help 栏。
- 验证：全仓 typecheck/build 0 错误；191/191 测试（agent-service 58 含 skills-loader 6）；dev 真机自检零错误。
- 边界登记：外部技能仅注入提示词与 read_skill（不注册新工具）；技能变更需手动重启本地服务（设置面板按钮）。

## R6-5 执行记录（2026-08-24，多行输入 + 加号菜单[附件/技能]）

- ✅ 输入框改 textarea：自动增高（1→10 行，200px 限幅内滚动）；Enter 发送 / Shift+Enter 手动换行；
  IME 组合输入保护（isComposing + composition 事件双保险，中文输入法候选回车不误发）。
- ✅ 加号菜单（输入区左下角 ＋）：📎 添加附件（ingestFiles 共享管线：图片注册/文本读取，原 📎 按钮移除）
  + ⧉ 选择技能（子菜单列出外部技能，懒加载 GET /v1/skills；选定→chip 展示可取消，发送时注入 prompt 头部
  `[使用技能: name]（描述）请按该技能的指引执行`；发送后保留便于连续使用）。工具条布局：＋+Agent | spacer | 模型+思考。
- ✅ 后端：skills 加载抬升到 start()（resolveAdapter 与网关共享）；新端点 GET /v1/skills（仅进程级 token，
  返回 [{name,description}]）；主进程 skills:list IPC → 渲染层加号菜单。
- 验证：全仓 typecheck/build 0 错误；174/174 测试；dev 真机零错误。
- 边界：技能列表在 agent-service 启动时快照（装新技能需设置面板重启服务）；技能选择为单选（一次一条消息带一个技能）。

## R6-6 执行记录（2026-08-24，多模型密钥管理 + 自定义会话目录 + 思考/工具展示开关 + Agent 日志）

- ✅ 多模型密钥管理：secrets.json 增加 models[]（name/baseUrl/model/apiKeyEnc(safeStorage)/thinking）+ activeModelId；
  注入 AICH_LLM_MODELS JSON + AICH_LLM_ACTIVE_ID；agent-service 按条目建独立 provider（aich-llm-<id>，Key 按条目鉴权），
  buildModelOverride 按 model/id 切换 baseUrl+Key；defaultThinking=激活条目思考档（信封未指定时生效）。
  设置页模型列表编辑器（增删/设默认/每条目思考档 7 档）；兼容回退旧单模型配置。
- ✅ 自定义会话存储位置：通用页输入 + setSessionsDir IPC（绝对路径校验，保存重启服务）；
  sessionsDir() 单源切换（sessions IPC/图像白名单/日志 env 同步）。
- ✅ 思考/工具调用展示：契约新增 thinking（SseThinkingData.delta）/tool（SseToolData.phase）事件（只增）；
  adapter 转发 thinking_delta 与 tool_execution_start/end；渲染层 ZCode 风格折叠块（左竖线+小字层级+chevron+计数徽标）；
  设置「界面显示」页两开关（localStorage 持久化，关闭即正文无区块）。
- ✅ Agent 日志：主进程捕获 agent-service stdout/stderr 全量落盘 userData/logs/agent-service.log（5MB 轮转 .old）；
  设置「日志」页显示路径 + 打开文件夹。
- 验证：全仓 typecheck/build 0 错误；174/174 测试；dev 真机：握手 OK，**真实 LLM 已激活（llm:deepseek-v4-flash）**，
  sqlite 正常。已修复 bug：agent.state.errorMessage 误归类 REQUEST_CANCELLED → 按上游错误分类 + 404 排查提示。
- 边界登记：模型列表为启动时快照（改配置即重启）；思考档对不支持 reasoning 的端点由其自行忽略；旧单模型 UI 移除（数据兼容保留）。

## R6-7 执行记录（2026-08-24，会话目录对话框 + 密钥统一 + 右栏箭头/拖拽）

- ✅ 会话存储位置改为系统文件夹选择对话框（config:browseSessionsDir → dialog.showOpenDialog openDirectory+createDirectory；通用页路径展示 + 浏览…按钮 + 保存并重启服务）。
- ✅ 密钥管理统一：输入区移除思考深度选择器（思考档由密钥管理页模型条目默认值决定）；模型选择器移除 3 个预设，
  仅列密钥管理页已配置模型（未配置则整器隐藏）——密钥管理页成为模型/密钥唯一维护入口（信封 thinking 字段保留兼容）。
- ✅ 右栏：收起后左缘 ◀ 箭头展开；中列/右栏交界处 6px 拖拽热区（hover 高亮），宽度 320~640px 可拖（working 态 grid 内联像素列）。
- 验证：全仓 typecheck/build 0 错误、33/33 app 测试；dev 真机零错误（llm:deepseek-v4-flash 激活）。
- 附：plan-draft 与外部 skill 区别已答复（内置=代码级工具+提示+白名单；外部=SKILL.md 知识注入+read_skill 按需取文）。

## R6-8 执行记录（2026-08-24，内置技能 SKILL.md 化 + 主次重排）

- ✅ 去除系统提示硬编码「可用技能：plan-draft（Beta）」段：buildSystemPrompt 只保留身份/通用约束 + 统一技能段
  （skillsPromptSection 由技能表动态生成，硬编码工具清单一并移除——pi 内核自动注入工具 schema）。
- ✅ 内置能力 SKILL.md 化（与外部技能同机制）：packages/skills 新增 image-gen/research SKILL.md，plan-draft 补
  「执行约束」段（原 preset 后缀迁移）+ description 标注（Beta）；loader 支持 allowed_tools frontmatter 解析、
  多目录合并（builtinSkillsDir + 用户目录，同名用户覆盖）、preferredOrder 排序（image-gen 首要）。
- ✅ 主次重排：系统提示与 /v1/skills 列表 image-gen 居首；选择器顺序 主Agent→图像生成(首要)→案例调研→方案起草(Beta)；
  main 注册表不再钉技能（全工具），image-gen/research/plan-draft 分别钉住对应 SKILL.md（正文进系统提示+allowedTools 过滤工具）。
- ✅ 注入链：app 主进程解析 packages/skills 路径注入 AICH_BUILTIN_SKILLS_DIR（与 agent-service entry 同源候选策略）。
- 验证：全仓 typecheck/build 0 错误；175/175 测试（agent-service 59 含内置 SKILL.md 解析/排序/白名单新测）；dev 真机
  「技能已加载：image-gen、research、plan-draft」+ 握手 OK（llm:deepseek-v4-flash）。
- 语义变化：技能表对内置/外部完全一致（用户可同名覆盖内置技能）；agent id 仍存在但仅作路由键与钉住依据。

## R6-9 执行记录（2026-08-24，会话删除/侧栏拉伸/LLM分派/Loops日志）

- ✅ 历史对话删除：storage.deleteSessionCascade（plan/image/cost/session 级联）+ sessions:delete IPC（jsonl+meta.db）；侧栏项 hover 删除按钮（confirm），当前会话删除后自动新建。
- ✅ 左侧边栏拖宽（200~400px，idle/work 双布局内联列）；App.tsx 因脚本切割损坏整体重写（功能一份全）。
- ✅ LLM 意图分派：去除正则兜底——主 Agent（main）由 LLM 经新工具 dispatch_agent（image-gen/plan-draft/research + reason）自主分派；
  tool 事件携 dispatchAgent → 渲染层自动以目标子 agent 接续同一请求；消息流「分派 → X」徽标显示。
- ✅ Agent Loops 日志：新语义=完整上下文记录（turn_end 消息/工具结果逐轮 JSONL 落 userData/logs/agent-loops.jsonl）；
  AICH_LOOP_LOG 开关（默认开）+ 设置→日志页开关（重启生效）。
- 验证：全仓 typecheck/build 0 错误、175/175 测试。

## R6-10 修复（2026-08-24）：布局错乱 + 日志默认关
- 布局错乱根因：拖拽分隔条被当 grid 子项（5 子项/3 列）导致换行挤压——.app 由 grid 改 flex（侧栏 slot 固定宽+resizer+中列 flex:1+右 dock），idle/work 统一。
- Loops 日志默认改为关（AICH_LOOP_LOG 缺省 '0'；设置开关显示与持久化对齐）。
- 验证：typecheck/build 0 错误、app 33/33。

## R6-11（2026-08-24，DeepSeek 官方联网 + 多模态图片分析 + 格式对齐）
- ✅ 联网检索新增 deepseek 源：官方 **Responses API + tools:[{type:"web_search"}]**（服务端执行；chat/completions 官方无内置搜索）；
  自动复用密钥管理中 baseUrl 含 api.deepseek.com 的模型条目（base/model/Key），解析 url_citation 注解→来源列表（无注解回退正文抽 URL）。
- ✅ 多模态图片分析（用户澄清：格式要求针对 DeepSeek 多模态 LLM 视觉输入）：信封新增 analysisImageIds（≤4）；
  适配器把已注册图片读为 base64（官方要求 jpeg/png/webp、base64 传输；file:// 本地读取转码；单图 >8MB 跳过），
  经 pi `Agent.prompt(text, images)` 交给多模态 LLM 分析；上传附件即默认随请求分析。
- ✅ 图像 API 格式对齐官方 gpt-image：size 枚举修正（去 2048x2048，加 auto）；quality 含 low/medium/high；
  image_edit mask 强制 PNG（不透明区=待编辑区）+ 语义注释；edits 图片 mime 按嗅探透传（png/jpeg/webp 官方均收）。
- 验证：typecheck/build 0 错误；各包测试绿。

## R6-12 修复（2026-09-28，联网检索被 120s 超时强杀 + 流式错误吞噬 + Loops 日志接线）

- ✅ 根因定位（用户报"联网搜索→INTERNAL_ERROR 网关流式响应中断"）：会话 jsonl 实测 run 恰在 120.012s 被杀
  ——适配器 `LLM_TIMEOUT_MS=120_000` 是"整 run 一次性"定时器（单 LLM 调用时代遗产），联网检索等长工具循环 run 必超。
- ✅ 适配器超时改造：`LLM_TIMEOUT_MS` → `RUN_IDLE_TIMEOUT_MS`（120s 空闲判定：内核有事件即重置；
  tool_execution_start 期间暂停——工具自带超时 search 120s / image 180s / fetch 15s）+ `RUN_TOTAL_TIMEOUT_MS`
  （10 分钟 runaway 总上限）；超时触发的中止先落 terminalError（"运行空闲超时中止/总时长超上限"），不再被误报为
  REQUEST_CANCELLED"请求已取消"；prompt 异常不覆盖超时原因。index.ts 导出同步更名。
- ✅ searchDeepSeek 客户端超时 30s → 120s（DeepSeek 服务端 agentic 搜索常超 30s，超时→isError→模型重试→拖垮整 run）。
- ✅ pumpStream 不再吞错：真实异常写主进程 stderr + 附入广播文案（"网关流式响应中断：{原因}"），可区分 404/401/超时/断连。
- ✅ SSE 保活：客户端 stream() 300s"总超时"改 300s"空闲超时"（收到数据即重置，含心跳）；网关 streamSse 每 15s
  写 `: ping` 注释行（客户端解析器跳过无 data 块）+ res.on('error') 防客户端断开 EPIPE 炸进程（P006 心跳轻量版落地）。
- ✅ Loops 日志开关接线（本次排查缺证据的根因）：R6-9 起开关实际是死的——Electron spawn 从未注入 AICH_LOOP_LOG、
  agent-service main.ts 算出 loopLogPath 却从未传给适配器。现 buildAgentServiceEnv 注入 AICH_LOOP_LOG=1（读 app.loopLog
  设置）、start() 按开关 gate 目录创建并把 loopLogPath 经 resolveAdapter deps 传入 PiAgentCoreAdapter。
- ✅ 顺带修复：适配器订阅回调重复 `case "turn_end"`（R6-9 加 collectLoop 未合并旧 case）——第二个（usage 记账）不可达，
  LLM 运行 token/成本记录实际断裂；现合并为单 case，usage 记账恢复。
- 验证：全仓 typecheck/build 0 错误；175/175 测试绿。待真机复测：联网搜索长运行 + Loops 日志落盘。

## R6-13（2026-09-28，防死循环 + 弱网防重复：审计发现修复）

- 审计结论：pi 内核 agent-loop 为 while(true) 无 maxTurns；后端唯一硬闸是 R6-12 的空闲 120s/总 10min（空闲超时挡"卡死"不挡"活跃循环"）；
  发现 UI 分派接续存在真实死循环（pendingDispatch 永不清零 + 接续 run 复用同一 onDone → 每次运行结束再次接续，image-gen 分派反复生图直到成本护栏）。
- ✅ P1 分派防环（useConversation）：pendingDispatch 用后即清零 + 链上最多自动接续 1 次（超限插系统提示并停止）；
  工具追加器重构为 makeToolAppender 工厂，接续 run 补订阅 onTool（恢复工具可见性）。
- ✅ P1 工具调用轮次上限（宿主侧补内核缺失的防护）：适配器计数 tool_execution_start，超限 abortForced 中止
  并报"工具调用轮次超限中止（单次运行最多 N 次…）"（RUNNER_ERROR，与超时共用 forcedStopMessage 终态通道，不再误报取消）。
  默认 25；配置链：设置 → Agent（新页）→ app.agent.maxToolCalls（secretsService）→ agent:setMaxToolCalls IPC
  （钳位 1~200，保存即重启服务）→ AICH_AGENT_MAX_TOOL_CALLS → config.maxToolCalls（钳位 1~200）→ 适配器 maxToolCalls。
- ✅ 设置新增「Agent」页（SECTIONS 登记，位于外部技能之后）：单次运行工具调用轮次上限数字输入（1~200，默认 25）+ 防护说明。
- ✅ P2 弱网重复显示修复（main.ts）：settledRequests 终态标记（pumpStream 广播 done/error 时登记）→ gateway:activeRuns
  只返回在途 run——终态结果已随 jsonl/meta.db 恢复，原实现会把刚结束的 run 回放成第二条消息（restoreConv + reattachActive 叠加）。
- ✅ P2 collectEvents 竞态修复：AsyncQueue 增加 transcript 全量存档（push 即记录，与消费进度无关）+ snapshot()；
  RunManager 终态缓存改用快照（非 AsyncQueue 实现保留 collectEvents 回退）——原实现以第二消费者身份与实时 SSE 争抢单消费者队列，回放可能残缺。
- 验证：全仓 typecheck/build 0 错误；175/175 测试绿（session-tokens 首跑 fetch failed 为瞬时，复跑通过）。

## R6-14（2026-09-28，ZCode 开源参考：图像端点保存修复 + 多图像服务商 + 设置拆页 + 无边框窗口 + 暗色精修）

- 参考：GitHub `zai-org/ZCode`（Apache 2.0）——desktopWindowChrome.ts（Windows frame:false + 渲染层自绘按钮 + chrome 状态推送）、
  DesktopWindowControls.tsx（三 ghost 按钮/关闭 hover 红/初态查询+订阅防迟到覆盖）、settings 原语（StatusDot/SettingsResourceGroup 模式）、
  ProviderSettingsCard（状态圆点/密码不回显/显式保存 busy 禁用）。
- ✅ 图像端点保存 bug 根因修复：原 KeysPane 唯一保存按钮只提交 LLM 列表，图像 Key/BaseURL/模型无提交出口（保存提示成功但从未写入）；
  另 buildAgentServiceEnv `if(imageKey)` 门控致 Key 缺失时 baseUrl/model 也不注入。随多服务商重构一并修复（独立保存通道 + 注入解耦）。
- ✅ 多图像服务商全链路：secretsService `imageModels[]/activeImageModelId` + `saveImageModels`（apiKey 语义同 LLM）+
  旧单条目懒迁移视图（img_legacy，首次保存固化）；`secrets:saveImageModels` IPC；注入 `AICH_IMAGE_MODELS`+`AICH_IMAGE_ACTIVE_ID`；
  agent-service config 解析（与 llmModels 同构校验）；`resolveImagePort` 选择链：激活有 Key → 任一有 Key → 旧单字段 → mock。
- ✅ 顺带修复（潜伏 bug）：secretsService.load() 此前丢弃 models/activeModelId——重启后多模型配置内存丢失且任何 flush 会写回无条目文件；现完整保留。
- ✅ 设置拆页：'keys' → 'llm'（LLM 端点）+ 'image'（图像端点）两页；删 KeysPane，新建 LlmEndpointsPane/ImageEndpointsPane
  （自持状态、纵向卡片、StatusDot、删除确认、显式保存 busy 禁用、保存回写）；Modal 仅持 secrets 会话级状态；页切换 key 重挂动画。
- ✅ 无边框窗口（用户选定 ZCode 同构自绘按钮）：createWindow Windows `frame:false`（macOS titleBarStyle hidden）、backgroundColor #0c0c0c；
  新增 win:minimize/toggleMaximize/close/chromeState IPC + win:chromeChanged 推送（maximize/unmaximize）；
  新组件 WindowControls（三按钮 + receivedEvent 防迟到覆盖）；App 改纵向布局 + .titlebar（drag 区、品牌、右侧按钮）；
  Sidebar 品牌文字移除；中文菜单保留（Alt 呼出）。
- ✅ 暗色精修：令牌补全（字号/间距/阴影/z-index/动效 --dur-1/2/3 + --ease-out + --focus-ring/--disabled + --titlebar-h）；
  控件统一（按钮 active scale(.98)、disabled、status-dot、settings__link--danger、settings__select）；
  微动效（模态 fade+modal-in 180ms、设置页 pane-in、prefers-reduced-motion 全局降级）。
- 验证：全仓 typecheck/build 0 错误；181/181 测试（agent-service 65 含新增 r6-image-endpoints 6 测：JSON 解析/选择链/mock 强制）。
- 待真机：图像页保存→配 Key 后 mock 警告消失、多服务商切换、无边框拖拽/双击最大化/三按钮、动效流畅。

## R6-15（2026-09-28，上游错误前端重试（3 次上限）+ 图像端点 URL 去硬编码补全）

- ✅ 上游错误重试机制：useConversation 重构——运行机制抽为 startRun（发消息与重试共用：流式订阅/错误登记/分派接续）；
  失败统一走 failAttempt（错误信封/传输错误/请求失败/接续失败四路收敛）——告知用户 code+message，
  登记 failedRef（原请求+原文本+原选项+失败计数），消息附重试按钮「↻ 重试（第 X/3 次）」；
  手动重试原位重跑同一请求（新 requestId，清错误/思考/工具态）；**重试 3 次仍失败则终止**（按钮消失，附排查指引文案）。
  失败不再触发分派接续（顺带修复错误后仍接续的边角）。ChatPanel 新增 onRetry 渲染重试按钮；ChatMessage 增 retry 字段。
- ✅ 图像端点 URL 去硬编码补全：「添加图像端点」不再预填 baseUrl/model；保存校验 baseUrl 必须为完整地址
  （/^https?:\/\/.+/，含协议与版本路径），错误提示明确"系统不做自动补全，请自行填写完整"；占位文本同步改为指引。
- 验证：全仓 typecheck/build 0 错误；181/181 测试绿。
- 待真机：断网/错 Key 场景验证重试按钮出现→重试计数递增→3 次后终止文案；图像页空 URL 保存被拦截。

## R6-16（2026-09-28，图像端点完整 URL 直用（零拼接）——修复 /v1 重复致生成不可用）

- 排查结论（用户报告图像生成不可用，猜疑 URL 自动补全后缀）：用户配置 baseUrl=https://grsai.dakka.com.cn/v1/（带 /v1，正确），
  而 image-api.ts 拼接为 `${base}/v1/images/generations` → 实际请求 /v1/v1/… → 服务商 404（探测实证：重复路径 404、正确路径 400）。
  根源：P012 起"无条件补 /v1"假设与设置页"如 https://api.openai.com/v1"引导自相矛盾；此前保存 bug 掩盖了该缺陷，R6-14 修复保存后即爆。
- ✅ 零拼接重构（用户决策：不自动拼接，由用户填写完整 URL）：
  - OpenAiImageApi 入参改 generationsUrl（必填）/ editsUrl（选填），generate/edit **原样使用**；editsUrl 缺省时 edit 报"图像编辑端点未配置"明确错误。
  - 存储形态 imageModels[]: baseUrl → url/editUrl；旧 baseUrl 数据一次性迁移（去尾斜杠后追加 /images/generations|/images/edits，不加版本段）——
    用户现配 https://grsai.dakka.com.cn/v1/ 自动转为正确完整端点，无需重填。
  - 注入 AICH_IMAGE_MODELS 携 url/editUrl；agent-service config 解析（url/model/Key 必填、editUrl 可空）；
    resolveImagePort 多条目原样透传；旧单字段回退路径保持遗留契约（base→按原行为折算完整端点）。
  - 设置 → 图像端点：每条目「生成 URL（必填）+ 编辑 URL（选填，留空则编辑不可用）+ 模型 id + Key」，占位示例与校验（完整 http(s) URL）对齐。
- ✅ 测试更新：config 解析（url/editUrl/旧形态过滤）、resolveImagePort 选择链、新增 verbatim URL 直测
  （generate 请求 URL === 用户配置 URL，零追加）+ editsUrl 缺省报错测试；67/67，全仓 183/183。
- 验证：全仓 typecheck/build 0 错误。待真机：现有 yzagrs 条目迁移后直接生成成功。

## R6-17（2026-09-28，DeepSeek 思考参数官方对齐 + 删除无效参数 + 修思考档位冻结）

- 排查结论（用户要求确认思考参数能否生效）：**原实现完全未生效**——
  ① buildLlmModel 写死 reasoning:false，pi-ai 全部思考分支以此为前提 → options.reasoning 在 buildParams 被整体丢弃，
  且 clamp 把一切档位钳成 off（supported=["off"]）；② 即使开启，pi-ai deepseek 分支把 reasoning_effort 发在**顶层**，
  而官方要求位于 thinking 对象内（顶层为无效参数）。官方事实（api-docs.deepseek.com）：模型仅 deepseek-flash/deepseek-v4-pro；
  thinking.type=enabled|disabled（默认 enabled）；thinking.reasoning_effort∈none|low|high|max（默认 high；minimal→low、medium/xhigh→high）；
  思考模式 temperature 不生效；reasoning_tokens 可核对生效。
- ✅ model.ts：仅 DeepSeek 端点（baseUrl 含 deepseek.com）reasoning=true + thinkingLevelMap 官方映射
  （off→none/minimal→low/low→low/medium→high/high→high/xhigh→high/max→max）+ compat.supportsReasoningEffort=false
  （禁用顶层无效参数来源）；非 DeepSeek 端点维持 reasoning=false（不发送任何思考参数，行为不变）。
- ✅ 适配器：wrapStreamFn 注入 DeepSeek 请求体改写 fetch（rewriteDeepSeekThinkingFetch）——
  档位按映射迁入 thinking.reasoning_effort（官方形状），**删除顶层 reasoning_effort 无效参数**（兜底删除）；
  非字符串体/解析失败原样放行。
- ✅ 顺带修复思考档位冻结（R6-6 登记的遗留缺陷）：SessionAgent 增 thinkingSlot（可变槽位），
  streamFn 逐次调用时读取；run() 每次更新 slot（req.thinking ?? defaultThinking）——同会话后续请求的档位变更即时生效。
- ✅ 测试新增 8 个（r6-deepseek-thinking.test.ts）：模型构建两分支、官方映射、改写器（迁入+删除顶层、off 不注入、
  槽位逐次读取回归护栏、无思考字段/非 JSON 放行）；75/75，全仓 191/191。
- 验证：全仓 typecheck/build 0 错误。待真机：同一提问 off/high 各发一次，对比 usage.completion_tokens_details.reasoning_tokens
  （0 vs >0）确认端到端生效；思考开关 UI 与设置默认档联动正常。

## R6-18（2026-09-28，删除 minimal 思考档位）

- ✅ ThinkingLevel 类型收窄：off/low/medium/high/xhigh/max（shared/runtime.ts）。
- ✅ 同步删除：网关信封 thinking 白名单（http-server）、defaultThinking 白名单（agent-service main）、
  DeepSeek thinkingLevelMap 的 minimal 键、Composer ThinkingSelector 选项（组件保留）、LLM 端点页思考档下拉项。
- ✅ 存量归一：secretsService normalizeThinking（minimal→low）应用于 status 视图 / modelsForInjection / saveModels 读写三路径，
  旧配置无感迁移，DeepSeek 请求按 low 档生效。
- 验证：typecheck/build 0 错误；191/191 测试（r6-deepseek-thinking 断言 minimal 映射已不存在）。

## R6-19（2026-09-28，主动打断终止 + 图像响应"接受方式"根治）

- ✅ 主动打断：发送键在生成中变为「■ 停止」（hover 红）→ stop()：网关 cancel（activeRunRef 跟踪在途 requestId）
  + userCancelled 标记 → done/error 信封命中标记即中性终态"（已停止）"（保留已生成部分、运行中工具收敛为结束、
  不进错误/重试链）；主 run 与分派接续 run 均可打断；mock 网关同步支持。
- ✅ 图像生成失败排查（Loops 日志实证）：20:17 报 404（/v1 重复，R6-16 已修）；21:09 URL 已通但
  **"响应缺少 data[0]"×3**——中转服务（grsai.dakka.com.cn）返回体非标准 OpenAI 形状，用户猜测"接受方式不明确"成立。
  另发现 image-registry 仅接受 dataURL 产物——中转若回 http URL 也会在落盘时失败。
- ✅ 图像响应解析根治（image-api.ts）：
  - 宽松提取 findImageRef：OpenAI 标准（data[0].b64_json/url）+ 常见中转形状（顶层 url/image_url/image/images/result/output/
    裸 base64/dataURL；data 可为对象非数组）；
  - http URL 结果自动下载转 dataURL（≤20MB，补 ImageRegistry dataURL 契约）；
  - 异步任务探测轮询（P012 登记边界落地）：task_id/taskId/job_id → GET {generationsUrl}/{taskId} 2s 间隔轮询
    （404/405 快速失败并报出探测到的响应体；failed 状态明确报错）；
  - 错误透明化：解析全落空时错误消息携带响应体前 400 字符——下次再遇到未知形状，Loops 日志/界面可直接看到真实报文。
- ✅ 测试新增 10 个（r6-image-response.test.ts）：五种中转形状、dataURL 直传、任务轮询全流程、任务失败态、
  错误摘录、edit 同路径；85/85，全仓 199/199。
- 验证：typecheck/build 0 错误。待真机：重试图像生成，若仍失败，错误消息将显示服务商真实响应体（据此精确适配）。

## R6-19 补充（同日，工具回传解析修复——grsai 实测形状）

- Loops 日志拿到真实报文：服务商**已成功出图**，响应为 `{id, status:"succeeded", results:[{url:…}], progress:100}`
  ——提取键清单有 `result` 无 `results`（复数），一字之差解析落空（即用户所见"工具的回传解析出错"）。
- ✅ 提取键清单补 `results`/`outputs`；新增回归测试行（grsai 实测形状）。
- ✅ 安全加固：结果图常托管在第三方文件域——结果下载仅在与生成端点同 host 时携带 API Key（防凭据外泄）。
- 验证：typecheck/build 0 错误；86/86（agent-service）。

## R6-19 补充 2（2026-09-29，聊天框拖拽上传 + 剪贴板粘贴上传）

- 需求：用户当前无法上传图片，需要「直接拖拽到聊天框」与「剪贴板粘贴（截图 Ctrl+V）」两个上传入口
  （既有「＋ 添加附件」文件选择链路保留，三者共用 ingestFiles 管线：图片→dataURL→/v1/images 注册→参考图/多模态分析 id）。
- ✅ ChatPanel：
  - 拖拽落点为**整个聊天面板**（work/idle 两形态），悬停时 composer 高亮（is-dragover，accent 描边+底色）；
    dragenter/leave 计数器防子元素抖动，仅 dataTransfer 含 Files 时接管；
  - **全局 dragover/drop preventDefault**——Electron 默认会把拖入文件当页面导航打开（整页被替换），必须先拦截；
  - textarea onPaste：剪贴板含文件（截图/复制的图片/资源管理器文件）→ preventDefault 走附件管线；纯文本走默认粘贴；
  - 附件处理错误（超限/注册失败）在 composer 顶部显示可关闭错误行（ingest-error）；
  - streaming 中拖拽/粘贴忽略（全局拦截仍生效，不导航）。
- ✅ 用户气泡内嵌附件图片预览：ChatMessage.images（dataURL）+ chat-msg__imgs 缩略图样式；仅含图无文字时气泡不渲染空段落。
- 验证：typecheck/build 0 错误；app 包 33/33。真机待验：拖拽高亮与落图、截图 Ctrl+V、发送后气泡缩略图、
  未配网关时 chip 显示"未注册"（mock/降级路径既有行为）。
