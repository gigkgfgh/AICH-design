/**
 * ImageCanvas —— 右栏图像节点画布（R7-2 增强版）：
 * - React Flow 只读画布：卡片可拖动重排、画布平移缩放；nodeClickDistance 修复微动点击被
 *   d3-drag 吞掉的问题（v12 默认 0 → 单击几乎必然失灵）；
 * - 单击卡片 → 放大预览（Lightbox 由 App 承载）；拖拽缩略图（HTML5, nodrag）→ 落入对话即引用；
 * - 右键 → 上下文菜单（删除/复制/编辑/引用/参数/预览）；Delete/Ctrl+C/Ctrl+V 操作右键选中的图；
 * - 「生成图像」入口已移除——生成一律在对话中进行（空态文案引导）。
 */

import { useCallback, useEffect, useMemo, useRef, useState, type ReactElement } from 'react';
import {
  Background,
  Controls,
  ReactFlow,
  type Node,
  type NodeChange,
  type NodeProps,
} from '@xyflow/react';
import '@xyflow/react/dist/style.css';
import type { ImageVersion } from '../types/contracts';
import { SafeImage } from './SafeImage';
import { CanvasContextMenu, ImageInfoOverlay, type CanvasMenuActions } from './CanvasContextMenu';

export interface ImageCanvasProps {
  images: ImageVersion[];
  loading: boolean;
  error: string | null;
  onOpen: (image: ImageVersion) => void;
  onEdit: (image: ImageVersion) => void;
  onReference: (image: ImageVersion) => void;
  onRemove: (imageId: string) => void;
  onDuplicate: (imageId: string) => void;
}

/** 节点数据形状（React Flow 泛型约束）。 */
type ImageCardData = {
  image: ImageVersion;
  active: boolean;
  onOpen: (image: ImageVersion) => void;
  onEdit: (image: ImageVersion) => void;
  onReference: (image: ImageVersion) => void;
};
type ImageCardNode = Node<ImageCardData, 'imageCard'>;

/** 应用内画布剪贴板（Ctrl+C/V；模块级，跨重挂存活）。 */
let canvasClipboard: ImageVersion | null = null;

/** 卡片节点。整框 = RF 节点拖动（拖图片即拖整框）；单击放大由 ReactFlow onNodeClick 承接。 */
function ImageCard(props: NodeProps<ImageCardNode>): ReactElement {
  const { image, active, onOpen, onEdit, onReference } = props.data;
  const summary = image.meta.prompt?.length > 42 ? `${image.meta.prompt.slice(0, 42)}…` : (image.meta.prompt ?? '');
  return (
    <div
      className={`image-node ${active ? 'is-active' : ''}`}
      title="双击放大预览 · 单击选中 · 拖动移动 · 右键更多操作"
      onKeyDown={(e) => {
        if (e.key === 'Enter') onOpen(image);
      }}
    >
      <div className="image-node__thumb-wrap">
        <SafeImage src={image.url} alt={summary || image.imageId} className="image-node__thumb" />
      </div>
      <div className="image-node__meta">
        <span className="image-node__prompt" title={image.meta.prompt}>
          {summary || image.imageId}
        </span>
        <span className="image-node__sub">
          {image.meta.model}
          {image.meta.createdAt ? ` · ${new Date(image.meta.createdAt).toLocaleString()}` : ''}
        </span>
      </div>
      <button
        type="button"
        className="image-node__edit nodrag"
        title="本地编辑（裁切/旋转/画笔/文字；保存为新版本）"
        onClick={(e) => {
          e.stopPropagation();
          onEdit(image);
        }}
      >
        ✎ 编辑
      </button>
      <button
        type="button"
        className="image-node__ref nodrag"
        title="在对话中引用（作为参考图附件）"
        onClick={(e) => {
          e.stopPropagation();
          onReference(image);
        }}
      >
        💬 引用
      </button>
    </div>
  );
}

const nodeTypes = { imageCard: ImageCard };

/** 网格布点常量（卡片约 208px 宽 + 间距）。 */
const COL_W = 236;
const ROW_H = 252;
const COLS = 3;

/** 输入焦点判定（快捷键跳过输入框/可编辑区）。 */
function isEditableTarget(target: EventTarget | null): boolean {
  const el = target as HTMLElement | null;
  if (!el) return false;
  const tag = el.tagName?.toUpperCase();
  return tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT' || el.isContentEditable === true;
}

