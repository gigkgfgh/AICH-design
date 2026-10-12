/**
 * R6-16：图像端点"完整 URL 直用（零拼接）"链路测试——
 * config AICH_IMAGE_MODELS 解析（url/editUrl）+ resolveImagePort 选择链 + OpenAiImageApi 原样使用 URL。
 */
import { describe, expect, it } from "vitest";
import { loadConfig } from "../src/config.js";
import { OpenAiImageApi, UnconfiguredImagePort } from "../src/adapters/image-api.js";
import { resolveImagePort } from "../src/main.js";

function configWithEnv(env: Record<string, string | undefined>) {
  const saved: Record<string, string | undefined> = {};
  for (const [k, v] of Object.entries(env)) {
    saved[k] = process.env[k];
    if (v === undefined) delete process.env[k];
    else process.env[k] = v;
  }
  try {
    return loadConfig();
  } finally {
    for (const [k, v] of Object.entries(saved)) {
      if (v === undefined) delete process.env[k];
      else process.env[k] = v;
    }
  }
}

describe("R6-16 config：AICH_IMAGE_MODELS 解析（url/editUrl）", () => {
  it("解析完整端点条目；坏 JSON 静默为空；缺字段条目被过滤", () => {
    const ok = configWithEnv({
      AICH_IMAGE_MODELS: JSON.stringify([
        { id: "img-a", name: "A", url: "https://a.example/v1/images/generations", editUrl: "https://a.example/v1/images/edits", model: "gpt-image-2", apiKey: "sk-a" },
        { baseUrl: "https://legacy" },
      ]),
    });
    expect(ok.image.models).toHaveLength(1);
    expect(ok.image.models[0]).toMatchObject({
      id: "img-a",
      url: "https://a.example/v1/images/generations",
      editUrl: "https://a.example/v1/images/edits",
      model: "gpt-image-2",
    });

    const bad = configWithEnv({ AICH_IMAGE_MODELS: "{not json" });
    expect(bad.image.models).toEqual([]);

    const none = configWithEnv({ AICH_IMAGE_MODELS: undefined });
    expect(none.image.models).toEqual([]);
  });

  it("editUrl 缺省为空串；activeId 透传", () => {
    const cfg = configWithEnv({
      AICH_IMAGE_MODELS: JSON.stringify([{ id: "img-a", name: "A", url: "https://a/gen", model: "m", apiKey: "sk" }]),
      AICH_IMAGE_ACTIVE_ID: "img-a",
    });
    expect(cfg.image.models[0]?.editUrl).toBe("");
    expect(cfg.image.activeId).toBe("img-a");
  });
});

describe("R6-16 resolveImagePort 选择链（url/editUrl 原样透传）", () => {
  it("激活条目有 Key → 用激活条目构造 OpenAiImageApi", () => {
    const cfg = configWithEnv({});
    const config = {
      ...cfg,
      image: {
        ...cfg.image,
        apiKey: null,
        models: [
          { id: "img-a", name: "A", url: "https://a/v1/images/generations", editUrl: "", model: "m-a", apiKey: "sk-a" },
          { id: "img-b", name: "B", url: "https://b/v1/images/generations", editUrl: "https://b/v1/images/edits", model: "m-b", apiKey: "sk-b" },
        ],
        activeId: "img-b",
      },
    };
    const { port, label } = resolveImagePort(config as never);
    expect(port).toBeInstanceOf(OpenAiImageApi);
    expect(label).toBe("openai-image:m-b");
  });

  it("激活条目无 Key → 回退任一有 Key 条目", () => {
    const cfg = configWithEnv({});
    const config = {
      ...cfg,
      image: {
        ...cfg.image,
        apiKey: null,
        models: [
          { id: "img-a", name: "A", url: "https://a/gen", editUrl: "", model: "m-a", apiKey: "" },
          { id: "img-b", name: "B", url: "https://b/gen", editUrl: "", model: "m-b", apiKey: "sk-b" },
        ],
        activeId: "img-a",
      },
    };
    const { port, label } = resolveImagePort(config as never);
    expect(port).toBeInstanceOf(OpenAiImageApi);
    expect(label).toBe("openai-image:m-b");
  });

  it("无条目回退旧单字段（按遗留契约折算完整端点）", () => {
    const cfg = configWithEnv({});
    const legacy = {
      ...cfg,
      image: { ...cfg.image, apiKey: "sk-legacy", models: [], activeId: "" },
    };
    expect(resolveImagePort(legacy as never).label).toBe("openai-image");
  });

  it("全空（无条目且无 Key）→ 未配置端口：不抛错，出图时才报错", () => {
    const cfg = configWithEnv({});
    const empty = {
      ...cfg,
      image: { ...cfg.image, apiKey: null, models: [], activeId: "" },
    };
    const { port, label } = resolveImagePort(empty as never);
    expect(port).toBeInstanceOf(UnconfiguredImagePort);
    expect(label).toBe("unconfigured-image");
  });

  it("条目存在但都无 Key → 未配置端口（不静默出图）", async () => {
    const cfg = configWithEnv({});
    const config = {
      ...cfg,
      image: {
        ...cfg.image,
        apiKey: null,
        models: [{ id: "img-a", name: "A", url: "https://a/gen", editUrl: "", model: "m-a", apiKey: "" }],
        activeId: "img-a",
      },
    };
    const { port } = resolveImagePort(config as never);
    expect(port).toBeInstanceOf(UnconfiguredImagePort);
    await expect(
      port.generate({ prompt: "p", size: "1024x1024", quality: "medium", outputFormat: "png", n: 1 }),
    ).rejects.toThrow(/图像端点未配置/);
  });
});

describe("R6-16 OpenAiImageApi：完整 URL 原样使用（零拼接）", () => {
  const okResponse = (): Response =>
    new Response(JSON.stringify({ data: [{ b64_json: Buffer.from("x").toString("base64") }] }), {
      status: 200,
      headers: { "content-type": "application/json" },
    });

  it("generate 请求 URL === 用户配置的 generationsUrl（不追加任何后缀）", async () => {
    const urls: string[] = [];
    const fetchImpl: typeof fetch = (async (input: Parameters<typeof fetch>[0]) => {
      urls.push(String(input));
      return okResponse();
    }) as typeof fetch;
    const api = new OpenAiImageApi({
      generationsUrl: "https://grsai.example/v1/images/generations",
      apiKey: "sk-test",
      model: "gpt-image-2.5",
      fetchImpl,
    });
    await api.generate({ prompt: "p", size: "1024x1024", quality: "high", outputFormat: "png", n: 1 });
    expect(urls).toEqual(["https://grsai.example/v1/images/generations"]);
  });

  it("editsUrl 未配置时 edit 报明确错误（不发起请求）", async () => {
    const api = new OpenAiImageApi({
      generationsUrl: "https://a/gen",
      apiKey: "sk",
      model: "m",
      fetchImpl: (async () => okResponse()) as typeof fetch,
    });
    await expect(
      api.edit({ images: ["data:image/png;base64,eA=="], prompt: "p", n: 1, size: "1024x1024", quality: "high", outputFormat: "png" }),
    ).rejects.toThrow(/图像编辑端点未配置/);
  });
});
