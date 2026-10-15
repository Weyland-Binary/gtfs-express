/**
 * conversation — the planner's turns of a modify project, kept with the
 * project (`context.conversation`) so that what the assistant said comes back
 * when the project is opened again (another day, another browser, a reload):
 * its explanations, its questions, the person's answers, the engine's verdict
 * on each turn. Held only in the studio's memory, they would be gone on
 * reopening, and a person could reach the delivery without the assistant's
 * warning that the failures it showed were measurement errors.
 *
 * Bounded in BYTES (UTF-8, as the server and the browser's storage count
 * them): the server keeps a whole project up to 900 KB (workspaceStore
 * MAX_PROJECT_BYTES), this browser caches up to 50 projects in one storage of
 * a few MB (utils/projectStore: a write the storage refuses drops the whole
 * update, plan and contract included), and a project's plan, offer and
 * contract come first. The newest turns are kept within MAX_CONVERSATION_BYTES
 * (or less: conversationBudget leaves a project near its limit the room it
 * has, and none at all past it) and MAX_CONVERSATION_TURNS entries. The newest
 * turn is kept at the first of LEVELS that fits — its text, its questions and
 * its verdict's rows shorter at each level —, the older ones at the first
 * level, as many as fit after it; a conversation whose newest turn fits at no
 * level is not kept (null: the studio says so). Each text within the
 * planner's own bound on a message of its history (8000 characters,
 * transformPlannerService). The verdict as the card of the turn reads it
 * (common/VerdictCard): its counts whole — the lists the card only counts
 * are kept as their count and given back as lists of that length —, its rows
 * bounded, the rows cut counted (`failing_more`, `unknown_more`: said under
 * the card), its gate reduced to what the card says, the struck spans that
 * still fall inside the text. The
 * older turns left out are counted on the
 * first one kept (`earlier`), said where the conversation starts — never
 * dropped unsaid. Nothing is streaming or pending in what is kept.
 *
 *   keptConversation(turns, { maxBytes? }) → { turns } | null: what the project keeps
 *   restoredTurns(kept)                    → the turns as the studio holds them again
 *   keptConversation(restoredTurns(kept)) equals `kept`: reopening writes nothing.
 *   conversationBudget(project)            → the bytes the project has room for
 *   utf8Length(text)                       → the bytes of a text in UTF-8
 */

// The newest turns, within this many bytes of JSON (an exchange with its verdict weighs a few thousand)…
export const MAX_CONVERSATION_BYTES = 24000;
// …and at most this many entries (a message and its answer are two; the planner reads the last 20 again).
export const MAX_CONVERSATION_TURNS = 40;
// A project as the server keeps it at most (workspaceStore MAX_PROJECT_BYTES), and what its plan, offer and contract
// may still grow by before the conversation gives them its room.
const PROJECT_BYTES = 900 * 1024;
const PROJECT_MARGIN = 64 * 1024;
// A list the card only counts, given back with at most this many entries (a count past it is no count of a brief).
const COUNT_MAX = 100000;

/**
 * The bounds of one kept turn, from the first level to the last: a message as the planner reads it again (8000
 * characters), the corrected words of the turn (llm/selfCorrection), its chips, its questions (the planner asks at
 * most 12 a turn) and their options, the verdict's rows and their words, the struck spans.
 */
const LEVELS = [
  { text: 8000, superseded: 3, supersededText: 2000, steps: 20, questions: 12, questionText: 1500, options: 12, optionText: 300, rows: 20, rowText: 240, spans: 40, corrections: 20, correctionParams: 2000 },
  { text: 3000, superseded: 1, supersededText: 600, steps: 10, questions: 6, questionText: 600, options: 8, optionText: 120, rows: 8, rowText: 160, spans: 20, corrections: 8, correctionParams: 1000 },
  { text: 1000, superseded: 0, supersededText: 0, steps: 5, questions: 3, questionText: 300, options: 4, optionText: 80, rows: 3, rowText: 120, spans: 10, corrections: 3, correctionParams: 600 },
];
// A correction's words as the server wrote them (an objective's words: 200 characters and « … » at most): kept whole
// below this many, else left out.
const CORRECTION_TEXT = 240;
const CORRECTION_REASON = 400;

