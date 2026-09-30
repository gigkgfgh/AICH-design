/**
 * 本地网关（修订①：127.0.0.1 + 随机端口 + Bearer token；沙箱仅 loopback 豁免即天然只连网关）。
 *
 * 端点契约（契约冻结于 shared 类型；变更必须落盘）：
 * - POST /v1/run
 *     body: { requestId, sessionId, request: AgentRequest }
 *     成功: 202 { requestId, sessionId, status, streamUrl }
 *     幂等（requestId 已存在）: 200 同形（终态同样返回 streamUrl，/v1/stream 可回放）
 * - GET  /v1/stream/:requestId   SSE（event: delta|partial|done|error，data=信封 JSON）
 *     在途: 挂接实时流；终态: 回放缓存事件后关闭；不存在: 404
 * - POST /v1/cancel  body: { requestId, sessionId? } → 200 { requestId, status } / 404
 * - GET  /v1/health   { ok, adapter, pid, uptimeMs }
 * - GET  /v1/metrics  usageTracker.summary()
 * 统一错误响应: { code, message, data }（shared/errors.ts）
 *
 * 安全（P016 会话 token 轮换，R3 §7 契约 1）：
 * - 仅监听 127.0.0.1；
 * - POST /v1/authorize body { sessionId }（**需进程级 token** bootstrap）→ { sessionId, token }；
 *   同 sessionId 再调用即轮换（旧会话 token 立即失效）；
 * - run / stream / cancel：接受进程级 token（兼容旧路径，**已登记废弃**）或
 *   与目标 sessionId 绑定的有效会话 token（stream/cancel 经 RunManager.requestId→sessionId 解析绑定）；
 * - /v1/health、/v1/metrics：仅进程级 token（README 登记；会话 token 不得读取进程级信息）；
 * - 全部 fail-closed：无法完成绑定判定（如 requestId 不存在且持会话 token）一律 401 不泄露存在性。
 */

import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import { once } from "node:events";
import type { AgentRequest, SseEventEnvelope } from "@aichdesign/shared";
import { ErrorCode, makeError } from "@aichdesign/shared";
import { RunManager } from "../runtime/run-manager.js";
import type { RunState } from "../runtime/run-manager.js";
import type { UsageTracker } from "../telemetry/usage-tracker.js";
import { SessionTokenManager } from "./session-tokens.js";
import type { ImageRegistry } from "../image/image-registry.js";

export interface HttpGatewayOptions {
  adapterLabel: string;
  token: string;
  runManager: RunManager;
  usageTracker: UsageTracker;
  /** P016：会话 token 管理器（缺省网关内部自建——仅测试便利，生产由 main 注入共享实例）。 */
  sessionTokens?: SessionTokenManager;
  /** R5：图像注册表（POST /v1/images 上传参考图注册用）。 */
  imageRegistry?: ImageRegistry;
  /** R6-4：外部技能列表（GET /v1/skills 供渲染层「选择技能」菜单）。 */
  skills?: ReadonlyArray<{ name: string; description: string }>;
  host?: string;
  port?: number;
}

export interface HttpGateway {
  port: number;
  url: string;
  token: string;
  close(): Promise<void>;
}

/** sessionId 白名单（R007：防路径穿越；与 JsonlSessionStore.SESSION_ID_RE 一致的双保险）。 */
const SESSION_ID_RE = /^[A-Za-z0-9._-]{1,64}$/;

/** requestId 长度上限（R013；主进程生成的幂等键，正常 ≪ 此值）。 */
const REQUEST_ID_MAX_LEN = 4096;

/** 请求体上限（R013：1MB；超限拒绝读取，防内存放大）。 */
const MAX_BODY_BYTES = 1024 * 1024;

/** R5：/v1/images 上传体上限（28MB——容纳 ≤20MB 图像的 base64 膨胀）。 */
const MAX_IMAGE_BODY_BYTES = 28 * 1024 * 1024;

/** 请求体超限标记错误（readJsonBody 抛出，调用方映射 413）。 */
class BodyTooLargeError extends Error {
  constructor() {
    super("request body 超过 1MB 上限");
  }
}

