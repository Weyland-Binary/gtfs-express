/**
 * contract — the project's contract in the browser: what the brief imposes,
 * decided by a named person before any planning by the assistant. Pure
 * functions over the contract's shape below, which the server checks again
 * on every request (contractService: an unnamed decision, tick or dismissal
 * is refused 400) — nothing here is trusted by the server, everything here
 * is what ② shows and sends.
 *
 *   Contract { status: draft|decided|assumed|empty, decided_by, decided_at,   (empty is named too: an unnamed
 *                                                                          empty contract is not ready)
 *     clauses: [clause + quote/page/document; decided → decided_by "user",
 *               decision { by: { name }, at, action: keep|correct|waive };
 *               disputes?: the id of a spreadsheet's objective the reading
 *               of the brief reads otherwise],
 *     wishes: [{ id, quote, why?, document?, cell?, by?: { name }, at?, checked?: { by: { name }, at } }],
 *                                                                          « à vérifier à la main » (by: who marked
 *                                                                          the sentence not measurable; cell: what an
 *                                                                          offer sheet states that no clause covers,
 *                                                                          at « Sheet!B4 »); one nobody checked is
 *                                                                          accepted by name at the build or the
 *                                                                          application (contract_<id>)
 *     assumptions: [{ id, text, confirmed?: { by: { name }, at } }],     confirmed or corrected by a named person
 *     dismissed: [{ sentence, text, by: { name }, at, reason? }],         G5 dismissals (sentence "doc:<id>":
 *                                                                          a document nobody could read, acknowledged)
 *     brief: string | null,                                               the brief typed or pasted at ② (not a
 *                                                                          document): measured on every request
 *     extracted: { model, at, note, documents, objectives, not_measurable,
 *                  left_out: [{ id, name, unreadable? }] } | null }          the documents a reading was given and
 *                                                                          could not read
 */

export const READY_STATUSES = Object.freeze(["decided", "assumed", "empty"]);
export const NAME_RE = /\p{L}/u;
export const nameOk = (s) => typeof s === "string" && s.trim().length >= 2 && s.trim().length <= 120 && NAME_RE.test(s);
/**
 * Ready: decided, assumed, or recorded empty BY A NAMED PERSON (as the server's contractService.isReady: an unnamed
 * empty contract builds and applies nothing, 409 CONTRACT_REQUIRED).
 */
export const isReady = (contract) => READY_STATUSES.includes(contract?.status) && (contract.status !== "empty" || nameOk(contract.decided_by));

/** As many clauses as the server reads of a contract (judge.MAX_CLAUSES, contractService). */
export const MAX_CONTRACT_CLAUSES = 240;
/** The wish that says how many clauses a long brief stated past that bound. */
export const OVERFLOW_WISH = "overflow";
/** As many wishes « à vérifier à la main » as the server keeps of a contract (contractService.MAX_WISHES). */
export const MAX_CONTRACT_WISHES = 240;
/** The wish that says how many points to check by hand the brief holds past that bound. */
export const OVERFLOW_WISHES = "overflow_wishes";

const overflowWords = (count, max, what) => `${count} more ${what} than the ${max} a contract holds`;
const reserved = (id, count, max, what, words) => ({ id, quote: words(count, max, what), overflow: count });

/** Wishes added to the ones a contract holds, each under an id of its own (a tick marks one wish, never its namesakes). */
export const withWishIds = (existing, added) => {
  const used = new Set((existing || []).map((w) => w?.id).filter(Boolean));
  let n = (existing || []).length + 1;
  return (added || []).map((w) => {
    if (w?.id && !used.has(w.id)) {
      used.add(w.id);
      return w;
    }
    while (used.has(`w${n}`)) n += 1;
    used.add(`w${n}`);
    return { ...w, id: `w${n}` };
  });
};

