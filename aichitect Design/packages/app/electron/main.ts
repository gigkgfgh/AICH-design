/**
 * Electron 主进程（P007 壳，R1-REV 修复：R002/R011/R015）
 *
 * 职责：
 * 1. 创建主窗口（加载 Vite dev server（仅可信本机地址）或构建产物 dist-renderer/index.html）
 * 2. spawn agent-service：入口存在则拉起、解析 stdout 就绪行
 *    `AICH_GATEWAY_READY {"url","token","adapter","pid"}`（R002：对齐 backend 冻结协议），
 *    3s 内未握手 → stub；入口不存在 → unavailable
 * 3. IPC 桥：渲染进程 gateway:status / gateway:run / gateway:cancel / 事件推送
 * 4. 网关 HTTP 客户端封装实例化（agent-service ready 时）
 *
 * TODO-API: agent-service 握手后的状态变化广播（渲染层初始化早于握手时需事件通知）留待
 * 后续轮实现；当前握手成功前渲染层走 UnavailableGatewayClient（显式报错，无离线兜底）。
 */
import { app, BrowserWindow, ipcMain, WebContents } from 'electron';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawn, ChildProcess } from 'node:child_process';
import { GatewayHttpClient, GatewayHttpError } from './gatewayClient.js';
import { SecretsService, SECRETS_REFS as REFS } from './secretsService.js';
import type {
  AgentRequest,
  GatewayStatus,
  KeyConfigInput,
  RunOptions,
  SecretsStatus,
  SessionContent,
  SessionSummary,
  SseEventEnvelope,
} from '../src/types/contracts.js';
import { parseSessionContent, summarizeSession, SESSION_ID_RE } from '../src/lib/sessionFiles.js';
import { isInsideRoots, sniffImageMime, toDataUrl, toLocalPath, IMAGE_MAX_BYTES } from '../src/lib/imageAccess.js';

/** ESM 主进程目录（等价 CJS __dirname；NodeNext 下无 __dirname 全局）。 */
const __dirname = path.dirname(fileURLToPath(import.meta.url));

/** agent-service 状态：ready=可走本地 HTTP 桥；stub=入口存在但握手失败；unavailable=入口不存在 */
type AgentServiceStatus = 'ready' | 'stub' | 'unavailable';

const GATEWAY_EVENT_CHANNEL = 'gateway:event';
/** R6-14：窗口 chrome 状态推送通道（maximize/unmaximize → 渲染层切换最大化/还原图标） */
const WINDOW_CHROME_CHANNEL = 'win:chromeChanged';
/** backend 冻结的就绪行前缀（packages/agent-service/README.md 就绪协议） */
const READY_PREFIX = 'AICH_GATEWAY_READY';

let mainWindow: BrowserWindow | null = null;
let agentServiceStatus: AgentServiceStatus = 'unavailable';
let agentServiceChild: ChildProcess | null = null;
let gatewayClient: GatewayHttpClient | null = null;
/**
 * 当前不可用的原因（渲染层据此展示可操作提示）。
 * 每次 startAgentService() 开头重置，恢复就绪后由 buildGatewayStatus 不返回。
 */
let agentServiceError: NonNullable<GatewayStatus['error']> | null = null;

/** 进程级 token（握手下发；P016 起作为 authorize 的 bootstrap 凭据与兼容回退）。 */
let processToken: string | undefined;

/* ---------------- P016 会话 token 缓存（仅主进程内存，不进渲染层/不持久化） ---------------- */

/** sessionId → 会话 token（POST /v1/authorize 签发；轮换后旧值自然被覆盖）。 */
const sessionTokens = new Map<string, string>();
/** 在途运行注册表：requestId → { sessionId, kind, prompt }（cancel 绑定校验 + 刷新后重连挂接）。 */
interface ActiveRunInfo {
  sessionId: string;
  kind: string;
  prompt: string;
}
const requestSessions = new Map<string, ActiveRunInfo>();

/** 获取会话 token：缓存命中直接返回；未命中/强制刷新走 authorize（进程级 token bootstrap）。 */
async function getSessionToken(sessionId: string, refresh = false): Promise<string | undefined> {
  if (!gatewayClient) return undefined;
  if (!refresh) {
    const cached = sessionTokens.get(sessionId);
    if (cached) return cached;
  }
  try {
    const token = await gatewayClient.authorize(sessionId);
    sessionTokens.set(sessionId, token);
    return token;
  } catch (err) {
    process.stderr.write(`[main] 会话授权失败（${sessionId}）：${(err as Error).message}\n`);
    return undefined;
  }
}

/** 丢弃缓存的会话 token（401 轮换竞态后强制重取）。 */
function invalidateSessionToken(sessionId: string): void {
  sessionTokens.delete(sessionId);
}

/** 会话数据目录（R6-6：支持自定义覆盖 <userData>/sessions；sessions:list/read 与图像白名单同源）。 */
function sessionsDir(): string {
  const override = secrets?.getSetting('app.sessionsDir') ?? '';
  return override.length > 0 ? override : path.join(app.getPath('userData'), 'sessions');
}

/** R6-6：Agent 日志目录（stdout/stderr 落盘，排查问题）。 */
function logsDir(): string {
  return path.join(app.getPath('userData'), 'logs');
}

const LOG_MAX_BYTES = 5 * 1024 * 1024;

/** 追加 agent-service 日志（超 5MB 轮转为 .old）。 */
function appendAgentLog(stream: 'stdout' | 'stderr', chunk: Buffer): void {
  try {
    const dir = logsDir();
    fs.mkdirSync(dir, { recursive: true });
    const file = path.join(dir, 'agent-service.log');
    try {
      if (fs.existsSync(file) && fs.statSync(file).size > LOG_MAX_BYTES) {
        fs.renameSync(file, `${file}.old`);
      }
    } catch {
      // 轮转失败不阻塞
    }
    fs.appendFileSync(file, `[${new Date().toISOString()}][${stream}] ${chunk.toString('utf-8')}`, 'utf-8');
  } catch {
    // 日志失败静默（不影响主流程）
  }
}

