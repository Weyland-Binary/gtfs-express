/**
 * One clause of the judge measured on the working copy against the feed before the change: the instrument the agent
 * checks its work with and the reviewer proves a demand with. The answer is the judge's, never an interpretation.
 * `fetchImpl` is the calendar service a caller freezes (an evaluation world).
 */

"use strict";

const judge = require("../judge");
const { buildFeedModel } = require("../transform/feedModel");

const clip = (s, n) => (typeof s === "string" && s.length > n ? `${s.slice(0, n)}…` : s);
const show = (v) => (v == null ? "—" : typeof v === "string" ? v : JSON.stringify(v));

/** The validity both feeds cover together, as the engine measures a plan's clauses on it. */
const spanOf = (before, after) => ({
  from: [before.range?.start, after.range?.start].filter(Boolean).sort()[0] || null,
  to: [before.range?.end, after.range?.end].filter(Boolean).sort().pop() || null,
});

const measureClause = async ({ before, after, clause, country = null, region = null, today = null, fetchImpl = null }) => {
  const c = judge.normalizeClause({ id: "m1", level: "must", status: "stated", ...clause });
  if (!c || !judge.KINDS.includes(c.kind)) return { status: "unknown", expected: null, measured: null, note: `unknown kind: ${clip(String(clause?.kind || ""), 40)} (one of ${judge.KINDS.join(", ")})` };
  const { checkFeedConformance, resolveClausePeriods, resolvePublicHolidays } = require("../transform/feedView");
  const span = spanOf(before, after);
  const requirements = { clauses: [c] };
  const periods = await resolveClausePeriods(requirements, { country, region, from: span.from, to: span.to, fetchImpl });
  const publicHolidays = judge.TIME_KINDS.includes(c.kind) ? await resolvePublicHolidays({ country, from: span.from, to: span.to, fetchImpl }) : null;
  const out = checkFeedConformance(after, requirements, { periods, today, publicHolidays, baseline: before });
  const r = out?.results?.[0];
  if (!r) return { status: "unknown", expected: null, measured: null, note: "nothing to measure" };
  return { status: r.status, expected: r.expected ?? null, measured: r.measured ?? null, note: r.note ?? null };
};

const DEFINITION = () => ({
  name: "measure",
  description: `Measure ONE clause on the feed as it now stands, against the feed before the change (the judge's own measure: every distinct timetable of the clause's dates; the relational kinds compare with the feed before). Answers status pass | fail | unknown, what was expected and measured, and a note. Lines and stops are named as the feed names them; dates YYYY-MM-DD; an undated clause is measured over the whole validity from today. The kinds and their params:\n${judge.kindsText()}`,
  input_schema: {
    type: "object",
    properties: {
      kind: { type: "string", enum: judge.KINDS },
      params: { type: "object", description: "the kind's params, as listed" },
      text: { type: "string", description: "what this measures, in a few words of the person's language" },
    },
    required: ["kind", "params"],
  },
});

const measureTool = ({ copy, country = null, region = null, today = null, fetchImpl = null, onUse = () => {} }) => {
  let beforeModel = null;
  return {
    definition: DEFINITION(),
    async run(input = {}) {
      onUse(input);
      if (!input || typeof input.kind !== "string" || !input.params || typeof input.params !== "object") return { content: "kind and params are required.", isError: true };
      try {
        if (!beforeModel) beforeModel = buildFeedModel(copy.before());
        const m = await measureClause({ before: beforeModel, after: copy.model(), clause: { kind: input.kind, params: input.params, text: typeof input.text === "string" ? input.text : undefined }, country, region, today, fetchImpl });
        return { content: `${m.status}: expected ${clip(show(m.expected), 600)}; measured ${clip(show(m.measured), 1200)}${m.note ? `; note: ${clip(show(m.note), 600)}` : ""}` };
      } catch (err) {
        return { content: `The measure failed: ${err.message}`, isError: true };
      }
    },
  };
};

module.exports = { measureTool, measureClause, _internals: { spanOf } };
