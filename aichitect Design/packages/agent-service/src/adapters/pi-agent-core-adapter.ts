/**
 * PiAgentCoreAdapter：AgentRuntimePort 的 pi-agent-core 0.84.x 默认实现（§3.3 G3）。
 *
 * 职责：
 * - 每会话一个 Agent 实例（会话上下文隔离，agent.state.messages 为该会话转录）；
 * - 将 pi AgentEvent 流适配为产品 SSE 信封（delta / partial / done / error）；
 * - 工具绑定（extensions 组装）→ AgentTool（TypeBox 参数 + execute）；
 * - turn_end 提取 Usage → usage/cost 埋点（C-6 自 M1）。
 *
 * 依赖注入：streamFn（mock 或真实 provider）、model、systemPrompt（含 Skill L1 元数据）。
 * 该文件仅在本包依赖安装成功后由 main.ts 动态加载；安装失败走 MockAdapter 兜底。
 */

import type {
  AgentEvent,
  AgentMessage,
  AgentTool,
  AgentToolResult,
  StreamFn,
} from "@earendil-works/pi-agent-core";
import { Agent } from "@earendil-works/pi-agent-core";
import { appendFileSync, mkdirSync, readFileSync } from "node:fs";
import { dirname } from "node:path";
import { fileURLToPath } from "node:url";
import type { Api, Model, TextContent } from "@earendil-works/pi-ai";
import type { AgentRegistration } from "../agents/presets.js";
import type {
  AgentRuntimePort,
  AgentResponse,
  RunHandle,
  RunRequest,
  RunStatus,
  SseEventEnvelope,
  SseUsageData,
} from "@aichdesign/shared";
import { ErrorCode, makeEnvelope } from "@aichdesign/shared";
import { AsyncQueue } from "../runtime/async-queue.js";
import { replayTranscript } from "../session/transcript-replay.js";
import { JsonlSessionStore } from "../session/jsonl-store.js";
import type { UsageRecord } from "../telemetry/usage-tracker.js";
import { findBinding, promptOf, type ToolBinding } from "./common.js";
import { DEEPSEEK_THINKING_LEVEL_MAP, isDeepSeekBaseUrl } from "../llm/model.js";
import type { ImageApiResult } from "./image-api.js";
import type { ImageRegisterContext, ImageRegistry, RegisteredImage } from "../image/image-registry.js";

/**
 * 运行空闲超时（R6-12：原"整 run 一次性 120s"会误杀联网检索等长工具循环 run——
 * 实测用户搜索请求恰在 120.012s 被强杀）。改为空闲判定：内核有事件即重置；
 * 工具执行期间暂停（工具自带超时：search 120s / image 180s / fetch 15s），由总上限兜底。
 */
export const RUN_IDLE_TIMEOUT_MS = 120_000;
/** 运行总上限（ runaway 兜底：工具重试/慢流式叠加也不应超过 10 分钟）。 */
export const RUN_TOTAL_TIMEOUT_MS = 10 * 60 * 1000;

export interface PiAgentCoreAdapterOptions {
  model: Model<Api>;
  streamFn: StreamFn;
  /** 系统提示词（含全部 Skill L1 元数据；由 main 组装）。 */
  systemPrompt: string;
  tools: ToolBinding[];
  getApiKey?: (provider: string) => Promise<string | undefined> | string | undefined;
  usageSink: (r: UsageRecord) => void;
  sessionStore?: JsonlSessionStore;
  /** P012/B-4：图像产物落盘 + 会话元数据注册（genImage/editImage 链路）。 */
  imageRegistry?: ImageRegistry;
  /**
   * R5：按次模型覆盖——信封 model 字段 → 重建 Model（同 provider/baseUrl 换 id）。
   * 缺省忽略覆盖（始终用 options.model）。
   */
  buildModelOverride?: (modelId: string) => Model<Api>;
  /** R6-6：默认思考档（激活模型条目的 thinking；信封未指定时生效）。 */
  defaultThinking?: import("@aichdesign/shared").ThinkingLevel;
  /** R6-9：Agent Loops 上下文日志文件路径（undefined = 不记录）。 */
  loopLogPath?: string;
  /**
   * R6-13：单次运行工具调用轮次上限（pi 内核 while(true) 无 maxTurns，宿主侧封顶防活跃死循环）。
   * 来源：设置 → Agent（AICH_AGENT_MAX_TOOL_CALLS），默认 25；≤0 = 不限制（不推荐）。
   */
  maxToolCalls?: number;
  /**
   * R6-8：agent 注册表（含各 agent 钉住的技能：SKILL.md 正文 + allowedTools 白名单）。
   * 宿主从加载的技能表中按 skillName 解析后传入；undefined = 主 Agent（全工具、无附加段）。
   */
  registrations?: Readonly<Record<string, AgentRegistration & { skillBody?: string }>>;
}

