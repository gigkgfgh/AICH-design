/**
 * agent-service 冒烟自测（P006 验收辅助）。
 *
 * 用法：
 *   node test/server.js              # 依赖自检（不启动常驻进程）
 *   node test/server.js --smoke      # 同自检 + 若 dist 已构建则启动 → 健康检查 → 关闭
 *
 * 说明：本机 npm 不可用（docs/ENVIRONMENT.md 快照），依赖未安装时输出降级记录
 * （AGENTS.md 铁律 8），不反复尝试；最终实机验证由主 Agent/用户执行。
 *
 * 环境约定：node -v / node --check 可用；启动自测必须配合 timeout 且测完即关。
 */

import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);
const root = new URL("../", import.meta.url);

function resolveOrNull(spec) {
  try {
    return require.resolve(spec, { paths: [root.pathname] });
  } catch {
    return null;
  }
}

function check(name, ok, detail = "") {
  console.log(`${ok ? "[OK]" : "[MISS]"} ${name}${detail ? ` — ${detail}` : ""}`);
  return ok;
}

function smoke() {
  console.log("== agent-service 依赖自检 ==");
  const piAgentCore = resolveOrNull("@earendil-works/pi-agent-core");
  const piAi = resolveOrNull("@earendil-works/pi-ai");
  const shared = resolveOrNull("@aichdesign/shared");
  const extensions = resolveOrNull("@aichdesign/extensions");
  const mockProvider = resolveOrNull("@aichdesign/mock-provider");

  const all = [
    check("node 运行时", true, process.version),
    check("@earendil-works/pi-agent-core@0.84.x", piAgentCore !== null),
    check("@earendil-works/pi-ai@0.84.x", piAi !== null),
  ];
  // workspace 包以 TS 源码形式解析（bundler 解析），Node 直跑需先构建。
  check("@aichdesign/shared (workspace)", shared !== null, shared ? "TS 源码解析（需 tsc 构建后运行）" : "workspace 未链接");
  check("@aichdesign/extensions (workspace)", extensions !== null);
  check("@aichdesign/mock-provider (workspace)", mockProvider !== null);

  if (!all.every(Boolean)) {
    console.log(
      "\n未能运行验证：npm 依赖未安装（环境快照：npm 不可用/网络受限）。" +
        "已按命令降级路径继续交付（静态代码 + node --check 语法自测）；实机验证由主 Agent/用户执行。",
    );
    return false;
  }
  return true;
}

function bootAndHealthCheck() {
  const dist = new URL("../dist/main.js", import.meta.url);
  if (!existsSync(dist)) {
    console.log("\n未能运行验证：dist/main.js 不存在（未执行 npm run build），跳过启动冒烟。");
    return;
  }
  console.log("\n== 启动冒烟（timeout 15s）==");
  const child = spawn(process.execPath, [dist.pathname], {
    stdio: ["ignore", "pipe", "pipe"],
    env: { ...process.env, AICH_ADAPTER: "mock", AICH_PORT: "0", AICH_IMAGE_MOCK: "1" },
  });
  let readyLine = "";
  const timer = setTimeout(() => {
    console.log("启动超时（15s），关闭进程。");
    child.kill();
    process.exit(1);
  }, 15000);
  child.stdout.on("data", (chunk) => {
    process.stdout.write(chunk);
    readyLine += chunk.toString("utf8");
    const match = readyLine.match(/AICH_GATEWAY_READY (\{.*\})/);
    if (match) {
      const info = JSON.parse(match[1]);
      console.log(`健康检查 ${info.url}/v1/health …`);
      fetch(`${info.url}/v1/health`, {
        headers: { Authorization: `Bearer ${info.token}` },
      })
        .then((res) => res.json())
        .then((body) => {
          console.log(`health: ${JSON.stringify(body)}`);
          return runImageChain(info);
        })
        .then(() => {
          child.kill();
          clearTimeout(timer);
          process.exit(0);
        })
        .catch((error) => {
          console.error("冒烟失败：", error.message);
          child.kill();
          clearTimeout(timer);
          process.exit(1);
        });
    }
  });
  child.stderr.on("data", (chunk) => process.stderr.write(chunk));
  child.on("error", (error) => {
    clearTimeout(timer);
    console.error("spawn 失败：", error.message);
    process.exit(1);
  });
}

/** P012 全链路冒烟：genImage → SSE done(image)，url 为本地 file://（MockImageProvider + ImageRegistry）。 */
async function runImageChain(info) {
  const run = await fetch(`${info.url}/v1/run`, {
    method: "POST",
    headers: { Authorization: `Bearer ${info.token}`, "content-type": "application/json" },
    body: JSON.stringify({
      requestId: "smoke-image-1",
      sessionId: "smoke-1",
      request: { kind: "genImage", sessionId: "smoke-1", prompt: "两室一厅客厅表现图" },
    }),
  });
  if (run.status !== 202) {
    throw new Error(`POST /v1/run 期望 202，收到 ${run.status}`);
  }
  const runBody = await run.json();
  console.log(`run: ${JSON.stringify(runBody)}`);
  const streamRes = await fetch(`${info.url}${runBody.streamUrl}`, {
    headers: { Authorization: `Bearer ${info.token}` },
  });
  const body = await streamRes.text();
  const events = [];
  for (const block of body.split("\n\n")) {
    const line = block.split("\n").find((l) => l.startsWith("data: "));
    if (line) events.push(JSON.parse(line.slice(6)));
  }
  const done = events.find((e) => e.type === "done");
  if (!done) throw new Error(`SSE 缺少 done 事件（收到 ${events.map((e) => e.type).join(",")}）`);
  const data = done.data;
  if (data.kind !== "image" || typeof data.imageId !== "string" || typeof data.meta !== "object") {
    throw new Error(`done 载荷非 image 形状：${JSON.stringify(data).slice(0, 200)}`);
  }
  if (!data.url.startsWith("file:///")) {
    throw new Error(`done.image url 应为本机 file://，收到：${data.url.slice(0, 80)}`);
  }
  console.log(`image done: imageId=${data.imageId} url=${data.url} meta.costUsd=${data.meta.costUsd}`);
  console.log("P012 图像全链路冒烟通过（mock generate → 落盘 → done image）。");
}

const args = process.argv.slice(2);
if (args.includes("--smoke")) {
  if (smoke()) bootAndHealthCheck();
} else {
  smoke();
}