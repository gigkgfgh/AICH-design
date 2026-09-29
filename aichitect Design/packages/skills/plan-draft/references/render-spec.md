# render_plan_svg 渲染规范（冻结）

> 权威实现：`packages/extensions/src/plan-tools/render.ts`（P008）；本文件为 plan-draft Skill 的 L3 按需加载说明，供人工核验与跨层对齐。冻结依据：设计文档 §5.3。

## 1. 坐标系与比例尺

- `viewBox="0 0 W H"`，单位 px；
- **比例尺 scale = 50 px/m**（实现常量 `RENDER_SCALE = 50`，可配置）；
- 米制坐标（x, y）为左上角原点；`W = bounds.widthM × scale`，`H = bounds.heightM × scale`；
- 画布周围预留标注边距（默认 28px + 底部 14px）。

## 2. 图层顺序（SVG 文档序 = 视觉层叠序）

1. **墙体**：深色实线，`stroke:#333`，线宽 = `thicknessMm / 1000 × scale`（默认 200mm → 10px），`stroke-linecap="round"`；
2. **房间**：`fill:#eef` 浅色矩形 + `stroke:#999` 边框，房间中心标注名称与面积（`areaM2` 缺省按 `w×h` 推算）；
3. **开口**：门（门扇线 + 90° 门弧，`stroke:#333`）、窗（双平行线 `stroke:#4a90d9`），挂接在 `openings[].wallId` 对应墙段；
4. **标注**：顶部总宽尺寸线（虚线段 + 数值 `<…> m`）、右侧总高尺寸线；`font-size:10`，`fill:#666`；
5. **指北针**：右上角圆形 + 北向箭头 + `N` 标记。

## 3. 样式常量（冻结）

| 元素 | 样式 |
|---|---|
| 墙体 | `stroke:#333`，线宽按厚度 ≥ 2px |
| 房间填充 | `fill:#eef` |
| 文字 | `font-family: sans-serif`；房间名 `font-size:≤12`，面积 `≤10`；标注 `10` |
| 门窗 | 门 `stroke:#333`；窗 `stroke:#4a90d9` |

## 4. 安全与校验

- 渲染前必须经历 `validate_plan`（结构/枚举/引用完整性）；校验失败抛 `PlanRenderError`，由上层走修正回环（≤2）或降级输出；
- 用户文本（房间名等）必须 XML 转义（防注入）：
  `& < > " '` → `&amp; &lt; &gt; &quot; &apos;`；
- 数值输出四舍五入到 0.01px，避免浮点毛刺。

## 5. 输出形态

- 完整 XML 文档：`<?xml version="1.0" encoding="UTF-8"?>` + `<svg xmlns=… width=… height=… viewBox=… font-family="sans-serif">`；
- 各图层以 `<!-- layer: xxx -->` 注释分隔（人工与测试可核对图层序）。