import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";
import { DatabaseSync } from "node:sqlite";
import { fileURLToPath } from "node:url";

const moduleDir = path.dirname(fileURLToPath(import.meta.url));
export const STORE_DIR = process.env.AGY_MEMORY_DIR || path.join(moduleDir, "memory");
export const JOURNAL_DIR = path.join(STORE_DIR, "raw");
const INDEX_FILE = path.join(STORE_DIR, "index.sqlite");

fs.mkdirSync(JOURNAL_DIR, { recursive: true });
const sqlite = new DatabaseSync(INDEX_FILE);
sqlite.exec(`
  PRAGMA journal_mode = WAL;
  PRAGMA synchronous = NORMAL;
  CREATE TABLE IF NOT EXISTS messages (
    message_id TEXT PRIMARY KEY,
    conversation_id TEXT NOT NULL,
    timestamp TEXT NOT NULL,
    date_key TEXT NOT NULL,
    role TEXT NOT NULL,
    content TEXT NOT NULL,
    source_path TEXT NOT NULL,
    model TEXT,
    origin TEXT NOT NULL DEFAULT 'api'
  );
  CREATE INDEX IF NOT EXISTS idx_messages_timestamp ON messages(timestamp);
  CREATE INDEX IF NOT EXISTS idx_messages_conversation ON messages(conversation_id, timestamp);
  CREATE INDEX IF NOT EXISTS idx_messages_date ON messages(date_key);
  CREATE VIRTUAL TABLE IF NOT EXISTS messages_fts USING fts5(
    message_id UNINDEXED,
    content,
    role UNINDEXED,
    conversation_id UNINDEXED,
    timestamp UNINDEXED,
    tokenize='unicode61 remove_diacritics 2'
  );
`);

const PREVIEW_LIMIT = 900;
const DATE_WINDOW_SQL = "(? IS NULL OR m.timestamp >= ?) AND (? IS NULL OR m.timestamp <= ?)";
const ROLE_MATCH_SQL = "(? IS NULL OR m.role = ?)";

const sql = {
  insertRow: sqlite.prepare(`
    INSERT OR IGNORE INTO messages
      (message_id, conversation_id, timestamp, date_key, role, content, source_path, model, origin)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
  `),
  insertSearchRow: sqlite.prepare(`
    INSERT INTO messages_fts (message_id, content, role, conversation_id, timestamp)
    VALUES (?, ?, ?, ?, ?)
  `),
  rowById: sqlite.prepare("SELECT * FROM messages WHERE message_id = ?"),
  latestInThread: sqlite.prepare(`
    SELECT * FROM messages WHERE conversation_id = ?
    ORDER BY timestamp DESC LIMIT ?
  `),
  rowsUpTo: sqlite.prepare(`
    SELECT * FROM messages WHERE conversation_id = ? AND timestamp <= ?
    ORDER BY timestamp DESC LIMIT ?
  `),
  rowsFollowing: sqlite.prepare(`
    SELECT * FROM messages WHERE conversation_id = ? AND timestamp > ?
    ORDER BY timestamp ASC LIMIT ?
  `),
  rankedMatch: sqlite.prepare(`
    SELECT m.*, bm25(messages_fts) AS score
    FROM messages_fts f JOIN messages m ON m.message_id = f.message_id
    WHERE messages_fts MATCH ? AND ${DATE_WINDOW_SQL} AND ${ROLE_MATCH_SQL}
    ORDER BY score ASC LIMIT ?
  `),
  substringMatch: sqlite.prepare(`
    SELECT * FROM messages m
    WHERE m.content LIKE ? ESCAPE '\\' AND ${DATE_WINDOW_SQL} AND ${ROLE_MATCH_SQL}
    ORDER BY m.timestamp DESC LIMIT ?
  `),
  literalAnyCase: sqlite.prepare(`
    SELECT * FROM messages m
    WHERE m.content LIKE ? ESCAPE '\\' AND ${DATE_WINDOW_SQL}
    ORDER BY m.timestamp DESC LIMIT ?
  `),
  literalExactCase: sqlite.prepare(`
    SELECT * FROM messages m
    WHERE instr(m.content, ?) > 0 AND ${DATE_WINDOW_SQL}
    ORDER BY m.timestamp DESC LIMIT ?
  `),
  perDay: sqlite.prepare("SELECT date_key, COUNT(*) AS messages FROM messages GROUP BY date_key ORDER BY date_key DESC LIMIT ?"),
  totalRows: sqlite.prepare("SELECT COUNT(*) AS count FROM messages"),
  totalThreads: sqlite.prepare("SELECT COUNT(DISTINCT conversation_id) AS count FROM messages")
};

