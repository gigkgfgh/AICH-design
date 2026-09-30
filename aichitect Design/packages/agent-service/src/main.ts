/**
 * agent-service 入口（P006）：配置 → 组装工具绑定与 adapter → 启动本地网关 → 打印就绪信息。
 *
 * adapter 决策（降级路径）：
 * - AICH_ADAPTER=mock → MockAdapter（零 pi 依赖）；
 * - AICH_ADAPTER=pi 或 auto → 尝试动态加载 @earendil-works/pi-agent-core；
 *   安装失败（ENOTFOUND / 解析失败）→ 降级 MockAdapter 并打印告警（铁律 8）。
 *
 * 就绪输出（主进程 spawn 读取）：AICH_GATEWAY_READY {json}
 */

import { randomBytes } from "node:crypto";
import { mkdirSync } from "node:fs";
import * as nodePath from "node:path";
import { pathToFileURL } from "node:url";
import { loadConfig } from "./config.js";
import { IMAGE_GENERATE_TOOL_DEF, IMAGE_EDIT_TOOL_DEF, validateImageGenerateParams, validateImageEditParams } from "@aichdesign/extensions";
import { createMockChatStream, createMockModel } from "@aichdesign/mock-provider";
import { JsonlSessionStore } from "./session/jsonl-store.js";
import { UsageTracker } from "./telemetry/usage-tracker.js";
import { RunManager } from "./runtime/run-manager.js";
import { RetryingRuntime } from "./runtime/task-queue.js";
import { createHttpGateway } from "./gateway/http-server.js";
import { SessionTokenManager } from "./gateway/session-tokens.js";
import type { AgentRuntimePort } from "@aichdesign/shared";
import type { ToolBinding } from "./adapters/common.js";
import type { PiAgentCoreAdapterOptions } from "./adapters/pi-agent-core-adapter.js";
import { MockImageProvider, OpenAiImageApi, type ImageApiPort } from "./adapters/image-api.js";
import { ImageRegistry } from "./image/image-registry.js";
import { buildSearchToolBindings } from "./tools/search.js";
import { buildDispatchToolBinding } from "./tools/dispatch.js";
import { loadSkillsFromDirs, buildReadSkillBinding, skillsPromptSection } from "./skills/loader.js";
import type { ExternalSkill } from "./skills/loader.js";
import { AGENT_REGISTRATIONS } from "./agents/presets.js";

/**
 * 组装图像工具绑定（image-tools extension，P012）：
 * 参数校验走 extensions 约束层（§6.2）；执行经 ImageApiPort（真实 OpenAI / MockImageProvider）。
 * 绑定返回 { text, details: ImageApiResult, isError }——details 由 adapter 在工具执行成功后
 * 经 ImageRegistry 落盘并产生 SSE done image 载荷。
 */
export function buildImageToolBindings(port: ImageApiPort): ToolBinding[] {
  const generateBinding: ToolBinding = {
    def: IMAGE_GENERATE_TOOL_DEF,
    execute: async (params) => {
      const validation = validateImageGenerateParams(params);
      if (!validation.ok) {
        return {
          text: `image_generate 参数校验失败：${validation.errors.join("；")}`,
          details: { errors: validation.errors, warnings: validation.warnings },
          isError: true,
        };
      }
      try {
        const result = await port.generate(validation.value);
        return { text: `已生成表现图（${result.meta.width ?? "?"}x${result.meta.height ?? "?"}，cost $${result.meta.costUsd?.toFixed(4) ?? "?"}）`, details: result };
      } catch (error) {
        return { text: `image_generate 执行失败：${error instanceof Error ? error.message : String(error)}`, details: { error: String(error) }, isError: true };
      }
    },
  };
  const editBinding: ToolBinding = {
    def: IMAGE_EDIT_TOOL_DEF,
    execute: async (params) => {
      const validation = validateImageEditParams(params);
      if (!validation.ok) {
        return {
          text: `image_edit 参数校验失败：${validation.errors.join("；")}`,
          details: { errors: validation.errors, warnings: validation.warnings },
          isError: true,
        };
      }
      try {
        const result = await port.edit(validation.value);
        return { text: `已生成编辑图（${result.meta.width ?? "?"}x${result.meta.height ?? "?"}，cost $${result.meta.costUsd?.toFixed(4) ?? "?"}）`, details: result };
      } catch (error) {
        return { text: `image_edit 执行失败：${error instanceof Error ? error.message : String(error)}`, details: { error: String(error) }, isError: true };
      }
    },
  };
  return [generateBinding, editBinding];
}

