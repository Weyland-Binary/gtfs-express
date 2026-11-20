/**
 * Turns the words of a brief into feed entities, or says why it cannot, never guessing.
 * Every resolver returns { value } or { ambiguity: { code, message, options? } }; the
 * engine blocks the step on an ambiguity until the user answers. An option is an answer:
 * the label a question offers resolves to what it names, so clicking it never asks again.
 * Names compare as a person reads them: accents, case and punctuation apart, ligatures
 * and the usual abbreviations written out, whole words first (« gare » is not « Nougarède »).
 * A question's message follows `lang`; its code and options never change with it.
 */

"use strict";

const { nameKey } = require("../network/feedText");
const { parseClock } = require("../../utils/time");
const { haversineMeters } = require("../../utils/geoUtils");
const { tr } = require("./i18n");

const DOW = ["mon", "tue", "wed", "thu", "fri", "sat", "sun"];
const DAY_WORDS = {
  weekday: ["mon", "tue", "wed", "thu", "fri"], weekdays: ["mon", "tue", "wed", "thu", "fri"], semaine: ["mon", "tue", "wed", "thu", "fri"], "lundi-vendredi": ["mon", "tue", "wed", "thu", "fri"], monfri: ["mon", "tue", "wed", "thu", "fri"],
  saturday: ["sat"], samedi: ["sat"], sunday: ["sun"], dimanche: ["sun"], weekend: ["sat", "sun"], "week-end": ["sat", "sun"],
  daily: DOW, everyday: DOW, "tous les jours": DOW, monsat: ["mon", "tue", "wed", "thu", "fri", "sat"], "lundi-samedi": ["mon", "tue", "wed", "thu", "fri", "sat"],
};
const DAY_ALIASES = { monday: "mon", lundi: "mon", tuesday: "tue", mardi: "tue", wednesday: "wed", mercredi: "wed", thursday: "thu", jeudi: "thu", friday: "fri", vendredi: "fri", saturday: "sat", samedi: "sat", sunday: "sun", dimanche: "sun" };

const str = (v) => (typeof v === "string" ? v.trim() : v == null ? "" : String(v).trim());
const amb = (code, message, options = null) => ({ ambiguity: { code, message, ...(options && options.length ? { options: options.slice(0, 12) } : {}) } });
const timeToSec = (t) => parseClock(t);

const routeLabel = (r) => `${r.short_name || r.id}${r.long_name ? ` — ${r.long_name}` : ""}`;
// A label that would ask again (a bare number another line bears, a label two lines share) carries the line's id: « 3 (R3a) ».
const routeOptions = (list) => {
  const numberOf = (r) => nameKey(r.short_name || r.id);
  const tally = (f) => list.reduce((m, r) => m.set(f(r), (m.get(f(r)) || 0) + 1), new Map());
  const numbers = tally(numberOf);
  const labels = tally(routeLabel);
  return list.map((r) => ((!r.long_name && numbers.get(numberOf(r)) > 1) || labels.get(routeLabel(r)) > 1 ? `${routeLabel(r)} (${r.id})` : routeLabel(r)));
};

// Expanded on both sides of a comparison.
const ABBREVIATIONS = Object.freeze({ st: "saint", ste: "sainte", av: "avenue", ave: "avenue", bd: "boulevard", bld: "boulevard", boul: "boulevard", pl: "place", rte: "route", fg: "faubourg", imp: "impasse", chem: "chemin", sq: "square" });
const looseKey = (name) =>
  nameKey(String(name ?? "").replace(/œ/gi, "oe").replace(/æ/gi, "ae"))
    .split(" ")
    .map((w) => ABBREVIATIONS[w] || w)
    .join(" ");