function bound(input, lo, hi, fallback) {
  return Math.max(lo, Math.min(Number(input) || fallback, hi));
}

function windowParams(from, to) {
  return [from || null, from || null, to || null, to || null];
}

function escapeForLike(text) {
  return `%${text.replace(/[\\%_]/g, "\\$&")}%`;
}

function asPhrase(text) {
  return `"${text.replaceAll('"', '""')}"`;
}

function dayStamp(when) {
  const parsed = new Date(when);
  if (Number.isNaN(parsed.getTime())) throw new Error("Invalid timestamp");
  return parsed.toISOString().slice(0, 10);
}

function fileSafe(raw) {
  return String(raw || "").replace(/[^a-zA-Z0-9._-]/g, "_").slice(0, 120) || crypto.randomUUID();
}

function journalFile(day, threadId) {
  const [yyyy, mm, dd] = day.split("-");
  const folder = path.join(JOURNAL_DIR, yyyy, mm, dd);
  fs.mkdirSync(folder, { recursive: true });
  return path.join(folder, `${fileSafe(threadId)}.jsonl`);
}

function appendJournal(target, entry) {
  fs.appendFileSync(target, JSON.stringify(entry) + "\n", { encoding: "utf8", mode: 0o600 });
}

function flatten(body) {
  if (typeof body === "string") return body;
  if (Array.isArray(body)) return body.map(piece => piece?.text || "").join("\n");
  return JSON.stringify(body ?? "");
}

function shape(row) {
  if (!row) return null;
  return {
    message_id: row.message_id,
    conversation_id: row.conversation_id,
    timestamp: row.timestamp,
    date: row.date_key,
    role: row.role,
    content: row.content,
    source_path: row.source_path,
    model: row.model,
    origin: row.origin
  };
}

function preview(text) {
  return text.length > PREVIEW_LIMIT ? text.slice(0, PREVIEW_LIMIT) + "…[truncated; use memory_read]" : text;
}

function persist({ threadId, at, role, text, model = null, origin = "api", id = null }) {
  if (!String(text ?? "").trim()) return null;
  const stamp = new Date(at || Date.now()).toISOString();
  const day = dayStamp(stamp);
  const thread = String(threadId || "imported").slice(0, 200);
  const entryId = id || crypto.randomUUID();
  const target = journalFile(day, thread);
  const entry = { message_id: entryId, conversation_id: thread, timestamp: stamp, role: String(role || "user"), content: String(text), model, origin };
  const outcome = sql.insertRow.run(entryId, thread, stamp, day, entry.role, entry.content, path.relative(STORE_DIR, target), model, origin);
  if (Number(outcome.changes) > 0) {
    sql.insertSearchRow.run(entryId, entry.content, entry.role, thread, stamp);
    appendJournal(target, entry);
  }
  return entryId;
}

export function saveExchange({ threadId, prompt, reply, model, at = new Date().toISOString() }) {
  const thread = String(threadId || `turn-${crypto.randomUUID()}`);
  const replyAt = new Date(new Date(at).getTime() + 1).toISOString();
  const saved = [];
  if (prompt) saved.push(persist({ threadId: thread, at, role: "user", text: prompt, model }));
  if (reply) saved.push(persist({ threadId: thread, at: replyAt, role: "assistant", text: reply, model }));
  return saved.filter(Boolean);
}

export function importThread({ conversation_id, messages, model = null, origin = "import" }) {
  if (!Array.isArray(messages) || messages.length === 0) throw new Error("messages must be a non-empty array");
  const thread = String(conversation_id || `import-${crypto.randomUUID()}`);
  const saved = [];
  messages.forEach((item, offset) => {
    const entry = item || {};
    const entryId = persist({
      threadId: thread,
      at: entry.timestamp || entry.created_at || new Date(Date.now() + offset).toISOString(),
      role: entry.role || "user",
      text: flatten(entry.content),
      model: entry.model || model,
      origin,
      id: entry.message_id || entry.id || null
    });
    if (entryId) saved.push(entryId);
  });
  return { conversation_id: thread, indexed_messages: saved.length, message_ids: saved };
}