/**
 * The contract held within the server's bounds, never silently (a brief's sheets can state dozens of clauses per
 * line): past MAX_CONTRACT_CLAUSES, the clauses a person decided stay first, then
 * the proposals in their order; the rest is left out and SAID by one wish « à vérifier à la main » — how many, in
 * `words(count, max, "clauses")` — which a named person accepts at the delivery. The wishes are held the same way
 * (MAX_CONTRACT_WISHES, the ones a person marked or checked first; `words(count, max, "wishes")`). A count once said
 * stays said: what was left out is not in the contract any more, whatever room it finds again later.
 */
export const boundedContract = (contract, words = overflowWords) => {
  if (!contract || typeof contract !== "object") return contract;
  let out = contract;
  const clauses = contract.clauses || [];
  if (clauses.length > MAX_CONTRACT_CLAUSES) {
    const wishes = contract.wishes || [];
    const held = wishes.find((w) => w?.id === OVERFLOW_WISH) || null;
    const decided = clauses.filter((c) => isDecided(c));
    const proposed = clauses.filter((c) => !isDecided(c));
    const keep = new Set([...decided, ...proposed].slice(0, MAX_CONTRACT_CLAUSES).map((c) => c.id));
    const left = (held?.overflow || 0) + clauses.length - keep.size;
    out = { ...contract, clauses: clauses.filter((c) => keep.has(c.id)), wishes: [...wishes.filter((w) => w !== held), reserved(OVERFLOW_WISH, left, MAX_CONTRACT_CLAUSES, "clauses", words)] };
  }
  const wishes = out.wishes || [];
  if (wishes.length <= MAX_CONTRACT_WISHES) return out;
  // One place is the reserved wish's; what a person marked or checked (and the clauses' own count) stays first.
  const held = wishes.find((w) => w?.id === OVERFLOW_WISHES) || null;
  const rest = wishes.filter((w) => w !== held);
  const first = rest.filter((w) => w?.id === OVERFLOW_WISH || w?.checked || w?.by);
  const keep = new Set([...first, ...rest.filter((w) => !first.includes(w))].slice(0, MAX_CONTRACT_WISHES - 1));
  const left = (held?.overflow || 0) + rest.length - keep.size;
  return { ...out, wishes: [...rest.filter((w) => keep.has(w)), reserved(OVERFLOW_WISHES, left, MAX_CONTRACT_WISHES, "wishes", words)] };
};

/** A contract before anything was decided. */
export const emptyContract = () => ({ status: "draft", decided_by: null, decided_at: null, clauses: [], wishes: [], assumptions: [], dismissed: [], brief: null, extracted: null });

/** Whether a person decided the clause, under their name. */
export const isDecided = (c) => Boolean(c?.decision && nameOk(c.decision?.by?.name));
export const decisionOf = (c) => (c?.decision && nameOk(c.decision?.by?.name) ? c.decision.action || (c.status === "waived" ? "waive" : "keep") : null);

/** The must clauses still to decide (keep, correct or waive): what holds « Concevoir avec ce contrat ». */
export const undecidedMust = (contract) => (contract?.clauses || []).filter((c) => c.level !== "should" && !isDecided(c));

/**
 * The clause a correction leaves: a correction written in ClauseForm (`patch.params` present) REPLACES the params —
 * the person wrote the whole clause, so nothing of the proposal's conditions may survive unseen (a template switch,
 * a direction or a window removed) — and carries over only the server-derived key `derive` while the kind is still
 * unchanged_except; a correction without params (the level toggle) keeps the clause's params as they are.
 */
const corrected = (clause, patch) => {
  if (!patch) return clause;
  if (!patch.params) return { ...clause, ...patch, params: clause.params || {} };
  const kind = patch.kind || clause.kind;
  const derive = kind === "unchanged_except" && clause.kind === "unchanged_except" && clause.params?.derive && patch.params.derive === undefined ? { derive: clause.params.derive } : {};
  return { ...clause, ...patch, params: { ...patch.params, ...derive } };
};

/**
 * A person's decision on a clause: kept (as proposed), corrected (the new clause, named: see `corrected`), or
 * waived — a waiver is an acceptance of scope `waive`, named, with its reason. Never anonymous.
 */
