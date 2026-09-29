/**
 * P018 任务队列补强测试：
 * - withRetry：退避节奏（500→1000）/ 瞬态重试 / 非瞬态 fail-fast / 耗尽抛最后错误；
 * - isTransientError：errno / PROVIDER_UNAVAILABLE / 业务码 / 取消 判定；
 * - OpenAiImageApi：fetchImpl 注入——网络失败重试后成功、5xx/429 重试、4xx 不重试；
 * - RetryingRuntime：图像成本护栏拒绝（不触达内层 + needUserConfirmation）、
 *   启动级瞬态重试、重试耗尽死信（内存 + jsonl deadQueue:true）、终态 error 死信、
 *   R024——REQUEST_CANCELLED 不重试不进死信且为终态码；
 * - UsageTracker：recordOnce 幂等记账 / costUsdByKinds。
 */

import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ErrorCode, makeEnvelope } from "@aichdesign/shared";
import type { AgentResponse, AgentRuntimePort, RunHandle, RunRequest } from "@aichdesign/shared";
import { withRetry, isTransientError, DEFAULT_RETRY_POLICY } from "../src/runtime/retry.js";
import type { RetryPolicy } from "../src/runtime/retry.js";
import { RetryingRuntime, DEFAULT_IMAGE_REQUEST_ESTIMATE_USD } from "../src/runtime/task-queue.js";
import { UsageTracker } from "../src/telemetry/usage-tracker.js";
import { JsonlSessionStore } from "../src/session/jsonl-store.js";
import { AsyncQueue } from "../src/runtime/async-queue.js";
import { OpenAiImageApi } from "../src/adapters/image-api.js";

/* ---------------- withRetry / isTransientError ---------------- */

function errnoError(code: string, message = "fail"): Error {
  const err = new Error(message) as Error & { code?: string };
  err.code = code;
  return err;
}

describe("withRetry", () => {
  const zeroSleep: RetryPolicy["sleep"] = async () => {};

  it("瞬态失败一次后成功：重试 1 次，退避 500ms", async () => {
    const delays: number[] = [];
    let calls = 0;
    const outcome = await withRetry(
      async () => {
        calls += 1;
        if (calls === 1) throw errnoError("ECONNRESET");
        return "ok";
      },
      { sleep: async (ms) => { delays.push(ms); } },
    );
    expect(outcome).toEqual({ value: "ok", attempts: 2 });
    expect(delays).toEqual([500]);
  });

  it("退避倍增 500 → 1000（两次重试）", async () => {
    const delays: number[] = [];
    let calls = 0;
    await withRetry(
      async () => {
        calls += 1;
        if (calls <= 2) throw errnoError("ETIMEDOUT");
        return 1;
      },
      { sleep: async (ms) => { delays.push(ms); } },
    );
    expect(delays).toEqual([500, 1000]);
  });

  it("非瞬态错误 fail-fast（不重试）", async () => {
    let calls = 0;
    await expect(
      withRetry(
        async () => {
          calls += 1;
          throw errnoError(ErrorCode.INVALID_REQUEST, "参数错误");
        },
        { sleep: zeroSleep },
      ),
    ).rejects.toThrow(/参数错误/);
    expect(calls).toBe(1);
  });

  it("重试耗尽：抛最后一次错误，尝试次数 = 1 + maxRetries", async () => {
    let calls = 0;
    await expect(
      withRetry(
        async () => {
          calls += 1;
          throw errnoError("ECONNREFUSED", `boom-${calls}`);
        },
        { maxRetries: 2, sleep: zeroSleep },
      ),
    ).rejects.toThrow("boom-3");
    expect(calls).toBe(3);
    expect(DEFAULT_RETRY_POLICY.maxRetries).toBe(2);
  });

  it("fetch 网络消息（TypeError: fetch failed）判定为瞬态", async () => {
    let calls = 0;
    const outcome = await withRetry(
      async () => {
        calls += 1;
        if (calls === 1) throw new TypeError("fetch failed");
        return true;
      },
      { sleep: zeroSleep },
    );
    expect(outcome.attempts).toBe(2);
  });
});

