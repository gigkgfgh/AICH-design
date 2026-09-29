# 开发计划 PLAN-20260812-AICH-Design-R2

> 版本：v0.1（执行轮 R2）　|　创建：2026-08-12　|　作者：planner（指挥模式 /auto）
> 关联总计划：`docs/plans/PLAN-20260812-AICH-Design开发计划.md`（v0.1，P001-P024 全周期）
> 来源：AICH 设计文档 v0.2 §6（图像 Extension 技术契约/B-3/B-4）+ 总计划 v0.1；本计划为 **R2（M2 图像轮）** 的细化与契约冻结，是 reviewer 核对「实现是否符合计划」的依据
> 代码落点：`aichitect Design/`（本项目根）；计划 `docs/plans/`、交接 `.handoffs/` 均位于本目录

## 1. 背景与目标

- 需求来源：设计文档 v0.2 §6（图像 Extension 技术契约："### 6.1 工具契约 / 6.2 gpt-image-2 适配要点 / 6.3 平面→表现图联动（B-3） / 6.4 图像版本管理（B-4）"）；总计划 v0.1 P011-P014；R1 实机联调已闭环（R1 计划 §2「不做」项中 P011 待联调决定启用——**联调完成，决定启用**）
- **本轮（R2）目标**：跑通 **M2 图像 Extension 核心能力**（总计划 P011/P012/P013/P014），出口验收标准：「对话 → 方案 SVG → 表现图 → 回退」**全闭环，离线可用**（总计划 §5 Phase 2 后段 M2）
  - P011 严格 json_schema 输出模式（联调决定启用）
  - P012 image-tools extension（image_generate / image_edit + gpt-image-2 适配 + 独立图像端口配置）
  - P013 ImageGallery + 图像版本树（prompt / 父版本 / 费用展示）
  - P014 B-3 联动：SVG→PNG 栅格化
- 验收口径（可量化）：
  - backend：image_generate / image_edit 工具按 §6.1 契约实现；独立图像端口 `AICH_IMAGE_BASE_URL` 可配（§6.2 合规端点）；mock 图像全链路（无 Key 离线可用）；SSE image 载荷按设计文档 §5.4 `{kind:'image', imageId, url, meta:ImageMeta}` 冻结文本；P011 严格模式开启后校验失败率有对比记录
  - frontend：ImageGallery（渲染图像、费用展示）+ 图像版本树（回退）；SVG→PNG 栅格化真实可用（Electron 渲染进程 / 浏览器直开）
  - 语法自测：`npm.cmd` 可用（ENVIRONMENT.md 已更新），typecheck / vitest / build 尽量跑通，失败按铁律 8 记录降级
  - **最终实机验证由主 Agent/用户执行**（ENVIRONMENT.md 验证职责归属）

## 2. 范围界定

- **做（R2）**：
  - P011 严格 json_schema 输出模式（backend）：validatePlan 严格档（拒绝宽容缺省）+ agent-service 校验失败率对比记录
  - P012 image-tools extension（backend）：image_generate / image_edit 工具、gpt-image-2 适配（§6.2 约束）、独立图像端口配置、MockImageProvider 离线图像 mock、SEssion 图像版本元数据注册
  - P013 ImageGallery + 图像版本树（frontend，依赖 P012 契约，mock 先行）
  - P014 SVG→PNG 栅格化（**归属调整**：设计 §5.5「渲染进程用 canvas/sharp」→ 执行环境定为 Electron 渲染进程 Chromium canvas，属 frontend 落点，理由见 §4 决策）
- **不做（R2，留后续轮）**：P015 sandbox-launcher、P016 KeyStore、P017 SQLite 实装（B-4 图像版本树本轮用会话内元数据 + jsonl 顶替）、P018 队列、P019 Session/Context、P020-P024——总计划已编号，留 R3+；gpt-image-2 真实 API 联调（无 Key/网络受限）为**预留联调点**，不阻塞交付

## 3. 技术选型及理由（R2 落定点）

