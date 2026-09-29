/**
 * useConversation —— 单会话编排（从 App.tsx 抽出，P-R3 重构）。
 *
 * - 消息修改流：「一句话 → 方案 SVG → 改一句 → 新版本 → 回退」闭环
 * - 图像流（P013）：方案 → 表现图（genImage）/ 编辑（editImage），mock 先行
 * - sessionId 参数化：请求携带真实会话 id（P016 会话 token 由主进程按 sessionId 注入）
 * - restore()：从主进程 sessions:read 恢复历史会话（消息/图像；方案结构完整恢复待 meta.db）
 * - 会话切换时 reset() 清空本地状态
 */

import { useCallback, useMemo, useRef, useState } from 'react';
import type {
  AgentRequest,
  AgentResponse,
  Attachment,
  ChatMessage,
  ImageMeta,
  ImageVersion,
  PlanStructure,
  PlanVersion,
  SessionContent,
  StoragePlanRecord,
  SubAgentId,
  ThinkingLevel,
} from '../types/contracts';
import type { GatewayClient } from '../gateway/types';
import { mockGateway } from '../gateway/mockGateway';
import { svgToPngDataUrl } from '../lib/svgToPng';
import { generateMockImageDataUrl } from '../lib/mockImage';

/** R5：主 Agent 意图路由（显式选定子 agent 时不再路由）——导出供单测。 */
export function classifyAgentIntent(text: string): SubAgentId {
  if (/(表现图|效果图|渲染|图像|配图)|((生成|换|改成?|变).{0,8}图)|(图.{0,6}(生成|换|改))/.test(text)) {
    return 'image-gen';
  }
  if (/(调研|案例|参考资?料?|搜索|检索|查一?下|规范|造价|材料|行情)/.test(text)) return 'research';
  return 'plan-draft';
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

let imgSeq = 0;
function nextImageId(): string {
  imgSeq += 1;
  return `img-${Date.now().toString(36)}-${imgSeq}`;
}

/** 生成表现图默认提示词（基于当前 plan 摘要） */
function buildImagePrompt(plan: PlanStructure): string {
  const names = plan.rooms.map((r) => r.name).join('、');
  return `为当前平面方案生成室内表现图（${plan.rooms.length} 个房间：${names}，${plan.bounds.widthM}×${plan.bounds.heightM}m），现代简约风格，自然采光，细节精致。`;
}

export interface UseConversationOptions {
  /** 会话产生新落盘内容后回调（App 刷新左侧历史列表） */
  onSessionTouched?: () => void;
}

export interface UseConversationResult {
  messages: ChatMessage[];
  versions: PlanVersion[];
  images: ImageVersion[];
  currentVersion: PlanVersion | null;
  currentVersionId: string | null;
  currentImage: ImageVersion | null;
  streaming: boolean;
  imageLoading: boolean;
  imageError: string | null;
  selectedRoomId: string | null;
  /** 会话是否有内容（AppShell idle/working 状态机依据） */
  hasContent: boolean;
  sendMessage: (text: string, options?: SendMessageOptions) => void;
  /** R6-19：主动打断/终止当前在途请求（保留已生成部分，中性"已停止"终态） */
  stop: () => void;
  /** R6-15：重试失败消息（上游错误重发，3 次上限；原位重跑同一请求） */
  retry: (messageId: string) => void;
  selectVersion: (version: PlanVersion) => void;
  selectImage: (image: ImageVersion) => void;
  selectRoom: (roomId: string | null) => void;
  generateImage: () => void;
  editImage: (image: ImageVersion) => void;
  rollbackToPlanFromImage: (image: ImageVersion) => void;
  /** 会话切换：清空本地状态（切回历史时再 restore） */
  reset: () => void;
  /** 恢复历史会话内容（主进程 sessions:read 产物；plans = meta.db 完整方案，可选） */
  restore: (content: SessionContent, plans?: StoragePlanRecord[]) => void;
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
  const [versions, setVersions] = useState<PlanVersion[]>([]);
  const [currentVersionId, setCurrentVersionId] = useState<string | null>(null);
  const [selectedRoomId, setSelectedRoomId] = useState<string | null>(null);
  const [streaming, setStreaming] = useState(false);
  const [images, setImages] = useState<ImageVersion[]>([]);
  const [currentImageId, setCurrentImageId] = useState<string | null>(null);
  const [imageLoading, setImageLoading] = useState(false);
  const [imageError, setImageError] = useState<string | null>(null);

  const unsubRef = useRef<(() => void) | null>(null);
  // R6-19：在途请求（最新一条）——主动停止依据；userCancelled 记录用户主动打断的消息（中性终态，不进重试链）。
  const activeRunRef = useRef<{ requestId: string; assistantId: string } | null>(null);
  const userCancelledRef = useRef<Set<string>>(new Set());
  // 当前版本/图像快照（构建请求时读取，避免闭包过期）
  const currentVersionRef = useRef<PlanVersion | null>(null);
  const currentImageRef = useRef<ImageVersion | null>(null);

  const currentVersion = useMemo(
    () => versions.find((v) => v.versionId === currentVersionId) ?? null,
    [versions, currentVersionId],
  );
  currentVersionRef.current = currentVersion;
  const currentImage = useMemo(
    () => images.find((img) => img.imageId === currentImageId) ?? null,
    [images, currentImageId],
  );
  currentImageRef.current = images.length > 0 ? (currentImage ?? images[images.length - 1] ?? null) : null;

  const finishStream = useCallback(() => {
    unsubRef.current?.();
    unsubRef.current = null;
    activeRunRef.current = null;
    setStreaming(false);
    options.onSessionTouched?.();
  }, [options]);

  /** 图像响应入树（mock 与网关 done.image 共用） */
  const addImageResponse = useCallback(
    (response: Extract<AgentResponse, { kind: 'image' }>, parentPlanVersionId: string | null) => {
      const version: ImageVersion = {
        imageId: response.imageId,
        url: response.url,
        meta: response.meta,
        parentPlanVersionId,
        createdAt: response.meta.createdAt ?? new Date().toISOString(),
      };
      setImages((prev) => [...prev, version]);
      setCurrentImageId(response.imageId);
      setImageLoading(false);
      setImageError(null);
    },
    [],
  );

  /** 发起图像请求（genImage / editImage；mock 本地生成 / 网关 SSE 双路径） */
  const runImageRequest = useCallback(
    async (kind: 'genImage' | 'editImage', prompt: string) => {
      if (imageLoading) return;
      const curVersion = currentVersionRef.current;
      const curImage = currentImageRef.current;
      setImageLoading(true);
      setImageError(null);

      let request: AgentRequest;
      if (kind === 'genImage') {
        if (!curVersion) {
          setImageError('请先生成平面方案，再生成表现图');
          setImageLoading(false);
          return;
        }
        request = { kind: 'genImage', sessionId, prompt, refImageId: undefined };
      } else {
        if (!curImage) {
          setImageError('请先选择一张表现图');
          setImageLoading(false);
          return;
        }
        request = { kind: 'editImage', sessionId, prompt, imageId: curImage.imageId };
      }
      const parentPlanVersionId = curVersion?.versionId ?? null;

      if (clientRef.current !== mockGateway) {
        try {
          const { requestId } = await clientRef.current.run(request);
          unsubRef.current = clientRef.current.subscribe(requestId, {
            onDelta: () => undefined,
            onDone: (response) => {
              if (response.kind === 'image') {
                addImageResponse(response, parentPlanVersionId);
              } else if (response.kind === 'error') {
                setImageError(`${response.code}：${response.message}`);
                setImageLoading(false);
              }
              unsubRef.current?.();
              unsubRef.current = null;
              options.onSessionTouched?.();
            },
            onError: (err) => {
              setImageError(`${err.code}：${err.message}`);
              setImageLoading(false);
              unsubRef.current?.();
              unsubRef.current = null;
            },
          });
        } catch (err) {
          setImageError(`图像请求失败：${(err as Error).message}`);
          setImageLoading(false);
        }
        return;
      }

      // mock 先行路径（TODO-API-STUB: P012 契约就绪后删除，统一走上方网关路径）
      try {
        const refDataUrl =
          kind === 'genImage'
            ? await svgToPngDataUrl(curVersion!.svg, { scale: 1, background: '#ffffff' }).catch(() => null)
            : (curImage?.url ?? null);
        const url = await generateMockImageDataUrl(prompt, { refDataUrl });
        const meta: ImageMeta = {
          prompt,
          model: 'gpt-image-2 (mock)',
          provider: 'aichmock',
          parentVersionId: parentPlanVersionId ?? undefined,
          parentImageId: kind === 'editImage' ? (curImage?.imageId ?? undefined) : undefined,
          width: 1024,
          height: 1024,
          durationMs: 420,
          costUsd: 0.0064,
          status: 'succeeded',
          createdAt: new Date().toISOString(),
        };
        addImageResponse({ kind: 'image', imageId: nextImageId(), url, meta }, parentPlanVersionId);
      } catch (err) {
        setImageError(`图像生成失败：${(err as Error).message}`);
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
        curVersion: PlanVersion | null;
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
      curVersion: PlanVersion | null;
      failures: number;
    }) => {
      const { text, options, assistantId, request, runOptions, curVersion, failures } = ctx;
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
          failedRef.current.set(assistantId, { text, options, request, runOptions, curVersion, failures: nextFailures });
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
        if (response.kind === 'plan') {
          const version: PlanVersion = {
            versionId: response.versionId,
            parentVersionId: curVersion?.versionId ?? null,
            createdAt: new Date().toISOString(),
            instruction: text,
            plan: response.structure,
            svg: response.svg,
          };
          setVersions((prev) => [...prev, version]);
          setCurrentVersionId(response.versionId);
          setSelectedRoomId(null);
          setMessages((prev) => prev.map((m) => (m.id === assistantId ? { ...m, planVersionId: response.versionId } : m)));
        } else if (response.kind === 'image') {
          addImageResponse(response, curVersion?.versionId ?? null);
          setMessages((prev) =>
            prev.map((m) => (m.id === assistantId ? { ...m, text: `${m.text} 已生成表现图 ${response.imageId}。` } : m)),
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
              : dispatchTarget === 'research'
                ? { kind: 'research', sessionId, prompt: text }
                : curVersion
                  ? { kind: 'editPlan', sessionId, instruction: text, versionId: curVersion.versionId }
                  : { kind: 'draftPlan', sessionId, prompt: text, variants: 1 };
          const appendDelta2 = (delta: string): void => {
            setMessages((prev) => prev.map((msg) => (msg.id === assistantId2 ? { ...msg, text: msg.text + delta } : msg)));
          };
          const appendTool2 = makeToolAppender(assistantId2);
          void (async () => {
            try {
              const { requestId: rid2 } = await clientRef.current.run(kindReq, { agent: dispatchTarget });
              activeRunRef.current = { requestId: rid2, assistantId };
              unsubRef.current = clientRef.current.subscribe(rid2, { onDelta: appendDelta2, onTool: appendTool2, onDone, onError });
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
          unsubRef.current = clientRef.current.subscribe(requestId, { onDelta: appendDelta, onThinking: appendThinking, onTool: appendTool, onDone, onError });
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
      const curVersion = currentVersionRef.current;
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

      // R5：按 agent 构建 request（附件：图片注册 id → genImage 参考图；文本已在 prompt 注入）
      const imageRef = options?.attachments?.find((a) => a.type === 'image' && a.imageId)?.imageId;
      let request: AgentRequest;
      if (resolvedAgent === 'image-gen') {
        request = { kind: 'genImage', sessionId, prompt, refImageId: imageRef };
      } else if (resolvedAgent === 'research') {
        request = { kind: 'research', sessionId, prompt };
      } else {
        const isReroll = /(重新生成|新方案|重来|重新设计|换一个)/.test(text);
        request =
          !curVersion || isReroll
            ? { kind: 'draftPlan', sessionId, prompt, variants: 1 }
            : { kind: 'editPlan', sessionId, instruction: prompt, versionId: curVersion.versionId };
      }

      const runOptions: Parameters<GatewayClient["run"]>[1] = {
        agent: resolvedAgent,
        model: options?.model && options.model.length > 0 ? options.model : undefined,
        analysisImageIds: options?.attachments?.map((a) => a.imageId).filter((x): x is string => !!x),
      };

      startRun({ text, options, assistantId, request, runOptions, curVersion, failures: 0 });
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
        curVersion: info.curVersion,
        failures: info.failures,
      });
    },
    [streaming, startRun],
  );

  const selectVersion = useCallback(
    (version: PlanVersion) => {
      if (version.versionId === currentVersionId) return;
      setCurrentVersionId(version.versionId);
      setSelectedRoomId(null);
      setMessages((prev) => [
        ...prev,
        {
          id: nextMessageId(),
          role: 'system',
          text: `已回退到版本 ${version.versionId}。后续修改将基于该版本生成新节点。`,
        },
      ]);
    },
    [currentVersionId],
  );

  const selectImage = useCallback((image: ImageVersion) => {
    setCurrentImageId(image.imageId);
    setImageError(null);
  }, []);

  const selectRoom = useCallback((roomId: string | null) => {
    setSelectedRoomId(roomId);
  }, []);

  const generateImage = useCallback(() => {
    const curVersion = currentVersionRef.current;
    if (!curVersion) {
      setImageError('请先生成平面方案，再生成表现图');
      return;
    }
    void runImageRequest('genImage', buildImagePrompt(curVersion.plan));
  }, [runImageRequest]);

  const editImage = useCallback(
    (image: ImageVersion) => {
      void runImageRequest('editImage', `基于所选表现图（${image.imageId}）深化设计：优化材质与光影，整体更精致。`);
    },
    [runImageRequest],
  );

  const rollbackToPlanFromImage = useCallback(
    (image: ImageVersion) => {
      const parent = image.parentPlanVersionId
        ? versions.find((v) => v.versionId === image.parentPlanVersionId)
        : null;
      if (!parent) {
        setImageError(`无法回退：父方案版本 ${image.parentPlanVersionId ?? '(空)'} 不在当前会话（历史会话仅恢复引用）`);
        return;
      }
      setCurrentVersionId(parent.versionId);
      setSelectedRoomId(null);
      setMessages((prev) => [
        ...prev,
        { id: nextMessageId(), role: 'system', text: `已回退到版本 ${parent.versionId}。后续修改将基于该版本生成新节点。` },
      ]);
    },
    [versions],
  );

  const reset = useCallback(() => {
    unsubRef.current?.();
    unsubRef.current = null;
    setMessages([]);
    setVersions([]);
    setCurrentVersionId(null);
    setSelectedRoomId(null);
    setStreaming(false);
    setImages([]);
    setCurrentImageId(null);
    setImageLoading(false);
    setImageError(null);
  }, []);

  const restore = useCallback((content: SessionContent, plans?: StoragePlanRecord[]) => {
    unsubRef.current?.();
    unsubRef.current = null;
    setStreaming(false);
    setImageLoading(false);
    setImageError(null);
    setSelectedRoomId(null);
    setMessages(
      content.messages.map((m) => ({
        id: m.id,
        role: m.role,
        text: m.text,
        planVersionId: m.planVersionId,
      })),
    );
    // R5：meta.db 可用 → 完整方案版本树（结构+SVG）；不可用 → 引用级提示
    if (plans && plans.length > 0) {
      const restored: PlanVersion[] = plans.map((p) => ({
        versionId: p.versionId,
        parentVersionId: p.parentVersionId,
        createdAt: p.createdAt,
        plan: p.structure,
        svg: p.svg ?? '',
      }));
      setVersions(restored);
      setCurrentVersionId(restored[restored.length - 1]?.versionId ?? null);
    } else {
      if (content.versionRefs.length > 0) {
        setMessages((prev) => [
          ...prev,
          {
            id: `restore-note-${content.sessionId}`,
            role: 'system',
            text: `已恢复 ${content.versionRefs.length} 个方案版本引用（本机存储不可用，方案图示未能还原；可继续以文字指令迭代新版本）。`,
          },
        ]);
      }
      setVersions([]);
      setCurrentVersionId(null);
    }
    setImages(content.images);
    setCurrentImageId(content.images.length > 0 ? content.images[content.images.length - 1]!.imageId : null);
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
          if (response.kind === 'plan') {
            const version: PlanVersion = {
              versionId: response.versionId,
              parentVersionId: currentVersionRef.current?.versionId ?? null,
              createdAt: new Date().toISOString(),
              instruction: run.prompt,
              plan: response.structure,
              svg: response.svg,
            };
            setVersions((prev) => (prev.some((v) => v.versionId === response.versionId) ? prev : [...prev, version]));
            setCurrentVersionId(response.versionId);
            const assistantId = assistantIds.get(requestId);
            if (assistantId) {
              setMessages((prev) =>
                prev.map((m) => (m.id === assistantId ? { ...m, text: m.text, planVersionId: response.versionId } : m)),
              );
            }
            settle('方案已生成。');
          } else if (response.kind === 'image') {
            addImageResponse(response, currentVersionRef.current?.versionId ?? null);
            settle(`已生成表现图 ${response.imageId}。`);
          } else if (response.kind === 'error') {
            settle(`出错了（${response.code}）：${response.message}`, true);
          } else {
            settle((response as { delta?: string }).delta ?? '已完成。');
          }
        };
        const onError = (err: { code: string; message: string }): void => {
          settle(`出错了（${err.code}）：${err.message}`, true);
        };
        void clientRef.current.subscribe(requestId, { onDelta: appendDelta, onDone, onError });
      }
    },
    [streaming, clientRef, addImageResponse, finishStream],
  );

  const hasContent = messages.length > 0 || streaming || imageLoading;

  return {
    messages,
    stop,
    retry,
    versions,
    images,
    currentVersion,
    currentVersionId,
    currentImage: currentImageRef.current,
    streaming,
    imageLoading,
    imageError,
    selectedRoomId,
    hasContent,
    sendMessage,
    selectVersion,
    selectImage,
    selectRoom,
    generateImage,
    editImage,
    rollbackToPlanFromImage,
    reset,
    restore,
    reattachActive,
  };
}
