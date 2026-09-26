/**
 * resolve — turning the words of a brief into entities of the feed, or
 * saying why it cannot, never guessing.
 *
 * Every resolver returns { value } or { ambiguity: { code, message, options? } }:
 *   route(model, ref)            "L3", "3", a route_id, a long name ("Gare ↔ Hôpital")
 *   stop(model, ref, opts)       a stop_id, a name (possibly served by a given route), or { lat, lon }
 *   direction(model, routeId, ref) "0" | "1" | "both" | a headsign / terminus name
 *   days(ref)                    "weekday" | "saturday" | ["mon", …] | "school_days" …
 *   window(from, to)             "07:00"–"09:00" → seconds
 *
 * An ambiguity is data: the engine blocks the step and shows the question
 * with its options; nothing runs until the user answers.
 */

"use strict";

const { nameKey } = require("../network/networkSpec")._internals;

const DOW = ["mon", "tue", "wed", "thu", "fri", "sat", "sun"];
const DAY_WORDS = {
  weekday: ["mon", "tue", "wed", "thu", "fri"], weekdays: ["mon", "tue", "wed", "thu", "fri"], semaine: ["mon", "tue", "wed", "thu", "fri"], "lundi-vendredi": ["mon", "tue", "wed", "thu", "fri"], monfri: ["mon", "tue", "wed", "thu", "fri"],
  saturday: ["sat"], samedi: ["sat"], sunday: ["sun"], dimanche: ["sun"], weekend: ["sat", "sun"], "week-end": ["sat", "sun"],
  daily: DOW, everyday: DOW, "tous les jours": DOW, monsat: ["mon", "tue", "wed", "thu", "fri", "sat"], "lundi-samedi": ["mon", "tue", "wed", "thu", "fri", "sat"],
};
const DAY_ALIASES = { monday: "mon", lundi: "mon", tuesday: "tue", mardi: "tue", wednesday: "wed", mercredi: "wed", thursday: "thu", jeudi: "thu", friday: "fri", vendredi: "fri", saturday: "sat", samedi: "sat", sunday: "sun", dimanche: "sun" };

const str = (v) => (typeof v === "string" ? v.trim() : v == null ? "" : String(v).trim());
const amb = (code, message, options = null) => ({ ambiguity: { code, message, ...(options && options.length ? { options: options.slice(0, 12) } : {}) } });
const timeToSec = (t) => {
  const m = /^(\d{1,2})(?::|h)(\d{2})?(?::(\d{2}))?$/i.exec(str(t));
  if (!m) return null;
  const h = parseInt(m[1], 10);
  const mi = m[2] ? parseInt(m[2], 10) : 0;
  return mi > 59 ? null : h * 3600 + mi * 60 + (m[3] ? parseInt(m[3], 10) : 0);
};

const routeLabel = (r) => `${r.short_name || r.id}${r.long_name ? ` — ${r.long_name}` : ""}`;

const route = (model, ref) => {
  const raw = str(ref && typeof ref === "object" ? ref.id || ref.short_name || ref.name : ref);
  if (!raw) return amb("route_missing", "Which line?", [...model.routes.values()].map(routeLabel));
  if (model.routes.has(raw)) return { value: model.routes.get(raw) };
  const k = nameKey(raw.replace(/^(ligne|line|route|l)\s*/i, ""));
  const all = [...model.routes.values()];
  let hits = all.filter((r) => nameKey(r.short_name) === k);
  if (!hits.length) hits = all.filter((r) => nameKey(r.id) === k);
  if (!hits.length) hits = all.filter((r) => nameKey(r.long_name) === nameKey(raw));
  if (!hits.length) hits = all.filter((r) => r.long_name && nameKey(r.long_name).includes(nameKey(raw)) && nameKey(raw).length >= 4);
  if (hits.length === 1) return { value: hits[0] };
  if (hits.length > 1) return amb("route_ambiguous", `"${raw}" matches several lines.`, hits.map(routeLabel));
  return amb("route_unknown", `No line "${raw}" in the feed.`, all.map(routeLabel));
};

const stopsOfRoute = (model, routeId) => {
  const ids = new Set();
  for (const p of model.patterns.values()) if (p.route_id === routeId) for (const s of p.stops) ids.add(s);
  return ids;
};

/**
 * A stop by id, name or position. A name matching several stops (the two
 * sides of a street, a station and its platforms) is resolved by the route
 * when one is given; otherwise it is an ambiguity. `platforms: true` accepts
 * a parent station's name for all its platforms.
 */
