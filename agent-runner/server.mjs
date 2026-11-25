// Agent runner: a small local HTTP service that executes one agent turn through the Claude Agent SDK.
// The .NET orchestrator calls POST /run for every agent. Running in Node means TLS goes through
// OpenSSL, which works on machines where Windows SChannel cannot reach api.anthropic.com.
import http from "node:http";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { query } from "@anthropic-ai/claude-agent-sdk";
import { makeGuard } from "./guard.mjs";
import { browse } from "./browse.mjs";

const PORT = Number(process.env.VC_RUNNER_PORT || 5081);
const HERE = path.dirname(fileURLToPath(import.meta.url));
const WORKSPACE = path.join(HERE, "workspace");   // neutral cwd for document-only agents
fs.mkdirSync(WORKSPACE, { recursive: true });
// Authentication: the engine uses Claude Code's own sign-in on this machine (~/.claude), or a standard Console API
// key (sk-ant-api...) in ANTHROPIC_API_KEY. A "sk-ant-usr-" key is not accepted by the engine (tested 2026-11-25),
// even though it works for direct API calls. Set VC_ISOLATE_AUTH=1 to ignore the machine's sign-in and use only the key.
const CONFIG_DIR = process.env.VC_ISOLATE_AUTH === "1" ? path.join(HERE, "workspace", ".claude-config") : null;
if (CONFIG_DIR) fs.mkdirSync(CONFIG_DIR, { recursive: true });
const EFFORTS = new Set(["low", "medium", "high", "xhigh", "max"]);
const GIT_BASH = ["C:\\Program Files\\Git\\bin\\bash.exe", "C:\\Program Files (x86)\\Git\\bin\\bash.exe"].find(p => fs.existsSync(p));
const log = line => console.log(`${new Date().toISOString()} ${line}`);

// ---------- live progress: what each running agent is doing right now ----------
// phase: starting (waiting for the first token) | thinking | writing | tool | retrying | rate_limited
const jobs = new Map();
// Projects the CEO paused: their agents wait before each next action (tool use) until they are continued.
const pausedProjects = new Set();
const projectOf = jobId => String(jobId || "").split(":")[0];
async function waitWhilePaused(jobId) {
  const pid = projectOf(jobId);
  if (!pid || !pausedProjects.has(pid)) return;
  const job = jobs.get(jobId), before = job ? { phase: job.phase, detail: job.detail } : null;
  if (job) Object.assign(job, { phase: "paused", detail: "" });
  while (pausedProjects.has(pid)) await new Promise(r => setTimeout(r, 400));
  if (job) Object.assign(job, before, { lastActivityAt: Date.now() });
}

function brief(input) {
  if (!input || typeof input !== "object") return "";
  const v = input.command ?? input.file_path ?? input.path ?? input.pattern ?? input.url ?? input.description ?? "";
  const s = String(v).replace(/\s+/g, " ").trim();
  return s.length > 70 ? s.slice(0, 67) + "…" : s;
}

// Update one job's progress from an Agent SDK message.
function track(job, msg) {
  if (!job) return;
  const now = Date.now();
  job.lastActivityAt = now;
  if (msg.type === "stream_event") {
    const e = msg.event || {};
    if (e.type === "message_start") { job.turnOut = 0; job.turnChars = 0; if (job.phase !== "tool") job.phase = "thinking"; }
    else if (e.type === "content_block_start") {
      const b = e.content_block || {};
      if (b.type === "tool_use") { job.phase = "tool"; job.tool = b.name; job.detail = ""; }
      else if (b.type === "thinking" || b.type === "redacted_thinking") job.phase = "thinking";
      else if (b.type === "text") job.phase = "writing";
    }
    else if (e.type === "content_block_delta") {
      const d = e.delta || {};
      if (d.type === "text_delta") {
        const n = (d.text || "").length;
        job.phase = "writing"; job.chars += n; job.turnChars = (job.turnChars || 0) + n;
        job.outTokens = job.doneOut + Math.max(job.turnOut || 0, Math.round(job.turnChars / 4));   // estimate until the API reports usage
      }
      else if (d.type === "thinking_delta") job.phase = "thinking";
    }
    else if (e.type === "message_delta" && e.usage?.output_tokens != null) {
      job.outTokens = job.doneOut + e.usage.output_tokens;
      job.turnOut = e.usage.output_tokens;
    }
    else if (e.type === "message_stop") { job.doneOut += job.turnOut || 0; job.turnOut = 0; }
  } else if (msg.type === "assistant") {
    for (const b of msg.message?.content || [])
      if (b.type === "tool_use") { job.phase = "tool"; job.tool = b.name; job.detail = brief(b.input); job.toolSince = now; }
    if (msg.error === "rate_limit") job.phase = "rate_limited";
  } else if (msg.type === "user") {
    job.phase = "thinking"; job.tool = null; job.detail = ""; job.turns++;   // a tool result came back; the model continues
  } else if (msg.type === "tool_progress") {
    job.phase = "tool"; job.tool = msg.tool_name || job.tool;
  } else if (msg.type === "system" && msg.subtype === "api_retry") {
    job.phase = "retrying";
    job.retry = { attempt: msg.attempt, max: msg.max_retries, waitMs: msg.retry_delay_ms, error: msg.error, status: msg.error_status };
  } else if (msg.type === "rate_limit_event") {
    const r = msg.rate_limit_info || {};
    job.rateLimit = { status: r.status, resetsAt: r.resetsAt ? r.resetsAt * (r.resetsAt < 1e12 ? 1000 : 1) : null, type: r.rateLimitType, utilization: r.utilization };
    if (r.status === "rejected") job.phase = "rate_limited";
  }
}

