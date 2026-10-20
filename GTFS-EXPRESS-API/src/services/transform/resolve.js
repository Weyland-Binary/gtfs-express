/**
 * resolve — turning the words of a brief into entities of the feed, or
 * saying why it cannot, never guessing.
 *
 * Every resolver returns { value } or { ambiguity: { code, message, options? } }:
 *   route(model, ref)            "L3", "3", a route_id, a long name ("Gare ↔ Hôpital")
 *   stop(model, ref, opts)       a stop_id, a name (possibly served by a given route), or { lat, lon };
 *                                `group: true` accepts a name shared by stops of one place (both
 *                                sides of a road, ≤ 400 m apart) and returns them all in `many`
 *   direction(model, routeId, ref) "0" | "1" | "both" | a headsign / terminus name
 *   days(ref)                    "weekday" | "saturday" | ["mon", …] | "school_days" …
 *   window(from, to)             "07:00"–"09:00" → seconds
 *
 * An ambiguity is data: the engine blocks the step and shows the question
 * with its options; nothing runs until the user answers. Its message is in
 * the language of the `lang` option every resolver takes (i18n.js; English
 * by default), its code and options never change with it. An option is an
 * answer: the label a question offers (« 3 — Gare ↔ Hôpital », « Mairie
 * (S12) », « 3 (R3a) » where two lines share a label) resolves to the line
 * or the stop it names, so that clicking one never asks the same question
 * again. A number two lines bear is asked, even when one of them has no long
 * name to tell it by (its label, the number alone, is not an answer).
 *
 * Names are compared as a person reads them: accents, case and punctuation
 * apart (the network's nameKey), ligatures written out (« Sacré-Cœur »),
 * and the usual abbreviations in full (« St-Jacques » is « Saint Jacques »,
 * « Av. de la Gare » is « Avenue de la Gare »). A name is first looked for
 * as whole words (« gare » is not « Nougarède »), then as any part of one.
 *
 * The stops' keys and the lines' stops are indexed once per model (stopIndex,
 * stopsOfRoute): a specification resolves hundreds of names on one model, a
 * big feed has tens of thousands of stops. A model is never changed once
 * built (the engine builds a new one after every applied operation), so an
 * index lives and dies with its model.
 *   childrenOf(model, stopId)    the ids of a station's platforms, from that index
 */

"use strict";

const { nameKey } = require("../network/networkSpec")._internals;
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
const timeToSec = (t) => {
  const m = /^(\d{1,2})(?::|h)(\d{2})?(?::(\d{2}))?$/i.exec(str(t));
  if (!m) return null;
  const h = parseInt(m[1], 10);
  const mi = m[2] ? parseInt(m[2], 10) : 0;
  return mi > 59 ? null : h * 3600 + mi * 60 + (m[3] ? parseInt(m[3], 10) : 0);
};

const routeLabel = (r) => `${r.short_name || r.id}${r.long_name ? ` — ${r.long_name}` : ""}`;
// The labels a question offers, each one line's answer. A label that would ask again — the bare number of a line
// without a long name when another of these lines bears it, or a label two lines share — carries the line's id,
// « 3 (R3a) », as a stop's label carries the stop's.
const routeOptions = (list) => {
  const numberOf = (r) => nameKey(r.short_name || r.id);
  const tally = (f) => list.reduce((m, r) => m.set(f(r), (m.get(f(r)) || 0) + 1), new Map());
  const numbers = tally(numberOf);
  const labels = tally(routeLabel);
  return list.map((r) => ((!r.long_name && numbers.get(numberOf(r)) > 1) || labels.get(routeLabel(r)) > 1 ? `${routeLabel(r)} (${r.id})` : routeLabel(r)));
};

// The words a street or a saint's name is shortened to on a timetable, in full (both sides of a comparison).
const ABBREVIATIONS = Object.freeze({ st: "saint", ste: "sainte", av: "avenue", ave: "avenue", bd: "boulevard", bld: "boulevard", boul: "boulevard", pl: "place", rte: "route", fg: "faubourg", imp: "impasse", chem: "chemin", sq: "square" });
/** A name as a person reads it: the network's key, ligatures written out, the usual abbreviations in full. */
const looseKey = (name) =>
  nameKey(String(name ?? "").replace(/œ/gi, "oe").replace(/æ/gi, "ae"))
    .split(" ")
    .map((w) => ABBREVIATIONS[w] || w)
    .join(" ");

