/**
 * plannerDemandTools — the network planner's demand tools, part of
 * networkPlannerService's tool set:
 *
 *   estimate_demand      the current spec's ridership ESTIMATE and KPIs on the
 *                        territory (emits "demand")
 *   optimize_service     its frequencies optimised (ridership | balanced | cost,
 *                        fleet / budget caps, the brief's clauses kept); the
 *                        optimised spec is adopted like set_spec (emits "spec")
 *   generate_scenarios   three contrasted networks and their comparison (emits
 *                        "scenarios"; the current spec is not replaced)
 *   adopt_scenario       a generated scenario becomes the current spec
 *
 *   createDemandTools(ctx, deps) → { definitions, byName }
 *
 * ctx is the planner's turn context (spec, specOk, specChanged, geometry,
 * quality, territory, requirements, emit); deps are injectable for tests
 * ({ buildDemandInputs, createRouter }). Every figure goes back to the
 * model as an ESTIMATE with its calibration status and uncertainty.
 */

"use strict";

const { normalizeSpec } = require("./networkSpec");
const inputsService = require("../demand/inputs");

const defaultDeps = {
  buildDemandInputs: (opts) => inputsService.buildDemandInputs(opts),
  // Estimates route in straight lines (× 1.3): offline, fast, deterministic.
  createRouter: () => require("./roadRouter").createRouter({ mode: "straight" }),
};

const fmt = (v) => (v == null ? "n/a" : Math.round(v).toLocaleString("en"));
const money = (v, cur) => `${fmt(v)} ${cur}`;

/** A KPI block for the model. */
const kpiText = (k) =>
  [
    `${k.lines} line(s), ${k.stops} stops; fleet ${k.fleet_peak} at peak; ${fmt(k.veh_km_year)} vehicle-km/year; cost ≈ ${money(k.cost_year, k.currency)}/year.`,
    k.trips_year != null ? `Ridership ESTIMATE (${k.calibrated ? "calibrated" : "not calibrated"}, ${k.uncertainty}): ~${fmt(k.trips_day)} boardings per weekday, ~${fmt(k.trips_year)} per year; ≈ ${k.cost_per_trip ?? "n/a"} ${k.currency} per boarding.` : "Ridership not estimated.",
    [k.pop_400m_pct != null ? `${k.pop_400m_pct} % of residents within 400 m of a stop` : null, k.pop_400m_frequent_pct != null ? `${k.pop_400m_frequent_pct} % near a frequent stop` : null, k.jobs_400m_pct != null ? `${k.jobs_400m_pct} % of jobs within 400 m` : null, k.hubs_30min_pct != null ? `${k.hubs_30min_pct} % reach the main places within 30 min at 08:00` : null, k.commercial_speed_kmh != null ? `commercial speed ${k.commercial_speed_kmh} km/h` : null].filter(Boolean).join("; "),
  ]
    .filter(Boolean)
    .join("\n");

const inputsSummary = (inputs) => ({ totals: inputs.totals, quality: inputs.quality, sources: inputs.sources, warnings: inputs.warnings });