| 决策点 | 选择 | 理由 | 备选 |
|---|---|---|---|
| 图像接入端口 | OpenAI Image API（POST /v1/images/generations、/v1/images/edits multipart），§6.1/§6.2 | 设计 v0.2 冻结；Responses API image_generation 为 B-2 增强升级路径 | Responses API（否决，v1 不引入） |
| 图像端口配置 | `AICH_IMAGE_BASE_URL`（默认 OpenAI）+ `AICH_IMAGE_API_KEY` 独立于 LLM 配置 | §6.2 合规：可指向任意 OpenAI 兼容端点（国内合规切换） | 固定 OpenAI（否决） |
| 图像模型约束 | gpt-image-2：无透明背景、input_fidelity 省略、尺寸 16 倍数≤3840、宽高比<3:1、像素 655,360–8,294,400、size 预设 1024x1024/1024x1536/1536x1024/2048x2048；输出 png/jpeg/webp；edits 入参 image≤16 张 png/webp/jpg 单张<50MB、mask 同尺寸 alpha PNG | §6.2 适配要点原文 | gpt-image-1.5 双模型路径（透明背景需求出现时再建） |
| 无 Key/离线策略 | MockImageProvider（确定性 PNG/费用 mock），AICH_ADAPTER 决策链同构（auto→mock 降级） | M2 出口「离线可用」；frontend 并行演示不依赖网络 | 无（否决，全链路必演示） |
| SVG→PNG | Electron 渲染进程 Chromium canvas 2D（drawImage SVG blob → toDataURL） | 零新依赖（Electron v31 已实机可用）；浏览器直开亦可用；回避 sharp/Canvas 包 native ABI 风险（npm 源受限） | sharp（否决：native，安装风险）；主进程离屏窗口（否决：更重） |
| 图像版本树（B-4） | 会话内元数据注册表 + images/ 目录落盘；SQLite 由 P017 承接 | P017 未落地，版本树本轮满足演示与回退；字段与 ImageMeta 冻结契约一致 | SQLite（P017 后无缝迁移） |
| mock 流 | mock-provider 扩展 createMockImageStream（pi 事件流协议同构：start → text_*/toolcall_* → done|error） | R1 P006 摸查已确立协议；图像 mock 复用同一语义 | 独立协议（否决） |

## 4. 任务拆解（R2）

> task-id 沿用总计划编号；共享文件（根 package.json、tsconfig.base.json、shared/mock-provider/extensions/agent-service 包内文件）**backend 单写**；frontend 只写 `packages/app/**`（铁律 4）。

| ID | 任务 | 所属角色 | 依赖 | 验收标准 | 评估量 |
|---|---|---|---|---|---|
| P011 | 严格 json_schema 输出模式：validatePlan 增严格档（缺省字段/宽容修正一律报错，仅 schemaVersion 缺省按 1 兼容的问题关闭）；agent-service 侧 AICH_STRICT_JSON=1（默认开）下发严格档，宽容降级保留并计数；启动/交接记录「校验失败率对比」基线 | backend | P008, R1 契约 | 严格档 vitest 用例（宽容用例反转为拒绝）；失败率对比记录落盘（README 或交接） | 0.5-1d |
| P012 | image-tools extension：① 工具契约（image_generate: prompt,size?,quality?,outputFormat?,n?；image_edit: images[](参考图),prompt,mask?,inputFidelity?,size?,quality?,n?，§6.1 表）；② gpt-image-2 适配层（§6.2 全部约束内建校验：透明拒绝/尺寸/像素/W×H 比/multipart）；③ 独立图像端口（AICH_IMAGE_BASE_URL/AICH_IMAGE_API_KEY，默认 OpenAI，可配兼容端点）；④ MockImageProvider（确定性 PNG dataURL + mock cost）；⑤ ImageApiPort 抽象（真实 http 与 mock 可替换，PiAgentCoreAdapter 工具绑定注册 2 工具）；⑥ B-4 会话图像元数据注册表（imageId/prompt/模型/费用/父版本与参考图，落 images/ + 会话 jsonl）；⑦ SSE done 载荷 image 分支 {kind:'image', imageId, url, meta:ImageMeta}（设计 §5.4/387 行冻结） | backend | P011, P005 契约 | mock 图像全链路（generate/edit→落盘→done 载荷）vitest/冒烟；端口配置生效（改 AICH_IMAGE_BASE_URL 走模拟端点）；§6.2 约束校验用例 | 3d |
| P013 | ImageGallery + 图像版本树：渲染层卡片流（图像/dataURL 显示、prompt/模型/费用展示）；done.image 入版本树（父版本=当前 plan 版本）；回退/重选；加载/空/错误态；P012 契约未就绪时 mock 先行（图像 mock 注 `// TODO-API-STUB`） | frontend | P012 契约（mock 先行） | mock 直连「方案→表现图→回退」演示；费用展示有契约依据 | 2-3d |
| P014 | SVG→PNG 栅格化：纯函数核心 svgToPngDataUrl(svg, {scale})（canvas 注入式，可测）+ 渲染层接入（导出 PNG/复制）；与 P012 参考图联动预留（image_edit images[] 由主进程透传 URI） | frontend | P010, §5.5 | Electron/浏览器实机导出 PNG 成功（实机目检由主 Agent）；核心逻辑 vitest（canvas mock） | 1d |

