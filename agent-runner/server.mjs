// Agent runner: a small local HTTP service that executes one agent turn through the Claude Agent SDK.
// The .NET orchestrator calls POST /run for every agent. Running in Node means TLS goes through
// OpenSSL, which works on machines where Windows SChannel cannot reach api.anthropic.com.
import http from "node:http";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { query } from "@anthropic-ai/claude-agent-sdk";

const PORT = Number(process.env.VC_RUNNER_PORT || 5081);
const HERE = path.dirname(fileURLToPath(import.meta.url));
const WORKSPACE = path.join(HERE, "workspace");   // neutral cwd: no CLAUDE.md or project settings leak in
fs.mkdirSync(WORKSPACE, { recursive: true });
const EFFORTS = new Set(["low", "medium", "high", "xhigh", "max"]);

async function runAgent({ model, effort, system, prompt, tools = [], maxTurns = 1 }) {
  const options = {
    model,
    systemPrompt: system,
    tools,                 // [] = plain completion, no file or shell access
    maxTurns,
    settingSources: [],    // ignore ~/.claude and project settings
    persistSession: false,
    cwd: WORKSPACE,
    env: { ...process.env, CLAUDE_AGENT_SDK_CLIENT_APP: "virtual-company/1.0" },
  };
  if (EFFORTS.has(effort)) options.effort = effort;

  let result = null;
  for await (const msg of query({ prompt, options })) {
    if (msg.type === "result") result = msg;
  }
  if (!result) throw new Error("The agent finished without a result.");

  const usage = Object.values(result.modelUsage || {});
  const inputTokens = usage.reduce((n, u) => n + u.inputTokens + u.cacheReadInputTokens + u.cacheCreationInputTokens, 0);
  const outputTokens = usage.reduce((n, u) => n + u.outputTokens, 0);
  if (result.subtype !== "success")
    return { ok: false, error: (result.errors || []).join("; ") || result.subtype, inputTokens, outputTokens, costUsd: result.total_cost_usd };
  return { ok: true, text: result.result, inputTokens, outputTokens, costUsd: result.total_cost_usd, stopReason: result.stop_reason || "end_turn" };
}

function send(res, status, body) {
  res.writeHead(status, { "Content-Type": "application/json" });
  res.end(JSON.stringify(body));
}

http.createServer(async (req, res) => {
  if (req.method === "GET" && req.url === "/health") return send(res, 200, { ok: true, keySet: !!process.env.ANTHROPIC_API_KEY });
  if (req.method !== "POST" || req.url !== "/run") return send(res, 404, { error: "Not found" });
  let raw = "";
  for await (const chunk of req) raw += chunk;
  const started = Date.now();
  try {
    const job = JSON.parse(raw);
    const out = await runAgent(job);
    console.log(`${new Date().toISOString()} ${job.agentId} ${job.model} ${out.ok ? "ok" : "error"} ${Date.now() - started}ms in=${out.inputTokens} out=${out.outputTokens} $${(out.costUsd ?? 0).toFixed(4)}`);
    send(res, out.ok ? 200 : 502, out);
  } catch (e) {
    console.error(`${new Date().toISOString()} run failed: ${e.message}`);
    send(res, 500, { ok: false, error: e.message });
  }
}).listen(PORT, "127.0.0.1", () => console.log(`Agent runner listening on http://127.0.0.1:${PORT}`));
