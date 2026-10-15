/**
 * plannerDemandTools — the change planner's demand tools, part of
 * transformPlannerService's tool set:
 *
 *   estimate_ridership     the loaded feed's ridership ESTIMATE and KPIs
 *                          (emits "demand")
 *   propose_optimization   optimised weekday frequencies as a CANDIDATE change
 *                          plan of catalogue operations (set_headway), each
 *                          marked source.generated_by = "optimizer", previewed
 *                          (never committed); the model adopts it through
 *                          set_plan (emits "optimization")
 *
 *   createChangeDemandTools(ctx, deps) → { definitions, byName }
 *
 * ctx is the change planner's turn context (db, sessionId, dataVersion,
 * model, emit, country); deps are injectable ({ buildDemandInputs,
 * getTerritory }). Without a place the feed is estimated on the area its
 * stops cover (demand/feedInputs: official data where available), else on
 * a stop-based population proxy, flagged as such. Every figure is an
 * ESTIMATE with its calibration status and uncertainty.
 */

"use strict";

const inputsService = require("../demand/inputs");

const defaultDeps = {
  buildDemandInputs: (opts) => inputsService.buildDemandInputs(opts),
  getTerritory: async (place) => {
    const t = require("../network/territoryService");
    return t.getCachedTerritory(place) || t.buildTerritory(place);
  },
};

const fmt = (v) => (v == null ? "n/a" : Math.round(v).toLocaleString("en"));