const createDemandTools = (ctx, deps = {}) => {
  const d = { ...defaultDeps, ...deps };
  const needTerritory = () => (!ctx.territory ? { content: "Error: call get_territory first (the demand is estimated on the territory's residents and places).", isError: true } : null);
  const needSpec = () => (!ctx.spec || !ctx.specOk ? { content: "Error: the current spec has blocking issues (or there is none): fix them with set_spec / patch_spec first.", isError: true } : null);
  // The demand inputs of the territory, built once per turn.
  const inputsOf = async () => {
    if (!ctx.demandInputs || ctx.demandInputsPlace !== ctx.territory.place.query) {
      ctx.demandInputs = await d.buildDemandInputs({ territory: ctx.territory, place: ctx.territory.place.query, dataIds: Array.isArray(ctx.dataIds) ? ctx.dataIds : [] });
      ctx.demandInputsPlace = ctx.territory.place.query;
    }
    return ctx.demandInputs;
  };
  // Shared by optimize_service and adopt_scenario: the new spec becomes the current one, as set_spec does.
  const adopt = (raw, extra) => {
    // Checked against the territory like set_spec (school zones).
    const norm = normalizeSpec(raw, { territory: ctx.territory });
    ctx.spec = norm.spec;
    ctx.specOk = norm.ok;
    ctx.geometry = null;
    ctx.quality = null;
    ctx.specChanged = true;
    ctx.emit("spec", { spec: norm.spec, issues: norm.issues, blockers: norm.blockers, estimate: norm.estimate, ok: norm.ok, ...extra });
    return norm;
  };

  const estimateDemand = {
    definition: {
      name: "estimate_demand",
      description: "Ridership ESTIMATE of the current spec on the territory: boardings per weekday and per year, per line (with the peak-hour load against capacity: overcrowding) and per stop, the share of all trips it would carry, and the KPIs (cost per boarding, residents within 400 m of a stop and of a frequent stop, access to the main places in 30 min). Every figure comes with its calibration status and uncertainty. Needs get_territory and a valid spec.",
      input_schema: { type: "object", properties: {} },
    },
    async run() {
      const blocked = needTerritory() || needSpec();
      if (blocked) return blocked;
      const inputs = await inputsOf();
      const { estimateSpecDemand } = require("../demand/assignment");
      const { kpisOfSpec } = require("../demand/kpis");
      const r = await estimateSpecDemand(ctx.spec, { inputs, router: d.createRouter() });
      const kpis = kpisOfSpec(ctx.spec, { territory: ctx.territory, inputs, geometry: r.geometry, estimate: r.estimate, tables: r.tables, timetable: r.timetable });
      ctx.demand = { estimate: r.estimate, kpis };
      ctx.emit("demand", { estimate: r.estimate, kpis, inputs: inputsSummary(inputs) });
      ctx.emit("step", { kind: "demand", boardings_day: r.estimate.total_boardings_day, calibrated: r.estimate.calibrated });
      const e = r.estimate;
      return {
        content: [
          `ESTIMATE, ${e.calibrated ? "calibrated on observed ridership" : "NOT calibrated"} (uncertainty ${e.uncertainty}${e.partial ? ", partial: time budget reached" : ""}): the network would carry ~${fmt(e.total_boardings_day)} boardings per weekday (~${fmt(e.total_boardings_year)} per year), ${(e.transit_share * 100).toFixed(1)} % of all trips.`,
          `Per line: ${e.per_line.map((l) => `${l.short_name} ${fmt(l.boardings_day)}/day${l.overcrowded ? " OVERCROWDED" : ""}`).join(", ")}.`,
          `Busiest stops: ${e.per_stop.slice(0, 6).map((s) => `${s.name} ${fmt(s.boardings_day)}`).join(", ")}.`,
          kpiText(kpis),
          e.warnings.length ? `Caveats: ${e.warnings.slice(0, 5).join(" ")}` : "",
          "Quote these as estimates with their uncertainty, never as counts.",
        ].filter(Boolean).join("\n"),
      };
    },
  };

  const optimizeService = {
    definition: {
      name: "optimize_service",
      description: "Optimise the frequencies of the current spec (headway of each line and period on a 5–60 min ladder, at most two steps from today): objective ridership (most boardings within the caps; without caps, at today's cost and fleet), balanced (moves service to where it carries riders more cheaply) or cost (lowest cost keeping 95 % of the boardings). Caps: max_vehicles, max_cost_year (else the brief's fleet_max / budget_max). The brief's passing clauses keep passing. The optimised spec BECOMES the current spec (shown to the user); returns the changes with their estimated effect — proposals the user validates.",
      input_schema: {
        type: "object",
        properties: {
          objective: { type: "string", enum: ["ridership", "balanced", "cost"] },
          max_vehicles: { type: "number" },
          max_cost_year: { type: "number", description: "In the operations currency." },
        },
        required: ["objective"],
      },
    },
    async run(input) {
      const blocked = needTerritory() || needSpec();
      if (blocked) return blocked;
      const inputs = await inputsOf();
      const { optimizeSpec } = require("../demand/optimizer");
      const constraints = {};
      if (Number(input?.max_vehicles) > 0) constraints.max_vehicles = Number(input.max_vehicles);
      if (Number(input?.max_cost_year) > 0) constraints.max_cost_year = Number(input.max_cost_year);
      if (ctx.requirements) constraints.keep_clauses = ctx.requirements;
      let r;
      try {
        r = await optimizeSpec(ctx.spec, { territory: ctx.territory, inputs, objective: input?.objective, constraints, router: d.createRouter() });
      } catch (err) {
        return { content: `Error: ${err.message}`, isError: true };
      }
      ctx.emit("optimization", { objective: r.objective, changes: r.changes, kpis_before: r.kpis_before, kpis_after: r.kpis_after, assumptions: r.assumptions, warnings: r.warnings });
      if (!r.changes.length) return { content: [`No change improves the ${r.objective} objective within the caps: the spec is kept.`, ...r.warnings.slice(0, 3)].join("\n") };
      const norm = adopt(r.spec, { optimized: { objective: r.objective } });
      ctx.emit("step", { kind: "optimize", objective: r.objective, changes: r.changes.length });
      const kb = r.kpis_before;
      const ka = r.kpis_after;
      return {
        content: [
          `Optimised (${r.objective}); the spec is now the optimised one (ok: ${norm.ok}). Changes (PROPOSALS, estimated effect of each):`,
          "| line | days | period | headway | vehicles | cost/year | boardings/year |",
          "|---|---|---|---|---|---|---|",
          ...r.changes.map((c) => `| ${c.line} | ${(c.days || []).join(",") || c.calendar} | ${c.period} | ${c.headway_before} → ${c.headway_after} min | ${c.vehicles_delta >= 0 ? "+" : ""}${c.vehicles_delta} | ${c.cost_delta >= 0 ? "+" : ""}${fmt(c.cost_delta)} | ${c.trips_delta >= 0 ? "+" : ""}${fmt(c.trips_delta)} |`),
          `Network (full re-assignment, ESTIMATE ${ka.uncertainty}${ka.calibrated ? ", calibrated" : ", not calibrated"}): boardings/year ${fmt(kb.trips_year)} → ${fmt(ka.trips_year)}; cost ${money(kb.cost_year, kb.currency)} → ${money(ka.cost_year, ka.currency)}; fleet ${kb.fleet_peak} → ${ka.fleet_peak}.`,
          r.warnings.length ? `Warnings: ${r.warnings.slice(0, 5).join(" ")}` : "",
          "Present them as proposals the user validates; re-run evaluate_plan to check the brief and the quality.",
        ].filter(Boolean).join("\n"),
      };
    },
  };

  const generateScenarios = {
    definition: {
      name: "generate_scenarios",
      description: "Design three contrasted networks for the territory to help the user arbitrate: trunk (1–3 strong lines every 10 min + feeders), coverage (more lines every 20–30 min, most residents within 400 m) and balanced (coverage lines, frequencies optimised under the cap), each checked against the brief, with ESTIMATED ridership, cost and coverage, and which are dominated. The current spec is NOT replaced (adopt_scenario does). Needs get_territory.",
      input_schema: { type: "object", properties: { strategies: { type: "array", items: { type: "string", enum: ["trunk", "coverage", "balanced"] } } } },
    },
    async run(input) {
      const blocked = needTerritory();
      if (blocked) return blocked;
      const inputs = await inputsOf();
      const { generateScenarios: generate } = require("../demand/scenarios");
      let r;
      try {
        r = await generate({ territory: ctx.territory, inputs, requirements: ctx.requirements, strategies: Array.isArray(input?.strategies) ? input.strategies : null, router: d.createRouter() });
      } catch (err) {
        return { content: `Error: ${err.message}`, isError: true };
      }
      ctx.scenarios = r.scenarios;
      ctx.emit("scenarios", { scenarios: r.scenarios.map(({ estimate: _estimate, ...s }) => s), comparison: r.comparison, warnings: r.warnings });
      ctx.emit("step", { kind: "scenarios", count: r.scenarios.length });
      const cur = r.comparison.rows[0]?.currency || "";
      return {
        content: [
          "Scenarios (ESTIMATES; boardings/year, cost/year, residents within 400 m):",
          "| id | lines | boardings/year | cost/year | per boarding | residents 400 m | brief (must) | dominated |",
          "|---|---|---|---|---|---|---|---|",
          ...r.comparison.rows.map((x) => `| ${x.id} | ${x.lines} | ${fmt(x.trips_year)} (${x.uncertainty}) | ${money(x.cost_year, cur)} | ${x.cost_per_trip ?? "n/a"} | ${x.pop_400m_pct ?? "n/a"} % | ${x.brief ? `${x.brief.must_pass}/${x.brief.must_total}` : "-"} | ${x.dominated ? `yes (by ${x.dominated_by.join(", ")})` : "no"} |`),
          ...r.scenarios.map((s) => `- ${s.id}: ${s.rationale}${s.warnings.length ? ` Warnings: ${s.warnings.slice(0, 3).join(" ")}` : ""}`),
          "Present the trade-offs; the user chooses. adopt_scenario { id } makes one the current spec.",
        ].join("\n"),
      };
    },
  };

  const adoptScenario = {
    definition: {
      name: "adopt_scenario",
      description: "Make a scenario generated by generate_scenarios (trunk, coverage or balanced) the current spec — when the user chose it. Then refine it with patch_spec and check it with evaluate_plan.",
      input_schema: { type: "object", properties: { id: { type: "string" } }, required: ["id"] },
    },
    run(input) {
      const s = (ctx.scenarios || []).find((x) => x.id === String(input?.id || ""));
      if (!s) return { content: `Error: no generated scenario "${input?.id}"${ctx.scenarios?.length ? ` (have: ${ctx.scenarios.map((x) => x.id).join(", ")})` : "; call generate_scenarios first"}.`, isError: true };
      const norm = adopt(s.spec, { scenario: s.id });
      ctx.emit("step", { kind: "adopt_scenario", id: s.id });
      return { content: `Scenario ${s.id} is now the current spec (ok: ${norm.ok}; ${norm.spec.lines.length} lines, ${norm.spec.stops.length} stops). ${s.warnings.length ? `Check: ${s.warnings.slice(0, 3).join(" ")} ` : ""}Call estimate_routes and evaluate_plan.` };
    },
  };

  // The computations share the server's demand slots with the HTTP endpoints (a BUSY error tells the model to try later).
  const { withGate } = require("../demand/computeGate");
  const gated = (tool) => ({ ...tool, run: (input) => withGate(() => tool.run(input)) });
  const tools = [gated(estimateDemand), gated(optimizeService), gated(generateScenarios), adoptScenario];
  return { definitions: tools.map((t) => t.definition), byName: Object.fromEntries(tools.map((t) => [t.definition.name, t])) };
};

module.exports = { createDemandTools, _internals: { kpiText, defaultDeps } };