/** 外部技能目录（R6-3：<dir>/<name>/SKILL.md；设置面板可打开）。 */
function skillsDir(): string {
  return path.join(app.getPath('userData'), 'skills');
}

/** R6-8：内置技能目录（产品自带 SKILL.md，与 agent-service entry 同源候选策略）。 */
function builtinSkillsDir(): string | null {
  const appDir = app.getAppPath();
  const candidates = [
    path.join(appDir, '..', 'skills'),
    path.join(appDir, '..', '..', 'packages', 'skills'),
  ];
  for (const c of candidates) {
    if (fs.existsSync(path.join(c, 'image-gen', 'SKILL.md'))) return c;
  }
  return null;
}

/** 密钥服务（safeStorage/DPAPI 系统级加密，无需口令；用户需求 2026-08-24）。 */
let secrets: SecretsService | null = null;

/** meta.db 持久化句柄（storage 包；打开失败 fail-open——UI 不受影响，仅不持久化）。 */
let metaDb: import('@aichdesign/storage').StorageHandle | null = null;
let storageRepos: {
  db: import('@aichdesign/storage').StorageHandle["db"];
  images: import('@aichdesign/storage').ImageMetaRepository;
} | null = null;

/** 组装 agent-service spawn 环境（会话目录固定 + 密钥库已解锁时注入 LLM/图像 Key）。 */
async function buildAgentServiceEnv(): Promise<Record<string, string>> {
  const env: Record<string, string> = {
    ELECTRON_RUN_AS_NODE: '1',
    AICH_SESSIONS_DIR: sessionsDir(),
    // R6-3/R6-8：技能目录（内置 + 用户；agent-service 启动时合并扫描 <dir>/<name>/SKILL.md）
    AICH_SKILLS_DIR: skillsDir(),
    ...(builtinSkillsDir() ? { AICH_BUILTIN_SKILLS_DIR: builtinSkillsDir()! } : {}),
  };
  if (secrets !== null) {
    // R6-12：Loops 上下文日志开关（设置 → 日志）——此前从未注入 spawn 环境，开关实际是死的。
    if ((await secrets.readSetting('app.loopLog')) === '1') {
      env.AICH_LOOP_LOG = '1';
    }
    // R6-13：工具调用轮次上限（设置 → Agent；空 = 默认 25）
    const maxToolCalls = (await secrets.readSetting('app.agent.maxToolCalls'))?.trim();
    if (maxToolCalls && maxToolCalls !== '') {
      const n = Number(maxToolCalls);
      if (Number.isFinite(n) && n >= 1) env.AICH_AGENT_MAX_TOOL_CALLS = String(Math.min(200, Math.floor(n)));
    }
    // R6-14：多图像服务商条目优先（Key 解密注入）；无条目回退旧单字段，
    // 且解除原 if(imageKey) 门控——baseUrl/model 独立注入（此前 Key 缺失时三者全丢）。
    const imageEntries = secrets.imageModelsForInjection();
    if (imageEntries.length > 0) {
      env.AICH_IMAGE_MODELS = JSON.stringify(imageEntries);
      env.AICH_IMAGE_ACTIVE_ID = secrets.activeImageModelId();
    } else {
      const imageKey = await secrets.readSecret(REFS.imageApiKey);
      if (imageKey) env.AICH_IMAGE_API_KEY = imageKey;
      const baseUrl = await secrets.readSetting(REFS.imageBaseUrl);
      if (baseUrl) env.AICH_IMAGE_BASE_URL = baseUrl;
      const model = await secrets.readSetting(REFS.imageModel);
      if (model) env.AICH_IMAGE_MODEL = model;
    }
    const llmKey = await secrets.readSecret(REFS.llmApiKey);
    const secretsStatusHasModels = (secrets.status().models?.length ?? 0) > 0;
    const modelEntries = secrets.modelsForInjection();
    if (modelEntries.length > 0) {
      // R6-6：多模型注入（每条目独立 baseUrl/Key/thinking；agent-service 按条目建 provider）
      env.AICH_LLM_MODELS = JSON.stringify(modelEntries);
      env.AICH_LLM_ACTIVE_ID = secrets.activeModelId();
    } else if (secretsStatusHasModels) {
      // R7-2：条目存在但全部未通过注入校验 → 不回退旧单字段（残留的旧端点会成为"假接线"，
      // 症状恰似"重启后必须重新保存才能用"）；宁不注入并明确告警（服务照常启动，对话侧显式报错）。
      process.stderr.write('[main] 模型条目存在但均未通过注入校验（见 [secrets] 诊断行），不回退旧单字段配置；请在 设置 → LLM 端点 重新保存\n');
    } else if (llmKey) {
      // 兼容回退：旧单模型配置（R5；仅在从未配置过多模型条目时生效）
      env.AICH_PROVIDER = 'openai-compatible';
      env.AICH_LLM_API_KEY_REF = llmKey;
      const baseUrl = await secrets.readSetting(REFS.llmBaseUrl);
      const model = await secrets.readSetting(REFS.llmModel);
      if (baseUrl) env.AICH_LLM_BASE_URL = baseUrl;
      if (model) env.AICH_LLM_MODEL = model;
    }
    // R5/R6-11：联网检索（research agent）。deepseek 官方联网 = 自动复用已配置的 DeepSeek 模型条目
    const searchProvider = await secrets.readSetting(REFS.searchProvider);
    if (searchProvider === 'searxng' || searchProvider === 'duckduckgo' || searchProvider === 'deepseek') {
      env.AICH_SEARCH_PROVIDER = searchProvider;
      if (searchProvider === 'searxng') {
        const searchUrl = await secrets.readSetting(REFS.searchBaseUrl);
        if (searchUrl) env.AICH_SEARCH_BASE_URL = searchUrl;
      }
      if (searchProvider === 'deepseek') {
        const dsEntry = modelEntries.find((e) => /api.deepseek.com/i.test(e.baseUrl));
        if (dsEntry) {
          env.AICH_SEARCH_DEEPSEEK_BASE_URL = dsEntry.baseUrl.replace(/\/+$/, '').replace(/\/v1$/, '');
          env.AICH_SEARCH_DEEPSEEK_MODEL = dsEntry.model;
          env.AICH_SEARCH_DEEPSEEK_KEY = dsEntry.apiKey;
        }
      }
    }
  }
  return env;
}

