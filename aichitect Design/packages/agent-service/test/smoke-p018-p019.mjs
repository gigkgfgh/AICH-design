/**
 * P018/P019 真机冒烟（R024 复核 + rehydration 进程级恢复）：
 * 1. 启动 agent-service（mock adapter，200ms 延迟）；
 * 2. POST /v1/run draftPlan → 立即 POST /v1/cancel → 读 SSE 终态，
 *    断言终态码 = REQUEST_CANCELLED（R024：cancel 优先于 terminalError）；
 * 3. 再跑一轮正常 draftPlan（等 done）；
 * 4. 杀进程 →「重启」：新进程读同一 sessions 目录，用 ContextManager.recoverSession
 *    恢复消息/版本树/硬约束（P019 rehydration）。
 * 运行：node test/smoke-p018-p019.mjs（exit 0 = 通过）。
 */

import { spawn, execFileSync } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import readline from "node:readline";

const pkgRoot = fileURLToPath(new URL("..", import.meta.url));
const dir = mkdtempSync(join(tmpdir(), "aich-smoke-"));
const sessionsDir = join(dir, "sessions");

function startService() {
  const child = spawn(process.execPath, [join(pkgRoot, "dist", "main.js")], {
    env: {
      ...process.env,
      AICH_ADAPTER: "mock",
      AICH_SESSIONS_DIR: sessionsDir,
      AICH_MOCK_DELAY_MS: "200",
      AICH_IMAGE_MOCK: "1",
      AICH_TOKEN: "smoke-token",
      AICH_PORT: "0",
    },
    stdio: ["ignore", "pipe", "pipe"],
  });
  return new Promise((resolve, reject) => {
    const rl = readline.createInterface({ input: child.stdout });
    rl.on("line", (line) => {
      if (line.startsWith("AICH_GATEWAY_READY")) {
        const info = JSON.parse(line.slice("AICH_GATEWAY_READY".length).trim());
        resolve({ child, url: info.url, token: info.token });
      }
    });
    child.stderr.on("data", (d) => process.stderr.write(`[svc] ${d}`));
    child.on("exit", (code) => reject(new Error(`service exited early code=${code}`)));
    setTimeout(() => reject(new Error("gateway ready 超时")), 10000);
  });
}

async function api(url, token, path, body) {
  const res = await fetch(`${url}${path}`, {
    method: body ? "POST" : "GET",
    headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
    body: body ? JSON.stringify(body) : undefined,
  });
  return { status: res.status, json: await res.json().catch(() => null) };
}

async function readSseTerminal(url, token, requestId) {
  const res = await fetch(`${url}/v1/stream/${requestId}`, { headers: { authorization: `Bearer ${token}` } });
  const text = await res.text();
  const events = text.split("\n").filter((l) => l.startsWith("data:")).map((l) => JSON.parse(l.slice(5).trim()));
  const last = events.at(-1);
  return last;
}

async function waitTerminal(url, token, requestId, timeoutMs = 15000, bearer) {
  const authHeader = { authorization: `Bearer ${bearer ?? token}` };
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    await new Promise((r) => setTimeout(r, 150));
    const res = await fetch(`${url}/v1/stream/${requestId}`, { headers: authHeader });
    if (res.status === 200) {
      const text = await res.text();
      if (text.includes("event: error") || text.includes("event: done")) {
        const events = text.split("\n").filter((l) => l.startsWith("data:")).map((l) => JSON.parse(l.slice(5).trim()));
        return events.at(-1);
      }
    }
  }
  throw new Error(`等待 ${requestId} 终态超时`);
}

const assert = (cond, label) => {
  if (!cond) throw new Error(`断言失败：${label}`);
  console.log(`  ✓ ${label}`);
};