const snapshot = job => ({
  id: job.id, agentId: job.agentId, phase: job.phase, tool: job.tool, detail: job.detail,
  outTokens: job.outTokens, chars: job.chars, turns: job.turns, retry: job.retry, rateLimit: job.rateLimit,
  elapsedSec: Math.round((Date.now() - job.startedAt) / 1000), idleSec: Math.round((Date.now() - job.lastActivityAt) / 1000),
});

const STALL_MS = Number(process.env.VC_STALL_MS || 6 * 60 * 1000);
class StallError extends Error {
  constructor() { super(`No activity for ${Math.round(STALL_MS / 60000)} minutes.`); this.name = "StallError"; }
}

// The customer's reference images and PDFs go with the prompt as content blocks, so the model sees them.
// Without attachments the prompt stays a plain string.
const SEEN = new Set(["image/png", "image/jpeg", "image/gif", "image/webp", "application/pdf"]);
function withAttachments(prompt, attachments) {
  const files = (attachments || []).filter(a => a && SEEN.has(a.mediaType) && a.data);
  if (!files.length) return prompt;
  const content = [
    ...files.flatMap(a => [
      { type: "text", text: `Reference file from the customer: ${a.name}` },
      a.mediaType === "application/pdf"
        ? { type: "document", source: { type: "base64", media_type: a.mediaType, data: a.data }, title: a.name }
        : { type: "image", source: { type: "base64", media_type: a.mediaType, data: a.data } },
    ]),
    { type: "text", text: prompt },
  ];
  return (async function* () {
    yield { type: "user", message: { role: "user", content }, parent_tool_use_id: null, session_id: "" };
  })();
}

const fmtReset = ms => ms ? new Date(ms).toLocaleString("en-GB", { weekday: "short", hour: "2-digit", minute: "2-digit" }) : "later";

