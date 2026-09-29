/**
 * VersionTree —— 方案/图像版本树（P010 + P013）
 *
 * - 方案版本树：以 parentVersionId 构建层级树（缩进展示分支）；回退 = 点击任意版本节点切换当前方案
 * - 图像版本分支（P013）：done 载荷 kind:'image' 入图像分支（父版本 = 生成时的当前 plan 版本）；
 *   - 点击图像节点 = 重选（设为当前表现图）
 *   - 「回退方案」= 回退到该图像的父 plan 版本（plan 回退保持既有行为，图像树保留展示）
 * - 状态覆盖：空态（暂无版本）、当前节点高亮
 */
import type { ReactElement } from 'react';
import type { ImageVersion, PlanVersion } from '../types/contracts';
import { formatTime, summarize } from '../lib/display';

export interface VersionTreeProps {
  versions: PlanVersion[];
  currentVersionId: string | null;
  onSelect: (version: PlanVersion) => void;
  /** 图像版本（P013；为空时仅渲染方案树） */
  images?: ImageVersion[];
  currentImageId?: string | null;
  /** 点击图像节点 → 重选当前图 */
  onSelectImage?: (image: ImageVersion) => void;
  /** 回退到图像父 plan 版本（plan 回退既有行为） */
  onRollbackToPlan?: (image: ImageVersion) => void;
}

/** 由 parentVersionId 建父子索引，输出缩进层级（广度优先，同一父级按时间序） */
function buildTree(versions: PlanVersion[]): Array<{ version: PlanVersion; depth: number }> {
  const byParent = new Map<string | null, PlanVersion[]>();
  for (const v of versions) {
    const key = v.parentVersionId;
    const list = byParent.get(key) ?? [];
    list.push(v);
    byParent.set(key, list);
  }
  const result: Array<{ version: PlanVersion; depth: number }> = [];
  const walk = (parent: string | null, depth: number): void => {
    for (const v of byParent.get(parent) ?? []) {
      result.push({ version: v, depth });
      walk(v.versionId, depth + 1);
    }
  };
  walk(null, 0);
  return result;
}

export function VersionTree(props: VersionTreeProps): ReactElement {
  const {
    versions,
    currentVersionId,
    onSelect,
    images = [],
    currentImageId = null,
    onSelectImage,
    onRollbackToPlan,
  } = props;

  return (
    <section className="version-tree" aria-label="方案与表现图版本树">
      <header className="version-tree__header">
        <h2>版本树</h2>
        <span className="version-tree__count">
          {versions.length + images.length} 个节点
        </span>
      </header>

      {images.length > 0 && (
        <div className="version-tree__group">
          <h3 className="version-tree__group-title">图像版本</h3>
          <ul className="version-tree__list">
            {[...images].reverse().map((image) => {
              const active = image.imageId === currentImageId;
              return (
                <li key={image.imageId} className="version-tree__item">
                  <div className={`version-tree__image-row ${active ? 'is-active' : ''}`}>
                    <button
                      type="button"
                      className="version-tree__image-node"
                      onClick={() => onSelectImage?.(image)}
                      title={active ? '当前表现图' : '设当前表现图'}
                    >
                      <img className="version-tree__thumb" src={image.url} alt={image.meta.prompt || image.imageId} />
                      <span className="version-tree__image-text">
                        {summarize(image.meta.prompt, image.imageId, 16)}
                      </span>
                      <span className="version-tree__time">{formatTime(image.createdAt)}</span>
                      {active && <span className="version-tree__mark">当前</span>}
                    </button>
                    {image.parentPlanVersionId && onRollbackToPlan && (
                      <button
                        type="button"
                        className="version-tree__rollback"
                        onClick={() => onRollbackToPlan(image)}
                        title={`回退到父方案版本 ${image.parentPlanVersionId}`}
                      >
                        ↶ {image.parentPlanVersionId}
                      </button>
                    )}
                  </div>
                </li>
              );
            })}
          </ul>
        </div>
      )}

      <div className="version-tree__group">
        <h3 className="version-tree__group-title">方案版本</h3>
        {versions.length === 0 ? (
          <div className="version-tree__empty">暂无版本。生成第一版方案后，每次修改会在此新增节点。</div>
        ) : (
          <ul className="version-tree__list">
            {buildTree(versions).map(({ version, depth }) => {
              const active = version.versionId === currentVersionId;
              return (
                <li key={version.versionId} className="version-tree__item" style={{ paddingLeft: `${12 + depth * 16}px` }}>
                  <button
                    type="button"
                    className={`version-tree__node ${active ? 'is-active' : ''}`}
                    onClick={() => onSelect(version)}
                    title={active ? '当前版本' : '回退到此版本'}
                  >
                    <span className="version-tree__name">{version.versionId}</span>
                    <span className="version-tree__text">
                      {summarize(version.instruction, '（初始方案）')}
                    </span>
                    <span className="version-tree__time">{formatTime(version.createdAt)}</span>
                    {active && <span className="version-tree__mark">当前</span>}
                  </button>
                </li>
              );
            })}
          </ul>
        )}
      </div>
    </section>
  );
}