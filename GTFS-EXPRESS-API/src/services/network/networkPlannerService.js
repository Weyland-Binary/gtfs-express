/**
 * networkPlannerService — the planner: a brief (cahier des charges, a few
 * sentences, answers to questions) → a Network Spec, grounded by tools.
 *
 *   POST /gtfs/network/plan   (SSE, gated like the chat)
 *   {
 *     brief:     string,                    // the user's message / document text
 *     spec?:     object,                    // the current spec, when refining
 *     messages?: [{ role, content }],       // previous turns (text only)
 *     language?: "fr" | "en" | …,
 *     near?:     { lat, lon }               // area hint for geocoding
 *   }
 *
 * The model never writes GTFS rows. It works in phases, each grounded by a
 * tool: understand (set_requirements → what the brief states, what is
 * assumed, what must be asked; ask_user with defaults), ground
 * (get_territory, suggest_corridors), design (find_existing_stops /
 * geocode_stops, set_spec validated by networkSpec, refine_stops,
 * estimate_routes), evaluate (evaluate_plan → the design quality report;
 * fix the majors, re-evaluate). Every event the UI needs streams over SSE:
 * `token` (markdown), `tool_pending`, `step`, `requirements`, `territory`,
 * `corridors`, `spec`, `geometry`, `coverage`, `quality`, `questions`,
 * `usage`, `error`, `done` (with `ready` when the plan can be projected).
 *
 * LLM → tools → LLM, up to MAX_ROUNDS; the strongest model tier is used
 * for this design step (NETWORK_PLANNER_MODEL), the chat model for the
 * free trial.
 */

"use strict";

const config = require("../../config");
const aiCostLimiter = require("../aiCostLimiter");
const freeTierLimiter = require("../freeTierLimiter");
const nl2sqlChatService = require("../nl2sqlChatService");
const { recordEvent, extractReqMeta } = require("../eventLogger");
const { normalizeSpec, MODES, NAMED_CALENDARS, LIMITS } = require("./networkSpec");
const geocoderModule = require("./geocoder");
const roadRouter = require("./roadRouter");
const compiler = require("./compiler");
const territoryService = require("./territoryService");
const design = require("./networkDesignService");
const { haversineMeters } = require("../../utils/geoUtils");

const MAX_ROUNDS = 20;
const MAX_CONSECUTIVE_ERRORS = 4;
// A whole network goes out in one set_spec call: room for a few dozen lines and their stops.
const MAX_TOKENS = 32000;
// A call cut off at the output limit is not run; the model resends it (compactly) at most this often.
const MAX_TRUNCATIONS = 2;
const TRUNCATED_CALL = "Not run: your reply reached the output limit before this call was complete. Send it again, more compactly: no prose before the call, and leave out the fields that keep their default value.";
const MAX_BRIEF_CHARS = 60000;
const MAX_HISTORY = 20;
const LANG_NAMES = { en: "English", fr: "French", es: "Spanish", de: "German", pt: "Portuguese", zh: "Chinese", ar: "Arabic", hi: "Hindi" };

// Injectable for tests (no network).
const catalogService = require("./catalogService");
const briefDocuments = require("./briefDocumentService");
const deps = { geocode: geocoderModule.geocode, createRouter: roadRouter.createRouter, buildTerritory: territoryService.buildTerritory, findFeeds: (territory) => catalogService.findFeeds(territory), importFeed: (url, opts) => catalogService.importFeed(url, opts) };

const clip = (s, n) => (typeof s === "string" && s.length > n ? `${s.slice(0, n)}…` : s);
const str = (v) => (typeof v === "string" ? v.trim() : v == null ? "" : String(v).trim());

// ── System prompt ──────────────────────────────────────────────────────────