describe("isTransientError", () => {
  it("瞬态：errno 白名单 / PROVIDER_UNAVAILABLE / 网络消息", () => {
    expect(isTransientError(errnoError("ECONNRESET"))).toBe(true);
    expect(isTransientError(errnoError("EAI_AGAIN"))).toBe(true);
    expect(isTransientError(errnoError(ErrorCode.PROVIDER_UNAVAILABLE))).toBe(true);
    expect(isTransientError(new TypeError("fetch failed"))).toBe(true);
  });

  it("非瞬态：业务错误 / 用户取消 / 非错误值", () => {
    expect(isTransientError(errnoError(ErrorCode.RUNNER_ERROR))).toBe(false);
    expect(isTransientError(errnoError(ErrorCode.REQUEST_CANCELLED))).toBe(false);
    expect(isTransientError(errnoError(ErrorCode.PLAN_VALIDATE_FAILED))).toBe(false);
    expect(isTransientError("string")).toBe(false);
  });
});

/* ---------------- OpenAiImageApi 重试（fetchImpl 注入） ---------------- */

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
}

const GEN_PARAMS = { prompt: "测试", size: "1024x1024" as const, quality: "medium" as const, outputFormat: "png" as const, n: 1 };

describe("OpenAiImageApi 瞬态重试", () => {
  const zeroSleep: RetryPolicy["sleep"] = async () => {};

  it("网络失败两次后成功：共 3 次尝试", async () => {
    let calls = 0;
    const api = new OpenAiImageApi({
      baseURL: "https://img.example.com",
      apiKey: "k",
      fetchImpl: (async () => {
        calls += 1;
        if (calls <= 2) throw new TypeError("fetch failed");
        return jsonResponse({ data: [{ b64_json: Buffer.from("png-bytes").toString("base64") }] });
      }) as typeof fetch,
      retryPolicy: { sleep: zeroSleep },
    });
    const result = await api.generate(GEN_PARAMS);
    expect(result.url.startsWith("data:image/png;base64,")).toBe(true);
    expect(result.meta.provider).toBe("openai");
    expect(calls).toBe(3);
  });

  it("5xx/429 可重试；4xx fail-fast", async () => {
    let fiveHundredCalls = 0;
    const fiveHundred = new OpenAiImageApi({
      baseURL: "https://img.example.com",
      apiKey: "k",
      fetchImpl: (async () => {
        fiveHundredCalls += 1;
        if (fiveHundredCalls === 1) return jsonResponse({ error: "upstream" }, 503);
        return jsonResponse({ data: [{ b64_json: "AAAA" }] });
      }) as typeof fetch,
      retryPolicy: { sleep: zeroSleep },
    });
    await fiveHundred.generate(GEN_PARAMS);
    expect(fiveHundredCalls).toBe(2);

    let fourHundredCalls = 0;
    const fourHundred = new OpenAiImageApi({
      baseURL: "https://img.example.com",
      apiKey: "k",
      fetchImpl: (async () => {
        fourHundredCalls += 1;
        return jsonResponse({ error: { message: "bad prompt" } }, 400);
      }) as typeof fetch,
      retryPolicy: { sleep: zeroSleep },
    });
    await expect(fourHundred.generate(GEN_PARAMS)).rejects.toThrow(/400/);
    expect(fourHundredCalls).toBe(1);
  });
});

/* ---------------- RetryingRuntime ---------------- */

/** 可编排的内层 adapter 桩：launchFn 抛错或返回 RunHandle。 */
class StubAdapter implements AgentRuntimePort {
  launchCalls = 0;
  launchFn: (req: RunRequest) => Promise<RunHandle> = async () => immediateHandle("s1", { kind: "stream", delta: "ok" });

  loadSkill(): void {}
  registerExtension(): void {}
  async dispose(): Promise<void> {}

  async run(req: RunRequest): Promise<RunHandle> {
    this.launchCalls += 1;
    return this.launchFn(req);
  }
}

function immediateHandle(sessionId: string, response: AgentResponse): RunHandle {
  const queue = new AsyncQueue<ReturnType<typeof makeEnvelope>>();
  queue.push(makeEnvelope("req", sessionId, response.kind === "error" ? "error" : "done", response as never));
  queue.close();
  return { events: queue, result: Promise.resolve(response), status: "succeeded" };
}