const route = (model, ref, { lang } = {}) => {
  const raw = str(ref && typeof ref === "object" ? ref.id || ref.short_name || ref.name : ref);
  if (!raw) return amb("route_missing", tr(lang, "resolve.route_missing"), routeOptions([...model.routes.values()]));
  // A brief names lines by number, and a feed with numeric route ids can give route_id 4 to line 3 while line 4
  // is route_id 2: the value is the number of exactly one other line then; otherwise it is the id.
  if (model.routes.has(raw)) {
    const byId = model.routes.get(raw);
    const byNumber = nameKey(byId.short_name) === nameKey(raw) ? [] : [...model.routes.values()].filter((r) => r !== byId && nameKey(r.short_name) === nameKey(raw));
    return { value: byNumber.length === 1 ? byNumber[0] : byId };
  }
  const all = [...model.routes.values()];
  // A label a question offered (« 3 — Gare ↔ Hôpital »); a line without a long name is labelled by its number,
  // which the lookups below read.
  const labelled = all.filter((r) => r.long_name && nameKey(routeLabel(r)) === nameKey(raw));
  if (labelled.length === 1) return { value: labelled[0] };
  // « 3 (R3a) »: read against the ids the model knows, since an id may hold brackets of its own.
  const withId = raw.endsWith(")") ? all.find((r) => raw.endsWith(` (${r.id})`) && nameKey(routeLabel(r)) === nameKey(raw.slice(0, -` (${r.id})`.length))) : null;
  if (withId) return { value: withId };
  // An empty key would equal the number of a line that has none.
  const kr = nameKey(raw);
  if (!kr) return amb("route_unknown", tr(lang, "resolve.route_unknown", { ref: raw }), routeOptions(all));
  const k = nameKey(raw.replace(/^(ligne|line|route|l)\s*/i, ""));
  // As written first: a line called « L1 » or « LEX » is neither « 1 » nor « EX ».
  let hits = all.filter((r) => nameKey(r.short_name) === kr);
  if (!hits.length && k) hits = all.filter((r) => nameKey(r.short_name) === k);
  if (!hits.length && k) hits = all.filter((r) => nameKey(r.id) === k);
  if (!hits.length) hits = all.filter((r) => r.long_name && nameKey(r.long_name) === kr);
  if (!hits.length) hits = all.filter((r) => r.long_name && nameKey(r.long_name).includes(nameKey(raw)) && nameKey(raw).length >= 4);
  if (hits.length === 1) return { value: hits[0] };
  if (hits.length > 1) return amb("route_ambiguous", tr(lang, "resolve.route_ambiguous", { ref: raw }), routeOptions(hits));
  return amb("route_unknown", tr(lang, "resolve.route_unknown", { ref: raw }), routeOptions(all));
};

/**
 * Indexed once per model: hundreds of names resolve on one model and a big feed has
 * tens of thousands of stops. A model is never changed once built (the engine builds a
 * new one per applied operation), so the index lives in a WeakMap; it is rebuilt anyway
 * when the stops map is replaced or resized (a model extended by hand).
 */
const STOP_INDEX = new WeakMap();
const stopIndex = (model) => {
  const hit = STOP_INDEX.get(model);
  if (hit && hit.map === model.stops && hit.size === model.stops.size) return hit;
  const stops = [];
  const keys = [];
  const byKey = new Map();
  const children = new Map();
  for (const s of model.stops.values()) {
    if (s.parent) {
      if (!children.has(s.parent)) children.set(s.parent, []);
      children.get(s.parent).push(s.id);
    }
    // Names resolve to the stops people board at; a station is reached through its label or its id.
    if (!(s.location_type === "0" || !s.location_type)) continue;
    const key = looseKey(s.name);
    stops.push(s);
    keys.push(key);
    if (!byKey.has(key)) byKey.set(key, []);
    byKey.get(key).push(s);
  }
  const idx = { map: model.stops, size: model.stops.size, stops, keys, byKey, children };
  STOP_INDEX.set(model, idx);
  return idx;
};
const stopsWhoseKey = (idx, test) => {
  const out = [];
  for (let i = 0; i < idx.keys.length; i++) if (test(idx.keys[i])) out.push(idx.stops[i]);
  return out;
};
// Word and four-letter indexes, built on first need: without them each unmatched name costs two passes over every key.
const lazyIndex = (idx, name, pieces) => {
  if (!idx[name]) {
    const map = new Map();
    idx.keys.forEach((key, i) => {
      for (const x of new Set(pieces(key))) {
        if (!map.has(x)) map.set(x, []);
        map.get(x).push(i);
      }
    });
    idx[name] = map;
  }
  return idx[name];
};
const GRAM = 4;
const gramsOf = (key) => {
  const out = [];
  for (let j = 0; j + GRAM <= key.length; j++) out.push(key.slice(j, j + GRAM));
  return out;
};
const stopsWithWords = (idx, k) => (lazyIndex(idx, "byWord", (key) => key.split(" ").filter(Boolean)).get(k.split(" ")[0]) || []).filter((i) => ` ${idx.keys[i]} `.includes(` ${k} `)).map((i) => idx.stops[i]);
const stopsWithPart = (idx, k) => (k.length < GRAM ? stopsWhoseKey(idx, (key) => key.includes(k)) : (lazyIndex(idx, "byGram", gramsOf).get(k.slice(0, GRAM)) || []).filter((i) => idx.keys[i].includes(k)).map((i) => idx.stops[i]));
const childrenOf = (model, id) => stopIndex(model).children.get(id) || [];

