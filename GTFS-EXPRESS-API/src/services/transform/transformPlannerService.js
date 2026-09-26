/**
 * transformPlannerService — a brief (service-change notice, cahier des
 * charges, a few sentences) → a CHANGE PLAN on the loaded feed, grounded by
 * tools and checked by the engine.
 *
 *   POST /gtfs/transform/plan   (SSE, gated like the chat; session required)
 *   { brief, plan?, messages?, language?, documents? }
 *
 * The model never writes GTFS rows. It reads the feed (lookup,
 * route_timetable), writes typed operations from the catalogue (set_plan,
 * patch_plan) — each citing the words of the brief it comes from — and
 * the engine previews them on a sandbox: steps applied or BLOCKED with the
 * questions the engine cannot answer from the feed, the semantic diff,
 * integrity, and the clauses the brief makes measurable. What the brief
 * does not say is either an explicit, recorded assumption or a question to
 * the user (ask_user) — never a silent guess.
 *
 * Events: meta, token, tool_pending, plan, preview, questions, usage, error,
 * done { ready, blocked, previewId }.
 */

"use strict";

const config = require("../../config");
const aiCostLimiter = require("../aiCostLimiter");
const nl2sqlChatService = require("../nl2sqlChatService");
const { recordEvent, extractReqMeta } = require("../eventLogger");
const briefDocuments = require("../network/briefDocumentService");
const registry = require("./operators");
const engine = require("./engine");
const R = require("./resolve");
const { buildFeedModel, routeStats, departures, _internals: fm } = require("./feedModel");
const references = require("./referenceFeeds");

const MAX_ROUNDS = 16;
const MAX_CONSECUTIVE_ERRORS = 4;
const MAX_TOKENS = 32000;
const MAX_BRIEF_CHARS = 60000;
const MAX_HISTORY = 20;
const MAX_OVERVIEW_ROUTES = 150;
const LANG_NAMES = { en: "English", fr: "French", es: "Spanish", de: "German", pt: "Portuguese", zh: "Chinese", ar: "Arabic", hi: "Hindi" };

// Injectable for tests.
const deps = { createRouter: () => require("../network/roadRouter").createRouter() };

const clip = (s, n) => (typeof s === "string" && s.length > n ? `${s.slice(0, n)}…` : s);
const hhmm = (s) => (s == null ? null : fm.secToTime(s).slice(0, 5));

// ── The catalogue, as the model reads it ────────────────────────────────────

const catalogueText = () =>
  registry
    .catalogue()
    .map((o) => {
      const params = (o.params || []).map((p) => `${p.name}${p.required ? "*" : ""}:${p.type}${p.enum ? `(${p.enum.join("|")})` : ""}`).join(", ");
      return `- ${o.type} [${o.category}] ${o.title}. ${o.description || ""}\n  params: ${params}\n  e.g. ${JSON.stringify(o.example || {})}`;
    })
    .join("\n");

/**
 * How real briefs map onto the catalogue (from service-change notices of
 * French and foreign networks, and the golden Albi cases): a brief, the
 * operations that implement it (placeholders in <>), and a note. A recipe
 * is shown only when every operator it uses is in the catalogue; a test
 * checks every parameter it names exists.
 */
