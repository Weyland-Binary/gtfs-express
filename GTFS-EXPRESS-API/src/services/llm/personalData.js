/**
 * The names and e-mails of people never reach the model provider. Two layers: what the services write for the model
 * leaves names out (the tables in PERSONAL_TABLES are never read), and every request body passes through
 * scrubRequest (llm/provider.createClient), which replaces the persons known to the request by a stable pseudonym
 * (an HMAC under IP_HASH_SECRET, so the prompt cache still hits) and any e-mail address by its form.
 *
 * A name matches whole, case-insensitive: a letter, digit or hyphen beside it makes it part of another word
 * ("Martin" never touches "Saint-Martin"); an apostrophe does not (« l'adresse d'Alice Dupont », a SQL literal
 * 'Alice Dupont'), and a one-word name followed by a capitalised word starts a longer proper name ("Jean" never touches « Jean Jaurès »: the agent writes its SQL with the feed's names as they are).
 * A stop or a street bearing exactly a registered person's name is pseudonymised too: the rule is the person's.
 * Unregistered names in a brief's text are beyond any pattern; a PDF or an image travels as it is.
 */

"use strict";

const { AsyncLocalStorage } = require("async_hooks");

const storage = new AsyncLocalStorage();
// The shortest name a person signs with (acknowledgement.NAME_OK): two characters, with a letter.
const MIN_NAME = 2;
const MAX_NAME = 254;
const PERSON_LABEL = "a named person";
const PERSONAL_TABLES = ["_edit_log", "_acknowledgements"];

const clean = (v) => (typeof v === "string" ? v.replace(/\s+/g, " ").trim() : "");
const isObject = (v) => Boolean(v) && typeof v === "object" && !Array.isArray(v);
const nameOfBy = (by) => (typeof by === "string" ? by : isObject(by) ? by.name : null);

/** The usable names of a list: strings, trimmed, de-duplicated (case-insensitive), long enough. */
const usable = (names) => {
  const out = new Map();
  for (const raw of names || []) {
    const n = clean(raw);
    if (n.length >= MIN_NAME && n.length <= MAX_NAME && /\p{L}/u.test(n)) out.set(n.toLowerCase(), n);
  }
  return [...out.values()];
};

// ── Where persons are named

const namesOfUser = (user) => (isObject(user) ? usable([user.display_name, user.email]) : []);

/** An older project may still store a contract of any shape: read it defensively. */
const namesOfContract = (contract) => {
  if (!isObject(contract)) return [];
  const names = [nameOfBy(contract.decided_by)];
  for (const c of Array.isArray(contract.clauses) ? contract.clauses : []) if (isObject(c)) names.push(nameOfBy(c.decision?.by), nameOfBy(c.by));
  for (const w of Array.isArray(contract.wishes) ? contract.wishes : []) if (isObject(w)) names.push(nameOfBy(w.by), nameOfBy(w.checked?.by));
  for (const a of Array.isArray(contract.assumptions) ? contract.assumptions : []) if (isObject(a)) names.push(nameOfBy(a.confirmed?.by));
  for (const d of Array.isArray(contract.dismissed) ? contract.dismissed : []) if (isObject(d)) names.push(nameOfBy(d.by));
  return usable(names);
};

const namesOfProject = (project) => {
  if (!isObject(project)) return [];
  const names = [...namesOfContract(project.contract)];
  for (const a of Array.isArray(project.acknowledgements) ? project.acknowledgements : []) if (isObject(a)) names.push(nameOfBy(a.by));
  for (const e of Array.isArray(project.journal) ? project.journal : []) if (isObject(e)) names.push(nameOfBy(e.actor));
  for (const v of Array.isArray(project.versions) ? project.versions : []) if (isObject(v)) names.push(nameOfBy(v.by), nameOfBy(v.delivered_by));
  if (isObject(project.delivery)) names.push(nameOfBy(project.delivery.by));
  for (const r of Array.isArray(project.reviews) ? project.reviews : []) if (isObject(r)) names.push(nameOfBy(r.by));
  return usable(names);
};

const namesOfSessionDb = (db) => {
  if (!db || typeof db.prepare !== "function") return [];
  const names = [];
  for (const sql of ["SELECT DISTINCT actor_name AS n FROM _edit_log WHERE actor_name IS NOT NULL", "SELECT DISTINCT by_name AS n FROM _acknowledgements"]) {
    try {
      for (const r of db.prepare(sql).all()) names.push(r.n);
    } catch {
      /* an old copy or a sandbox may lack the table */
    }
  }
  return usable(names);
};

// ── The scope of a request

const scopeOf = (names = [], lazy = []) => {
  const parent = storage.getStore();
  return { names: new Set([...(parent ? current() : []), ...usable(names)]), lazy: [...lazy] };
};

/** A scope for a call outside any request (a test, a script). */
const run = (names, fn) => storage.run(scopeOf(names), fn);

const remember = (names) => {
  const scope = storage.getStore();
  if (!scope) return;
  for (const n of usable(names)) scope.names.add(n);
};

/** Lazy sources are resolved once, at the first model request. */
const current = () => {
  const scope = storage.getStore();
  if (!scope) return [];
  while (scope.lazy.length) {
    const source = scope.lazy.shift();
    try {
      for (const n of usable(source())) scope.names.add(n);
    } catch {
      /* a session gone or a store closed adds nothing */
    }
  }
  return usable([...scope.names]);
};

