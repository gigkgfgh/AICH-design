/**
 * 主进程网关 HTTP 客户端封装（P007，R1-REV 修复：R003/R011/R016；P016 会话 token）
 *
 * 契约来源（backend 已冻结，唯一权威）：
 * - POST /v1/authorize body={ sessionId }（需进程级 token）→ 200 { sessionId, token }
 *   会话 token 一次性、再调用即轮换（P016 契约，main 内存缓存，不进渲染层）
 * - POST /v1/run  body={ requestId, sessionId, request: AgentRequest }
 *   → 202 { requestId, sessionId, status, streamUrl }
 *   requestId 由主进程生成（UUID，幂等键 ADR-006），不可猜测
 * - GET  /v1/stream/:requestId   SSE 事件流（信封 { requestId, sessionId, type, data }）
 * - POST /v1/cancel body={ requestId } → 200 { requestId, status }
 * - Authorization: Bearer <进程级 token | 会话 token>；run/stream/cancel 接受两者（旧路径兼容）
 * - 错误响应结构 { code, message, data }；错误码表唯一权威 packages/shared/src/errors.ts
 */
import type { AgentRequest, RunOptions, SseEventEnvelope } from '../src/types/contracts.js';

export interface GatewayHttpClientOptions {
  /** 网关 baseUrl，如 http://127.0.0.1:3719（由 AICH_GATEWAY_READY 握手下发） */
  baseUrl: string;
  /** 进程级 Bearer token（握手下发；authorize 的 bootstrap 凭据与兼容回退） */
  token?: string;
}

/** 网关请求错误（code 使用 shared 错误码表唯一语义） */
export class GatewayHttpError extends Error {
  readonly code: string;
  readonly httpStatus?: number;

  constructor(code: string, message: string, httpStatus?: number) {
    super(message);
    this.name = 'GatewayHttpError';
    this.code = code;
    this.httpStatus = httpStatus;
  }
}

export interface RunResult {
  requestId: string;
}

/**
 * 主进程 → agent-service 的 HTTP/SSE 客户端。
 * 渲染进程不直接接触 HTTP，统一走 IPC 桥（见 src/gateway/ipcGateway.ts）。
 */
export class GatewayHttpClient {
  /** 网关 baseUrl（对外只读，供状态上报使用） */
  readonly baseUrl: string;
  private readonly token?: string;

  /** shared 模块懒加载缓存（CJS 无法静态 require ESM，见 loadShared） */
  private sharedPromise: Promise<typeof import('@aichdesign/shared')> | null = null;

  constructor(options: GatewayHttpClientOptions) {
    this.baseUrl = options.baseUrl.replace(/\/+$/, '');
    this.token = options.token;
  }

  /**
   * 按需加载 @aichdesign/shared（错误码表唯一权威）。
   * TODO-API: Electron 31 内置 Node 20（不支持 require(esm)），shared 为 ESM，
   * 故用动态 import；Electron 升级至支持 require(esm) 后可改静态导入。
   */
  private loadShared(): Promise<typeof import('@aichdesign/shared')> {
    this.sharedPromise ??= import('@aichdesign/shared');
    return this.sharedPromise;
  }

  private headers(bearer?: string): Record<string, string> {
    const h: Record<string, string> = {
      'Content-Type': 'application/json',
      Accept: 'text/event-stream',
    };
    const token = bearer ?? this.token;
    if (token) {
      h.Authorization = `Bearer ${token}`;
    }
    return h;
  }