const RECIPES = [
  { brief: "Un bus toutes les 10 min de 7h à 9h en période scolaire à partir du 2 novembre (contre 15 aujourd'hui)", steps: [{ type: "set_headway", params: { route: "<line>", days: "weekday", from: "07:00", to: "09:00", headway_min: 10, from_date: "2026-11-02", period: "school_days", region: "<zone>" } }], note: "Add a headway_max clause; the stated old value (15) is checked by an assert first when the catalogue has one." },
  { brief: "Les lignes X et Y circulent désormais le dimanche, de 9h à 19h, un départ par heure sur leur itinéraire principal", steps: [{ type: "copy_day_service", params: { routes: ["X", "Y"], from_day: "saturday", to_days: "sunday", from_date: "<date>" } }, { type: "set_headway", params: { route: "X", days: "sunday", from_date: "<date>", from: "09:00", to: "19:00", start: "09:00", headway_min: 60, patterns: "main_only" } }, { type: "set_span", params: { route: "X", days: "sunday", from_date: "<date>", first: "09:00", last: "18:00" } }], note: "set_headway and set_span for each line." },
  { brief: "Les jours fériés, ces lignes circulent comme le dimanche, sauf le 1er mai", steps: [{ type: "apply_holiday_rules", params: { routes: ["X", "Y"], rule: "sunday", period: "public_holidays", except: ["2027-05-01"] } }] },
  { brief: "Pendant les vacances scolaires, la ligne E circule en semaine selon ses horaires du samedi", steps: [{ type: "run_like", params: { routes: ["E"], like: "saturday", days: "weekday", period: "school_holidays", region: "<zone>" } }] },
  { brief: "Dernier départ à 21h30, un bus toutes les 30 min en soirée, du lundi au samedi", steps: [{ type: "set_span", params: { route: "<line>", days: ["mon", "tue", "wed", "thu", "fri", "sat"], last: "21:30", headway_min: 30 } }], note: "\"Premier départ à 6h30\" is first." },
  { brief: "Les courses limitées à A sont prolongées jusqu'à B ; horaires conservés aux arrêts desservis", steps: [{ type: "extend_route", params: { route: "<line>", beyond: "A", stops: ["<new stop 1>", "<…>", "B"], from_date: "<date>" } }] },
  { brief: "La desserte de X est supprimée : les courses sont limitées à Y", steps: [{ type: "truncate_route", params: { route: "<line>", at: "Y", drop: "X", from_date: "<date>" } }], note: "Only the patterns going beyond Y change." },
  { brief: "Travaux du … au … : arrêts A et B non desservis, arrêt provisoire C (lat, lon), temps de parcours inchangés", steps: [{ type: "reroute", params: { route: "<line>", from_stop: "<stop before A>", to_stop: "<stop after B>", via: [{ name: "C", lat: 0, lon: 0 }], from_date: "<date>", to_date: "<date>", mode: "absorb" } }], note: "One per line; where the two directions use different streets, one per direction (direction set, stops in that direction's order)." },
  { brief: "L'arrêt X n'est plus desservi par la ligne L ; nouvel arrêt Z (lat, lon) entre A et B", steps: [{ type: "remove_stop", params: { route: "L", stop: "X" } }, { type: "add_stop", params: { route: "L", stop: { name: "Z", lat: 0, lon: 0 }, after: "A", before: "B" } }], note: "A name standing for both sides of the street is fine: the engine takes each direction's side." },
  { brief: "La course de 7h40 au départ de A doit arriver à B à 7h50 (au lieu de 7h56)", steps: [{ type: "shift_trips", params: { route: "<line>", direction: "B", times: ["07:40"], at_stop: "A", target: { stop: "B", time: "07:50", event: "arrive", was: "07:56" } } }] },
  { brief: "Suppression de la course de 13h45 au départ de A ; ajout d'un départ à 7h37 de A vers B", steps: [{ type: "remove_trips", params: { route: "<line>", times: ["13:45"], at_stop: "A" } }, { type: "add_trips", params: { route: "<line>", direction: "B", days: "weekday", times: ["07:37"], at_stop: "A" } }], note: "Running times come from the nearest trip." },
  { brief: "La ligne R devient la ligne 5, en gris, texte blanc", steps: [{ type: "set_route_attributes", params: { changes: [{ route: "R", short_name: "5", color: "6E6E6E", text_color: "FFFFFF" }] } }], note: "With a date, whole_feed: true (GTFS cannot date a line's identity)." },
  { brief: "La ligne J est supprimée à compter du 4 janvier", steps: [{ type: "discontinue_route", params: { route: "J", from_date: "2027-01-04" } }] },
  { brief: "Prolonger les horaires jusqu'au 31 août", steps: [{ type: "extend_validity", params: { end_date: "2027-08-31", holidays: "public_holidays", holiday_rule: "sunday" } }] },
  { brief: "Après ces changements, refaire les services voitures", steps: [{ type: "rebuild_blocks", params: {} }], note: "Also when the preview shows block overlaps and the brief cares about vehicles." },
];
const recipesText = () =>
  RECIPES.filter((r) => r.steps.every((st) => registry.get(st.type)))
    .map((r) => `- "${r.brief}" → ${r.steps.map((st) => `${st.type} ${JSON.stringify(st.params)}`).join("; ")}${r.note ? `. ${r.note}` : ""}`)
    .join("\n");

