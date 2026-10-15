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
 *               of the brief reads otherwise (openDisputes)],
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
 *                                                                          could not read (utils/briefReading)
 *
 * A clause prefilled « kept by default » (the two « inchangé » clauses of a
 * modify project) carries `keep_by_default`: it counts as decided for the
 * primary action, and « Concevoir / Rédiger avec ce contrat » records it kept
 * by the person who proceeds, under their name (finalize) — never a decision
 * without a name.
 */

export const READY_STATUSES = Object.freeze(["decided", "assumed", "empty"]);
export const NAME_RE = /\p{L}/u;
export const nameOk = (s) => typeof s === "string" && s.trim().length >= 2 && s.trim().length <= 120 && NAME_RE.test(s);
/**
 * Ready: decided, assumed, or recorded empty BY A NAMED PERSON (as the server's contractService.isReady: an unnamed
 * empty contract builds and applies nothing, 409 CONTRACT_REQUIRED).
 */
export const isReady = (contract) => READY_STATUSES.includes(contract?.status) && (contract.status !== "empty" || nameOk(contract.decided_by));

/** As many clauses as the server reads of a contract (conformanceService.MAX_CLAUSES, contractService). */
export const MAX_CONTRACT_CLAUSES = 240;
/** The wish that says how many clauses a long brief stated past that bound. */
export const OVERFLOW_WISH = "overflow";
/** As many wishes « à vérifier à la main » as the server keeps of a contract (contractService.MAX_WISHES). */
export const MAX_CONTRACT_WISHES = 240;
/** The wish that says how many points to check by hand the brief holds past that bound. */
export const OVERFLOW_WISHES = "overflow_wishes";

const overflowWords = (count, max, what) => `${count} more ${what} than the ${max} a contract holds`;
const reserved = (id, count, max, what, words) => ({ id, quote: words(count, max, what), overflow: count });

/**
 * `count` more points to check by hand than the contract has room for (a sheet read once the contract is full):
 * counted by the contract's reserved wish, with the ones counted before — never dropped unsaid.
 */
export const withUnrecordedWishes = (contract, count, words = overflowWords) => {
  const n = Math.max(0, Math.floor(Number(count) || 0));
  if (!contract || !n) return contract;
  const wishes = contract.wishes || [];
  const held = wishes.find((w) => w?.id === OVERFLOW_WISHES) || null;
  return { ...contract, wishes: [...wishes.filter((w) => w !== held), reserved(OVERFLOW_WISHES, (held?.overflow || 0) + n, MAX_CONTRACT_WISHES, "wishes", words)] };
};

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
 * line): past MAX_CONTRACT_CLAUSES, the clauses a person decided (and the ones kept by default) stay first, then
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

/**
 * The two « inchangé » clauses a modify project starts with (②): step 2's unchanged_except, derived at every
 * measure from the plan's operations (the server's unchangedClauses), kept by default, waivable by name.
 */
export const unchangedClauses = (t) => [
  { id: "other_lines_unchanged", kind: "unchanged_except", level: "must", status: "stated", text: t("contract.unchanged.lines"), params: { derive: "other_lines" }, keep_by_default: true },
  { id: "rest_of_the_day_unchanged", kind: "unchanged_except", level: "must", status: "stated", text: t("contract.unchanged.day"), params: { derive: "rest_of_day" }, keep_by_default: true },
];

/** Whether a person decided the clause (named), or it is kept by default until the person proceeds. */
export const isDecided = (c) => Boolean((c?.decision && nameOk(c.decision?.by?.name)) || c?.keep_by_default);
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
  const { keep_by_default: _k, ...rest } = clause; // eslint-disable-line no-unused-vars
  const base = action === "correct" ? corrected(rest, patch) : rest;
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

/** A decision taken back: the clause is proposed again (a kept-by-default one stays kept by default). */
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
 * The contract as ② leaves it (the primary action, or « contrat supposé »): decided — every clause kept by
 * default recorded kept under the person's name —, assumed (named), or empty (nothing decided) — recorded empty by a
 * named person too (never anonymously, never by a build).
 */
