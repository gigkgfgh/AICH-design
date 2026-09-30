/**
 * agent-service 运行配置（环境变量注入；真实 provider 密钥由主进程 KeyStore 注入，P016）。
 */

export interface AgentServiceConfig {
  /** adapter 选择：auto（优先 pi-agent-core，失败降级 mock）/ pi / mock。默认 auto。 */
  adapter: "auto" | "pi" | "mock";
  /** 监听主机，固定 127.0.0.1（修订①）。 */
  host: string;
  /** 端口；0 = 随机（修订①）。 */
  port: number;
  /** Bearer token；缺省自动生成随机 token。 */
  token: string | null;
  /** 会话 jsonl 目录；缺省 <cwd>/.data/sessions。 */
  sessionsDir: string;
  /** LLM provider 配置（真实链路 P016 注入密钥后才启用；M1 默认 mock）。 */
  llm: {
    provider: "mock" | "openai-compatible";
    baseURL: string | null;
    apiKeyRef: string | null;
    model: string | null;
  } | null;
  /** mock 流式延迟（毫秒）。 */
  mockDelayMs: number;
  /** P012 图像端口（§6.2：独立于 LLM，可指向任意 OpenAI 兼容端点）。 */
  image: {
    /** AICH_IMAGE_BASE_URL，默认 OpenAI 官方（https://api.openai.com/v1）。 */
    baseURL: string;
    /** AICH_IMAGE_API_KEY（P016 KeyStore 前由环境注入；缺省自动 mock 降级）。 */
    apiKey: string | null;
    /** AICH_IMAGE_MOCK=1 强制 mock；与 Key 缺失自动降级同效。 */
    mock: boolean;
    /** AICH_IMAGE_MODEL，默认 gpt-image-2（§6.2）。 */
    model: string;
    /** R6-14/R6-16：多图像条目（url=完整生成端点；editUrl=完整编辑端点可空；AICH_IMAGE_MODELS JSON，Key 明文仅进程内）。 */
    models: Array<{ id: string; name: string; url: string; editUrl: string; model: string; apiKey: string }>;
    /** R6-14：激活图像条目 id（AICH_IMAGE_ACTIVE_ID）。 */
    activeId: string;
  };
  /** P018 任务队列：启动级重试 + 图像成本护栏。 */
  queue: {
    /** AICH_RUN_MAX_RETRIES，瞬态失败重试次数（不含首次），默认 2。 */
    maxRetries: number;
    /** AICH_RUN_RETRY_BASE_MS，退避基数，默认 500（倍增 500→1000）。 */
    retryBaseDelayMs: number;
    /** AICH_IMAGE_COST_LIMIT_USD，图像成本护栏上限；≤0 关闭，默认 0.5。 */
    imageCostLimitUsd: number;
  };
  /** R5：联网检索（research 子 agent 的 web_search/fetch_page 工具）。 */
  search: {
    /** AICH_SEARCH_PROVIDER：disabled（默认）/ searxng / duckduckgo。 */
    provider: "disabled" | "searxng" | "duckduckgo" | "deepseek";
    /** AICH_SEARCH_BASE_URL：SearXNG 搜索端点（含 /search）。 */
    baseUrl: string;
    /** R6-11：DeepSeek 官方联网（Responses API）。 */
    deepseek: { baseUrl: string; model: string; apiKey: string };
  };
  /** R6-3：外部技能目录（<dir>/<name>/SKILL.md；AICH_SKILLS_DIR，空 = 不加载）。 */
  skillsDir: string;
  /** R6-8：内置技能目录（产品自带 SKILL.md；AICH_BUILTIN_SKILLS_DIR）。 */
  builtinSkillsDir: string;
  /** R6-6：多模型条目（AICH_LLM_MODELS JSON；key 明文仅进程内；imageInput=端点支持图像输入）。 */
  llmModels: Array<{ id: string; name: string; baseUrl: string; model: string; apiKey: string; thinking: string; imageInput: boolean; contextWindow: number }>;
  /** R6-6：激活条目 id。 */
  llmActiveId: string;
  /** R6-9：Agent Loops 上下文日志（AICH_LOOP_LOG，默认关）。 */
  loopLog: boolean;
  /** R6-13：单次运行工具调用轮次上限（AICH_AGENT_MAX_TOOL_CALLS，默认 25，钳位 1~200）。 */
  maxToolCalls: number;
}

function env(name: string): string | null {
  const value = process.env[name];
  return value === undefined || value === "" ? null : value;
}

function envNumber(name: string, fallback: number): number {
  const raw = env(name);
  if (raw === null) return fallback;
  const n = Number(raw);
  return Number.isFinite(n) ? n : fallback;
}