export const decideClause = (clause, action, { name, at = new Date().toISOString(), patch = null, reason = null } = {}) => {
  if (!nameOk(name)) throw Object.assign(new Error("A decision names the person who decides it."), { code: "ACKNOWLEDGEMENT_UNNAMED" });
  const base = action === "correct" ? corrected(clause, patch) : clause;
  return { ...base, status: action === "waive" ? "waived" : "confirmed", decided_by: "user", decision: { by: { name: name.trim() }, at, action, ...(reason ? { reason: String(reason).slice(0, 200) } : {}) }, ...(action === "waive" && reason ? { reason: String(reason).slice(0, 200) } : {}) };
};

/**
 * The waivers a change of the contract adds (writing off a clause is an acceptance of scope `waive`):
 * the clauses `next` records waived by a named person that `prev` did not. → [clause]
 */
export const waiversAdded = (prev, next) => {
  const before = new Map((prev?.clauses || []).map((c) => [c.id, c]));
  return (next?.clauses || []).filter((c) => decisionOf(c) === "waive" && decisionOf(before.get(c.id)) !== "waive");
};

/** The acknowledgement record of a waiver (the server's acknowledgement.recordOf shape, scope waive), kept with the project. */
export const waiveRecord = (clause, now = new Date().toISOString()) => ({
  id: `waive-${clause.id}-${Date.parse(clause.decision?.at || now) || Date.now()}`,
  scope: "waive",
  by: { name: clause.decision.by.name },
  at: clause.decision.at || now,
  clauses: [clause.id],
  items: [{ kind: "clause", id: clause.id, status: "waived", text: clause.text || null }],
  note: clause.decision.reason || null,
});

/** A decision taken back: the clause is proposed again. */
export const undecideClause = (clause) => {
  const { decision: _d, decided_by: _b, reason: _r, ...rest } = clause; // eslint-disable-line no-unused-vars
  return { ...rest, status: "stated" };
};

/** « Vérifié à la main » ticked by a named person, or unticked. */
export const tickWish = (wish, name, at = new Date().toISOString()) => {
  if (!name) {
    const { checked: _c, ...rest } = wish; // eslint-disable-line no-unused-vars
    return rest;
  }
  if (!nameOk(name)) throw Object.assign(new Error("A tick names the person who checked."), { code: "ACKNOWLEDGEMENT_UNNAMED" });
  return { ...wish, checked: { by: { name: name.trim() }, at } };
};

/**
 * An assumption of the contract confirmed by a named person — or corrected: its new words, confirmed under that
 * name. One nobody confirmed is accepted by name at delivery (the server's pendingAssumptionsOf).
 */
export const confirmAssumption = (contract, id, { name, text = null, at = new Date().toISOString() } = {}) => {
  if (!nameOk(name)) throw Object.assign(new Error("An assumption is confirmed by a named person."), { code: "ACKNOWLEDGEMENT_UNNAMED" });
  const words = typeof text === "string" && text.trim() ? { text: text.trim().slice(0, 300) } : {};
  return { ...contract, assumptions: (contract.assumptions || []).map((a) => (a.id === id ? { ...a, ...words, confirmed: { by: { name: name.trim() }, at } } : a)) };
};

/** A requirement sentence dismissed by a named person (G5: the G4 acknowledgement shape). */
export const dismissSentence = (contract, sentence, { name, reason = null, at = new Date().toISOString() } = {}) => {
  if (!nameOk(name)) throw Object.assign(new Error("A dismissal names the person who dismisses it."), { code: "ACKNOWLEDGEMENT_UNNAMED" });
  const dismissed = [...(contract.dismissed || []).filter((d) => d.sentence !== sentence.id), { sentence: sentence.id, text: sentence.text, by: { name: name.trim() }, at, ...(reason ? { reason: String(reason).slice(0, 300) } : {}) }];
  return { ...contract, dismissed };
};

/**
 * « Enregistrer un contrat vide » (an explicit, named choice): every requirement sentence and unread document
 * the detector lists is dismissed under the person's name, with the reason that the contract is recorded empty — so
 * the empty contract never silences a requirement nobody looked at. → the contract, still to be recorded empty.
 */
