/**
 * MockGatewayClient —— 本地 mock 全链路（P007/P010）
 *
 * 模拟真实链路语义：
 *   UI 发送 → run() 返回 requestId → subscribe() 收到 SSE 信封流
 *   （delta 文本增量 → done 携带 AgentResponse.plan）
 * 版本树：draftPlan 建根版本；editPlan 基于 versionId 生成子版本（parentVersionId 指向旧版）；
 * 回退 = 前端本地选中历史版本（见 App/VersionTree），无需网络请求。
 *
 * TODO-API: 切换 backend 网关 —— agent-service ready 时由 IpcGatewayClient 替代本实现，
 * 版本树语义不变（done.plan 入树，回退为本地状态）。
 */
import type { AgentRequest, AgentResponse, GatewayStatus, PlanStructure, PlanVersion, SseEventEnvelope } from '../types/contracts';
import type { GatewayClient, StreamHandlers } from './types';
import { dispatchEnvelope } from './types';
import { ErrorCode } from '@aichdesign/shared'; // 错误码表唯一权威（R011：对齐 shared 10 码）
import { pickSeedPlan, findRoomByName } from '../lib/planExamples';
import { renderPlanSvg } from '../lib/planSvg';

const MOCK_SESSION_ID = 'mock-session-001';
const TICK_MS = 120; // 流式分片间隔（模拟网络节奏）

let seq = 0;
function nextId(): string {
  seq += 1;
  return `mock-${Date.now().toString(36)}-${seq}`;
}

/** 文本按字节安全切分（按字符切，中文友好） */
function chunkText(text: string, size = 9): string[] {
  const chunks: string[] = [];
  for (let i = 0; i < text.length; i += size) {
    chunks.push(text.slice(i, i + size));
  }
  return chunks;
}

/** 规则化编辑：按中文指令修改 PlanStructure（mock 版；真实链路由 LLM + plan_patch 完成） */
function applyEdit(plan: PlanStructure, instruction: string): { plan: PlanStructure; note: string } {
  const next = structuredClone(plan);

  const GROW = /(客厅|卧室|主卧|次卧|厨房|卫生间|卫生间|书房|餐厅|走廊|阳台)(扩大|变大|加大|放大)/;
  const SHRINK = /(客厅|卧室|主卧|次卧|厨房|卫生间|卫生间|书房|餐厅|走廊|阳台)(缩小|变小|减少)/;
  const REMOVE = /(去掉|删除|移除|取消|不要)(客厅|卧室|主卧|次卧|厨房|卫生间|卫生间|书房|餐厅|走廊|阳台)/;

  const growMatch = instruction.match(GROW);
  if (growMatch) {
    const room = findRoomByName(next, growMatch[1]);
    if (room) {
      room.w = Math.round(room.w * 1.2 * 10) / 10;
      room.h = Math.round(room.h * 1.2 * 10) / 10;
      room.areaM2 = undefined; // 由 w*h 重新推算
      return { plan: next, note: `已按「${growMatch[1]}扩大」调整：${growMatch[1]}增大约 20%（新尺寸 ${room.w}m × ${room.h}m）。` };
    }
  }
  const shrinkMatch = instruction.match(SHRINK);
  if (shrinkMatch) {
    const room = findRoomByName(next, shrinkMatch[1]);
    if (room) {
      room.w = Math.round(room.w * 0.82 * 10) / 10;
      room.h = Math.round(room.h * 0.82 * 10) / 10;
      room.areaM2 = undefined;
      return { plan: next, note: `已按「${shrinkMatch[1]}缩小」调整：${shrinkMatch[1]}缩小约 18%（新尺寸 ${room.w}m × ${room.h}m）。` };
    }
  }
  const removeMatch = instruction.match(REMOVE);
  if (removeMatch) {
    const room = findRoomByName(next, removeMatch[2]);
    if (room) {
      next.rooms = next.rooms.filter((r) => r.id !== room.id);
      return { plan: next, note: `已移除「${removeMatch[2]}」。其相邻墙体保留（真实修改流将由 plan_patch + 引用完整性校验处理）。` };
    }
  }
  if (/(开|加|增加)a?窗|多.*窗/.test(instruction)) {
    const wall = next.walls.find((w) => /w-left|w-top/.test(w.id));
    if (wall) {
      const wallOpenings = next.openings ?? [];
      wallOpenings.push({ kind: 'window', wallId: wall.id, offsetM: 0.8, widthM: 1.2 });
      next.openings = wallOpenings;
      return { plan: next, note: '已按指令新增一扇窗（示例修改：外墙 w-left 增加 1.2m 窗）。' };
    }
  }

  // 兜底修改：客厅 + 次卧整体偏移 0.5m（保证「改一句 → 新版本」闭环可演示）
  const living = next.rooms.find((r) => r.type === 'living');
  if (living) {
    living.x += 0.2;
    living.y += 0.2;
  }
  return { plan: next, note: '已按指令调整方案（示例修改：客厅微调 0.2m）。完整编辑能力待 P008 plan_patch + LLM 生成。' };
}

export class MockGatewayClient implements GatewayClient {
  private readonly status: GatewayStatus = {
    agentService: 'unavailable',
    gateway: 'mock',
  };

  private readonly versions = new Map<string, PlanVersion>();

  async getStatus(): Promise<GatewayStatus> {
    return this.status;
  }

