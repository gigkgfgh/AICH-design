/**
 * R6-17：DeepSeek 思考参数官方对齐测试——
 * 模型构建（reasoning/thinkingLevelMap/compat）+ 请求体改写器（effort 迁入 thinking 内、删除顶层无效参数）。
 */
import { describe, expect, it } from "vitest";
import { buildLlmModel, DEEPSEEK_THINKING_LEVEL_MAP, isDeepSeekBaseUrl } from "../src/llm/model.js";
import { rewriteDeepSeekThinkingFetch } from "../src/adapters/pi-agent-core-adapter.js";
import type { ThinkingLevel } from "@aichdesign/shared";

describe("R6-17 buildLlmModel：DeepSeek 官方对齐", () => {
  it("deepseek.com 端点：reasoning=true + 官方档位映射 + 禁用顶层 effort 来源", () => {
    const m = buildLlmModel({ baseURL: "https://api.deepseek.com", apiKeyRef: "sk", model: "deepseek-flash" });
    expect(m).not.toBeNull();
    expect(m!.reasoning).toBe(true);
    expect(m!.thinkingLevelMap).toMatchObject({
      off: "none",
      low: "low",
      medium: "high",
      high: "high",
      xhigh: "high",
      max: "max",
    });
    expect(m!.compat?.supportsReasoningEffort).toBe(false);
  });

  it("非 DeepSeek 端点：维持 reasoning=false（不发送思考参数，行为不变）", () => {
    const m = buildLlmModel({ baseURL: "https://token.sensenova.cn/v1", apiKeyRef: "sk", model: "deepseek-v4-flash" });
    expect(m).not.toBeNull();
    expect(m!.reasoning).toBe(false);
    expect(m!.thinkingLevelMap).toBeUndefined();
    expect(m!.compat).toBeUndefined();
  });

  it("isDeepSeekBaseUrl：大小写不敏感；其他域名不误判", () => {
    expect(isDeepSeekBaseUrl("https://API.DeepSeek.com")).toBe(true);
    expect(isDeepSeekBaseUrl("https://grsai.dakka.com.cn/v1")).toBe(false);
  });

  it("档位映射符合官方：low→low、medium/xhigh→high、max→max（minimal 档已删除）", () => {
    expect(DEEPSEEK_THINKING_LEVEL_MAP["minimal"]).toBeUndefined();
    expect(DEEPSEEK_THINKING_LEVEL_MAP["medium"]).toBe("high");
    expect(DEEPSEEK_THINKING_LEVEL_MAP["xhigh"]).toBe("high");
    expect(DEEPSEEK_THINKING_LEVEL_MAP["max"]).toBe("max");
  });
});

describe("R6-17 rewriteDeepSeekThinkingFetch：官方形状请求体", () => {
  function makeCapturingFetch(): { fetchImpl: typeof fetch; bodies: Array<Record<string, unknown>> } {
    const bodies: Array<Record<string, unknown>> = [];
    const fetchImpl: typeof fetch = (async (_input, init) => {
      try {
        bodies.push(JSON.parse(String(init?.body)) as Record<string, unknown>);
      } catch {
        bodies.push({ __nonJson: String(init?.body) });
      }
      return new Response(
        JSON.stringify({ choices: [{ delta: { content: "" } }] }),
        { status: 200, headers: { "content-type": "application/json" } },
      );
    }) as typeof fetch;
    return { fetchImpl, bodies };
  }

  it("档位迁入 thinking 对象内；删除顶层 reasoning_effort 无效参数", async () => {
    const slot = { level: "medium" as ThinkingLevel };
    const { fetchImpl, bodies } = makeCapturingFetch();
    const wrapped = rewriteDeepSeekThinkingFetch(slot, fetchImpl);
    await wrapped("https://api.deepseek.com/chat/completions", {
      method: "POST",
      body: JSON.stringify({
        model: "deepseek-flash",
        messages: [],
        // pi-ai deepseek 分支产物：thinking.type + 顶层 effort（无效位置）
        thinking: { type: "enabled" },
        reasoning_effort: "whatever-pi-ai-sent",
      }),
    });
    expect(bodies[0]!.reasoning_effort).toBeUndefined(); // 顶层无效参数已删除
    expect(bodies[0]!.thinking).toEqual({ type: "enabled", reasoning_effort: "high" }); // 官方形状（medium→high）
  });

  it("off 档：不注入 effort（thinking.type=disabled 原样保留）", async () => {
    const slot = { level: "off" as ThinkingLevel };
    const { fetchImpl, bodies } = makeCapturingFetch();
    const wrapped = rewriteDeepSeekThinkingFetch(slot, fetchImpl);
    await wrapped("https://api.deepseek.com/chat/completions", {
      method: "POST",
      body: JSON.stringify({ model: "deepseek-flash", messages: [], thinking: { type: "disabled" } }),
    });
    expect(bodies[0]!.thinking).toEqual({ type: "disabled" });
  });

  it("槽位逐次读取：同请求先后不同档位即时生效（冻结缺陷回归护栏）", async () => {
    const slot = { level: "low" as ThinkingLevel };
    const { fetchImpl, bodies } = makeCapturingFetch();
    const wrapped = rewriteDeepSeekThinkingFetch(slot, fetchImpl);
    const request: Parameters<typeof wrapped>[1] = {
      method: "POST",
      body: JSON.stringify({ model: "deepseek-flash", messages: [], thinking: { type: "enabled" } }),
    };
    await wrapped("https://api.deepseek.com/chat/completions", request);
    slot.level = "max";
    await wrapped("https://api.deepseek.com/chat/completions", request);
    expect(bodies[0]!.thinking).toMatchObject({ reasoning_effort: "low" });
    expect(bodies[1]!.thinking).toMatchObject({ reasoning_effort: "max" });
  });

  it("无思考字段的请求体原样放行；非 JSON 体不抛错", async () => {
    const slot = { level: "high" as ThinkingLevel };
    const { fetchImpl, bodies } = makeCapturingFetch();
    const wrapped = rewriteDeepSeekThinkingFetch(slot, fetchImpl);
    await wrapped("https://api.deepseek.com/chat/completions", {
      method: "POST",
      body: JSON.stringify({ model: "deepseek-flash", messages: [] }),
    });
    expect(bodies[0]!.thinking).toBeUndefined();
    await wrapped("https://api.deepseek.com/chat/completions", { method: "POST", body: "not-json" });
    expect(bodies[1]).toEqual({ __nonJson: "not-json" }); // 原样放行（改写器不抛错）
  });
});