/** 重启 agent-service（Key 配置变更后：kill → 重新握手；会话 token 缓存清空）。 */
async function restartAgentService(): Promise<void> {
  const child = agentServiceChild;
  if (child && !child.killed) {
    child.kill();
    await new Promise<void>((resolve) => {
      const timer = setTimeout(resolve, 3000);
      child.once('exit', () => {
        clearTimeout(timer);
        resolve();
      });
    });
  }
  agentServiceChild = null;
  gatewayClient = null;
  sessionTokens.clear();
  if (agentServiceStatus === 'ready') agentServiceStatus = 'stub';
  await startAgentService();
}

/** shared 错误码表懒加载（CJS ↔ ESM，见 gatewayClient.loadShared 相同策略） */
let sharedPromise: Promise<typeof import('@aichdesign/shared')> | null = null;
function loadShared(): Promise<typeof import('@aichdesign/shared')> {
  sharedPromise ??= import('@aichdesign/shared');
  return sharedPromise;
}

function resolveAgentServiceEntry(): string | null {
  const appDir = app.getAppPath();
  // 顺序：backend bin 实际产物 dist/main.js（package.json bin）→ 源码入口 src/main.ts
  // （Node 24 strip-types 直跑）→ 兼容候选 dist/index.js / src/index.ts（package.json main）
  const candidates = [
    path.join(appDir, '..', 'agent-service', 'dist', 'main.js'),
    path.join(appDir, '..', 'agent-service', 'src', 'main.ts'),
    path.join(appDir, '..', 'agent-service', 'dist', 'index.js'),
    path.join(appDir, '..', 'agent-service', 'src', 'index.ts'),
    path.join(appDir, '..', '..', 'packages', 'agent-service', 'dist', 'main.js'),
    path.join(appDir, '..', '..', 'packages', 'agent-service', 'src', 'main.ts'),
    path.join(appDir, '..', '..', 'packages', 'agent-service', 'dist', 'index.js'),
    path.join(appDir, '..', '..', 'packages', 'agent-service', 'src', 'index.ts'),
  ];
  for (const candidate of candidates) {
    if (fs.existsSync(candidate)) {
      return candidate;
    }
  }
  return null;
}

/**
 * spawn agent-service：
 * - 入口存在 → spawn（stdio 管道解析 stdout 就绪行），3s 内未握手 → stub 并 kill
 * - 入口不存在 → unavailable（不阻塞渲染层，UI 显式展示具体原因）
 * 就绪行格式（backend 冻结，README.md:42-46）：
 *   AICH_GATEWAY_READY {"url":"http://127.0.0.1:PORT","token":"...","adapter":"...","pid":...}
 */
function trySpawnAgentService(extraEnv: Record<string, string>): AgentServiceStatus {
  const entry = resolveAgentServiceEntry();
  if (!entry) {
    agentServiceError = {
      code: 'no-entry',
      message: '未找到 agent-service 入口（packages/agent-service/dist/main.js）。请先执行 npm run build。',
    };
    return 'unavailable';
  }

  try {
    // 入口存在：先置 stub（等待就绪行升级为 ready）
    agentServiceStatus = 'stub';
    const child = spawn(process.execPath, [entry], {
      cwd: path.dirname(entry),
      stdio: ['ignore', 'pipe', 'pipe'],
      windowsHide: true,
      // Electron 内 process.execPath=electron.exe：以纯 Node 模式运行 agent-service
      //（Electron 文档标准做法；否则入口会被当作 Electron 主脚本启动）
      // 密钥库已解锁时 extraEnv 携带 LLM/图像 Key（R2 边界：env 注入）
      env: { ...process.env, ...extraEnv },
    });
    agentServiceChild = child;

    let stdoutBuf = '';
    // R025 实机修复（2026-08-12）：pi 路径冷启动实测 READY ~2.2s（ELECTRON_RUN_AS_NODE 直跑计时），
    // Electron 壳内 spawn 进程创建/import 开销叠加后 3s 极易误杀 → 放宽至 15s 兜底
    const handshakeTimeout = setTimeout(() => {
      if (agentServiceStatus !== 'ready') {
        agentServiceStatus = 'stub';
        // R7-2：stub 原因可见（此前静默 kill，用户只见"没配置"，无从排查）
        agentServiceError = {
          code: 'handshake-timeout',
          message: 'agent-service 启动超时（15s 未就绪）。可重启应用，或在「设置 → 日志」中查看 agent-service.log。',
        };
        process.stderr.write(`[main] agent-service 15s 握手超时 → stub：${agentServiceError.message}\n`);
        child.kill();
      }
    }, 15000);

    child.stdout?.on('data', (chunk: Buffer) => {
      appendAgentLog('stdout', chunk); // R6-6：Agent 日志落盘
      stdoutBuf += chunk.toString('utf-8');
      const lines = stdoutBuf.split(/\r?\n/);
      stdoutBuf = lines.pop() ?? '';
      for (const line of lines) {
        const trimmed = line.trim();
        if (!trimmed.startsWith(READY_PREFIX)) {
          continue;
        }
        const jsonText = trimmed.slice(READY_PREFIX.length).trim();
        try {
          const ready = JSON.parse(jsonText) as {
            url?: unknown;
            token?: unknown;
            adapter?: unknown;
            pid?: unknown;
          };
          if (typeof ready.url !== 'string' || ready.url.length === 0) {
            throw new Error('就绪行缺少 url');
          }
          clearTimeout(handshakeTimeout);
          processToken = typeof ready.token === 'string' && ready.token.length > 0 ? ready.token : undefined;
          gatewayClient = new GatewayHttpClient({ baseUrl: ready.url, token: processToken });
          sessionTokens.clear(); // 新网关实例：旧会话 token 全部失效
          agentServiceStatus = 'ready';
          process.stderr.write(
            `[agent-service] 握手成功 ${ready.url} adapter=${String(ready.adapter ?? 'unknown')}\n`
          );
        } catch (err) {
          // 防御性解析：单行失败不置终态，继续等待后续行 / 超时兜底
          process.stderr.write(`[agent-service] 就绪行解析失败: ${(err as Error).message}\n`);
        }
      }
    });
    child.stderr?.on('data', (chunk: Buffer) => {
      // R6-6：Agent 日志落盘 + 透传主进程 stderr
      appendAgentLog('stderr', chunk);
      process.stderr.write(chunk);
    });

    child.on('exit', (code) => {
      clearTimeout(handshakeTimeout);
      if (agentServiceStatus === 'ready') {
        agentServiceStatus = 'stub';
        agentServiceError = {
          code: 'exited',
          message: `agent-service 进程已退出（code=${String(code)}）。可重启应用，或在「设置 → 日志」中查看 agent-service.log。`,
        };
      }
      agentServiceChild = null;
    });
    child.on('error', (err) => {
      clearTimeout(handshakeTimeout);
      agentServiceStatus = 'stub';
      agentServiceError = { code: 'spawn-error', message: `agent-service 启动失败：${err.message}` };
      agentServiceChild = null;
    });

    return agentServiceStatus;
  } catch (err) {
    agentServiceStatus = 'stub';
    agentServiceError = { code: 'spawn-error', message: `agent-service 启动失败：${(err as Error).message}` };
    return 'stub';
  }
}