export function loadConfig(): AgentServiceConfig {
  const rawAdapter = env("AICH_ADAPTER") ?? "auto";
  const adapter: AgentServiceConfig["adapter"] =
    rawAdapter === "pi" || rawAdapter === "mock" ? rawAdapter : "auto";
  const portRaw = env("AICH_PORT");
  const port = portRaw ? Number(portRaw) : 0;

  const llm = env("AICH_PROVIDER");
  return {
    adapter,
    host: "127.0.0.1",
    port: Number.isFinite(port) && port >= 0 ? Math.floor(port) : 0,
    token: env("AICH_TOKEN"),
    sessionsDir: env("AICH_SESSIONS_DIR") ?? ".data/sessions",
    llm:
      llm === "openai-compatible"
        ? {
            provider: "openai-compatible",
            baseURL: env("AICH_LLM_BASE_URL"),
            apiKeyRef: env("AICH_LLM_API_KEY_REF"),
            model: env("AICH_LLM_MODEL"),
          }
        : null,
    mockDelayMs: Number(env("AICH_MOCK_DELAY_MS") ?? "30"),
    image: {
      baseURL: env("AICH_IMAGE_BASE_URL") ?? "https://api.openai.com/v1",
      apiKey: env("AICH_IMAGE_API_KEY"),
      mock: (env("AICH_IMAGE_MOCK") ?? "0") === "1",
      model: env("AICH_IMAGE_MODEL") ?? "gpt-image-2",
      models: (() => {
        // R6-14：与 llmModels 同构校验（字段齐备才收；坏 JSON 静默为空）。
        try {
          const raw: unknown = JSON.parse(env("AICH_IMAGE_MODELS") ?? "[]");
          if (!Array.isArray(raw)) return [];
          return raw
            .filter(
              (m): m is Record<string, unknown> =>
                typeof m === "object" &&
                m !== null &&
                typeof (m as Record<string, unknown>).url === "string" &&
                typeof (m as Record<string, unknown>).model === "string" &&
                typeof (m as Record<string, unknown>).apiKey === "string",
            )
            .map((m, i) => ({
              id: typeof m.id === "string" ? m.id : `img-${i}`,
              name: typeof m.name === "string" ? m.name : "未命名图像端点",
              url: String(m.url),
              editUrl: typeof m.editUrl === "string" ? m.editUrl : "",
              model: String(m.model),
              apiKey: String(m.apiKey),
            }));
        } catch {
          return [];
        }
      })(),
      activeId: env("AICH_IMAGE_ACTIVE_ID") ?? "",
    },
    queue: {
      maxRetries: Math.max(0, Math.floor(envNumber("AICH_RUN_MAX_RETRIES", 2))),
      retryBaseDelayMs: Math.max(0, Math.floor(envNumber("AICH_RUN_RETRY_BASE_MS", 500))),
      imageCostLimitUsd: envNumber("AICH_IMAGE_COST_LIMIT_USD", 0.5),
    },
    search: {
      provider: (() => {
        const raw = env("AICH_SEARCH_PROVIDER");
        return raw === "searxng" || raw === "duckduckgo" || raw === "deepseek" ? raw : "disabled";
      })(),
      baseUrl: env("AICH_SEARCH_BASE_URL") ?? "",
      deepseek: {
        baseUrl: env("AICH_SEARCH_DEEPSEEK_BASE_URL") ?? "https://api.deepseek.com",
        model: env("AICH_SEARCH_DEEPSEEK_MODEL") ?? "deepseek-chat",
        apiKey: env("AICH_SEARCH_DEEPSEEK_KEY") ?? "",
      },
    },
    skillsDir: env("AICH_SKILLS_DIR") ?? "",
    builtinSkillsDir: env("AICH_BUILTIN_SKILLS_DIR") ?? "",
    llmModels: (() => {
      const raw = env("AICH_LLM_MODELS");
      if (!raw) return [];
      try {
        const parsed = JSON.parse(raw) as Array<Record<string, unknown>>;
        return parsed
          .filter((m) => typeof m.baseUrl === "string" && typeof m.model === "string" && typeof m.apiKey === "string")
          .map((m, i) => ({
            id: typeof m.id === "string" ? m.id : `m-${i}`,
            name: typeof m.name === "string" ? m.name : "未命名",
            baseUrl: String(m.baseUrl),
            model: String(m.model),
            apiKey: String(m.apiKey),
            thinking: typeof m.thinking === "string" ? m.thinking : "off",
            // R7-1：默认支持图像输入（DeepSeek 官方等视觉端点开箱即用）；纯文本端点经设置关闭。
            imageInput: m.imageInput !== false,
            // R7-2：条目级上下文窗口（<=0/缺省 = 服务端默认）。
            contextWindow: Number(m.contextWindow) > 0 ? Math.floor(Number(m.contextWindow)) : 0,
          }));
      } catch {
        return [];
      }
    })(),
    llmActiveId: env("AICH_LLM_ACTIVE_ID") ?? "",
    loopLog: env("AICH_LOOP_LOG") === "1",
    maxToolCalls: Math.min(200, Math.max(1, Math.floor(envNumber("AICH_AGENT_MAX_TOOL_CALLS", 25)))),
  };
}