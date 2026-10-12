/**
 * R5 单测：buildLlmModel（含覆盖）/ SSRF 防护 / htmlToText / agent 预设 /
 * 网关信封扩展字段（agent/model/thinking 白名单）与 /v1/images 上传注册。
 */

import { describe, it, expect } from "vitest";
import type { AgentRuntimePort, RunHandle, RunRequest } from "@aichdesign/shared";
import { makeEnvelope } from "@aichdesign/shared";
import { buildLlmModel, LLM_PROVIDER_ID } from "../src/llm/model.js";
import { assertPublicHttpUrl, htmlToText } from "../src/tools/search.js";
import { RunManager } from "../src/runtime/run-manager.js";
import { UsageTracker } from "../src/telemetry/usage-tracker.js";
import { createHttpGateway } from "../src/gateway/http-server.js";
import { SessionTokenManager } from "../src/gateway/session-tokens.js";
import { ImageRegistry } from "../src/image/image-registry.js";
import { JsonlSessionStore } from "../src/session/jsonl-store.js";
import { AsyncQueue } from "../src/runtime/async-queue.js";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

/* ---------------- buildLlmModel ---------------- */

describe("buildLlmModel", () => {
  it("配置不齐备返回 null（维持 mock）", () => {
    expect(buildLlmModel({ baseURL: "", apiKeyRef: "k", model: "m" })).toBeNull();
    expect(buildLlmModel({ baseURL: "http://x/v1", apiKeyRef: "", model: "m" })).toBeNull();
    expect(buildLlmModel({ baseURL: "http://x/v1", apiKeyRef: "k", model: "" })).toBeNull();
  });

  it("构建 openai-completions 模型；model 覆盖换 id 保 baseUrl/provider", () => {
    const base = buildLlmModel({ baseURL: "http://127.0.0.1:8000/v1/", apiKeyRef: "k", model: "gpt-4o" })!;
    expect(base.api).toBe("openai-completions");
    expect(base.provider).toBe(LLM_PROVIDER_ID);
    expect(base.baseUrl).toBe("http://127.0.0.1:8000/v1");
    expect(base.id).toBe("gpt-4o");
    const override = buildLlmModel({ baseURL: "http://127.0.0.1:8000/v1/", apiKeyRef: "k", model: "gpt-4o" }, "deepseek-chat")!;
    expect(override.id).toBe("deepseek-chat");
    expect(override.baseUrl).toBe(base.baseUrl);
    expect(override.provider).toBe(base.provider);
  });
});

/* ---------------- SSRF / htmlToText ---------------- */

describe("assertPublicHttpUrl（SSRF 防护）", () => {
  it("公网域名通过", async () => {
    expect(await assertPublicHttpUrl("https://example.com/a")).toBeNull();
  });
  it("协议/本地/私网/解析失败拒绝", async () => {
    expect(await assertPublicHttpUrl("ftp://example.com/a")).toMatch(/http/);
    expect(await assertPublicHttpUrl("http://localhost:8080/")).toMatch(/本地|内网/);
    expect(await assertPublicHttpUrl("http://127.0.0.1/x")).toMatch(/本地|私网|内网/);
    expect(await assertPublicHttpUrl("http://192.168.1.1/x")).toMatch(/本地|私网|内网/);
    expect(await assertPublicHttpUrl("http://172.16.0.1/x")).toMatch(/本地|私网|内网/);
    expect(await assertPublicHttpUrl("http://169.254.1.1/x")).toMatch(/本地|私网|内网/);
    expect(await assertPublicHttpUrl("http://[::1]/x")).toMatch(/本地|私网|内网/);
    expect(await assertPublicHttpUrl("not a url")).toMatch(/URL 非法/);
  });
});

describe("htmlToText", () => {
  it("去脚本样式/标签/实体并压缩空白", () => {
    const html = "<html><head><style>.a{}</style><script>evil()</script></head><body><h1>标&nbsp;题</h1><p>A &amp; B &lt;c&gt;</p></body></html>";
    expect(htmlToText(html)).toBe("标 题 A & B <c>");
  });
});

/* ---------------- agent 预设 ---------------- */

describe('AGENT_REGISTRATIONS（R6-8：内置技能化；R7-1 起两套）', () => {
  it('注册表收敛 image-gen/research；skillName 映射正确', async () => {
    const { AGENT_REGISTRATIONS, skillNameForAgent } = await import('../src/agents/presets.js');
    expect(Object.keys(AGENT_REGISTRATIONS).sort()).toEqual(['image-gen', 'main', 'research']);
    expect(AGENT_REGISTRATIONS['image-gen']?.skillName).toBe('image-gen');
    expect(AGENT_REGISTRATIONS.main?.skillName).toBeUndefined();
    expect(skillNameForAgent('research')).toBe('research');
    expect(skillNameForAgent(undefined)).toBeUndefined();
  });

  it('内置 SKILL.md 可被 loader 解析：allowedTools 白名单 + 正文约束', async () => {
    const { loadSkillsFromDirs } = await import('../src/skills/loader.js');
    const { fileURLToPath } = await import('node:url');
    const skillsDir = fileURLToPath(new URL('../../skills', import.meta.url));
    const skills = loadSkillsFromDirs([skillsDir], ['image-gen', 'research']);
    expect(skills.map((s) => s.name)).toEqual(['image-gen', 'research']);
    const img = skills.find((s) => s.name === 'image-gen')!;
    expect(img.allowedTools).toEqual(['image_generate', 'image_edit']);
    expect(img.body).toContain('参数契约');
  });
});

