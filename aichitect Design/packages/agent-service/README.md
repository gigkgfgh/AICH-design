# agent-service

AICH Design Agent Service（P006）——独立 Node 进程：内核运行时（pi-agent-core 0.84.x 适配）+ 本地网关（HTTP/SSE 127.0.0.1 随机端口 + Bearer token）+ 会话 jsonl + usage/cost 埋点。

端点未配置时**服务照常启动并就绪**，仅对应能力的请求返回明确错误（分项报错，互不影响）：

- LLM 端点未配置 → 对话/调研请求报 `PROVIDER_UNAVAILABLE`（附配置引导），图像功能不受影响；
- 图像端点未配置 → 出图/编辑请求报明确错误，对话功能不受影响。

就绪行的 `adapter` / `image` 字段即当前生效模式：`pi-agent-core@0.84.x` | `unconfigured`；`openai-image[:<model>]` | `unconfigured-image`。

## 运行

```bash
npm install                       # 安装 workspace + @earendil-works/pi-agent-core@0.84.1 / pi-ai@0.84.1（需网络）
                                   # postinstall 会按拓扑构建各包 dist；--ignore-scripts 时需手动 npm run build
npm run start -w @aichdesign/agent-service   # 或 node packages/agent-service/dist/main.js
```

环境变量（真实端点密钥由桌面端「设置」经主进程 SecretsService 注入，此处为直接运行的骨架）：

| 变量 | 默认 | 说明 |
|---|---|---|
| `AICH_PORT` | `0` | 随机端口 |
| `AICH_TOKEN` | 自动生成 | Bearer token；就绪行 `AICH_GATEWAY_READY` 输出 |
| `AICH_SESSIONS_DIR` | `.data/sessions` | 会话 jsonl 目录；图像落盘在 `<dir>/images/`（ImageRegistry，路径随本目录派生） |
| `AICH_PROVIDER` | 无 | 置 `openai-compatible` 启用旧单模型 LLM 链路（多模型条目优先，见下） |
| `AICH_LLM_BASE_URL` / `AICH_LLM_API_KEY_REF` / `AICH_LLM_MODEL` | 无 | 旧单模型 LLM 端点三要素；缺失则该链路不生效 |
| `AICH_LLM_MODELS` | 无 | 多模型条目 JSON：`[{id,name,baseUrl,model,apiKey,thinking,imageInput,contextWindow}]`（字段齐备才收，坏 JSON 静默为空） |
| `AICH_LLM_ACTIVE_ID` | 空 | 激活条目 id |
| `AICH_IMAGE_MODELS` | 无 | 多图像条目 JSON：`[{id,name,url,editUrl,model,apiKey}]`；`url`/`editUrl` 均为**完整端点地址**，原样使用不做拼接 |
| `AICH_IMAGE_ACTIVE_ID` | 空 | 激活图像条目 id |
| `AICH_IMAGE_BASE_URL` | `https://api.openai.com/v1` | 旧单字段图像 baseURL（无多条目时的兼容回退） |
| `AICH_IMAGE_API_KEY` | 无 | 旧单字段图像 Key |
| `AICH_IMAGE_MODEL` | `gpt-image-2` | 图像模型 id（ImageMeta.model 按实际值登记） |
| `AICH_RUN_MAX_RETRIES` | `2` | 启动级瞬态失败重试次数（不含首次） |
| `AICH_RUN_RETRY_BASE_MS` | `500` | 退避基数（倍增 500→1000） |
| `AICH_IMAGE_COST_LIMIT_USD` | `0.5` | 单会话图像成本护栏上限；≤0 关闭 |
| `AICH_SEARCH_PROVIDER` | `disabled` | `disabled` / `searxng` / `duckduckgo` / `deepseek` |
| `AICH_SEARCH_BASE_URL` | 空 | SearXNG 搜索端点（含 `/search`） |
| `AICH_SEARCH_DEEPSEEK_BASE_URL` / `_MODEL` / `_KEY` | `https://api.deepseek.com` / `deepseek-chat` / 空 | DeepSeek 官方服务端联网（Responses API） |
| `AICH_SKILLS_DIR` | 空 | 外部技能目录（`<dir>/<name>/SKILL.md`）；空 = 不加载 |
| `AICH_BUILTIN_SKILLS_DIR` | 空 | 内置技能目录（产品自带 SKILL.md） |
| `AICH_LOOP_LOG` | `0` | `1` 开启 Agent Loops 上下文日志 |
| `AICH_AGENT_MAX_TOOL_CALLS` | `25` | 单次运行工具调用轮次上限（钳位 1~200） |

就绪协议（主进程 spawn 解析 stdout 首行）：

```
AICH_GATEWAY_READY {"url":"http://127.0.0.1:PORT","token":"...","adapter":"pi-agent-core@0.84.x|unconfigured","image":"openai-image|unconfigured-image","pid":...}
```

## 网关端点

