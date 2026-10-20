/**
 * llm/personalData — the names and e-mails of people never reach the model
 * provider.
 *
 * Why: the contract names the person who decided it (decided_by, each
 * decision's by.name), an acknowledgement names who accepted a risk, the
 * journal names who did what, an account has a name and an e-mail. None of
 * that is needed to design a network or plan a change, and the provider is
 * a processor the terms must otherwise name for it. Two layers keep it out:
 *
 *   1. Structural — what the services write for the model leaves the names
 *      out: the contract's block says « a named person » (contractService
 *      .promptOf), the chat's SQL tool cannot read the journal's tables
 *      (chatAgentTools.run_sql, PERSONAL_TABLES), and so on.
 *   2. A safety net under every request — the model client of
 *      llm/provider.createClient passes each request body through
 *      scrubRequest with the persons known to the current request: their
 *      names and e-mails, wherever they appear (a tool result, an assumption
 *      quoted back, the user's own message, a file name), are replaced by a
 *      stable pseudonym, « [person-1a2b3c] » (an HMAC of the lower-cased
 *      name under IP_HASH_SECRET, so the same person keeps the same
 *      pseudonym across turns and the prompt cache still hits).
 *
 * The persons of a request live in an AsyncLocalStorage opened by the
 * middleware (`personalDataContext`, after userContext and actorContext): the
 * account's name and e-mail, the name this browser declares for its
 * acknowledgements (X-Actor-Name), and — resolved lazily, at the first model
 * request only — the names in the working copy's journal and acknowledgements
 * (X-Session-Id) and in the project it is bound to. The services that receive
 * a contract or a project add theirs (`remember`), and `run` opens a scope for
 * a call outside any request (a test, a script).
 *
 * A name is matched whole (case-insensitive, its words separated by any
 * spaces; a letter, a digit, a hyphen or an apostrophe next to it means it is
 * part of another word: "Martin" never touches "Saint-Martin"). Every name a
 * person may sign with is matched, the two-character ones included (« Li »,
 * « Wu »: the shortest an acknowledgement accepts, acknowledgement.NAME_OK),
 * since each name here is a known person of the request, never a dictionary;
 * only a single character is left to the structural layer (MIN_NAME). A stop
 * or a street that bears exactly a registered person's name is pseudonymised
 * too: the rule is the person's, not the data's.
 *
 * Any e-mail address is replaced too, known or not, by its form: a brief's
 * signature, an authority's contact, a feed_info contact — « [email-1a2b3c] ».
 * The names of
 * persons nobody registered, in a brief's text, are beyond any pattern; a PDF
 * or an image travels as it is (base64), which the terms say.
 *
 *   personalDataContext(req, res, next)   the middleware
 *   run(names, fn)                        fn in a scope with these persons (plus the enclosing ones)
 *   remember(names)                       add persons to the current scope (no scope: nothing)
 *   current()                             the persons of the current scope (lazy sources resolved)
 *   namesOfUser(user) / namesOfContract(contract) / namesOfProject(project) / namesOfSessionDb(db)
 *   pseudonymOf(name)                     "[person-xxxxxx]"
 *   scrubText(text, names) / scrubRequest(body, names)
 *   PERSON_LABEL                          "a named person" — what the structural layer writes instead of a name
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

// ── Where persons are named ────────────────────────────────────────────────

/** An account: its display name and its e-mail. */
const namesOfUser = (user) => (isObject(user) ? usable([user.display_name, user.email]) : []);

/**
 * A contract as the planners receive it (any shape: read defensively): every named mark it carries — who decided or
 * assumed it, who decided a clause, who marked a sentence « à vérifier à la main » (wishes[].by) and who checked it
 * by hand (wishes[].checked.by), who confirmed an assumption, who dismissed a requirement sentence.
 */
const namesOfContract = (contract) => {
  if (!isObject(contract)) return [];
  const names = [nameOfBy(contract.decided_by)];
  for (const c of Array.isArray(contract.clauses) ? contract.clauses : []) if (isObject(c)) names.push(nameOfBy(c.decision?.by), nameOfBy(c.by));
  for (const w of Array.isArray(contract.wishes) ? contract.wishes : []) if (isObject(w)) names.push(nameOfBy(w.by), nameOfBy(w.checked?.by));
  for (const a of Array.isArray(contract.assumptions) ? contract.assumptions : []) if (isObject(a)) names.push(nameOfBy(a.confirmed?.by));
  for (const d of Array.isArray(contract.dismissed) ? contract.dismissed : []) if (isObject(d)) names.push(nameOfBy(d.by));
  return usable(names);
};

/** A journey's project document (workspace): its contract, acknowledgements, journal, versions, delivery. */
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

/** A working copy's database: the names of its journal and its acknowledgements (absent tables: none). */
const namesOfSessionDb = (db) => {
  if (!db || typeof db.prepare !== "function") return [];
  const names = [];
  for (const sql of ["SELECT DISTINCT actor_name AS n FROM _edit_log WHERE actor_name IS NOT NULL", "SELECT DISTINCT by_name AS n FROM _acknowledgements"]) {
    try {
      for (const r of db.prepare(sql).all()) names.push(r.n);
    } catch {
      /* a database without the table (an old copy, a sandbox): nothing to add */
    }
  }
  return usable(names);
};

