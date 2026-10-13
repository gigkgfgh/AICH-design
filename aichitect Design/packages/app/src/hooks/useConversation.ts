/**
 * useConversation —— 单会话编排（从 App.tsx 抽出，P-R3 重构；R7-1 方案链路移除）。
 *
 * - 对话流：chat（main Agent 承接）/ research（调研子 agent）/ image-gen（图像子 agent）
 * - 图像流（P013）：genImage（文生图）/ editImage（参考图编辑），全经网关 SSE；网关未连接时显式报错
 * - sessionId 参数化：请求携带真实会话 id（P016 会话 token 由主进程按 sessionId 注入）
 * - restore()：从主进程 sessions:read 恢复历史会话（消息/图像）
 * - 会话切换时 reset() 清空本地状态
 */

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type {
  AgentRequest,
  AgentResponse,
  Attachment,
  ChatMessage,
  ImageMeta,
  ImageVersion,
  SessionContent,
  SseUsageData,
  SubAgentId,
  ThinkingLevel,
} from '../types/contracts';
import type { GatewayClient } from '../gateway/types';
import { isGatewayAvailable } from '../gateway/unavailableGateway';
import { shouldFinalizeOnWatchdog, watchdogTimeoutMessage, STREAM_WATCHDOG_MS } from '../lib/streamWatchdog';

/** R5：主 Agent 意图路由（显式选定子 agent 时不再路由）——导出供单测。R7-1：默认 main。 */
export function classifyAgentIntent(text: string): SubAgentId {
  if (/(表现图|效果图|渲染|图像|配图)|((生成|换|改成?|变).{0,8}图)|(图.{0,6}(生成|换|改))/.test(text)) {
    return 'image-gen';
  }
  if (/(调研|案例|参考资?料?|搜索|检索|查一?下|规范|造价|材料|行情)/.test(text)) return 'research';
  return 'main';
}

/** R5：文本附件注入 prompt（≤50KB 已在上传侧限制）。 */
export function composePromptWithAttachments(text: string, attachments?: Attachment[]): string {
  const texts = attachments?.filter((a) => a.type === 'text' && a.content && a.content.length > 0) ?? [];
  const images = attachments?.filter((a) => a.type === 'image') ?? [];
  let prompt = text;
  if (texts.length > 0) {
    prompt += `\n\n${texts.map((a) => `[附件：${a.name}]\n${a.content}`).join('\n\n')}`;
  }
  if (images.length > 0) {
    prompt += `\n\n[参考图] 用户附加了 ${images.length} 张图片：${images.map((a) => a.name).join('、')}${
      images.some((a) => !a.imageId) ? '（部分未注册为参考图 id，仅作说明）' : ''
    }`;
  }
  return prompt;
}

export interface SendMessageOptions {
  agent?: SubAgentId;
  model?: string;
  thinking?: ThinkingLevel;
  attachments?: Attachment[];
  /** R6-4：选定的外部技能（发送时注入 prompt 头部） */
  skill?: { name: string; description: string };
}

let msgSeq = 0;
function nextMessageId(): string {
  msgSeq += 1;
  return `msg-${Date.now().toString(36)}-${msgSeq}`;
}

/** R7-2：模型用量聚合（最近一轮 = 上下文规模口径；会话累计由逐轮 usage 累加）。 */
export interface SessionUsage {
  /** 最近一轮 prompt（含缓存命中，DeepSeek prompt_tokens 口径） */
  lastPromptTokens: number;
  lastCompletionTokens: number;
  lastCacheReadTokens: number;
  /** 上下文窗口与静态构成（条目配置优先，服务端默认兜底） */
  contextWindow: number;
  contextSystemTokens: number;
  contextToolTokens: number;
  /** 会话累计（DSH 口径：未缓存输入/缓存读取/输出/总计/思考） */
  sessionInput: number;
  sessionCacheRead: number;
  sessionCacheWrite: number;
  sessionOutput: number;
  sessionTotal: number;
  sessionReasoning: number;
}

export interface UseConversationOptions {
  /** 会话产生新落盘内容后回调（App 刷新左侧历史列表） */
  onSessionTouched?: () => void;
}