export function ImageCanvas(props: ImageCanvasProps): ReactElement {
  const { images, loading, error, onOpen, onEdit, onReference, onRemove, onDuplicate } = props;
  const [positions, setPositions] = useState<Record<string, { x: number; y: number }>>({});
  const [menu, setMenu] = useState<{ x: number; y: number; image: ImageVersion } | null>(null);
  const [infoImage, setInfoImage] = useState<ImageVersion | null>(null);
  const activeIdRef = useRef<string | null>(null);
  // active 用于高亮 + 快捷键目标（state 驱动高亮）
  const [activeId, setActiveId] = useState<string | null>(null);

  useEffect(() => {
    setPositions((prev) => {
      const next = { ...prev };
      let changed = false;
      for (const img of images) {
        if (next[img.imageId]) continue;
        const used = new Set(Object.values(next).map((p) => `${p.x},${p.y}`));
        let slot = 0;
        while (used.has(`${(slot % COLS) * COL_W},${Math.floor(slot / COLS) * ROW_H}`)) slot += 1;
        next[img.imageId] = { x: (slot % COLS) * COL_W, y: Math.floor(slot / COLS) * ROW_H };
        changed = true;
      }
      // 清理已删除节点的槽位（空位可复用）
      for (const key of Object.keys(next)) {
        if (!images.some((img) => img.imageId === key)) {
          delete next[key];
          changed = true;
        }
      }
      return changed ? next : prev;
    });
  }, [images]);

  const nodes = useMemo<ImageCardNode[]>(
    () =>
      images
        .filter((img) => positions[img.imageId])
        .map((img) => ({
          id: img.imageId,
          type: 'imageCard' as const,
          position: positions[img.imageId]!,
          data: {
            image: img,
            active: activeId === img.imageId,
            onOpen: (image: ImageVersion) => {
              activeIdRef.current = image.imageId;
              setActiveId(image.imageId);
              onOpen(image);
            },
            onEdit,
            onReference,
          },
          draggable: true,
        })),
    [images, positions, activeId, onOpen, onEdit, onReference],
  );

  const onNodesChange = useCallback((changes: NodeChange<ImageCardNode>[]) => {
    const posChanges = changes.filter((c) => c.type === 'position' && c.position);
    if (posChanges.length === 0) return;
    setPositions((prev) => {
      const next = { ...prev };
      for (const c of posChanges) {
        if (c.type === 'position' && c.position) next[c.id] = c.position;
      }
      return next;
    });
  }, []);

  /** 单击选中节点（放大预览改双击；右键菜单内仍可放大） */
  const onNodeClick = useCallback((_event: React.MouseEvent, node: ImageCardNode) => {
    activeIdRef.current = node.id;
    setActiveId(node.id);
  }, []);

  /** 双击放大预览（ReactFlow onNodeDoubleClick，与拖拽判定协同） */
  const onNodeDoubleClick = useCallback(
    (_event: React.MouseEvent, node: ImageCardNode) => {
      activeIdRef.current = node.id;
      setActiveId(node.id);
      const image = images.find((img) => img.imageId === node.id);
      if (image) onOpen(image);
    },
    [images, onOpen],
  );

  /** 右键菜单（选中该节点为快捷键目标）。 */
  const onNodeContextMenu = useCallback(
    (event: React.MouseEvent, node: ImageCardNode) => {
      event.preventDefault();
      activeIdRef.current = node.id;
      setActiveId(node.id);
      const image = images.find((img) => img.imageId === node.id);
      if (image) setMenu({ x: event.clientX, y: event.clientY, image });
    },
    [images],
  );

  /** 快捷键：Delete 删除 / Ctrl+C 复制 / Ctrl+V 粘贴（作用目标 = 右键选中的图）。 */
  useEffect(() => {
    const onKey = (e: KeyboardEvent): void => {
      if (isEditableTarget(e.target)) return;
      const activeImage = images.find((img) => img.imageId === (activeIdRef.current ?? activeId));
      if (e.key === 'Delete' && activeImage) {
        e.preventDefault();
        onRemove(activeImage.imageId);
        return;
      }
      if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'c' && activeImage) {
        canvasClipboard = activeImage;
        return;
      }
      if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'v' && canvasClipboard) {
        e.preventDefault();
        onDuplicate(canvasClipboard.imageId);
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [images, activeId, onRemove, onDuplicate]);

  const menuActions: CanvasMenuActions = useMemo(
    () => ({
      open: onOpen,
      reference: onReference,
      edit: onEdit,
      duplicate: (image) => onDuplicate(image.imageId),
      info: setInfoImage,
      remove: (image) => onRemove(image.imageId),
    }),
    [onOpen, onReference, onEdit, onDuplicate, onRemove],
  );

  if (images.length === 0) {
    return (
      <div className="image-canvas image-canvas--empty">
        {error ? (
          <p className="image-canvas__error" role="alert">{error}</p>
        ) : (
          <>
            <p className="image-canvas__empty-title">{loading ? '正在生成图像…' : '尚无图像'}</p>
            <p className="image-canvas__empty-sub">
              {loading
                ? '生成完成后会自动出现在画布上'
                : '在对话中描述画面或上传/粘贴图片，生成的图像会自动加入画布'}
            </p>
          </>
        )}
      </div>
    );
  }

  return (
    <div className="image-canvas">
      {error && <p className="image-canvas__error" role="alert">{error}</p>}
      <ReactFlow
        nodes={nodes}
        nodeTypes={nodeTypes}
        onNodesChange={onNodesChange}
        onNodeClick={onNodeClick}
        onNodeDoubleClick={onNodeDoubleClick}
        onNodeContextMenu={onNodeContextMenu}
        // R7-2：v12 默认 0——按下与抬起间 ≥1px 移动即判定为拖拽并杀死 click（window 捕获层），
        // 单击放大因此失灵；放宽到 5px 恢复正常点击语义。
        nodeClickDistance={5}
        nodesConnectable={false}
        elementsSelectable={false}
        fitView
        fitViewOptions={{ padding: 0.2, maxZoom: 1 }}
        minZoom={0.2}
        maxZoom={1.6}
        panOnScroll
        proOptions={{ hideAttribution: true }}
      >
        <Background gap={18} size={1} />
        <Controls showInteractive={false} />
      </ReactFlow>
      {menu && (
        <CanvasContextMenu
          x={menu.x}
          y={menu.y}
          image={menu.image}
          actions={menuActions}
          onClose={() => setMenu(null)}
        />
      )}
      {infoImage && <ImageInfoOverlay image={infoImage} onClose={() => setInfoImage(null)} />}
    </div>
  );
}