const buildSystemPrompt = () => `You are the service-change planner of GTFS Express: a senior transit scheduler and GTFS expert. A transport authority or operator gives you a brief (a service-change notice, a contract amendment, a cahier des charges, or a few sentences) about THE FEED ALREADY LOADED. You turn it into a CHANGE PLAN: typed operations from the catalogue below, which the engine applies deterministically on a sandbox, previews and checks. You never write GTFS rows.

# Principles
1. The brief is the law. Every operation carries "source": { "quote": the exact words of the brief it implements (≤ 200 chars), "page"?, "document"? }. Do nothing the brief does not ask (no "improvements").
2. Never guess. Use the feed's real ids and names (lookup, route_timetable). When the brief does not say something an operation needs (the direction, the days, the stop a time refers to, the date it starts, the school zone, whether all trips or some…):
   - if the answer is conventional and low-impact, decide it and record it in "assumptions" (text, operation id, confidence low|medium|high);
   - otherwise leave the parameter out: the engine blocks the step and asks the user, with the options it knows. Do not invent coordinates, times or dates.
3. Scope: a change on some dates uses the scope parameters (days, from_date, to_date, dates, period, except, region) — "from 1 September" is from_date, "during the works from 20 Jan to 18 Jul" is from_date+to_date, "school days"/"school holidays"/"public holidays" are periods (the plan's "calendars" can define named periods with dates stated in the brief). Other dates keep the old timetable.
4. Measurable promises become clauses in "requirements.clauses" so the result is verified after the plan: headway_max {line, day, from, to, minutes}, span {line, day, first_before, last_after}, days {line, days}, no_service {line, days}, line_exists {line}, serves {place, line}, fleet_max {vehicles}… Give each clause the operation ids it relies on in the operation's "clauses".
5. When the brief states the CURRENT value ("from 12 to 14 minutes", "instead of 7:50"), add an "assert" operation before the change when the catalogue has one, so a plan written for another version of the feed fails loudly instead of doing the wrong thing.
6. Order: validity/calendar first, then line structure (create, extend, truncate, reroute, split, merge), then stops, then timetables (headways, spans, trips, running times), then connections, fares, attributes, asserts after.
7. After set_plan / patch_plan, read the preview. Fix what is YOUR mistake (a wrong id, a missing parameter the brief does state, a failed step). Leave the genuine questions to the user: call ask_user with them (reuse the engine's options) and stop. Do not loop more than needed.
8. Answer in the user's language, briefly: what the plan does, what you assumed, what you need.
9. Data that is not in the feed (another operator's trains, a school's bell times, counts) is never invented. Another operator's timetable loaded as a REFERENCE feed (listed in the context) is read with reference_timetable and aligned on with align_connections { with: { times, name } }, one step per day timetable; say when its validity does not cover the dates. Otherwise ask for it (ask_user: the operator's GTFS, e.g. on transport.data.gouv.fr, or the times themselves) and change nothing that depends on it.

# Recipes (how real briefs map onto the catalogue)
${recipesText()}

# Change plan (set_plan)
{ "title", "operations": [{ "id": "op1", "type", "params": {…}, "source": { "quote", "page"? }, "clauses"?: [clause ids], "note"? }],
  "requirements"?: { "clauses": [{ "id", "kind", "level": "must"|"should", "text", "params": {…} }] },
  "calendars"?: { "<name>": { "from", "to" } | { "dates": [...] } | { "ranges": [{ "from", "to" }] } },
  "costs"?: { "cost_per_km", "cost_per_hour", "currency" },   // when the brief states them: the impact (km, hours, cost, fleet) uses them
  "assumptions"?: [{ "text", "operation"?, "confidence" }] }
The preview also gives the IMPACT: commercial km, service hours and cost over the real running days, vehicles at peak, stops that lose service, and "major service change" flags. When the brief sets a budget or a fleet cap, check it there (and add a fleet_max / budget_max clause).
Dates YYYY-MM-DD, times HH:MM (may exceed 24:00 for after-midnight trips of the same service day).

# Operation catalogue (* = required)
${catalogueText()}
`;

let _prompt = null;
let _promptOps = null;
const systemPrompt = () => {
  const names = registry.names().join(",");
  if (!_prompt || _promptOps !== names) {
    _prompt = buildSystemPrompt();
    _promptOps = names;
  }
  return _prompt;
};

// ── The feed, as the model reads it ─────────────────────────────────────────

const DAY_TYPES = [
  ["weekday", ["tue", "mon", "wed", "thu", "fri"]],
  ["saturday", ["sat"]],
  ["sunday", ["sun"]],
];

const feedOverview = (model) => {
  const lines = [];
  lines.push(`[Loaded feed] ${model.counts.routes} lines, ${model.counts.stops} stops, ${model.counts.trips} trips, ${model.counts.services} services. Validity ${model.range ? `${model.range.start} → ${model.range.end}` : "unknown"}. Representative dates: ${Object.entries(model.representative).map(([k, v]) => `${k} ${v}`).join(", ")}.`);
  if (model.feedInfo) lines.push(`[feed_info] ${clip(JSON.stringify(model.feedInfo), 300)}`);
  lines.push("[Lines] id | short | long name | mode | termini | patterns | weekday trips first–last, peak headway | sat | sun");
  const routes = [...model.routes.values()].sort((a, b) => String(a.short_name || a.id).localeCompare(String(b.short_name || b.id), undefined, { numeric: true }));
  for (const r of routes.slice(0, MAX_OVERVIEW_ROUTES)) {
    const main = r.patterns[0];
    const termini = main ? `${model.stops.get(main.stops[0])?.name || "?"} ↔ ${model.stops.get(main.stops[main.stops.length - 1])?.name || "?"}` : "no trips";
    const days = DAY_TYPES.map(([label, dows]) => {
      const date = dows.map((d) => model.representative[d]).find(Boolean);
      if (!date) return `${label} -`;
      const s = routeStats(model, r.id, date);
      if (!s.trips) return `${label} none`;
      const d0 = Object.values(s.directions)[0];
      return label === "weekday" ? `${s.trips} ${d0?.first?.slice(0, 5) || "?"}–${d0?.last?.slice(0, 5) || "?"}, am ${d0?.headways?.am_peak ?? "-"} min` : `${s.trips}`;
    });
    lines.push(`${r.id} | ${r.short_name} | ${clip(r.long_name, 60)} | ${r.mode} | ${termini} | ${r.patterns.length} | ${days.join(" | ")}`);
  }
  if (routes.length > MAX_OVERVIEW_ROUTES) lines.push(`… and ${routes.length - MAX_OVERVIEW_ROUTES} more lines: use lookup.`);
  return lines.join("\n");
};

// ── Tools ───────────────────────────────────────────────────────────────────

const OPERATION_SCHEMA = {
  type: "object",
  properties: {
    id: { type: "string" },
    type: { type: "string" },
    params: { type: "object" },
    source: { type: "object", properties: { quote: { type: "string" }, page: { type: "number" }, document: { type: "string" } } },
    clauses: { type: "array", items: { type: "string" } },
    note: { type: "string" },
  },
  required: ["id", "type", "params"],
};

