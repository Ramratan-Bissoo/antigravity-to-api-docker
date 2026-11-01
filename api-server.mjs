import "./env-loader.mjs";
import http from "node:http";
import { spawn } from "node:child_process";
import os from "node:os";
import path from "node:path";
import crypto from "node:crypto";
import { saveExchange, importThread, findMemories, scanMemories, openMemory, summarizeDays, describeStore, loadThread } from "./memory-db.mjs";

const BIND_HOST = process.env.HOST || "127.0.0.1";
const BIND_PORT = Number(process.env.PORT || 8788);
const CLI_PATH = process.env.AGY_BIN || path.join(os.homedir(), ".local", "bin", "agy");
const ACCESS_TOKEN = process.env.AGY_API_KEY || "";
const TURN_TIMEOUT_MS = Number(process.env.AGY_TIMEOUT_MS || 300000);
const BODY_LIMIT = 2 * 1024 * 1024;
const PARALLEL_LIMIT = Number(process.env.AGY_MAX_CONCURRENT || 1);
const WAITLIST_LIMIT = Number(process.env.AGY_MAX_QUEUE || 10);
let inFlight = 0;
const waitlist = [];

function enterGate() {
  if (inFlight < PARALLEL_LIMIT) {
    inFlight++;
    return Promise.resolve();
  }
  if (waitlist.length >= WAITLIST_LIMIT) {
    return Promise.reject(statusError("AGY request queue is full; retry later", 429));
  }
  return new Promise(wake => waitlist.push(wake)).then(() => { inFlight++; });
}

function leaveGate() {
  inFlight = Math.max(0, inFlight - 1);
  const wake = waitlist.shift();
  if (wake) wake();
}

const FALLBACK_MODELS = [
  { id: "gemini-3.8-flash-medium", name: "Gemini 3.8 Flash (Medium)" },
  { id: "gemini-3.8-flash-high", name: "Gemini 3.8 Flash (High)" },
  { id: "gemini-3.8-flash-low", name: "Gemini 3.8 Flash (Low)" },
  { id: "claude-sonnet-4-6", name: "Claude Sonnet 4.6 (Thinking)" },
  { id: "claude-opus-4-6-thinking", name: "Claude Opus 4.6 (Thinking)" },
  { id: "gpt-oss-120b-medium", name: "GPT-OSS 120B (Medium)" }
];
const CATALOG_TTL_MS = 5 * 60_000;
let catalog = null;
let catalogFetchedAt = 0;