function genImageRequest(overrides?: Partial<RunRequest>): RunRequest {
  return {
    requestId: "req-1",
    sessionId: "s1",
    request: { kind: "genImage", sessionId: "s1", prompt: "客厅表现图" },
    ...overrides,
  };
}

let dir: string;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "aich-queue-"));
});

afterEach(() => {
  rmSync(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
});

const zeroSleep: RetryPolicy["sleep"] = async () => {};

describe("RetryingRuntime", () => {
  it("图像成本护栏：已用 + 预估超上限 → IMAGE_COST_LIMIT_EXCEEDED，不触达内层 adapter", async () => {
    const inner = new StubAdapter();
    const runtime = new RetryingRuntime({
      inner,
      policy: { sleep: zeroSleep },
      sessionStore: new JsonlSessionStore(dir),
      imageCostLimitUsd: 0.5,
      imageCostUsed: () => 0.48,
      imageRequestEstimateUsd: 0.04,
    });
    const handle = await runtime.run(genImageRequest());
    const response = await handle.result;
    expect(response.kind).toBe("error");
    if (response.kind === "error") {
      expect(response.code).toBe(ErrorCode.IMAGE_COST_LIMIT_EXCEEDED);
      expect(response.message).toContain("用户确认");
    }
    expect(inner.launchCalls).toBe(0);
    expect(runtime.deadLetters().length).toBe(0); // 护栏拒绝不是死信（等待用户确认）
  });

  it("护栏未超限：透传内层执行", async () => {
    const inner = new StubAdapter();
    const runtime = new RetryingRuntime({
      inner,
      policy: { sleep: zeroSleep },
      imageCostLimitUsd: 0.5,
      imageCostUsed: () => 0.1,
    });
    const response = await (await runtime.run(genImageRequest())).result;
    expect(response.kind).toBe("stream");
    expect(inner.launchCalls).toBe(1);
  });

  it("护栏关闭（limit ≤ 0）：不检查", async () => {
    const inner = new StubAdapter();
    const runtime = new RetryingRuntime({
      inner,
      policy: { sleep: zeroSleep },
      imageCostLimitUsd: 0,
      imageCostUsed: () => 999,
    });
    const response = await (await runtime.run(genImageRequest())).result;
    expect(response.kind).toBe("stream");
  });

  it("非图像请求不受护栏限制", async () => {
    const inner = new StubAdapter();
    const runtime = new RetryingRuntime({
      inner,
      policy: { sleep: zeroSleep },
      imageCostLimitUsd: 0.5,
      imageCostUsed: () => 999,
    });
    const response = await (
      await runtime.run({ requestId: "r", sessionId: "s1", request: { kind: "draftPlan", sessionId: "s1", prompt: "两室一厅" } })
    ).result;
    expect(response.kind).toBe("stream");
  });

  it("启动级瞬态失败重试后成功", async () => {
    const inner = new StubAdapter();
    inner.launchFn = async () => {
      if (inner.launchCalls < 3) throw errnoError("ECONNRESET");
      return immediateHandle("s1", { kind: "stream", delta: "ok" });
    };
    const runtime = new RetryingRuntime({ inner, policy: { sleep: zeroSleep }, sessionStore: new JsonlSessionStore(dir) });
    const response = await (await runtime.run(genImageRequest())).result;
    expect(response.kind).toBe("stream");
    expect(inner.launchCalls).toBe(3);
    expect(runtime.deadLetters().length).toBe(0);
  });

  it("重试耗尽 → 死信登记（内存 + jsonl deadQueue:true）+ 终态 error", async () => {
    const inner = new StubAdapter();
    inner.launchFn = async () => {
      throw errnoError("ETIMEDOUT", "网关无响应");
    };
    const store = new JsonlSessionStore(dir);
    const runtime = new RetryingRuntime({ inner, policy: { maxRetries: 2, sleep: zeroSleep }, sessionStore: store });
    const response = await (await runtime.run(genImageRequest())).result;
    expect(inner.launchCalls).toBe(3);
    expect(response.kind === "error" && response.code).toBe(ErrorCode.PROVIDER_UNAVAILABLE);

    const dead = runtime.deadLetters();
    expect(dead.length).toBe(1);
    expect(dead[0]).toMatchObject({ requestId: "req-1", code: ErrorCode.PROVIDER_UNAVAILABLE, attempts: 3 });

    const lines = store.readLines("s1");
    const deadLine = lines.find((l) => l.kind === "error");
    expect(deadLine?.data).toMatchObject({ deadQueue: true, code: ErrorCode.PROVIDER_UNAVAILABLE });
  });

  it("终态 error 响应（内层成功启动但运行失败）→ 死信登记，结果原样透传", async () => {
    const inner = new StubAdapter();
    inner.launchFn = async () => immediateHandle("s1", { kind: "error", code: ErrorCode.RUNNER_ERROR, message: "工具失败" });
    const store = new JsonlSessionStore(dir);
    const runtime = new RetryingRuntime({ inner, policy: { sleep: zeroSleep }, sessionStore: store });
    const response = await (await runtime.run(genImageRequest())).result;
    expect(response.kind === "error" && response.code).toBe(ErrorCode.RUNNER_ERROR);
    await new Promise((r) => setTimeout(r, 10)); // 终态观察异步登记
    expect(runtime.deadLetters().length).toBe(1);
  });

  it("R024 复核：取消不重试、不进死信，终态码 REQUEST_CANCELLED 优先", async () => {
    const inner = new StubAdapter();
    let launched = 0;
    inner.launchFn = async (req) => {
      launched += 1;
      // 模拟 cancel 后内核抛出的是通用 AbortError（terminalError 风险路径）：
      // 正确行为是归一化为 REQUEST_CANCELLED（RunManager/adapter 责任），此处以取消码直达。
      const signal = req.signal;
      if (signal) {
        return new Promise<RunHandle>((resolve) => {
          signal.addEventListener(
            "abort",
            () => resolve(immediateHandle("s1", { kind: "error", code: ErrorCode.REQUEST_CANCELLED, message: "请求已取消" })),
            { once: true },
          );
        });
      }
      return immediateHandle("s1", { kind: "stream", delta: "ok" });
    };
    const store = new JsonlSessionStore(dir);
    const runtime = new RetryingRuntime({ inner, policy: { sleep: zeroSleep }, sessionStore: store });
    const controller = new AbortController();
    const runPromise = runtime.run({ ...genImageRequest(), signal: controller.signal });
    controller.abort();
    const response = await (await runPromise).result;
    expect(response.kind === "error" && response.code).toBe(ErrorCode.REQUEST_CANCELLED);
    expect(launched).toBe(1); // 取消不触发重试
    expect(runtime.deadLetters().length).toBe(0); // 取消不进死信
  });
});

/* ---------------- UsageTracker 幂等记账 / 成本聚合 ---------------- */

describe("UsageTracker（P018 扩展）", () => {
  const rec = (requestId: string, costUsd: number, requestKind = "genImage") => ({
    sessionId: "s1",
    requestId,
    requestKind,
    model: "m",
    provider: "mock",
    promptTokens: 1,
    completionTokens: 1,
    cacheReadTokens: 0,
    cacheWriteTokens: 0,
    totalTokens: 2,
    costUsd,
    latencyMs: 5,
    ok: true,
    ts: "2026-08-12T00:00:00Z",
  });

  it("recordOnce：同 requestId 覆盖，重试不重复计费", () => {
    const tracker = new UsageTracker();
    tracker.recordOnce(rec("req-1", 0.04));
    tracker.recordOnce(rec("req-1", 0.04)); // 同 requestId 重试
    tracker.recordOnce(rec("req-2", 0.06));
    expect(tracker.summary().totalRuns).toBe(2);
    expect(tracker.summary().totalCostUsd).toBeCloseTo(0.1);
  });

  it("costUsdByKinds：图像护栏读取口径", () => {
    const tracker = new UsageTracker();
    tracker.record(rec("r1", 0.04, "genImage"));
    tracker.record(rec("r2", 0.04, "editImage"));
    tracker.record(rec("r3", 0.01, "draftPlan"));
    expect(tracker.costUsdByKinds(["genImage", "editImage"])).toBeCloseTo(0.08);
    expect(tracker.costUsdByKinds(["draftPlan"])).toBeCloseTo(0.01);
    expect(DEFAULT_IMAGE_REQUEST_ESTIMATE_USD).toBe(0.04);
  });
});