export async function createHttpGateway(options: HttpGatewayOptions): Promise<HttpGateway> {
  const { token, runManager, usageTracker, adapterLabel, imageRegistry } = options;
  const sessionTokens = options.sessionTokens ?? new SessionTokenManager();
  const host = options.host ?? "127.0.0.1";

  const server: Server = createServer((req, res) => {
    void handleRequest(req, res).catch((error) => {
      res.statusCode = 500;
      res.setHeader("content-type", "application/json; charset=utf-8");
      res.end(JSON.stringify(makeError(ErrorCode.INTERNAL_ERROR, error instanceof Error ? error.message : String(error))));
    });
  });

  /** 提取 Bearer 凭据（无则 null）。 */
  function bearerOf(req: IncomingMessage): string | null {
    const header = req.headers.authorization ?? "";
    return header.startsWith("Bearer ") ? header.slice("Bearer ".length) : null;
  }

  /** 是否持进程级 token（bootstrap/兼容路径）。 */
  function isProcessToken(req: IncomingMessage): boolean {
    const bearer = bearerOf(req);
    return bearer !== null && bearer === token;
  }

  /** P016 绑定校验：进程级 token 或 绑定该 sessionId 的有效会话 token。 */
  function isRunAuthorized(req: IncomingMessage, sessionId: string | null): boolean {
    if (isProcessToken(req)) return true;
    const bearer = bearerOf(req);
    return bearer !== null && sessionId !== null && sessionTokens.validate(sessionId, bearer);
  }

  function unauthorized(res: ServerResponse): void {
    sendJson(res, 401, makeError(ErrorCode.UNAUTHORIZED, "缺少或无效的 Bearer token（或会话 token 与目标会话不匹配）"));
  }

  async function handleRequest(req: IncomingMessage, res: ServerResponse): Promise<void> {
    const url = new URL(req.url ?? "/", "http://localhost");
    const method = req.method ?? "GET";

    // POST /v1/authorize（P016：仅进程级 token 可调用——签发/轮换会话 token）
    if (method === "POST" && url.pathname === "/v1/authorize") {
      if (!isProcessToken(req)) {
        unauthorized(res);
        return;
      }
      let body: { sessionId?: unknown } | null;
      try {
        body = await readJsonBody<{ sessionId?: unknown }>(req);
      } catch (error) {
        if (error instanceof BodyTooLargeError) {
          sendJson(res, 413, makeError(ErrorCode.INVALID_REQUEST, error.message));
          return;
        }
        throw error;
      }
      const sessionId = body?.sessionId;
      if (typeof sessionId !== "string" || !SESSION_ID_RE.test(sessionId)) {
        sendJson(res, 400, makeError(ErrorCode.INVALID_REQUEST, "sessionId 必须匹配白名单 ^[A-Za-z0-9._-]{1,64}$"));
        return;
      }
      const issued = sessionTokens.authorize(sessionId);
      sendJson(res, 200, { sessionId, token: issued });
      return;
    }

    // GET /v1/skills（R6-4：外部技能列表，供渲染层加号菜单「选择技能」；仅进程级 token）
    if (method === "GET" && url.pathname === "/v1/skills") {
      if (!isProcessToken(req)) {
        unauthorized(res);
        return;
      }
      sendJson(res, 200, { skills: (options.skills ?? []).map((s) => ({ name: s.name, description: s.description })) });
      return;
    }

    // POST /v1/images（R5：上传参考图注册——dataURL → ImageRegistry 落盘 → imageId 可用于 genImage.refImageId/editImage.imageId）
    if (method === "POST" && url.pathname === "/v1/images") {
      let body: { sessionId?: unknown; dataUrl?: unknown; name?: unknown } | null;
      try {
        body = await readJsonBody<{ sessionId?: unknown; dataUrl?: unknown; name?: unknown }>(req, MAX_IMAGE_BODY_BYTES);
      } catch (error) {
        if (error instanceof BodyTooLargeError) {
          sendJson(res, 413, makeError(ErrorCode.INVALID_REQUEST, `上传图像超过上限（${Math.floor(MAX_IMAGE_BODY_BYTES / 1024 / 1024)}MB）`));
          return;
        }
        throw error;
      }
      const sessionId = body?.sessionId;
      const dataUrl = body?.dataUrl;
      const name = typeof body?.name === "string" ? body.name.slice(0, 200) : undefined;
      if (typeof sessionId !== "string" || !SESSION_ID_RE.test(sessionId)) {
        sendJson(res, 400, makeError(ErrorCode.INVALID_REQUEST, "sessionId 必须匹配白名单"));
        return;
      }
      if (!isRunAuthorized(req, sessionId)) {
        unauthorized(res);
        return;
      }
      if (typeof dataUrl !== "string" || !/^data:image\/(png|jpeg|webp);base64,/.test(dataUrl)) {
        sendJson(res, 400, makeError(ErrorCode.INVALID_REQUEST, "dataUrl 必须为 png/jpeg/webp 图像 base64"));
        return;
      }
      if (!imageRegistry) {
        sendJson(res, 503, makeError(ErrorCode.PROVIDER_UNAVAILABLE, "图像注册表不可用"));
        return;
      }
      try {
        const format = dataUrl.startsWith("data:image/jpeg") ? "jpeg" : dataUrl.startsWith("data:image/webp") ? "webp" : "png";
        const registered = imageRegistry.store(
          sessionId,
          {
            imageId: `img_up_${Date.now().toString(36)}`,
            url: dataUrl,
            format,
            meta: {
              prompt: name ?? "用户上传参考图",
              model: "user-upload",
              provider: "user",
              status: "succeeded",
              createdAt: new Date().toISOString(),
            },
          },
          undefined,
        );
        sendJson(res, 200, { imageId: registered.imageId, url: registered.url });
      } catch (error) {
        sendJson(res, 500, makeError(ErrorCode.INTERNAL_ERROR, `上传注册失败：${error instanceof Error ? error.message : String(error)}`));
      }
      return;
    }

    // GET /v1/health、GET /v1/metrics：仅进程级 token（P016 登记口径）
    if (method === "GET" && (url.pathname === "/v1/health" || url.pathname === "/v1/metrics")) {
      if (!isProcessToken(req)) {
        unauthorized(res);
        return;
      }
      if (url.pathname === "/v1/health") {
        sendJson(res, 200, { ok: true, adapter: adapterLabel, pid: process.pid, uptimeMs: Math.round(process.uptime() * 1000) });
      } else {
        sendJson(res, 200, usageTracker.summary());
      }
      return;
    }

    // POST /v1/run
    if (method === "POST" && url.pathname === "/v1/run") {
      let body: { requestId?: unknown; sessionId?: unknown; request?: unknown; agent?: unknown; model?: unknown; thinking?: unknown; analysisImageIds?: unknown } | null;
      try {
        body = await readJsonBody<typeof body>(req);
      } catch (error) {
        if (error instanceof BodyTooLargeError) {
          sendJson(res, 413, makeError(ErrorCode.INVALID_REQUEST, error.message));
          return;
        }
        throw error;
      }
      const requestId = body?.requestId;
      const sessionId = body?.sessionId;
      const request = body?.request;
      // P016：会话绑定校验（进程级 token 兼容并存）。
      if (typeof sessionId === "string" ? !isRunAuthorized(req, sessionId) : !isProcessToken(req)) {
        unauthorized(res);
        return;
      }
      const validation = validateRunRequest(requestId, sessionId, request);
      if (!validation.ok) {
        sendJson(res, 400, validation.error);
        return;
      }
      // R5：信封扩展字段（agent/model/thinking）——可选、白名单校验、原样透传。
      const agent = parseSubAgent(body?.agent);
      const model = parseModelOverride(body?.model);
      const thinking = parseThinking(body?.thinking);
      const analysisImageIds = parseImageIds(body?.analysisImageIds);
      if (agent === false || model === false || thinking === false || analysisImageIds === false) {
        sendJson(res, 400, makeError(ErrorCode.INVALID_REQUEST, "信封扩展字段非法（agent/model/thinking 取值不在白名单）"));
        return;
      }
      const runRequest = {
        requestId: requestId as string,
        sessionId: sessionId as string,
        request: request as AgentRequest,
        ...(agent !== undefined ? { agent } : {}),
        ...(model !== undefined ? { model } : {}),
        ...(thinking !== undefined ? { thinking } : {}),
        ...(analysisImageIds !== undefined ? { analysisImageIds } : {}),
      };
      // 二次校验（request.kind 白名单）。
      const kindOk = isKnownKind(request as AgentRequest);
      if (!kindOk) {
        sendJson(res, 400, makeError(ErrorCode.INVALID_REQUEST, `未知 request.kind：${(request as AgentRequest).kind}`));
        return;
      }
      try {
        const { launched, state } = await runManager.start(runRequest);
        const streamUrl = `/v1/stream/${requestId}`;
        sendJson(res, launched ? 202 : 200, {
          requestId,
          sessionId,
          status: state.status,
          streamUrl,
        });
      } catch (error) {
        sendJson(res, 500, makeError(ErrorCode.INTERNAL_ERROR, error instanceof Error ? error.message : String(error)));
      }
      return;
    }

    // GET /v1/stream/:requestId（SSE）
    const streamMatch = /^\/v1\/stream\/([^/]+)$/.exec(url.pathname);
    if (method === "GET" && streamMatch) {
      const requestId = decodeURIComponent(streamMatch[1] ?? "");
      // P016：会话 token 须绑定该 requestId 所属会话；requestId 未知时不泄露存在性（401）。
      if (!isProcessToken(req)) {
        const boundSession = runManager.sessionIdOf(requestId);
        const bearer = bearerOf(req);
        if (boundSession === null || bearer === null || !sessionTokens.validate(boundSession, bearer)) {
          unauthorized(res);
          return;
        }
      }
      const state = runManager.get(requestId);
      if (!state) {
        sendJson(res, 404, makeError(ErrorCode.NOT_FOUND, `requestId 不存在：${requestId}`));
        return;
      }
      if (isTerminal(state)) {
        await streamSse(res, replayEvents(state.events));
      } else {
        await streamSse(res, state.handle.events);
      }
      return;
    }

    // POST /v1/cancel
    if (method === "POST" && url.pathname === "/v1/cancel") {
      let body: { requestId?: unknown } | null;
      try {
        body = await readJsonBody<{ requestId?: unknown }>(req);
      } catch (error) {
        if (error instanceof BodyTooLargeError) {
          sendJson(res, 413, makeError(ErrorCode.INVALID_REQUEST, error.message));
          return;
        }
        throw error;
      }
      const requestId = typeof body?.requestId === "string" ? body.requestId : undefined;
      if (!requestId) {
        sendJson(res, 400, makeError(ErrorCode.INVALID_REQUEST, "缺少 requestId"));
        return;
      }
      // P016：会话 token 须绑定该 requestId 所属会话（同 stream 的 fail-closed 口径）。
      if (!isProcessToken(req)) {
        const boundSession = runManager.sessionIdOf(requestId);
        const bearer = bearerOf(req);
        if (boundSession === null || bearer === null || !sessionTokens.validate(boundSession, bearer)) {
          unauthorized(res);
          return;
        }
      }
      if (requestId.length > REQUEST_ID_MAX_LEN) {
        sendJson(res, 400, makeError(ErrorCode.INVALID_REQUEST, `requestId 长度超限（≤${REQUEST_ID_MAX_LEN}）`));
        return;
      }
      if (!runManager.cancel(requestId)) {
        sendJson(res, 404, makeError(ErrorCode.NOT_FOUND, `requestId 不存在或已终态：${requestId}`));
        return;
      }
      sendJson(res, 200, { requestId, status: "cancelled" });
      return;
    }

    sendJson(res, 404, makeError(ErrorCode.NOT_FOUND, `未知端点：${method} ${url.pathname}`));
  }

  /** 幂等/终态回放流（原地转成异步迭代）。 */
  async function* replayEvents(events: SseEventEnvelope[]): AsyncGenerator<SseEventEnvelope> {
    for (const event of events) {
      yield event;
    }
  }

  server.listen(options.port ?? 0, host);
  await once(server, "listening");
  const address = server.address();
  const port = typeof address === "object" && address ? address.port : 0;
  const url = `http://${host}:${port}`;

  return {
    port,
    url,
    token,
    close: () =>
      new Promise<void>((resolve) => {
        server.close(() => resolve());
      }),
  };

  /** RunState 终态判别守卫（复合字面量条件两侧窄化，供 /v1/stream 分流）。 */
  function isTerminal(
    state: RunState,
  ): state is Extract<RunState, { status: "succeeded" | "failed" | "cancelled" }> {
    return state.status === "succeeded" || state.status === "failed" || state.status === "cancelled";
  }

  async function streamSse(res: ServerResponse, events: AsyncIterable<SseEventEnvelope>): Promise<void> {
    res.statusCode = 200;
    res.setHeader("content-type", "text/event-stream; charset=utf-8");
    res.setHeader("cache-control", "no-cache");
    res.setHeader("connection", "keep-alive");
    res.flushHeaders?.();
    // R6-12 心跳（P006 轻量版）：每 15s 写 SSE 注释行，喂客户端空闲超时并保活中间层。
    // 长工具执行（联网检索/生图）期间运行无事件，靠此保持连接活跃判定。
    const heartbeat = setInterval(() => {
      if (!res.writableEnded) res.write(": ping\n\n");
    }, 15_000);
    // 客户端断开后 write 可能触发 EPIPE/ECONNRESET：挂 error 监听防未捕获异常炸进程。
    res.on("error", () => {});
    try {
      for await (const event of events) {
        res.write(`event: ${event.type}\n`);
        res.write(`data: ${JSON.stringify(event)}\n\n`);
      }
    } finally {
      clearInterval(heartbeat);
      res.end();
    }
  }
}

