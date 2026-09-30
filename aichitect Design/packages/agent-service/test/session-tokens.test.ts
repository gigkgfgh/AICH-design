/**
 * P016 会话 token 测试：
 * - SessionTokenManager：签发/轮换（旧 token 立即失效）/绑定校验/isRotated/revoke；
 * - 网关集成（createHttpGateway + RunManager + StubAdapter）：
 *   authorize 需进程级 token；run/stream/cancel 会话 token 绑定校验；
 *   错会话 token 拒绝；轮换后旧 token 401；进程级 token 兼容并存；
 *   health/metrics 仅进程级 token（会话 token 401）；requestId 未知 + 会话 token → 401（不泄露存在性）。
 */

import { describe, it, expect } from "vitest";
import type { AgentResponse, AgentRuntimePort, RunHandle, RunRequest } from "@aichdesign/shared";
import { makeEnvelope } from "@aichdesign/shared";
import { SessionTokenManager, SESSION_TOKEN_PREFIX } from "../src/gateway/session-tokens.js";
import { RunManager } from "../src/runtime/run-manager.js";
import { UsageTracker } from "../src/telemetry/usage-tracker.js";
import { createHttpGateway } from "../src/gateway/http-server.js";
import { AsyncQueue } from "../src/runtime/async-queue.js";

/* ---------------- SessionTokenManager 单元 ---------------- */

describe("SessionTokenManager", () => {
  it("签发 token（前缀标识）+ 绑定校验", () => {
    const mgr = new SessionTokenManager();
    const t = mgr.authorize("s1");
    expect(t.startsWith(SESSION_TOKEN_PREFIX)).toBe(true);
    expect(mgr.validate("s1", t)).toBe(true);
    expect(mgr.validate("s2", t)).toBe(false); // 跨会话无效
    expect(mgr.validate("s1", "aichs_deadbeef")).toBe(false);
  });

  it("轮换：再 authorize 即旧 token 失效（isRotated 可辨识）", () => {
    const mgr = new SessionTokenManager();
    const t1 = mgr.authorize("s1");
    const t2 = mgr.authorize("s1");
    expect(t1).not.toBe(t2);
    expect(mgr.validate("s1", t1)).toBe(false);
    expect(mgr.validate("s1", t2)).toBe(true);
    expect(mgr.isRotated("s1", t1)).toBe(true);
    expect(mgr.isRotated("s1", t2)).toBe(false);
  });

  it("revoke 撤销后不可用", () => {
    const mgr = new SessionTokenManager();
    const t = mgr.authorize("s1");
    mgr.revoke("s1");
    expect(mgr.validate("s1", t)).toBe(false);
    expect(mgr.size).toBe(0);
  });
});

/* ---------------- 网关集成 ---------------- */

class StubAdapter implements AgentRuntimePort {
  loadSkill(): void {}
  registerExtension(): void {}
  async dispose(): Promise<void> {}

  async run(req: RunRequest): Promise<RunHandle> {
    const queue = new AsyncQueue<ReturnType<typeof makeEnvelope>>();
    const response: AgentResponse = { kind: "stream", delta: `echo:${req.request.kind}` };
    queue.push(makeEnvelope(req.requestId, req.sessionId, "done", response));
    queue.close();
    return { events: queue, result: Promise.resolve(response), status: "succeeded" };
  }
}

async function startGateway() {
  const runManager = new RunManager(new StubAdapter());
  const gateway = await createHttpGateway({
    adapterLabel: "stub",
    token: "proc-token",
    runManager,
    usageTracker: new UsageTracker(),
    host: "127.0.0.1",
    port: 0,
  });
  const base = gateway.url;
  const call = (path: string, init?: RequestInit) =>
    fetch(`${base}${path}`, {
      ...init,
      headers: { "content-type": "application/json", ...(init?.headers ?? {}) },
    });
  const run = (sessionId: string, requestId: string, bearer: string) =>
    call("/v1/run", {
      method: "POST",
      headers: { authorization: `Bearer ${bearer}` },
      body: JSON.stringify({ requestId, sessionId, request: { kind: "chat", sessionId, prompt: "两室一厅" } }),
    });
  return { gateway, call, run };
}