async function runAgent({ agentId, model, effort, system, prompt, maxOutputTokens, tools = [], cwd, maxTurns = 1, maxBudgetUsd, jobId, allowedHosts = [], attachments = [] }) {
  const usesTools = Array.isArray(tools) && tools.length > 0 && cwd && fs.existsSync(cwd);
  const options = {
    model,
    systemPrompt: system,
    tools: usesTools ? tools : [],   // [] = plain completion, no file or shell access
    maxTurns: usesTools ? maxTurns : 1,
    settingSources: [],              // ignore ~/.claude and project settings
    persistSession: false,
    cwd: usesTools ? cwd : WORKSPACE,
    env: { ...process.env, CLAUDE_AGENT_SDK_CLIENT_APP: "virtual-company/1.0", ...(CONFIG_DIR ? { CLAUDE_CONFIG_DIR: CONFIG_DIR } : {}) },
  };
  if (EFFORTS.has(effort)) options.effort = effort;
  if (usesTools) {
    const guard = makeGuard(cwd, agentId, log, allowedHosts);
    options.canUseTool = async (...args) => { await waitWhilePaused(jobId); return guard(...args); };   // paused: hold here
    if (GIT_BASH) options.env.CLAUDE_CODE_GIT_BASH_PATH = GIT_BASH;
    if (Number(maxBudgetUsd) > 0) options.maxBudgetUsd = Number(maxBudgetUsd);
  }
  // Hard cap on one reply (thinking included). Tool runs write whole files in one call, so they get more room.
  const cap = usesTools ? Math.max(maxOutputTokens || 0, 32000) : maxOutputTokens;
  if (Number.isFinite(cap) && cap > 0) options.env.CLAUDE_CODE_MAX_OUTPUT_TOKENS = String(Math.floor(cap));

  options.includePartialMessages = true;   // token-level events: proof of life while a long reply streams
  const job = jobId ? jobs.get(jobId) : null;
  if (job) Object.assign(job, { phase: "starting", tool: null, detail: "", turnOut: 0, doneOut: 0, retry: null, lastActivityAt: Date.now() });

  // Stall watchdog: no message at all from the engine for STALL_MS means the call is stuck. Abort it so the
  // caller can retry instead of waiting forever.
  const ac = new AbortController();
  options.abortController = ac;
  let lastMsgAt = Date.now(), stalled = false;
  const watch = setInterval(() => {
    if (pausedProjects.has(projectOf(jobId))) { lastMsgAt = Date.now(); return; }   // waiting on purpose, not stuck
    if (!stalled && Date.now() - lastMsgAt > STALL_MS) {
      stalled = true; clearInterval(watch);
      log(`${agentId} no activity for ${Math.round(STALL_MS / 1000)} s; aborting`); ac.abort();
    }
  }, Math.min(10000, Math.max(100, STALL_MS / 3)));

  let result = null, turns = 0;
  try {
    for await (const msg of query({ prompt: withAttachments(prompt, attachments), options })) {
      lastMsgAt = Date.now();
      track(job, msg);
      if (msg.type === "assistant") turns++;
      if (msg.type === "result") result = msg;
    }
  } catch (e) {
    if (stalled) throw new StallError();
    throw e;
  } finally {
    clearInterval(watch);
  }
  if (stalled && !result) throw new StallError();
  if (!result) throw new Error("The agent finished without a result.");
  // A subscription that ran out shows up as a failed result after a rejected rate-limit event: say so plainly.
  if (result.subtype !== "success" && job?.rateLimit?.status === "rejected")
    return { ok: false, code: "rate_limit", resetsAt: job.rateLimit.resetsAt,
             error: `Claude usage limit reached (${job.rateLimit.type || "plan"}); it resets ${fmtReset(job.rateLimit.resetsAt)}. Press Resume after that.` };

  const usage = Object.values(result.modelUsage || {});
  // Cache reads are re-reads of context the agent already has (each tool step re-reads the whole conversation) and
  // cost about a tenth of fresh input, so they are reported apart and do not count as fresh input.
  const inputTokens = usage.reduce((n, u) => n + u.inputTokens + u.cacheCreationInputTokens, 0);
  const cacheReadTokens = usage.reduce((n, u) => n + u.cacheReadInputTokens, 0);
  const outputTokens = usage.reduce((n, u) => n + u.outputTokens, 0);
  if (result.subtype !== "success") {
    // A tool run that hit its turn or dollar cap has still written files; report it instead of failing the pipeline.
    if (usesTools && (result.subtype === "error_max_turns" || result.subtype === "error_max_budget_usd")) {
      const why = result.subtype === "error_max_turns" ? `its limit of ${maxTurns} steps` : `its budget of $${maxBudgetUsd}`;
      const text = `The agent stopped at ${why} before writing its report. The files it wrote so far are in the app folder.\n` +
                   "```json\n" + JSON.stringify({ status: "done", summary: `Stopped early at ${why}; the work may be incomplete.` }) + "\n```";
      return { ok: true, text, inputTokens, outputTokens, cacheReadTokens, costUsd: result.total_cost_usd, stopReason: result.subtype, turns };
    }
    return { ok: false, error: (result.errors || []).join("; ") || result.subtype, inputTokens, outputTokens, cacheReadTokens, costUsd: result.total_cost_usd };
  }
  return { ok: true, text: result.result, inputTokens, outputTokens, cacheReadTokens, costUsd: result.total_cost_usd, stopReason: result.stop_reason || "end_turn", turns };
}