const summarizePreview = (p) => {
  const out = [];
  out.push(`Preview: ${p.steps.filter((s) => s.status === "applied").length} applied, ${p.steps.filter((s) => s.status === "blocked").length} blocked, ${p.steps.filter((s) => s.status === "failed").length} failed, ${p.steps.filter((s) => s.status === "skipped").length} skipped.`);
  for (const s of p.steps) {
    let line = `- ${s.id} ${s.type}: ${s.status}`;
    if (s.summary) line += ` — ${s.summary}`;
    if (s.error) line += ` — ERROR: ${s.error}`;
    for (const a of s.ambiguities || []) line += `\n    ? ${a.param}: [${a.code}] ${a.message}${a.options ? ` options: ${a.options.slice(0, 8).join(" | ")}` : ""}`;
    for (const w of (s.warnings || []).slice(0, 4)) line += `\n    ! ${clip(w, 200)}`;
    out.push(line);
  }
  if (p.lines?.length) out.push(`Changes:\n${p.lines.slice(0, 40).map((l) => `  ${l}`).join("\n")}${p.lines.length > 40 ? `\n  … ${p.lines.length - 40} more` : ""}`);
  if (p.integrity?.length) out.push(`Integrity problems introduced: ${p.integrity.map((i) => `${i.code} ×${i.count}`).join(", ")}`);
  if (p.checks?.length) out.push(`Consumer checks made worse (Google-style): ${p.checks.map((c) => `${c.code} ${c.before} → ${c.count}${c.examples?.[0] ? ` e.g. ${JSON.stringify(c.examples[0])}` : ""}`).join("; ")}`);
  const im = p.impact;
  if (im && im.totals) out.push(`Impact (${im.window.days} running days): km ${im.totals.km.before} → ${im.totals.km.after} (${im.totals.km.pct ?? 0}%), hours ${im.totals.hours.before} → ${im.totals.hours.after}, cost ${im.totals.cost.before} → ${im.totals.cost.after} ${im.currency}, vehicles at peak ${im.totals.fleet.before} → ${im.totals.fleet.after}${im.stops.lost.length ? `; stops no longer served: ${im.stops.lost.map((s) => s.name).slice(0, 10).join(", ")}` : ""}${im.flags.filter((f) => f.code !== "stop_unserved").length ? `; major-change flags: ${im.flags.filter((f) => f.code !== "stop_unserved").map((f) => `${f.code} ${f.label || ""}`).join(", ")}` : ""}`);
  const res = p.conformance?.after?.results || [];
  if (res.length) out.push(`Clauses after the plan: ${res.map((r) => `${r.id} ${r.status}${r.status !== "pass" ? ` (expected ${r.expected}, measured ${r.measured})` : ""}`).join("; ")}`);
  return out.join("\n");
};