const createChangeDemandTools = (ctx, deps = {}) => {
  const d = { ...defaultDeps, ...deps };
  const modelOf = () => ctx.model || require("./feedModel").buildFeedModel(ctx.db);
  // The inputs: the place's territory, else the feed's own area (official data), else a stop-based proxy.
  const inputsOf = async (place, model) => {
    const key = place || "";
    if (ctx.demandInputs && ctx.demandInputsKey === key) return { inputs: ctx.demandInputs, territory: ctx.demandTerritory || null };
    const { inputsForFeed, feedNameOf } = require("../demand/feedInputs");
    const countryCode = ctx.country || (ctx.sessionId ? require("../sessionCountry").sessionCountryCode(ctx.sessionId) : null);
    const got = await inputsForFeed(model, { place, dataIds: Array.isArray(ctx.dataIds) ? ctx.dataIds : [], countryCode, name: feedNameOf(model, ctx.db), deps: { buildDemandInputs: d.buildDemandInputs, getTerritory: d.getTerritory } });
    Object.assign(ctx, { demandInputs: got.inputs, demandInputsKey: key, demandTerritory: got.territory });
    return got;
  };
  const placeOf = (input) => (typeof input?.place === "string" && input.place.trim().length >= 2 ? input.place.trim().slice(0, 200) : null);

  const estimateRidership = {
    definition: {
      name: "estimate_ridership",
      description: "Ridership ESTIMATE of the loaded feed: boardings per weekday and per year, per line (peak-hour load vs capacity: overcrowding) and per stop, and the KPIs (fleet, vehicle-km, cost, cost per boarding, coverage when the territory is known). With `place` (the town), the territory's residents and places; without, a stop-based population proxy, flagged. Every figure comes with its calibration status and uncertainty.",
      input_schema: { type: "object", properties: { place: { type: "string", description: "Town or area of the network (optional, sounder estimate)." } } },
    },
    async run(input) {
      const model = modelOf();
      let got;
      try {
        got = await inputsOf(placeOf(input), model);
      } catch (err) {
        return { content: `Territory lookup failed: ${err.message}. Call again without place (stop-based proxy).`, isError: true };
      }
      const { estimateFeedDemand } = require("../demand/assignment");
      const { kpisOfFeed } = require("../demand/kpis");
      const r = estimateFeedDemand(model, { inputs: got.inputs });
      const kpis = kpisOfFeed(model, { inputs: got.inputs, estimate: r.estimate, costs: ctx.plan?.costs || null, territory: got.territory, timetable: r.timetable });
      ctx.emit("demand", { estimate: r.estimate, kpis, inputs: { totals: got.inputs.totals, quality: got.inputs.quality, sources: got.inputs.sources, warnings: got.inputs.warnings } });
      const e = r.estimate;
      return {
        content: [
          `ESTIMATE, ${e.calibrated ? "calibrated on observed ridership" : "NOT calibrated"} (uncertainty ${e.uncertainty}): ~${fmt(e.total_boardings_day)} boardings per weekday (${e.method.reference_day}), ~${fmt(e.total_boardings_year)} per year.`,
          `Per line: ${e.per_line.map((l) => `${l.short_name} ${fmt(l.boardings_day)}/day${l.overcrowded ? " OVERCROWDED" : ""}`).join(", ")}.`,
          `KPIs: fleet ${kpis.fleet_peak}, ${fmt(kpis.veh_km_year)} vehicle-km/year, cost ≈ ${fmt(kpis.cost_year)} ${kpis.currency}/year (${kpis.basis.operations}), ${kpis.cost_per_trip ?? "n/a"} ${kpis.currency} per boarding${kpis.pop_400m_pct != null ? `, ${kpis.pop_400m_pct} % of residents within 400 m of a stop` : ""}.`,
          got.inputs.quality?.population === "stop_proxy" ? "Residents are a PROXY placed on the stops (no population data for the area): say so; with the town as place the estimate is sounder." : "",
          e.warnings.length ? `Caveats: ${e.warnings.slice(0, 4).join(" ")}` : "",
          "Quote these as estimates with their uncertainty, never as counts.",
        ].filter(Boolean).join("\n"),
      };
    },
  };

  const proposeOptimization = {
    definition: {
      name: "propose_optimization",
      description: "Optimised WEEKDAY frequencies of the loaded feed as a candidate change plan: set_headway operations per line and period (at most two ladder steps from today), objective ridership (most boardings within the caps; without caps, at today's cost and fleet), balanced or cost (lowest cost keeping 95 % of the boardings), caps max_vehicles / max_cost_year, previewed on a sandbox (never committed). Each operation carries source.generated_by = \"optimizer\": they are PROPOSALS, not the brief's words. Use it only when the user asks to optimise; adopt the plan through set_plan with the operations unchanged.",
      input_schema: {
        type: "object",
        properties: {
          objective: { type: "string", enum: ["ridership", "balanced", "cost"] },
          constraints: { type: "object", properties: { max_vehicles: { type: "number" }, max_cost_year: { type: "number" }, min_headway: { type: "number" }, max_headway: { type: "number" } } },
          place: { type: "string", description: "Town or area of the network (optional, sounder estimate)." },
        },
        required: ["objective"],
      },
    },
    async run(input) {
      const model = modelOf();
      let got;
      try {
        got = await inputsOf(placeOf(input), model);
      } catch (err) {
        return { content: `Territory lookup failed: ${err.message}. Call again without place (stop-based proxy).`, isError: true };
      }
      const c = input?.constraints && typeof input.constraints === "object" ? input.constraints : {};
      const constraints = {};
      for (const k of ["max_vehicles", "max_cost_year", "min_headway", "max_headway"]) if (Number(c[k]) > 0) constraints[k] = Number(c[k]);
      if (ctx.plan?.requirements) constraints.keep_clauses = ctx.plan.requirements;
      const { optimizeFeed } = require("../demand/optimizer");
      let r;
      try {
        r = await optimizeFeed(ctx.db, { inputs: got.inputs, objective: input?.objective, constraints, costs: ctx.plan?.costs || null, territory: got.territory, sessionId: ctx.sessionId, dataVersion: ctx.dataVersion });
      } catch (err) {
        return { content: `Error: ${err.message}`, isError: true };
      }
      ctx.optimizerProposal = r;
      ctx.emit("optimization", { objective: r.objective, plan: r.plan, preview: r.preview, changes: r.changes, dropped: r.dropped, kpis_before: r.kpis_before, kpis_after: r.kpis_after, assumptions: r.assumptions, warnings: r.warnings });
      if (!r.plan.operations.length) return { content: [`No frequency change improves the ${r.objective} objective within the caps.`, ...r.warnings.slice(0, 3)].join("\n") };
      const kb = r.kpis_before;
      const ka = r.kpis_after;
      return {
        content: [
          `Candidate plan (${r.objective}, PROPOSALS the user validates): ${r.plan.operations.length} set_headway operation(s), previewed: ${r.preview?.blocked ? "BLOCKED" : "no blocked step"}${r.dropped.length ? `; dropped: ${r.dropped.map((x) => `${x.id} (${x.reason})`).join("; ")}` : ""}.`,
          ...r.changes.map((x) => `- line ${x.line} ${x.period}: every ${x.headway_before} → ${x.headway_after} min (${x.cost_delta >= 0 ? "+" : ""}${fmt(x.cost_delta)} ${kb.currency}/year, ${x.trips_delta >= 0 ? "+" : ""}${fmt(x.trips_delta)} boardings/year estimated)`),
          `Network, ESTIMATE (${ka.uncertainty}${ka.calibrated ? ", calibrated" : ", not calibrated"}): boardings/year ${fmt(kb.trips_year)} → ${fmt(ka.trips_year)}; cost ${fmt(kb.cost_year)} → ${fmt(ka.cost_year)} ${ka.currency}; fleet ${kb.fleet_peak} → ${ka.fleet_peak}.`,
          r.warnings.length ? `Warnings: ${r.warnings.slice(0, 4).join(" ")}` : "",
          `To adopt it, call set_plan with these operations unchanged (keep source.generated_by) and the plan's assumptions: ${JSON.stringify({ title: r.plan.title, operations: r.plan.operations, assumptions: r.plan.assumptions, costs: r.plan.costs })}`,
        ].filter(Boolean).join("\n"),
      };
    },
  };

  // The computations share the server's demand slots with the HTTP endpoints (a BUSY error tells the model to try later).
  const { withGate } = require("../demand/computeGate");
  const gated = (tool) => ({ ...tool, run: (input) => withGate(() => tool.run(input)) });
  const tools = [gated(estimateRidership), gated(proposeOptimization)];
  return { definitions: tools.map((t) => t.definition), byName: Object.fromEntries(tools.map((t) => [t.definition.name, t])) };
};

module.exports = { createChangeDemandTools, _internals: { defaultDeps } };