try {
  // ---- 启动 ----
  const { child, url, token } = await startService();
  console.log(`service up: ${url}`);

  // ---- R024：cancel 终态码 ----
  const run1 = await api(url, token, "/v1/run", {
    requestId: "req-cancel-1",
    sessionId: "smoke-s1",
    request: { kind: "draftPlan", sessionId: "smoke-s1", prompt: "设计 12x8米 两室一厅，主卧必须朝南" },
  });
  assert(run1.status === 202, "draftPlan 已受理（202）");
  await api(url, token, "/v1/cancel", { requestId: "req-cancel-1" });
  const cancelTerminal = await waitTerminal(url, token, "req-cancel-1");
  assert(cancelTerminal.type === "error" && cancelTerminal.data.code === "REQUEST_CANCELLED",
    `R024 复核：cancel 终态码 = REQUEST_CANCELLED（实际 ${cancelTerminal?.data?.code}）`);

  // ---- 正常一轮 draftPlan ----
  await api(url, token, "/v1/run", {
    requestId: "req-plan-1",
    sessionId: "smoke-s1",
    request: { kind: "draftPlan", sessionId: "smoke-s1", prompt: "设计 10x8米 两室一厅，主卧朝南" },
  });
  const doneTerminal = await waitTerminal(url, token, "req-plan-1");
  assert(doneTerminal.type === "done" && doneTerminal.data.kind === "plan", "draftPlan 完成（done plan）");

  // ---- P016：authorize → 会话 token 全链路 ----
  const authRes = await fetch(`${url}/v1/authorize`, {
    method: "POST",
    headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
    body: JSON.stringify({ sessionId: "smoke-s1" }),
  });
  assert(authRes.status === 200, "authorize 签发（进程级 token bootstrap）");
  const { token: sessionToken } = await authRes.json();
  const runWithSession = await fetch(`${url}/v1/run`, {
    method: "POST",
    headers: { authorization: `Bearer ${sessionToken}`, "content-type": "application/json" },
    body: JSON.stringify({
      requestId: "req-plan-2",
      sessionId: "smoke-s1",
      request: { kind: "draftPlan", sessionId: "smoke-s1", prompt: "设计 8x6米 一室一厅" },
    }),
  });
  assert(runWithSession.status === 202, "会话 token 发起 run（202）");
  const sessionDone = await waitTerminal(url, token, "req-plan-2", 15000, sessionToken);
  assert(sessionDone.type === "done" && sessionDone.data.kind === "plan", "会话 token 读 stream（done plan）");
  const healthWithSession = await fetch(`${url}/v1/health`, { headers: { authorization: `Bearer ${sessionToken}` } });
  assert(healthWithSession.status === 401, "health 拒会话 token（仅进程级）");

  // ---- 杀进程（模拟崩溃/重启） ----
  child.kill("SIGKILL");
  await new Promise((r) => setTimeout(r, 300));
  console.log("service killed; 重启恢复中…");

  // ---- 「重启」：ContextManager.recoverSession 从 jsonl 重建 ----
  const { writeFileSync } = await import("node:fs");
  const recoverScript = join(dir, "recover.mjs");
  // Windows 绝对路径静态 import 不合法（protocol 'd:'），须转 file:// URL。
  writeFileSync(
    recoverScript,
    [
      `import { pathToFileURL } from "node:url";`,
      `const { JsonlSessionStore } = await import(pathToFileURL(${JSON.stringify(join(pkgRoot, "dist", "session", "jsonl-store.js"))}).href);`,
      `const { ContextManager } = await import(pathToFileURL(${JSON.stringify(join(pkgRoot, "dist", "session", "context-manager.js"))}).href);`,
      `const store = new JsonlSessionStore(${JSON.stringify(sessionsDir)});`,
      `const cm = new ContextManager(store);`,
      `const snap = cm.recoverSession("smoke-s1");`,
      `console.log(JSON.stringify({`,
      `  messages: snap.messages.length,`,
      `  users: snap.messages.filter(m => m.kind === "user").length,`,
      `  plans: snap.planVersions.length,`,
      `  constraints: snap.hardConstraints,`,
      `  compressed: snap.compressed,`,
      `}));`,
    ].join("\n"),
    "utf8",
  );
  const out = execFileSync(process.execPath, [recoverScript], { encoding: "utf8" });
  const recovered = JSON.parse(out.trim().split("\n").at(-1));
  console.log("  recovered:", JSON.stringify(recovered));
  assert(recovered.users >= 2, "恢复 ≥2 条用户消息");
  assert(recovered.plans >= 1, "恢复版本树引用");
  assert(recovered.constraints.some((c) => c.includes("10x8米") || c.includes("12x8米")), "恢复硬约束（尺寸）");
  assert(recovered.constraints.some((c) => c.includes("朝南") || c.includes("必须朝南")), "恢复硬约束（朝向）");

  console.log("SMOKE-P018-P019 OK");
} finally {
  rmSync(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
}