// stopsOfRoute's sets are shared by the callers, who only read them.
const SERVED_INDEX = new WeakMap();
const stopsOfRoute = (model, routeId, direction = null) => {
  const dir = !direction || direction === "both" ? "" : String(direction);
  let served = SERVED_INDEX.get(model);
  if (!served || served.map !== model.patterns || served.size !== model.patterns.size) {
    served = { map: model.patterns, size: model.patterns.size, sets: new Map() };
    SERVED_INDEX.set(model, served);
  }
  const key = `${routeId}\u0000${dir}`;
  if (!served.sets.has(key)) {
    const ids = new Set();
    for (const p of model.patterns.values()) if (p.route_id === routeId && (!dir || p.direction_id === dir)) for (const s of p.stops) ids.add(s);
    served.sets.set(key, ids);
  }
  return served.sets.get(key);
};

// One place for a passenger: the same name, a few hundred metres apart at most (both sides of a road).
const SAME_PLACE_M = 400;
const samePlace = (hits) => {
  if (hits.length < 2) return false;
  const k = nameKey(hits[0].name);
  if (!hits.every((h) => nameKey(h.name) === k)) return false;
  const located = hits.filter((h) => h.lat != null && h.lon != null);
  if (located.length !== hits.length) return false;
  for (let i = 0; i < located.length; i++) for (let j = i + 1; j < located.length; j++) if (haversineMeters(located[i].lat, located[i].lon, located[j].lat, located[j].lon) > SAME_PLACE_M) return false;
  return true;
};

const stop = (model, ref, { routeId = null, direction = null, allowMany = false, group = false, lang } = {}) => {
  if (ref && typeof ref === "object" && Number.isFinite(Number(ref.lat)) && Number.isFinite(Number(ref.lon)) && !ref.id) {
    const nm = str(ref.name) || null;
    const lat = Number(ref.lat);
    const lon = Number(ref.lon);
    // The same name within 10 m is that stop (an earlier step created it, or it exists): not a new one.
    if (nm) {
      for (const s of model.stops.values()) {
        if (s.name !== nm || s.lat == null || !(s.location_type === "0" || !s.location_type)) continue;
        if (Math.hypot((s.lat - lat) * 111320, (s.lon - lon) * 111320 * Math.cos((lat * Math.PI) / 180)) <= 10) return { value: s };
      }
    }
    return { value: { id: null, name: nm, lat, lon, new: true } };
  }
  const raw = str(ref && typeof ref === "object" ? ref.id || ref.name : ref);
  if (!raw) return amb("stop_missing", tr(lang, "resolve.stop_missing"));
  if (model.stops.has(raw)) return { value: model.stops.get(raw) };
  // « Mairie (S12) »: read against the ids the model knows, since an id may hold brackets of its own.
  if (raw.endsWith(")")) {
    for (const s of model.stops.values()) {
      const tail = ` (${s.id})`;
      if (raw.endsWith(tail) && looseKey(raw.slice(0, -tail.length)) === looseKey(s.name)) return { value: s };
    }
  }
  const k = looseKey(raw);
  // The index's own lists are never handed out (`many` is the caller's).
  const idx = stopIndex(model);
  let hits = (idx.byKey.get(k) || []).slice();
  // A part needs four letters as written: an abbreviation alone (« St », « Bd ») names nothing.
  const part = nameKey(raw).length >= 4;
  if (!hits.length && part) hits = stopsWithWords(idx, k);
  if (!hits.length && part) hits = stopsWithPart(idx, k);
  if (routeId && hits.length > 1) {
    const served = stopsOfRoute(model, routeId);
    const onRoute = hits.filter((s) => served.has(s.id));
    if (onRoute.length) hits = onRoute;
  }
  // The side of the street the line serves in that direction.
  if (routeId && direction && direction !== "both" && hits.length > 1) {
    const served = stopsOfRoute(model, routeId, direction);
    const onSide = hits.filter((s) => served.has(s.id));
    if (onSide.length) hits = onSide;
  }
  if (hits.length === 1) return { value: hits[0] };
  if (hits.length > 1 && allowMany) return { value: hits[0], many: hits };
  if (hits.length > 1 && group && samePlace(hits)) return { value: hits[0], many: hits, samePlace: true };
  if (hits.length > 1) return amb("stop_ambiguous", tr(lang, "resolve.stop_ambiguous", { ref: raw, count: hits.length }), hits.map((s) => `${s.name} (${s.id})`));
  return amb("stop_unknown", tr(lang, "resolve.stop_unknown", { ref: raw }));
};

