---
name: plan-draft
description: （Beta）Drafts or iterates architectural floor plans (PlanStructure JSON + SVG) from natural language. Use when the user describes a room layout, asks to create a floor plan, or requests changes to an existing plan (e.g. enlarge a bedroom, change an orientation, add a room).
allowed_tools:
  - validate_plan
  - render_plan_svg
  - plan_patch
license: MIT
compatibility: aich-design >= 0.1, PlanStructure schemaVersion 1
metadata:
  version: 1
  schema: PlanStructure@1
  scope: plan-drafting
---

# plan-draft

起草与迭代建筑平面方案（AICH Design 模块 A，设计文档 §5）。本 Skill 的职责边界：**只负责把自然语言变成结构化 PlanStructure JSON 并驱动渲染/校验工具**；不做图像生成（image-tools）、不做存储（版本树归主进程）。

## 何时使用

- 用户描述户型需求（「两室一厅 90 平米」「主卧朝南」）→ 起草；
- 用户对已有方案提出修改（「把客厅加大」「厨房换到东侧」）→ 迭代；
- 用户要求「多方案」→ 一次产出 2~3 个独立 PlanStructure 比选。

## 工作流（固定顺序）

1. **解析硬约束**：用户显式给出的尺寸、朝向、房间数、功能关系是硬约束，逐条列出并保留（后续迭代也不得违反）。
2. **产出 PlanStructure JSON**（米制，schemaVersion=1，字段规范见 references/schema.json）：
   - `bounds` 为方案总尺寸；房间坐标（x, y, w, h）为左上角原点米制；
   - `rooms[].type` 仅允许 `bedroom|living|kitchen|bath|study|balcony|corridor|other`；
   - `rooms[].orientation` 仅允许 `N|S|E|W|NE|NW|SE|SW`；
   - 面积 `areaM2` 可选：缺省由渲染链按 w*h 推算（不必手工计算）；
   - `walls` 每段墙两端点坐标米制，`thicknessMm` 默认 200；
   - 门/窗放入 `openings` 并引用 `walls[].id`（`kind: door|window`）。
3. **调用 `validate_plan`**：把 JSON 原样传入；校验失败时按返回的 errors 修正 JSON 并重查（修正回环 ≤2 次）。
4. **调用 `render_plan_svg`**：渲染通过校验的 PlanStructure 为 SVG（渲染规范见 references/render-spec.md）。
5. **回复用户**：给出方案要点（房间构成/总面积/朝向），并提示可迭代方向。

## 约束与边界

- **不输出 SVG 原始码之外的解释性包裹**：SVG 由 render_plan_svg 生成，除展示文本外不要自行拼接 SVG；
- **不猜测未给出的尺寸**：用户未指定时按合理默认（如客厅 4×3.6 m），并在回复中说明假设；
- **不回退硬约束**：迭代时不得违反第一步列出的硬约束；确实冲突时向用户确认；
- **JSON 必须完整**：禁止省略必需字段（id/name/type/x/y/w/h/orientation）或输出非法枚举。

## 示例

用户：「帮我设计一个两室一厅，总开间 10 米、进深 8 米，主卧朝南。」

1. 硬约束：[两室一厅；bounds 10×8；主卧朝南]
2. PlanStructure：
```json
{
  "schemaVersion": 1,
  "bounds": { "widthM": 10, "heightM": 8 },
  "rooms": [
    { "id": "r1", "name": "主卧", "type": "bedroom", "x": 0, "y": 4.4, "w": 3.6, "h": 3.6, "orientation": "S" },
    { "id": "r2", "name": "次卧", "type": "bedroom", "x": 0, "y": 0, "w": 3.4, "h": 3.4, "orientation": "N" },
    { "id": "r3", "name": "客厅", "type": "living", "x": 4.2, "y": 0, "w": 5.8, "h": 4.4, "orientation": "E" },
    { "id": "r4", "name": "厨房", "type": "kitchen", "x": 4.2, "y": 4.4, "w": 2.8, "h": 3.6, "orientation": "S" }
  ],
  "walls": [
    { "id": "w1", "x1": 0, "y1": 0, "x2": 10, "y2": 0, "thicknessMm": 200 },
    { "id": "w2", "x1": 0, "y1": 8, "x2": 10, "y2": 8, "thicknessMm": 200 },
    { "id": "w3", "x1": 0, "y1": 0, "x2": 0, "y2": 8, "thicknessMm": 200 },
    { "id": "w4", "x1": 10, "y1": 0, "x2": 10, "y2": 8, "thicknessMm": 200 },
    { "id": "w5", "x1": 4.2, "y1": 4.4, "x2": 4.2, "y2": 8, "thicknessMm": 120 }
  ],
  "openings": [{ "kind": "door", "wallId": "w5", "offsetM": 1.2, "widthM": 0.9 }]
}
```
3. `validate_plan` 通过；4. `render_plan_svg` 输出 SVG；5. 回复要点与迭代方向。

## 多方案（variants）说明

`variants > 1` 时产出多个 PlanStructure 并分别渲染多张 SVG 供比选；每张 SVG 对应独立版本，交给主进程版本树管理（不在此处拼接）。
## 执行约束（必须遵守）

1. 先理解户型需求（总尺寸/朝向/房间构成/硬约束），再生成方案；
2. 方案必须输出 schemaVersion=1 的 PlanStructure（planschema.json，米制单位，rooms/walls/openings 引用完整）；
3. 流程固定：先 validate_plan 校验，通过后 render_plan_svg 渲染出图；增量修改用 plan_patch（校验回环 ≤2，超限降级输出）；
4. 修改时严格保留用户显式尺寸与朝向（硬约束），不得擅自变更；
5. 输出后简要说明布局思路（房间关系/采光/交通面积），便于用户决策。