  async run(req: AgentRequest, _runOptions?: import('../types/contracts').RunOptions): Promise<{ requestId: string }> {
    // 同步完成「执行」，subscribe 只负责回放信封流 —— 保持 run/subscribe 解耦，
    // 与真实链路（run 启动、stream 拉取）一致。
    const requestId = nextId();
    this.prepareResponse(requestId, req);
    return { requestId };
  }

  subscribe(requestId: string, handlers: StreamHandlers): () => void {
    const timers: ReturnType<typeof setTimeout>[] = [];
    const pending = this.pending.get(requestId);
    if (!pending) {
      const envelope: SseEventEnvelope = {
        requestId,
        sessionId: MOCK_SESSION_ID,
        type: 'error',
        data: { code: ErrorCode.INTERNAL_ERROR, message: 'mock：未知 requestId（无法生成响应）' },
      };
      timers.push(setTimeout(() => dispatchEnvelope(envelope, handlers), 0));
      return () => timers.forEach(clearTimeout);
    }
    this.pending.delete(requestId);

    const { deltas, done } = pending;
    deltas.forEach((text, i) => {
      timers.push(
        setTimeout(() => {
          const envelope: SseEventEnvelope = {
            requestId,
            sessionId: MOCK_SESSION_ID,
            type: 'delta',
            data: { delta: text },
          };
          dispatchEnvelope(envelope, handlers);
        }, i * TICK_MS)
      );
    });
    timers.push(
      setTimeout(() => {
        const envelope: SseEventEnvelope = {
          requestId,
          sessionId: MOCK_SESSION_ID,
          type: 'done',
          data: done,
        };
        dispatchEnvelope(envelope, handlers);
      }, deltas.length * TICK_MS + 60)
    );
    return () => timers.forEach(clearTimeout);
  }

  async cancel(requestId: string): Promise<void> {
    this.pending.delete(requestId);
  }

  /* ---------------- mock 执行体（真实链路中由 agent-service 承担） ---------------- */

  private readonly pending = new Map<
    string,
    { deltas: string[]; done: AgentResponse }
  >();

  private prepareResponse(requestId: string, req: AgentRequest): void {
    switch (req.kind) {
      case 'draftPlan': {
        const plan = pickSeedPlan(req.prompt);
        const version = this.pushVersion(req.prompt, plan, null);
        // svg 由本地渲染器生成（§5.3）；PlanCanvas 以 plan 为主源重渲染以支持高亮/点选
        const done: AgentResponse = {
          kind: 'plan',
          svg: renderPlanSvg(plan),
          structure: plan,
          versionId: version.versionId,
        };
        const summary = `已生成方案「${plan.rooms.length} 室」（${plan.bounds.widthM}m × ${plan.bounds.heightM}m）：${plan.rooms
          .map((r) => `${r.name}${Math.round((r.areaM2 ?? r.w * r.h) * 10) / 10}m²`)
          .join('、')}。`;
        this.pending.set(requestId, { deltas: chunkText(summary), done });
        break;
      }
      case 'editPlan': {
        const base = this.versions.get(req.versionId);
        if (!base) {
          const done: AgentResponse = {
            kind: 'error',
            code: ErrorCode.NOT_FOUND,
            message: `版本 ${req.versionId} 不存在（可能已回退到其他分支）`,
          };
          this.pending.set(requestId, { deltas: [], done });
          break;
        }
        const { plan, note } = applyEdit(base.plan, req.instruction);
        const version = this.pushVersion(req.instruction, plan, base.versionId);
        const done: AgentResponse = {
          kind: 'plan',
          svg: renderPlanSvg(plan),
          structure: plan,
          versionId: version.versionId,
        };
        const streamText = `${note} 生成新版本 ${version.versionId}。`;
        this.pending.set(requestId, { deltas: chunkText(streamText), done });
        break;
      }
      case 'listVersions': {
        // TODO-API: listVersions 的响应类型在 AgentResponse 契约中未定义（仅 plan|image|stream|error），
        // 当前版本树由前端会话内累积维护，此处仅返回说明文本，不发 done.plan。
        const items = [...this.versions.values()];
        const text =
          items.length === 0
            ? '暂无方案版本。'
            : `共有 ${items.length} 个版本：${items.map((v) => v.versionId).join('、')}。`;
        this.pending.set(requestId, {
          deltas: chunkText(text),
          done: { kind: 'error', code: ErrorCode.INTERNAL_ERROR, message: 'mock/listVersions 待契约明确' },
        });
        break;
      }
      default: {
        // genImage / editImage 属 R2+（图像端口本期不做）
        const done: AgentResponse = {
          kind: 'error',
          code: ErrorCode.INVALID_REQUEST,
          message: `mock 暂不支持请求类型 ${req.kind}（图像能力留 R2+）`,
        };
        this.pending.set(requestId, { deltas: [], done });
        break;
      }
    }
  }

  private pushVersion(instruction: string, plan: PlanStructure, parentVersionId: string | null): PlanVersion {
    const versionId = `v${this.versions.size + 1}`;
    const version: PlanVersion = {
      versionId,
      parentVersionId,
      createdAt: new Date().toISOString(),
      instruction,
      plan,
      svg: renderPlanSvg(plan),
    };
    this.versions.set(versionId, version);
    return version;
  }

  /** 供 UI 初始化时读取（App 以 done.plan 累积为主，本方法为诊断/测试辅助） */
  getVersions(): PlanVersion[] {
    return [...this.versions.values()];
  }
}

/** 渲染层默认单例（App 在 gateway='mock' 时使用） */
export const mockGateway = new MockGatewayClient();