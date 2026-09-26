/**
 * dataNeedsService — what the system needs from the user to design well,
 * and what each missing piece costs.
 *
 *   computeNeeds({ spec, requirements, territory, quality, maxLines })
 *     → { needs: [{ id, impact, state, params, action }], counts }
 *   serviceLevers(spec, { geometry, country })
 *     → the fleet and yearly cost of the plan as it is, and with a peak
 *       headway of 10 / 15 / 20 min, without Saturday or Sunday service
 *
 * A need is `missing` (nothing to go on), `defaulted` (the system assumed a
 * value the user never gave), `unconfirmed` (given by the assistant, never
 * confirmed by the user) or `provided`. Its impact says how much the
 * network changes with it: `high` blocks a trustworthy result, `medium`
 * changes the design materially, `low` refines it. `action` names where
 * the user answers it (settings, territory, brief, map, trips).
 *
 * Deterministic and cheap: the Studio shows it live, the planner reads it
 * to ask only what matters, with the stakes in figures.
 */

"use strict";

const { estimateOperations } = require("./operationsService");
const { clausesOf } = require("./conformanceService");
const { _internals: specInternals } = require("./networkSpec");

const { timeToSec } = specInternals;
const IMPACT_ORDER = { high: 0, medium: 1, low: 2 };
const isSchoolOrShuttle = (l) => l.mode === "shuttle" || /scol|school|navette|shuttle/i.test(`${l.short_name} ${l.long_name || ""}`);

const need = (id, impact, state, params = {}, action = null) => ({ id, impact, state, params, ...(action ? { action } : {}) });

const computeNeeds = ({ spec = null, requirements = null, territory = null, quality = null, maxLines = null } = {}) => {
  const out = [];
  const agency = spec?.agency || {};
  const clauses = clausesOf(requirements);
  const kinds = new Set(clauses.filter((c) => c.status !== "waived").map((c) => c.kind));
  const lines = spec?.lines || [];

  // Where: the territory grounds everything (stops, places, residents, holidays).
  if (!territory) out.push(need("territory", "high", "missing", {}, "territory"));
  else {
    if (territory.partial) out.push(need("territory_partial", "medium", "defaulted", { gaps: (territory.warnings || []).slice(0, 4) }, "territory"));
    if (territory.population_grid?.estimated) out.push(need("population", "medium", "defaulted", { density: 4000 }, "brief"));
  }

  // What: the brief as clauses the plan is measured against.
  if (!clauses.length) out.push(need("brief", "high", "missing", {}, "brief"));
  else {
    const confirmed = clauses.filter((c) => c.decided_by === "user").length;
    if (!confirmed) out.push(need("brief_confirm", "medium", "unconfirmed", { count: clauses.length }, "brief"));
  }
  const assumed = (requirements?.assumptions || []).filter((a) => a.confidence !== "high");
  if (assumed.length) out.push(need("assumptions", "medium", "unconfirmed", { count: assumed.length, topics: assumed.slice(0, 5).map((a) => a.topic) }, "brief"));
  const highQuestions = (requirements?.open_questions || []).filter((q) => q.impact === "high");
  if (highQuestions.length) out.push(need("questions", "high", "missing", { count: highQuestions.length }, "brief"));

  // Who runs it: GTFS requires the operator's name, website and timezone.
  const identity = ["name", "url", "timezone"].filter((k) => !String(agency[k] || "").trim());
  if (identity.length) out.push(need("operator", "high", "missing", { fields: identity }, "settings"));
  else if (/example/i.test(agency.url || "")) out.push(need("operator_url", "low", "defaulted", { url: agency.url }, "settings"));

  // When: validity, holidays, school periods.
  // Dates left out: the compiler takes today → +1 year.
  if (spec && lines.length && !(spec.feed?.start_date && spec.feed?.end_date)) out.push(need("validity", "low", "defaulted", {}, "settings"));
  if ((territory?.holidays || []).length && !(spec?.holidays || []).length) out.push(need("holidays", "medium", "missing", { count: territory.holidays.length }, "settings"));
  const regional = (territory?.school_holidays || []).some((h) => !h.nationwide);
  if (regional && lines.some(isSchoolOrShuttle) && !requirements?.school_zone) out.push(need("school_zone", "medium", "missing", {}, "brief"));

  // How much: service level, caps, costs.
  if (lines.length && !kinds.has("headway_max") && !kinds.has("span")) out.push(need("service_level", "medium", "defaulted", {}, "brief"));
  const ops = spec?.operations || {};
  const operations = quality?.operations || null;
  if (lines.length && !kinds.has("fleet_max") && !kinds.has("budget_max") && ops.max_vehicles == null && ops.max_cost_year == null) {
    out.push(need("caps", "medium", "missing", operations ? { fleet: operations.fleet_total, cost_year: operations.cost_year, currency: operations.currency } : {}, "settings"));
  }
  if (lines.length && ops.cost_per_km == null && operations) out.push(need("costs", "low", "defaulted", { basis: operations.assumptions?.cost_basis || null, currency: operations.currency }, "settings"));

  // For whom: the trips that matter, the places that must be served.
  if (lines.length && !kinds.has("od_max_time")) out.push(need("typical_trips", "medium", "missing", {}, "brief"));
  if ((territory?.existing_lines || []).length && !(requirements?.constraints || []).some((c) => /exist|conserv|keep|garder|maintenir/i.test(c))) out.push(need("existing_network", "low", "missing", { count: territory.existing_lines.length }, "brief"));

  // Where exactly: stops the plan cannot place, clauses it cannot measure.
  const unlocated = (spec?.stops || []).filter((s) => s.lat == null).length;
  if (unlocated) out.push(need("stops_unlocated", "high", "missing", { count: unlocated }, "map"));
  const unknown = (quality?.conformance?.results || []).filter((r) => r.status === "unknown" && r.level === "must");
  if (unknown.length) out.push(need("clauses_unmeasurable", "medium", "missing", { count: unknown.length, ids: unknown.slice(0, 5).map((r) => r.id) }, "brief"));

  if (Number.isFinite(maxLines) && lines.length > maxLines) out.push(need("plan_limit", "high", "missing", { count: lines.length, max: maxLines }, "plan"));

  out.sort((a, b) => IMPACT_ORDER[a.impact] - IMPACT_ORDER[b.impact]);
  const counts = { high: out.filter((n) => n.impact === "high").length, medium: out.filter((n) => n.impact === "medium").length, low: out.filter((n) => n.impact === "low").length };
  return { needs: out, counts };
};