// The engine fails a call whose reply passes the output cap instead of truncating it. Retry once, asking for a
// much shorter answer, so one wordy reply does not stop the whole pipeline.
const TOO_LONG = /exceeded the \d+ output token maximum/;
async function runWithRetry(job, stallRetries = 1) {
  try {
    return await runAgent(job);
  } catch (e) {
    if (e instanceof StallError) {
      if (stallRetries <= 0) throw new Error(`The agent stopped responding twice (no activity for ${Math.round(STALL_MS / 60000)} minutes each time). Press Resume to try again.`);
      log(`${job.agentId} stalled; retrying once`);
      const note = "\n\nNOTE: a previous attempt at this task stopped responding and was restarted. Files it already wrote are still there: " +
                   "check them and continue, working efficiently.";
      return await runWithRetry({ ...job, prompt: job.prompt + note }, stallRetries - 1);
    }
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
  if (req.method === "GET" && req.url.startsWith("/progress")) {
    const id = decodeURIComponent(req.url.slice("/progress/".length));
    if (!id || req.url === "/progress") return send(res, 200, [...jobs.values()].map(snapshot));
    const j = jobs.get(id);
    return j ? send(res, 200, snapshot(j)) : send(res, 404, { error: "No such job" });
  }
  if (req.method === "POST" && req.url === "/pause") {   // { project, paused }: hold or release that project's agents
    let body = ""; for await (const c of req) body += c;
    try {
      const { project, paused } = JSON.parse(body || "{}");
      if (!project) return send(res, 400, { ok: false, error: "project missing" });
      if (paused) pausedProjects.add(project); else pausedProjects.delete(project);
      log(`${project} ${paused ? "paused" : "continued"}`);
      return send(res, 200, { ok: true, paused: pausedProjects.has(project) });
    } catch (e) { return send(res, 400, { ok: false, error: e.message }); }
  }
  if (req.method === "POST" && req.url === "/browse") {   // browser check for QA, called by the orchestrator
    let body = ""; for await (const c of req) body += c;
    try {
      const { url, outDir } = JSON.parse(body);
      if (!/^http:\/\/(localhost|127\.0\.0\.1):\d+/.test(url || "")) return send(res, 400, { ok: false, error: "Only local app URLs can be checked." });
      const started = Date.now();
      const r = await browse({ url, outDir });
      log(`browse ${url} ${r.ok ? "ok" : "error"} ${Date.now() - started}ms console=${r.console.length} exceptions=${r.exceptions.length} failed=${r.failed.length}`);
      return send(res, 200, r);
    } catch (e) { return send(res, 500, { ok: false, error: e.message }); }
  }
  if (req.method !== "POST" || req.url !== "/run") return send(res, 404, { error: "Not found" });
  let raw = "";
  for await (const chunk of req) raw += chunk;
  const started = Date.now();
  let jobId = null;
  try {
    const job = JSON.parse(raw);
    jobId = job.jobId || null;
    if (jobId) jobs.set(jobId, { id: jobId, agentId: job.agentId, startedAt: started, lastActivityAt: started, phase: "starting",
      tool: null, detail: "", outTokens: 0, doneOut: 0, turnOut: 0, chars: 0, turns: 0, retry: null, rateLimit: null });
    const out = await runWithRetry(job);
    log(`${job.agentId} ${job.model} ${out.ok ? "ok" : "error"} ${Date.now() - started}ms${out.turns ? ` turns=${out.turns}` : ""} in=${out.inputTokens} cache=${out.cacheReadTokens ?? 0} out=${out.outputTokens} $${(out.costUsd ?? 0).toFixed(4)}${out.stopReason?.startsWith("error_") ? " " + out.stopReason : ""}`);
    send(res, out.ok ? 200 : 502, out);
  } catch (e) {
    log(`run failed: ${e.message}`);
    const rl = jobId ? jobs.get(jobId)?.rateLimit : null;
    if (rl?.status === "rejected" || /usage limit|rate.?limit/i.test(e.message))
      send(res, 500, { ok: false, code: "rate_limit", resetsAt: rl?.resetsAt ?? null,
                       error: `Claude usage limit reached; it resets ${fmtReset(rl?.resetsAt)}. Press Resume after that. (${e.message})` });
    else send(res, 500, { ok: false, error: e.message });
  } finally {
    if (jobId) jobs.delete(jobId);
  }
}).listen(PORT, "127.0.0.1", () => log(`Agent runner listening on http://127.0.0.1:${PORT}${GIT_BASH ? "" : " (Git Bash not found: Bash tool unavailable)"}`));