const stop = (model, ref, { routeId = null, allowMany = false } = {}) => {
  if (ref && typeof ref === "object" && Number.isFinite(Number(ref.lat)) && Number.isFinite(Number(ref.lon)) && !ref.id) {
    return { value: { id: null, name: str(ref.name) || null, lat: Number(ref.lat), lon: Number(ref.lon), new: true } };
  }
  const raw = str(ref && typeof ref === "object" ? ref.id || ref.name : ref);
  if (!raw) return amb("stop_missing", "Which stop?");
  if (model.stops.has(raw)) return { value: model.stops.get(raw) };
  const k = nameKey(raw);
  const all = [...model.stops.values()].filter((s) => s.location_type === "0" || !s.location_type);
  let hits = all.filter((s) => nameKey(s.name) === k);
  if (!hits.length) hits = all.filter((s) => k.length >= 4 && nameKey(s.name).includes(k));
  if (routeId && hits.length > 1) {
    const served = stopsOfRoute(model, routeId);
    const onRoute = hits.filter((s) => served.has(s.id));
    if (onRoute.length) hits = onRoute;
  }
  if (hits.length === 1) return { value: hits[0] };
  if (hits.length > 1 && allowMany) return { value: hits[0], many: hits };
  if (hits.length > 1) return amb("stop_ambiguous", `"${raw}" matches ${hits.length} stops.`, hits.map((s) => `${s.name} (${s.id})`));
  return amb("stop_unknown", `No stop "${raw}" in the feed.`);
};

const direction = (model, routeId, ref) => {
  const raw = str(ref);
  if (!raw || ["both", "all", "les deux", "tous"].includes(raw.toLowerCase())) return { value: "both" };
  if (raw === "0" || raw === "1") return { value: raw };
  // A headsign or a terminus name: the direction whose trips go there.
  const k = nameKey(raw.replace(/^(vers|direction|to|towards)\s+/i, ""));
  const dirs = new Set();
  for (const t of model.trips.values()) {
    if (t.route_id !== routeId) continue;
    const last = model.stops.get(t.stops[t.stops.length - 1]);
    if (nameKey(t.headsign).includes(k) || (last && nameKey(last.name).includes(k))) dirs.add(t.direction_id);
  }
  if (dirs.size === 1) return { value: [...dirs][0] };
  if (dirs.size > 1) return amb("direction_ambiguous", `"${raw}" is the destination of both directions.`, ["0", "1", "both"]);
  return amb("direction_unknown", `No direction of this line goes to "${raw}".`, ["0", "1", "both"]);
};

const days = (ref) => {
  if (ref == null || ref === "") return amb("days_missing", "Which days (weekday, saturday, sunday…)?", ["weekday", "saturday", "sunday", "daily"]);
  const list = Array.isArray(ref) ? ref : String(ref).split(/[,+]/);
  const out = new Set();
  for (const r of list) {
    const k = str(r).toLowerCase();
    if (DAY_WORDS[k]) DAY_WORDS[k].forEach((d) => out.add(d));
    else if (DOW.includes(k.slice(0, 3)) && k.length <= 3) out.add(k.slice(0, 3));
    else if (DAY_ALIASES[k]) out.add(DAY_ALIASES[k]);
    else return amb("days_unknown", `"${r}" is not a day or a day type.`, ["weekday", "saturday", "sunday", "daily", ...DOW]);
  }
  return { value: DOW.filter((d) => out.has(d)) };
};

const window = (from, to, { required = true } = {}) => {
  if ((from == null || from === "") && (to == null || to === "")) return required ? amb("window_missing", "Which time window (from – to)?") : { value: { from: 0, to: 48 * 3600 } };
  const a = from == null || from === "" ? 0 : timeToSec(from);
  const b = to == null || to === "" ? 48 * 3600 : timeToSec(to);
  if (a == null) return amb("time_invalid", `"${from}" is not a time.`);
  if (b == null) return amb("time_invalid", `"${to}" is not a time.`);
  if (b <= a) return amb("window_inverted", `The window ends (${to}) before it starts (${from}).`);
  return { value: { from: a, to: b } };
};

const positive = (v, name, { max = Infinity } = {}) => {
  const n = typeof v === "number" ? v : parseFloat(str(v).replace(",", "."));
  if (!Number.isFinite(n)) return amb(`${name}_missing`, `How much (${name})?`);
  if (!(n > 0) || n > max) return amb(`${name}_invalid`, `${name} must be between 0 and ${max}.`);
  return { value: n };
};

module.exports = { route, stop, direction, days, window, positive, stopsOfRoute, timeToSec, DOW, routeLabel };