/** move ToolBinding → kernel AgentTool（TypeBox TSchema 断言，见 shared ToolDef.parameters 约定）。 */
function toAgentTool(binding: ToolBinding): AgentTool {
  return {
    name: binding.def.name,
    description: binding.def.description,
    label: binding.def.label ?? binding.def.name,
    parameters: binding.def.parameters as AgentTool["parameters"],
    execute: async (_toolCallId, args, signal) => {
      const result = await binding.execute(args as Record<string, unknown>, signal);
      // pi 内核 AgentToolResult 无 isError 字段：错误经 content 文案表达（内核以 details 承载结构化数据）。
      const content: TextContent[] = [
        { type: "text", text: result.isError ? `执行错误：${result.text}` : result.text },
      ];
      const toolResult: AgentToolResult<unknown> = {
        content,
        details: result.details,
      };
      return toolResult;
    },
  };
}

/** 会话 Agent 缓存：每次 run 在对应会话转录上继续（P019 rehydration 前为内存态）。 */
interface SessionAgent {
  agent: Agent;
  activeRuns: Set<string>;
  /**
   * R6-17：当前思考档位槽位（可变引用）——streamFn 在每次 LLM 调用时读取，
   * 修复原"档位在 Agent 创建时冻结"缺陷（同会话后续请求的 thinking 变更现即时生效）。
   */
  thinkingSlot: { level: import("@aichdesign/shared").ThinkingLevel | undefined };
}

/** pi-ai Usage 的宿主侧投影（R7-2：与内核 Usage 字段名对齐——原 total 笔误致 totalTokens 记账为 undefined）。 */
interface ExtractUsage {
  input: number;
  output: number;
  cacheRead: number;
  cacheWrite: number;
  reasoning?: number;
  totalTokens: number;
}

/**
 * R7-2：token 启发式估算（DSH 同口径：固定密度近似；仅用于上下文构成展示，非计费值）。
 * CJK ≈ 1 token/字，其余 ≈ 4 字符/token。
 */
export function estimateTokensHeuristic(text: string): number {
  let cjk = 0;
  let other = 0;
  for (const ch of text) {
    const code = ch.codePointAt(0)!;
    if ((code >= 0x4e00 && code <= 0x9fff) || (code >= 0x3000 && code <= 0x303f) || (code >= 0xff00 && code <= 0xffef)) {
      cjk += 1;
    } else {
      other += 1;
    }
  }
  return cjk + Math.ceil(other / 4);
}

export class PiAgentCoreAdapter implements AgentRuntimePort {
  private readonly options: PiAgentCoreAdapterOptions;
  private readonly agents = new Map<string, SessionAgent>();
  private readonly kernelTools: AgentTool[];
  /** R5：按 agent 预设的工具白名单缓存。 */
  private readonly toolsByAgent = new Map<string, AgentTool[]>();
  private disposed = false;

  constructor(options: PiAgentCoreAdapterOptions) {
    this.options = options;
    this.kernelTools = options.tools.map(toAgentTool);
  }

  loadSkill(): void {
    // L1 元数据在 systemPrompt 中注入（main 组装）；运行时无需额外动作。
  }