function tidy(raw) {
  return String(raw || "").trim().slice(0, 1000);
}

function toMatchQuery(phrase) {
  const words = (phrase.match(/[\p{L}\p{N}_./:@+-]+/gu) || []).filter(w => w.length > 1).slice(0, 18);
  // OR keeps vague natural-language questions matching partially.
  return words.map(asPhrase).join(" OR ");
}

export function findMemories({ query, queries = [], after, before, role, search_type = "hybrid", limit = 8 } = {}) {
  const phrases = [...new Set([query, ...(Array.isArray(queries) ? queries : [])].map(tidy).filter(Boolean))].slice(0, 8);
  if (!phrases.length) throw new Error("Provide query or queries");
  const maxHits = bound(limit, 1, 25, 8);
  const phraseMode = search_type === "exact";
  const binds = [...windowParams(after, before), role || null, role || null];
  const hits = new Map();

  for (const phrase of phrases) {
    const matchQuery = phraseMode ? asPhrase(phrase) : toMatchQuery(phrase);
    if (matchQuery) {
      try {
        for (const row of sql.rankedMatch.all(matchQuery, ...binds, maxHits * 3)) {
          const weight = 1 / (1 + Math.max(0, Number(row.score) || 0));
          const prior = hits.get(row.message_id);
          if (!prior || weight > prior._weight) hits.set(row.message_id, { ...shape(row), _weight: weight, matched_queries: [phrase] });
          else if (!prior.matched_queries.includes(phrase)) prior.matched_queries.push(phrase);
        }
      } catch {
        // Invalid FTS syntax (heavy punctuation) falls through to the substring match.
      }
    }
    if (phraseMode || hits.size < maxHits) {
      for (const row of sql.substringMatch.all(escapeForLike(phrase), ...binds, maxHits * 2)) {
        if (!hits.has(row.message_id)) hits.set(row.message_id, { ...shape(row), _weight: 0.5, matched_queries: [phrase] });
      }
    }
  }

  const ranked = [...hits.values()]
    .sort((x, y) => y._weight - x._weight || y.timestamp.localeCompare(x.timestamp))
    .slice(0, maxHits)
    .map(({ _weight, ...hit }) => ({ ...hit, score: Number(_weight.toFixed(3)), snippet: preview(hit.content) }));
  return { query: phrases, count: ranked.length, results: ranked };
}

export function scanMemories({ pattern, case_sensitive = false, after, before, limit = 10 } = {}) {
  const needle = String(pattern || "").trim().slice(0, 500);
  if (!needle) throw new Error("pattern is required");
  const tail = [...windowParams(after, before), bound(limit, 1, 50, 10)];
  const rows = case_sensitive
    ? sql.literalExactCase.all(needle, ...tail)
    : sql.literalAnyCase.all(escapeForLike(needle), ...tail);
  return { pattern: needle, count: rows.length, results: rows.map(shape) };
}

export function openMemory({ message_id, before = 2, after = 2 } = {}) {
  const anchor = sql.rowById.get(String(message_id || ""));
  if (!anchor) return { found: false, message_id };
  const earlier = sql.rowsUpTo.all(anchor.conversation_id, anchor.timestamp, bound(before, 0, 10, 0)).reverse();
  const later = sql.rowsFollowing.all(anchor.conversation_id, anchor.timestamp, bound(after, 0, 10, 0));
  const merged = new Map();
  for (const row of [...earlier, anchor, ...later]) merged.set(row.message_id, shape(row));
  return { found: true, target: shape(anchor), context: [...merged.values()].sort((x, y) => x.timestamp.localeCompare(y.timestamp)) };
}

export function loadThread(threadId, max = 40) {
  const thread = String(threadId || "").trim();
  if (!thread) return { conversation_id: thread, messages: [] };
  const rows = sql.latestInThread.all(thread, bound(max, 1, 100, 40)).reverse();
  return { conversation_id: thread, messages: rows.map(row => ({ role: row.role, content: row.content, timestamp: row.timestamp, message_id: row.message_id })) };
}

export function summarizeDays({ limit = 60 } = {}) {
  return { total_messages: sql.totalRows.get().count, dates: sql.perDay.all(bound(limit, 1, 366, 60)) };
}

export function describeStore() {
  return {
    root: STORE_DIR,
    database: INDEX_FILE,
    total_messages: sql.totalRows.get().count,
    total_conversations: sql.totalThreads.get().count
  };
}