  /**
   * POST /v1/authorize（P016）：为会话签发一次性 token（再调用即轮换旧 token）。
   * 使用进程级 token 作 bootstrap；会话 token 仅由调用方（main 内存）缓存。
   */
  async authorize(sessionId: string): Promise<string> {
    let res: Response;
    try {
      res = await fetch(`${this.baseUrl}/v1/authorize`, {
        method: 'POST',
        headers: this.headers(),
        body: JSON.stringify({ sessionId }),
        signal: AbortSignal.timeout(10_000),
      });
    } catch (err) {
      throw await this.networkError(err, '会话授权失败');
    }
    if (!res.ok) {
      throw await this.toHttpError(res);
    }
    const body = (await res.json()) as { token?: unknown };
    if (typeof body?.token !== 'string' || body.token.length === 0) {
      const { ErrorCode } = await this.loadShared();
      throw new GatewayHttpError(ErrorCode.INTERNAL_ERROR, '网关 /v1/authorize 响应缺少 token');
    }
    return body.token;
  }

  /** 网络层异常 → PROVIDER_UNAVAILABLE（上游不可达/超时统一语义） */
  private async networkError(err: unknown, action: string): Promise<GatewayHttpError> {
    const { ErrorCode } = await this.loadShared();
    return new GatewayHttpError(ErrorCode.PROVIDER_UNAVAILABLE, `${action}: ${(err as Error).message}`);
  }

  /**
   * POST /v1/run：生成 requestId（UUID，幂等键）并包裹信封 { requestId, sessionId, request }。
   * 修复 R003：旧实现发送裸 AgentRequest 且 requestId 缺失 → validateRunRequest 必然 400。
   */
  async run(req: AgentRequest, sessionBearer?: string, runOptions?: RunOptions): Promise<RunResult> {
    const requestId = crypto.randomUUID();
    // 信封 sessionId 必须非空（网关校验）；缺省时兜底会话令牌
    const sessionId =
      'sessionId' in req && typeof req.sessionId === 'string' && req.sessionId.length > 0
        ? req.sessionId
        : 'session-local';
    let res: Response;
    try {
      res = await fetch(`${this.baseUrl}/v1/run`, {
        method: 'POST',
        headers: this.headers(sessionBearer),
        body: JSON.stringify({
          requestId,
          sessionId,
          request: req,
          // R5：信封扩展（可选；undefined 字段 JSON.stringify 自动省略）
          ...(runOptions?.agent ? { agent: runOptions.agent } : {}),
          ...(runOptions?.model ? { model: runOptions.model } : {}),
          ...(runOptions?.thinking && runOptions.thinking !== 'off' ? { thinking: runOptions.thinking } : {}),
          ...(runOptions?.analysisImageIds?.length ? { analysisImageIds: runOptions.analysisImageIds } : {}),
        }),
        signal: AbortSignal.timeout(10_000),
      });
    } catch (err) {
      throw await this.networkError(err, '网关连接失败');
    }
    if (!res.ok) {
      throw await this.toHttpError(res);
    }
    const body = (await res.json()) as RunResult;
    if (!body || typeof body.requestId !== 'string' || body.requestId.length === 0) {
      const { ErrorCode } = await this.loadShared();
      throw new GatewayHttpError(ErrorCode.INTERNAL_ERROR, '网关 /v1/run 响应缺少 requestId');
    }
    return body;
  }