const route = (model, ref, { lang } = {}) => {
  const raw = str(ref && typeof ref === "object" ? ref.id || ref.short_name || ref.name : ref);
  if (!raw) return amb("route_missing", tr(lang, "resolve.route_missing"), routeOptions([...model.routes.values()]));
  // A line's id first — unless the same value is another line's number while the id's own line bears a different
  // one: a brief names lines by their number, and a feed whose route ids are numbers can give one line the number of
  // another (Cholet: route_id 4 is line 3 and line 4 is route_id 2; 10 and 13 cross the same way). That
  // line is then the number's. The id is read when its own line bears that number (Saint-Malo: the new line 1 is
  // route 1 and the old one route 01, both numbered 1), when no line bears it as a number, and when two other lines
  // bear it (the number alone would be asked; the id is the one reading that is not).
  if (model.routes.has(raw)) {
    const byId = model.routes.get(raw);
    const byNumber = nameKey(byId.short_name) === nameKey(raw) ? [] : [...model.routes.values()].filter((r) => r !== byId && nameKey(r.short_name) === nameKey(raw));
    return { value: byNumber.length === 1 ? byNumber[0] : byId };
  }
  const all = [...model.routes.values()];
  // The label a question offered (« 3 — Gare ↔ Hôpital ») is that line — compared as names are (a long name may end
  // with a space the feed kept). Only a label with a long name: the label of a line without one is its number alone,
  // which the lookups below read — and ask about when two lines bear it.
  const labelled = all.filter((r) => r.long_name && nameKey(routeLabel(r)) === nameKey(raw));
  if (labelled.length === 1) return { value: labelled[0] };
  // A label with the line's id (« 3 (R3a) »: offered where two lines share a label) is that line, when both agree —
  // read against the ids the model knows, since an id may hold brackets of its own.
  const withId = raw.endsWith(")") ? all.find((r) => raw.endsWith(` (${r.id})`) && nameKey(routeLabel(r)) === nameKey(raw.slice(0, -` (${r.id})`.length))) : null;
  if (withId) return { value: withId };
  // A reference that names nothing once read as a name (« — ») or once « ligne » is taken off (« ligne » alone) is
  // no line: an empty key would equal the number of a line that has none.
  const kr = nameKey(raw);
  if (!kr) return amb("route_unknown", tr(lang, "resolve.route_unknown", { ref: raw }), routeOptions(all));
  const k = nameKey(raw.replace(/^(ligne|line|route|l)\s*/i, ""));
  // The name as written first (a line called « L1 » or « LEX » is neither « 1 » nor « EX »), then without « ligne ».
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
 * What a model's stops hold, indexed once per model: the loose key of every
 * stop, the stops bearing each key, the children of each parent (and, the
 * same way below, the stops each line serves). A specification resolves
 * hundreds of stop names on one model (a row of a grid each, twice in an auto
 * simulation), and a big feed has tens of thousands of stops: each reference
 * must not read them all.
 *
 * An index follows its model. A model is never changed once built — the
 * engine builds a new one after every applied operation, so a stop that one
 * operation added, renamed or moved is seen by the next through its own
 * model — and the index is dropped with it (a WeakMap). As a net, it is also
 * rebuilt when the model's map is another one or holds another number of
 * entries (a model extended by hand).
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
// The stops whose key passes a test, in the feed's order (the containment passes).
const stopsWhoseKey = (idx, test) => {
  const out = [];
  for (let i = 0; i < idx.keys.length; i++) if (test(idx.keys[i])) out.push(idx.stops[i]);
  return out;
};
// The keys' words and four-letter pieces, read once per model when a name first needs them (without them, each of a
// grid's names the feed spells otherwise costs two passes over every key) — the stops whose key holds `k` as whole
// words, or as any part, in the feed's order as the passes give them.
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
/** The ids of the stops whose parent is `id` (a station's platforms), in the feed's order; none for a plain stop. */
const childrenOf = (model, id) => stopIndex(model).children.get(id) || [];

/** The ids of the stops a line serves (in one direction, or in both): a set shared by the callers, who only read it. */
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

/**
 * A stop by id, name or position. A name matching several stops (the two
 * sides of a street, a station and its platforms) is resolved by the route
 * when one is given; otherwise it is an ambiguity. `platforms: true` accepts
 * a parent station's name for all its platforms.
 */
// Stops that are one place for a passenger: the same name, a few hundred
// metres apart at most (the two sides of a road, the bays of a square).
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
  // The label a question offered (« Mairie (S12) »: the stop's name, its id) is that stop — read against the ids the
  // model knows, since an id may hold brackets of its own (« (3) T »).
  if (raw.endsWith(")")) {
    for (const s of model.stops.values()) {
      const tail = ` (${s.id})`;
      if (raw.endsWith(tail) && looseKey(raw.slice(0, -tail.length)) === looseKey(s.name)) return { value: s };
    }
  }
  const k = looseKey(raw);
  // The stops' keys, computed once per model (stopIndex): the whole name is one lookup, a part of one two passes
  // over the keys. The index's own lists are never handed out (`many` is the caller's).
  const idx = stopIndex(model);
  let hits = (idx.byKey.get(k) || []).slice();
  // Part of a name: whole words first (« gare » is « Gare Centrale », never « Nougarède »), then any part — and a
  // part needs four letters as written: an abbreviation alone (« St », « Bd ») names nothing, however long the word
  // it stands for.
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
  // The same place (both sides of the road): all of them, when the caller can use a group.
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