function sendJson(res: ServerResponse, status: number, payload: unknown): void {
  res.statusCode = status;
  res.setHeader("content-type", "application/json; charset=utf-8");
  res.end(JSON.stringify(payload));
}

async function readJsonBody<T>(req: IncomingMessage, maxBytes: number = MAX_BODY_BYTES): Promise<T | null> {
  // R013：Content-Length 声明超限直接拒绝（未读流即 413，防内存放大）。
  const declared = Number(req.headers["content-length"] ?? 0);
  if (Number.isFinite(declared) && declared > maxBytes) {
    throw new BodyTooLargeError();
  }
  const chunks: Buffer[] = [];
  let total = 0;
  for await (const chunk of req) {
    const buf = chunk as Buffer;
    total += buf.length;
    // 分块传输（无 Content-Length）场景同样累计限流。
    if (total > maxBytes) {
      req.destroy();
      throw new BodyTooLargeError();
    }
    chunks.push(buf);
  }
  const raw = Buffer.concat(chunks).toString("utf8").trim();
  if (!raw) return null;
  try {
    return JSON.parse(raw) as T;
  } catch {
    return null;
  }
}

function validateRunRequest(
  requestId: unknown,
  sessionId: unknown,
  request: unknown,
): { ok: true } | { ok: false; error: unknown } {
  if (typeof requestId !== "string" || requestId.length === 0) {
    return { ok: false, error: makeError(ErrorCode.INVALID_REQUEST, "requestId 必须为非空字符串（主进程生成，幂等键）") };
  }
  if (requestId.length > REQUEST_ID_MAX_LEN) {
    return { ok: false, error: makeError(ErrorCode.INVALID_REQUEST, `requestId 长度超限（≤${REQUEST_ID_MAX_LEN}）`) };
  }
  if (typeof sessionId !== "string" || !SESSION_ID_RE.test(sessionId)) {
    return {
      ok: false,
      error: makeError(
        ErrorCode.INVALID_REQUEST,
        "sessionId 必须匹配白名单 ^[A-Za-z0-9._-]{1,64}$（R007：防路径穿越）",
      ),
    };
  }
  if (typeof request !== "object" || request === null) {
    return { ok: false, error: makeError(ErrorCode.INVALID_REQUEST, "request 必须为 AgentRequest 对象") };
  }
  return { ok: true };
}