  /**
   * GET /v1/stream/:requestId：拉取 SSE 流，逐事件回调。
   * 修复 R016：TextDecoder 尾 flush（跨 chunk 多字节字符收尾）。
   * R6-12：300s"总超时"改为 300s"空闲超时"——原实现在长运行（联网检索/工具循环）
   * 超过 5 分钟时无条件掐断连接（实测搜索 run 因此报"网关流式响应中断"）。
   * 现每收到数据（含网关 15s 心跳注释行）即重置；仅连接真正失联/挂死时中止。
   */
  async stream(
    requestId: string,
    onEvent: (envelope: SseEventEnvelope) => void,
    sessionBearer?: string,
  ): Promise<void> {
    const SSE_IDLE_TIMEOUT_MS = 300_000;
    const abortController = new AbortController();
    let idleTimer: ReturnType<typeof setTimeout> | undefined;
    const armIdle = (): void => {
      if (idleTimer !== undefined) clearTimeout(idleTimer);
      idleTimer = setTimeout(() => {
        abortController.abort(new Error(`SSE 空闲超时（${SSE_IDLE_TIMEOUT_MS / 1000}s 未收到任何数据）`));
      }, SSE_IDLE_TIMEOUT_MS);
    };
    armIdle();
    try {
      let res: Response;
      try {
        res = await fetch(`${this.baseUrl}/v1/stream/${encodeURIComponent(requestId)}`, {
          method: 'GET',
          headers: this.headers(sessionBearer),
          signal: abortController.signal,
        });
      } catch (err) {
        throw await this.networkError(err, 'SSE 连接失败');
      }
      if (!res.ok) {
        throw await this.toHttpError(res);
      }
      if (!res.body) {
        const { ErrorCode } = await this.loadShared();
        throw new GatewayHttpError(ErrorCode.INTERNAL_ERROR, 'SSE 响应无 body');
      }

      // 解析完整事件块，返回剩余未闭合 buffer
      const consumeBlocks = (buf: string): string => {
        const blocks = buf.split(/\r?\n\r?\n/);
        const rest = blocks.pop() ?? '';
        for (const block of blocks) {
          const dataLines = block
            .split(/\r?\n/)
            .filter((l) => l.startsWith('data:'))
            .map((l) => l.slice(5).trim());
          if (dataLines.length === 0) {
            continue; // 心跳注释行（": ping"）等非 data 块在此跳过
          }
          const payload = dataLines.join('');
          try {
            const envelope = JSON.parse(payload) as SseEventEnvelope;
            if (envelope && typeof envelope.type === 'string') {
              onEvent(envelope);
            }
          } catch {
            // 忽略无法解析的事件块（幂等；不阻断后续事件）
          }
        }
        return rest;
      };

      const reader = res.body.getReader();
      const decoder = new TextDecoder('utf-8');
      let buffer = '';
      for (;;) {
        const { done, value } = await reader.read();
        if (done) {
          break;
        }
        armIdle(); // 收到数据即重置空闲计时（心跳/增量/终态都算活着）
        buffer += decoder.decode(value, { stream: true });
        buffer = consumeBlocks(buffer);
      }
      // 尾 flush：流结束后解码器残留字节收尾并消费最后一块
      buffer += decoder.decode();
      consumeBlocks(buffer);
    } finally {
      if (idleTimer !== undefined) clearTimeout(idleTimer);
    }
  }

  /**
   * POST /v1/images（R5）：上传参考图注册——dataURL → ImageRegistry → { imageId, url }
   * （imageId 可用于 genImage.refImageId / editImage.imageId）。
   */
  async uploadImage(sessionId: string, dataUrl: string, name?: string, sessionBearer?: string): Promise<{ imageId: string; url: string }> {
    let res: Response;
    try {
      res = await fetch(`${this.baseUrl}/v1/images`, {
        method: 'POST',
        headers: this.headers(sessionBearer),
        body: JSON.stringify({ sessionId, dataUrl, name }),
        signal: AbortSignal.timeout(30_000),
      });
    } catch (err) {
      throw await this.networkError(err, '图像上传失败');
    }
    if (!res.ok) {
      throw await this.toHttpError(res);
    }
    const body = (await res.json()) as { imageId?: unknown; url?: unknown };
    if (typeof body?.imageId !== 'string' || typeof body?.url !== 'string') {
      const { ErrorCode } = await this.loadShared();
      throw new GatewayHttpError(ErrorCode.INTERNAL_ERROR, '网关 /v1/images 响应缺少 imageId/url');
    }
    return { imageId: body.imageId, url: body.url };
  }