function queryCliModels() {
  return new Promise((resolve, reject) => {
    const proc = spawn(CLI_PATH, ["models"], { env: process.env, stdio: ["ignore", "pipe", "pipe"] });
    let captured = "";
    const deadline = setTimeout(() => proc.kill(), 30_000);
    proc.stdout.on("data", piece => { captured += piece.toString(); });
    proc.on("error", problem => { clearTimeout(deadline); reject(problem); });
    proc.on("close", () => {
      clearTimeout(deadline);
      // Rows are "<id>\t<name>" when piped, space-padded in a terminal.
      const found = captured.replace(/\x1b\[[0-9;?]*[A-Za-z]/g, "").split(/[\r\n]+/)
        .map(row => row.trim().match(/^([a-z0-9][\w.-]*)(?:\t|\s{2,})(.+)$/i))
        .filter(Boolean)
        .map(hit => ({ id: hit[1], name: hit[2].trim() }));
      if (found.length) resolve(found);
      else reject(new Error("AGY returned no models"));
    });
  });
}

async function resolveCatalog() {
  if (catalog && Date.now() - catalogFetchedAt < CATALOG_TTL_MS) return { models: catalog, source: "agy" };
  try {
    catalog = await queryCliModels();
    catalogFetchedAt = Date.now();
    return { models: catalog, source: "agy" };
  } catch (problem) {
    console.error("Live model list failed:", problem.message);
    return catalog ? { models: catalog, source: "agy-cache" } : { models: FALLBACK_MODELS, source: "fallback" };
  }
}

const CROSS_ORIGIN = {
  "access-control-allow-origin": "*",
  "access-control-allow-headers": "authorization, content-type",
  "access-control-allow-methods": "GET, POST, OPTIONS"
};
const DIRECTIVE_ROLES = new Set(["system", "developer"]);
const RECALL_GUIDANCE = "[MEMORY TOOL POLICY]\nWhen the user asks about something they said, decided, ran, shared, or discussed in a past conversation, use the agy-memory MCP tools before answering. Do not pass the original question verbatim as the only search query. Infer the likely facts they want, create several short alternative search terms, synonyms, and identifiers, call memory_search, refine search if needed, and use memory_read to verify the exact source and nearby context. For exact code, commands, or error text, use memory_grep. Only provide recalled facts supported by retrieved messages; if no matching evidence is found, say so rather than guessing. Keep retrieval narrow and do not dump whole conversations into context. For unrelated questions that do not require past-conversation recall, do not search memory.";
const REPLY_TRIGGER = "[ASSISTANT]\nRespond to the conversation above. Follow the system instructions and answer the latest user message.";
const BLANK_REPLY_NUDGE = "[IMPORTANT OUTPUT CHECK]\nYour previous attempt returned an empty response. Answer the latest user message now with a non-empty, concise answer. If context is insufficient, say so clearly.";
const THROTTLE_SIGNS = /\b429\b|RESOURCE_EXHAUSTED|rate.?limit|quota exceeded|too many requests/i;

function statusError(text, status) {
  return Object.assign(new Error(text), { status });
}

function replyJson(res, status, payload, moreHeaders = {}) {
  res.writeHead(status, { "content-type": "application/json; charset=utf-8", ...CROSS_ORIGIN, ...moreHeaders });
  res.end(JSON.stringify(payload));
}

function errorEnvelope(message, type = "invalid_request_error", code = null) {
  return { error: { message, type, param: null, code } };
}

function hasValidToken(req) {
  if (!ACCESS_TOKEN) return true;
  const authHeader = req.headers.authorization || "";
  const presented = authHeader.startsWith("Bearer ") ? authHeader.slice(7) : "";
  const given = Buffer.from(presented);
  const expected = Buffer.from(ACCESS_TOKEN);
  return given.length === expected.length && crypto.timingSafeEqual(given, expected);
}

function parseJsonBody(req) {
  return new Promise((resolve, reject) => {
    let raw = "";
    let received = 0;
    req.on("data", piece => {
      received += piece.length;
      if (received > BODY_LIMIT) {
        reject(statusError("Request body exceeds 2 MB limit", 413));
        req.destroy();
        return;
      }
      raw += piece.toString("utf8");
    });
    req.on("end", () => {
      try { resolve(JSON.parse(raw || "{}")); }
      catch { reject(statusError("Request body must be valid JSON", 400)); }
    });
    req.on("error", reject);
  });
}

function normalizedRole(entry) {
  return String(entry?.role || "").toLowerCase();
}

function isDirective(entry) {
  return DIRECTIVE_ROLES.has(normalizedRole(entry));
}

function latestUserEntry(entries) {
  return [...entries].reverse().find(entry => normalizedRole(entry) === "user");
}

function extractText(body) {
  if (typeof body === "string") return body;
  if (Array.isArray(body)) {
    return body.map(segment => {
      if (segment?.type === "text") return segment.text || "";
      if (segment?.type === "image_url") return "[Image input is not supported by this AGY CLI bridge]";
      return "";
    }).filter(Boolean).join("\n");
  }
  return "";
}

function composeTranscript(entries, recalled = []) {
  if (!Array.isArray(entries) || entries.length === 0) {
    throw statusError("'messages' must be a non-empty array", 400);
  }
  // Directives go first so a resent system prompt never lands after the recalled history.
  const directives = entries.filter(isDirective);
  const dialogue = entries.filter(entry => !isDirective(entry));
  const transcript = [...directives, ...recalled, ...dialogue]
    .map(entry => `[${String(entry?.role || "user").toUpperCase()}]\n${extractText(entry?.content)}`)
    .join("\n\n");
  return `${transcript}\n\n${RECALL_GUIDANCE}\n\n${REPLY_TRIGGER}`;
}

function terminate(proc) {
  proc.kill("SIGTERM");
  setTimeout(() => proc.kill("SIGKILL"), 3000).unref();
}

const livePool = new Map();
const POOL_CAPACITY = Math.max(1, Number(process.env.AGY_MAX_SESSION_WORKERS || 1));
const IDLE_EVICT_MS = Math.max(60_000, Number(process.env.AGY_SESSION_IDLE_MS || 5 * 60_000));

function usageDelta(now = {}, before = {}) {
  const fields = ["input_tokens", "output_tokens", "thinking_tokens", "cache_read_tokens", "total_tokens"];
  const diff = {};
  for (const field of fields) {
    diff[field] = Math.max(0, Number(now[field] || 0) - Number(before[field] || 0));
  }
  return diff;
}

class CliConversation {
  constructor(model) {
    this.model = model;
    this.bornAt = Date.now();
    this.touchedAt = Date.now();
    this.occupied = false;
    this.ended = false;
    this.pendingText = "";
    this.errTail = "";
    this.prevUsage = {};
    this.prevSeconds = 0;
    this.turn = null;
    const flags = ["--model", model, "--sandbox", "--disable-slash-commands", "--input-format", "stream-json", "--output-format", "stream-json"];
    this.proc = spawn(CLI_PATH, flags, { env: process.env, stdio: ["pipe", "pipe", "pipe"] });
    this.proc.stdout.on("data", piece => this._consume(piece.toString()));
    this.proc.stderr.on("data", piece => {
      this.errTail = (this.errTail + piece.toString()).slice(-8000);
    });
    this.proc.on("error", problem => this._abort(new Error(`Could not start AGY CLI at ${CLI_PATH}: ${problem.message}`)));
    this.proc.on("close", exitCode => {
      this.ended = true;
      if (this.turn) this._abort(new Error((this.errTail.trim() || `AGY stream process exited with code ${exitCode}`).slice(-5000)));
    });
  }

  _consume(text) {
    this.pendingText += text;
    let cut;
    while ((cut = this.pendingText.indexOf("\n")) >= 0) {
      const row = this.pendingText.slice(0, cut).trim();
      this.pendingText = this.pendingText.slice(cut + 1);
      if (!row) continue;
      let evt;
      try { evt = JSON.parse(row); } catch { continue; }
      if (evt.event === "step_update" && evt.step_update?.step_type === "agent_response") {
        const fragment = evt.step_update.text_delta;
        if (fragment && this.turn?.onText) {
          try { this.turn.onText(String(fragment)); } catch {}
        }
      }
      if (evt.event === "result" && evt.result && this.turn) {
        const outcome = { ...evt.result, usage: evt.result.usage ? { ...evt.result.usage } : undefined };
        const turn = this.turn;
        clearTimeout(turn.deadline);
        outcome.usage = usageDelta(outcome.usage || {}, this.prevUsage);
        this.prevUsage = evt.result.usage || this.prevUsage;
        const seconds = Number(evt.result.duration_seconds || 0);
        outcome.duration_seconds = Math.max(0, seconds - this.prevSeconds);
        this.prevSeconds = seconds;
        this.turn = null;
        this.occupied = false;
        this.touchedAt = Date.now();
        if (outcome.status && outcome.status !== "SUCCESS") turn.reject(new Error(outcome.error || `AGY status: ${outcome.status}`));
        else turn.resolve(outcome);
      }
    }
  }

  _abort(problem) {
    this.ended = true;
    if (!this.turn) return;
    const turn = this.turn;
    clearTimeout(turn.deadline);
    this.turn = null;
    this.occupied = false;
    turn.reject(problem);
  }

  ask(promptText, { onText } = {}) {
    if (this.ended || this.proc.killed) return Promise.reject(new Error("AGY session worker is not available"));
    if (this.occupied) return Promise.reject(new Error("AGY session worker already has an active turn"));
    this.occupied = true;
    this.touchedAt = Date.now();
    return new Promise((resolve, reject) => {
      const turn = { resolve, reject, onText, deadline: null };
      turn.deadline = setTimeout(() => {
        terminate(this.proc);
        this._abort(new Error("AGY session turn timed out"));
      }, TURN_TIMEOUT_MS);
      this.turn = turn;
      const frame = JSON.stringify({ event: "user", message: { content: promptText } }) + "\n";
      this.proc.stdin.write(frame, problem => {
        if (problem) this._abort(new Error(`Could not send prompt to AGY session: ${problem.message}`));
      });
    });
  }

  shutdown() {
    if (this.ended) return;
    this.ended = true;
    try { this.proc.stdin.end(); } catch {}
    const proc = this.proc;
    setTimeout(() => proc.kill("SIGKILL"), 1500).unref();
  }
}

function acquireConversation(threadId, model) {
  let convo = livePool.get(threadId);
  if (convo && (convo.ended || convo.model !== model)) {
    convo.shutdown();
    livePool.delete(threadId);
    convo = null;
  }
  if (!convo) {
    if (livePool.size >= POOL_CAPACITY) {
      const oldestIdle = [...livePool.entries()]
        .filter(([, candidate]) => !candidate.occupied)
        .sort((x, y) => x[1].touchedAt - y[1].touchedAt)[0];
      if (oldestIdle) {
        oldestIdle[1].shutdown();
        livePool.delete(oldestIdle[0]);
      }
    }
    convo = new CliConversation(model);
    livePool.set(threadId, convo);
  }
  convo.touchedAt = Date.now();
  return convo;
}

function isConversationWarm(threadId, model) {
  const convo = livePool.get(threadId);
  return Boolean(convo && !convo.ended && convo.model === model);
}

const idleReaper = setInterval(() => {
  const now = Date.now();
  for (const [threadId, convo] of livePool) {
    if (convo.ended || (!convo.occupied && now - convo.touchedAt > IDLE_EVICT_MS)) {
      convo.shutdown();
      livePool.delete(threadId);
    }
  }
}, 60_000);
idleReaper.unref();

function pushEvent(res, payload) {
  res.write(`data: ${JSON.stringify(payload)}\n\n`);
}

function finishStream(res, payload) {
  pushEvent(res, payload);
  res.write("data: [DONE]\n\n");
  res.end();
}

function replyFailure(res, isStreaming, status, envelope, headers = {}) {
  if (isStreaming) return finishStream(res, { error: envelope.error });
  return replyJson(res, status, envelope, headers);
}

function stamp() {
  return `[${new Date().toISOString()}]`;
}

function mapUsage(raw) {
  if (!raw) return undefined;
  return {
    prompt_tokens: Number(raw.input_tokens || 0),
    completion_tokens: Number(raw.output_tokens || 0),
    total_tokens: Number(raw.total_tokens || 0)
  };
}

function modelExists(modelId) {
  return [...FALLBACK_MODELS, ...(catalog || [])].some(entry => entry.id === modelId);
}

// Only recall stored turns when a session-managed request carries just the newest user turn.
function recallHistory(payload, threadId, model) {
  if (!(payload.session_id || payload.conversation_id) || isConversationWarm(threadId, model)) return [];
  const dialogue = Array.isArray(payload.messages) ? payload.messages.filter(entry => !isDirective(entry)) : [];
  if (dialogue.length !== 1 || dialogue[0]?.role !== "user") return [];
  try {
    return loadThread(threadId, 40).messages;
  } catch (problem) {
    console.error("Session history load failed:", problem.message);
    return [];
  }
}

function persistExchange(threadId, entries, replyText, model) {
  try {
    const userEntry = latestUserEntry(entries);
    saveExchange({ threadId, prompt: userEntry ? extractText(userEntry.content) : "", reply: replyText, model });
  } catch (problem) {
    console.error("Memory archive failed:", problem.message);
  }
}

const MEMORY_ACTIONS = {
  "/v1/memory/search": findMemories,
  "/v1/memory/grep": scanMemories,
  "/v1/memory/read": openMemory,
  "/v1/memory/ingest": importThread
};

async function serveMemory(req, res, target) {
  if (req.method === "GET" && target.pathname === "/v1/memory/stats") return replyJson(res, 200, describeStore());
  if (req.method === "GET" && target.pathname === "/v1/memory/dates") return replyJson(res, 200, summarizeDays({ limit: Number(target.searchParams.get("limit") || 60) }));
  if (req.method !== "POST") return replyJson(res, 405, errorEnvelope("Use POST for memory search/read/ingest endpoints"));
  let payload;
  try { payload = await parseJsonBody(req); } catch (problem) { return replyJson(res, problem.status || 400, errorEnvelope(problem.message)); }
  const action = MEMORY_ACTIONS[target.pathname];
  if (!action) return replyJson(res, 404, errorEnvelope("Unknown memory endpoint", "invalid_request_error", "not_found"));
  try {
    return replyJson(res, 200, action(payload));
  } catch (problem) {
    return replyJson(res, 400, errorEnvelope(problem.message));
  }
}

async function serveCatalog(res) {
  const { models, source } = await resolveCatalog();
  return replyJson(res, 200, { object: "list", source, data: models.map(entry => ({ id: entry.id, object: "model", created: 0, owned_by: "agy-cli", name: entry.name })) });
}

async function askWithRetry(convo, promptText, threadId, onText) {
  let outcome = await convo.ask(promptText, { onText });
  let answer = String(outcome.response ?? "").trim();
  if (!answer) {
    console.warn(`${stamp()} Empty AGY response for session ${threadId}; retrying once`);
    outcome = await convo.ask(BLANK_REPLY_NUDGE, { onText });
    answer = String(outcome.response ?? "").trim();
  }
  return { outcome, answer };
}

async function serveCompletion(req, res) {
  let payload;
  try { payload = await parseJsonBody(req); } catch (problem) { return replyJson(res, problem.status || 400, errorEnvelope(problem.message)); }

  const model = String(payload.model || FALLBACK_MODELS[0].id);
  if (!modelExists(model)) {
    return replyJson(res, 400, errorEnvelope(`Unknown model '${model}'. Check GET /v1/models for supported IDs.`));
  }
  const threadId = String(payload.session_id || payload.conversation_id || crypto.randomUUID()).slice(0, 200);
  let promptText;
  try { promptText = composeTranscript(payload.messages, recallHistory(payload, threadId, model)); }
  catch (problem) { return replyJson(res, problem.status || 400, errorEnvelope(problem.message)); }

  try {
    await enterGate();
  } catch (problem) {
    return replyJson(res, 429, errorEnvelope(problem.message, "rate_limit_error", "local_queue_full"), { "retry-after": "10" });
  }

  const beganAt = Date.now();
  const completionId = "chatcmpl-" + crypto.randomUUID().replaceAll("-", "");
  const createdSec = Math.floor(Date.now() / 1000);
  const frame = (delta, finish_reason = null) => ({ id: completionId, object: "chat.completion.chunk", created: createdSec, model, choices: [{ index: 0, delta, finish_reason }] });
  let isStreaming = false;
  try {
    if (isConversationWarm(threadId, model)) {
      const userEntry = latestUserEntry(payload.messages);
      if (!userEntry) throw statusError("messages must include a user message", 400);
      // The live CLI conversation already holds history, so send only the newest turn.
      promptText = `[USER]\n${extractText(userEntry.content)}`;
    }
    const convo = acquireConversation(threadId, model);

    if (payload.stream === true) {
      res.writeHead(200, {
        "content-type": "text/event-stream; charset=utf-8",
        "cache-control": "no-cache",
        "connection": "keep-alive",
        ...CROSS_ORIGIN
      });
      isStreaming = true;
      pushEvent(res, { ...frame({ role: "assistant" }), session_id: threadId });
    }
    const onText = isStreaming ? piece => pushEvent(res, frame({ content: piece })) : undefined;
    const { outcome, answer } = await askWithRetry(convo, promptText, threadId, onText);

    if (!answer) {
      console.error(`${stamp()} Empty AGY response twice for session ${threadId}; not archiving blank turn`);
      return replyFailure(res, isStreaming, 502, errorEnvelope("The model returned an empty response twice. The blank turn was not saved; retry the request.", "server_error", "empty_model_response"));
    }
    persistExchange(threadId, payload.messages, answer, model);

    if (isStreaming) return finishStream(res, frame({}, "stop"));

    const usage = mapUsage(outcome.usage);
    const turnCount = outcome.num_turns || 1;
    return replyJson(res, 200, {
      session_id: threadId,
      id: completionId, object: "chat.completion", created: createdSec, model,
      choices: [{ index: 0, message: { role: "assistant", content: answer }, finish_reason: "stop" }],
      ...(usage ? { usage } : {}),
      x_agy: {
        conversation_id: outcome.conversation_id || null,
        duration_seconds: (Date.now() - beganAt) / 1000,
        cli_duration_seconds: outcome.duration_seconds || null,
        num_turns: turnCount,
        warm_session: Number(turnCount) > 1
      }
    });
  } catch (problem) {
    const detail = problem.message || "AGY request failed";
    const throttled = THROTTLE_SIGNS.test(detail);
    console.error(`${stamp()} AGY request failed (${throttled ? "upstream rate limit" : "upstream error"}): ${detail.slice(-1500)}`);
    if (throttled) {
      return replyFailure(res, isStreaming, 429, errorEnvelope("AGY/provider rate limit detected. Pause requests and check your AGY model/account quota before retrying. Details are in server.log.", "rate_limit_error", "upstream_rate_limit"), { "retry-after": "30" });
    }
    return replyFailure(res, isStreaming, problem.status || 502, errorEnvelope(detail, "server_error", "agy_cli_error"));
  } finally {
    leaveGate();
  }
}

function healthReport() {
  return {
    ok: true,
    service: "antigravity-to-api-docker",
    cli: CLI_PATH,
    active: inFlight,
    queued: waitlist.length,
    max_concurrent: PARALLEL_LIMIT,
    max_queue: WAITLIST_LIMIT,
    warm_sessions: livePool.size,
    max_session_workers: POOL_CAPACITY
  };
}

const app = http.createServer(async (req, res) => {
  if (req.method === "OPTIONS") {
    res.writeHead(204, CROSS_ORIGIN);
    return res.end();
  }
  const target = new URL(req.url, `http://${BIND_HOST}:${BIND_PORT}`);
  if (req.method === "GET" && target.pathname === "/health") return replyJson(res, 200, healthReport());

  const wantsMemory = target.pathname.startsWith("/v1/memory/");
  const wantsCatalog = req.method === "GET" && target.pathname === "/v1/models";
  const wantsCompletion = req.method === "POST" && target.pathname === "/v1/chat/completions";
  if (!wantsMemory && !wantsCatalog && !wantsCompletion) {
    return replyJson(res, 404, errorEnvelope("Not found. Use GET /v1/models or POST /v1/chat/completions", "invalid_request_error", "not_found"));
  }
  if (!hasValidToken(req)) return replyJson(res, 401, errorEnvelope("Invalid or missing API key", "authentication_error"));

  if (wantsMemory) return serveMemory(req, res, target);
  if (wantsCatalog) return serveCatalog(res);
  return serveCompletion(req, res);
});

app.listen(BIND_PORT, BIND_HOST, () => {
  console.log(`AGY OpenAI-compatible API listening at http://${BIND_HOST}:${BIND_PORT}`);
  console.log(`Using CLI: ${CLI_PATH}`);
  console.log(`Auth: ${ACCESS_TOKEN ? "API key required" : "disabled (localhost only)"}`);
});
app.on("error", problem => {
  console.error("Server failed:", problem.message);
  process.exitCode = 1;
});