/** 组装对渲染层暴露的网关状态 */
function buildGatewayStatus(): GatewayStatus {
  const bridgeReady = agentServiceStatus === 'ready' && gatewayClient !== null;
  const gateway: GatewayStatus['gateway'] = bridgeReady ? 'bridge' : 'none';
  return {
    agentService: agentServiceStatus,
    gateway,
    gatewayUrl: bridgeReady ? gatewayClient?.baseUrl : undefined,
    sessionsDir: bridgeReady ? sessionsDir() : undefined,
    skillsDir: bridgeReady ? skillsDir() : undefined,
    logsDir: logsDir(),
    error: bridgeReady ? undefined : (agentServiceError ?? undefined),
  };
}

/** 从 AgentRequest 提取信封 sessionId（缺省时兜底当前会话） */
function sessionIdOf(req: AgentRequest): string {
  return 'sessionId' in req && typeof req.sessionId === 'string' && req.sessionId.length > 0
    ? req.sessionId
    : 'session-local';
}

/** 异步启动链：读密钥库 → 组装 env → spawn（whenReady 与 restart 共用）。 */
async function startAgentService(): Promise<void> {
  agentServiceError = null; // 每次重新握手前清空旧原因，避免恢复后仍显示陈旧错误
  const env = await buildAgentServiceEnv();
  agentServiceStatus = trySpawnAgentService(env);
}

/** meta.db 初始化（storage 包；单写者=主进程；失败 fail-open 仅登记不阻塞）。 */
async function initStorage(): Promise<void> {
  try {
    const storage = await import('@aichdesign/storage');
    const dbPath = path.join(app.getPath('userData'), 'meta.db');
    metaDb = storage.openStorage(dbPath);
    storageRepos = {
      db: metaDb.db,
      images: new storage.ImageMetaRepository(metaDb.db),
    };
  } catch (err) {
    metaDb = null;
    storageRepos = null;
    process.stderr.write(`[storage] meta.db 初始化失败（不阻塞，仅不持久化）：${(err as Error).message}\n`);
  }
}

/** done 信封持久化（图像元数据 → meta.db；无句柄时静默跳过）。 */
function persistEnvelope(sessionId: string, envelope: SseEventEnvelope): void {
  if (!storageRepos || envelope.type !== 'done') return;
  const data = envelope.data as Record<string, unknown> | undefined;
  if (!data || typeof data !== 'object') return;
  try {
    if (data['kind'] === 'image') {
      void storageRepos.images.upsert({
        imageId: String(data['imageId']),
        sessionId,
        parentVersionId: null,
        meta: data['meta'] as never,
      });
    }
  } catch (err) {
    process.stderr.write(`[storage] 持久化失败（跳过）：${(err as Error).message}\n`);
  }
}

/** 正在 pump 的 requestId（R6 重连防重复拉流：在途泵已在广播，重挂只订阅即可）。 */
const pumpActive = new Set<string>();

/**
 * R6-13：已终态（done/error 已广播）的 requestId。activeRuns 只报在途运行——
 * 终态结果已随会话 jsonl/meta.db 恢复，再回放会把同一条消息显示两遍。
 */
const settledRequests = new Set<string>();

/** 广播事件到所有存活窗口（R6：渲染层刷新后新窗口也能收到在途事件）。 */
function broadcastEnvelope(envelope: SseEventEnvelope): void {
  for (const win of BrowserWindow.getAllWindows()) {
    if (!win.isDestroyed() && !win.webContents.isDestroyed()) {
      win.webContents.send(GATEWAY_EVENT_CHANNEL, envelope);
    }
  }
}

