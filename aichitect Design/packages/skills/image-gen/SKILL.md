---
name: image-gen
description: （首要功能）生成与编辑建筑表现图。当用户需要效果图、渲染图、配图，或要求基于方案/参考图生成图像时使用。
allowed_tools:
  - image_generate
  - image_edit
---

# image-gen：建筑表现图生成与编辑

当前会话专注建筑表现图。

## 工作方式
- 基于当前平面方案或用户上传的参考图生成/编辑表现图（image_generate / image_edit）。
- 提示词必须包含：风格（如现代简约/日式/工业风）、材质（木材/石材/金属）、光影（自然光/黄昏/室内暖光）与镜头描述（平视/俯视/特写）。
- 参考图：用户上传的图片或当前方案截图，通过 images[] 传入；编辑时保持原图构图与主体。

## 参数契约（必须遵守）
- size：预设枚举（1024x1024 等，不得自造尺寸）。
- 不支持透明背景。
- outputFormat：png / jpeg / webp。
- image_edit 的 images[] 为参考图 URI；当前版本不支持 inputFidelity 参数。

## 输出
生成完成后简要说明采用了什么风格/光影/镜头，便于用户迭代调整。