  /** R6-8：按钉住技能的 allowedTools 过滤工具（带缓存；无白名单 = 全量；read_skill 恒可用）。 */
  private toolsForAgent(agent: string | undefined): AgentTool[] {
    const key = agent ?? "main";
    let tools = this.toolsByAgent.get(key);
    if (!tools) {
      const allow = this.options.registrations?.[key]?.skillBody !== undefined
        ? this.options.registrations?.[key]?.allowedTools
        : undefined;
      tools = allow && allow.length > 0
        ? this.kernelTools.filter((t) => allow.includes(t.name) || t.name === "read_skill")
        : [...this.kernelTools];
      this.toolsByAgent.set(key, tools);
    }
    return tools;
  }

  /**
   * R5：思考深度透传——off/缺省原样；其余按 pi-ai 原生 ThinkingLevel 注入
   * options.reasoning（逐次运行生效，与 Agent 缓存无关）。
   */
  /**
   * R6-17：streamFn 包装——思考档位经槽位逐次读取（不再冻结于 Agent 创建时刻）；
   * DeepSeek 端点注入请求体改写 fetch：把档位按官方形状写入 thinking 对象内
   * （thinking.reasoning_effort），并删除任何顶层 reasoning_effort 无效参数。
   */
  private wrapStreamFn(slot: { level: import("@aichdesign/shared").ThinkingLevel | undefined }): StreamFn {
    const inner = this.options.streamFn;
    return (model, context, options) => {
      const level = slot.level ?? this.options.defaultThinking;
      const next: Record<string, unknown> = { ...options, reasoning: options?.reasoning ?? (level as never) };
      if (isDeepSeekBaseUrl(model.baseUrl)) {
        next.fetch = rewriteDeepSeekThinkingFetch(slot, (next as { fetch?: typeof fetch }).fetch);
      }
      return inner(model, context, next as never);
    };
  }

  registerExtension(): void {
    // 工具经 options.tools 一次性注册（Extension 静态工具集）；动态注册留 P012。
  }

  async dispose(): Promise<void> {
    this.disposed = true;
    this.agents.clear();
  }

