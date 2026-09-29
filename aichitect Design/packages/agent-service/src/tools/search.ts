/**
 * 联网检索工具（R5：research 子 agent 专用）——开源方案 SearXNG 集成。
 *
 * 方案依据（开源事实标准）：SearXNG 自托管元搜索的 JSON API（?format=json）是主流开源
 * Agent 框架的接入方式（本地 Docker 部署、无 Key、聚合多引擎）；备用 DuckDuckGo HTML
 * 端点（无 Key）。provider 可经设置面板配置，默认 disabled（工具返回引导文案）。
 *
 * 安全（SSRF 防护，fetch_page）：
 * - 仅 http/https；拒绝 loopback/私网/链路本地/唯一本地地址（防打本地网关与内网）；
 * - 域名解析后校验 IP（DNS 重绑定防护：解析结果任一 IP 落私网即拒绝）；
 * - 响应大小上限 2MB、截断输出 32KB、超时 15s。
 */

import { lookup } from "node:dns/promises";
import { randomUUID } from "node:crypto";
import type { ToolBinding } from "../adapters/common.js";

export type SearchProvider = "disabled" | "searxng" | "duckduckgo" | "deepseek";

export interface SearchConfig {
  provider: SearchProvider;
  /** SearXNG 搜索端点（含 /search），如 http://127.0.0.1:8888/search。 */
  baseUrl: string;
  /** R6-11：DeepSeek 官方服务端联网（Responses API web_search 工具）。 */
  deepseek?: { baseUrl: string; model: string; apiKey: string };
}

/** 检索结果条目。 */
export interface SearchResultItem {
  title: string;
  url: string;
  snippet: string;
}

/** ---------- SSRF 防护 ---------- */

function isPrivateIp(ip: string): boolean {
  if (ip === "::1" || ip === "::ffff:127.0.0.1") return true;
  if (ip.startsWith("127.") || ip.startsWith("10.") || ip.startsWith("192.168.") || ip.startsWith("169.254.")) return true;
  if (ip.startsWith("172.")) {
    const second = Number(ip.split(".")[1]);
    if (Number.isFinite(second) && second >= 16 && second <= 31) return true;
  }
  if (ip.startsWith("fc") || ip.startsWith("fd") || ip === "0.0.0.0") return true;
  return false;
}

/**
 * 公网 http(s) URL 校验（SSRF 防护）：协议白名单 + 域名字面量 + DNS 解析结果私网拒绝。
 * 返回错误信息（拒绝原因）；通过返回 null。
 */
export async function assertPublicHttpUrl(raw: string): Promise<string | null> {
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    return "URL 非法";
  }
  if (url.protocol !== "http:" && url.protocol !== "https:") {
    return "仅支持 http/https";
  }
  const host = url.hostname.toLowerCase().replace(/^\[|\]$/g, "");
  if (host === "localhost" || host.endsWith(".localhost") || host.endsWith(".local") || host === "metadata.google.internal") {
    return "拒绝本地/内网地址";
  }
  if (isPrivateIp(host)) {
    return "拒绝私网地址";
  }
  // DNS 解析校验（含 IPv6；任一解析结果私网即拒绝——防 DNS 重绑定至内网）
  try {
    const addresses = await lookup(host, { all: true });
    if (addresses.length === 0) return "域名无法解析";
    for (const { address } of addresses) {
      if (isPrivateIp(address)) return "域名解析到内网地址，拒绝";
    }
  } catch {
    return "域名解析失败";
  }
  return null;
}

/** ---------- HTML → 纯文本（去脚本样式，压缩空白） ---------- */

export function htmlToText(html: string): string {
  return html
    .replace(/<script[\s\S]*?<\/script>/gi, " ")
    .replace(/<style[\s\S]*?<\/style>/gi, " ")
    .replace(/<!--[\s\S]*?-->/g, " ")
    .replace(/<[^>]+>/g, " ")
    .replace(/&nbsp;/g, " ")
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/\s+/g, " ")
    .trim();
}

/** ---------- 检索 provider 实现 ---------- */

async function searchSearXng(config: SearchConfig, query: string, maxResults: number): Promise<SearchResultItem[]> {
  const endpoint = `${config.baseUrl.replace(/\/+$/, "")}?q=${encodeURIComponent(query)}&format=json`;
  const res = await fetch(endpoint, { signal: AbortSignal.timeout(10_000) });
  if (!res.ok) throw new Error(`SearXNG ${res.status}`);
  const body = (await res.json()) as { results?: Array<{ title?: string; url?: string; content?: string }> };
  return (body.results ?? [])
    .filter((r) => typeof r.url === "string" && typeof r.title === "string")
    .slice(0, maxResults)
    .map((r) => ({ title: String(r.title), url: String(r.url), snippet: (r.content ?? "").slice(0, 300) }));
}