const buildSystemPrompt = () => `You are the network planner of GTFS Express: a senior transit planner and GTFS expert who turns a brief (a specification document, a few sentences, or answers to your questions) into a complete, valid public-transport network, ready to be compiled into GTFS.

You NEVER write GTFS rows yourself. You produce a Network Spec through the set_spec tool; the server compiles it deterministically (road routing, running times, timetables, calendars, validation). Your job is the DESIGN: the right lines, the right stops in the right order, sensible services, honest assumptions.

# Network Spec (what set_spec expects)
{
  "agency": { "name", "url", "timezone" (IANA, e.g. Europe/Paris), "lang"?, "phone"?, "email"? },
  "feed": { "start_date"?: "YYYYMMDD", "end_date"?: "YYYYMMDD" },
  "stops": [ { "id"?, "name", "lat", "lon", "code"?, "address"? } ],
  "lines": [ {
    "id"?, "short_name", "long_name"?, "mode": ${Object.keys(MODES).join("|")}, "color"?: "RRGGBB", "speed_kmh"?, "dwell_s"?,
    "directions": [ { "id": "0"|"1", "headsign", "stops": [stop ids or exact stop names in order] } ],   // one direction + round_trip (default) derives the return
    "services": [ { "calendar": ${Object.keys(NAMED_CALENDARS).slice(0, 8).join("|")} | {"days":["mon",…],"start_date"?,"end_date"?}, "direction"?: "0"|"1"|"both",
                    "periods"?: [ { "from": "06:00", "to": "09:00", "headway_min": 10 } ], "departures"?: ["06:05", …] } ]
  } ],
  "holidays"?: ["YYYYMMDD"], "holiday_service"?: "sunday"|"none",
  "transfers"?: [ { "from", "to", "min_minutes" } ],
  "weekend"?: ["fri","sat"],   // local weekly rest days (default sat+sun): "weekday" and "weekend" calendars follow them
  "sync"?: { "stop": stop id or name, "minute"?: 0 },   // pulse timetable: every headway service reaches this hub at that minute (mod its headway); services[].sync overrides or opts out (false)
  "operations"?: { "currency"?: "EUR", "cost_per_km"?: number | {mode: number}, "cost_per_hour"?, "layover_min"?, "max_vehicles"?, "max_cost_year"? }
}
Limits: ≤ ${LIMITS.lines} lines, ≤ ${LIMITS.stops} stops, ≤ ${LIMITS.stopsPerDirection} stops per direction, ≤ ${LIMITS.trips} trips.

# Method: four phases, each grounded by a tool

## 1. Understand (set_requirements, ask_user)
Attached documents (PDF, Word, text: a tender, a study, a cahier des charges) ARE the specification. Read them entirely — text, tables, maps' captions, annexes — before anything else: lines and stops requested, service levels by period, hours, days, calendars and school periods, fleet, budget, accessibility, deadlines, priorities, what must be kept. Put each requirement in set_requirements (cite the page or section in the reason when you can). When a document and the chat disagree, the latest chat message wins; when two parts of a document disagree, ask.
On a NEW brief (no [Current spec] block), your FIRST call is set_requirements: what the brief states (operator, area, lines with termini and vias, modes, service days and hours, headways, holidays, budget or fleet constraints, must-serve places), what you ASSUME with a confidence level, and the OPEN QUESTIONS with their impact. Everything the brief states is law; do not "improve" it silently. On a refinement, call set_requirements again only when the request changes the scope (new lines, new area, new service policy).
An open question has impact "high" when two plausible answers give materially different networks: which town when the name is ambiguous, the termini or the order of stops of a requested line, whether existing lines must be kept, a fleet or budget cap, school-only service. Then call ask_user with those questions (1–3, each with options and a default), end your turn, and continue with the answers next time. Everything else gets a sensible default (below), listed as an assumption the user can contest.

## 2. Ground (get_territory, suggest_corridors)
Real networks start from the ground: call get_territory with the town or area (once; the dossier is cached) unless a [Territory] block is already in the message. It gives the timezone, the population, the EXISTING stops and stations from OpenStreetMap (reuse their names, coordinates and ids — passengers know them), the existing transit lines (do not duplicate a line that already runs; connect to it), the trip generators that the lines must serve, and the holidays for the calendars. It also gives the country context (currency, language, the usual weekend days, driving side, income level) and the works and projects under way (new neighbourhoods and facilities being built are tomorrow's demand: serve them; roads under construction are not usable until they open; connect to planned tram, metro or rail lines). The application is used worldwide: follow local practice, never assume a European week, currency or language.
When the brief does not name the lines precisely ("a bus network for the town", "3 lines serving the essentials"), call suggest_corridors: it computes the demand hubs and the strongest corridors between them from the generators and the population. Use them as skeletons; keep the brief's own lines first.
When the brief asks to improve, extend or restructure the EXISTING network, or when the territory lists existing transit lines and the brief does not say to start from scratch: call find_existing_feeds, then import_existing_network on the most local feed. It loads the network that runs today as the current spec (its score is the baseline); design your changes on it and quote the before/after score in the summary.

## 3. Design (find_existing_stops, geocode_stops, set_spec, refine_stops, estimate_routes)
- Stops need real coordinates. Resolve a named stop with find_existing_stops first; geocode_stops the rest in ONE batch (add the town to each query, \`near\` = area centre); take the chosen candidate unless the context contradicts it. Never invent coordinates. A stop that cannot be located stays in the spec without coordinates: the user places it on the map.
- Call set_spec. Fix every blocker (missing coordinates aside) and call it again until ok=true.
- Then call refine_stops once: it snaps the planned stops onto the existing ones and fills long gaps with the existing stops along the way, so a line serves the neighbourhoods it crosses. Then estimate_routes: check distances and running times are plausible for the mode (a 12 km urban bus line runs ~35–45 min); adjust speed_kmh or the stop order when they are not.

## 4. Evaluate (evaluate_plan, coverage_score)
Call evaluate_plan: the design quality report (coverage of the generators and residents, stop spacing, directness, service level for the population, connectivity, plausibility, compliance) with a score out of 100, the operations bill, the accessibility of the main places (share of residents reaching the station, the hospital, the centre within 30/45/60 min at 08:00) and recommendations. Fix the MAJOR findings unless the brief imposes them, then evaluate again (at most two rounds). Aim for a score ≥ 70 with no major finding. coverage_score gives the detail of the unserved places when you need it.

## Designing from scratch
When the user asks to propose a network for the territory without naming lines, you design it end to end from the data: suggest_corridors for the skeleton, the population grid for where people live, the generators for where they go, the works for where the city grows, the existing network to connect to. Size it for the population (rules of thumb, adapt to density and the budget): under 10 000 inhabitants, 1–2 lines or a shuttle; 10 000–50 000, 2–5 radial lines through the centre with a pulse; 50 000–150 000, 5–12 lines with one or two frequent trunks (10 min at peak); 150 000–500 000, 10–25 lines with a frequent grid of trunks (5–8 min); above, a trunk mode (tram or BRT) plus a feeder grid. Keep the number of lines within the plan's limit. Ask at most the essential questions (budget or fleet cap, service span, priorities) with suggested answers; otherwise state your assumptions and deliver a complete plan.

## 5. Deliver
Answer in markdown, in the user's language, briefly: the network (lines, stops, service) in a few lines, the **quality score** and what limits it, the ASSUMPTIONS as a bullet list, what the user should check on the map. When the plan is ready (spec ok, no missing coordinates), say it can be projected into the application. Do not repeat the requirements card; the UI shows it.

# Defaults when the brief is silent
- Service: weekday 06:00–21:00, peak (07:00–09:00, 16:30–19:00) headway 15 min, off-peak 30 min; saturday 08:00–20:00 every 30 min; sunday 09:00–19:00 every 60 min. Shuttles/school lines: explicit departures.
- Modes and speeds: the compiler knows commercial speeds per mode; set speed_kmh only when the brief implies express or slow service.
- Feed dates: today → +1 year. Holidays: the territory's public holidays (dates from get_territory) with holiday_service "sunday" unless the brief says otherwise; when school holidays matter (school lines, reduced summer service) build a second calendar with days and dates.
- Agency timezone: the territory's timezone; agency.lang: the country's first language; operations.currency: leave it out (costs are then estimated in the local currency at the local price level) unless the brief gives figures.
- Week: set spec.weekend to the country's usual weekend when it is not Saturday–Sunday; "weekday" then means the local working days and "weekend" the rest days; name saturday/sunday calendars only where they make sense locally.
- Colours: one distinct colour per line; keep the brief's colours when given.
- Stop naming: proper case, no codes; termini names as headsigns.
- Ids: short and stable (line short name; stop slug); the compiler slugs missing ids.
- Operations: evaluate_plan reports the fleet (vehicles at peak per line, no interlining), the vehicle-km and vehicle-hours per year and the yearly cost (per-mode cost per km; the brief's figures go in operations.cost_per_km / cost_per_hour / currency). When the brief caps the fleet or the budget, put it in operations.max_vehicles / max_cost_year: the report flags an overrun as a major finding, and you must fit within it (wider headways off-peak, shorter lines, fewer lines) before delivering. Always quote the fleet and the yearly cost in your summary.
- Pulse timetable: in a small town with radial lines and headways of 20 min or more, set sync to the hub (station or centre, minute 0) so every line meets there and transfers work; say it in the assumptions.
- Line design: stops every 300–600 m in town, termini at generators or existing stops, no detour over ×1.5 of the straight distance, every line meets another at a hub (station, centre) so passengers can transfer; a small town gets radial lines through the centre, a bigger one adds a cross-town line.

# Style
Be concise and concrete. No narration of tool calls (the UI shows them). Use **bold** for line names and key numbers. When you refine an existing spec, change only what the user asked and keep the rest byte-identical.`;

