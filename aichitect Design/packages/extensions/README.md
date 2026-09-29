# @aichdesign/extensions

AICH Design 产品 Extension：纯函数工具实现（零运行时依赖，可被 MockAdapter 与 PiAgentCoreAdapter 共用）。

| Extension | 内容 | 交付轮 |
|---|---|---|
| `plan-tools` | `validate_plan` / `render_plan_svg` / `plan_patch`（结构校验、SVG 渲染、增量补丁） | P008（R1） |
| `image-tools` | `image_generate` / `image_edit`（ToolDef + gpt-image-2 约束校验层 + 尺寸探测） | P012（R2） |

## P011 严格 json_schema 输出模式（validate.ts）

`validatePlan(input)` 与 `validatePlan(input, { strict: true })` / `validatePlanStrict(input)` 双档：

| 校验点 | 宽容档（R1 行为） | 严格档（P011） |
|---|---|---|
| `schemaVersion` 缺省 | 视为 1（ADR-005 兼容） | **拒绝**（必须显式声明） |
| `rooms[].areaM2` 缺省 | 允许（渲染按 w\*h 推算） | **拒绝** |
| `walls[].thicknessMm` 缺省 | 允许（默认 200mm） | **拒绝** |
| 房间几何越界 | 警告（不阻断渲染） | **拒绝**（提升为错误） |
| 悬垂引用（`adjacentTo` / `openings.wallId`） | 错误 | 错误（保持） |
| 枚举 / 结构非法 | 错误 | 错误（保持） |

```ts
import { validatePlan, validatePlanStrict } from "@aichdesign/extensions";

const lenient = validatePlan(input);            // 宽容档（R1）
const strict = validatePlanStrict(input);        // 严格档（P011 等价）
const strict2 = validatePlan(input, { strict: true });
```

agent-service 侧由 `AICH_STRICT_JSON`（默认 `"1"`）决定 `validate_plan` 工具实际生效档；
两档均执行并计数（README：agent-service「P011 校验失败率对比」基线口径）。

## P012 image-tools（gpt-image-2 契约与约束，§6.1/§6.2）

工具定义（ToolDef，与 plan-tools 同构）：

- `image_generate`：`{ prompt, size?, quality?, outputFormat?, n? }`
  - `size` ∈ `1024x1024 | 1024x1536 | 1536x1024 | 2048x2048`（缺省 `1024x1024`，预设天然满足 gpt-image-2 尺寸物理约束）
  - `quality` ∈ `low | medium | high`（缺省 `medium`）；`outputFormat` ∈ `png | jpeg | webp`（缺省 `png`）；`n` ∈ 1–10（缺省 1）
- `image_edit`：`{ images[], prompt, mask?, inputFidelity?, size?, quality?, n? }`
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

测试：`npm.cmd run test -w @aichdesign/extensions`（plan-tools 含 P011 严格档用例；image-tools 含 §6.2 约束用例）。