/**
 * 图像端口决策（§6.2 与 AICH_ADAPTER 降级链同构；R6-14 多服务商）：
 * AICH_IMAGE_MOCK=1 强制 mock；否则按激活条目 → 任一有 Key 条目 → 旧单字段 → mock 选择。
 */
export function resolveImagePort(
  config: ReturnType<typeof loadConfig>,
  allowedLocalRoots?: string[],
): { port: ImageApiPort; label: string } {
  const { image } = config;
  if (!image.mock) {
    const pick =
      image.models.find((m) => m.id === image.activeId && m.apiKey.length > 0) ??
      image.models.find((m) => m.apiKey.length > 0);
    if (pick) {
      // R6-16：url/editUrl 为用户填写的完整端点，原样透传（零拼接）。
      return {
        port: new OpenAiImageApi({
          generationsUrl: pick.url,
          editsUrl: pick.editUrl || undefined,
          apiKey: pick.apiKey,
          model: pick.model,
          allowedLocalRoots,
        }),
        label: `openai-image:${pick.model}`,
      };
    }
  }
  if (image.mock || !image.apiKey) {
    if (!image.apiKey && !image.mock) {
      process.stderr.write("[warn] AICH_IMAGE_API_KEY 缺失，图像端口降级 MockImageProvider（离线兜底，§6.2）\n");
    }
    return { port: new MockImageProvider(), label: "mock-image" };
  }
  // 旧单字段回退（遗留契约：AICH_IMAGE_BASE_URL 为 API Base）——按原行为折算完整端点。
  const legacyBase = image.baseURL.replace(/\/+$/, "");
  return {
    port: new OpenAiImageApi({
      generationsUrl: `${legacyBase}/v1/images/generations`,
      editsUrl: `${legacyBase}/v1/images/edits`,
      apiKey: image.apiKey,
      model: image.model,
      allowedLocalRoots,
    }),
    label: "openai-image",
  };
}

/** 组装系统提示词（R6-2：通用建筑设计助手——领域专属约束下沉到各子 agent 预设；R6-3：外部技能 L1 注入）。 */
export function buildSystemPrompt(skills: ExternalSkill[] = []): string {
  const sections = [
    [
      "你是 AICH Design 的建筑设计助手，帮助用户完成从方案构思到成果呈现的全过程。图像表现为首要能力。",
      "通用约束：",
      "- 与用户沟通保持简洁专业；修改类请求必须保留用户显式要求（硬约束）；",
      "- 不确定用户意图时先澄清，再动手。",
    ].join("\n"),
  ];
  const skillsSection = skillsPromptSection(skills);
  if (skillsSection) sections.push(skillsSection);
  return sections.join("\n\n");
}