let _systemPrompt = null;
const systemPrompt = () => {
  if (!_systemPrompt) _systemPrompt = buildSystemPrompt();
  return _systemPrompt;
};

// ── Tools ──────────────────────────────────────────────────────────────────

const createTools = (ctx) => {
  const geocodeStops = {
    definition: {
      name: "geocode_stops",
      description: "Coordinates of stops from their names or addresses (OpenStreetMap). Batch all the stops of the network in ONE call (≤ 60). Add the town to each query ('Mairie, Vendôme'). `near` biases the search to the area. Returns, per query, a chosen candidate (closest plausible) and alternatives.",
      input_schema: {
        type: "object",
        properties: {
          queries: { type: "array", items: { type: "string" } },
          near: { type: "object", properties: { lat: { type: "number" }, lon: { type: "number" } }, description: "Centre of the area (town centre)." },
          lang: { type: "string", description: "Two-letter language for labels." },
        },
        required: ["queries"],
      },
    },
    async run(input) {
      const queries = (Array.isArray(input?.queries) ? input.queries : []).map((q) => String(q || "").trim()).filter(Boolean).slice(0, 60);
      if (queries.length === 0) return { content: "Error: queries[] is required.", isError: true };
      const near = input?.near && Number.isFinite(Number(input.near.lat)) && Number.isFinite(Number(input.near.lon)) ? { lat: Number(input.near.lat), lon: Number(input.near.lon) } : ctx.near;
      const lang = typeof input?.lang === "string" ? input.lang.slice(0, 2) : ctx.language;
      const results = [];
      for (let i = 0; i < queries.length; i += 3) {
        const batch = queries.slice(i, i + 3);
        const out = await Promise.all(batch.map((q) => deps.geocode(q, { near, limit: 4, lang })));
        results.push(...out);
      }
      // Choose: nearest candidate to `near` (within 40 km), else the first.
      const summary = results.map((r) => {
        const cands = r.candidates.map((c) => ({ ...c, distance_km: near ? Math.round(haversineMeters(near.lat, near.lon, c.lat, c.lon) / 100) / 10 : null }));
        let chosen = null;
        if (cands.length) {
          const sorted = near ? [...cands].sort((a, b) => a.distance_km - b.distance_km) : cands;
          chosen = near && sorted[0].distance_km <= 40 ? sorted[0] : cands[0];
        }
        return { query: r.query, chosen: chosen ? { label: chosen.label, lat: chosen.lat, lon: chosen.lon, kind: chosen.kind, distance_km: chosen.distance_km } : null, alternatives: cands.filter((c) => c !== chosen).slice(0, 2).map((c) => ({ label: c.label, lat: c.lat, lon: c.lon, distance_km: c.distance_km })), error: r.error || undefined };
      });
      const missing = summary.filter((s) => !s.chosen).map((s) => s.query);
      ctx.emit("step", { kind: "geocode", queries: queries.length, found: queries.length - missing.length, missing });
      return {
        content: JSON.stringify({ results: summary, not_found: missing, note: missing.length ? "Keep the not-found stops in the spec without coordinates (or retry with a more specific query, e.g. street + town)." : "All stops found." }),
      };
    },
  };

  const setSpec = {
    definition: {
      name: "set_spec",
      description: "Set (or replace) the Network Spec. The server normalises and validates it and returns the issues (blockers first) and an estimate of the feed (trips, stop_times). Call it again after fixing the blockers. The spec is shown to the user as it is set.",
      input_schema: { type: "object", properties: { spec: { type: "object" } }, required: ["spec"] },
    },
    run(input) {
      const spec = input?.spec;
      if (!spec || typeof spec !== "object") return { content: "Error: spec object is required.", isError: true };
      const norm = normalizeSpec(spec);
      ctx.spec = norm.spec;
      ctx.specOk = norm.ok;
      ctx.geometry = null;
      ctx.emit("spec", { spec: norm.spec, issues: norm.issues, blockers: norm.blockers, estimate: norm.estimate, ok: norm.ok });
      const coordBlockers = norm.blockers.filter((b) => b.code === "stop_needs_coordinates");
      const others = norm.blockers.filter((b) => b.code !== "stop_needs_coordinates");
      const warnings = norm.issues.filter((i) => i.level === "warning" && i.code !== "stop_auto_created");
      return {
        content: [
          `ok: ${norm.ok}. Estimate: ${norm.estimate.lines} line(s), ${norm.estimate.stops} stop(s) (${norm.estimate.stops_without_coordinates} without coordinates), ${norm.estimate.calendars} calendar(s), ${norm.estimate.trips} trip(s), ${norm.estimate.stop_times} stop_times.`,
          others.length ? `BLOCKERS to fix:\n${others.map((b) => `- ${b.path}: ${b.message}`).join("\n")}` : "",
          coordBlockers.length ? `Stops without coordinates (geocode them or leave them for the user): ${coordBlockers.map((b) => `${b.stopId} "${b.stopName}"`).join(", ")}` : "",
          warnings.length ? `Warnings:\n${warnings.slice(0, 12).map((w) => `- ${w.path}: ${w.message}`).join("\n")}` : "",
          norm.ok ? "The spec is valid: call estimate_routes, then write your summary." : "",
        ].filter(Boolean).join("\n"),
        isError: others.length > 0,
      };
    },
  };

  const estimateRoutes = {
    definition: {
      name: "estimate_routes",
      description: "Route every direction of the current spec along roads: distance, running time and the drawn path (shown on the user's map). Needs coordinates. Use it to sanity-check the design.",
      input_schema: { type: "object", properties: {} },
    },
    async run() {
      if (!ctx.spec) return { content: "Error: call set_spec first.", isError: true };
      const geo = await compiler.estimateGeometry(ctx.spec, { router: deps.createRouter() });
      ctx.geometry = geo;
      ctx.emit("geometry", geo);
      const lines = geo.lines.map((l) => `- ${l.short_name}: ${l.directions.map((d) => (d.routable ? `dir ${d.id} ${d.stops} stops, ${d.distance_km} km, ${d.running_min} min${d.fallback_legs ? ` (${d.fallback_legs} straight legs)` : ""}` : `dir ${d.id}: not routable (missing coordinates)`)).join("; ")}`);
      return { content: [`Routing: ${geo.routing}${geo.fallback_legs ? ` (${geo.fallback_legs} leg(s) fell back to straight lines)` : ""}.`, ...lines].join("\n") };
    },
  };

  const askUser = {
    definition: {
      name: "ask_user",
      description: "Ask the user 1–3 precise questions when the brief is genuinely ambiguous on something essential (impact high). Give options and the default you would take, so the user can accept your defaults in one click. After calling it, end your turn: the answers come in the next message.",
      input_schema: {
        type: "object",
        properties: {
          questions: { type: "array", items: { type: "object", properties: { id: { type: "string" }, question: { type: "string" }, options: { type: "array", items: { type: "string" } }, default: { type: "string", description: "The answer you would assume; shown as the suggested answer." }, why: { type: "string", description: "One line on what changes with the answer." } }, required: ["id", "question"] } },
        },
        required: ["questions"],
      },
    },
    run(input) {
      const qs = (Array.isArray(input?.questions) ? input.questions : []).filter((q) => q && typeof q.question === "string").slice(0, 3).map((q, i) => ({ id: String(q.id || `q${i + 1}`).slice(0, 32), question: clip(q.question.trim(), 300), options: Array.isArray(q.options) ? q.options.map((o) => clip(String(o), 80)).slice(0, 5) : [], ...(typeof q.default === "string" && q.default.trim() ? { default: clip(q.default.trim(), 120) } : {}), ...(typeof q.why === "string" && q.why.trim() ? { why: clip(q.why.trim(), 200) } : {}) }));
      if (!qs.length) return { content: "Error: questions[] is required.", isError: true };
      ctx.emit("questions", { questions: qs });
      ctx.asked = true;
      return { content: "Questions shown to the user. End your turn now with a one-line note; do not guess the answers." };
    },
  };

  const setRequirements = {
    definition: {
      name: "set_requirements",
      description: "Record the specification as you understood it: what the brief states, what you assume (with confidence), and the open questions with their impact. Shown to the user as a card they can contest. Call it first on a new brief, and again when a refinement changes the scope.",
      input_schema: {
        type: "object",
        properties: {
          requirements: {
            type: "object",
            properties: {
              operator: { type: "string" },
              area: { type: "string", description: "Town or area, with the country." },
              objectives: { type: "array", items: { type: "string" }, description: "What the network must achieve (serve the hospital, connect the station, school runs…)." },
              lines_requested: { type: "array", items: { type: "object", properties: { name: { type: "string" }, mode: { type: "string" }, from: { type: "string" }, to: { type: "string" }, via: { type: "array", items: { type: "string" } }, notes: { type: "string" } } } },
              service: { type: "object", properties: { days: { type: "string" }, span: { type: "string" }, headways: { type: "string" }, holidays: { type: "string" } } },
              constraints: { type: "array", items: { type: "string" }, description: "Fleet, budget, must-keep existing lines, accessibility…" },
              assumptions: { type: "array", items: { type: "object", properties: { topic: { type: "string" }, value: { type: "string" }, confidence: { type: "string", enum: ["high", "medium", "low"] }, reason: { type: "string" } }, required: ["topic", "value", "confidence"] } },
              open_questions: { type: "array", items: { type: "object", properties: { id: { type: "string" }, question: { type: "string" }, impact: { type: "string", enum: ["high", "low"] }, default: { type: "string" }, options: { type: "array", items: { type: "string" } } }, required: ["id", "question", "impact"] } },
            },
          },
        },
        required: ["requirements"],
      },
    },
    run(input) {
      const r = input?.requirements;
      if (!r || typeof r !== "object") return { content: "Error: requirements object is required.", isError: true };
      const strList = (v, n = 20, len = 200) => (Array.isArray(v) ? v.map((x) => clip(String(x || ""), len)).filter(Boolean).slice(0, n) : []);
      const req = {
        operator: clip(str(r.operator), 120) || null,
        area: clip(str(r.area), 160) || null,
        objectives: strList(r.objectives),
        lines_requested: (Array.isArray(r.lines_requested) ? r.lines_requested : []).filter((l) => l && typeof l === "object").slice(0, LIMITS.lines).map((l) => ({ name: clip(str(l.name), 40), mode: clip(str(l.mode), 20) || "bus", from: clip(str(l.from), 80), to: clip(str(l.to), 80), via: strList(l.via, 30, 80), notes: clip(str(l.notes), 200) || undefined })),
        service: r.service && typeof r.service === "object" ? { days: clip(str(r.service.days), 120) || null, span: clip(str(r.service.span), 120) || null, headways: clip(str(r.service.headways), 200) || null, holidays: clip(str(r.service.holidays), 120) || null } : null,
        constraints: strList(r.constraints),
        assumptions: (Array.isArray(r.assumptions) ? r.assumptions : []).filter((a) => a && typeof a === "object" && str(a.topic)).slice(0, 25).map((a) => ({ topic: clip(str(a.topic), 60), value: clip(str(a.value), 200), confidence: ["high", "medium", "low"].includes(a.confidence) ? a.confidence : "medium", reason: clip(str(a.reason), 200) || undefined })),
        open_questions: (Array.isArray(r.open_questions) ? r.open_questions : []).filter((q) => q && typeof q === "object" && str(q.question)).slice(0, 8).map((q, i) => ({ id: clip(str(q.id) || `q${i + 1}`, 32), question: clip(str(q.question), 300), impact: q.impact === "high" ? "high" : "low", default: clip(str(q.default), 120) || undefined, options: strList(q.options, 5, 80) })),
      };
      ctx.requirements = req;
      ctx.emit("requirements", req);
      ctx.emit("step", { kind: "requirements", lines: req.lines_requested.length, assumptions: req.assumptions.length, questions: req.open_questions.length });
      const high = req.open_questions.filter((q) => q.impact === "high");
      return {
        content: high.length
          ? `Requirements recorded. ${high.length} open question(s) have a high impact (${high.map((q) => q.id).join(", ")}): call ask_user with them now (options + default), then end your turn.`
          : `Requirements recorded (${req.lines_requested.length} line(s) requested, ${req.assumptions.length} assumption(s)). No high-impact question: proceed with the defaults and list them as assumptions.`,
      };
    },
  };

  const suggestCorridors = {
    definition: {
      name: "suggest_corridors",
      description: "Demand hubs of the territory (weighted clusters of generators, the centre, the stations) and the strongest corridors between them: candidate lines with their termini, the hubs on the way and the existing stops to reuse. Use it when the brief does not name the lines precisely. Needs get_territory.",
      input_schema: { type: "object", properties: { max_lines: { type: "integer", description: "How many corridors (default: what the plan allows, at most 8)." } } },
    },
    run(input) {
      if (!ctx.territory) return { content: "Error: call get_territory first.", isError: true };
      const cap = Number.isFinite(ctx.maxLines) ? Math.min(8, ctx.maxLines) : 8;
      const maxLines = Math.max(1, Math.min(cap, parseInt(input?.max_lines, 10) || cap));
      const out = design.suggestCorridors(ctx.territory, { maxLines, spec: ctx.spec });
      ctx.emit("corridors", { hubs: out.hubs.map((h) => ({ id: h.id, name: h.name, lat: h.lat, lon: h.lon, weight: h.weight })), corridors: out.corridors.map((c) => ({ id: c.id, score: c.score, points: [c.from, ...c.via, c.to].map((p) => [p.lat, p.lon]), from: c.from.name, to: c.to.name })) });
      ctx.emit("step", { kind: "corridors", hubs: out.hubs.length, corridors: out.corridors.length });
      return { content: design.summarizeCorridors(out) };
    },
  };

  const refineStops = {
    definition: {
      name: "refine_stops",
      description: "Improve the current spec with the territory's existing stops: planned stops within 40 m of an existing stop take its exact position; long gaps between consecutive stops are filled with the existing stops along the way (up to 8 per direction). Returns the changes; the spec is updated and re-validated. Needs get_territory and set_spec.",
      input_schema: { type: "object", properties: { snap: { type: "boolean" }, densify: { type: "boolean" } } },
    },
    run(input) {
      if (!ctx.territory) return { content: "Error: call get_territory first.", isError: true };
      if (!ctx.spec) return { content: "Error: call set_spec first.", isError: true };
      const r = design.refineStops(ctx.spec, ctx.territory, { snap: input?.snap !== false, densify: input?.densify !== false });
      if (!r.changes.length) return { content: "No change: the stops already sit on existing stops and no gap can be filled from the existing network." };
      const norm = normalizeSpec(r.spec);
      ctx.spec = norm.spec;
      ctx.specOk = norm.ok;
      ctx.geometry = null;
      ctx.emit("spec", { spec: norm.spec, issues: norm.issues, blockers: norm.blockers, estimate: norm.estimate, ok: norm.ok });
      ctx.emit("step", { kind: "refine", snapped: r.snapped, inserted: r.inserted });
      const lines = r.changes.slice(0, 40).map((c) => (c.type === "snap" ? `- snapped "${c.name}" onto existing stop "${c.to}" (${c.distance_m} m)` : `- line ${c.line}: inserted "${c.name}" between ${c.between[0]} and ${c.between[1]} (gap was ${c.gap_m} m)`));
      return { content: [`${r.snapped} stop(s) snapped, ${r.inserted} stop(s) inserted. Spec ok: ${norm.ok}.`, ...lines, r.changes.length > 40 ? `… and ${r.changes.length - 40} more.` : "", "Call estimate_routes, then evaluate_plan."].filter(Boolean).join("\n") };
    },
  };

  const evaluatePlan = {
    definition: {
      name: "evaluate_plan",
      description: "The design quality report of the current spec: coverage of the trip generators, stop spacing, directness, service level for the population, connectivity (transfers), plausibility of the running times, compliance — a score out of 100, the findings per dimension and recommendations. Needs set_spec (and estimate_routes for the running times).",
      input_schema: { type: "object", properties: {} },
    },
    async run() {
      if (!ctx.spec) return { content: "Error: call set_spec first.", isError: true };
      let geometry = ctx.geometry;
      if (!geometry && !ctx.spec.stops.some((s) => s.lat == null) && ctx.spec.lines.length) {
        try {
          geometry = await compiler.estimateGeometry(ctx.spec, { router: deps.createRouter() });
          ctx.geometry = geometry;
          ctx.emit("geometry", geometry);
        } catch {
          geometry = null;
        }
      }
      let report = design.evaluatePlan(ctx.spec, { territory: ctx.territory, geometry });
      // Accessibility needs a timetable: compile in memory (straight legs, no shapes) when the residents are known.
      if (ctx.territory?.population_grid?.cells?.length && ctx.specOk) {
        try {
          const compiled = await compiler.compileSpec(ctx.spec, { router: roadRouter.createRouter({ mode: "straight" }), shapes: false });
          report = design.attachAccessibility(report, compiled.tables, ctx.spec, ctx.territory);
        } catch {
          /* the report stands without it */
        }
      }
      ctx.quality = report;
      ctx.emit("quality", report);
      ctx.emit("step", { kind: "quality", score: report.score, grade: report.grade, majors: report.majors });
      if (ctx.territory) ctx.emit("coverage", territoryService.coverageOf(ctx.spec, ctx.territory));
      return { content: design.summarizeReport(report) };
    },
  };

  const getTerritory = {
    definition: {
      name: "get_territory",
      description: "The public-data dossier of an area (town, district, region name): timezone, population, existing stops and stations with coordinates (OpenStreetMap), existing transit lines, trip generators (schools, hospitals, universities, stations, malls, stadiums, industry) with coordinates, public holidays and school holidays. Call it once at the start; the user's map shows the layers.",
      input_schema: { type: "object", properties: { place: { type: "string", description: "Town or area name, with the country when ambiguous ('Vendôme, France')." } }, required: ["place"] },
    },
    async run(input) {
      const place = String(input?.place || "").trim();
      if (place.length < 2) return { content: "Error: place is required.", isError: true };
      try {
        const d = await deps.buildTerritory(place);
        ctx.territory = d;
        ctx.near = ctx.near || { lat: d.place.lat, lon: d.place.lon };
        ctx.emit("territory", d);
        ctx.emit("step", { kind: "territory", place: d.place.display_name, stops: d.existing_stops.length, pois: d.pois.items.length, lines: d.existing_lines.length });
        return { content: territoryService.summarizeForModel(d) };
      } catch (err) {
        return { content: `Territory lookup failed: ${err.message}. Continue with geocode_stops.`, isError: true };
      }
    },
  };

  const findExistingStops = {
    definition: {
      name: "find_existing_stops",
      description: "Existing stops of the territory whose name matches (loose match), nearest to `near` first, with ids and coordinates. Needs get_territory first.",
      input_schema: { type: "object", properties: { query: { type: "string" }, near: { type: "object", properties: { lat: { type: "number" }, lon: { type: "number" } } }, limit: { type: "integer" } }, required: ["query"] },
    },
    run(input) {
      if (!ctx.territory) return { content: "Error: call get_territory first.", isError: true };
      const near = input?.near && Number.isFinite(Number(input.near.lat)) ? { lat: Number(input.near.lat), lon: Number(input.near.lon) } : null;
      const hits = territoryService.findStops(ctx.territory, input?.query, near, Math.min(15, parseInt(input?.limit, 10) || 8));
      if (!hits.length) return { content: `No existing stop matches "${input?.query}". Geocode it or create it.` };
      return { content: JSON.stringify(hits.map((h) => ({ id: h.id, name: h.name, kind: h.kind, lat: h.lat, lon: h.lon, distance_m: h.distance_m, operator: h.operator || undefined }))) };
    },
  };

  const coverageScore = {
    definition: {
      name: "coverage_score",
      description: "How the current spec covers the territory: share of trip generators within 400 m of a served stop (weighted by importance), per category, existing stops reused, and the main places left unserved. Needs get_territory and set_spec.",
      input_schema: { type: "object", properties: {} },
    },
    run() {
      if (!ctx.territory) return { content: "Error: call get_territory first.", isError: true };
      if (!ctx.spec) return { content: "Error: call set_spec first.", isError: true };
      const c = territoryService.coverageOf(ctx.spec, ctx.territory);
      ctx.emit("coverage", c);
      return {
        content: [
          `Coverage: ${c.coverage_pct == null ? "n/a" : `${c.coverage_pct}%`} of trip generators within ${c.radius_m} m of a served stop (${c.pois_covered}/${c.pois_total}); ${c.existing_stops_reused}/${c.stops_planned} planned stops are existing stops.`,
          c.population ? `Residents within ${c.radius_m} m of a served stop: ${c.population.pct == null ? "n/a" : `${c.population.pct}%`} (${c.population.covered}/${c.population.total}${c.population.estimated ? ", estimated" : ""}). Densest unserved areas: ${c.population.top_missed.map((m) => `~${m.pop} at ${m.lat.toFixed(4)},${m.lon.toFixed(4)}`).join("; ") || "none"}.` : "",
          `By category: ${Object.entries(c.by_category).map(([k, v]) => `${k} ${v.covered}/${v.total}`).join(", ") || "none"}.`,
          c.top_missed.length ? `Main unserved places: ${c.top_missed.map((m) => `${m.name} (${m.category}, ${m.lat.toFixed(5)},${m.lon.toFixed(5)})`).join("; ")}.` : "Every major generator is served.",
        ].join("\n"),
      };
    },
  };

  const findExistingFeeds = {
    definition: {
      name: "find_existing_feeds",
      description: "The public GTFS feeds (Mobility Database catalog) whose area covers the territory: provider, name, download url, licence. Most local first. Needs get_territory.",
      input_schema: { type: "object", properties: {} },
    },
    async run() {
      if (!ctx.territory) return { content: "Error: call get_territory first.", isError: true };
      try {
        const feeds = await deps.findFeeds(ctx.territory);
        ctx.emit("feeds", { feeds });
        ctx.emit("step", { kind: "feeds", count: feeds.length });
        if (!feeds.length) return { content: "No public feed covers this territory in the catalog. Design from scratch." };
        return { content: `Feeds covering the territory:\n${feeds.map((f, i) => `${i + 1}. ${f.provider}${f.name ? ` — ${f.name}` : ""} (${f.country}${f.municipality ? `, ${f.municipality}` : f.region ? `, ${f.region}` : ""}; box ${f.area_deg2}°²${f.covers_centre ? ", covers the centre" : ""}) url: ${f.url}${f.license ? ` licence: ${f.license}` : ""}`).join("\n")}\nImport the most local one with import_existing_network when the brief builds on the existing network.` };
      } catch (err) {
        return { content: `Catalog unavailable: ${err.message}. Design from the territory.`, isError: true };
      }
    },
  };

  const importExistingNetwork = {
    definition: {
      name: "import_existing_network",
      description: "Download a public GTFS feed and load the network it describes as the current spec (lines with their dominant stop sequence, stops, calendars, explicit departures). The user sees it on the map; evaluate_plan then gives the baseline score. Use the url from find_existing_feeds.",
      input_schema: { type: "object", properties: { url: { type: "string" } }, required: ["url"] },
    },
    async run(input) {
      const url = String(input?.url || "").trim();
      if (!/^https?:\/\//i.test(url)) return { content: "Error: a http(s) url is required.", isError: true };
      try {
        const r = await deps.importFeed(url, { maxLines: Number.isFinite(ctx.maxLines) ? ctx.maxLines : undefined });
        const norm = normalizeSpec(r.spec);
        ctx.spec = norm.spec;
        ctx.specOk = norm.ok;
        ctx.geometry = null;
        ctx.emit("spec", { spec: norm.spec, issues: norm.issues, blockers: norm.blockers, estimate: norm.estimate, ok: norm.ok, imported: true });
        ctx.emit("step", { kind: "import", lines: r.stats.lines, stops: r.stats.stops, routes: r.stats.routes });
        return { content: [`Imported: ${r.stats.lines} line(s) of ${r.stats.routes} route(s), ${r.stats.stops} stops, from ${r.stats.trips} trips. Spec ok: ${norm.ok}${norm.ok ? "" : ` (${norm.blockers.length} blocker(s): ${norm.blockers.slice(0, 5).map((b) => b.message).join("; ")})`}.`, ...r.warnings.map((w) => `- ${w}`), "Lines: " + norm.spec.lines.slice(0, 40).map((l) => `${l.short_name} (${l.mode}, ${l.directions[0].stops.length} stops)`).join(", "), "Call estimate_routes then evaluate_plan for the baseline, then design your changes with set_spec."].join("\n") };
      } catch (err) {
        return { content: `Import failed: ${err.message}. Design from the territory instead.`, isError: true };
      }
    },
  };

  const tools = [setRequirements, askUser, getTerritory, suggestCorridors, findExistingFeeds, importExistingNetwork, findExistingStops, geocodeStops, setSpec, refineStops, estimateRoutes, evaluatePlan, coverageScore];
  return { definitions: tools.map((t) => t.definition), byName: Object.fromEntries(tools.map((t) => [t.definition.name, t])) };
};

// ── Model round ────────────────────────────────────────────────────────────

const runRound = async ({ client, model, messages, tools, signal, emit }) => {
  const stream = client.messages.stream(
    {
      model,
      max_tokens: MAX_TOKENS,
      system: [{ type: "text", text: systemPrompt(), cache_control: { type: "ephemeral" } }],
      tools: tools.definitions,
      messages,
    },
    { signal },
  );
  let usage = null;
  for await (const event of stream) {
    if (event.type === "content_block_start" && event.content_block?.type === "tool_use") emit("tool_pending", { name: event.content_block.name });
    else if (event.type === "content_block_delta" && event.delta?.type === "text_delta" && event.delta.text) emit("token", { text: event.delta.text });
    else if (event.type === "message_delta" && event.usage) usage = event.usage;
  }
  let finalMessage = null;
  try {
    finalMessage = await stream.finalMessage();
  } catch {
    /* consumed by the iterator */
  }
  if (finalMessage?.usage) usage = finalMessage.usage;
  const content = Array.isArray(finalMessage?.content) ? finalMessage.content : [];
  return { content, toolUses: content.filter((b) => b.type === "tool_use"), stopReason: finalMessage?.stop_reason || null, usage };
};

const buildMessages = ({ history, brief, spec, language, near, territoryBlock = "", requirements = null, documents = [] }) => {
  const msgs = [];
  for (const h of (history || []).slice(-MAX_HISTORY)) {
    if (!h || (h.role !== "user" && h.role !== "assistant")) continue;
    const text = clip(String(h.content || ""), 8000);
    if (!text.trim()) continue;
    if (msgs.length && msgs[msgs.length - 1].role === h.role) msgs[msgs.length - 1].content += `\n\n${text}`;
    else msgs.push({ role: h.role, content: text });
  }
  const blocks = [`[UI language: ${LANG_NAMES[language] || "English"}]`];
  if (documents.length) blocks.push(`[Attached documents] ${documents.map((d) => `"${d.name}"${d.pages ? ` (${d.pages} pages)` : ""}${d.truncated ? " (truncated)" : ""}`).join(", ")} — the specification: read them entirely before designing.`);
  if (near) blocks.push(`[Area hint] lat ${near.lat}, lon ${near.lon}`);
  if (territoryBlock) blocks.push(territoryBlock);
  if (requirements) blocks.push(`[Requirements as recorded]\n${clip(JSON.stringify(requirements), 6000)}`);
  if (spec) blocks.push(`[Current spec]\n${clip(JSON.stringify(spec), 40000)}`);
  blocks.push(brief);
  const text = blocks.join("\n\n");
  if (msgs.length && msgs[msgs.length - 1].role === "user") msgs[msgs.length - 1].content += `\n\n${text}`;
  else msgs.push({ role: "user", content: text });
  if (msgs[0].role !== "user") msgs.shift();
  // Documents go before the question, as document blocks the model reads natively.
  if (documents.length) {
    const last = msgs[msgs.length - 1];
    last.content = [...briefDocuments.toContentBlocks(documents), { type: "text", text: last.content }];
  }
  return msgs;
};

/** The planner turn. Emits SSE-style events through `emit`. */
const planNetwork = async ({ brief, spec = null, history = [], language = "en", near = null, territoryPlace = null, requirements = null, documentIds = [], maxLines = null, freeTier = false, rateKey, aiLimits = {}, signal, emit, req = null }) => {
  const text = String(brief || "").trim();
  if (text.length < 3) throw Object.assign(new Error("brief is required (≥ 3 characters)."), { code: "INVALID_INPUT", status: 400 });
  if (text.length > MAX_BRIEF_CHARS) throw Object.assign(new Error(`brief is too long (max ${MAX_BRIEF_CHARS} characters).`), { code: "INVALID_INPUT", status: 400 });
  const limit = aiCostLimiter.check({ key: rateKey || "anon", scope: "chat", ...aiLimits });
  if (!limit.ok) {
    throw Object.assign(new Error(limit.code === "BUDGET_EXHAUSTED" ? "The daily AI budget has been reached." : "AI request limit reached. Try again later."), { code: limit.code, status: limit.code === "BUDGET_EXHAUSTED" ? 503 : 429, retryAfterSec: limit.retryAfterSec });
  }
  const client = nl2sqlChatService.getClient();
  const model = freeTier ? nl2sqlChatService.resolveChatModel({ freeTier: true }) : config.NETWORK_PLANNER_MODEL || nl2sqlChatService.resolveChatModel({});
  const startedAt = Date.now();
  const ctx = { spec: spec && typeof spec === "object" ? normalizeSpec(spec).spec : null, specOk: false, near, language, emit, asked: false, territory: null, geometry: null, quality: null, requirements: requirements && typeof requirements === "object" ? requirements : null, maxLines: Number.isFinite(maxLines) ? maxLines : null };
  // A dossier the studio already loaded rides along as context (cached server-side).
  let territoryBlock = "";
  if (territoryPlace) {
    const cached = territoryService.getCachedTerritory(territoryPlace);
    if (cached) {
      ctx.territory = cached;
      ctx.near = ctx.near || { lat: cached.place.lat, lon: cached.place.lon };
      territoryBlock = territoryService.summarizeForModel(cached);
    }
  }
  const tools = createTools(ctx);
  // The specification documents attached to the conversation (uploaded once, referenced by id).
  const docs = briefDocuments.getDocuments(documentIds);
  if (docs.found.length || docs.missing.length) emit("step", { kind: "documents", count: docs.found.length, names: docs.found.map((d) => d.name), missing: docs.missing });
  const messages = buildMessages({ history, brief: text, spec: ctx.spec, language, near: ctx.near, territoryBlock, requirements: ctx.requirements, documents: docs.found });
  emit("meta", { model, mode: "planner" });
  const usageTotals = { input_tokens: 0, output_tokens: 0, cache_read_input_tokens: 0, cache_creation_input_tokens: 0 };
  let rounds = 0;
  let toolCalls = 0;
  let consecutiveErrors = 0;
  let truncations = 0;
  let finalText = "";
  try {
    for (;;) {
      if (signal?.aborted) {
        emit("done", { reason: "aborted" });
        return;
      }
      const round = await runRound({ client, model, messages, tools, signal, emit });
      rounds += 1;
      if (round.usage) for (const k of Object.keys(usageTotals)) usageTotals[k] += Number(round.usage[k]) || 0;
      finalText += round.content.filter((b) => b.type === "text").map((b) => b.text).join("");
      // A tool call cut off at the output limit has partial input: answer it without running it.
      if (round.stopReason === "max_tokens" && round.toolUses.length && truncations < MAX_TRUNCATIONS && rounds < MAX_ROUNDS) {
        truncations += 1;
        messages.push({ role: "assistant", content: round.content });
        messages.push({ role: "user", content: round.toolUses.map((tu) => ({ type: "tool_result", tool_use_id: tu.id, content: TRUNCATED_CALL, is_error: true })) });
        continue;
      }
      if (round.toolUses.length === 0 || round.stopReason !== "tool_use") break;
      messages.push({ role: "assistant", content: round.content });
      const results = [];
      for (const tu of round.toolUses) {
        toolCalls += 1;
        const tool = tools.byName[tu.name];
        let res;
        try {
          res = tool ? await tool.run(tu.input || {}) : { content: `Error: unknown tool ${tu.name}.`, isError: true };
        } catch (err) {
          res = { content: `Tool ${tu.name} failed: ${err.message}`, isError: true };
        }
        if (res.isError) consecutiveErrors += 1;
        else consecutiveErrors = 0;
        results.push({ type: "tool_result", tool_use_id: tu.id, content: res.content, ...(res.isError ? { is_error: true } : {}) });
      }
      const stop = rounds >= MAX_ROUNDS || consecutiveErrors >= MAX_CONSECUTIVE_ERRORS || ctx.asked;
      if (stop && !ctx.asked) {
        results[results.length - 1].content += rounds >= MAX_ROUNDS ? "\n\n[Tool budget exhausted: write your summary now with what you have.]" : "\n\n[Too many consecutive tool errors: write your summary now and list what is missing.]";
      }
      messages.push({ role: "user", content: results });
      if (ctx.asked) {
        // One short closing line after the questions, no more tools.
        const closing = await runRound({ client, model, messages, tools: { definitions: [] }, signal, emit });
        finalText += closing.content.filter((b) => b.type === "text").map((b) => b.text).join("");
        rounds += 1;
        break;
      }
      if (stop) {
        const closing = await runRound({ client, model, messages, tools: { definitions: [] }, signal, emit });
        finalText += closing.content.filter((b) => b.type === "text").map((b) => b.text).join("");
        rounds += 1;
        break;
      }
    }
    emit("usage", { rounds, toolCalls, ...usageTotals, durationMs: Date.now() - startedAt });
    // Ready: the plan can be projected (valid spec, every stop located, within the plan).
    const ready = Boolean(ctx.specOk && ctx.spec && !ctx.asked && !ctx.spec.stops.some((s) => s.lat == null) && (!Number.isFinite(ctx.maxLines) || ctx.spec.lines.length <= ctx.maxLines));
    const quality = ctx.quality ? { score: ctx.quality.score, grade: ctx.quality.grade, majors: ctx.quality.majors } : null;
    // Nothing to show (no text, no plan, no question): the studio says so instead of an empty turn.
    const empty = !finalText.trim() && !ctx.spec && !ctx.asked;
    emit("done", { reason: empty ? "empty" : "complete", specOk: ctx.specOk, asked: ctx.asked, ready, quality });
    recordEvent("network.plan", { ...(req ? extractReqMeta(req) : {}), model, rounds, toolCalls, specOk: ctx.specOk, asked: ctx.asked, ready, score: quality?.score ?? null, durationMs: Date.now() - startedAt, anon: freeTier });
    return { text: finalText, spec: ctx.spec, specOk: ctx.specOk, ready, quality: ctx.quality, requirements: ctx.requirements };
  } catch (err) {
    if (signal?.aborted) {
      emit("done", { reason: "aborted" });
      return;
    }
    throw err;
  }
};

module.exports = { planNetwork, buildSystemPrompt, _internals: { deps, createTools, buildMessages, MAX_ROUNDS } };