/** 主进程从网关拉 SSE 流并逐信封广播（P016 会话 token；R6 全窗口广播 + 终态回放复用） */
async function pumpStream(requestId: string, sessionId: string): Promise<void> {
  if (!gatewayClient || pumpActive.has(requestId)) {
    return;
  }
  pumpActive.add(requestId);
  try {
    const bearer = await getSessionToken(sessionId);
    await gatewayClient.stream(
      requestId,
      (envelope: SseEventEnvelope) => {
        if (envelope.type === 'done' || envelope.type === 'error') {
          settledRequests.add(requestId);
        }
        persistEnvelope(sessionId, envelope);
        broadcastEnvelope(envelope);
      },
      bearer,
    );
  } catch (err) {
    // R6-12：流异常不再吞掉底层原因——原样写主进程 stderr + 附入广播文案
    // （此前一律"网关流式响应中断"，排查时无法区分 404/401/超时/断连）。
    const detail = err instanceof Error ? err.message : String(err);
    process.stderr.write(`[gateway] 流式响应中断 requestId=${requestId}：${detail}\n`);
    const { ErrorCode } = await loadShared();
    broadcastEnvelope({
      requestId,
      sessionId,
      type: 'error',
      data: { code: ErrorCode.INTERNAL_ERROR, message: `网关流式响应中断：${detail}` },
    });
  } finally {
    pumpActive.delete(requestId);
    // R6：requestSessions 保留（供刷新后重挂/回放定位会话）；容量上限防线性增长
    if (requestSessions.size > 300) {
      const oldest = requestSessions.keys().next().value;
      if (oldest !== undefined) requestSessions.delete(oldest);
    }
    if (settledRequests.size > 300) {
      const oldest = settledRequests.values().next().value;
      if (oldest !== undefined) settledRequests.delete(oldest);
    }
  }
}

/** 判定是否为会话 token 轮换竞态（401 且持缓存 token）→ 调用方刷新重试一次。 */
function isUnauthorized(err: unknown): boolean {
  return err instanceof GatewayHttpError && err.code === 'UNAUTHORIZED';
}

/** 会话文件（<sessionsDir>/<sessionId>.jsonl）安全读取；sessionId 白名单防穿越。 */
function sessionFile(sessionId: string): string | null {
  if (!SESSION_ID_RE.test(sessionId)) return null;
  return path.join(sessionsDir(), `${sessionId}.jsonl`);
}

/** 会话文件读取上限（10MB；防异常超大文件读入内存）。 */
const SESSION_FILE_MAX_BYTES = 10 * 1024 * 1024;

