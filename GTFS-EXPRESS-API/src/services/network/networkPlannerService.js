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
 * The model never writes GTFS rows. It calls tools: geocode_stops (real
 * coordinates), set_spec (validated by networkSpec → issues back to the
 * model until the spec is clean), estimate_routes (road distances and
 * running times), ask_user (questions when the brief is ambiguous). Every
 * event the UI needs streams over SSE: `token` (markdown), `tool_pending`,
 * `step`, `spec`, `geometry`, `questions`, `usage`, `error`, `done`.
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
const { haversineMeters } = require("../../utils/geoUtils");

const MAX_ROUNDS = 14;
const MAX_CONSECUTIVE_ERRORS = 4;
const MAX_TOKENS = 6000;
const MAX_BRIEF_CHARS = 60000;
const MAX_HISTORY = 20;
const LANG_NAMES = { en: "English", fr: "French", es: "Spanish", de: "German", pt: "Portuguese", zh: "Chinese", ar: "Arabic", hi: "Hindi" };

// Injectable for tests (no network).
const deps = { geocode: geocoderModule.geocode, createRouter: roadRouter.createRouter, buildTerritory: territoryService.buildTerritory };

const clip = (s, n) => (typeof s === "string" && s.length > n ? `${s.slice(0, n)}…` : s);

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
  "transfers"?: [ { "from", "to", "min_minutes" } ]
}
Limits: ≤ ${LIMITS.lines} lines, ≤ ${LIMITS.stops} stops, ≤ ${LIMITS.stopsPerDirection} stops per direction, ≤ ${LIMITS.trips} trips.

# Territory first
Real networks start from the ground: call get_territory with the town or area named in the brief (once; the dossier is cached) unless a [Territory] block is already in the message. It gives the timezone, the population, the EXISTING stops and stations from OpenStreetMap (reuse their names, coordinates and ids instead of geocoding — passengers know them), the existing transit lines (do not duplicate a line that already runs; connect to it), the trip generators (schools, hospitals, universities, stations, malls, stadiums, industrial areas) that the lines must serve, and the public and school holidays for the calendars. Use find_existing_stops to resolve a stop name mentioned in the brief before geocoding it. After set_spec, call coverage_score and improve the plan if major generators are unserved (add a stop or a via) — say what you left out and why.

