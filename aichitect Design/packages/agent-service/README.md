# agent-service

AICH Design Agent Service（P006）——独立 Node 进程：内核运行时（pi-agent-core 0.84.x 适配 / MockAdapter 兜底）+ 本地网关（HTTP/SSE 127.0.0.1 随机端口 + Bearer token）+ 会话 jsonl + usage/cost 埋点。

## API 摸查记录（pi-agent-core 0.84.1，P001 继承）

> 摸查源：`pi-agent/npm-packages/pi-agent-core-0.84.1-src/package/dist/*.d.ts` 与
> `pi-agent/pi-main/packages/agent/src/*.ts`（版本锁定 0.84.1，API 以实际导出为准）。

| 导出 | 签名要点（摸查结论，注释于 adapter 实现） |
|---|---|
| `Agent` | `new Agent({ initialState: { systemPrompt, model, tools }, streamFn, getApiKey, ... })`；`prompt(text)`；`subscribe(listener: (event: AgentEvent, signal) => void)`；`state.messages/errorMessage/isStreaming` |
| `AgentEvent` | `agent_start / agent_end{messages} / turn_start / turn_end{message, toolResults} / message_start / message_update{assistantMessageEvent} / message_end / tool_execution_start / tool_execution_update / tool_execution_end{result, isError}` |
| `agentLoop` / `agentLoopContinue` / `runAgentLoop` | 低层 loop；本产品使用有状态 `Agent`（P006）；低层 API 供未来自研 Loop 参考 |
| `streamProxy(model, context, { proxyUrl, authToken })` | 推理代理注入路径（P016 启用；POST `${proxyUrl}/api/stream`，`Authorization: Bearer`） |
| `AgentTool` | TypeBox `TSchema` 参数 + `execute(toolCallId, params, signal, onUpdate)`；`beforeToolCall/afterToolCall` 钩子 |
| `StreamFn` | `(model, context, options?) => AssistantMessageEventStream`；失败必须编码进流（stopReason "error"/"aborted"），不得 throw |
| pi-ai `Model` | `{ id, name, api, provider, baseUrl, reasoning, input, output, cost, contextWindow, maxTokens }`；`cost` 供成本埋点 |
| `Usage` | `{ input, output, cacheRead, cacheWrite, totalTokens, cost{...total} }` |
| `AssistantMessageEventStream` | `createAssistantMessageEventStream()` 构造；`push(event)` + `end(result)`；事件协议 `start → text_*/toolcall_* → done|error` |
| `AssistantMessage` | `{ role, content, api, provider, model, usage, stopReason, timestamp, errorMessage? }`；stopReason ∈ `pending|stop|length|toolUse|error|aborted|deferred` |

## 运行

```bash
npm install                 # 安装 workspace + @earendil-works/pi-agent-core@0.84.1 / pi-ai@0.84.1（需网络）
npm run build -w @aichdesign/agent-service
npm run start -w @aichdesign/agent-service   # 或 node packages/agent-service/dist/main.js
```

环境变量：

| 变量 | 默认 | 说明 |
|---|---|---|
| `AICH_ADAPTER` | `auto` | `auto`（优先 pi，失败降级 mock）/ `pi`（缺失则 fail-closed）/ `mock` |
| `AICH_PORT` | `0` | 随机端口（修订①） |
| `AICH_TOKEN` | 自动生成 | Bearer token；就绪行 AICH_GATEWAY_READY 输出 |
| `AICH_SESSIONS_DIR` | `.data/sessions` | 会话 jsonl 目录（修订②：agent-service 仅直写这里）；图像落盘在 `<dir>/images/`（ImageRegistry，路径随本目录派生） |
| `AICH_MOCK_DELAY_MS` | `30` | mock 流式延迟 |
| `AICH_PROVIDER=openai-compatible` | 缺省 mock | 真实 LLM 链路（密钥注入归 P016，此处仅为配置骨架） |
| `AICH_STRICT_JSON` | `1` | P011 严格 json_schema 输出模式：`1` 开启（validate_plan 走严格档）；`0` 关闭回 R1 宽容档；两档始终双跑计数（见「P011 校验失败率对比」） |
| `AICH_IMAGE_BASE_URL` | `https://api.openai.com/v1` | P012 图像端口 baseURL（§6.2 可指向任意 OpenAI 兼容端点，国内合规切换） |
| `AICH_IMAGE_API_KEY` | 无 | 图像 API Key（独立于 LLM 配置）；缺失自动降级 MockImageProvider |
| `AICH_IMAGE_MOCK` | `0` | `1` 强制走 MockImageProvider（离线演示，与 Key 缺失降级同效） |
| `AICH_IMAGE_MODEL` | `gpt-image-2` | 图像模型 id（§6.2；ImageMeta.model 按实际值登记） |

