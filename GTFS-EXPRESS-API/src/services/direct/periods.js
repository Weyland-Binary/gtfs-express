/**
 * direct/periods — the dates of a named period (school holidays, school days, public holidays), which GTFS does not
 * hold: what the agent dates a change with and the reviewer checks one against. The same resolution as the judge's
 * `period` (transform/calendars.named: the country's public holidays, its school holidays by zone), over the feed's
 * validity unless the caller bounds it.
 *
 *   periodDatesTool({ copy, country, region, fetchImpl, onUse }) → { definition, run(input) → { content, isError? } }
 *   rangesOf(dates)  → [{ from, to, days }] (YYYYMMDD, consecutive dates folded)
 *
 * The answer is the calendar service's, never a guess: a period it cannot resolve (no country, an unknown zone, the
 * service unreachable) is said with its reason and, for a zone, the zones it knows.
 */

"use strict";

const PERIODS = ["school_holidays", "school_days", "public_holidays"];
const ISO = /^(\d{4})-(\d{2})-(\d{2})$/;
const ymd = (s) => (typeof s === "string" && ISO.test(s) ? s.replace(/-/g, "") : null);
const nextDay = (d) => {
  const t = new Date(Date.UTC(+d.slice(0, 4), +d.slice(4, 6) - 1, +d.slice(6, 8) + 1));
  return `${t.getUTCFullYear()}${String(t.getUTCMonth() + 1).padStart(2, "0")}${String(t.getUTCDate()).padStart(2, "0")}`;
};

/** Consecutive dates folded into ranges, in order. */
const rangesOf = (dates) => {
  const out = [];
  for (const d of [...dates].sort()) {
    const last = out[out.length - 1];
    if (last && nextDay(last.to) === d) {
      last.to = d;
      last.days += 1;
    } else out.push({ from: d, to: d, days: 1 });
  }
  return out;
};

const DEFINITION = {
  name: "period_dates",
  description: "The dates of a named period, which the feed does not hold: school_holidays (by school zone), school_days (the validity's dates outside school and public holidays) or public_holidays, of the network's country. Answers the dates as ranges (YYYYMMDD, both ends included). By default over the feed's validity; from / to (YYYY-MM-DD) bound it; region names a school zone other than the session's (France: « A », « B », « C », « Corse »…).",
  input_schema: {
    type: "object",
    properties: {
      period: { type: "string", enum: PERIODS },
      region: { type: "string", description: "a school zone, when the brief names one" },
      from: { type: "string", description: "YYYY-MM-DD" },
      to: { type: "string", description: "YYYY-MM-DD" },
    },
    required: ["period"],
  },
};

const periodDatesTool = ({ copy, country = null, region = null, fetchImpl = null, onUse = () => {} }) => ({
  definition: DEFINITION,
  async run(input = {}) {
    onUse(input);
    const period = PERIODS.includes(input.period) ? input.period : null;
    if (!period) return { content: `period is one of ${PERIODS.join(", ")}.`, isError: true };
    if ((input.from && !ymd(input.from)) || (input.to && !ymd(input.to))) return { content: "from and to are dates YYYY-MM-DD.", isError: true };
    const range = copy.model().range || {};
    const from = ymd(input.from) || range.start || null;
    const to = ymd(input.to) || range.end || null;
    if (!from || !to) return { content: "The feed has no validity: give from and to.", isError: true };
    if (to < from) return { content: "to is before from.", isError: true };
    const zone = typeof input.region === "string" && input.region.trim() ? input.region.trim() : region;
    try {
      const n = await require("../transform/calendars").named(period, { country, region: zone, from, to, fetchImpl });
      if (n.ambiguity) return { content: `Not resolved: ${n.ambiguity.message}${n.ambiguity.options?.length ? ` (known: ${n.ambiguity.options.join(", ")})` : ""}`, isError: true };
      const ranges = rangesOf(n.dates);
      const total = ranges.reduce((s, r) => s + r.days, 0);
      const shown = ranges.slice(0, 80).map((r) => (r.days === 1 ? r.from : `${r.from}–${r.to} (${r.days} days)`));
      return { content: `${n.label} from ${from} to ${to}: ${total} dates${ranges.length ? `: ${shown.join(", ")}${ranges.length > 80 ? `, … ${ranges.length - 80} more ranges` : ""}` : ""}.${n.warning ? ` ${n.warning}` : ""}` };
    } catch (err) {
      return { content: `The calendar could not be read: ${err.message}`, isError: true };
    }
  },
});

module.exports = { periodDatesTool, rangesOf, PERIODS };