# Method
1. Read the brief. Extract: operator (name, website, timezone from the country/city), area, lines (name, mode, termini, via stops, one-way loops), service (days, first/last departures, headways by period, explicit departures), holidays, constraints. Everything the brief states is law; do not "improve" it silently.
2. Stops need real coordinates: call geocode_stops with the stop names (add the city/area to each query) and \`near\` set to the area centre; take the candidate the tool marks as chosen unless the brief's context contradicts it. Never invent coordinates. If a stop cannot be geocoded, keep it in the spec without coordinates: the user places it on the map.
3. Call set_spec. Read the issues: fix every blocker (missing coordinates aside), then call set_spec again. Repeat until ok=true or only "stop_needs_coordinates" blockers remain.
4. Call estimate_routes once the coordinates are in: check the distances and running times are plausible for the mode (a 12 km urban bus line runs ~35–45 min). Adjust speed_kmh or the stop order when they are not.
5. Answer in markdown, in the user's language: a short summary of the network (lines, stops, service), the ASSUMPTIONS you made (headways, hours, calendar, speeds, colours) as a bullet list, and what the user should check. If something essential is genuinely ambiguous (two plausible orders of stops, no service hours at all, which town), call ask_user with 1–3 precise questions instead of guessing — but for ordinary gaps, choose a sensible default and state it.

# Defaults when the brief is silent
- Service: weekday 06:00–21:00, peak (07:00–09:00, 16:30–19:00) headway 15 min, off-peak 30 min; saturday 08:00–20:00 every 30 min; sunday 09:00–19:00 every 60 min. Shuttles/school lines: explicit departures.
- Modes and speeds: the compiler knows commercial speeds per mode; set speed_kmh only when the brief implies express or slow service.
- Feed dates: today → +1 year. Holidays: the territory's public holidays (dates from get_territory) with holiday_service "sunday" unless the brief says otherwise; when school holidays matter (school lines, reduced summer service) build a second calendar with days and dates.
- Agency timezone: the territory's timezone.
- Colours: one distinct colour per line; keep the brief's colours when given.
- Stop naming: proper case, no codes; termini names as headsigns.
- Ids: short and stable (line short name; stop slug); the compiler slugs missing ids.

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
      ctx.emit("geometry", geo);
      const lines = geo.lines.map((l) => `- ${l.short_name}: ${l.directions.map((d) => (d.routable ? `dir ${d.id} ${d.stops} stops, ${d.distance_km} km, ${d.running_min} min${d.fallback_legs ? ` (${d.fallback_legs} straight legs)` : ""}` : `dir ${d.id}: not routable (missing coordinates)`)).join("; ")}`);
      return { content: [`Routing: ${geo.routing}${geo.fallback_legs ? ` (${geo.fallback_legs} leg(s) fell back to straight lines)` : ""}.`, ...lines].join("\n") };
    },
  };

  const askUser = {
    definition: {
      name: "ask_user",
      description: "Ask the user 1–3 precise questions when the brief is genuinely ambiguous on something essential. Give options when you can. After calling it, end your turn: the answers come in the next message.",
      input_schema: {
        type: "object",
        properties: {
          questions: { type: "array", items: { type: "object", properties: { id: { type: "string" }, question: { type: "string" }, options: { type: "array", items: { type: "string" } } }, required: ["id", "question"] } },
        },
        required: ["questions"],
      },
    },
    run(input) {
      const qs = (Array.isArray(input?.questions) ? input.questions : []).filter((q) => q && typeof q.question === "string").slice(0, 3).map((q, i) => ({ id: String(q.id || `q${i + 1}`).slice(0, 32), question: clip(q.question.trim(), 300), options: Array.isArray(q.options) ? q.options.map((o) => clip(String(o), 80)).slice(0, 5) : [] }));
      if (!qs.length) return { content: "Error: questions[] is required.", isError: true };
      ctx.emit("questions", { questions: qs });
      ctx.asked = true;
      return { content: "Questions shown to the user. End your turn now with a one-line note; do not guess the answers." };
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
          `By category: ${Object.entries(c.by_category).map(([k, v]) => `${k} ${v.covered}/${v.total}`).join(", ") || "none"}.`,
          c.top_missed.length ? `Main unserved places: ${c.top_missed.map((m) => `${m.name} (${m.category}, ${m.lat.toFixed(5)},${m.lon.toFixed(5)})`).join("; ")}.` : "Every major generator is served.",
        ].join("\n"),
      };
    },
  };

  const tools = [getTerritory, findExistingStops, geocodeStops, setSpec, estimateRoutes, coverageScore, askUser];
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

const buildMessages = ({ history, brief, spec, language, near, territoryBlock = "" }) => {
  const msgs = [];
  for (const h of (history || []).slice(-MAX_HISTORY)) {
    if (!h || (h.role !== "user" && h.role !== "assistant")) continue;
    const text = clip(String(h.content || ""), 8000);
    if (!text.trim()) continue;
    if (msgs.length && msgs[msgs.length - 1].role === h.role) msgs[msgs.length - 1].content += `\n\n${text}`;
    else msgs.push({ role: h.role, content: text });
  }
  const blocks = [`[UI language: ${LANG_NAMES[language] || "English"}]`];
  if (near) blocks.push(`[Area hint] lat ${near.lat}, lon ${near.lon}`);
  if (territoryBlock) blocks.push(territoryBlock);
  if (spec) blocks.push(`[Current spec]\n${clip(JSON.stringify(spec), 40000)}`);
  blocks.push(brief);
  const text = blocks.join("\n\n");
  if (msgs.length && msgs[msgs.length - 1].role === "user") msgs[msgs.length - 1].content += `\n\n${text}`;
  else msgs.push({ role: "user", content: text });
  if (msgs[0].role !== "user") msgs.shift();
  return msgs;
};

/** The planner turn. Emits SSE-style events through `emit`. */
const planNetwork = async ({ brief, spec = null, history = [], language = "en", near = null, territoryPlace = null, freeTier = false, rateKey, aiLimits = {}, signal, emit, req = null }) => {
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
  const ctx = { spec: spec && typeof spec === "object" ? normalizeSpec(spec).spec : null, specOk: false, near, language, emit, asked: false, territory: null };
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
  const messages = buildMessages({ history, brief: text, spec: ctx.spec, language, near: ctx.near, territoryBlock });
  emit("meta", { model, mode: "planner" });
  const usageTotals = { input_tokens: 0, output_tokens: 0, cache_read_input_tokens: 0, cache_creation_input_tokens: 0 };
  let rounds = 0;
  let toolCalls = 0;
  let consecutiveErrors = 0;
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
    emit("done", { reason: "complete", specOk: ctx.specOk, asked: ctx.asked });
    recordEvent("network.plan", { ...(req ? extractReqMeta(req) : {}), model, rounds, toolCalls, specOk: ctx.specOk, asked: ctx.asked, durationMs: Date.now() - startedAt, anon: freeTier });
    return { text: finalText, spec: ctx.spec, specOk: ctx.specOk };
  } catch (err) {
    if (signal?.aborted) {
      emit("done", { reason: "aborted" });
      return;
    }
    throw err;
  }
};

module.exports = { planNetwork, buildSystemPrompt, _internals: { deps, createTools, buildMessages, MAX_ROUNDS } };