function isKnownKind(request: AgentRequest): boolean {
  return (
    request.kind === "chat" ||
    request.kind === "genImage" ||
    request.kind === "editImage" ||
    request.kind === "research"
  );
}

/** R5：信封扩展字段解析（合法返回值/缺省 undefined；非法返回 false 供 400）。 */
const SUB_AGENTS = new Set(["main", "image-gen", "research"]);
const THINKING_LEVELS = new Set(["off", "low", "medium", "high", "xhigh", "max"]);

function parseSubAgent(v: unknown): "main" | "image-gen" | "research" | undefined | false {
  if (v === undefined || v === null || v === "") return undefined;
  return typeof v === "string" && SUB_AGENTS.has(v) ? (v as "main") : false;
}

function parseModelOverride(v: unknown): string | undefined | false {
  if (v === undefined || v === null || v === "") return undefined;
  return typeof v === "string" && v.length > 0 && v.length <= 200 ? v : false;
}

function parseImageIds(v: unknown): string[] | undefined | false {
  if (v === undefined || v === null) return undefined;
  if (!Array.isArray(v) || v.length > 4) return false;
  return v.every((x) => typeof x === "string" && x.length > 0 && x.length <= 200) ? (v as string[]) : false;
}

function parseThinking(v: unknown): import("@aichdesign/shared").ThinkingLevel | undefined | false {
  if (v === undefined || v === null || v === "") return undefined;
  return typeof v === "string" && THINKING_LEVELS.has(v) ? (v as import("@aichdesign/shared").ThinkingLevel) : false;
}