## 5. 里程碑与顺序建议

- **R2-A（backend 单线）**：P011（严格档）→ P012（image-tools，依赖 P005 冻结契约 + P011）
- **R2-B（frontend 单线，可并行）**：P014（canvas 原生，零依赖先行）→ P013（ImageGallery，mock 先行；P012 契约以交接文档「依赖信息」冻结文本为准，未就绪用 `// TODO-API-STUB` 本地存根）
- **R2-C（审查闭环）**：R2-REV；P0/P1 按归属回退对应窗口（原 task_id resume），复审通过后双方回执归档
- 关键路径：P012 契约 → P013；P014 独立可并行；整体无网络/Key 依赖（MockImageProvider 兜底）

## 6. 风险与假设清单

| 级别 | 风险/假设 | 应对 |
|---|---|---|
| 高 | gpt-image-2 真实 API 无法联调（无 Key/网络受限，P003 Spike 未跑） | 按 §6.2 适配要点实现约束校验 + 独立端口可配；mock 兜底全链路；联调点登记（README「已知边界」），Key 就绪后仅换 ImageApiPort 真实实现 |
| 中 | P014 canvas 在 vitest 无 DOM | 纯函数核心 + canvas 注入参数化，测试传 mock canvas；实机验证（Electron/浏览器）由主 Agent 执行 |
| 中 | 共享文件并发（shared/extensions 包） | backend 单写 shared/*/extensions/*；frontend 仅 packages/app/**；改动前核对交接「编辑归属」 |
| 中 | 图像版本树本轮无 SQLite（P017 未落地） | 会话 jsonl + images/ 落盘顶替，元数据字段与 ImageMeta 对齐，P017 迁移路径预留 |
| 低 | mock-provider 新增 createMockImageStream 与 pi 事件流协议耦合 | 复用 R1 已冻结协议（摸查表），改动局限 mock-provider 包内 |
| 假设 | npm.cmd / 构建链 / Electron 已实机可用（ENVIRONMENT.md 2026-08-12 快照） | frontend 本轮可实机 build；仍以交接「已完成工作」如实标注验证结果 |
| 假设 | 本轮交付为代码+契约，最终目检（图像卡片显示、PNG 导出、费用展示样式）由主 Agent/用户执行 | 交接文档如实注明；交付信号=实现+自测（或降级）记录 |

## 7. R2 契约冻结（写入双方交接文档「依赖信息」）

1. **图像工具契约**（§6.1 冻结，P012 落盘 extensions/plan-tools 同构 ToolDef）：
   - `image_generate`：`{ prompt: string, size?: "1024x1024"|"1024x1536"|"1536x1024"|"2048x2048", quality?: "low"|"medium"|"high", outputFormat?: "png"|"jpeg"|"webp", n?: number }` → OpenAI `POST {AICH_IMAGE_BASE_URL}/v1/images/generations`
   - `image_edit`：`{ images: string[]（参考图 URI）, prompt: string, mask?, inputFidelity?, size?, quality?, n? }` → `POST {AICH_IMAGE_BASE_URL}/v1/images/edits`（multipart/form-data，image≤16 张 png/webp/jpg 单张<50MB，mask 同尺寸 alpha PNG）
   - 约束内建（§6.2）：拒绝透明度请求；省略 input_fidelity；尺寸校验（16 倍数、≤3840、宽高比<3:1、像素 655,360–8,294,400）
2. **图像响应/落盘**（设计 §5.4/6.4 冻结）：
   - SSE `done` 载荷 image 分支：`{ kind:'image', imageId: string, url: string（本地 file:// 或 dataURL）, meta: ImageMeta }`；ImageMeta 复用 shared 冻结结构（prompt/model/provider/costMs 等 + 索引签名）
   - 落盘：`<sessions>相关 images/ 目录`（P017 前会话 jsonl 记录元数据，含 parentImageId/refPlanVersionId）
3. **独立图像端口**：`AICH_IMAGE_BASE_URL`（默认 OpenAI API）与 `AICH_IMAGE_API_KEY` 独立于 LLM 配置；`AICH_IMAGE_MOCK=1` 或 Key 缺失自动 MockImageProvider（与 AICH_ADAPTER 降级链同构）
4. **P011 开关**：`AICH_STRICT_JSON=1`（默认开启）→ validatePlan 严格档；关闭回到 R1 宽容档
5. **P014**：`svgToPngDataUrl(svg: string, opts?: { scale?: number; background?: string }): Promise<string>`（PNG dataURL），执行环境=渲染进程 canvas（浏览器直开兼容）；参考图供 P012 image_edit 消费的 URI 透传由主进程完成