function registerIpcHandlers(): void {
  ipcMain.handle('gateway:status', (): GatewayStatus => buildGatewayStatus());

  ipcMain.handle('gateway:run', async (_e, req: AgentRequest, runOptions?: RunOptions): Promise<{ requestId: string }> => {
    if (!gatewayClient) {
      const { ErrorCode } = await loadShared();
      throw new Error(`${ErrorCode.INTERNAL_ERROR}: 网关未就绪`);
    }
    const sessionId = sessionIdOf(req);
    // P016：优先会话 token；401（轮换竞态）刷新后重试一次；再失败回退进程级 token（兼容）
    let bearer = await getSessionToken(sessionId);
    const runWith = (b?: string): Promise<{ requestId: string }> => gatewayClient!.run(req, b, runOptions);
    let result: { requestId: string };
    try {
      result = await runWith(bearer);
    } catch (err) {
      if (bearer && isUnauthorized(err)) {
        invalidateSessionToken(sessionId);
        bearer = (await getSessionToken(sessionId, true)) ?? undefined;
        try {
          result = await runWith(bearer);
        } catch {
          result = await runWith(); // 进程级 token 兼容回退
        }
      } else {
        throw err;
      }
    }
    requestSessions.set(result.requestId, {
      sessionId,
      kind: 'kind' in req ? String(req.kind) : 'unknown',
      prompt: ('prompt' in req && typeof req.prompt === 'string'
        ? req.prompt
        : 'instruction' in req && typeof req.instruction === 'string'
          ? req.instruction
          : ''
      ).slice(0, 80),
    });
    // 自动拉起该 requestId 的 SSE 推送（bridge 模式全链路）
    void pumpStream(result.requestId, sessionId);
    return result;
  });

  // R5：上传参考图注册（dataURL → POST /v1/images → imageId 可作 genImage.refImageId/editImage.imageId）
  ipcMain.handle(
    'upload:image',
    async (_e, sessionId: string, dataUrl: string, name?: string): Promise<{ imageId: string; url: string }> => {
      if (!gatewayClient) {
        const { ErrorCode } = await loadShared();
        throw new Error(`${ErrorCode.INTERNAL_ERROR}: 网关未就绪`);
      }
      const bearer = await getSessionToken(sessionId);
      try {
        return await gatewayClient.uploadImage(sessionId, dataUrl, name, bearer);
      } catch (err) {
        if (bearer && isUnauthorized(err)) {
          invalidateSessionToken(sessionId);
          return gatewayClient.uploadImage(sessionId, dataUrl, name, (await getSessionToken(sessionId, true)) ?? undefined);
        }
        throw err;
      }
    },
  );

  ipcMain.handle('gateway:cancel', async (_e, requestId: string): Promise<void> => {
    if (!gatewayClient) {
      const { ErrorCode } = await loadShared();
      throw new Error(`${ErrorCode.INTERNAL_ERROR}: 网关未就绪`);
    }
    // P016：cancel 按 requestId 反查会话取 token
    const runInfo = requestSessions.get(requestId);
    const sessionId = runInfo?.sessionId;
    const bearer = sessionId ? await getSessionToken(sessionId) : undefined;
    try {
      await gatewayClient.cancel(requestId, bearer);
    } catch (err) {
      if (bearer && isUnauthorized(err) && sessionId) {
        invalidateSessionToken(sessionId);
        await gatewayClient.cancel(requestId, (await getSessionToken(sessionId, true)) ?? undefined);
      } else {
        throw err;
      }
    }
  });

  // R6：在途运行查询（渲染层刷新/切回后重连挂接——SSE 终态缓存可回放，结果永不丢）
  ipcMain.handle(
    'gateway:activeRuns',
    (): Array<{ requestId: string; sessionId: string; kind: string; prompt: string }> =>
      [...requestSessions.entries()]
        .filter(([requestId]) => !settledRequests.has(requestId)) // R6-13：终态 run 不再回放（防重复显示）
        .map(([requestId, info]) => ({ requestId, ...info })),
  );

  // R6：重挂单个请求——在途泵已在广播（仅订阅即可）；已终态则重新拉流回放缓存事件
  ipcMain.handle('gateway:reattach', (_e, requestId: string): void => {
    if (!gatewayClient || typeof requestId !== 'string' || requestId.length === 0) return;
    if (pumpActive.has(requestId)) return; // 在途：广播已覆盖新窗口
    const sessionId = requestSessions.get(requestId)?.sessionId ?? 'unknown';
    void pumpStream(requestId, sessionId);
  });

  // R6-3：外部链接经系统浏览器打开（Markdown 来源链接可点击；仅 http/https，防任意协议）
  ipcMain.handle('open:external', (_e, url: string): void => {
    if (typeof url !== 'string' || !/^https?:\/\//i.test(url)) {
      throw new Error('仅支持 http/https 外部链接');
    }
    void import('electron').then(({ shell }) => shell.openExternal(url));
  });

  // R6-3：打开外部技能文件夹（固定 userData/skills，不接受任意路径）；不存在则创建
  ipcMain.handle('skills:openDir', (): string => {
    const dir = skillsDir();
    fs.mkdirSync(dir, { recursive: true });
    void import('electron').then(({ shell }) => shell.openPath(dir));
    return dir;
  });

  // R6-3：重启本地服务（技能安装/变更后生效）
  ipcMain.handle('service:restart', async (): Promise<void> => {
    await restartAgentService();
  });

  // R6-4：外部技能列表（GET /v1/skills；渲染层加号菜单「选择技能」）
  ipcMain.handle('skills:list', async (): Promise<Array<{ name: string; description: string }>> => {
    if (!gatewayClient) return [];
    try {
      return await gatewayClient.listSkills(processToken);
    } catch {
      return [];
    }
  });

  // ---- 密钥管理（safeStorage 无口令方案；用户需求 2026-08-24） ----
  ipcMain.handle('secrets:status', (): SecretsStatus => {
    if (!secrets) throw new Error('密钥服务未初始化');
    return secrets.status();
  });

  ipcMain.handle('secrets:saveKeys', (_e, input: KeyConfigInput): SecretsStatus => {
    if (!secrets) throw new Error('密钥服务未初始化');
    // 保存（含清除）→ 重启 agent-service 使注入生效；同步返回状态
    const status = secrets.saveKeys(input);
    void restartAgentService();
    return status;
  });

  // R6-6：保存多模型条目（全量替换 + 激活 id）→ 重启生效
  ipcMain.handle(
    'secrets:saveModels',
    (
      _e,
      entries: Array<{ id?: string; name: string; baseUrl: string; model: string; apiKey?: string; thinking?: string }>,
      activeModelId: string,
    ): SecretsStatus => {
      if (!secrets) throw new Error('密钥服务未初始化');
      const status = secrets.saveModels(entries, activeModelId);
      void restartAgentService();
      return status;
    },
  );

  // R6-14：保存多图像服务商条目（保存 → 重启服务生效）
  ipcMain.handle(
    'secrets:saveImageModels',
    (
      _e,
      entries: Array<{ id?: string; name: string; url: string; editUrl?: string; model: string; apiKey?: string }>,
      activeImageModelId: string,
    ): SecretsStatus => {
      if (!secrets) throw new Error('密钥服务未初始化');
      const status = secrets.saveImageModels(entries, activeImageModelId);
      void restartAgentService();
      return status;
    },
  );

  // R6-14：无边框窗口控制（ZCode 同构自绘按钮；win:chromeChanged 推送见 createWindow）
  ipcMain.handle('win:minimize', (): void => {
    BrowserWindow.getFocusedWindow()?.minimize();
  });
  ipcMain.handle('win:toggleMaximize', (): void => {
    const w = BrowserWindow.getFocusedWindow();
    if (!w) return;
    if (w.isMaximized()) w.unmaximize();
    else w.maximize();
  });
  ipcMain.handle('win:close', (): void => {
    BrowserWindow.getFocusedWindow()?.close();
  });
  ipcMain.handle('win:chromeState', (): { isMaximized: boolean } => ({
    isMaximized: BrowserWindow.getFocusedWindow()?.isMaximized() ?? false,
  }));

  // R6-6：自定义会话目录（保存 → 重启服务生效；图像白名单/sessions IPC 同源切换）
  ipcMain.handle('config:setSessionsDir', async (_e, dir: string): Promise<void> => {
    if (!secrets) throw new Error('密钥服务未初始化');
    if (typeof dir !== 'string') throw new Error('路径必须为字符串');
    if (dir.length > 0 && !path.isAbsolute(dir)) throw new Error('必须为绝对路径');
    secrets.setSetting('app.sessionsDir', dir.trim());
    await restartAgentService();
  });

  // R6-7：文件夹选择对话框（会话目录自定义；返回所选路径或 null）
  ipcMain.handle('config:browseSessionsDir', async (): Promise<string | null> => {
    const { dialog } = await import('electron');
    const result = await dialog.showOpenDialog({
      title: '选择会话数据存储位置',
      properties: ['openDirectory', 'createDirectory'],
    });
    return result.canceled || result.filePaths.length === 0 ? null : result.filePaths[0]!;
  });

  // R6-9：Agent Loops 日志开关（写 settings，重启服务生效）
  ipcMain.handle('looplog:setEnabled', async (_e, enabled: boolean): Promise<void> => {
    if (!secrets) throw new Error('密钥服务未初始化');
    secrets.setSetting('app.loopLog', enabled ? '1' : '0');
    await restartAgentService();
  });

  // R6-13：单次运行工具调用轮次上限（设置 → Agent；保存后重启服务生效）
  ipcMain.handle('agent:setMaxToolCalls', (_e, value: number): SecretsStatus => {
    if (!secrets) throw new Error('密钥服务未初始化');
    const n = Math.floor(Number(value));
    if (!Number.isFinite(n) || n < 1 || n > 200) {
      throw new Error('轮次上限必须为 1~200 之间的整数');
    }
    secrets.setSetting('app.agent.maxToolCalls', String(n));
    void restartAgentService();
    return secrets.status();
  });

  // R6-6：打开 Agent 日志文件夹（自动创建）
  ipcMain.handle('logs:openDir', (): string => {
    const dir = logsDir();
    fs.mkdirSync(dir, { recursive: true });
    void import('electron').then(({ shell }) => shell.openPath(dir));
    return dir;
  });

  // ---- 会话历史（P-R3 前端重构：主进程读 sessions/*.jsonl） ----
  ipcMain.handle('sessions:list', (): SessionSummary[] => {
    const dir = sessionsDir();
    if (!fs.existsSync(dir)) return [];
    const summaries: SessionSummary[] = [];
    for (const name of fs.readdirSync(dir)) {
      if (!name.endsWith('.jsonl')) continue;
      const sessionId = name.slice(0, -'.jsonl'.length);
      if (!SESSION_ID_RE.test(sessionId)) continue;
      try {
        summaries.push(summarizeSession(sessionId, fs.readFileSync(path.join(dir, name), 'utf-8')));
      } catch {
        // 单文件损坏跳过（不阻塞列表）
      }
    }
    summaries.sort((a, b) => (a.lastTs < b.lastTs ? 1 : a.lastTs > b.lastTs ? -1 : 0));
    return summaries;
  });

  ipcMain.handle('sessions:read', (_e, sessionId: string): SessionContent => {
    const file = sessionFile(sessionId);
    // 新会话尚无 jsonl → 返回空内容（渲染层视为空白，不抛错避免 IPC 噪音日志）
    if (!file || !fs.existsSync(file)) {
      return {
        sessionId,
        title: '（新会话）',
        messages: [],
        images: [],
      };
    }
    const stat = fs.statSync(file);
    if (stat.size > SESSION_FILE_MAX_BYTES) {
      throw new Error(`会话文件超过读取上限（${Math.floor(SESSION_FILE_MAX_BYTES / 1024 / 1024)}MB）`);
    }
    return parseSessionContent(sessionId, fs.readFileSync(file, 'utf-8'));
  });

  // R6-9：删除历史会话（jsonl + meta.db 级联：方案/图像/费用/session 行）
  ipcMain.handle('sessions:delete', (_e, sessionId: string): { ok: boolean; removed: number } => {
    const file = sessionFile(sessionId);
    let removed = 0;
    if (file && fs.existsSync(file)) {
      fs.rmSync(file, { force: true });
      removed += 1;
    }
    if (storageRepos) {
      try {
        void import('@aichdesign/storage').then((storage) => {
          removed += storage.deleteSessionCascade(storageRepos!.db, sessionId);
        });
      } catch (err) {
        process.stderr.write(`[storage] 会话级联删除失败：${(err as Error).message}
`);
      }
    }
    return { ok: true, removed };
  });

  // R7-2 反馈：画布删除 = 仅移出画布——会话 jsonl 中该 image 条目打 canvasRemoved 标记（原位改写，
  // 原子重写）；对话消息的图片引用（user.imageIds 回填）与磁盘文件一律不动，对话内容不受影响。
  // 幂等：重复删除 / 未注册 id（画布复制件）无匹配行时静默成功。
  ipcMain.handle(
    'sessions:deleteImage',
    (_e, sessionId: string, imageId: string): { ok: boolean } => {
      if (typeof sessionId !== 'string' || !SESSION_ID_RE.test(sessionId)) {
        throw new Error('非法 sessionId');
      }
      if (typeof imageId !== 'string' || !/^[A-Za-z0-9._-]{1,80}$/.test(imageId)) {
        throw new Error('非法 imageId');
      }
      const file = sessionFile(sessionId);
      if (!file || !fs.existsSync(file)) return { ok: true };
      const stat = fs.statSync(file);
      if (stat.size > SESSION_FILE_MAX_BYTES) {
        throw new Error(`会话文件超过处理上限（${Math.floor(SESSION_FILE_MAX_BYTES / 1024 / 1024)}MB）`);
      }
      const lines = fs.readFileSync(file, 'utf-8').split('\n');
      let changed = false;
      const kept: string[] = [];
      for (const line of lines) {
        if (line.trim() === '') continue;
        try {
          const entry = JSON.parse(line) as { kind?: string; data?: Record<string, unknown> };
          if (entry.kind === 'image' && entry.data?.imageId === imageId && entry.data.canvasRemoved !== true) {
            kept.push(JSON.stringify({ ...entry, data: { ...entry.data, canvasRemoved: true } }));
            changed = true;
            continue;
          }
        } catch {
          // 损坏行原样保留
        }
        kept.push(line);
      }
      if (changed) {
        const tmp = `${file}.tmp-${process.pid}-${Date.now()}`;
        fs.writeFileSync(tmp, kept.length > 0 ? `${kept.join('\n')}\n` : '', 'utf-8');
        fs.renameSync(tmp, file);
      }
      return { ok: true };
    },
  );

  // ---- G8：file:// 图像兜底（白名单读取 → dataURL；dev http 源无法直接显示 file:// img） ----
  ipcMain.handle('image:readDataUrl', (_e, uri: string): string => {
    if (typeof uri !== 'string' || uri.length === 0) {
      throw new Error('图像 URI 非法');
    }
    const local = toLocalPath(uri);
    if (local === null) {
      throw new Error('仅支持 file:// 或本地路径图像兜底');
    }
    // 白名单：sessions 目录（含 images/ 子目录）——与 backend G2 修复同语义，fail-closed
    if (!isInsideRoots(local, [path.join(sessionsDir(), 'images'), sessionsDir()], path.resolve)) {
      throw new Error('图像路径不在会话数据目录白名单内');
    }
    const bytes = fs.readFileSync(local);
    if (bytes.length > IMAGE_MAX_BYTES) {
      throw new Error(`图像超过大小上限（${Math.floor(IMAGE_MAX_BYTES / 1024 / 1024)}MB）`);
    }
    const mime = sniffImageMime(bytes);
    if (mime === null) {
      throw new Error('无法识别的图像格式（仅 png/jpeg/webp/gif）');
    }
    return toDataUrl(bytes, mime);
  });
}

