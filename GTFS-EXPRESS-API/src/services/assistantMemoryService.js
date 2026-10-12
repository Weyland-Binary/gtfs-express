/**
 * assistantMemoryService — what the assistant remembers about THIS session.
 *
 *   GET  /gtfs/assistant/memory          → { notes, ignoredFindings, updatedAt }
 *   PUT  /gtfs/assistant/memory          { addNotes?, removeNoteIds?, ignore?, unignore?, clear? }
 *
 * Two kinds of memory, both decided by the user (directly or through the
 * `remember` / `forget` chat tools):
 *   • notes — short facts and decisions ("route 12 is a school service,
 *     leave its calendar alone", "stop codes are the 4-digit SAE ids") that
 *     are injected in every chat turn so the assistant stops asking;
 *   • ignoredFindings — Diagnostic codes the user chose to mute: the panel
 *     hides them and the assistant does not propose fixes for them.
 *
 * Kept in memory and mirrored to `<session dir>/_assistant_memory.json`
 * (the `_` prefix keeps it out of the export), like the validation report.
 */

"use strict";

const fs = require("fs");
const path = require("path");
const crypto = require("crypto");
const { GTFS_UPLOAD_DIR } = require("./sessionManager");
const { requireSession } = require("./edit/_editCore");

const FILE_NAME = "_assistant_memory.json";
const MAX_NOTES = 40;
const MAX_NOTE_CHARS = 240;
const MAX_IGNORED = 60;
const CODE_RE = /^[a-z0-9_]{1,64}$/i;

const _memories = new Map(); // sessionId -> memory

const filePath = (sessionId) => path.join(GTFS_UPLOAD_DIR, sessionId, FILE_NAME);
const empty = () => ({ notes: [], ignoredFindings: [], updatedAt: null });

const load = (sessionId) => {
  if (_memories.has(sessionId)) return _memories.get(sessionId);
  let mem = empty();
  try {
    const raw = fs.readFileSync(filePath(sessionId), "utf8");
    const parsed = JSON.parse(raw);
    mem = {
      notes: Array.isArray(parsed.notes) ? parsed.notes.filter((n) => n && typeof n.text === "string").slice(0, MAX_NOTES) : [],
      ignoredFindings: Array.isArray(parsed.ignoredFindings) ? parsed.ignoredFindings.filter((c) => typeof c === "string" && CODE_RE.test(c)).slice(0, MAX_IGNORED) : [],
      updatedAt: typeof parsed.updatedAt === "string" ? parsed.updatedAt : null,
    };
  } catch {
    /* no memory yet */
  }
  _memories.set(sessionId, mem);
  return mem;
};

const persist = (sessionId, mem) => {
  mem.updatedAt = new Date().toISOString();
  _memories.set(sessionId, mem);
  try {
    const dir = path.dirname(filePath(sessionId));
    if (fs.existsSync(dir)) fs.writeFileSync(filePath(sessionId), JSON.stringify(mem), "utf8");
  } catch (err) {
    console.warn("assistant memory persist failed:", err.message);
  }
  return mem;
};

const cleanText = (t) => (typeof t === "string" ? t.replace(/\s+/g, " ").trim().slice(0, MAX_NOTE_CHARS) : "");

/** Apply a change set; returns the new memory. `source` tags who wrote the note. */
const update = (sessionId, change = {}, source = "user") => {
  const mem = { ...load(sessionId), notes: [...load(sessionId).notes], ignoredFindings: [...load(sessionId).ignoredFindings] };
  if (change.clear) {
    mem.notes = [];
    mem.ignoredFindings = [];
  }
  const removeIds = new Set(Array.isArray(change.removeNoteIds) ? change.removeNoteIds.map(String) : []);
  if (removeIds.size) mem.notes = mem.notes.filter((n) => !removeIds.has(n.id));
  for (const raw of Array.isArray(change.addNotes) ? change.addNotes : []) {
    const text = cleanText(typeof raw === "string" ? raw : raw && raw.text);
    if (!text) continue;
    if (mem.notes.some((n) => n.text.toLowerCase() === text.toLowerCase())) continue;
    mem.notes.push({ id: crypto.randomBytes(4).toString("hex"), text, ts: new Date().toISOString(), source });
  }
  if (mem.notes.length > MAX_NOTES) mem.notes = mem.notes.slice(mem.notes.length - MAX_NOTES);
  const unignore = new Set(Array.isArray(change.unignore) ? change.unignore.map(String) : []);
  if (unignore.size) mem.ignoredFindings = mem.ignoredFindings.filter((c) => !unignore.has(c));
  for (const code of Array.isArray(change.ignore) ? change.ignore : []) {
    if (typeof code !== "string" || !CODE_RE.test(code) || mem.ignoredFindings.includes(code)) continue;
    mem.ignoredFindings.push(code);
  }
  if (mem.ignoredFindings.length > MAX_IGNORED) mem.ignoredFindings = mem.ignoredFindings.slice(0, MAX_IGNORED);
  return persist(sessionId, mem);
};

const clear = (sessionId) => {
  _memories.delete(sessionId);
  try {
    fs.unlinkSync(filePath(sessionId));
  } catch {
    /* none */
  }
};

/** The `[Memory]` block injected in the current chat user message. */
const buildMemoryBlock = (sessionId) => {
  const mem = load(sessionId);
  const lines = [];
  if (mem.notes.length) lines.push(`Remembered from this session (user decisions and facts — respect them, do not ask again):\n- ${mem.notes.map((n) => n.text).join("\n- ")}`);
  if (mem.ignoredFindings.length) lines.push(`Diagnostic findings the user chose to ignore (do not propose fixes for them unless asked): ${mem.ignoredFindings.join(", ")}.`);
  return lines.length ? `[Memory]\n${lines.join("\n")}` : "";
};

// ── Handlers ───────────────────────────────────────────────────────────────

const getMemory = (req, res) => {
  const ctx = requireSession(req, res);
  if (!ctx) return;
  res.json(load(ctx.sessionId));
};

const putMemory = (req, res) => {
  const ctx = requireSession(req, res);
  if (!ctx) return;
  const body = req.body || {};
  const change = {
    addNotes: Array.isArray(body.addNotes) ? body.addNotes.slice(0, 10) : [],
    removeNoteIds: Array.isArray(body.removeNoteIds) ? body.removeNoteIds.slice(0, 50) : [],
    ignore: Array.isArray(body.ignore) ? body.ignore.slice(0, 20) : [],
    unignore: Array.isArray(body.unignore) ? body.unignore.slice(0, 20) : [],
    clear: body.clear === true,
  };
  if (!change.clear && !change.addNotes.length && !change.removeNoteIds.length && !change.ignore.length && !change.unignore.length) {
    return res.status(400).json({ error: "Nothing to change (addNotes, removeNoteIds, ignore, unignore or clear)." });
  }
  res.json(update(ctx.sessionId, change, "user"));
};

module.exports = { load, update, clear, buildMemoryBlock, getMemory, putMemory, _internals: { cleanText, MAX_NOTES } };