export const dismissAllForEmpty = (contract, uncovered, { name, reason, at = new Date().toISOString() } = {}) => {
  if (!nameOk(name)) throw Object.assign(new Error("An empty contract over listed requirements is recorded by a named person."), { code: "ACKNOWLEDGEMENT_UNNAMED" });
  return (uncovered || []).reduce((k, s) => dismissSentence(k, s, { name, reason, at }), contract);
};

/**
 * A requirement sentence marked « à vérifier à la main » (a wish quoting it) by a named person — the contract panel's
 * decider (`contract-decider-name`): « not measurable » is a person's decision, never anonymous. The wish
 * is then accepted by name at the build or the application unless someone checks it by hand (tickWish).
 */
export const markNotMeasurable = (contract, sentence, { name, why = null, at = new Date().toISOString() } = {}) => {
  if (!nameOk(name)) throw Object.assign(new Error("A sentence is marked not measurable by a named person."), { code: "ACKNOWLEDGEMENT_UNNAMED" });
  const wishes = contract.wishes || [];
  const ids = new Set(wishes.map((w) => w.id));
  let n = wishes.length + 1;
  while (ids.has(`w${n}`)) n += 1;
  const id = `w${n}`;
  return { ...contract, wishes: [...wishes, { id, quote: sentence.text.replace(/\s*[.;!?]\s*$/, "").trim(), ...(why ? { why } : {}), by: { name: name.trim() }, at }] };
};

/** A clause added by hand (ClauseForm), carrying its quote; it is the person's, decided as kept under their name. */
export const addClause = (contract, clause, { name = null, at = new Date().toISOString() } = {}) => {
  const ids = new Set((contract.clauses || []).map((c) => c.id));
  let n = (contract.clauses || []).length + 1;
  while (ids.has(`u${n}`)) n += 1;
  const own = { status: "stated", level: "must", ...clause, id: clause.id || `u${n}` };
  const decided = nameOk(name) ? decideClause(own, "keep", { name, at }) : own;
  return { ...contract, clauses: [...(contract.clauses || []).filter((c) => c.id !== decided.id), decided] };
};

/**
 * The contract as ② leaves it (the primary action, or « contrat supposé »): decided, assumed (named), or empty
 * (nothing decided) — recorded empty by a named person too (never anonymously, never by a build).
 */
export const finalize = (contract, status, { name = null, at = new Date().toISOString() } = {}) => {
  if (!nameOk(name)) throw Object.assign(new Error("A contract is decided by a named person."), { code: "ACKNOWLEDGEMENT_UNNAMED" });
  if (status === "empty") return { ...contract, status: "empty", clauses: [], decided_by: name.trim(), decided_at: at };
  return { ...contract, status, decided_by: name.trim(), decided_at: at };
};