  async run(req: RunRequest): Promise<RunHandle> {
    if (this.disposed) {
      throw new Error("adapter 已关闭");
    }
    const { model, tools, usageSink, sessionStore, systemPrompt, getApiKey, imageRegistry } = this.options;
    const queue = new AsyncQueue<SseEventEnvelope>();
    const startedAt = Date.now();
    const { requestId, sessionId, signal } = req;
    // R6-13：单次运行工具调用轮次上限（默认 25；≤0 = 不限制）。
    const maxToolCalls = this.options.maxToolCalls ?? 25;
    let toolCallCount = 0;

    // R5：会话 Agent 获取/创建——缓存键 = sessionId | agent 预设 | 模型覆盖
    //（预设决定系统提示与工具白名单；模型覆盖重建 Model；thinking 逐次经 streamFn 包装透传）。
    const agentId = req.agent ?? "main";
    const cacheKey = `${sessionId}|${agentId}|${req.model ?? ""}`;
    let session = this.agents.get(cacheKey);
    if (!session) {
      const runModel =
        req.model && this.options.buildModelOverride ? this.options.buildModelOverride(req.model) : model;
      const registration = this.options.registrations?.[req.agent ?? "main"];
      const systemPromptWithCtx = registration?.skillBody
        ? systemPrompt + "\n\n" + registration.skillBody
        : systemPrompt;
      // R7-1：转录回放（替代 P019 contextProvider 注入）——会话 Agent 创建时从 jsonl
      // 重建历史消息装入内核转录，重启后 LLM 上下文与 UI 记忆对齐（全量保留，无压缩）。
      // 创建发生于当前 run 的 user 条目落盘之前，回放天然不含当前请求。
      const replayed = this.options.sessionStore
        ? replayTranscript(this.options.sessionStore, sessionId, this.options.imageRegistry)
        : [];
      // R6-17：思考档位槽位（Agent 创建前声明；run 每次更新 → streamFn 逐次读取）。
    const sessionThinkingSlot: SessionAgent["thinkingSlot"] = {
      level: req.thinking ?? this.options.defaultThinking,
    };
    const agent = new Agent({
        initialState: {
          systemPrompt: systemPromptWithCtx,
          model: runModel,
          tools: this.toolsForAgent(req.agent),
          // 结构最小集与内核 AgentMessage 结构兼容（user/assistant 文本+图片块）。
          ...(replayed.length > 0 ? { messages: replayed as unknown as AgentMessage[] } : {}),
        },
        streamFn: this.wrapStreamFn(sessionThinkingSlot),
        getApiKey,
      });
      session = { agent, activeRuns: new Set<string>(), thinkingSlot: sessionThinkingSlot };
      this.agents.set(cacheKey, session);
    }
    const { agent } = session;
    const activeRuns = session.activeRuns;
    activeRuns.add(requestId);
    // R6-17：更新思考档位槽位（默认档回退；缓存 Agent 的后续请求即时生效）。
    session.thinkingSlot.level = req.thinking ?? this.options.defaultThinking;

    // 超时：空闲超时（内核有事件即重置）+ 运行总上限 + 外部取消信号合并。
    // R008：中止必须穿透到 pi 内核——agent.abort() 会 abort 内核 activeRun 的
    // abortController（agent.ts runWithLifecycle），从而中止上游 LLM 请求与循环；
    // 仅置自身 controller.signal 无法止住内核侧 LLM 调用（ADR-004.4 可中止 + ADR-006 成本护栏）。
    const controller = new AbortController();
    const abortRun = () => {
      controller.abort();
      agent.abort();
    };
    // R6-12/R6-13：强制中止（空闲/总上限/工具轮次超限）先落 forcedStopMessage（finish 优先采用），
    // 避免被 finish 的取消分支误报为 REQUEST_CANCELLED"请求已取消"。
    let forcedStopMessage: string | null = null;
    const abortForced = (message: string): void => {
      forcedStopMessage = message;
      abortRun();
    };
    let idleTimer: ReturnType<typeof setTimeout> | null = null;
    const disarmIdle = (): void => {
      if (idleTimer !== null) {
        clearTimeout(idleTimer);
        idleTimer = null;
      }
    };
    const armIdle = (): void => {
      disarmIdle();
      idleTimer = setTimeout(() => {
        abortForced(`运行空闲超时中止（内核 ${RUN_IDLE_TIMEOUT_MS / 1000}s 内无任何事件）`);
      }, RUN_IDLE_TIMEOUT_MS);
    };
    armIdle();
    const totalTimer = setTimeout(() => {
      abortForced(`运行总时长超上限中止（${RUN_TOTAL_TIMEOUT_MS / 60000} 分钟）`);
    }, RUN_TOTAL_TIMEOUT_MS);
    const externalAbort = () => abortRun();
    signal?.addEventListener("abort", externalAbort, { once: true });

    // 本次 run 的产物积累。
    let accumulatedDelta = "";
    // R6-9：Loops 上下文收集（每个 turn 的消息与工具结果；finish 时落盘）。
    const loopTurns: Array<{ ts: string; kind: string; payload: unknown }> = [];
    const collectLoop = (kind: string, payload: unknown): void => {
      if (!self.options.loopLogPath) return;
      loopTurns.push({ ts: new Date().toISOString(), kind, payload });
    };
    let imageResult: RegisteredImage | null = null;
    let terminalError: { code: string; message: string } | null = null;
    // R7-2：本 run 的上下文构成估算缓存（system/tool/窗口；首次 usage 事件时计算一次）。
    let contextEstimate: SseUsageData["context"] | null = null;

    const unsubscribe = agent.subscribe((event: AgentEvent, kernelSignal: AbortSignal) => {
      // R008：内核侧 signal 中止（内核内部主动 abort / agent.abort() 已触发）时，
      // 同步自身 controller，保证 finish() 的取消终态判定一致（双向同步）。
      if (kernelSignal.aborted) {
        controller.abort();
      }
      // 本次 run 结束后事件不再转发（run 级 listener 生命周期）。
      if (queue.isClosed) return;
      // R6-12 空闲喂狗：内核有动静即重置空闲计时；工具执行期间暂停
      // （工具自带超时，长搜索/生图不应被 120s 空闲线误杀；run 总上限仍兜底）。
      if (event.type === "tool_execution_start") {
        disarmIdle();
      } else {
        armIdle();
      }
      switch (event.type) {
        case "message_update": {
          const ev = event.assistantMessageEvent;
          if (ev.type === "text_delta") {
            accumulatedDelta += ev.delta;
            queue.push(makeEnvelope(requestId, sessionId, "delta", { delta: ev.delta }));
            } else if (ev.type === "thinking_delta") {
            // R6-6：模型思考增量（渲染层折叠展示，开关控制）。
            queue.push(makeEnvelope(requestId, sessionId, "thinking", { delta: ev.delta }));
          }
          break;
        }
        case "message_end": {
          collectLoop("message_end", event.message);
          break;
        }
        case "turn_end": {
          // R6-12：合并原重复 case——Loops 收集 + usage 记账（此前第二个 case 不可达，
          // LLM 运行的 token/成本记录实际是断的）。
          collectLoop("turn_end", { message: event.message, toolResults: event.toolResults });
          const msg = event.message as { usage?: ExtractUsage };
          if (msg.usage) {
            recordUsage(msg.usage);
            // R7-2：用量 SSE（每次 LLM 调用一轮；渲染层据此显示上下文/缓存命中/累计）。
            queue.push(makeEnvelope(requestId, sessionId, "usage", usageDataOf(msg.usage, agent)));
          }
          break;
        }
        case "tool_execution_start": {
          // R6-13：工具调用轮次上限（pi 内核 while(true) 无 maxTurns，宿主侧封顶防活跃死循环）。
          toolCallCount += 1;
          if (maxToolCalls > 0 && toolCallCount > maxToolCalls) {
            abortForced(`工具调用轮次超限中止（单次运行最多 ${maxToolCalls} 次工具调用；可在 设置 → Agent 调整）`);
            break;
          }
          // R6-6：工具调用可见性（渲染层折叠展示，开关控制）。
          queue.push(makeEnvelope(requestId, sessionId, "tool", { toolName: event.toolName, phase: "start" }));
          break;
        }
        case "tool_execution_end": {
          const dispatchDetails = (event.result as { details?: { dispatchAgent?: string } } | undefined)?.details;
          queue.push(
            makeEnvelope(requestId, sessionId, "tool", {
              toolName: event.toolName,
              phase: "end",
              ...(event.isError ? { error: "执行失败" } : {}),
              ...(event.toolName === "dispatch_agent" && dispatchDetails?.dispatchAgent
                ? { dispatchAgent: dispatchDetails.dispatchAgent }
                : {}),
            }),
          );
          const binding = findBinding(tools, event.toolName);
          if (!binding || event.isError) break;
          if (binding.def.name === "image_generate" || binding.def.name === "image_edit") {
            const phase = binding.def.name === "image_generate" ? "image_generate" : "image_edit";
            // P1 修复（R2-REV 前回退）：pi 内核事件流无 phase 语义，在工具执行结束节点补发同型
            // progress（契约 SseProgressData.phase 含 image_generate/image_edit，shared contracts.ts
            // L157；与 mock 路径语义对齐，done 前必发；isError 时上方已 break，不产生终态外事件）。
            queue.push(
              makeEnvelope(requestId, sessionId, "progress", {
                phase,
                percent: 100,
                message: binding.def.name === "image_generate" ? "图像生成完成" : "图像编辑完成",
              }),
            );
            const details = (event.result as { details?: unknown }).details as ImageApiResult | undefined;
            if (details?.imageId && details.url && details.meta) {
              // B-4：落盘 images/ + 会话 jsonl 元数据注册；done image 载荷取注册后 file:// url。
              imageResult = imageRegistry
                ? imageRegistry.store(sessionId, details, imageContextOf(req.request))
                : { imageId: details.imageId, url: details.url, meta: details.meta };
            }
          }
          break;
        }
        default:
          break;
      }
    });

    function recordUsage(u: ExtractUsage): void {
      const cost = model.cost;
      const costUsd =
        u.input * cost.input + u.output * cost.output + u.cacheRead * cost.cacheRead + u.cacheWrite * cost.cacheWrite;
      const rec: UsageRecord = {
        sessionId,
        requestId,
        requestKind: req.request.kind,
        model: model.id,
        provider: model.provider,
        promptTokens: u.input,
        completionTokens: u.output,
        cacheReadTokens: u.cacheRead,
        cacheWriteTokens: u.cacheWrite,
        totalTokens: u.totalTokens,
        costUsd,
        latencyMs: Date.now() - startedAt,
        ok: true,
        ts: new Date().toISOString(),
      };
      usageSink(rec);
      // R7-2 补：落盘载荷附 context 静态估算快照（UI 重启后用量胶囊恢复窗口分母/构成；旧数据无此段）。
      sessionStore?.append(sessionId, "usage", { ...rec, context: usageDataOf(u, agent).context }, requestId);
    }

    /**
     * R7-2：turn usage → SSE usage 载荷。context 段为静态估算（系统提示词/工具定义，
     * 按当前 Agent 的 systemPrompt 与工具集一次估出）；contextWindow 取活动模型声明
     * （条目配置优先，见 buildLlmModel；DeepSeek 官方 1M）。
     */
    function usageDataOf(u: ExtractUsage, agentRef: Agent): SseUsageData {
      if (!contextEstimate) {
        const toolsJson = agentRef.state.tools
          .map((t) => `${t.name}${t.description ?? ""}${JSON.stringify(t.parameters ?? {})}`)
          .join("");
        contextEstimate = {
          systemTokens: estimateTokensHeuristic(agentRef.state.systemPrompt),
          toolTokens: estimateTokensHeuristic(toolsJson),
          contextWindow: agentRef.state.model?.contextWindow ?? 128_000,
        };
      }
      return {
        promptTokens: u.input + u.cacheRead + u.cacheWrite,
        completionTokens: u.output,
        cacheReadTokens: u.cacheRead,
        cacheWriteTokens: u.cacheWrite,
        ...(u.reasoning !== undefined ? { reasoningTokens: u.reasoning } : {}),
        totalTokens: u.totalTokens,
        context: contextEstimate,
      };
    }

    // 用户消息入会话 jsonl（R7-1：图片引用 id 一并落盘——转录回放时经 ImageRegistry 还原为 base64）。
    const userPrompt = promptOf(req.request);
    const requestedImageIds = req.analysisImageIds ?? [];
    sessionStore?.append(
      sessionId,
      "user",
      {
        text: userPrompt,
        kind: req.request.kind,
        ...(requestedImageIds.length > 0 ? { imageIds: requestedImageIds } : {}),
      },
      requestId,
    );

    // R6-11：多模态——请求携带 analysisImageIds 时，把已注册图片读为 base64 交 LLM 视觉分析。
    // DeepSeek/OpenAI 官方要求：jpeg/png/webp；base64 传输（file:// 本地读取转码）；单图 ≤8MB。
    let analysisImages: Array<{ type: 'image'; data: string; mimeType: string }> | undefined;
    const unresolvedImageIds: string[] = [];
    for (const imageId of requestedImageIds) {
      const url = imageRegistry?.resolveUrl(imageId);
      if (!url || !url.startsWith('file://')) {
        unresolvedImageIds.push(imageId);
        continue;
      }
      try {
        const bytes = readFileSync(fileURLToPath(url));
        if (bytes.length > 8 * 1024 * 1024) {
          unresolvedImageIds.push(imageId);
          continue;
        }
        const ext = url.split('.').pop()?.toLowerCase() ?? '';
        const mime = ext === 'png' ? 'image/png' : ext === 'webp' ? 'image/webp' : 'image/jpeg';
        (analysisImages ??= []).push({ type: 'image' as const, data: bytes.toString('base64'), mimeType: mime });
      } catch {
        unresolvedImageIds.push(imageId);
      }
    }
    // R7-1：图片未能加载不再静默跳过——向 LLM 与用户显式说明（此前重启后注册表失效，
    // 图片被无声丢弃，模型答"图没传过来"且无从排查）。
    const effectivePrompt =
      unresolvedImageIds.length > 0
        ? `${userPrompt}\n\n[系统] 附件图片未能加载（共 ${unresolvedImageIds.length} 张：${unresolvedImageIds.join("、")}）——请告知用户图片未送达，不要假设图片内容。`
        : userPrompt;
    const self = this;
    // 运行：prompt 完成后终结（agent_end 事件先于 prompt resolve 发出）。
    const outcomePromise = (async () => {
      try {
        await agent.prompt(effectivePrompt, analysisImages);
      } catch (error) {
        // 超时中止引发的异常不覆盖超时原因（保持面向用户的真实错误语义）。
        if (!forcedStopMessage) {
          terminalError = {
            code: ErrorCode.RUNNER_ERROR,
            message: `agent 运行异常：${error instanceof Error ? error.message : String(error)}`,
          };
        }
      }
      return finish();
    })();

    function finish(): AgentResponse {
      disarmIdle();
      clearTimeout(totalTimer);
      signal?.removeEventListener("abort", externalAbort);
      unsubscribe();
      activeRuns.delete(requestId);

      if (forcedStopMessage && !terminalError) {
        terminalError = { code: ErrorCode.RUNNER_ERROR, message: forcedStopMessage };
      }
      let final: AgentResponse;
      if (terminalError) {
        final = { kind: "error", code: terminalError.code, message: terminalError.message };
      } else if (controller.signal.aborted) {
        // 真取消：外部 abort 信号触发。
        final = { kind: "error", code: ErrorCode.REQUEST_CANCELLED, message: agent.state.errorMessage ?? "请求已取消" };
      } else if (agent.state.errorMessage) {
        // R6-6 修复：pi 内核把上游 LLM 错误写入 state.errorMessage——这不是取消，
        // 按 HTTP/网络错误归类 PROVIDER_UNAVAILABLE（其余 RUNNER_ERROR），并附排查提示。
        const msg = agent.state.errorMessage;
        const isHttpErr = /\b(4\d\d|5\d\d)\b|status|fetch failed|ECONNREFUSED|ENOTFOUND|ETIMEDOUT|timeout|not found/i.test(msg);
        const hint =
          isHttpErr && /\b404\b/.test(msg)
            ? "（排查：Base URL 需为 OpenAI 兼容前缀，如 https://api.deepseek.com/v1 或 https://open.bigmodel.cn/api/paas/v4，勿带 /chat/completions——端点会自动追加）"
            : "";
        final = {
          kind: "error",
          code: isHttpErr ? ErrorCode.PROVIDER_UNAVAILABLE : ErrorCode.RUNNER_ERROR,
          message: `LLM 调用失败：${msg}${hint}`,
        };
      } else if (imageResult) {
        // P012：SSE done image 载荷（设计 §5.4 / shared contracts.ts 冻结文本）。
        final = { kind: "image", imageId: imageResult.imageId, url: imageResult.url, meta: imageResult.meta };
      } else {
        final = { kind: "stream", delta: accumulatedDelta };
      }

      if (final.kind === "error") {
        queue.push(makeEnvelope(requestId, sessionId, "error", { code: final.code, message: final.message }));
      } else {
        queue.push(makeEnvelope(requestId, sessionId, "done", final));
      }
      queue.close();

      sessionStore?.append(
        sessionId,
        final.kind === "error" ? "error" : "assistant",
        {
          kind: final.kind,
          // R7-1：统一携带最终 assistant 文本（含 image/plan 终态轮）——转录回放的数据源。
          text: final.kind === "error" ? undefined : lastAssistantText(agent.state.messages) || accumulatedDelta || undefined,
          imageId: final.kind === "image" ? final.imageId : undefined,
          url: final.kind === "image" ? final.url : undefined,
        },
        requestId,
      );

      // R6-9：Agent Loops 上下文落盘（完整 turn 消息/工具结果；开关由 loopLogPath 控制）。
      if (self.options.loopLogPath && (loopTurns.length > 0 || accumulatedDelta)) {
        try {
          const record = {
            ts: new Date().toISOString(),
            requestId,
            sessionId,
            agent: req.agent ?? "main",
            model: req.model ?? "",
            thinking: req.thinking ?? "",
            userPrompt,
            turns: loopTurns,
            final,
          };
          mkdirSync(dirname(self.options.loopLogPath), { recursive: true });
          appendFileSync(self.options.loopLogPath, JSON.stringify(record) + "\n", "utf8");
        } catch {
          // 日志失败静默（不影响主流程）
        }
      }
      return final;
    }

    return {
      events: queue,
      result: outcomePromise,
      status: "running" as RunStatus,
    };
  }
}