/** Only a working copy already open is read. */
const namesOfSession = (sessionId) => {
  if (!sessionId || !/^[A-Za-z0-9_-]{8,128}$/.test(String(sessionId))) return [];
  const names = [];
  const connection = require("../db/connection");
  if (connection.hasEditDb(sessionId)) names.push(...namesOfSessionDb(connection.getEditDb(sessionId)));
  const config = require("../../config");
  if (config.WORKSPACE_ENABLED) {
    const store = require("../workspace/workspaceStore");
    if (store.exists()) {
      // A draft's session belongs to its working copy's project.
      const main = require("../transform/draftSession").mainOf(sessionId);
      const binding = store.bindingOf(sessionId) || (main ? store.bindingOf(main) : null);
      const row = binding ? store.projectRowById(binding.project_id) : null;
      if (row) {
        try {
          names.push(...namesOfProject(JSON.parse(row.data)));
        } catch {
          /* an unreadable document adds nothing */
        }
        names.push(...store.listReviews(row.id).map((r) => r.by?.name));
      }
    }
  }
  return names;
};

const personalDataContext = (req, _res, next) => {
  const { cleanName } = require("../edit/actorContext");
  // The declared name counts even with an account signed in: the person may have typed it elsewhere.
  const names = [...namesOfUser(req.user), cleanName(req.headers?.["x-actor-name"])];
  const sessionId = req.headers?.["x-session-id"];
  storage.run({ names: new Set(usable(names)), lazy: sessionId ? [() => namesOfSession(String(sessionId))] : [] }, () => next());
};

// ── Replacing them

const pseudonymOf = (name) => {
  const { hashIp } = require("../eventLogger");
  return `[person-${String(hashIp(clean(name).toLowerCase()) || "000000").slice(0, 6)}]`;
};

const escapeRe = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
const NOT_PART = "[\\p{L}\\p{N}_-]";
const patterns = new Map();

// After a one-word name: a capitalised word makes it the first word of a longer proper name (« Jean Jaurès »). Read
// case-sensitively, apart from the names' pattern: under its `i` flag \p{Lu} would match any letter.
const STARTS_PROPER_NAME = /^\s+\p{Lu}/u;

const patternOf = (names) => {
  const list = usable(names).sort((a, b) => b.length - a.length);
  if (!list.length) return null;
  const key = list.map((n) => n.toLowerCase()).join("\u0000");
  if (patterns.has(key)) return patterns.get(key);
  const alternatives = list.map((n) => n.split(" ").map(escapeRe).join("\\s+"));
  const re = new RegExp(`(?<!${NOT_PART})(?:${alternatives.join("|")})(?!${NOT_PART})`, "giu");
  if (patterns.size > 200) patterns.clear();
  patterns.set(key, re);
  return re;
};

// An e-mail address by its form (letters of any script, the usual punctuation of a local part, a dotted domain):
// a feed's identifiers, times and URLs without "@" are never one.
const EMAIL_RE = /(?<![\p{L}\p{N}._%+-])[\p{L}\p{N}._%+-]+@[\p{L}\p{N}-]+(?:\.[\p{L}\p{N}-]+)*\.\p{L}{2,}(?![\p{L}\p{N}-])/gu;
const HAS_EMAIL_RE = new RegExp(EMAIL_RE.source, "u");

const emailPseudonymOf = (email) => {
  const { hashIp } = require("../eventLogger");
  return `[email-${String(hashIp(clean(email).toLowerCase()) || "000000").slice(0, 6)}]`;
};

const scrubString = (text, re) => {
  const named = re ? text.replace(re, (m, offset, whole) => (!/\s/.test(m) && STARTS_PROPER_NAME.test(whole.slice(offset + m.length, offset + m.length + 8)) ? m : pseudonymOf(m))) : text;
  return named.includes("@") ? named.replace(EMAIL_RE, (m) => emailPseudonymOf(m)) : named;
};

const scrubText = (text, names) => {
  if (typeof text !== "string" || !text) return text;
  return scrubString(text, patternOf(names));
};

// What the API reads as protocol, never as text: a block's type, the ids that pair a tool call with its result, a
// media type, a cache breakpoint — and a thinking block's signature, which a rewritten byte makes the API refuse.
const PROTOCOL_KEYS = new Set(["type", "id", "tool_use_id", "media_type", "cache_control", "signature"]);
// Blocks sent back exactly as the model returned them: a thinking block is verified against its signature, and the
// model only ever saw scrubbed inputs, so they carry nothing to replace. A tool call's name is the code's own word.
const VERBATIM_BLOCKS = new Set(["thinking", "redacted_thinking"]);
const TOOL_CALLS = new Set(["tool_use", "server_tool_use"]);

const scrubValue = (value, re) => {
  if (typeof value === "string") return scrubString(value, re);
  if (Array.isArray(value)) return value.map((v) => scrubValue(v, re));
  if (!isObject(value)) return value;
  if (value.type === "base64" || VERBATIM_BLOCKS.has(value.type)) return value;
  const out = {};
  for (const [k, v] of Object.entries(value)) out[k] = PROTOCOL_KEYS.has(k) || (k === "name" && TOOL_CALLS.has(value.type)) ? v : scrubValue(v, re);
  return out;
};

/** Only the system prompt and the messages carry text; the tools' definitions are the code's own words. */
const scrubRequest = (body, names) => {
  if (!isObject(body)) return body;
  const re = patternOf(names);
  if (!re && !HAS_EMAIL_RE.test(JSON.stringify([body.system ?? null, body.messages ?? null]))) return body;
  const out = { ...body };
  if ("system" in out) out.system = scrubValue(out.system, re);
  if ("messages" in out) out.messages = scrubValue(out.messages, re);
  return out;
};

module.exports = {
  MIN_NAME,
  PERSON_LABEL,
  PERSONAL_TABLES,
  personalDataContext,
  run,
  remember,
  current,
  namesOfUser,
  namesOfContract,
  namesOfProject,
  namesOfSessionDb,
  namesOfSession,
  pseudonymOf,
  emailPseudonymOf,
  scrubText,
  scrubRequest,
};