/* ---------------- 网关：信封扩展 + /v1/images ---------------- */

class NullAdapter implements AgentRuntimePort {
  loadSkill(): void {}
  registerExtension(): void {}
  async dispose(): Promise<void> {}
  async run(req: RunRequest): Promise<RunHandle> {
    const queue = new AsyncQueue<ReturnType<typeof makeEnvelope>>();
    const response = { kind: "stream" as const, delta: `agent=${req.agent ?? "main"}` };
    queue.push(makeEnvelope(req.requestId, req.sessionId, "done", response));
    queue.close();
    return { events: queue, result: Promise.resolve(response), status: "succeeded" };
  }
}

describe("网关 R5 扩展", () => {
  it("信封 agent/model/thinking 合法透传（adapter 收到）；非法值 400", async () => {
    const runManager = new RunManager(new NullAdapter());
    const gateway = await createHttpGateway({
      adapterLabel: "stub",
      token: "proc",
      runManager,
      usageTracker: new UsageTracker(),
      host: "127.0.0.1",
      port: 0,
    });
    try {
      const ok = await fetch(`${gateway.url}/v1/run`, {
        method: "POST",
        headers: { authorization: "Bearer proc", "content-type": "application/json" },
        body: JSON.stringify({
          requestId: "r1",
          sessionId: "s1",
          request: { kind: "research", sessionId: "s1", prompt: "调研开放式厨房案例" },
          agent: "research",
          model: "gpt-4o",
          thinking: "high",
        }),
      });
      expect(ok.status).toBe(202);

      const bad = await fetch(`${gateway.url}/v1/run`, {
        method: "POST",
        headers: { authorization: "Bearer proc", "content-type": "application/json" },
        body: JSON.stringify({
          requestId: "r2",
          sessionId: "s1",
          request: { kind: "research", sessionId: "s1", prompt: "x" },
          agent: "evil-agent",
        }),
      });
      expect(bad.status).toBe(400);
      const badThinking = await fetch(`${gateway.url}/v1/run`, {
        method: "POST",
        headers: { authorization: "Bearer proc", "content-type": "application/json" },
        body: JSON.stringify({
          requestId: "r3",
          sessionId: "s1",
          request: { kind: "research", sessionId: "s1", prompt: "x" },
          thinking: "ultra",
        }),
      });
      expect(badThinking.status).toBe(400);
    } finally {
      await gateway.close();
    }
  });

  it("POST /v1/images：dataURL 注册 → imageId/url；非图片 dataURL 400", async () => {
    const dir = mkdtempSync(join(tmpdir(), "aich-img-"));
    try {
      const store = new JsonlSessionStore(dir);
      const registry = new ImageRegistry(dir, store);
      const runManager = new RunManager(new NullAdapter());
      const gateway = await createHttpGateway({
        adapterLabel: "stub",
        token: "proc",
        runManager,
        usageTracker: new UsageTracker(),
        sessionTokens: new SessionTokenManager(),
        imageRegistry: registry,
        host: "127.0.0.1",
        port: 0,
      });
      try {
        // 会话 token 授权（进程级亦可）
        const auth = await fetch(`${gateway.url}/v1/authorize`, {
          method: "POST",
          headers: { authorization: "Bearer proc", "content-type": "application/json" },
          body: JSON.stringify({ sessionId: "s1" }),
        });
        const { token } = (await auth.json()) as { token: string };

        // 1x1 PNG dataURL
        const pngB64 =
          "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==";
        const ok = await fetch(`${gateway.url}/v1/images`, {
          method: "POST",
          headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
          body: JSON.stringify({ sessionId: "s1", dataUrl: `data:image/png;base64,${pngB64}`, name: "参考图" }),
        });
        expect(ok.status).toBe(200);
        const body = (await ok.json()) as { imageId: string; url: string };
        expect(body.imageId.startsWith("img_")).toBe(true);
        expect(registry.resolveUrl(body.imageId)).toBeTruthy();

        const bad = await fetch(`${gateway.url}/v1/images`, {
          method: "POST",
          headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
          body: JSON.stringify({ sessionId: "s1", dataUrl: "data:text/plain;base64,QUJD" }),
        });
        expect(bad.status).toBe(400);
      } finally {
        await gateway.close();
      }
    } finally {
      rmSync(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
    }
  });
});
