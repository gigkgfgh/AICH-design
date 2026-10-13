# @aichdesign/extensions

AICH Design 产品 Extension：纯函数工具实现（零运行时依赖，可被 PiAgentCoreAdapter 直接绑定）。

| Extension | 内容 | 交付轮 |
|---|---|---|
| `image-tools` | `image_generate` / `image_edit`（ToolDef + gpt-image-2 约束校验层 + 尺寸探测） | P012 |

> R7-1：`plan-tools`（`validate_plan` / `render_plan_svg` / `plan_patch`）与 P011 严格 json_schema 双档校验随方案链路一并移除，本包仅保留 image-tools。

## image-tools（gpt-image-2 契约与约束，§6.1/§6.2）

工具定义（ToolDef）：

- `image_generate`：`{ prompt, size?, quality?, outputFormat?, n? }`
  - `size` ∈ `1024x1024 | 1536x1024 | 1024x1536 | auto`（缺省 `1024x1024`；`auto` 由服务端决定尺寸）
  - `quality` ∈ `low | medium | high`（缺省 `medium`）；`outputFormat` ∈ `png | jpeg | webp`（缺省 `png`）；`n` ∈ 1–10（缺省 1）
  - 不支持透明背景；不支持自定义尺寸（仅上述预设）
- `image_edit`：`{ images[], prompt, mask?, inputFidelity?, size?, quality?, outputFormat?, n? }`
  - `images` 1–16 张（png/webp/jpg）；`mask` 同尺寸 alpha PNG（`alpha=0` 区域重绘）
  - `inputFidelity` 显式提供会**拒绝**（§6.2：联调前省略该参数）

约束校验层（`src/image-tools/validate.ts`，全部内建）：

- 透明背景拒绝：`background:"transparent"` / `transparent:true` / `alpha:"transparent"` → 错误；
- 尺寸物理约束 `checkImageDimension(w, h)`：单边 16 的倍数、≤3840px、宽高比 <3:1、像素 655,360–8,294,400；
- edits 入参：`images` ≤16、元素 URI 格式校验；`mask` 必须 PNG、带 alpha、且与参考图同尺寸
  （dataURL 可本地探测；外部 URI 无法探测时降级 warning，交由上游 API 校验）；
- 非法枚举 / 缺失必填 → 错误（`{ ok:false, errors }`；`ok:true` 时返回规范化参数供调用）。

尺寸探测（`src/image-tools/size-probe.ts`，纯函数零依赖）：

- `decodeBase64DataUrl` / `probeImageBytes` / `probeImageFromDataUrl`：PNG（IHDR+alpha 判定）、JPEG（SOF 段）、WebP（VP8X/VP8/VP8L）头部解析，不做整图解码。

## 执行归属

本包只负责**参数契约与约束校验**，不执行网络请求。图像生成/编辑的实际执行在 agent-service 的 `ImageApiPort`：

- `OpenAiImageApi`：按用户配置的完整端点 URL 原样请求（不做拼接）；
- `UnconfiguredImagePort`：端点未配置时抛「图像端点未配置」明确错误。

测试：`npm run test -w @aichdesign/extensions`（image-tools：§6.2 约束用例 + 尺寸探测 + ToolDef 契约）。