async function searchDuckDuckGo(query: string, maxResults: number): Promise<SearchResultItem[]> {
  const res = await fetch(`https://html.duckduckgo.com/html/?q=${encodeURIComponent(query)}`, {
    signal: AbortSignal.timeout(10_000),
    headers: { "user-agent": "Mozilla/5.0 (compatible; AICHDesign/0.1)" },
  });
  if (!res.ok) throw new Error(`DuckDuckGo ${res.status}`);
  const html = (await res.text()).slice(0, 2 * 1024 * 1024);
  const items: SearchResultItem[] = [];
  // DDG HTML 结果结构：<a class="result__a" href="...">title</a> + <a class="result__snippet">
  const re = /<a[^>]+class="result__a"[^>]+href="([^"]+)"[^>]*>([\s\S]*?)<\/a>[\s\S]*?class="result__snippet"[^>]*>([\s\S]*?)<\/a>/g;
  for (const m of html.matchAll(re)) {
    let url = m[1]!;
    // DDG 跳转包装：uddg=<encoded>
    const uddg = /[?&]uddg=([^&]+)/.exec(url);
    if (uddg) url = decodeURIComponent(uddg[1]!);
    items.push({ title: htmlToText(m[2] ?? "").slice(0, 200), url, snippet: htmlToText(m[3] ?? "").slice(0, 300) });
    if (items.length >= maxResults) break;
  }
  return items;
}

/**
 * DeepSeek 官方服务端联网（R6-11）：Responses API + tools:[{type:"web_search"}]。
 * chat/completions 不支持内置搜索；Responses（V4 系列）由服务端执行 web_search 并返回
 * url_citation 注解。返回要点列表；无注解时从文本抽 URL 兜底。
 */
export async function searchDeepSeek(
  cfg: NonNullable<SearchConfig["deepseek"]>,
  query: string,
  maxResults: number,
): Promise<SearchResultItem[]> {
  const base = cfg.baseUrl.replace(/\/+$/, "");
  const res = await fetch(base + "/responses", {
    method: "POST",
    headers: { authorization: `Bearer ${cfg.apiKey}`, "content-type": "application/json" },
    body: JSON.stringify({
      model: cfg.model,
      input: `联网检索「${query}」，输出与该查询最相关的要点列表，每条附来源链接。`,
      tools: [{ type: "web_search" }],
    }),
    // R6-12：120s（原 30s 会掐断 DeepSeek 服务端 agentic 搜索——实测长搜索常超 30s，
    // 超时后模型重试、累计拖垮整个 run）。适配器空闲超时在工具执行期间暂停，不会双重拦截。
    signal: AbortSignal.timeout(120_000),
  });
  if (!res.ok) {
    const errText = await safeTextLike(res);
    throw new Error(`DeepSeek Responses ${res.status}：${errText.slice(0, 200)}`);
  }
  const body = (await res.json()) as {
    output?: Array<{ type?: string; content?: Array<{ type?: string; text?: string; annotations?: Array<{ type?: string; url?: string; title?: string }> }> }>;
  };
  let text = "";
  const citations: SearchResultItem[] = [];
  for (const item of body.output ?? []) {
    for (const part of item.content ?? []) {
      if (typeof part.text === "string") text += part.text + "\n";
      for (const ann of part.annotations ?? []) {
        if (ann.type === "url_citation" && ann.url) {
          citations.push({ title: ann.title ?? ann.url, url: ann.url, snippet: "" });
        }
      }
    }
  }
  const trimmed = text.slice(0, 4000);
  if (citations.length > 0) {
    return citations.slice(0, maxResults).map((c) => ({ ...c, snippet: (c.snippet || trimmed).slice(0, 300) }));
  }
  const urlRe = /https?:\/\/[^\s)\]]+/g;
  const urls = [...trimmed.matchAll(urlRe)].slice(0, maxResults);
  if (urls.length > 0) {
    return urls.map((m) => ({ title: m[0]!, url: m[0], snippet: trimmed.slice(0, 300) }));
  }
  return [{ title: `DeepSeek 联网结果（${query}）`, url: "", snippet: trimmed.slice(0, 600) }];
}

async function safeTextLike(res: Response): Promise<string> {
  try { return await res.text(); } catch { return "<不可读>"; }
}