```bash
# 授权（进程级 token 换取会话级 token）
curl -X POST http://127.0.0.1:PORT/v1/authorize -H "Authorization: Bearer $PROC_TOKEN" \
  -H "content-type": "application/json" -d '{"sessionId":"s-1"}'

# 运行（幂等键 requestId；request.kind ∈ chat | genImage | editImage | research）
curl -X POST http://127.0.0.1:PORT/v1/run -H "Authorization: Bearer $TOKEN" \
  -H "content-type: application/json" \
  -d '{"requestId":"r-1","sessionId":"s-1","request":{"kind":"chat","sessionId":"s-1","prompt":"两室一厅怎么布局"}}'
# → 202 {"requestId":"r-1","sessionId":"s-1","status":"running","streamUrl":"/v1/stream/r-1"}
# → 幂等重放（requestId 已存在）返回 200 同形，/v1/stream 可回放终态

# 流式（SSE；信封 {requestId, sessionId, type, data}）
curl -N http://127.0.0.1:PORT/v1/stream/r-1 -H "Authorization: Bearer $TOKEN"
# → 文本链路：event: delta → event: done（data=AgentResponse）
# → 图像链路（genImage/editImage）：event: delta → event: progress(phase=image_generate|image_edit, percent 递增) → event: done

# 图像生成（done 载荷 {kind:'image', imageId, url(file://), meta}）
curl -X POST http://127.0.0.1:PORT/v1/run -H "Authorization: Bearer $TOKEN" \
  -H "content-type: application/json" \
  -d '{"requestId":"r-img-1","sessionId":"s-1","request":{"kind":"genImage","sessionId":"s-1","prompt":"两室一厅客厅表现图"}}'

# 图像编辑（imageId 须为会话内已注册图像；参考图经 ImageRegistry 解析为 file:// URL）
curl -X POST http://127.0.0.1:PORT/v1/run -H "Authorization: Bearer $TOKEN" \
  -H "content-type: application/json" \
  -d '{"requestId":"r-img-2","sessionId":"s-1","request":{"kind":"editImage","sessionId":"s-1","prompt":"改成暖色调","imageId":"img_xxx"}}'

# 上传参考图注册（dataURL → 落盘 → imageId 可用于 genImage.refImageId / editImage.imageId）
curl -X POST http://127.0.0.1:PORT/v1/images -H "Authorization: Bearer $TOKEN" \
  -H "content-type: application/json" -d '{"sessionId":"s-1","dataUrl":"data:image/png;base64,...","name":"参考图"}'

# 外部技能列表
curl http://127.0.0.1:PORT/v1/skills -H "Authorization: Bearer $TOKEN"

# 取消
curl -X POST http://127.0.0.1:PORT/v1/cancel -H "Authorization: Bearer $TOKEN" \
  -H "content-type: application/json" -d '{"requestId":"r-1"}'

# 健康 / 指标（进程级 token）
curl http://127.0.0.1:PORT/v1/health  -H "Authorization: Bearer $PROC_TOKEN"
curl http://127.0.0.1:PORT/v1/metrics -H "Authorization: Bearer $PROC_TOKEN"
```

统一错误响应：`{ "code": "...", "message": "...", "data": ... }`。
错误码唯一权威在 `packages/shared/src/errors.ts`（9 码，HTTP 映射以 `httpStatusFor()` 为准），禁止散用字面量。

## 自测

```bash
npm run test -w @aichdesign/agent-service   # vitest（8 个测试文件）
```

## 图像链路

- 工具绑定：`image_generate` / `image_edit`（extensions image-tools 约束校验 → ImageApiPort 执行 → ImageRegistry 落盘 → SSE `done(image)`）；
- **progress**：图像工具执行期间发 `progress`（`SseProgressData`，`phase: "image_generate" | "image_edit"`，percent 递增，message 中文，`done` 前必发）。pi 路径内核事件流无 phase 语义，在 `tool_execution_end` 图像工具完成节点补发 100% 档；
- ImageApiPort 两种实现：
  - `OpenAiImageApi`（真实链路）：`POST {url}` JSON / multipart，URL 为用户配置的完整端点，原样使用；
  - `UnconfiguredImagePort`（未配置）：`generate`/`edit` 一律抛「图像端点未配置」明确错误；
- 落盘：图像写 `<sessionsDir>/images/<imageId>.png`，元数据（imageId/prompt/model/provider/尺寸/耗时）随会话 jsonl（`kind=image`）同步追加；
- **SSRF 防护**：`http(s)` 参考图下载前过 `assertPublicHttpUrl`（协议白名单 + DNS 解析结果私网拒绝），与 `fetch_page` 同口径；未知协议（如 `ftp://`）直接拒绝，不会被当作本地相对路径读取。

## 已知边界

- **gpt-image-2 真实 API 未联调（无 Key/网络受限）**：`OpenAiImageApi` 按 §6.2 要点实现待联调。联调参数表：
  - `POST {url}` body：`{ model, prompt, n, size, quality, output_format }`；响应优先 `data[].b64_json`，缺省回退 `data[].url`（`response_format` 与 `output_format` 是否互斥待实机核对）；
  - `POST {editUrl}` multipart：字段 `image`（每参考图同名多值）+ `mask`（PNG）+ `model/prompt/n/size/quality/output_format`；文件 Blob 由 dataURL/本地 URI 转换；
  - 组织验证（§6.2）为真实计费前提。
- **n>1 仅返回首张**：契约声明 `n` 1–10，但 generate/edit 只消费 `data[0]`（`ImageApiResult` 单图形状）；多图批量留待请求层/SSE 载荷扩展。
- **size=auto 无真实宽高**：官方预设 `auto` 不返回固定尺寸，`ImageMeta.width/height` 记 gpt-image-2 默认输出 1024x1024（非实测值）。
- mask 同尺寸/alpha 校验：dataURL 可本地探测（纯函数 IHDR），外部 URI 无法探测时降级 warning（交由上游校验）。
- 会话级 `Agent` 为内存态（重启后经 jsonl rehydration 恢复会话历史，不恢复进行中的 run）。
- 在途 SSE 支持单消费者（重连回放仅终态可用）。
- RunManager 终态缓存：TTL 10 分钟 + 上限 100 条；死信清单内存上限 500 条（完整历史已落会话 jsonl）。
