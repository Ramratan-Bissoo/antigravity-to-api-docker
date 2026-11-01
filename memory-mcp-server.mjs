#!/usr/bin/env node
import "./env-loader.mjs";
import readline from "node:readline";
import { findMemories, scanMemories, openMemory, summarizeDays, importThread, describeStore } from "./memory-db.mjs";

const TOOL_CATALOG = [
  {
    name: "memory_search",
    description: "Search the user's entire archived conversation memory. IMPORTANT: do not blindly search the user's question verbatim. First infer what information they are trying to recall, then generate several short, varied search queries: key concepts, likely terms, synonyms, technical identifiers, commands, or paraphrases. Start broad; use results to refine with another call if needed. This search is local and consumes no LLM tokens itself. Returns small snippets with message_id, timestamp, conversation_id, and source_path. Use memory_read to verify exact wording and context.",
    inputSchema: { type: "object", properties: {
      query: { type: "string", description: "One concise search query derived from the user's intent, not necessarily the original question." },
      queries: { type: "array", items: { type: "string" }, description: "Optional alternative search terms, synonyms, or likely phrasings. Use 2-5 diverse queries for vague questions." },
      after: { type: "string", description: "Optional ISO timestamp lower bound." },
      before: { type: "string", description: "Optional ISO timestamp upper bound." },
      role: { type: "string", enum: ["user", "assistant", "system"], description: "Optional role filter." },
      search_type: { type: "string", enum: ["hybrid", "exact"], description: "hybrid for keyword/FTS search with fallback; exact for phrase search." },
      limit: { type: "integer", minimum: 1, maximum: 25, description: "Maximum results, default 8." }
    }, required: ["query"] }
  },
  {
    name: "memory_grep",
    description: "Literal substring search across all archived messages. Best for exact commands, code, error text, names, or phrases. Runs locally without LLM tokens. Use when you have a likely exact string.",
    inputSchema: { type: "object", properties: {
      pattern: { type: "string", description: "Literal text to find." },
      case_sensitive: { type: "boolean" },
      after: { type: "string" }, before: { type: "string" },
      limit: { type: "integer", minimum: 1, maximum: 50 }
    }, required: ["pattern"] }
  },
  {
    name: "memory_read",
    description: "Read one matching archived message and nearby messages from the same conversation. Use this to verify exact facts before answering. Local retrieval; no LLM call.",
    inputSchema: { type: "object", properties: {
      message_id: { type: "string" },
      before: { type: "integer", minimum: 0, maximum: 10 },
      after: { type: "integer", minimum: 0, maximum: 10 }
    }, required: ["message_id"] }
  },
  {
    name: "memory_list_dates",
    description: "List dates containing archived messages and total indexed count. Use when the user references a date or when narrowing a search by time. Local retrieval; no LLM call.",
    inputSchema: { type: "object", properties: { limit: { type: "integer", minimum: 1, maximum: 366 } } }
  },
  {
    name: "memory_stats",
    description: "Show archive/index location and indexed message/conversation counts. Local retrieval; no LLM call.",
    inputSchema: { type: "object", properties: {} }
  },
  {
    name: "memory_ingest",
    description: "Import a conversation or message batch into the searchable local archive. Use only when the user explicitly asks to import or archive supplied conversation data. Duplicate message IDs are ignored.",
    inputSchema: { type: "object", properties: {
      conversation_id: { type: "string" },
      model: { type: "string" },
      origin: { type: "string" },
      messages: { type: "array", items: { type: "object", properties: {
        id: { type: "string" }, message_id: { type: "string" }, timestamp: { type: "string" },
        created_at: { type: "string" }, role: { type: "string" }, content: {}, model: { type: "string" }
      }, required: ["role", "content"] } }
    }, required: ["messages"] }
  }
];

const TOOL_ROUTES = {
  memory_search: findMemories,
  memory_grep: scanMemories,
  memory_read: openMemory,
  memory_list_dates: summarizeDays,
  memory_stats: () => describeStore(),
  memory_ingest: importThread
};

const IDENTITY = { name: "agy-memory-search", version: "1.0.0" };
const FALLBACK_PROTOCOL = "2024-11-05";

function emit(frame) {
  process.stdout.write(JSON.stringify({ jsonrpc: "2.0", ...frame }) + "\n");
}

function reply(requestId, result) {
  emit({ id: requestId, result });
}

function replyError(requestId, code, message) {
  emit({ id: requestId, error: { code, message } });
}

async function invokeTool(toolName, input) {
  try {
    const route = TOOL_ROUTES[toolName];
    if (!route) throw new Error("Unknown tool: " + toolName);
    const payload = await route(input);
    return { content: [{ type: "text", text: JSON.stringify(payload) }], structuredContent: payload, isError: false };
  } catch (problem) {
    return { content: [{ type: "text", text: problem.message || String(problem) }], isError: true };
  }
}

const RPC_HANDLERS = {
  initialize: params => ({
    protocolVersion: params?.protocolVersion || FALLBACK_PROTOCOL,
    capabilities: { tools: {} },
    serverInfo: IDENTITY
  }),
  ping: () => ({}),
  "tools/list": () => ({ tools: TOOL_CATALOG }),
  "tools/call": params => invokeTool(params?.name, params?.arguments || {})
};

async function onInputLine(rawLine) {
  if (!rawLine.trim()) return;
  let packet;
  try { packet = JSON.parse(rawLine); } catch { return; }
  if (!packet || packet.jsonrpc !== "2.0" || packet.method?.startsWith("notifications/")) return;

  const rpc = RPC_HANDLERS[packet.method];
  if (rpc) return reply(packet.id, await rpc(packet.params));
  if (packet.id !== undefined) replyError(packet.id, -32601, "Method not found: " + packet.method);
}

const stdinReader = readline.createInterface({ input: process.stdin, crlfDelay: Infinity });
stdinReader.on("line", onInputLine);
stdinReader.on("close", () => process.exit(0));