const createTools = (ctx) => {
  const lookup = {
    definition: {
      name: "lookup",
      description: "Find lines and stops of the loaded feed by what the brief calls them. routes: names/numbers to resolve (returns id, names, termini, patterns). stops: [{ query, route? }] (returns every matching stop with id, name, parent station, lines serving it). route_stops: a line → its patterns with their stops in order.",
      input_schema: {
        type: "object",
        properties: {
          routes: { type: "array", items: { type: "string" } },
          stops: { type: "array", items: { type: "object", properties: { query: { type: "string" }, route: { type: "string" } }, required: ["query"] } },
          route_stops: { type: "string" },
        },
      },
    },
    run(input) {
      const m = ctx.model;
      const out = [];
      for (const q of (input.routes || []).slice(0, 20)) {
        const r = R.route(m, q);
        if (r.value) {
          const pats = r.value.patterns.slice(0, 4).map((p) => `dir ${p.direction_id}: ${m.stops.get(p.stops[0])?.name} → ${m.stops.get(p.stops[p.stops.length - 1])?.name} (${p.stops.length} stops, ${p.trips.length} trips)`);
          out.push(`route "${q}" → ${r.value.id} (${R.routeLabel(r.value)}, ${r.value.mode}); patterns: ${pats.join("; ")}${r.value.patterns.length > 4 ? `; +${r.value.patterns.length - 4} more` : ""}`);
        } else out.push(`route "${q}" → ${r.ambiguity.code}: ${r.ambiguity.message}${r.ambiguity.options ? ` [${r.ambiguity.options.slice(0, 10).join(" | ")}]` : ""}`);
      }
      const servedBy = (id) => [...new Set([...m.patterns.values()].filter((p) => p.stops.includes(id)).map((p) => m.routes.get(p.route_id)?.short_name || p.route_id))];
      for (const s of (input.stops || []).slice(0, 30)) {
        const q = String(s.query || "");
        const route = s.route ? R.route(m, s.route).value : null;
        const k = q.toLowerCase();
        const hits = [...m.stops.values()].filter((x) => x.id === q || String(x.name).toLowerCase() === k || (k.length >= 3 && String(x.name).toLowerCase().includes(k))).slice(0, 12);
        const ranked = route ? hits.sort((a, b) => Number(servedBy(b.id).includes(route.short_name || route.id)) - Number(servedBy(a.id).includes(route.short_name || route.id))) : hits;
        out.push(`stop "${q}"${route ? ` (line ${route.short_name || route.id})` : ""} → ${ranked.length ? ranked.map((x) => `${x.id} "${x.name}"${x.location_type === "1" ? " [station]" : ""}${x.parent ? ` parent ${x.parent}` : ""} lines ${servedBy(x.id).join(",") || "none"}`).join("; ") : "no match"}`);
      }
      if (input.route_stops) {
        const r = R.route(m, input.route_stops);
        if (r.value) for (const p of r.value.patterns.slice(0, 6)) out.push(`${r.value.short_name || r.value.id} dir ${p.direction_id} (${p.trips.length} trips): ${p.stops.map((id) => `${m.stops.get(id)?.name || id} [${id}]`).join(" → ")}`);
        else out.push(`route "${input.route_stops}" → ${r.ambiguity.message}`);
      }
      return { content: out.join("\n") || "Nothing asked." };
    },
  };

  const routeTimetable = {
    definition: {
      name: "route_timetable",
      description: "The timetable of a line on a day type (weekday, saturday, sunday, a weekday name or a YYYYMMDD date): per direction trips, first/last departure, headway per period (early, am_peak, midday, pm_peak, evening), running time, and the departures at the origin.",
      input_schema: { type: "object", properties: { route: { type: "string" }, day: { type: "string" } }, required: ["route"] },
    },
    run(input) {
      const m = ctx.model;
      const r = R.route(m, input.route);
      if (!r.value) return { content: `${r.ambiguity.code}: ${r.ambiguity.message}`, isError: true };
      const day = String(input.day || "weekday").toLowerCase();
      const dows = DAY_TYPES.find(([k]) => k === day)?.[1] || (R.DOW.includes(day.slice(0, 3)) ? [day.slice(0, 3)] : null);
      const date = /^\d{8}$/.test(day) ? day : (dows || []).map((d) => m.representative[d]).find(Boolean);
      if (!date) return { content: `No representative date for "${input.day}".`, isError: true };
      const s = routeStats(m, r.value.id, date);
      const deps = departures(m, r.value.id, date);
      const out = [`Line ${r.value.short_name || r.value.id} on ${date} (${day}): ${s.trips} trips, ${s.vehicles_peak} vehicles at peak.`];
      for (const [dir, d] of Object.entries(s.directions)) {
        const times = (deps.get(dir) || []).map(hhmm);
        out.push(`dir ${dir}: ${d.trips} trips ${d.first?.slice(0, 5)}–${d.last?.slice(0, 5)}, headways ${JSON.stringify(d.headways)}, running ${d.running_min} min. Departures: ${times.length > 120 ? `${times.slice(0, 120).join(" ")} … (+${times.length - 120})` : times.join(" ")}`);
      }
      return { content: out.join("\n") };
    },
  };

  // Other operators' timetables loaded next to the feed (references).
  const referenceTimetable = {
    definition: {
      name: "reference_timetable",
      description: "The calls at a station in a REFERENCE feed (another operator's timetable loaded next to this feed, e.g. the regional trains): departures (or arrivals) of the trips going on to `towards` (or coming from it, for arrivals), per date asked (YYYY-MM-DD) or typical day (weekday, saturday, sunday), within from–to. It says when the reference's validity does not cover the dates. Feed these times to align_connections as with: { times, name }, one step per day timetable.",
      input_schema: {
        type: "object",
        properties: { reference: { type: "string", description: "Reference id or name (default: the only one)." }, stop: { type: "string" }, towards: { type: "string" }, event: { type: "string", enum: ["depart", "arrive"] }, day: { type: "string" }, dates: { type: "array", items: { type: "string" } }, from: { type: "string" }, to: { type: "string" } },
        required: ["stop"],
      },
    },
    run(input) {
      const refs = ctx.sessionId ? references.listReferences(ctx.sessionId) : [];
      if (!refs.length) return { content: "No reference feed is loaded for this session: ask the user for the other operator's GTFS (a public URL, e.g. on transport.data.gouv.fr) to add as a reference, or for the times themselves. Change nothing that depends on them.", isError: true };
      const want = String(input.reference || "").toLowerCase();
      const ref = refs.find((r) => r.id === input.reference) || refs.find((r) => want && r.name.toLowerCase().includes(want)) || (refs.length === 1 ? refs[0] : null);
      if (!ref) return { content: `Which reference? ${refs.map((r) => `${r.id} (${r.name})`).join(", ")}`, isError: true };
      try {
        const out = references.referenceDepartures(ctx.sessionId, ref.id, { stop: input.stop, towards: input.towards || null, event: input.event === "arrive" ? "arrive" : "depart", day: input.day || "weekday", dates: Array.isArray(input.dates) ? input.dates : null, from: input.from || null, to: input.to || null });
        const lines = [`Reference "${ref.name}" (validity ${out.validity ? `${out.validity.start}–${out.validity.end}` : "none"}), ${out.event === "arrive" ? "arrivals" : "departures"} at ${out.stop.join(" / ")}${out.towards ? ` ${out.event === "arrive" ? "from" : "towards"} ${out.towards}` : ""}:`];
        for (const d of out.days) lines.push(`- ${d.asked || d.day} (times of ${d.date || "no date"}): ${d.times.join(" ") || "none"}`);
        for (const w of out.warnings) lines.push(`! ${w}`);
        return { content: lines.join("\n") };
      } catch (err) {
        return { content: `${err.code || "ERROR"}: ${err.message}`, isError: true };
      }
    },
  };

  const runPreview = async () => {
    const p = await engine.previewPlan(ctx.db, ctx.plan, { sessionId: ctx.sessionId, dataVersion: ctx.dataVersion, router: ctx.router, country: ctx.country, fetchImpl: ctx.fetchImpl });
    ctx.preview = p;
    ctx.emit("plan", ctx.plan);
    ctx.emit("preview", p);
    return p;
  };

  const validatePlan = (plan) => {
    const errors = [];
    const ids = new Set();
    for (const op of plan.operations) {
      if (!op || typeof op !== "object") {
        errors.push("an operation is not an object");
        continue;
      }
      if (!op.id) errors.push(`an operation of type ${op.type} has no id`);
      else if (ids.has(op.id)) errors.push(`operation id ${op.id} is used twice`);
      ids.add(op.id);
      if (!registry.get(op.type)) errors.push(`${op.id}: unknown type "${op.type}" (known: ${registry.names().join(", ")})`);
      if (!op.source?.quote) errors.push(`${op.id}: no source.quote (cite the brief)`);
    }
    return errors;
  };

  const setPlan = {
    definition: {
      name: "set_plan",
      description: "Write the whole change plan (replaces the previous one). The engine previews it on a sandbox of the loaded feed and returns each step's status (applied / blocked with questions / failed), the semantic diff, integrity problems and the clauses after the plan.",
      input_schema: {
        type: "object",
        properties: {
          title: { type: "string" },
          operations: { type: "array", items: OPERATION_SCHEMA },
          requirements: { type: "object" },
          calendars: { type: "object" },
          costs: { type: "object", properties: { cost_per_km: { type: "number" }, cost_per_hour: { type: "number" }, currency: { type: "string" } } },
          assumptions: { type: "array", items: { type: "object", properties: { text: { type: "string" }, operation: { type: "string" }, confidence: { type: "string" } }, required: ["text"] } },
        },
        required: ["title", "operations"],
      },
    },
    async run(input) {
      const plan = { title: String(input.title || "").slice(0, 160), operations: Array.isArray(input.operations) ? input.operations.slice(0, 100) : [], ...(input.requirements ? { requirements: input.requirements } : {}), ...(input.calendars ? { calendars: input.calendars } : {}), ...(input.costs ? { costs: input.costs } : {}), assumptions: Array.isArray(input.assumptions) ? input.assumptions.slice(0, 40) : [] };
      const errors = validatePlan(plan);
      if (errors.length) return { content: `Plan refused:\n- ${errors.join("\n- ")}`, isError: true };
      ctx.plan = plan;
      ctx.planChanged = true;
      const p = await runPreview();
      return { content: summarizePreview(p) };
    },
  };

  const patchPlan = {
    definition: {
      name: "patch_plan",
      description: "Change part of the current plan: upsert operations by id (the whole operation), remove ids, move an id before another, replace title / requirements / calendars / assumptions. Previews again.",
      input_schema: {
        type: "object",
        properties: {
          upsert: { type: "array", items: OPERATION_SCHEMA },
          remove: { type: "array", items: { type: "string" } },
          before: { type: "object", description: "{ id: the id to insert before } for upserted NEW operations (default: at the end)." },
          title: { type: "string" },
          requirements: { type: "object" },
          calendars: { type: "object" },
          costs: { type: "object" },
          assumptions: { type: "array", items: { type: "object" } },
        },
      },
    },
    async run(input) {
      if (!ctx.plan) return { content: "No plan yet: call set_plan first.", isError: true };
      const plan = JSON.parse(JSON.stringify(ctx.plan));
      const remove = new Set(input.remove || []);
      plan.operations = plan.operations.filter((o) => !remove.has(o.id));
      for (const op of input.upsert || []) {
        const i = plan.operations.findIndex((o) => o.id === op.id);
        if (i >= 0) plan.operations[i] = op;
        else {
          const at = input.before?.id ? plan.operations.findIndex((o) => o.id === input.before.id) : -1;
          if (at >= 0) plan.operations.splice(at, 0, op);
          else plan.operations.push(op);
        }
      }
      for (const k of ["title", "requirements", "calendars", "costs", "assumptions"]) if (input[k] !== undefined) plan[k] = input[k];
      const errors = validatePlan(plan);
      if (errors.length) return { content: `Patch refused:\n- ${errors.join("\n- ")}`, isError: true };
      ctx.plan = plan;
      ctx.planChanged = true;
      const p = await runPreview();
      return { content: summarizePreview(p) };
    },
  };

  const askUser = {
    definition: {
      name: "ask_user",
      description: "Ask the user what only they can decide (the engine's blocked questions, or what the brief leaves open with a real impact). Each question: text, options (when enumerable), the operation and parameter it answers, and your recommended default. The turn ends after this call.",
      input_schema: {
        type: "object",
        properties: {
          questions: {
            type: "array",
            items: { type: "object", properties: { id: { type: "string" }, text: { type: "string" }, options: { type: "array", items: { type: "string" } }, operation: { type: "string" }, param: { type: "string" }, default: { type: "string" } }, required: ["text"] },
          },
        },
        required: ["questions"],
      },
    },
    run(input) {
      const qs = (input.questions || []).slice(0, 12);
      ctx.asked = true;
      ctx.emit("questions", { questions: qs });
      return { content: `${qs.length} question(s) shown to the user. End your turn with one short sentence.` };
    },
  };

  const tools = [lookup, routeTimetable, referenceTimetable, setPlan, patchPlan, askUser];
  return { definitions: tools.map((t) => t.definition), byName: Object.fromEntries(tools.map((t) => [t.definition.name, t])) };
};

