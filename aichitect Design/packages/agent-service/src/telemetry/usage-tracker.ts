/**
 * usage/cost 埋点（C-6 自 M1 起步；P023 指标仪表聚合读取）。
 *
 * - 每次 run 结束时 record 一条；成本美元按模型单价计算（真实 provider 用 pi-ai
 *   Model.cost，mock 用 mock-provider 的 MOCK_MODEL_COST）；
 * - 落盘：随会话 jsonl kind:'usage'（修订②：sessions/*.jsonl 归 agent-service）；
 * - 提供 /v1/metrics 聚合摘要（网关暴露）。
 */

export interface UsageRecord {
  sessionId: string;
  requestId: string;
  requestKind: string;
  model: string;
  provider: string;
  promptTokens: number;
  completionTokens: number;
  cacheReadTokens: number;
  cacheWriteTokens: number;
  totalTokens: number;
  /** 美元。 */
  costUsd: number;
  latencyMs: number;
  ok: boolean;
  code?: string;
  ts: string;
}

export interface UsageSummary {
  totalRuns: number;
  succeeded: number;
  failed: number;
  cancelled: number;
  successRate: number;
  totalTokens: number;
  totalCostUsd: number;
  avgLatencyMs: number;
  byModel: Record<string, { runs: number; costUsd: number; tokens: number }>;
  byKind: Record<string, number>;
}

export class UsageTracker {
  private records: UsageRecord[] = [];

  record(r: UsageRecord): void {
    this.records.push(r);
  }

  /**
   * 幂等记账（P018，ADR-006）：同 requestId 仅保留最后一次记录。
   * 重试链路（同一 requestId 内多次尝试）不重复计费——以终态尝试为准。
   */
  recordOnce(r: UsageRecord): void {
    const idx = this.records.findIndex((x) => x.requestId === r.requestId);
    if (idx >= 0) {
      this.records[idx] = r;
    } else {
      this.records.push(r);
    }
  }

  /** 指定 requestKind 集合的累计成本（美元）——P018 图像成本护栏读取点。 */
  costUsdByKinds(kinds: readonly string[]): number {
    const set = new Set(kinds);
    return this.records.filter((r) => set.has(r.requestKind)).reduce((acc, r) => acc + r.costUsd, 0);
  }

  /** 会话内累计（用于审计 / 会话文件核对）。 */
  forSession(sessionId: string): UsageRecord[] {
    return this.records.filter((r) => r.sessionId === sessionId);
  }

  summary(): UsageSummary {
    const total = this.records.length;
    const succeeded = this.records.filter((r) => r.ok).length;
    const failed = this.records.filter((r) => !r.ok && r.code !== "REQUEST_CANCELLED").length;
    const cancelled = this.records.filter((r) => r.code === "REQUEST_CANCELLED").length;
    const totalCostUsd = this.records.reduce((acc, r) => acc + r.costUsd, 0);
    const totalTokens = this.records.reduce((acc, r) => acc + r.totalTokens, 0);
    const latency = this.records.map((r) => r.latencyMs);
    const avgLatencyMs = latency.length > 0 ? latency.reduce((a, b) => a + b, 0) / latency.length : 0;

    const byModel: UsageSummary["byModel"] = {};
    const byKind: UsageSummary["byKind"] = {};
    for (const r of this.records) {
      const m = (byModel[r.model] ??= { runs: 0, costUsd: 0, tokens: 0 });
      m.runs += 1;
      m.costUsd += r.costUsd;
      m.tokens += r.totalTokens;
      byKind[r.requestKind] = (byKind[r.requestKind] ?? 0) + 1;
    }

    return {
      totalRuns: total,
      succeeded,
      failed,
      cancelled,
      successRate: total > 0 ? succeeded / total : 0,
      totalTokens,
      totalCostUsd,
      avgLatencyMs,
      byModel,
      byKind,
    };
  }
}