/** 从 AgentRequest 提取 B-4 注册上下文（genImage → refImageId；editImage → parentImageId/maskId）。 */
function imageContextOf(request: RunRequest["request"]): ImageRegisterContext {
  if (request.kind === "genImage") {
    return { refImageId: request.refImageId };
  }
  if (request.kind === "editImage") {
    return { parentImageId: request.imageId, maskId: request.maskId };
  }
  return {};
}

/**
 * R7-1：提取内核转录中最后一条 assistant 消息的文本（jsonl assistant 条目统一携带，
 * 供服务重启后的转录回放）。找不到含文本的 assistant 消息返回 ""。
 */
function lastAssistantText(messages: AgentMessage[]): string {
  for (let i = messages.length - 1; i >= 0; i -= 1) {
    const m = messages[i] as { role?: unknown; content?: unknown } | undefined;
    if (!m || m.role !== "assistant") continue;
    const blocks = Array.isArray(m.content) ? (m.content as unknown[]) : [];
    const text = blocks
      .map((b) =>
        b && typeof b === "object" && (b as { type?: unknown }).type === "text" && typeof (b as { text?: unknown }).text === "string"
          ? (b as { text: string }).text
          : "",
      )
      .join("")
      .trim();
    if (text.length > 0) return text;
  }
  return "";
}
/**
 * R6-17：DeepSeek 请求体改写（fetch 包装）——思考参数对齐 api-docs.deepseek.com 官方形状：
 * - 档位写入 thinking 对象内：`thinking: {type: "enabled", reasoning_effort: none|low|high|max}`
 *   （官方要求 reasoning_effort 位于 thinking 内；档位映射见 DEEPSEEK_THINKING_LEVEL_MAP）；
 * - **删除顶层 reasoning_effort**（官方不支持该位置，属无效参数；compat 已禁其来源，此处兜底）；
 * - off 档不注入 effort（pi-ai 发 thinking:{type:"disabled"}，即官方非思考语义）；
 * - 非字符串请求体（multipart 等）与解析失败一律原样放行，不影响其他链路。
 */
export function rewriteDeepSeekThinkingFetch(
  slot: { level: import("@aichdesign/shared").ThinkingLevel | undefined },
  baseFetch?: typeof fetch,
): typeof fetch {
  const impl = baseFetch ?? fetch;
  return async (input, init) => {
    try {
      if (init?.body && typeof init.body === "string") {
        const body = JSON.parse(init.body) as Record<string, unknown>;
        if (body.thinking !== undefined || body.reasoning_effort !== undefined) {
          const level = slot.level;
          const thinking = (
            typeof body.thinking === "object" && body.thinking !== null ? { ...(body.thinking as Record<string, unknown>) } : {}
          ) as Record<string, unknown>;
          if (level && level !== "off") {
            thinking.type = thinking.type ?? "enabled";
            const mapped = DEEPSEEK_THINKING_LEVEL_MAP[level];
            if (mapped) thinking.reasoning_effort = mapped;
          }
          body.thinking = thinking;
          delete body.reasoning_effort; // 删除顶层无效参数（官方要求位于 thinking 对象内）
          init = { ...init, body: JSON.stringify(body) };
        }
      }
    } catch {
      // 解析失败（非 JSON 体等）原样放行
    }
    return impl(input, init);
  };
}