async function resolveAdapter(
  preferred: "auto" | "pi" | "mock",
  context: {
    tools: ToolBinding[];
    usageTracker: UsageTracker;
    sessionStore: JsonlSessionStore;
    imageRegistry: ImageRegistry;
    mockDelayMs: number;
    /** R5：真实 LLM 端点配置（旧单模型兼容）。 */
    llm?: ReturnType<typeof loadConfig>["llm"];
    /** R6-6：多模型条目。 */
    llmModels?: ReturnType<typeof loadConfig>["llmModels"];
    /** R6-6：激活条目 id。 */
    llmActiveId?: string;
    /** R6-8：全部技能（内置+用户合并，已排序）。 */
    skills?: ExternalSkill[];
    /** R6-12：Loops 上下文日志路径（设置开关开启时传入；undefined = 不记录）。 */
    loopLogPath?: string;
    /** R6-13：单次运行工具调用轮次上限（默认 25；≤0 = 不限制）。 */
    maxToolCalls?: number;
  },
): Promise<{ adapter: AgentRuntimePort; label: string }> {
  const { tools, usageTracker, sessionStore, imageRegistry, mockDelayMs, loopLogPath, maxToolCalls } = context;
  // P018：同 requestId 仅保留最后一次记账（重试不重复计费，ADR-006）。
  const usageSink = (r: Parameters<UsageTracker["record"]>[0]) => usageTracker.recordOnce(r);

  if (preferred !== "mock") {
    try {
      const pi = await import("@earendil-works/pi-agent-core");
      const { PiAgentCoreAdapter } = await import("./adapters/pi-agent-core-adapter.js");
      // R5：真实 LLM 接线——config.llm 齐备（设置面板已存 Key/BaseURL/模型）→ 真实流式；
      // 否则维持 mock 模型（既有降级链）。
      let model = createMockModel();
      let streamFn: import("@earendil-works/pi-agent-core").StreamFn = createMockChatStream({
        delayMs: mockDelayMs,
        chunkSize: 6,
      });
      let getApiKey: PiAgentCoreAdapterOptions["getApiKey"] = undefined;
      let buildModelOverride: PiAgentCoreAdapterOptions["buildModelOverride"] = undefined;
      let defaultThinking: PiAgentCoreAdapterOptions["defaultThinking"] = undefined;
      let label = `pi-agent-core@${pi.Agent ? "0.84.x" : ""}`;
      // R6-6：多模型（AICH_LLM_MODELS 齐备）优先——每条目独立 provider（按条目 Key 鉴权）；
      // 回退 R5 单模型（config.llm）；两者皆无 → mock。
      const llmModels = context.llmModels ?? [];
      const llmActiveId = context.llmActiveId ?? "";
      if (llmModels.length > 0) {
        const piAi = await import("@earendil-works/pi-ai");
        const { openAICompletionsApi } = await import("@earendil-works/pi-ai/api/openai-completions.lazy");
        const { buildLlmModel } = await import("./llm/model.js");
        const modelsRegistry = piAi.createModels();
        const keyByProvider = new Map<string, string>();
        let firstModel: import("@earendil-works/pi-ai").Model<"openai-completions"> | null = null;
        for (const entry of llmModels) {
          const providerId = `aich-llm-${entry.id}`;
          const m = buildLlmModel({ baseURL: entry.baseUrl, apiKeyRef: entry.apiKey, model: entry.model, imageInput: entry.imageInput, contextWindow: entry.contextWindow }, undefined, providerId);
          if (!m) continue;
          modelsRegistry.setProvider(
            piAi.createProvider({
              id: providerId,
              baseUrl: m.baseUrl,
              auth: { apiKey: { name: `AICH ${entry.name}`, resolve: async () => ({ auth: {} }) } },
              models: [m],
              api: openAICompletionsApi(),
            }),
          );
          keyByProvider.set(providerId, entry.apiKey);
          if (!firstModel || entry.id === llmActiveId) firstModel = entry.id === llmActiveId ? m : (firstModel ?? m);
          if (entry.id === llmActiveId && ["low", "medium", "high", "xhigh", "max"].includes(entry.thinking)) {
            defaultThinking = entry.thinking as import("@aichdesign/shared").ThinkingLevel;
          }
        }
        if (firstModel) {
          model = firstModel;
          streamFn = modelsRegistry.streamSimple.bind(modelsRegistry) as import("@earendil-works/pi-agent-core").StreamFn;
          getApiKey = (provider) => keyByProvider.get(provider);
          const entries = llmModels;
          buildModelOverride = (modelId: string) => {
            const hit = entries.find((e) => e.model === modelId || e.id === modelId);
            if (!hit) return buildLlmModel({ baseURL: entries[0]!.baseUrl, apiKeyRef: entries[0]!.apiKey, model: modelId, imageInput: entries[0]!.imageInput, contextWindow: entries[0]!.contextWindow }, undefined, `aich-llm-${entries[0]!.id}`)!;
            return buildLlmModel({ baseURL: hit.baseUrl, apiKeyRef: hit.apiKey, model: hit.model, imageInput: hit.imageInput, contextWindow: hit.contextWindow }, undefined, `aich-llm-${hit.id}`)!;
          };
          label = `llm×${llmModels.length}:${firstModel.id}`;
          process.stderr.write(`[agent-service] 多模型已接线 ${llmModels.map((e) => e.model).join("、")}（激活 ${firstModel.id}）\n`);
        }
      } else if (context.llm?.provider === "openai-compatible") {
        const llm = context.llm;
        const { buildLlmModel, LLM_PROVIDER_ID } = await import("./llm/model.js");
        const realModel = buildLlmModel({
          baseURL: llm.baseURL ?? "",
          apiKeyRef: llm.apiKeyRef ?? "",
          model: llm.model ?? "",
        });
        if (realModel) {
          const piAi = await import("@earendil-works/pi-ai");
          const { openAICompletionsApi } = await import("@earendil-works/pi-ai/api/openai-completions.lazy");
          const provider = piAi.createProvider({
            id: LLM_PROVIDER_ID,
            baseUrl: realModel.baseUrl,
            auth: { apiKey: { name: "AICH LLM", resolve: async () => ({ auth: {} }) } },
            models: [realModel],
            api: openAICompletionsApi(),
          });
          const models = piAi.createModels();
          models.setProvider(provider);
          model = realModel;
          streamFn = models.streamSimple.bind(models) as import("@earendil-works/pi-agent-core").StreamFn;
          const apiKey = llm.apiKeyRef ?? "";
          getApiKey = () => apiKey;
          const llmCfg = { baseURL: llm.baseURL ?? "", apiKeyRef: apiKey, model: llm.model ?? "" };
          buildModelOverride = (id: string) => buildLlmModel(llmCfg, id)!;
          label = `llm:${realModel.id}`;
          process.stderr.write(`[agent-service] 真实 LLM 已接线 ${realModel.baseUrl} model=${realModel.id}\n`);
        }
      }
      // R6-8：全部技能（内置+外部同机制）——统一列表注入 + read_skill 按需取全文（start() 已合并加载）。
      const externalSkills: ExternalSkill[] = context.skills ?? [];
      if (externalSkills.length > 0) {
        process.stderr.write(`[agent-service] 技能已加载：${externalSkills.map((s) => s.name).join("、")}\n`);
      }
      const readSkillBinding = buildReadSkillBinding(externalSkills);
      // R6-8：按注册表钉住技能（正文进系统提示、allowedTools 过滤工具）。
      const registrations = Object.fromEntries(
        Object.values(AGENT_REGISTRATIONS).map((reg) => {
          const skill = reg.skillName ? externalSkills.find((sk) => sk.name === reg.skillName) : undefined;
          return [reg.id, { ...reg, ...(skill ? { skillBody: skill.body, allowedTools: skill.allowedTools } : {}) }];
        }),
      );
      const adapter = new PiAgentCoreAdapter({
        model,
        streamFn,
        getApiKey,
        buildModelOverride,
        systemPrompt: buildSystemPrompt(externalSkills),
        registrations,
        defaultThinking,
        tools: readSkillBinding ? [...tools, readSkillBinding] : tools,
        usageSink,
        sessionStore,
        imageRegistry,
        // R6-12/R6-13：Loops 日志路径 + 工具调用轮次上限透传。
        loopLogPath,
        maxToolCalls,
      });
      return { adapter, label };
    } catch (error) {
      if (preferred === "pi") {
        // 显式要求 pi 但不可用：fail-closed 拒绝启动（与沙箱策略一致的严格模式）。
        throw new Error(`AICH_ADAPTER=pi 但 pi-agent-core 依赖不可用：${(error as Error).message}`);
      }
      process.stderr.write(`[warn] pi-agent-core 依赖不可用，降级 MockAdapter：${(error as Error).message}\n`);
    }
  }

  const { MockAdapter } = await import("./adapters/mock-adapter.js");
  const adapter = new MockAdapter({ tools, usageSink, sessionStore, imageRegistry, delayMs: mockDelayMs });
  return { adapter, label: "mock" };
}