export const finalize = (contract, status, { name = null, at = new Date().toISOString() } = {}) => {
  if (!nameOk(name)) throw Object.assign(new Error("A contract is decided by a named person."), { code: "ACKNOWLEDGEMENT_UNNAMED" });
  if (status === "empty") return { ...contract, status: "empty", clauses: [], decided_by: name.trim(), decided_at: at };
  const clauses = (contract.clauses || []).map((c) => (c.keep_by_default && !c.decision ? decideClause(c, "keep", { name, at }) : c));
  return { ...contract, status, clauses, decided_by: name.trim(), decided_at: at };
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
// The lists whose order says nothing (a stop_pattern's stops keep theirs), and the kinds' defaults (conformanceService).
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

// An id in brackets in a clause's words: the reading's mark of the spreadsheet objective it reads otherwise
// (utils/briefReading sheetCheckOf asks for it).
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
 * reads a spreadsheet's objective otherwise is kept as a dispute of it (`disputes`: its id; ② asks the person which
 * reading holds, openDisputes): marked against it by the assistant, or about the same thing (the same kind, line,
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

/** What an extraction adds over the contract, as withExtraction merges it (the turn's card counts it). → reconciledClauses */
export const extractionOutcome = (contract, extracted) => reconciledClauses(extracted?.clauses || [], heldThrough(contract, extracted?.extracted || null).own);

/**
 * An extraction's draft contract over the one ② holds: the person's decisions, the kept-by-default clauses, and what
 * no extraction proposed stay — a spreadsheet's clauses read cell by cell (source.cells) and the measured suggestions
 * (source.kind recommendation), decided or not: an extraction only replaces its own earlier proposals — of the
 * documents it read. The earlier proposals of a document read before that this reading was given and could not read
 * (its `left_out`: too long with the others for one message) stay, and a reading of such documents on their own
 * (`partial`: utils/briefReading) keeps every earlier proposal of the documents it was not given, with the earlier
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
 * The spreadsheets' objectives the reading of the brief at ② reads otherwise (`disputes`, reconciledClauses): open
 * while the assistant's reading is undecided and the spreadsheet's objective is not set aside — one question for the
 * person, never two objectives kept side by side by one act. → [{ assistant, sheet }]
 */
export const openDisputes = (contract) => {
  const clauses = contract?.clauses || [];
  const byId = new Map(clauses.map((c) => [c?.id, c]));
  return clauses
    .filter((c) => c?.disputes && !isDecided(c))
    .map((c) => ({ assistant: c, sheet: byId.get(c.disputes) || null }))
    .filter((d) => d.sheet && decisionOf(d.sheet) !== "waive" && d.sheet.status !== "waived");
};

/**
 * A dispute settled under the person's name: "assistant" keeps the assistant's reading and sets the spreadsheet's
 * objective aside (with `reasons.assistant`); "sheet" keeps the spreadsheet's objective (as already decided, or kept
 * now) and sets the assistant's reading aside (with `reasons.sheet`). Never anonymous (decideClause).
 */
export const settleDispute = (contract, dispute, choice, { name, reasons = {}, at = new Date().toISOString() } = {}) => {
  const mine = choice === "assistant";
  return {
    ...contract,
    clauses: (contract?.clauses || []).map((c) => {
      if (c.id === dispute?.assistant?.id) return decideClause(c, mine ? "keep" : "waive", { name, at, reason: mine ? null : reasons.sheet || null });
      if (c.id === dispute?.sheet?.id) return mine ? decideClause(c, "waive", { name, at, reason: reasons.assistant || null }) : isDecided(c) && !c.keep_by_default ? c : decideClause(c, "keep", { name, at });
      return c;
    }),
  };
};

/**
 * Whether a clause was read from a spreadsheet of the brief, cell by cell (no model): the reading marks it
 * (`origin.kind` "sheet": ChangeStudio.readSheet), and the server cites its cell as « file · Sheet!A1 ».
 */
export const fromSheet = (c) => c?.origin?.kind === "sheet" || Array.isArray(c?.source?.cells) || (typeof c?.source === "string" && / · [^·]*![A-Z]+\d+/.test(c.source));

/**
 * The change's « mise en service » on the objectives a spreadsheet gave without a date (a CSV of Sunday trips under
 * titles naming no date, the brief saying « à compter du 4 janvier 2027 »): without it, such an objective is measured
 * from the feed's first Sunday and fails there, before the service starts. `date`: "YYYY-MM-DD"; `textOf(text,
 * date)`: the objective's words with the date said. A decided objective (the person's record), one set aside, or one
 * that states a date or a period of its own is left as it is.
 */
// A clause read from a spreadsheet, whoever read it: the cell reader, or the assistant citing the sheet (departures the
// assistant reads from a CSV carry no date either, and would fail before the start of service).
const SHEET_DOCUMENT = /\.(xlsx|xlsm|xls|ods|csv)$/i;
const fromASheet = (c) => fromSheet(c) || SHEET_DOCUMENT.test(String(c?.document || c?.origin?.document || "").trim());
export const withEffectiveDate = (contract, date, textOf) => {
  if (!contract || !/^\d{4}-\d{2}-\d{2}$/.test(String(date || ""))) return contract;
  let changed = false;
  const clauses = (contract.clauses || []).map((c) => {
    const p = c?.params && typeof c.params === "object" ? c.params : null;
    if (!p || !fromASheet(c) || isDecided(c) || c.status === "waived" || p.from_date || p.to_date || p.derive) return c;
    changed = true;
    return { ...c, params: { ...p, from_date: date }, ...(typeof c.text === "string" && textOf ? { text: textOf(c.text, date) } : {}) };
  });
  return changed ? { ...contract, clauses } : contract;
};

/**
 * The reason a sentence the reading set aside is dismissed with (the coverage's `set_aside`: { kind, why }), in the
 * person's language: « Sans demande au réseau selon l'assistant (titre) : … ».
 */
export const setAsideReasonOf = (sentence, t) => {
  const aside = sentence?.set_aside;
  if (!aside) return null;
  const why = String(aside.why || "").trim();
  return `${t("objectives.setAside.reason", { kind: t(`objectives.setAside.kind.${aside.kind || "other"}`) })}${why ? ` : ${why}` : ""}`;
};

/**
 * « Retenir les objectifs et continuer » in one act (the modify journey's autopilot): every objective
 * proposed and not decided yet is kept under the person's name, and every requirement sentence of the brief that no
 * objective answers is recorded « à vérifier à la main » under that name (a wish quoting it: accepted by name at the
 * delivery unless someone checks it) — never left to hold the way on — but one the reading set aside as asking
 * nothing (`set_aside`: a title, context, today's service), which is dismissed under that name with the reading's
 * reason (`setAsideReason(sentence)`, setAsideReasonOf), as listed apart at ① before the act. What the person set aside
 * stays set aside; a document nobody could read is not a sentence: it stays to acknowledge (the detailed view) —
 * but for a workbook read cell by cell (`documents`), acknowledged here with the reason given. Two readings of the
 * same cells that disagree (openDisputes) are the person's question: neither is kept by the one act (② holds it).
 */
export const acceptAll = (contract, { name, sentences = [], documents = [], documentReason = null, setAsideReason = null, at = new Date().toISOString() } = {}) => {
  if (!nameOk(name)) throw Object.assign(new Error("Objectives are kept by a named person."), { code: "ACKNOWLEDGEMENT_UNNAMED" });
  const disputed = new Set(openDisputes(contract).flatMap((d) => [d.assistant.id, d.sheet.id]));
  const clauses = (contract?.clauses || []).map((c) => (isDecided(c) || disputed.has(c.id) ? c : decideClause(c, "keep", { name, at })));
  // The sentences as the detector last listed them may be a moment old: one the person dismissed since, or already
  // kept « à vérifier à la main » in the same words, is settled — never recorded again behind their decision.
  const dismissed = new Set((contract?.dismissed || []).map((d) => d?.sentence).filter(Boolean));
  const quoted = new Set((contract?.wishes || []).map((w) => String(w?.quote || "").trim()).filter(Boolean));
  const wordsOf = (s) => String(s.text || "").replace(/\s*[.;!?]\s*$/, "").trim();
  const kept = (sentences || [])
    .filter((s) => s && !s.unread && String(s.text || "").trim() && !dismissed.has(s.id) && !quoted.has(wordsOf(s)))
    .reduce((k, s) => (s.set_aside ? dismissSentence(k, s, { name, reason: (setAsideReason && setAsideReason(s)) || "set aside by the reading", at }) : markNotMeasurable(k, s, { name, at })), { ...contract, clauses });
  // `documents`: workbooks the journey read cell by cell whose text version was too long for the sentence search
  // (the detector's « doc:<id> » entries, unread "truncated") — acknowledged under the person's name, with why.
  return (documents || []).filter((d) => d && d.id && !dismissed.has(d.id)).reduce((k, d) => dismissSentence(k, { id: d.id, text: d.text || d.source || d.id }, { name, reason: documentReason, at }), kept);
};

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
 * The contract as a request carries it: what the server reads, nothing of this browser's own bookkeeping. A clause
 * kept by default that nobody decided keeps its mark (`keep_by_default`): the server measures it from the draft on
 * and the verdict lists it as kept by default; a decided one drops it (the decision says it all).
 */
export const contractForServer = (contract) => {
  if (!contract) return null;
  return { ...contract, clauses: (contract.clauses || []).map(({ keep_by_default: k, quote_verified: _q, ...c }) => (k && !c.decision ? { ...c, keep_by_default: true } : c)) };
};

/** Whether a draft carries clauses kept by default (the two « inchangé » clauses): a simulation measures them already. */
export const hasKeptByDefault = (contract) => (contract?.clauses || []).some((c) => c?.keep_by_default && !c.decision);

/**
 * What the brief states about today's network, as the reading recorded and the server measured it
 * (contract.extracted.premises: { id, quote, clause, verdict: holds | false | unknown, measured, expected, choices:
 * [{ action: keep_network | apply_brief, clause }], decision? }). A false premise is the person's question before any
 * change, with no default: nothing proceeds while one is undecided (the server refuses PREMISE_UNDECIDED).
 */
export const premisesOf = (contract) => (Array.isArray(contract?.extracted?.premises) ? contract.extracted.premises.filter((p) => p && p.id) : []);
export const premiseDecided = (p) => Boolean(p?.decision && nameOk(p.decision?.by?.name) && p.decision.action);
export const undecidedPremises = (contract) => premisesOf(contract).filter((p) => p.verdict === "false" && !premiseDecided(p));

/**
 * The person's decision on a false premise, under their name: the premise marked decided, and the clause that answer
 * adds (the server's own, from the premise's choices) kept in the contract as theirs — the plan then has to hold it.
 */
/**
 * The engine's own correction of a clause (`clause.fix`, contract/clauseFixes: the shape of its params calls for it),
 * applied in one act under the person's name: the clause set aside with the reason, its replacement kept — the same
 * kind, level and words, the corrected params, its origin saying which clause it corrects and why. Nothing without a fix.
 */
export const applyFix = (contract, clause, { name, at = new Date().toISOString(), reason = null } = {}) => {
  if (!nameOk(name)) throw Object.assign(new Error("A correction is applied by a named person."), { code: "ACKNOWLEDGEMENT_UNNAMED" });
  const fix = clause?.fix;
  if (!fix || !fix.params || !(contract?.clauses || []).some((c) => c.id === clause.id)) return contract;
  const waived = decideClause(clause, "waive", { name, at, reason: reason || `fix:${fix.code}` });
  const { id: _id, fix: _fix, status: _s, decided_by: _d, decision: _dec, keep_by_default: _k, quote_verified: _q, origin: _o, ...rest } = clause; // eslint-disable-line no-unused-vars
  const withWaive = { ...contract, clauses: (contract.clauses || []).map((c) => (c.id === clause.id ? waived : c)) };
  return addClause(withWaive, { ...rest, params: fix.params, origin: { kind: "fix", of: clause.id, code: fix.code } }, { name, at });
};

/** The points the two readings of the brief differ on (contract.extracted.readings.divergences), each with its two values and the tests each choice adds. */
export const readingsOf = (contract) => (Array.isArray(contract?.extracted?.readings?.divergences) ? contract.extracted.readings.divergences.filter((d) => d && d.id) : []);
export const readingDecided = (d) => Boolean(d?.decision && nameOk(d.decision?.by?.name) && ["A", "B"].includes(d.decision.reading));
export const undecidedReadings = (contract) => readingsOf(contract).filter((d) => !readingDecided(d));

/**
 * The person's choice on a point the two readings differ on, under their name: the divergence decided, the tests that
 * reading adds kept as clauses of the contract (ids of the contract's own). Nothing else changes.
 */
export const decideReading = (contract, divergence, reading, { name, at = new Date().toISOString() } = {}) => {
  if (!nameOk(name)) throw Object.assign(new Error("A reading is chosen by a named person."), { code: "ACKNOWLEDGEMENT_UNNAMED" });
  if (!["A", "B"].includes(reading) || !readingsOf(contract).some((d) => d.id === divergence?.id)) return contract;
  const choice = (divergence.choices || []).find((c) => c && c.reading === reading) || { clauses: [] };
  let out = contract;
  for (const c of choice.clauses || []) {
    const { id: _id, status: _s, decided_by: _d, decision: _dec, ...rest } = c; // eslint-disable-line no-unused-vars
    out = addClause(out, { ...rest, origin: { ...(rest.origin || {}), reading } }, { name, at });
  }
  const divergences = readingsOf(contract).map((d) => (d.id === divergence.id ? { ...d, decision: { by: { name }, at, reading } } : d));
  return { ...out, extracted: { ...(out.extracted || {}), readings: { ...(out.extracted?.readings || {}), divergences } } };
};

export const decidePremise = (contract, premise, action, { name, at = new Date().toISOString() } = {}) => {
  if (!nameOk(name)) throw Object.assign(new Error("A premise is decided by a named person."), { code: "ACKNOWLEDGEMENT_UNNAMED" });
  const choice = (premise?.choices || []).find((c) => c && c.action === action && c.clause);
  if (!choice) return contract;
  const premises = premisesOf(contract).map((p) => (p.id === premise.id ? { ...p, decision: { by: { name }, at, action } } : p));
  // The clause takes an id of the contract's own (the server named it after the premise), kept under the person's name.
  const { id: _premiseId, ...clause } = choice.clause; // eslint-disable-line no-unused-vars
  const withClause = addClause(contract, clause, { name, at });
  return { ...withClause, extracted: { ...(withClause.extracted || {}), premises } };
};