const direction = (model, routeId, ref, { lang } = {}) => {
  const raw = str(ref);
  if (!raw || ["both", "all", "les deux", "tous"].includes(raw.toLowerCase())) return { value: "both" };
  if (raw === "0" || raw === "1") return { value: raw };
  // A headsign or a terminus name: the direction whose trips go there.
  const k = nameKey(raw.replace(/^(vers|direction|to|towards)\s+/i, ""));
  const dirs = new Set();
  for (const t of require("./feedModel").tripsOfRoute(model, routeId)) {
    const last = model.stops.get(t.stops[t.stops.length - 1]);
    if (nameKey(t.headsign).includes(k) || (last && nameKey(last.name).includes(k))) dirs.add(t.direction_id);
  }
  if (dirs.size === 1) return { value: [...dirs][0] };
  if (dirs.size > 1) return amb("direction_ambiguous", tr(lang, "resolve.direction_ambiguous", { ref: raw }), ["0", "1", "both"]);
  return amb("direction_unknown", tr(lang, "resolve.direction_unknown", { ref: raw }), ["0", "1", "both"]);
};

const days = (ref, { lang } = {}) => {
  if (ref == null || ref === "") return amb("days_missing", tr(lang, "resolve.days_missing"), ["weekday", "saturday", "sunday", "daily"]);
  const list = Array.isArray(ref) ? ref : String(ref).split(/[,+]/);
  const out = new Set();
  for (const r of list) {
    const k = str(r).toLowerCase();
    if (DAY_WORDS[k]) DAY_WORDS[k].forEach((d) => out.add(d));
    else if (DOW.includes(k.slice(0, 3)) && k.length <= 3) out.add(k.slice(0, 3));
    else if (DAY_ALIASES[k]) out.add(DAY_ALIASES[k]);
    else return amb("days_unknown", tr(lang, "resolve.days_unknown", { value: String(r) }), ["weekday", "saturday", "sunday", "daily", ...DOW]);
  }
  return { value: DOW.filter((d) => out.has(d)) };
};

const window = (from, to, { required = true, lang } = {}) => {
  if ((from == null || from === "") && (to == null || to === "")) return required ? amb("window_missing", tr(lang, "resolve.window_missing")) : { value: { from: 0, to: 48 * 3600 } };
  const a = from == null || from === "" ? 0 : timeToSec(from);
  const b = to == null || to === "" ? 48 * 3600 : timeToSec(to);
  if (a == null) return amb("time_invalid", tr(lang, "resolve.time_invalid", { value: String(from) }));
  if (b == null) return amb("time_invalid", tr(lang, "resolve.time_invalid", { value: String(to) }));
  if (b <= a) return amb("window_inverted", tr(lang, "resolve.window_inverted", { to: String(to), from: String(from) }));
  return { value: { from: a, to: b } };
};

const positive = (v, name, { max = Infinity, lang } = {}) => {
  const n = typeof v === "number" ? v : parseFloat(str(v).replace(",", "."));
  if (!Number.isFinite(n)) return amb(`${name}_missing`, tr(lang, "resolve.amount_missing", { name }));
  if (!(n > 0) || n > max) return amb(`${name}_invalid`, tr(lang, "resolve.amount_invalid", { name, max }));
  return { value: n };
};

module.exports = { route, stop, direction, days, window, positive, stopsOfRoute, childrenOf, timeToSec, DOW, routeLabel, looseKey, _internals: { stopIndex } };
