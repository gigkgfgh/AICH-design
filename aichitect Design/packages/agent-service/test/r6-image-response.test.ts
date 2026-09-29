/**
 * R6-19：图像响应解析测试——宽松形状（OpenAI 标准 + 常见中转变体）+ http 结果下载转 dataURL +
 * 异步任务轮询 + 错误透明化（响应体摘录）。
 */
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { OpenAiImageApi, setImagePollIntervalForTests } from "../src/adapters/image-api.js";

const GEN_URL = "https://relay.example/v1/images/generations";

interface CapturedRequest {
  url: string;
  init?: RequestInit;
}

function makeApi(responses: Array<{ status: number; body: unknown | string; contentType?: string }>) {
  const requests: CapturedRequest[] = [];
  let i = 0;
  const fetchImpl: typeof fetch = (async (input: Parameters<typeof fetch>[0], init?: RequestInit) => {
    const r = responses[Math.min(i, responses.length - 1)]!;
    requests.push({ url: String(input), init });
    i += 1;
    if (typeof r.body === "string") {
      return new Response(r.body, { status: r.status, headers: { "content-type": r.contentType ?? "application/json" } });
    }
    if (Buffer.isBuffer(r.body)) {
      return new Response(new Uint8Array(r.body), { status: r.status, headers: { "content-type": r.contentType ?? "application/octet-stream" } });
    }
    return new Response(JSON.stringify(r.body), { status: r.status, headers: { "content-type": r.contentType ?? "application/json" } });
  }) as typeof fetch;
  const api = new OpenAiImageApi({
    generationsUrl: GEN_URL,
    editsUrl: "https://relay.example/v1/images/edits",
    apiKey: "sk-test",
    model: "gpt-image-2.5",
    fetchImpl,
  });
  return { api, requests };
}

const PNG_BYTES = Buffer.from("png-bytes");

beforeEach(() => {
  setImagePollIntervalForTests(1);
});

afterEach(() => {
  setImagePollIntervalForTests(2000);
});

describe("R6-19 图像响应宽松解析", () => {
  it.each([
    ["OpenAI 标准 url", { data: [{ url: "https://cdn.example/1.png" }] }, "https://cdn.example/1.png"],
    ["顶层 url（中转常见）", { url: "https://cdn.example/2.png" }, "https://cdn.example/2.png"],
    ["images 数组", { images: ["https://cdn.example/3.png"] }, "https://cdn.example/3.png"],
    ["data 为对象（非数组）", { data: { url: "https://cdn.example/4.png" } }, "https://cdn.example/4.png"],
    ["result 包裹", { result: { url: "https://cdn.example/5.png" } }, "https://cdn.example/5.png"],
    ["grsai 实测形状（results 数组）", { id: "1-x", status: "succeeded", results: [{ url: "https://file2.example/x.png" }], progress: 100 }, "https://file2.example/x.png"],
  ])("%s → 提取并下载为 dataURL", async (_name, body, expectedUrl) => {
    const { api, requests } = makeApi([
      { status: 200, body },
      { status: 200, body: PNG_BYTES, contentType: "image/png" },
    ]);
    const result = await api.generate({ prompt: "p", size: "1024x1024", quality: "high", outputFormat: "png", n: 1 });
    expect(result.url).toMatch(/^data:image\/png;base64,/);
    expect(Buffer.from(result.url.split(",")[1]!, "base64").toString()).toBe("png-bytes");
    // 第二个请求即结果下载
    expect(requests[1]!.url).toBe(expectedUrl);
  });

  it("dataURL 字符串直传（不下载）", async () => {
    const dataUrl = `data:image/png;base64,${PNG_BYTES.toString("base64")}`;
    const { api, requests } = makeApi([{ status: 200, body: { data: [{ b64_json: dataUrl }] } }]);
    const result = await api.generate({ prompt: "p", size: "1024x1024", quality: "high", outputFormat: "png", n: 1 });
    expect(result.url).toBe(dataUrl);
    expect(requests).toHaveLength(1);
  });

  it("异步任务：POST 返回 task_id → 轮询 GET {url}/{taskId} 直至成功", async () => {
    const { api, requests } = makeApi([
      { status: 200, body: { task_id: "t-1", status: "pending" } },
      { status: 200, body: { status: "pending" } },
      { status: 200, body: { status: "succeeded", url: "https://cdn.example/done.png" } },
      { status: 200, body: PNG_BYTES, contentType: "image/png" },
    ]);
    const result = await api.generate({ prompt: "p", size: "1024x1024", quality: "high", outputFormat: "png", n: 1 });
    expect(result.url).toMatch(/^data:image\/png;base64,/);
    expect(requests[1]!.url).toBe(`${GEN_URL}/t-1`);
    expect(requests[1]!.init?.method).toBe("GET");
  });

  it("任务失败状态 → 明确报错", async () => {
    const { api } = makeApi([
      { status: 200, body: { task_id: "t-2" } },
      { status: 200, body: { status: "failed", message: "content policy" } },
    ]);
    await expect(api.generate({ prompt: "p", size: "1024x1024", quality: "high", outputFormat: "png", n: 1 })).rejects.toThrow(
      /图像任务失败（status=failed）/,
    );
  });

  it("无法解析 → 错误携带响应体摘录（透明化）", async () => {
    const { api } = makeApi([{ status: 200, body: { code: 0, msg: "quota exceeded" } }]);
    await expect(api.generate({ prompt: "p", size: "1024x1024", quality: "high", outputFormat: "png", n: 1 })).rejects.toThrow(
      /响应无法解析[\s\S]*quota exceeded/,
    );
  });

  it("edit 响应同样走宽松解析", async () => {
    const { api, requests } = makeApi([
      { status: 200, body: { data: [{ url: "https://cdn.example/edit.png" }] } },
      { status: 200, body: PNG_BYTES, contentType: "image/png" },
    ]);
    const dataImg = `data:image/png;base64,${PNG_BYTES.toString("base64")}`;
    const result = await api.edit({
      images: [dataImg],
      prompt: "p",
      n: 1,
      size: "1024x1024",
      quality: "high",
      outputFormat: "png",
    });
    expect(result.url).toMatch(/^data:image\/png;base64,/);
    expect(requests.length).toBe(2);
  });
});