/** The bytes of a text in UTF-8 (a pair of surrogates is one character of four bytes). */
export const utf8Length = (text) => {
  const s = String(text ?? "");
  let n = 0;
  for (let i = 0; i < s.length; i += 1) {
    const c = s.charCodeAt(i);
    if (c < 0x80) n += 1;
    else if (c < 0x800) n += 2;
    else if (c >= 0xd800 && c <= 0xdbff && i + 1 < s.length && (s.charCodeAt(i + 1) & 0xfc00) === 0xdc00) {
      n += 4;
      i += 1;
    } else n += 3;
  }
  return n;
};
const bytesOf = (value) => utf8Length(JSON.stringify(value));

/**
 * The bytes a project has room for in its conversation: MAX_CONVERSATION_BYTES, or what is left below the server's
 * bound once the rest of the project and its margin are counted — none past it (the conversation goes first).
 */
export const conversationBudget = (project) => {
  if (!project) return MAX_CONVERSATION_BYTES;
  const { conversation: _gone, ...context } = project.context || {}; // eslint-disable-line no-unused-vars
  const rest = bytesOf({ ...project, context });
  return Math.max(0, Math.min(MAX_CONVERSATION_BYTES, PROJECT_BYTES - PROJECT_MARGIN - rest));
};

const clip = (value, max) => {
  const s = String(value ?? "");
  return s.length > max ? `${s.slice(0, Math.max(0, max - 1))}…` : s;
};
const count = (v) => (Number.isFinite(Number(v)) ? Number(v) : 0);
// A value the card prints as it is (a figure, a word): numbers and booleans kept, words bounded.
const scalar = (v, max) => (v == null ? null : typeof v === "number" || typeof v === "boolean" ? v : clip(typeof v === "string" ? v : JSON.stringify(v), max));
const listOf = (x) => (Array.isArray(x) ? x.filter((v) => v != null) : []);
// A list the card only counts, given back as that many entries.
const counted = (n) => Array.from({ length: Math.min(count(n), COUNT_MAX) }, () => 0);

const tally = (x) => (x && typeof x === "object" ? { total: count(x.total), pass: count(x.pass), fail: count(x.fail), unknown: count(x.unknown) } : null);

/** The verdict of a turn as its card reads it (services/verdict.verdictOf's fields), bounded at `L`. */
const keptVerdictBody = (v, L) => {
  if (!v || typeof v !== "object") return null;
  const cov = v.coverage && typeof v.coverage === "object" ? v.coverage : null;
  const failing = listOf(v.failing);
  const unknown = listOf(v.unknown);
  // The rows cut, with the ones a kept copy had cut already: counted under the card.
  const failingMore = count(v.failing_more) + Math.max(0, failing.length - L.rows);
  const unknownMore = count(v.unknown_more) + Math.max(0, unknown.length - L.rows);
  return {
    conforms: Boolean(v.conforms),
    must: tally(v.must),
    should: tally(v.should),
    // The objectives apart from the default guarantees (the turn's card says the page's split only when it is this one).
    ...(v.objectives && typeof v.objectives === "object" ? { objectives: tally(v.objectives) } : {}),
    failing: failing.slice(0, L.rows).map((c) => ({ id: clip(c.id, 120), kind: scalar(c.kind, 60), text: scalar(c.text, L.rowText), expected: scalar(c.expected, 120), measured: scalar(c.measured, L.rowText) })),
    ...(failingMore ? { failing_more: failingMore } : {}),
    unknown: unknown.slice(0, L.rows).map((c) => ({ id: clip(c.id, 120), kind: scalar(c.kind, 60), text: scalar(c.text, L.rowText), note: scalar(c.note, L.rowText) })),
    ...(unknownMore ? { unknown_more: unknownMore } : {}),
    waived: count(v.waived),
    deliverable: typeof v.deliverable === "boolean" ? v.deliverable : null,
    ...(Array.isArray(v.not_deliverable) ? { not_deliverable: v.not_deliverable.slice(0, 10).map((r) => clip(r, 60)) } : {}),
    ...(cov
      ? {
          coverage: {
            sentences: count(cov.sentences),
            covered: count(cov.covered),
            not_measurable: count(cov.not_measurable),
            dismissed: count(cov.dismissed),
            // The card counts the sentences no clause answers: their count is kept.
            uncovered_count: listOf(cov.uncovered).length,
            ...(listOf(cov.unread).length ? { unread: listOf(cov.unread).slice(0, 20).map((u) => ({ id: clip(u?.id ?? "", 80), name: scalar(u?.name, 200), ...(u?.acknowledged_by ? { acknowledged_by: scalar(u.acknowledged_by?.name ?? u.acknowledged_by, 120) } : {}) })) } : {}),
            gated: Boolean(cov.gated),
          },
        }
      : {}),
    ...(v.contract && typeof v.contract === "object"
      ? { contract: { status: scalar(v.contract.status, 20), ...(v.contract.uncovered != null ? { uncovered: count(v.contract.uncovered) } : {}), ...(listOf(v.contract.kept_by_default).length ? { kept_by_default: listOf(v.contract.kept_by_default).slice(0, 10).map((c) => ({ id: clip(c.id, 120), text: scalar(c.text, 240) })) } : {}) } }
      : {}),
    ...(v.over_plan_limit ? { over_plan_limit: { count: count(v.over_plan_limit.count), max: count(v.over_plan_limit.max) } } : {}),
    checked_at: scalar(v.checked_at, 40),
  };
};