// ── The same requirement, read alike (the reading of the brief over the spreadsheets' objectives) ──
const TIME_WORDS = /^(\d{1,2})\s*[:h]\s*(\d{2})$/i;
const plainWords = (s) =>
  String(s)
    .normalize("NFD")
    .replace(/[̀-ͯ]/g, "")
    .toLowerCase()
    .replace(/[’']/g, "'")
    .replace(/\s+/g, " ")
    .trim();
const paramValue = (v) => {
  if (typeof v === "number" || typeof v === "boolean") return v;
  if (typeof v === "string") {
    const time = TIME_WORDS.exec(v.trim());
    if (time) return `${time[1].padStart(2, "0")}:${time[2]}`;
    const n = Number(v);
    return v.trim() !== "" && Number.isFinite(n) ? n : plainWords(v);
  }
  if (Array.isArray(v)) return v.map(paramValue);
  if (v && typeof v === "object") return paramsRead(v);
  return null;
};
// The lists whose order says nothing (a stop_pattern's stops keep theirs), and the kinds' defaults (judge).
const UNORDERED = new Set(["times", "dates", "lines", "avoid", "days", "except"]);
const PARAM_DEFAULTS = { event: "departure", tolerance_min: 0, present: true, day: "weekday", per: "direction", trips: "through" };
const paramsRead = (p) => {
  const out = {};
  for (const [k, v] of Object.entries(p || {})) {
    if (v == null || v === "" || (Array.isArray(v) && !v.length)) continue;
    let n = paramValue(v);
    if (UNORDERED.has(k) && Array.isArray(n)) n = [...n].sort((a, b) => String(a).localeCompare(String(b)));
    if (k in PARAM_DEFAULTS && JSON.stringify(n) === JSON.stringify(paramValue(PARAM_DEFAULTS[k]))) continue;
    out[k] = n;
  }
  if (out.exactly == null && out.min != null && out.min === out.max) {
    out.exactly = out.min;
    delete out.min;
    delete out.max;
  }
  return out;
};
const stableJson = (v) => JSON.stringify(v, (k, x) => (x && typeof x === "object" && !Array.isArray(x) ? Object.fromEntries(Object.entries(x).sort(([a], [b]) => a.localeCompare(b))) : x));

/**
 * Whether two clauses state the same requirement: the same kind, and params read alike — words without accents or
 * case, « 7h30 » as « 07:30 », a list of times or dates as a set, the kinds' defaults left out, min = max as exactly.
 */
export const sameClause = (a, b) => Boolean(a && b && a.kind && a.kind === b.kind) && stableJson(paramsRead(a.params)) === stableJson(paramsRead(b.params));

// An id in brackets in a clause's words: the reading's mark of the spreadsheet objective it reads otherwise.
const DISPUTE_MARK = /\[([^\]\s]{2,64})\]/g;

// The params that say how much (a count, a time, a duration, an order of stops) for the kinds a brief states once
// per thing it is about; the others (the line, the day, the direction, the stop, the window…) say what it is about.
// Two clauses about the same thing that say another value contradict each other, marked or not by the assistant.
const VALUE_PARAMS = {
  trips_count: ["min", "max", "exactly"],
  headway_max: ["minutes"],
  span: ["first_before", "first_after", "last_after", "last_before", "amplitude_h"],
  departure_at: ["times", "tolerance_min"],
  running_time: ["minutes", "min_minutes", "max_minutes", "tolerance_min", "measure"],
  stop_pattern: ["stops", "avoid", "exact", "ends"],
  pickup_dropoff: ["on_demand", "pickup", "drop_off"],
  shape_follows: ["tolerance_m"],
};
const subjectOf = (c) => {
  const values = VALUE_PARAMS[c?.kind];
  if (!values) return null;
  const p = paramsRead(c.params);
  for (const k of values) delete p[k];
  return `${c.kind}|${stableJson(p)}`;
};
const setAside = (c) => decisionOf(c) === "waive" || c?.status === "waived";
const sameQuote = (a, b) => !String(a?.quote || "").trim() || plainWords(a.quote) === plainWords(b?.quote || "");
// The kinds whose values add up: departures at a stop are each a promise of their own (« 7h00 et 7h30 » in a sheet,
// « 17h00 et 17h30 » in the note are four departures, measured each), never two readings of one value. Two of them
// about the same thing are a dispute only when marked by the assistant, or read from the very document the
// spreadsheet's objective cites (the sheet read again, otherwise).
const ADDITIVE = new Set(["departure_at"]);
// The document a clause cites, read as a name: its `document`, its origin's, or the « name · Sheet!A1 » / « name p. 3 » it was read at.
const citedDocument = (c) => documentKey(c?.document || c?.origin?.document || (typeof c?.source === "string" ? c.source.split(" · ")[0] : ""));
// Departures read from the very document the sheet's objective cites are a dispute only when they read one of its times
// otherwise — a time within a quarter of an hour of it, not it (« 06:55 » for the cell's « 06:50 »); the grid's other departures
// (« 08:10 | 08:50 | … » beside « départ à 6h50 ») add up.
const minutesOf = (t) => {
  // « 07:45 », « 7h45 », « 7 h » as a brief writes them.
  const m = /^(\d{1,2})\s*[:hH]\s*(\d{2})?/.exec(String(t || "").trim());
  return m ? Number(m[1]) * 60 + Number(m[2] || 0) : null;
};
const readsOtherwise = (incoming, held) => {
  const theirs = (Array.isArray(held?.params?.times) ? held.params.times : []).map(minutesOf).filter((x) => x != null);
  const mine = (Array.isArray(incoming?.params?.times) ? incoming.params.times : []).map(minutesOf).filter((x) => x != null);
  return mine.some((m) => !theirs.includes(m) && theirs.some((h) => Math.abs(h - m) <= 15));
};
const disputable = (incoming, held) => !ADDITIVE.has(incoming?.kind) || (Boolean(citedDocument(incoming)) && citedDocument(incoming) === citedDocument(held) && readsOtherwise(incoming, held));
// A marked departure that states the sheet's own times again among more (« les autres départs de Pélissier de la
// grille — 06:50 | 07:30 | … » marked against « départ de Pélissier à 6h50 »): it reads the cells the same way and
// adds departures — kept beside the sheet's, never a dispute that holds ② and makes the person set one aside.
const hhmm = (t) => String(t || "").trim().replace(/^(\d):/, "0$1:").slice(0, 5);
const extendsDepartures = (incoming, held) => {
  if (!ADDITIVE.has(incoming?.kind) || incoming.kind !== held?.kind) return false;
  const a = incoming.params || {};
  const b = held.params || {};
  if (String(a.line ?? "") !== String(b.line ?? "") || plainWords(a.stop || "") !== plainWords(b.stop || "")) return false;
  const times = new Set((Array.isArray(a.times) ? a.times : []).map(hhmm));
  const own = (Array.isArray(b.times) ? b.times : []).map(hhmm);
  return own.length > 0 && own.every((x) => times.has(x));
};

/**
 * The clauses of a reading of the brief over the objectives the contract holds (`held`: what the reading does not
 * replace — the spreadsheets' objectives read cell by cell, listed in its message for the assistant to check, the
 * person's decisions, the suggestions, the proposals of documents it was not given). One that states a spreadsheet's
 * objective again is dropped (`repeats`) — the objective already cites its cells —, and so is one that states again,
 * from the same words, an objective held otherwise (the person decided it, or another reading proposed it). One that
 * reads a spreadsheet's objective otherwise is kept as a dispute of it (`disputes`: its id, the person deciding which
 * reading holds): marked against it by the assistant, or about the same thing (the same kind, line,
 * day, direction, stop…) with another value — never two objectives that contradict each other kept side by side —,
 * unless the person already set that objective aside: then it is a proposal like any other. Departures (ADDITIVE)
 * add up: unmarked, the times another document states at that stop are more departures, kept beside the sheet's —
 * never a dispute that holds ② and makes the person set one aside —; the same document's other times are a dispute.
 * The mark is the assistant's note to the application, never left in the objective's words.
 * → { clauses, repeats, disputes }
 */
export const reconciledClauses = (incoming, held) => {
  const sheet = (held || []).filter((c) => fromSheet(c));
  const others = (held || []).filter((c) => c && !fromSheet(c));
  const byId = new Map(sheet.map((c) => [c.id, c]));
  const clauses = [];
  let repeats = 0;
  let disputes = 0;
  for (const c of incoming || []) {
    if (!c) continue;
    const text = String(c.text || "");
    const named = [...text.matchAll(DISPUTE_MARK)].map((m) => m[1]).find((id) => byId.has(id)) || null;
    const marked = named ? byId.get(named) : null;
    const own = marked ? { ...c, text: text.replace(`[${named}]`, "").replace(/\s+/g, " ").replace(/^[\s:—–-]+/, "").trim() || text } : c;
    if ((marked ? sameClause(own, marked) : sheet.some((s) => sameClause(own, s))) || others.some((h) => sameClause(own, h) && sameQuote(own, h))) {
      repeats += 1;
      continue;
    }
    // Not marked: the spreadsheet's objective about the same thing, if one says another value.
    const subject = marked ? null : subjectOf(own);
    const target = marked && !extendsDepartures(own, marked) ? marked : marked ? null : subject ? sheet.find((s) => !setAside(s) && subjectOf(s) === subject && disputable(own, s)) || null : null;
    if (target && !setAside(target)) {
      clauses.push({ ...own, disputes: target.id });
      disputes += 1;
    } else clauses.push(own);
  }
  return { clauses, repeats, disputes };
};

// The document a clause of an extraction cites (its `document`, else its source « name p. 3 »), read as a name.
const documentKey = (s) => plainWords(String(s || "").replace(/\s+p\.\s*\d+\s*$/i, "").replace(/\.[a-z0-9]{2,5}$/i, ""));
const citesDocument = (c, d) => {
  const a = documentKey(c?.document || (typeof c?.source === "string" ? c.source : ""));
  return Boolean(a) && a === documentKey(d?.name);
};

// What an extraction leaves of the contract's clauses (see withExtraction), and the documents read before whose
// proposals stay: not read now, and either left out of this reading or not given it (`partial`).
const heldThrough = (contract, record) => {
  const partial = Boolean(record?.partial);
  const before = contract?.extracted?.documents || [];
  const now = record?.documents || [];
  const leftNow = new Set((record?.left_out || []).map((d) => d?.id).filter(Boolean));
  const keepFor = before.filter((d) => d?.id && !now.some((x) => x?.id === d.id) && (partial || leftNow.has(d.id)));
  const own = (contract?.clauses || []).filter((c) => isDecided(c) || String(c.id).startsWith("u") || fromSheet(c) || c?.source?.kind === "recommendation" || keepFor.some((d) => citesDocument(c, d)));
  return { own, keepFor };
};

/**
 * An extraction's draft contract over the one ② holds: the person's decisions and what
 * no extraction proposed stay — a spreadsheet's clauses read cell by cell (source.cells) and the measured suggestions
 * (source.kind recommendation), decided or not: an extraction only replaces its own earlier proposals — of the
 * documents it read. The earlier proposals of a document read before that this reading was given and could not read
 * (its `left_out`: too long with the others for one message) stay, and a reading of such documents on their own
 * (`partial`) keeps every earlier proposal of the documents it was not given, with the earlier
 * « not measurable » ones (they name no document). What it states again of an objective it does not replace goes,
 * what it reads otherwise than a spreadsheet's objective is a dispute (reconciledClauses). Its record keeps every
 * document read and the ones a reading was given and could not read (`left_out`: read again on their own, never
 * dropped unsaid).
 */
export const withExtraction = (contract, extracted) => {
  const record = extracted?.extracted || null;
  const partial = Boolean(record?.partial);
  const before = contract?.extracted?.documents || [];
  const now = record?.documents || [];
  const { own, keepFor } = heldThrough(contract, record);
  const { clauses: incoming } = reconciledClauses(extracted?.clauses || [], own);
  const ids = new Set(own.map((c) => c.id));
  // The extractor numbers c1, c2…: a number already used by a decided clause takes the next free one.
  let n = 1;
  const renamed = new Map();
  const renumbered = incoming.map((c) => {
    if (!ids.has(c.id)) return c;
    while (ids.has(`c${n}`) || incoming.some((x) => x.id === `c${n}`)) n += 1;
    ids.add(`c${n}`);
    renamed.set(c.id, `c${n}`);
    return { ...c, id: `c${n}` };
  });
  // The wishes a person marked or checked, the ones a sheet's reading recorded (its cell) and the one that says a
  // long brief's clauses left out (boundedContract) are not the extraction's to replace: only its own earlier « not
  // measurable » proposals go — none on a reading of left-out documents alone (`partial`): theirs are the others'.
  // The extractor numbers its wishes w1, w2…: a number already held takes the next free one.
  const kept = (contract?.wishes || []).filter((w) => partial || w.checked || w.by || w.cell || w.id === OVERFLOW_WISH || w.id === OVERFLOW_WISHES);
  const quotes = new Set(kept.map((w) => w.quote));
  // The documents this extraction read join the ones read before (a second prose document read on its own turn).
  const documents = [...before.filter((d) => !now.some((x) => x.id === d.id)), ...now];
  const read = new Set(documents.map((d) => d?.id));
  const leftOut = new Map();
  for (const d of [...(contract?.extracted?.left_out || []), ...(record?.left_out || [])]) if (d?.id && !read.has(d.id)) leftOut.set(d.id, d);
  const recordsLeftOut = Array.isArray(contract?.extracted?.left_out) || Array.isArray(record?.left_out);
  // What the extraction proposed, as the contract holds it (changesSinceExtraction compares them): its clauses under
  // the ids they took, without those it stated again; beside a reading that kept earlier proposals, theirs.
  const proposedIds = new Set(incoming.map((c) => c.id));
  const heldIds = new Set(own.map((c) => c.id));
  const objectives = [
    ...(keepFor.length ? (contract?.extracted?.objectives || []).filter((o) => heldIds.has(o?.clause?.id)) : []),
    ...(record?.objectives || []).filter((o) => !o?.clause?.id || proposedIds.has(o.clause.id)).map((o) => (o?.clause?.id && renamed.has(o.clause.id) ? { ...o, clause: { ...o.clause, id: renamed.get(o.clause.id) } } : o)),
  ];
  // (`partial` says how this reading merges: never a field of the record kept.)
  const { partial: _partial, ...stored } = record || {}; // eslint-disable-line no-unused-vars
  return {
    ...(contract || emptyContract()),
    status: "draft",
    clauses: [...own, ...renumbered],
    wishes: [...kept, ...withWishIds(kept, (extracted?.wishes || []).filter((w) => !quotes.has(w.quote)))],
    extracted: record ? { ...stored, documents, ...(Array.isArray(record.objectives) || objectives.length ? { objectives } : {}), ...(recordsLeftOut ? { left_out: [...leftOut.values()] } : {}) } : null,
    dismissed: contract?.dismissed || [],
  };
};

/**
 * Whether a clause was read from a spreadsheet of the brief, cell by cell (no model): the reading marks it
 * (`origin.kind` "sheet": ChangeStudio.readSheet), and the server cites its cell as « file · Sheet!A1 ».
 */
export const fromSheet = (c) => c?.origin?.kind === "sheet" || Array.isArray(c?.source?.cells) || (typeof c?.source === "string" && / · [^·]*![A-Z]+\d+/.test(c.source));

/**
 * What the person changed since the extraction (② shows it): for each extracted clause, "kept" (as proposed),
 * "corrected" (params, level or kind differ), "waived", or "removed"; clauses added by hand are "added".
 */
export const changesSinceExtraction = (contract) => {
  const proposed = (contract?.extracted?.objectives || []).map((o, i) => ({ ...(o.clause || {}), id: o.clause?.id || `c${i + 1}` }));
  const out = {};
  for (const p of proposed) {
    const now = (contract.clauses || []).find((c) => c.id === p.id);
    if (!now) out[p.id] = "removed";
    else if (now.status === "waived") out[p.id] = "waived";
    else if (JSON.stringify(now.params || {}) !== JSON.stringify(p.params || {}) || now.level !== p.level || now.kind !== p.kind) out[p.id] = "corrected";
    else out[p.id] = "kept";
  }
  for (const c of contract?.clauses || []) if (!proposed.some((p) => p.id === c.id) && !out[c.id]) out[c.id] = "added";
  return out;
};

/**
 * The contract as a request carries it: what the server reads, nothing of this browser's own bookkeeping (the reading's
 * mark of a quote found in the brief, shown at ②).
 */
export const contractForServer = (contract) => {
  if (!contract) return null;
  return { ...contract, clauses: (contract.clauses || []).map(({ quote_verified: _q, ...c }) => c) };
};
