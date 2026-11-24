// Agent runner: a small local HTTP service that executes one agent turn through the Claude Agent SDK.
// The .NET orchestrator calls POST /run for every agent. Running in Node means TLS goes through
// OpenSSL, which works on machines where Windows SChannel cannot reach api.anthropic.com.
import http from "node:http";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { query } from "@anthropic-ai/claude-agent-sdk";
import { makeGuard } from "./guard.mjs";

const PORT = Number(process.env.VC_RUNNER_PORT || 5081);
const HERE = path.dirname(fileURLToPath(import.meta.url));
const WORKSPACE = path.join(HERE, "workspace");   // neutral cwd for document-only agents
fs.mkdirSync(WORKSPACE, { recursive: true });
const EFFORTS = new Set(["low", "medium", "high", "xhigh", "max"]);
const GIT_BASH = ["C:\\Program Files\\Git\\bin\\bash.exe", "C:\\Program Files (x86)\\Git\\bin\\bash.exe"].find(p => fs.existsSync(p));
const log = line => console.log(`${new Date().toISOString()} ${line}`);

async function runAgent({ agentId, model, effort, system, prompt, maxOutputTokens, tools = [], cwd, maxTurns = 1, maxBudgetUsd }) {
  const usesTools = Array.isArray(tools) && tools.length > 0 && cwd && fs.existsSync(cwd);
  const options = {
    model,
    systemPrompt: system,
    tools: usesTools ? tools : [],   // [] = plain completion, no file or shell access
    maxTurns: usesTools ? maxTurns : 1,
    settingSources: [],              // ignore ~/.claude and project settings
    persistSession: false,
    cwd: usesTools ? cwd : WORKSPACE,
    env: { ...process.env, CLAUDE_AGENT_SDK_CLIENT_APP: "virtual-company/1.0" },
  };
  if (EFFORTS.has(effort)) options.effort = effort;
  if (usesTools) {
    options.canUseTool = makeGuard(cwd, agentId, log);
    if (GIT_BASH) options.env.CLAUDE_CODE_GIT_BASH_PATH = GIT_BASH;
    if (Number(maxBudgetUsd) > 0) options.maxBudgetUsd = Number(maxBudgetUsd);
  }
  // Hard cap on one reply (thinking included). Tool runs write whole files in one call, so they get more room.
  const cap = usesTools ? Math.max(maxOutputTokens || 0, 32000) : maxOutputTokens;
  if (Number.isFinite(cap) && cap > 0) options.env.CLAUDE_CODE_MAX_OUTPUT_TOKENS = String(Math.floor(cap));

  let result = null, turns = 0;
  for await (const msg of query({ prompt, options })) {
    if (msg.type === "assistant") turns++;
    if (msg.type === "result") result = msg;
  }
  if (!result) throw new Error("The agent finished without a result.");

  const usage = Object.values(result.modelUsage || {});
  const inputTokens = usage.reduce((n, u) => n + u.inputTokens + u.cacheReadInputTokens + u.cacheCreationInputTokens, 0);
  const outputTokens = usage.reduce((n, u) => n + u.outputTokens, 0);
  if (result.subtype !== "success") {
    // A tool run that hit its turn or dollar cap has still written files; report it instead of failing the pipeline.
    if (usesTools && (result.subtype === "error_max_turns" || result.subtype === "error_max_budget_usd")) {
      const why = result.subtype === "error_max_turns" ? `its limit of ${maxTurns} steps` : `its budget of $${maxBudgetUsd}`;
      const text = `The agent stopped at ${why} before writing its report. The files it wrote so far are in the app folder.\n` +
                   "```json\n" + JSON.stringify({ status: "done", summary: `Stopped early at ${why}; the work may be incomplete.` }) + "\n```";
      return { ok: true, text, inputTokens, outputTokens, costUsd: result.total_cost_usd, stopReason: result.subtype, turns };
    }
    return { ok: false, error: (result.errors || []).join("; ") || result.subtype, inputTokens, outputTokens, costUsd: result.total_cost_usd };
  }
  return { ok: true, text: result.result, inputTokens, outputTokens, costUsd: result.total_cost_usd, stopReason: result.stop_reason || "end_turn", turns };
}

// The engine fails a call whose reply passes the output cap instead of truncating it. Retry once, asking for a
// much shorter answer, so one wordy reply does not stop the whole pipeline.
const TOO_LONG = /exceeded the \d+ output token maximum/;
async function runWithRetry(job) {
  try {
    return await runAgent(job);
  } catch (e) {
    if (!TOO_LONG.test(e.message)) throw e;
    log(`${job.agentId} reply exceeded the output cap; retrying shorter`);
    const note = "\n\nIMPORTANT: your previous attempt was rejected for being too long. Write it again at about half the length: " +
                 "only the essential content, no preamble, then the mandatory final json block.";
    return await runAgent({ ...job, prompt: job.prompt + note, maxOutputTokens: Math.round((job.maxOutputTokens || 8000) * 1.5) });
  }
}

function send(res, status, body) {
  res.writeHead(status, { "Content-Type": "application/json" });
  res.end(JSON.stringify(body));
}

http.createServer(async (req, res) => {
  if (req.method === "GET" && req.url === "/health") return send(res, 200, { ok: true, keySet: !!process.env.ANTHROPIC_API_KEY, gitBash: !!GIT_BASH });
  if (req.method !== "POST" || req.url !== "/run") return send(res, 404, { error: "Not found" });
  let raw = "";
  for await (const chunk of req) raw += chunk;
  const started = Date.now();
  try {
    const job = JSON.parse(raw);
    const out = await runWithRetry(job);
    log(`${job.agentId} ${job.model} ${out.ok ? "ok" : "error"} ${Date.now() - started}ms${out.turns ? ` turns=${out.turns}` : ""} in=${out.inputTokens} out=${out.outputTokens} $${(out.costUsd ?? 0).toFixed(4)}${out.stopReason?.startsWith("error_") ? " " + out.stopReason : ""}`);
    send(res, out.ok ? 200 : 502, out);
  } catch (e) {
    log(`run failed: ${e.message}`);
    send(res, 500, { ok: false, error: e.message });
  }
}).listen(PORT, "127.0.0.1", () => log(`Agent runner listening on http://127.0.0.1:${PORT}${GIT_BASH ? "" : " (Git Bash not found: Bash tool unavailable)"}`));