/** One block for the planner: what is missing, by impact. */
const summarizeNeeds = (r) => {
  if (!r || !r.needs.length) return "Inputs: nothing important is missing.";
  const items = r.needs.filter((n) => n.impact !== "low").map((n) => `${n.id} (${n.impact}, ${n.state}${Object.keys(n.params).length ? ` ${JSON.stringify(n.params)}` : ""})`);
  return `Inputs missing or assumed (${r.counts.high} high, ${r.counts.medium} medium): ${items.join("; ") || "only low-impact ones"}. Ask only the high ones with ask_user (use service_levers to put figures on fleet, budget and frequency questions); list the rest as assumptions.`;
};

// ── Levers: what a choice costs ────────────────────────────────────────────

const PEAKS = [
  [7 * 3600, 9 * 3600],
  [16.5 * 3600, 19 * 3600],
];
const overlapsPeak = (p) => {
  const a = timeToSec(p.from);
  const b = timeToSec(p.to);
  return PEAKS.some(([x, y]) => a < y && b > x);
};

const withPeakHeadway = (spec, minutes) => ({
  ...spec,
  lines: spec.lines.map((l) => (isSchoolOrShuttle(l) ? l : { ...l, services: l.services.map((s) => ({ ...s, periods: (s.periods || []).map((p) => (overlapsPeak(p) ? { ...p, headway_min: minutes } : p)) })) })),
});
const without = (spec, day) => {
  const cal = new Map((spec.calendars || []).map((c) => [c.id, c]));
  return { ...spec, lines: spec.lines.map((l) => ({ ...l, services: l.services.filter((s) => !(cal.get(s.calendar_id)?.days || []).every((d) => d === day)) })) };
};

/**
 * The fleet and yearly cost of the plan and of its main variants, so a
 * question ("10 or 15 minutes at peak?") comes with its price.
 */
const serviceLevers = (spec, { geometry = null, country = null } = {}) => {
  if (!spec || !(spec.lines || []).length) return null;
  const run = (s) => {
    try {
      const o = estimateOperations(s, geometry, { country });
      return { fleet: o.fleet_total, cost_year: o.cost_year, veh_km_year: o.veh_km_year };
    } catch {
      return null;
    }
  };
  const base = run(spec);
  if (!base) return null;
  const variants = [];
  const add = (id, params, s) => {
    const r = run(s);
    if (r) variants.push({ id, params, ...r, delta_fleet: r.fleet - base.fleet, delta_cost: Math.round(r.cost_year - base.cost_year) });
  };
  for (const m of [10, 15, 20]) add("peak_headway", { minutes: m }, withPeakHeadway(spec, m));
  add("no_saturday", {}, without(spec, "sat"));
  add("no_sunday", {}, without(spec, "sun"));
  const currency = (() => {
    try {
      return estimateOperations(spec, geometry, { country }).currency;
    } catch {
      return "EUR";
    }
  })();
  return { currency, base, variants };
};

const summarizeLevers = (l) => {
  if (!l) return "No lever: the plan has no line yet.";
  const money = (v) => `${Math.round(v).toLocaleString("en")} ${l.currency}`;
  const lines = [`As planned: ${l.base.fleet} vehicle(s) at peak, ${money(l.base.cost_year)}/year.`];
  for (const v of l.variants) {
    const what = v.id === "peak_headway" ? `Peak every ${v.params.minutes} min` : v.id === "no_saturday" ? "No Saturday service" : "No Sunday service";
    lines.push(`- ${what}: ${v.fleet} vehicle(s) (${v.delta_fleet >= 0 ? "+" : ""}${v.delta_fleet}), ${money(v.cost_year)}/year (${v.delta_cost >= 0 ? "+" : ""}${money(v.delta_cost)}).`);
  }
  return lines.join("\n");
};

module.exports = { computeNeeds, summarizeNeeds, serviceLevers, summarizeLevers, _internals: { withPeakHeadway, without } };