// ── The scope of a request ─────────────────────────────────────────────────

/** A new scope: the enclosing one's persons, these names, and lazy sources resolved at the first read. */
const scopeOf = (names = [], lazy = []) => {
  const parent = storage.getStore();
  return { names: new Set([...(parent ? current() : []), ...usable(names)]), lazy: [...lazy] };
};

/** fn with these persons known (plus the enclosing scope's): a test, a script, a planner called directly. */
const run = (names, fn) => storage.run(scopeOf(names), fn);

/** Add persons to the current scope; outside any scope nothing is recorded (and nothing is sent either). */
const remember = (names) => {
  const scope = storage.getStore();
  if (!scope) return;
  for (const n of usable(names)) scope.names.add(n);
};

/** The persons of the current scope, its lazy sources resolved once (a failing source adds nothing). */
const current = () => {
  const scope = storage.getStore();
  if (!scope) return [];
  while (scope.lazy.length) {
    const source = scope.lazy.shift();
    try {
      for (const n of usable(source())) scope.names.add(n);
    } catch {
      /* a source that cannot be read (a session gone, a store closed) adds nothing */
    }
  }
  return usable([...scope.names]);
};

/** The names in the working copy of a session id and in the project it is bound to — only when already open. */
const namesOfSession = (sessionId) => {
  if (!sessionId || !/^[A-Za-z0-9_-]{8,128}$/.test(String(sessionId))) return [];
  const names = [];
  const connection = require("../db/connection");
  if (connection.hasEditDb(sessionId)) names.push(...namesOfSessionDb(connection.getEditDb(sessionId)));
  const config = require("../../config");
  if (config.WORKSPACE_ENABLED) {
    const store = require("../workspace/workspaceStore");
    if (store.exists()) {
      // A draft's session is the project's too: its persons are its working copy's project's.
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

/**
 * Express middleware: the rest of the request runs with its persons known —
 * the account's name and e-mail and the declared acknowledgement name now,
 * the working copy's and its project's at the first model request.
 */
const personalDataContext = (req, _res, next) => {
  const { cleanName } = require("../edit/actorContext");
  // The declared name counts even when an account is signed in (the journal then writes the account's, but the
  // browser still sends it, and the person may have typed it elsewhere).
  const names = [...namesOfUser(req.user), cleanName(req.headers?.["x-actor-name"])];
  const sessionId = req.headers?.["x-session-id"];
  storage.run({ names: new Set(usable(names)), lazy: sessionId ? [() => namesOfSession(String(sessionId))] : [] }, () => next());
};

// ── Replacing them ─────────────────────────────────────────────────────────

/** A person's stable pseudonym: the same name (whatever its case and spacing) always gives the same one. */
const pseudonymOf = (name) => {
  const { hashIp } = require("../eventLogger");
  return `[person-${String(hashIp(clean(name).toLowerCase()) || "000000").slice(0, 6)}]`;
};

const escapeRe = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
const NOT_PART = "[\\p{L}\\p{N}_'’-]";
const patterns = new Map();

/** One regular expression for a set of names (longest first), cached. */
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

/** An address's stable pseudonym, as a person's: the same address (whatever its case) always gives the same one. */
const emailPseudonymOf = (email) => {
  const { hashIp } = require("../eventLogger");
  return `[email-${String(hashIp(clean(email).toLowerCase()) || "000000").slice(0, 6)}]`;
};

/** A string with the registered persons (`re`, or none) and then any e-mail address replaced. */
const scrubString = (text, re) => {
  const named = re ? text.replace(re, (m) => pseudonymOf(m)) : text;
  return named.includes("@") ? named.replace(EMAIL_RE, (m) => emailPseudonymOf(m)) : named;
};

/** A text with every registered person and every e-mail address replaced by their pseudonym. */
const scrubText = (text, names) => {
  if (typeof text !== "string" || !text) return text;
  return scrubString(text, patternOf(names));
};

/** Every string of a value (objects and arrays walked), a base64 payload (a PDF, an image) left as it is. */
const scrubValue = (value, re) => {
  if (typeof value === "string") return scrubString(value, re);
  if (Array.isArray(value)) return value.map((v) => scrubValue(v, re));
  if (!isObject(value)) return value;
  if (value.type === "base64") return value;
  const out = {};
  for (const [k, v] of Object.entries(value)) out[k] = scrubValue(v, re);
  return out;
};

/**
 * A model request with the persons replaced in what carries text — the
 * system prompt and the messages (text, tool calls echoed back, tool
 * results, documents' titles). The model id, the tools' definitions (the
 * code's own words) and the rest are left as they are. The same object when
 * nobody is known.
 */
const scrubRequest = (body, names) => {
  if (!isObject(body)) return body;
  const re = patternOf(names);
  // Nobody registered and no address in the text: the same object, untouched.
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