就绪协议（主进程 spawn 解析 stdout 首行）：

```
AICH_GATEWAY_READY {"url":"http://127.0.0.1:PORT","token":"...","adapter":"pi-agent-core|mock","image":"openai-image|mock-image","pid":...}
```

## 网关端点（契约，变更必须落盘 .handoffs/「依赖信息」）

```bash
# 运行（幂等键 requestId）
curl -X POST http://127.0.0.1:PORT/v1/run -H "Authorization: Bearer $TOKEN" \
  -H "content-type: application/json" \
  -d '{"requestId":"r-1","sessionId":"s-1","request":{"kind":"draftPlan","sessionId":"s-1","prompt":"帮我设计两室一厅","variants":1}}'
# → 202 {"requestId":"r-1","sessionId":"s-1","status":"running","streamUrl":"/v1/stream/r-1"}

# 流式（SSE）
curl -N http://127.0.0.1:PORT/v1/stream/r-1 -H "Authorization: Bearer $TOKEN"
# → 文本链路：event: delta / event: done（data=信封 {requestId, sessionId, type, data}）
# → 图像链路（genImage/editImage）：event: delta → event: progress(phase=image_generate|image_edit, percent 递增) → event: done

# 图像生成（P012；SSE done 载荷 {kind:'image', imageId, url(file://), meta}）
curl -X POST http://127.0.0.1:PORT/v1/run -H "Authorization: Bearer $TOKEN" \
  -H "content-type: application/json" \
  -d '{"requestId":"r-img-1","sessionId":"s-1","request":{"kind":"genImage","sessionId":"s-1","prompt":"两室一厅客厅表现图"}}'

# 图像编辑（imageId 须为会话内已注册图像；images[] 经 ImageRegistry 解析为 file:// URL）
curl -X POST http://127.0.0.1:PORT/v1/run -H "Authorization: Bearer $TOKEN" \
  -H "content-type: application/json" \
  -d '{"requestId":"r-img-2","sessionId":"s-1","request":{"kind":"editImage","sessionId":"s-1","prompt":"改成暖色调","imageId":"img_xxx"}}'

# 取消
curl -X POST http://127.0.0.1:PORT/v1/cancel -H "Authorization: Bearer $TOKEN" \
  -H "content-type: application/json" -d '{"requestId":"r-1"}'

# 健康 / 指标
curl http://127.0.0.1:PORT/v1/health -H "Authorization: Bearer $TOKEN"
curl http://127.0.0.1:PORT/v1/metrics -H "Authorization: Bearer $TOKEN"
```

统一错误响应：`{ "code": "INVALID_REQUEST|UNAUTHORIZED|...", "message": "...", "data": ... }`。

**错误码唯一权威（R001 登记，2026-08-12 R1-REV 裁决）：** 错误码表以 `packages/shared/src/errors.ts` 的 10 码为全产品唯一权威（HTTP 映射以 `httpStatusFor()` 为准）；早期 7 码草案（ERR_AUTH/ERR_INVALID/ERR_NOT_FOUND/ERR_CONFLICT/ERR_CANCELLED/ERR_RUNNER/ERR_INTERNAL）作废不落地。前端 `toHttpError` 须对齐本表，禁止散用字面量；SSE 错误信封 `code` 字段亦取本表值（R011 已通知 frontend）。

## 自测

```bash
npm run test -w @aichdesign/agent-service     # vitest（含 P012 图像链路单测）+ smoke
node packages/agent-service/test/server.js    # 依赖自检（[OK]/[MISS]）
node packages/agent-service/test/server.js --smoke   # 自检 + 构建产物启动冒烟（15s 超时自动关闭）
# 冒烟内容：health 200 → genImage 全链路（POST /v1/run → SSE done(image)，url 为 file://）
```

## P011 校验失败率对比（基线口径）

`validate_plan` 工具每次执行**同时运行宽容档与严格档**并计数（`ValidationStats`，进程内存）：

| 计数器 | 口径 |
|---|---|
| `total` | validate_plan 工具执行次数（含宽容/严格双跑，无论 `AICH_STRICT_JSON` 开关） |
| `lenientFailures` | 宽容档 `valid=false` 次数（结构/枚举/悬垂引用错误） |
| `strictFailures` | 仅 `AICH_STRICT_JSON=1` 时累加：严格档 `valid=false` 次数（宽容可能通过而严格拒绝——缺 schemaVersion / areaM2 / thicknessMm / 越界） |

- 严格失败时打日志（stderr）：`[validate-strict] 严格档校验失败 total=… 宽容失败=… 严格失败=…：<前 3 条错误>`；
- 对比意义：`strictFailures - lenientFailures` 即「宽容放过但严格拦截」的差集（P011 的拦截价值）；
- 计数为进程内存态（重启归零），落盘/聚合归 P023 指标管线；实际生效档由 `AICH_STRICT_JSON` 决定（默认开启）。