/** The gate of a turn's simulation as the card says it: the validator's run, deliverable or why not (counts kept). */
const keptGate = (g) =>
  g && typeof g === "object"
    ? {
        validation: scalar(g.validation, 20),
        can_commit: Boolean(g.can_commit),
        ...(typeof g.deliverable === "boolean" ? { deliverable: g.deliverable } : {}),
        // The card reads the first blocking reason and counts its errors or its sentences: their counts are kept.
        blocking: listOf(g.blocking)
          .slice(0, 20)
          .map((b) => ({ code: clip(b?.code, 60), ...(Array.isArray(b?.new_errors) ? { new_errors_count: b.new_errors.length } : {}), ...(Array.isArray(b?.sentences) ? { sentences_count: b.sentences.length } : {}) })),
        acknowledgeable: listOf(g.acknowledgeable)
          .slice(0, 20)
          .map((a) => ({ code: clip(a?.code, 60) })),
      }
    : null;

/**
 * The `verdict` event of a turn ({ verdict, gate, prose }) as kept: the struck spans only where the kept text still
 * holds them (`within`: its length once cut), their words as they are — the card finds them by those words.
 */
const keptVerdict = (payload, within, L) => {
  if (!payload || typeof payload !== "object") return null;
  const prose = payload.prose && typeof payload.prose === "object" ? payload.prose : null;
  return {
    verdict: keptVerdictBody(payload.verdict, L),
    ...(payload.gate ? { gate: keptGate(payload.gate) } : {}),
    prose: prose
      ? {
          claims_all_met: Boolean(prose.claims_all_met),
          wrong_count: Boolean(prose.wrong_count),
          contradicts: Boolean(prose.contradicts),
          spans: listOf(prose.spans)
            .filter((s) => Number.isInteger(s.start) && Number.isInteger(s.end) && s.end <= within && typeof s.text === "string")
            .slice(0, L.spans)
            .map((s) => ({ start: s.start, end: s.end, text: s.text, reason: clip(s.reason, 40) })),
        }
      : null,
  };
};

// The chips of a turn (the plan written, the ridership estimate…): their kind and their figures.
const STEP_FIELDS = ["count", "attempt", "max", "attempts", "trips", "calibrated", "uncertainty"];
const keptStep = (s) => (s && typeof s === "object" && s.kind ? { kind: clip(s.kind, 40), ...Object.fromEntries(STEP_FIELDS.filter((k) => s[k] != null).map((k) => [k, scalar(s[k], 40)])) } : null);

// A question of the turn: its words, its options, what it answers (the engine's operation and parameter) and the
// person's answer once given (`answer`).
const QUESTION_FIELDS = ["id", "operation", "param", "origin"];
const keptQuestion = (q, L) =>
  q && typeof q === "object"
    ? {
        ...Object.fromEntries(QUESTION_FIELDS.filter((k) => q[k] != null).map((k) => [k, clip(q[k], 120)])),
        text: clip(q.text, L.questionText),
        options: listOf(q.options)
          .slice(0, L.options)
          .map((o) => clip(o, L.optionText)),
        ...(q.default != null ? { default: clip(q.default, L.optionText) } : {}),
        ...(q.answer != null ? { answer: clip(q.answer, L.optionText) } : {}),
      }
    : null;

// The summary of a reading of the brief (the extraction turn's card): its counts, the documents it could not read.
const keptExtracted = (x) => ({
  clauses: count(x.clauses),
  wishes: count(x.wishes),
  uncovered: count(x.uncovered),
  ...(x.checked ? { checked: count(x.checked) } : {}),
  ...(x.disputed ? { disputed: count(x.disputed) } : {}),
  ...(listOf(x.left).length ? { left: listOf(x.left).slice(0, 5).map((n) => clip(n, 160)) } : {}),
});