/** dev server URL 来源校验（R015）：仅信任本机 loopback HTTP 地址，防任意 URL 加载 */
function isTrustedDevUrl(url: string): boolean {
  try {
    const u = new URL(url);
    return u.protocol === 'http:' && (u.hostname === 'localhost' || u.hostname === '127.0.0.1');
  } catch {
    return false;
  }
}

function createWindow(): void {
  // R6-14：无边框窗口（ZCode 同构）——Windows/Linux frame:false（渲染层自绘窗口按钮），
  // macOS 保留系统红绿灯（titleBarStyle hidden）。backgroundColor 与暗色主题一致。
  mainWindow = new BrowserWindow({
    width: 1360,
    height: 860,
    minWidth: 1024,
    minHeight: 700,
    title: 'AICH Design',
    backgroundColor: '#0c0c0c',
    ...(process.platform === 'darwin'
      ? { titleBarStyle: 'hidden' as const }
      : { frame: false as const }),
    webPreferences: {
      preload: path.join(__dirname, 'preload.cjs'),
      contextIsolation: true,
      nodeIntegration: false,
      // R015：显式开启渲染进程沙箱（preload 仅用 contextBridge/ipcRenderer，沙箱兼容）
      sandbox: true,
    },
  });

  // R6-14：窗口 chrome 状态推送（maximize/unmaximize → 渲染层切换最大化/还原图标）
  const sendChromeState = (): void => {
    if (mainWindow && !mainWindow.isDestroyed()) {
      mainWindow.webContents.send(WINDOW_CHROME_CHANNEL, { isMaximized: mainWindow.isMaximized() });
    }
  };
  mainWindow.on('maximize', sendChromeState);
  mainWindow.on('unmaximize', sendChromeState);

  // 开发：加载 Vite dev server（仅可信本机地址）；否则加载 packages/app/dist-renderer 产物
  const devServerUrl = process.env.VITE_DEV_SERVER_URL;
  const rendererHtml = path.join(__dirname, '..', '..', 'dist-renderer', 'index.html');
  if (devServerUrl && isTrustedDevUrl(devServerUrl)) {
    void mainWindow.loadURL(devServerUrl);
  } else {
    void mainWindow.loadFile(rendererHtml);
  }

  mainWindow.on('closed', () => {
    mainWindow = null;
  });
}