export async function webSearch(config: SearchConfig, query: string, maxResults = 6): Promise<SearchResultItem[]> {
  if (config.provider === "disabled") return [];
  if (config.provider === "deepseek") {
    if (!config.deepseek?.apiKey || !config.deepseek.baseUrl) throw new Error("DeepSeek 联网未配置（需在密钥管理中配置 baseUrl 含 api.deepseek.com 的模型条目）");
    return searchDeepSeek(config.deepseek, query, maxResults);
  }
  if (config.provider === "searxng") {
    if (!config.baseUrl) throw new Error("SearXNG 端点未配置");
    return searchSearXng(config, query, maxResults);
  }
  return searchDuckDuckGo(query, maxResults);
}

/** ---------- 工具绑定（research 预设专用） ---------- */

export function buildSearchToolBindings(config: SearchConfig): ToolBinding[] {
  const enabled = config.provider !== "disabled";

  const searchBinding: ToolBinding = {
    def: {
      name: "web_search",
      description:
        "联网检索：按关键词返回网页结果列表 [{title,url,snippet}]。用于案例调研/规范查询/材料与造价参考。仅在需要外部信息时使用。",
      label: "联网检索",
      parameters: {
        type: "object",
        properties: {
          query: { type: "string", description: "检索关键词（中文或英文）" },
          maxResults: { type: "number", description: "返回条数上限，默认 6" },
        },
        required: ["query"],
      },
    },
    execute: async (params) => {
      const query = typeof params["query"] === "string" ? params["query"].trim() : "";
      if (!query) return { text: "web_search 参数错误：query 不能为空", isError: true };
      if (!enabled) {
        return {
          text: "联网检索未启用：请在「设置 → 联网检索」配置搜索服务（推荐本地部署 SearXNG，docker run -p 8888:8080 searxng/searxng，并在 settings.yml 开启 search.formats: [json]）。",
          isError: true,
        };
      }
      try {
        const maxResults = typeof params["maxResults"] === "number" && params["maxResults"] > 0 ? Math.min(Math.floor(params["maxResults"]), 10) : 6;
        const items = await webSearch(config, query, maxResults);
        if (items.length === 0) return { text: `未检索到结果（${query}）`, details: { results: [] } };
        const lines = items.map((r, i) => `${i + 1}. ${r.title}\n   ${r.url}\n   ${r.snippet}`);
        return { text: `检索「${query}」共 ${items.length} 条：\n${lines.join("\n")}`, details: { results: items } };
      } catch (error) {
        return { text: `检索失败：${error instanceof Error ? error.message : String(error)}`, isError: true };
      }
    },
  };

  const fetchBinding: ToolBinding = {
    def: {
      name: "fetch_page",
      description: "抓取公网网页并转为纯文本（≤32KB）。用于读取 web_search 结果中的页面全文。",
      label: "网页抓取",
      parameters: {
        type: "object",
        properties: { url: { type: "string", description: "公网 http(s) 页面地址" } },
        required: ["url"],
      },
    },
    execute: async (params, signal) => {
      const url = typeof params["url"] === "string" ? params["url"].trim() : "";
      const rejected = await assertPublicHttpUrl(url);
      if (rejected || !url) {
        return { text: `fetch_page 拒绝：${rejected ?? "URL 为空"}（仅允许公网 http/https）`, isError: true };
      }
      try {
        const res = await fetch(url, {
          signal: signal ?? AbortSignal.timeout(15_000),
          headers: { "user-agent": "Mozilla/5.0 (compatible; AICHDesign/0.1)" },
        });
        if (!res.ok) return { text: `页面请求失败 HTTP ${res.status}`, isError: true };
        const raw = (await res.text()).slice(0, 2 * 1024 * 1024);
        const text = htmlToText(raw).slice(0, 32 * 1024);
        if (!text) return { text: "页面无可提取文本", isError: true };
        return { text, details: { url, fetchedAt: new Date().toISOString() } };
      } catch (error) {
        if ((error as Error).name === "TimeoutError" || signal?.aborted) return { text: "页面抓取超时/中止", isError: true };
        return { text: `页面抓取失败：${error instanceof Error ? error.message : String(error)}`, isError: true };
      }
    },
  };

  return [searchBinding, fetchBinding];
}

/** 生成上传参考图占位 id（与 image-registry 命名对齐；主用 /v1/images 注册）。 */
export function newUploadImageId(): string {
  return `img_up_${randomUUID().slice(0, 8)}`;
}