/** One turn as kept at the level `L`: a message of the person (or the journey's own brief), or the assistant's answer. */
const keptTurn = (turn, L) => {
  const raw = String(turn.text ?? "");
  const text = clip(raw, L.text);
  const head = { role: turn.role, text, ...(turn.auto ? { auto: true } : {}) };
  if (turn.role === "user") return head;
  return {
    ...head,
    steps: listOf(turn.steps).slice(-L.steps).map(keptStep).filter(Boolean),
    questions: listOf(turn.questions)
      .slice(0, L.questions)
      .map((q) => keptQuestion(q, L))
      .filter(Boolean),
    ...(turn.extracted && typeof turn.extracted === "object" ? { extracted: keptExtracted(turn.extracted) } : {}),
    ...(turn.verdict ? { verdict: keptVerdict(turn.verdict, raw.length > L.text ? L.text - 1 : raw.length, L) } : {}),
    ...(listOf(turn.superseded).length && L.superseded ? { superseded: listOf(turn.superseded).slice(-L.superseded).map((x) => clip(x, L.supersededText)) } : {}),
    ...(turn.error ? { error: clip(turn.error, 500) } : {}),
    ...(turn.trial ? { trial: true } : {}),
    ...(turn.done ? { done: true } : {}),
  };
};

// What the wrapper and the first kept turn's count of the earlier ones weigh beside the turns.
const WRAPPER_BYTES = 48;

/**
 * What the project keeps of the conversation: the newest turns within the bounds above, the first one kept counting
 * the earlier ones left out (`earlier`, those the turns held already included). Null when there is nothing to keep,
 * or when the newest turn fits at no level within `maxBytes`.
 */
export const keptConversation = (turns, { maxBytes = MAX_CONVERSATION_BYTES } = {}) => {
  const list = (Array.isArray(turns) ? turns : []).filter((x) => x && (x.role === "user" || x.role === "assistant"));
  if (!list.length) return null;
  const before = count(list.find((x) => Number(x.earlier) > 0)?.earlier);
  const room = maxBytes - WRAPPER_BYTES;
  const kept = [];
  let size = 0;
  for (let i = list.length - 1; i >= 0 && kept.length < MAX_CONVERSATION_TURNS; i -= 1) {
    // The newest turn at the first level that fits, the older ones at the first level only, as many as fit after it.
    const levels = kept.length ? LEVELS.slice(0, 1) : LEVELS;
    let turn = null;
    for (const L of levels) {
      const candidate = keptTurn(list[i], L);
      if (size + bytesOf(candidate) + 1 <= room) {
        turn = candidate;
        break;
      }
    }
    if (!turn) break;
    kept.unshift(turn);
    size += bytesOf(turn) + 1;
  }
  if (!kept.length) return null;
  const earlier = before + list.length - kept.length;
  if (earlier > 0) kept[0] = { ...kept[0], earlier };
  return { turns: kept };
};

/** A kept verdict as the card reads it again: the lists it counts given back at their length. */
const restoredVerdict = (payload) => {
  const v = payload?.verdict;
  if (!v || typeof v !== "object") return payload;
  const cov = v.coverage && typeof v.coverage === "object" ? { ...v.coverage, uncovered: counted(v.coverage.uncovered_count ?? listOf(v.coverage.uncovered).length) } : v.coverage;
  const gate = payload.gate && typeof payload.gate === "object" ? { ...payload.gate, blocking: listOf(payload.gate.blocking).map((b) => ({ ...b, ...(b.new_errors_count != null ? { new_errors: counted(b.new_errors_count) } : {}), ...(b.sentences_count != null ? { sentences: counted(b.sentences_count) } : {}) })) } : payload.gate;
  return { ...payload, verdict: { ...v, failing: listOf(v.failing), unknown: listOf(v.unknown), ...(cov ? { coverage: cov } : {}) }, ...(gate ? { gate } : {}) };
};

/** The turns as the studio holds them, from what the project kept: nothing pending, every list there. */
export const restoredTurns = (kept) =>
  listOf(kept?.turns)
    .filter((x) => x.role === "user" || x.role === "assistant")
    .map((x) => (x.role === "user" ? { ...x, text: String(x.text ?? "") } : { ...x, text: String(x.text ?? ""), steps: listOf(x.steps), questions: listOf(x.questions), pending: null, ...(x.verdict ? { verdict: restoredVerdict(x.verdict) } : {}) }));