describe("网关会话 token（P016 集成）", () => {
  it("authorize 需进程级 token；返回可用的会话 token", async () => {
    const { gateway, call, run } = await startGateway();
    try {
      // 无凭据/错凭据 → 401
      expect((await call("/v1/authorize", { method: "POST", body: JSON.stringify({ sessionId: "s1" }) })).status).toBe(401);
      expect(
        (
          await call("/v1/authorize", {
            method: "POST",
            headers: { authorization: "Bearer wrong" },
            body: JSON.stringify({ sessionId: "s1" }),
          })
        ).status,
      ).toBe(401);

      const ok = await call("/v1/authorize", {
        method: "POST",
        headers: { authorization: "Bearer proc-token" },
        body: JSON.stringify({ sessionId: "s1" }),
      });
      expect(ok.status).toBe(200);
      const { token } = (await ok.json()) as { token: string };
      expect(token.startsWith(SESSION_TOKEN_PREFIX)).toBe(true);

      // 会话 token 发起 run → 202
      const runRes = await run("s1", "req-1", token);
      expect(runRes.status).toBe(202);
    } finally {
      await gateway.close();
    }
  });

  it("会话 token 绑定校验：错会话/无效 token 拒绝；进程级 token 兼容并存", async () => {
    const { gateway, call, run } = await startGateway();
    try {
      const s1 = (await (
        await call("/v1/authorize", {
          method: "POST",
          headers: { authorization: "Bearer proc-token" },
          body: JSON.stringify({ sessionId: "s1" }),
        })
      ).json()) as { token: string };

      // s1 的 token 跑 s2 → 401
      expect((await run("s2", "req-a", s1.token)).status).toBe(401);
      // 伪造 token → 401
      expect((await run("s1", "req-b", `${SESSION_TOKEN_PREFIX}fake`)).status).toBe(401);
      // 进程级 token 旧路径仍可用（兼容并存，登记废弃）
      expect((await run("s2", "req-c", "proc-token")).status).toBe(202);
    } finally {
      await gateway.close();
    }
  });

  it("stream/cancel：会话 token 须绑定 requestId 所属会话；轮换后旧 token 401", async () => {
    const { gateway, call, run } = await startGateway();
    try {
      const t1 = (await (
        await call("/v1/authorize", {
          method: "POST",
          headers: { authorization: "Bearer proc-token" },
          body: JSON.stringify({ sessionId: "s1" }),
        })
      ).json()) as { token: string };
      await run("s1", "req-1", t1.token);

      // stream：绑定会话 token 可读
      const streamOk = await call("/v1/stream/req-1", { headers: { authorization: `Bearer ${t1.token}` } });
      expect(streamOk.status).toBe(200);
      await streamOk.text();

      // 轮换 → 旧 token 401，新 token 可读
      const t2 = (await (
        await call("/v1/authorize", {
          method: "POST",
          headers: { authorization: "Bearer proc-token" },
          body: JSON.stringify({ sessionId: "s1" }),
        })
      ).json()) as { token: string };
      expect((await call("/v1/stream/req-1", { headers: { authorization: `Bearer ${t1.token}` } })).status).toBe(401);
      expect((await call("/v1/stream/req-1", { headers: { authorization: `Bearer ${t2.token}` } })).status).toBe(200);

      // 未知 requestId + 会话 token → 401（不泄露存在性）；+ 进程级 token → 404
      expect((await call("/v1/stream/req-nope", { headers: { authorization: `Bearer ${t2.token}` } })).status).toBe(401);
      expect((await call("/v1/stream/req-nope", { headers: { authorization: "Bearer proc-token" } })).status).toBe(404);

      // cancel（终态后 cancel 返回 404 属预期——此处仅验证鉴权先行：401 而非 404）
      expect(
        (
          await call("/v1/cancel", {
            method: "POST",
            headers: { authorization: `Bearer ${t1.token}` },
            body: JSON.stringify({ requestId: "req-1" }),
          })
        ).status,
      ).toBe(401);
    } finally {
      await gateway.close();
    }
  });

  it("health/metrics 仅进程级 token（会话 token 401）", async () => {
    const { gateway, call } = await startGateway();
    try {
      const s1 = (await (
        await call("/v1/authorize", {
          method: "POST",
          headers: { authorization: "Bearer proc-token" },
          body: JSON.stringify({ sessionId: "s1" }),
        })
      ).json()) as { token: string };
      expect((await call("/v1/health", { headers: { authorization: `Bearer ${s1.token}` } })).status).toBe(401);
      expect((await call("/v1/metrics", { headers: { authorization: `Bearer ${s1.token}` } })).status).toBe(401);
      expect((await call("/v1/health", { headers: { authorization: "Bearer proc-token" } })).status).toBe(200);
      expect((await call("/v1/metrics", { headers: { authorization: "Bearer proc-token" } })).status).toBe(200);
    } finally {
      await gateway.close();
    }
  });
});