  /** GET /v1/skills（R6-4）：外部技能列表（渲染层加号菜单「选择技能」用）。 */
  async listSkills(sessionBearer?: string): Promise<Array<{ name: string; description: string }>> {
    let res: Response;
    try {
      res = await fetch(`${this.baseUrl}/v1/skills`, {
        method: 'GET',
        headers: this.headers(sessionBearer),
        signal: AbortSignal.timeout(10_000),
      });
    } catch (err) {
      throw await this.networkError(err, '技能列表获取失败');
    }
    if (!res.ok) {
      throw await this.toHttpError(res);
    }
    const body = (await res.json()) as { skills?: Array<{ name?: unknown; description?: unknown }> };
    return (body?.skills ?? [])
      .filter((s): s is { name: string; description: string } => typeof s?.name === 'string')
      .map((s) => ({ name: s.name, description: typeof s.description === 'string' ? s.description : '' }));
  }

  /** POST /v1/cancel：取消指定 requestId 的流 */
  async cancel(requestId: string, sessionBearer?: string): Promise<void> {
    let res: Response;
    try {
      res = await fetch(`${this.baseUrl}/v1/cancel`, {
        method: 'POST',
        headers: this.headers(sessionBearer),
        body: JSON.stringify({ requestId }),
        signal: AbortSignal.timeout(10_000),
      });
    } catch (err) {
      throw await this.networkError(err, '取消失败');
    }
    if (!res.ok) {
      throw await this.toHttpError(res);
    }
  }

  /**
   * HTTP 错误 → shared 错误码（10 码唯一权威）。
   * 优先解析统一错误响应体 { code, message }（backend errors.ts 结构）；
   * body 无 code 时按 HTTP 状态映射（与 httpStatusFor 保持一致）。
   * 修复 R011：旧 ERR_* 7 码字面量已废弃。
   */
  private async toHttpError(res: Response): Promise<GatewayHttpError> {
    const { ErrorCode } = await this.loadShared();

    let code: string = ErrorCode.INTERNAL_ERROR;
    let message = `网关错误 HTTP ${res.status}`;
    try {
      const body = (await res.json()) as { code?: unknown; message?: unknown };
      if (typeof body.code === 'string' && body.code.length > 0) {
        code = body.code;
      }
      if (typeof body.message === 'string' && body.message.length > 0) {
        message = body.message;
      }
    } catch {
      // 非 JSON body：走 HTTP 状态映射
    }
    // 兜底：响应未带 code 时按状态归一（与 shared httpStatusFor 同表）
    if (code === ErrorCode.INTERNAL_ERROR && message === `网关错误 HTTP ${res.status}`) {
      code = statusToErrorCode(res.status, ErrorCode);
      message = messageFor(res.status);
    }
    return new GatewayHttpError(code, message, res.status);
  }
}

/** HTTP 状态 → shared 错误码（仅用于响应体无 code 的兜底情况） */
function statusToErrorCode(status: number, EC: typeof import('@aichdesign/shared')['ErrorCode']): string {
  switch (status) {
    case 401:
    case 403:
      return EC.UNAUTHORIZED;
    case 400:
      return EC.INVALID_REQUEST;
    case 404:
      return EC.NOT_FOUND;
    case 409:
      return EC.CONFLICT;
    case 422:
      return EC.INVALID_REQUEST;
    case 408:
    case 502:
    case 504:
      // 上游/网关不可达与运行失败统一语义：RUNNER_ERROR（502）与 PROVIDER_UNAVAILABLE（503/超时）
      return status === 502 ? EC.RUNNER_ERROR : EC.PROVIDER_UNAVAILABLE;
    case 503:
      return EC.PROVIDER_UNAVAILABLE;
    default:
      return EC.INTERNAL_ERROR;
  }
}

function messageFor(status: number): string {
  switch (status) {
    case 401:
    case 403:
      return '网关鉴权失败';
    case 400:
      return '请求校验失败';
    case 404:
      return '资源不存在';
    case 408:
    case 504:
      return '网关超时';
    default:
      return `网关错误 HTTP ${status}`;
  }
}