/** 中文应用菜单（R6-3：File/Edit/View/Window 本地化，移除 Help；角色保留标准行为）。 */
function setupApplicationMenu(): void {
  void import('electron').then(({ Menu }) => {
    const menu = Menu.buildFromTemplate([
      {
        label: '文件',
        submenu: [{ role: 'quit', label: '退出' }],
      },
      {
        label: '编辑',
        submenu: [
          { role: 'undo', label: '撤销' },
          { role: 'redo', label: '重做' },
          { type: 'separator' },
          { role: 'cut', label: '剪切' },
          { role: 'copy', label: '复制' },
          { role: 'paste', label: '粘贴' },
          { role: 'selectAll', label: '全选' },
        ],
      },
      {
        label: '视图',
        submenu: [
          { role: 'reload', label: '重新加载' },
          { role: 'forceReload', label: '强制重新加载' },
          { role: 'toggleDevTools', label: '开发者工具' },
          { type: 'separator' },
          { role: 'resetZoom', label: '实际大小' },
          { role: 'zoomIn', label: '放大' },
          { role: 'zoomOut', label: '缩小' },
          { type: 'separator' },
          { role: 'togglefullscreen', label: '全屏' },
        ],
      },
      {
        label: '窗口',
        submenu: [
          { role: 'minimize', label: '最小化' },
          { role: 'zoom', label: '缩放' },
          { role: 'close', label: '关闭窗口' },
        ],
      },
    ]);
    Menu.setApplicationMenu(menu);
  });
}

app.whenReady().then(() => {
  // 密钥服务（safeStorage）：无 Key/解密失败时 agent-service 不注入对应端点（该功能显式报错）
  secrets = new SecretsService(app.getPath('userData'));
  setupApplicationMenu();
  registerIpcHandlers();
  createWindow();
  // 尽量拉起 agent-service；失败不影响壳启动（渲染层显式报错，见 buildGatewayStatus）
  void startAgentService();
  void initStorage();

  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) {
      createWindow();
    }
  });
});

app.on('window-all-closed', () => {
  // win32 全部窗口关闭即退出（macOS 习惯保留，此处按桌面工具常规定义）
  if (process.platform !== 'darwin') {
    app.quit();
  }
});

app.on('quit', () => {
  if (agentServiceChild && !agentServiceChild.killed) {
    agentServiceChild.kill();
  }
});