export async function start(overrides: Partial<ReturnType<typeof loadConfig>> = {}): Promise<{
  url: string;
  port: number;
  token: string;
  adapterLabel: string;
  stop: () => Promise<void>;
}> {
  const config = { ...loadConfig(), ...overrides };
  const token = config.token ?? `aich_${randomBytes(24).toString("hex")}`;
  const sessionStore = new JsonlSessionStore(config.sessionsDir);
  const usageTracker = new UsageTracker();
  const imageRegistry = new ImageRegistry(config.sessionsDir, sessionStore);
  // R7-1：从会话 jsonl 重建 imageId→file:// 映射（修复重启后注册表失效、上传图"读不到"）。
  const rehydratedImages = imageRegistry.rehydrate();
  if (rehydratedImages > 0) {
    process.stderr.write(`[agent-service] 图像注册表已从会话记录回填 ${rehydratedImages} 条
`);
  }
  const { port: imagePort, label: imageLabel } = resolveImagePort(config, [imageRegistry.dir]);
  const tools = [
    ...buildImageToolBindings(imagePort),
    // R5：联网检索工具（research 预设专用；默认 disabled 时工具返回引导文案）
    ...buildSearchToolBindings(config.search),
    // R6-9：主 Agent 自主分派工具（子 agent 白名单不含它，天然仅 main 可用）
    buildDispatchToolBinding(),
  ];

  // R6-9/R6-12：Agent Loops 上下文日志文件（sessionsDir 同级的 logs/agent-loops.jsonl）。
  // 仅开关（AICH_LOOP_LOG=1）开启时启用并传给适配器；关闭时不建目录不落盘。
  const loopLogPath = config.loopLog
    ? nodePath.resolve(config.sessionsDir, "..", "logs", "agent-loops.jsonl")
    : undefined;
  if (loopLogPath) mkdirSync(nodePath.dirname(loopLogPath), { recursive: true });
  // R6-8：技能合并加载（内置目录 + 用户目录，同名用户覆盖；image-gen 首要排序）。
  const externalSkills = loadSkillsFromDirs(
    [config.builtinSkillsDir, config.skillsDir].filter((d): d is string => !!d && d.length > 0),
    ["image-gen", "research"],
  );

  const { adapter, label } = await resolveAdapter(config.adapter, {
    tools,
    usageTracker,
    sessionStore,
    imageRegistry,
    mockDelayMs: config.mockDelayMs,
    llm: config.llm,
    llmModels: config.llmModels,
    llmActiveId: config.llmActiveId,
    loopLogPath,
    maxToolCalls: config.maxToolCalls,
    skills: externalSkills,
  });
  // P018：任务队列补强——启动级指数退避重试 + 死信登记 + 图像成本护栏（包裹内层 adapter）。
  const runtime = new RetryingRuntime({
    inner: adapter,
    policy: { maxRetries: config.queue.maxRetries, baseDelayMs: config.queue.retryBaseDelayMs },
    sessionStore,
    imageCostLimitUsd: config.queue.imageCostLimitUsd,
    imageCostUsed: () => usageTracker.costUsdByKinds(["genImage", "editImage"]),
  });
  const runManager = new RunManager(runtime);
  const sessionTokens = new SessionTokenManager();
  const gateway = await createHttpGateway({
    adapterLabel: label,
    token,
    runManager,
    usageTracker,
    sessionTokens,
    imageRegistry,
    skills: externalSkills,
    host: config.host,
    port: config.port,
  });

  const ready = { url: gateway.url, token, adapter: label, image: imageLabel, pid: process.pid };
  process.stdout.write(`AICH_GATEWAY_READY ${JSON.stringify(ready)}\n`);

  return {
    url: gateway.url,
    port: gateway.port,
    token,
    adapterLabel: label,
    stop: async () => {
      await gateway.close();
      await adapter.dispose();
    },
  };
}

/** 直接运行（bin 入口）。 */
async function main(): Promise<void> {
  const gateway = await start();
  process.stderr.write(`[agent-service] 就绪 ${gateway.url} adapter=${gateway.adapterLabel}\n`);

  const shutdown = async (signal: string) => {
    process.stderr.write(`[agent-service] 收到 ${signal}，关闭中…\n`);
    await gateway.stop();
    process.exit(0);
  };
  process.on("SIGINT", () => void shutdown("SIGINT"));
  process.on("SIGTERM", () => void shutdown("SIGTERM"));
}

// bin 直跑判定（main.ts 作为入口时执行；作为库导入时不自动启动）。
if (import.meta.url === pathToFileURL(process.argv[1] ?? "").href) {
  void main().catch((error) => {
    process.stderr.write(`[agent-service] 启动失败：${(error as Error).message}\n`);
    process.exit(1);
  });
}