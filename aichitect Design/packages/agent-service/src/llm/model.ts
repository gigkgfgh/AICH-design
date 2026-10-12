/**
 * 真实 LLM 模型构建（R5：openai-compatible 接线；R6-17：DeepSeek 思考参数官方对齐）。
 *
 * Model 为 pi-ai 普通对象（api: "openai-completions" 兼容任意 OpenAI 风格端点）；
 * provider id 统一 `aich-llm`，Key 经 Agent 的 getApiKey 逐次注入（优先级高于 provider auth）。
 *
 * R6-17 思考参数（对齐 api-docs.deepseek.com）：
 * - 仅 DeepSeek 端点（baseUrl 含 deepseek.com）开启 reasoning —— pi-ai 据此命中 deepseek
 *   兼容分支，随请求发送 `thinking: {type: "enabled"|"disabled"}`；
 * - thinkingLevelMap 按 DeepSeek 官方档位映射（reasoning_effort ∈ none|low|high|max；
 *   （low→low、medium/xhigh→high），clamp 由此放行全部 UI 档位（minimal 档已删除）；
 * - compat.supportsReasoningEffort=false：禁用 pi-ai 在**顶层**发送 reasoning_effort
 *   （官方要求该字段位于 thinking 对象内，顶层为无效参数）——档位由适配器的请求体
 *   改写器（wrapStreamFn 注入 fetch）迁入 thinking 内，最终上线形状与官方完全一致；
 * - 其他 OpenAI 兼容端点维持 reasoning:false（不发送任何思考参数，行为与既往一致）。
 *
 * 登记边界：
 * - cost 费率未知（自定义端点）→ 按 0 费率记账（usage token 数仍真实）；
 * - contextWindow/maxTokens 采用保守常量（128k/8k）。
 */

import type { Model } from "@earendil-works/pi-ai";

/** 真实 LLM 端点配置（config.llm 齐备时有效）。 */
export interface LlmEndpointConfig {
  baseURL: string;
  apiKeyRef: string;
  model: string;
  /** R7-1：端点是否支持图像输入（缺省 true——DeepSeek 官方等视觉端点开箱即用；纯文本端点显式关）。 */
  imageInput?: boolean;
  /** R7-2：最大上下文窗口（tokens；<=0/缺省 = 服务端默认：DeepSeek 官方 1M，其余 128K 保守值）。 */
  contextWindow?: number;
}

export const LLM_PROVIDER_ID = "aich-llm";

/** DeepSeek 官方端点判定（api.deepseek.com；供模型构建与请求体改写共用）。 */
export function isDeepSeekBaseUrl(baseUrl: string): boolean {
  return /deepseek\.com/i.test(baseUrl);
}

/**
 * DeepSeek 官方思考档位映射（R6-17）。
 * reasoning_effort 合法值：none|low|high|max（默认 high）；UI 档位映射：low→low、medium/xhigh→high。
 */
export const DEEPSEEK_THINKING_LEVEL_MAP: Record<string, string> = {
  off: "none",
  low: "low",
  medium: "high",
  high: "high",
  xhigh: "high",
  max: "max",
};

/** 构建 openai-completions 模型对象；配置不齐备返回 null（调用方降级为未配置占位实现）。 */
export function buildLlmModel(
  config: LlmEndpointConfig,
  modelOverride?: string,
  providerId: string = LLM_PROVIDER_ID,
): Model<"openai-completions"> | null {
  if (!config.baseURL || !config.model || !config.apiKeyRef) return null;
  const id = modelOverride && modelOverride.length > 0 ? modelOverride : config.model;
  const deepseek = isDeepSeekBaseUrl(config.baseURL);
  return {
    id,
    name: id,
    api: "openai-completions",
    provider: providerId,
    baseUrl: config.baseURL.replace(/\/+$/, ""),
    // R6-17：仅 DeepSeek 开启思考（pi-ai deepseek 分支以 reasoning 为前提）。
    reasoning: deepseek,
    // R7-1：默认声明图像输入——pi-ai transform-messages 据此决定是否把 image 块降级为
    // "(image omitted)" 占位文本（input 不含 "image" 时图片在 SDK 层即被剥除）。
    input: config.imageInput === false ? ["text"] : ["text", "image"],
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
    // R7-2：条目配置优先；默认按端点取值（DeepSeek 官方文档 CONTEXT LENGTH 1M；其余保守 128K）。
    contextWindow: config.contextWindow && config.contextWindow > 0
      ? Math.floor(config.contextWindow)
      : deepseek
        ? 1_000_000
        : 128_000,
    maxTokens: 8_192,
    ...(deepseek
      ? {
          thinkingLevelMap: { ...DEEPSEEK_THINKING_LEVEL_MAP },
          // 官方要求 reasoning_effort 位于 thinking 对象内——禁用 pi-ai 的顶层无效参数来源。
          compat: { supportsReasoningEffort: false },
        }
      : {}),
  };
}