export interface UseConversationResult {
  messages: ChatMessage[];
  images: ImageVersion[];
  currentImage: ImageVersion | null;
  streaming: boolean;
  imageLoading: boolean;
  imageError: string | null;
  /** 会话是否有内容（AppShell idle/working 状态机依据） */
  hasContent: boolean;
  /** R7-2：模型用量聚合（无 usage 数据为 null） */
  usage: SessionUsage | null;
  sendMessage: (text: string, options?: SendMessageOptions) => void;
  /** R6-19：主动打断/终止当前在途请求（保留已生成部分，中性"已停止"终态） */
  stop: () => void;
  /** R6-15：重试失败消息（上游错误重发，3 次上限；原位重跑同一请求） */
  retry: (messageId: string) => void;
  selectImage: (image: ImageVersion) => void;
  /** 生成表现图（R7-1：与平面方案解耦，直接按提示词走 genImage） */
  generateImage: () => void;
  editImage: (image: ImageVersion) => void;
  /** R7-2：把已注册图像（上传/编辑产物）加入画布 */
  addRegisteredImage: (imageId: string, url: string, meta?: Partial<ImageMeta>) => void;
  /** R7-2：从画布移除图像（仅视图层；磁盘文件与 jsonl 存档不动） */
  removeImage: (imageId: string) => void;
  /** R7-2：复制图像为画布新条目（新 imageId、同 url，meta 标注血缘） */
  duplicateImage: (imageId: string) => void;
  /** 会话切换：清空本地状态（切回历史时再 restore） */
  reset: () => void;
  /** 恢复历史会话内容（主进程 sessions:read 产物） */
  restore: (content: SessionContent) => void;
  /**
   * R6：在途请求重连挂接（刷新/切回后）。主进程 activeRuns → 逐个 subscribe：
   * - 终态缓存回放：done 已发生 → onDone 立即触发（结果入树，永不丢）
   * - 仍在飞行 → 挂接实时流；等待期间插入占位用户消息与「重连中」提示
   */
  reattachActive: (runs: Array<{ requestId: string; kind: string; prompt: string }>) => void;
}