// ── Model loop ──────────────────────────────────────────────────────────────

const supportsEffort = (model) => /^claude-(opus|sonnet|fable|mythos)-(4-[678]|5)/.test(String(model || ""));

const runRound = async ({ client, model, messages, tools, signal, emit, toolChoice = null }) => {
  const effort = config.NETWORK_PLANNER_EFFORT;
  const stream = client.messages.stream(
    {
      model,
      max_tokens: MAX_TOKENS,
      system: [{ type: "text", text: systemPrompt(), cache_control: { type: "ephemeral" } }],
      tools: tools.definitions,
      ...(toolChoice ? { tool_choice: toolChoice } : {}),
      ...(effort && supportsEffort(model) ? { output_config: { effort } } : {}),
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

const NO_ANSWER = "(No answer: that turn did not complete.)";

const buildMessages = ({ history, brief, plan, preview, overview, language, documents = [], context = [] }) => {
  const msgs = [];
  for (const h of (history || []).slice(-MAX_HISTORY)) {
    if (!h || (h.role !== "user" && h.role !== "assistant")) continue;
    const text = clip(String(h.content || ""), 8000);
    if (!text.trim()) continue;
    const prev = msgs[msgs.length - 1];
    if (prev && prev.role === h.role) {
      if (h.role === "user") msgs.push({ role: "assistant", content: NO_ANSWER }, { role: "user", content: text });
      else prev.content += `\n\n${text}`;
    } else msgs.push({ role: h.role, content: text });
  }
  const blocks = [`[UI language: ${LANG_NAMES[language] || "English"}]`, ...context, overview];
  if (documents.length) blocks.push(`[Attached documents] ${documents.map((d) => `"${d.name}"${d.pages ? ` (${d.pages} pages)` : ""}${d.truncated ? " (truncated)" : ""}`).join(", ")} — the brief: read them entirely; cite their pages in source.page.`);
  if (plan) blocks.push(`[Current plan]\n${clip(JSON.stringify(plan), 30000)}`);
  if (preview) blocks.push(`[Last preview]\n${clip(summarizePreview(preview), 8000)}`);
  blocks.push(brief);
  if (msgs.length && msgs[msgs.length - 1].role === "user") msgs.push({ role: "assistant", content: NO_ANSWER });
  msgs.push({ role: "user", content: blocks.join("\n\n") });
  if (msgs[0].role !== "user") msgs.shift();
  if (documents.length) {
    const last = msgs[msgs.length - 1];
    last.content = [...briefDocuments.toContentBlocks(documents), { type: "text", text: last.content }];
  }
  return msgs;
};

/** One planner turn on a session's feed. Emits SSE-style events through `emit`. */
const planChanges = async ({ db, sessionId = null, dataVersion = null, country = null, fetchImpl = null, brief, plan = null, history = [], language = "en", documentIds = [], freeTier = false, rateKey, aiLimits = {}, signal, emit, req = null }) => {
  const text = String(brief || "").trim();
  if (text.length < 3) throw Object.assign(new Error("brief is required (≥ 3 characters)."), { code: "INVALID_INPUT", status: 400 });
  if (text.length > MAX_BRIEF_CHARS) throw Object.assign(new Error(`brief is too long (max ${MAX_BRIEF_CHARS} characters).`), { code: "INVALID_INPUT", status: 400 });
  const limit = aiCostLimiter.check({ key: rateKey || "anon", scope: "chat", ...aiLimits });
  if (!limit.ok) throw Object.assign(new Error(limit.code === "BUDGET_EXHAUSTED" ? "The daily AI budget has been reached." : "AI request limit reached. Try again later."), { code: limit.code, status: limit.code === "BUDGET_EXHAUSTED" ? 503 : 429, retryAfterSec: limit.retryAfterSec });
  const client = nl2sqlChatService.getClient();
  const model = freeTier ? nl2sqlChatService.resolveChatModel({ freeTier: true }) : config.TRANSFORM_PLANNER_MODEL || config.NETWORK_PLANNER_MODEL || nl2sqlChatService.resolveChatModel({});
  const startedAt = Date.now();
  const feedModel = buildFeedModel(db);
  const ctx = { db, sessionId, dataVersion, country, fetchImpl, model: feedModel, plan: plan && Array.isArray(plan.operations) ? plan : null, planChanged: false, preview: null, asked: false, emit, router: deps.createRouter() };
  const tools = createTools(ctx);
  const docs = briefDocuments.getDocuments(documentIds);
  const context = [`[Today] ${new Date().toISOString().slice(0, 10)}`];
  if (country) context.push(`[Country] ${country} (public and school holidays can be named periods)`);
  const refs = sessionId ? references.listReferences(sessionId) : [];
  if (refs.length) context.push(`[Reference feeds] ${refs.map((r) => `${r.id} "${r.name}" (${r.agencies.join(", ") || "?"}; ${r.counts.trips} trips near the network; validity ${r.validity ? `${r.validity.start}–${r.validity.end}` : "?"})`).join("; ")} — read them with reference_timetable.`);
  if (docs.missing.length) context.push(`[Documents] ${docs.missing.length} attached document(s) expired on the server and are NOT in this message: say so; do not guess their content.`);
  if (docs.found.length) emit("step", { kind: "documents", count: docs.found.length, names: docs.found.map((d) => d.name) });
  // The current plan is previewed again: the model sees where it stands.
  let preview = null;
  if (ctx.plan) {
    preview = await engine.previewPlan(db, ctx.plan, { sessionId, dataVersion, router: ctx.router, country, fetchImpl });
    ctx.preview = preview;
  }
  const messages = buildMessages({ history, brief: text, plan: ctx.plan, preview, overview: feedOverview(feedModel), language, documents: docs.found, context });
  emit("meta", { model, mode: "transform" });
  const usageTotals = { input_tokens: 0, output_tokens: 0, cache_read_input_tokens: 0, cache_creation_input_tokens: 0 };
  const addUsage = (u) => {
    if (u) for (const k of Object.keys(usageTotals)) usageTotals[k] += Number(u[k]) || 0;
  };
  let rounds = 0;
  let toolCalls = 0;
  let consecutiveErrors = 0;
  let incomplete = null;
  let finalText = "";
  try {
    for (;;) {
      if (signal?.aborted) {
        emit("done", { reason: "aborted" });
        return null;
      }
      const round = await runRound({ client, model, messages, tools, signal, emit });
      rounds += 1;
      addUsage(round.usage);
      finalText += round.content.filter((b) => b.type === "text").map((b) => b.text).join("");
      if (round.stopReason === "refusal") {
        incomplete = "REFUSAL";
        emit("error", { code: "REFUSAL", message: "The model declined this request." });
        break;
      }
      if (round.stopReason === "max_tokens") {
        incomplete = "OUTPUT_LIMIT";
        emit("error", { code: "OUTPUT_LIMIT", message: "The plan is too large to be written in one go: split the brief." });
        break;
      }
      if (!round.toolUses.length || round.stopReason !== "tool_use") break;
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
        consecutiveErrors = res.isError ? consecutiveErrors + 1 : 0;
        results.push({ type: "tool_result", tool_use_id: tu.id, content: res.content, ...(res.isError ? { is_error: true } : {}) });
      }
      const stop = rounds >= MAX_ROUNDS || consecutiveErrors >= MAX_CONSECUTIVE_ERRORS || ctx.asked;
      if (stop && !ctx.asked) results[results.length - 1].content += rounds >= MAX_ROUNDS ? "\n\n[Tool budget exhausted: summarise now.]" : "\n\n[Too many consecutive tool errors: summarise now and say what is missing.]";
      messages.push({ role: "user", content: results });
      if (stop) {
        const closing = await runRound({ client, model, messages, tools, signal, emit, toolChoice: { type: "none" } });
        addUsage(closing.usage);
        finalText += closing.content.filter((b) => b.type === "text").map((b) => b.text).join("");
        rounds += 1;
        break;
      }
    }
    emit("usage", { rounds, toolCalls, ...usageTotals, durationMs: Date.now() - startedAt });
    const p = ctx.preview;
    const failing = (p?.conformance?.after?.results || []).filter((r) => r.level === "must" && r.status === "fail");
    const ready = Boolean(p && p.id && !p.blocked && !(p.integrity || []).length && !failing.length && !incomplete);
    emit("done", { reason: incomplete ? "incomplete" : "complete", ready, blocked: Boolean(p?.blocked), previewId: p?.id || null, asked: ctx.asked, planChanged: ctx.planChanged, failingClauses: failing.map((r) => r.id) });
    recordEvent("transform.plan", { ...(req ? extractReqMeta(req) : {}), model, rounds, toolCalls, operations: ctx.plan?.operations?.length || 0, blocked: Boolean(p?.blocked), ready, asked: ctx.asked, incomplete, ...usageTotals, durationMs: Date.now() - startedAt, anon: freeTier });
    return { text: finalText, plan: ctx.plan, preview: p, ready };
  } catch (err) {
    recordEvent("transform.plan", { ...(req ? extractReqMeta(req) : {}), model, rounds, toolCalls, error: err.code || err.name || "error", ...usageTotals, durationMs: Date.now() - startedAt, anon: freeTier });
    if (signal?.aborted) {
      emit("done", { reason: "aborted" });
      return null;
    }
    throw err;
  }
};

module.exports = { planChanges, buildSystemPrompt, feedOverview, summarizePreview, _internals: { deps, createTools, buildMessages, MAX_ROUNDS, RECIPES } };