## 图像链路（P012，§6.1/§6.2/§6.4）

- 工具绑定：`image_generate` / `image_edit`（extensions image-tools 约束校验 → ImageApiPort 执行 → ImageRegistry 落盘 → SSE done(image)）；
- **progress（R2-REV P1 修复）**：图像工具执行期间发 `progress`（`SseProgressData`，shared contracts.ts 冻结：`phase: "image_generate" | "image_edit"`，percent 递增，message 中文，done 前必发）。mock 路径在工具执行前后发 30% → 80% 两档；pi 路径内核事件流无 phase 语义，在 `tool_execution_end` 图像工具完成节点补发 100% 档（与 mock 语义对齐，done 前必发）；
- ImageApiPort：真实 `OpenAiImageApi`（`POST {base}/v1/images/generations` JSON；`POST {base}/v1/images/edits` multipart）与 `MockImageProvider`（确定性 PNG dataURL + mock cost，`AICH_IMAGE_MOCK=1` 或 Key 缺失自动降级，与 AICH_ADAPTER 降级链同构）；
- B-4 落盘：图像写 `<sessionsDir>/images/<imageId>.png`，元数据（imageId/prompt/model/provider/cost/父版本/参考图）随会话 jsonl（kind=`image`）同步追加；`done` 载荷 `{ kind:'image', imageId, url(file://), meta }` 与 shared contracts.ts 冻结文本一致；
- mock 编辑（MockImageProvider.edit）不真正读取参考图/遮罩，按 prompt+size 生成确定性变体图（离线演示）。

## 已知边界（M1 + R2）

- **progress 覆盖（R2-REV P1 修复登记）**：图像链路（genImage/editImage）已发 `progress`（phase=image_generate/image_edit）；**文本链路（draftPlan/editPlan/其他 stream）暂不发 progress**——契约 `SseProgressData.phase` 的 `"llm"` 为可选心跳（"LLM 文本阶段可发 { phase: "llm" } 心跳"，shared contracts.ts L155 冻结文本），R2 起按需启用，不影响契约兼容；
- **n>1 仅返回首张（G1 登记，R2-REV）**：契约声明 `n` 1-10，但本轮 generate/edit 真实链路与 mock 均只消费 `data[0]`（`ImageApiResult` 单图形状）；多图批量（如 n=4 出 4 张比选）留待请求层/SSE 载荷扩展（done image 载荷单 imageId），启用前维持单图语义；
- **listVersions（R009 登记）：R1 阶段不返回列表**——`AgentResponse` 冻结文本无 list 类型，方案版本树由主进程/UI 会话内维护（会话 jsonl 中 `assistant` 条目的 `versionId` 为可枚举依据），P019 后按需回归；mock 与 pi 路径对该 kind 均返回明确提示文案而非误导回复（`mock-provider/src/replies.ts` buildMockReply 显式分支 / `adapters/common.ts` promptOf 注释）；
- **gpt-image-2 真实 API 未联调（无 Key/网络受限）**：OpenAiImageApi 按 §6.2 要点实现待联调。联调参数表：
  - `POST {base}/v1/images/generations` body：`{ model: gpt-image-2, prompt, n, size, quality, output_format }`；响应优先 `data[].b64_json`，缺省回退 `data[].url`（`response_format` 与 `output_format` 是否互斥待实机核对）；
  - `POST {base}/v1/images/edits` multipart：字段 `image`（每参考图同名多值）+ `mask`（PNG）+ `model/prompt/n/size/quality/output_format`；文件 Blob 由 dataURL/本地 URI 转换；
  - Key 就绪后仅需验证 OpenAiImageApi 两方法（其余链路 mock 已闭环）；组织验证（§6.2）为真实计费前提。
- **refPlanVersionId 透传为空**：B-4 元数据 `parentVersionId`（ImageMeta）与请求层 `AgentRequest.genImage` 无 plan 版本透传通道（契约冻结），本轮为空并登记；P019/请求层扩展时补；
- mask 同尺寸/alpha 校验：dataURL 可本地探测（纯函数 IHDR），外部 URI 无法探测时降级 warning（README 注明交由上游校验）；
- 会话级 `Agent` 为内存态（P019 rehydration 补持久化恢复）；
- 在途 SSE 支持单消费者（重连回放仅终态可用；P007 前端单连接消费可满足）；
- 每会话一次性 token 轮换归 P016（当前为进程级 token）；
- 真实 LLM provider 配置骨架已预留（P016 启用）；图像 provider 已启用（P012）；
- RunManager 终态缓存：TTL 10 分钟 + 上限 100 条（R014 清理钩子，P023 阶段正式落地指标/持久化）。