export function useConversation(
  sessionId: string,
  clientRef: { current: GatewayClient },
  options: UseConversationOptions = {},
): UseConversationResult {
  const [messages, setMessages] = useState<ChatMessage[]>([]);
  const [streaming, setStreaming] = useState(false);
  const [images, setImages] = useState<ImageVersion[]>([]);
  const [currentImageId, setCurrentImageId] = useState<string | null>(null);
  const [imageLoading, setImageLoading] = useState(false);
  const [imageError, setImageError] = useState<string | null>(null);
  const [usage, setUsage] = useState<SessionUsage | null>(null);

  const unsubRef = useRef<(() => void) | null>(null);
  // 自愈看门狗（R7-3）：见 WATCHDOG 说明。timer 在每次订阅时武装、终态时解除。
  // activeRequestId 独立于 activeRunRef —— reattachActive 路径也会订阅流，
  // 但不写 activeRunRef（那里没有"停止"语义），若复用会导致看门狗误判为已切换而放弃。
  const watchdogRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const watchedRequestIdRef = useRef<string | null>(null);
  // R6-19：在途请求（最新一条）——主动停止依据；userCancelled 记录用户主动打断的消息（中性终态，不进重试链）。
  const activeRunRef = useRef<{ requestId: string; assistantId: string } | null>(null);
  const userCancelledRef = useRef<Set<string>>(new Set());
  // 当前图像快照（构建请求时读取，避免闭包过期）
  const currentImageRef = useRef<ImageVersion | null>(null);

  // 卸载时解除定时器：否则组件销毁后定时器仍会触发 setState（幽灵更新 + 内存泄漏）。
  useEffect(
    () => () => {
      if (watchdogRef.current !== null) {
        clearTimeout(watchdogRef.current);
        watchdogRef.current = null;
      }
    },
    [],
  );

  const currentImage = useMemo(
    () => images.find((img) => img.imageId === currentImageId) ?? null,
    [images, currentImageId],
  );
  currentImageRef.current = images.length > 0 ? (currentImage ?? images[images.length - 1] ?? null) : null;

  /** R7-2：逐轮 usage 累加（onUsage） */
  const accumulateUsage = useCallback((u: SseUsageData): void => {
    setUsage((prev) => ({
      lastPromptTokens: u.promptTokens,
      lastCompletionTokens: u.completionTokens,
      lastCacheReadTokens: u.cacheReadTokens,
      contextWindow: u.context.contextWindow,
      contextSystemTokens: u.context.systemTokens,
      contextToolTokens: u.context.toolTokens,
      sessionInput: (prev?.sessionInput ?? 0) + (u.promptTokens - u.cacheReadTokens - u.cacheWriteTokens),
      sessionCacheRead: (prev?.sessionCacheRead ?? 0) + u.cacheReadTokens,
      sessionCacheWrite: (prev?.sessionCacheWrite ?? 0) + u.cacheWriteTokens,
      sessionOutput: (prev?.sessionOutput ?? 0) + u.completionTokens,
      sessionTotal: (prev?.sessionTotal ?? 0) + u.totalTokens,
      sessionReasoning: (prev?.sessionReasoning ?? 0) + (u.reasoningTokens ?? 0),
    }));
  }, []);

  /**
 * R7-3 自愈看门狗：兜底「终态永远不来」的场景。
 *
 * 症状：输入框光标消失、无法输入——因为 ChatPanel 在 streaming 期间把 textarea
 * 设为 disabled，而 streaming 只有 onDone/onError 才会复位。
 *
 * 失效路径（主进程侧看似完备，实际仍有缝隙）：
 * - IpcGatewayClient.subscribe 是**纯被动监听**，不保证收到终态；
 * - 主进程 broadcastEnvelope 依赖 BrowserWindow 存活，窗口重建/重载期间推送会丢；
 * - 网关重连、配置热重载、服务重启期间的在途 requestId 无人再泵流；
 * - SSE 连接被中间层静默丢弃时，既无 done 也无 error。
 *
 * 一旦命中，streaming 永久为 true → 输入框永久禁用 → 用户只能重启应用。
 * 故渲染层不依赖对端正确性：订阅成功即武装定时器，终态到达则解除。
 *
 * 时限取5 分钟：远大于任何正常响应耗时（长文本生成通常数十秒），
 * 又不至于让用户等太久才有反馈；触发后明确提示「已中断」而非静默恢复。
 *
 * 判定逻辑与文案抽到 lib/streamWatchdog.ts（纯函数，便于无 React 环境单测）。
 */


const finishStream = useCallback(() => {
    if (watchdogRef.current !== null) {
      clearTimeout(watchdogRef.current);
      watchdogRef.current = null;
    }
    watchedRequestIdRef.current = null;
    unsubRef.current?.();
    unsubRef.current = null;
    activeRunRef.current = null;
    setStreaming(false);
    options.onSessionTouched?.();
  }, [options]);

  /** 武装看门狗；已有一只在跑则先解除（顺带重置计时）。 */
  const armWatchdog = useCallback(
    (assistantId: string, requestId: string) => {
      if (watchdogRef.current !== null) clearTimeout(watchdogRef.current);
      watchedRequestIdRef.current = requestId;
      watchdogRef.current = setTimeout(() => {
        watchdogRef.current = null;
        // 只在仍处于该 run 时才收尾，避免误伤后续新请求
        if (!shouldFinalizeOnWatchdog(watchedRequestIdRef.current, requestId)) return;
        watchedRequestIdRef.current = null;
        // 不登记重试上下文：超时多半源于网关/网络异常，重跑大概率同样超时；
        // 且此处拿不到原始 request/options（见 startRun 入参），强行重试反而误导。
        failedRef.current.delete(assistantId);
        setMessages((prev) =>
          prev.map((m) =>
            m.id === assistantId
              ? {
                  ...m,
                  text: `${m.text}${watchdogTimeoutMessage(STREAM_WATCHDOG_MS)}`,
                  isError: true,
                  retry: undefined,
                }
              : m,
          ),
        );
        finishStream();
      }, STREAM_WATCHDOG_MS);
    },
    [finishStream],
  );

  /** 图像响应入树（网关 done.image 单一来源） */
  const addImageResponse = useCallback((response: Extract<AgentResponse, { kind: 'image' }>) => {
    const version: ImageVersion = {
      imageId: response.imageId,
      url: response.url,
      meta: response.meta,
      createdAt: response.meta.createdAt ?? new Date().toISOString(),
    };
    setImages((prev) => [...prev, version]);
    setCurrentImageId(response.imageId);
    setImageLoading(false);
    setImageError(null);
  }, []);

  /** 发起图像请求（genImage / editImage；经网关 SSE，网关不可用时直接报错） */
  const runImageRequest = useCallback(
    async (kind: 'genImage' | 'editImage', prompt: string) => {
      if (imageLoading) return;
      const curImage = currentImageRef.current;
      setImageLoading(true);
      setImageError(null);

      let request: AgentRequest;
      if (kind === 'editImage') {
        if (!curImage) {
          setImageError('请先选择一张表现图');
          setImageLoading(false);
          return;
        }
        request = { kind: 'editImage', sessionId, prompt, imageId: curImage.imageId };
      } else {
        request = { kind: 'genImage', sessionId, prompt, refImageId: undefined };
      }

      if (!isGatewayAvailable(clientRef.current)) {
        setImageError('未连接本地网关，无法生成/编辑图像。请在「设置 → 图像端点」完成配置后重启本地服务。');
        setImageLoading(false);
        return;
      }

      try {
        const { requestId } = await clientRef.current.run(request);
        armWatchdog('', requestId);
        unsubRef.current = clientRef.current.subscribe(requestId, {
          onDelta: () => undefined,
          onUsage: accumulateUsage,
          onDone: (response) => {
            if (response.kind === 'image') {
              addImageResponse(response);
            } else if (response.kind === 'error') {
              setImageError(`${response.code}：${response.message}`);
              setImageLoading(false);
            }
            if (watchdogRef.current !== null) {
              clearTimeout(watchdogRef.current);
              watchdogRef.current = null;
            }
            watchedRequestIdRef.current = null;
            unsubRef.current?.();
            unsubRef.current = null;
            options.onSessionTouched?.();
          },
          onError: (err) => {
            setImageError(`${err.code}：${err.message}`);
            setImageLoading(false);
            if (watchdogRef.current !== null) {
              clearTimeout(watchdogRef.current);
              watchdogRef.current = null;
            }
            watchedRequestIdRef.current = null;
            unsubRef.current?.();
            unsubRef.current = null;
          },
        });
      } catch (err) {
        setImageError(`图像请求失败：${(err as Error).message}`);
        setImageLoading(false);
      }
    },
    [imageLoading, sessionId, clientRef, addImageResponse, options],
  );

  /** R6-15：上游错误重试上限（初始失败后可手动重试 3 次，仍失败则终止）。 */
  const MAX_SEND_RETRIES = 3;

  // R6-15：失败请求登记（messageId → 重跑所需上下文；重试耗尽或成功后移除）。
  const failedRef = useRef<
    Map<
      string,
      {
        text: string;
        options?: SendMessageOptions;
        request: AgentRequest;
        runOptions?: Parameters<GatewayClient["run"]>[1];
        failures: number;
      }
    >
  >(new Map());

  /** 一次完整运行（发消息与失败重试共用）：流式订阅 + 错误登记 + 分派接续。 */
  const startRun = useCallback(
    (ctx: {
      text: string;
      options?: SendMessageOptions;
      assistantId: string;
      request: AgentRequest;
      runOptions?: Parameters<GatewayClient["run"]>[1];
      failures: number;
    }) => {
      const { text, options, assistantId, request, runOptions, failures } = ctx;
      const appendDelta = (delta: string): void => {
        setMessages((prev) => prev.map((m) => (m.id === assistantId ? { ...m, text: m.text + delta } : m)));
      };
      const appendThinking = (delta: string): void => {
        setMessages((prev) => prev.map((m) => (m.id === assistantId ? { ...m, thinking: (m.thinking ?? '') + delta } : m)));
      };
      let pendingDispatch: SubAgentId | null = null;
      // R6-13 分派防环：pendingDispatch 用后即清零 + 链上最多自动接续 1 次。
      let dispatchContinuations = 0;
      const makeToolAppender = (msgId: string) => (info: { toolName: string; phase: 'start' | 'end'; error?: string; dispatchAgent?: string }): void => {
        if (info.toolName === 'dispatch_agent' && info.dispatchAgent) {
          pendingDispatch = info.dispatchAgent as SubAgentId;
          setMessages((prev) =>
            prev.map((m) => (m.id === msgId ? { ...m, dispatchedAgent: pendingDispatch! } : m)),
          );
        }
        setMessages((prev) =>
          prev.map((m) => {
            if (m.id !== msgId) return m;
            const tools = [...(m.tools ?? [])];
            if (info.phase === 'end') {
              let idx = -1;
              for (let j = tools.length - 1; j >= 0; j -= 1) {
                if (tools[j]!.toolName === info.toolName && tools[j]!.phase === "start") { idx = j; break; }
              }
              if (idx >= 0) tools[idx] = { ...tools[idx]!, phase: "end" as const, error: info.error };
              else tools.push({ toolName: info.toolName, phase: "end" as const, error: info.error });
            } else {
              tools.push({ toolName: info.toolName, phase: 'start' });
            }
            return { ...m, tools };
          }),
        );
      };
      const appendTool = makeToolAppender(assistantId);

      // R6-15：失败统一处理——告知用户 + 登记可重试（≤3 次）；耗尽后终止并给出指引。
      const failAttempt = (message: string): void => {
        const nextFailures = failures + 1;
        const retriesDone = nextFailures - 1;
        if (retriesDone < MAX_SEND_RETRIES) {
          failedRef.current.set(assistantId, { text, options, request, runOptions, failures: nextFailures });
          setMessages((prev) =>
            prev.map((m) =>
              m.id === assistantId
                ? { ...m, text: message, isError: true, retry: { attempt: retriesDone + 1, max: MAX_SEND_RETRIES } }
                : m,
            ),
          );
        } else {
          failedRef.current.delete(assistantId);
          setMessages((prev) =>
            prev.map((m) =>
              m.id === assistantId
                ? {
                    ...m,
                    text: `${message}\n\n已自动重试 ${MAX_SEND_RETRIES} 次仍失败，已终止。请检查网络连接、模型配置或 API 额度后重新发送。`,
                    isError: true,
                    retry: undefined,
                  }
                : m,
            ),
          );
        }
      };

      const onDone = (response: AgentResponse): void => {
        // R6-19：用户主动打断 → 中性终态（保留已生成部分，不进错误/重试链）
        if (userCancelledRef.current.has(assistantId)) {
          userCancelledRef.current.delete(assistantId);
          failedRef.current.delete(assistantId);
          setMessages((prev) =>
            prev.map((m) =>
              m.id === assistantId
                ? {
                    ...m,
                    text: `${m.text}${m.text ? '\n\n' : ''}（已停止）`,
                    isError: false,
                    retry: undefined,
                    tools: (m.tools ?? []).map((t) => (t.phase === 'start' ? { ...t, phase: 'end' as const } : t)),
                  }
                : m,
            ),
          );
          finishStream();
          return;
        }
        if (response.kind === 'image') {
          addImageResponse(response);
          setMessages((prev) =>
            prev.map((m) => (m.id === assistantId ? { ...m, text: `${m.text} 已生成图像 ${response.imageId}。` } : m)),
          );
        } else if (response.kind === 'error') {
          failAttempt(`出错了（${response.code}）：${response.message}`);
          finishStream();
          return; // R6-15：失败不触发分派接续
        }
        finishStream();
        // R6-9/R6-13：主 Agent 分派 → 自动以目标子 agent 接续同一请求。
        // 防环三件套：用后即清零 + 链上最多接续 1 次 + 接续 run 补订阅 onTool。
        const dispatchTarget = pendingDispatch;
        pendingDispatch = null;
        if (dispatchTarget) {
          if (dispatchContinuations >= 1) {
            setMessages((prev) => [
              ...prev,
              {
                id: nextMessageId(),
                role: 'system',
                text: `检测到再次分派请求（${dispatchTarget}）；为防止循环已停止自动接续，如需继续可手动选择该 Agent 发送。`,
              },
            ]);
            return;
          }
          dispatchContinuations += 1;
          setMessages((prev) => [
            ...prev,
            { id: nextMessageId(), role: 'system', text: `已分派给：${dispatchTarget}，正在接续处理…` },
          ]);
          const assistantId2 = nextMessageId();
          setMessages((prev) => [...prev, { id: assistantId2, role: 'assistant', text: '' }]);
          setStreaming(true);
          const kindReq: AgentRequest =
            dispatchTarget === 'image-gen'
              ? { kind: 'genImage', sessionId, prompt: text, refImageId: options?.attachments?.find((x) => x.type === 'image' && x.imageId)?.imageId }
              : { kind: 'research', sessionId, prompt: text };
          const appendDelta2 = (delta: string): void => {
            setMessages((prev) => prev.map((msg) => (msg.id === assistantId2 ? { ...msg, text: msg.text + delta } : msg)));
          };
          const appendTool2 = makeToolAppender(assistantId2);
          void (async () => {
            try {
              const { requestId: rid2 } = await clientRef.current.run(kindReq, { agent: dispatchTarget });
              activeRunRef.current = { requestId: rid2, assistantId };
              armWatchdog(assistantId2, rid2);
              unsubRef.current = clientRef.current.subscribe(rid2, { onDelta: appendDelta2, onTool: appendTool2, onUsage: accumulateUsage, onDone, onError });
            } catch (err) {
              failAttempt(`接续失败：${(err as Error).message}`);
              finishStream();
            }
          })();
          return;
        }
      };
      const onError = (err: { code: string; message: string }): void => {
        if (userCancelledRef.current.has(assistantId)) {
          userCancelledRef.current.delete(assistantId);
          failedRef.current.delete(assistantId);
          setMessages((prev) =>
            prev.map((m) =>
              m.id === assistantId
                ? { ...m, text: `${m.text}${m.text ? '\n\n' : ''}（已停止）`, isError: false, retry: undefined }
                : m,
            ),
          );
          finishStream();
          return;
        }
        failAttempt(`出错了（${err.code}）：${err.message}`);
        finishStream();
      };

      void (async () => {
        try {
          const { requestId } = await clientRef.current.run(request, runOptions);
          activeRunRef.current = { requestId, assistantId };
          armWatchdog(assistantId, requestId);
          unsubRef.current = clientRef.current.subscribe(requestId, { onDelta: appendDelta, onThinking: appendThinking, onTool: appendTool, onUsage: accumulateUsage, onDone, onError });
        } catch (err) {
          failAttempt(`请求失败：${(err as Error).message}`);
          finishStream();
        }
      })();
    },
    [sessionId, clientRef, addImageResponse, finishStream],
  );

  const sendMessage = useCallback(
    (text: string, options?: SendMessageOptions) => {
      if (streaming) return;
      // R5：子 agent 解析——显式选定（非 main）固定；main 按意图路由
      // R6-9：main = 主 Agent LLM 自主分派（dispatch_agent 工具）；显式选定则固定
      const resolvedAgent: SubAgentId = options?.agent && options.agent !== 'main' ? options.agent : 'main';
      const skillPrefix = options?.skill
        ? '[使用技能: ' + options.skill.name + ']' + (options.skill.description ? '（' + options.skill.description + '）' : '') + '\n请按该技能的指引执行。\n\n'
        : '';
      const prompt = skillPrefix + composePromptWithAttachments(text, options?.attachments);
      // R6-19 补充：用户气泡内嵌图片附件预览（dataURL）
      const userImages = (options?.attachments ?? [])
        .filter((a) => a.type === 'image' && typeof a.url === 'string')
        .map((a) => a.url as string);
      const userMsg: ChatMessage = {
        id: nextMessageId(),
        role: 'user',
        text,
        ...(userImages.length > 0 ? { images: userImages } : {}),
      };
      const assistantId = nextMessageId();
      const assistantMsg: ChatMessage = { id: assistantId, role: 'assistant', text: '' };
      setMessages((prev) => [...prev, userMsg, assistantMsg]);
      setStreaming(true);

      // R5/R7-1：按 agent 构建 request（附件：图片注册 id → genImage 参考图；文本已在 prompt 注入）
      const imageRef = options?.attachments?.find((a) => a.type === 'image' && a.imageId)?.imageId;
      let request: AgentRequest;
      if (resolvedAgent === 'image-gen') {
        request = { kind: 'genImage', sessionId, prompt, refImageId: imageRef };
      } else if (resolvedAgent === 'research') {
        request = { kind: 'research', sessionId, prompt };
      } else {
        request = { kind: 'chat', sessionId, prompt };
      }

      const runOptions: Parameters<GatewayClient["run"]>[1] = {
        agent: resolvedAgent,
        model: options?.model && options.model.length > 0 ? options.model : undefined,
        analysisImageIds: options?.attachments?.map((a) => a.imageId).filter((x): x is string => !!x),
      };

      startRun({ text, options, assistantId, request, runOptions, failures: 0 });
    },
    [streaming, sessionId, startRun],
  );

  // R6-19：主动打断/终止当前对话请求——网关 cancel + 本地标记（中性"已停止"终态）。
  const stop = useCallback(() => {
    const active = activeRunRef.current;
    if (!active || !streaming) return;
    userCancelledRef.current.add(active.assistantId);
    void clientRef.current.cancel(active.requestId).catch(() => undefined);
  }, [streaming, clientRef]);

  // R6-15：重试失败消息——清错误态原位重跑同一请求（新 requestId）；次数耗尽后不可再试。
  const retry = useCallback(
    (messageId: string) => {
      if (streaming) return;
      const info = failedRef.current.get(messageId);
      if (!info) return;
      failedRef.current.delete(messageId);
      setMessages((prev) =>
        prev.map((m) =>
          m.id === messageId
            ? { ...m, text: '', isError: false, retry: undefined, thinking: '', tools: [], dispatchedAgent: undefined }
            : m,
        ),
      );
      setStreaming(true);
      startRun({
        text: info.text,
        options: info.options,
        assistantId: messageId,
        request: info.request,
        runOptions: info.runOptions,
        failures: info.failures,
      });
    },
    [streaming, startRun],
  );

  const selectImage = useCallback((image: ImageVersion) => {
    setCurrentImageId(image.imageId);
    setImageError(null);
  }, []);

  /** R7-1：生成表现图（与平面方案解耦；无方案时直接按默认提示词出图）。 */
  const generateImage = useCallback(() => {
    void runImageRequest('genImage', '生成一张建筑室内表现图：现代简约风格，自然采光，材质细节精致，构图完整。');
  }, [runImageRequest]);

  const editImage = useCallback(
    (image: ImageVersion) => {
      void runImageRequest('editImage', `基于所选图像（${image.imageId}）深化设计：优化材质与光影，整体更精致。`);
    },
    [runImageRequest],
  );

  /** R7-2：已注册图像入画布（上传/编辑产物；url 兼容 file:// 与 dataURL）。 */
  const addRegisteredImage = useCallback(
    (imageId: string, url: string, meta?: Partial<ImageMeta>) => {
      if (images.some((img) => img.imageId === imageId)) return;
      const version: ImageVersion = {
        imageId,
        url,
        meta: {
          prompt: meta?.prompt ?? '用户上传参考图',
          model: meta?.model ?? 'user-upload',
          provider: meta?.provider ?? 'user',
          status: 'succeeded',
          createdAt: meta?.createdAt ?? new Date().toISOString(),
          ...meta,
        },
        createdAt: meta?.createdAt ?? new Date().toISOString(),
      };
      setImages((prev) => [...prev, version]);
      setCurrentImageId(imageId);
    },
    [images],
  );

  const removeImage = useCallback((imageId: string) => {
    setImages((prev) => prev.filter((img) => img.imageId !== imageId));
    setCurrentImageId((prev) => (prev === imageId ? null : prev));
  }, []);

  const duplicateImage = useCallback((imageId: string) => {
    setImages((prev) => {
      const source = prev.find((img) => img.imageId === imageId);
      if (!source) return prev;
      const copy: ImageVersion = {
        ...source,
        imageId: `${source.imageId}-c${Date.now().toString(36)}`,
        meta: { ...source.meta, parentImageId: source.imageId },
        createdAt: new Date().toISOString(),
      };
      return [...prev, copy];
    });
  }, []);

  const reset = useCallback(() => {
    if (watchdogRef.current !== null) {
      clearTimeout(watchdogRef.current);
      watchdogRef.current = null;
    }
    watchedRequestIdRef.current = null;
    unsubRef.current?.();
    unsubRef.current = null;
    setMessages([]);
    setStreaming(false);
    setImages([]);
    setCurrentImageId(null);
    setImageLoading(false);
    setImageError(null);
    setUsage(null);
  }, []);

  const restore = useCallback((content: SessionContent) => {
    // 必须解除看门狗：切换/重载会话后旧 run 已无意义，若定时器残留，
    // 到期会误改**新会话**的消息文本（表现为凭空多出一句"已中断"）。
    if (watchdogRef.current !== null) {
      clearTimeout(watchdogRef.current);
      watchdogRef.current = null;
    }
    watchedRequestIdRef.current = null;
    unsubRef.current?.();
    unsubRef.current = null;
    setStreaming(false);
    setImageLoading(false);
    setImageError(null);
    setMessages(
      content.messages.map((m) => ({
        id: m.id,
        role: m.role,
        text: m.text,
        ...(m.images && m.images.length > 0 ? { images: m.images } : {}),
      })),
    );
    setImages(content.images);
    setCurrentImageId(content.images.length > 0 ? content.images[content.images.length - 1]!.imageId : null);
    // R7-2：重启/切换会话后用量胶囊恢复（jsonl usage 行聚合；无数据保持隐藏）
    setUsage(content.usage ?? null);
  }, []);

  const reattachActive = useCallback(
    (runs: Array<{ requestId: string; kind: string; prompt: string }>) => {
      if (runs.length === 0 || streaming) return;
      const assistantIds = new Map<string, string>();
      setMessages((prev) => {
        const next = [...prev];
        for (const run of runs) {
          const assistantId = nextMessageId();
          assistantIds.set(run.requestId, assistantId);
          if (run.prompt) {
            next.push({ id: nextMessageId(), role: 'user', text: run.prompt });
          }
          next.push({
            id: assistantId,
            role: 'assistant',
            text: `↻ 已重新挂接进行中的请求（${run.kind}）…`,
          });
        }
        return next;
      });
      setStreaming(true);

      for (const run of runs) {
        const requestId = run.requestId;
        const appendDelta = (delta: string): void => {
          const assistantId = assistantIds.get(requestId);
          if (!assistantId) return;
          setMessages((prev) =>
            prev.map((m) => (m.id === assistantId ? { ...m, text: m.text === '' ? delta : m.text + delta } : m)),
          );
        };
        const settle = (finalText: string, isError = false): void => {
          const assistantId = assistantIds.get(requestId);
          if (assistantId) {
            setMessages((prev) => prev.map((m) => (m.id === assistantId ? { ...m, text: finalText, isError } : m)));
          }
          finishStream();
        };
        const onDone = (response: AgentResponse): void => {
          if (response.kind === 'image') {
            addImageResponse(response);
            settle(`已生成图像 ${response.imageId}。`);
          } else if (response.kind === 'error') {
            settle(`出错了（${response.code}）：${response.message}`, true);
          } else {
            settle((response as { delta?: string }).delta ?? '已完成。');
          }
        };
        const onError = (err: { code: string; message: string }): void => {
          settle(`出错了（${err.code}）：${err.message}`, true);
        };
        armWatchdog(assistantIds.get(requestId) ?? '', requestId);
        void clientRef.current.subscribe(requestId, { onDelta: appendDelta, onUsage: accumulateUsage, onDone, onError });
      }
    },
    [streaming, clientRef, addImageResponse, finishStream, armWatchdog],
  );

  // R7-2 补：画布已有图像（如 idle 会话先传图）也构成"工作态"——否则图片入册后画布不渲染，用户看不到图
  const hasContent = messages.length > 0 || streaming || imageLoading || images.length > 0;

  return {
    messages,
    stop,
    retry,
    images,
    currentImage: currentImageRef.current,
    streaming,
    imageLoading,
    imageError,
    usage,
    hasContent,
    sendMessage,
    selectImage,
    generateImage,
    editImage,
    addRegisteredImage,
    removeImage,
    duplicateImage,
    reset,
    restore,
    reattachActive,
  };
}
