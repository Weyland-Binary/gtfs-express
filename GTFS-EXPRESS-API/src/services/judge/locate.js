/**
 * What a clause names, found on the measured network: lines, places, stops, calls and directions.
 * A place located by coordinates or the territory outweighs a stop that merely bears its name.
 * A direction no trip reaches, or one naming every direction, leaves the clause unknown: a promise
 * about one direction is never measured over all of them. At a stop, a departure is never a trip's
 * last call nor an arrival its first.
 */

"use strict";

const { nameKey } = require("../network/feedText");
const { haversineMeters } = require("../../utils/geoUtils");
const { stopKeys, indexIn } = require("./clauseTrips");
const { str, num, given, listOf } = require("./values");
const { result } = require("./result");


// ── Lines and places

// The public number wins over an id: in a real feed a route's id can be another line's number.
const findLine = (spec, ref) => {
  const k = nameKey(ref);
  if (!k) return null;
  const lines = spec.lines || [];
  const found = lines.find((l) => nameKey(l.short_name) === k) || lines.find((l) => nameKey(l.id) === k) || lines.find((l) => nameKey(l.long_name) === k);
  if (found) return found;
  // The labels the engine's line questions offer, written back as an answer: « 3 — Gare ↔ Hôpital (R3a) ».
  // The id is matched against the feed's ids, since an id may hold brackets of its own.
  const label = (l) => `${l.short_name || l.id}${l.long_name ? ` — ${l.long_name}` : ""}`;
  const raw = String(ref).trim();
  const withId = raw.endsWith(")") ? lines.find((l) => raw.endsWith(` (${l.id})`) && [label(l), l.short_name || l.id].some((x) => nameKey(x) === nameKey(raw.slice(0, -` (${l.id})`.length)))) : null;
  if (withId) return withId;
  const labelled = lines.filter((l) => l.long_name && nameKey(label(l)) === k);
  if (labelled.length === 1) return labelled[0];
  // The forms the engine's resolver reads, so a clause finds the line its plan ran on: « Ligne 1 », a number in
  // brackets after a name, then a name the long name holds as whole words. One match only, never a guess.
  const bare = nameKey(raw.replace(/^(ligne|line|route|l)\s*/i, ""));
  if (bare && bare !== k) {
    const byBare = lines.find((l) => nameKey(l.short_name) === bare) || lines.find((l) => nameKey(l.id) === bare);
    if (byBare) return byBare;
  }
  const bracket = raw.match(/^(.*\S)\s*\(([^()]+)\)\s*$/);
  if (bracket) {
    const num = nameKey(bracket[2]);
    const byNumber = lines.filter((l) => nameKey(l.short_name) === num || nameKey(l.id) === num);
    if (byNumber.length === 1) return byNumber[0];
    const byName = findLine(spec, bracket[1]);
    if (byName) return byName;
  }
  if (k.length >= 4) {
    const within = lines.filter((l) => l.long_name && ` ${nameKey(l.long_name)} `.includes(` ${k} `));
    if (within.length === 1) return within[0];
  }
  return null;
};
/** The same line in another feed (the feed before a plan): by its id, else by its number. */
const pairedLine = (spec, line) => (spec.lines || []).find((l) => l.id === line.id) || findLine(spec, line.short_name);

const nameMatches = (a, b) => {
  const x = nameKey(a);
  const y = nameKey(b);
  if (!x || !y) return false;
  if (x === y) return true;
  const [short, long] = x.length <= y.length ? [x, y] : [y, x];
  return short.length >= 4 && ` ${long} `.includes(` ${short} `);
};

// Who says where a place is, strongest first; the authoritative ones overrule a stop's name.
const AUTHORITIES = ["coordinates", "territory", "feed"];
const AUTHORITATIVE = new Set(["coordinates", "territory"]);
const weakest = (list) => list.filter(Boolean).sort((a, b) => AUTHORITIES.indexOf(b) - AUTHORITIES.indexOf(a))[0] || null;

const namedLike = (list, name) => {
  const k = nameKey(name);
  const located = (list || []).filter((s) => s && Number.isFinite(num(s.lat)) && Number.isFinite(num(s.lon)));
  const exact = located.filter((s) => nameKey(s.name) === k || (s.id != null && nameKey(s.id) === k));
  return exact.length ? exact : located.filter((s) => nameMatches(s.name, name));
};

/**
 * A place as a point and the authority it rests on (`via`). `points` lists every match: a name may stand
 * for both sides of a street. null when it cannot be located: the clause is then unknown, never a guess.
 */
const locate = (ref, spec, territory) => {
  let name = ref;
  if (ref && typeof ref === "object") {
    const lat = num(ref.lat);
    const lon = num(ref.lon);
    if (lat != null && lon != null && Math.abs(lat) <= 90 && Math.abs(lon) <= 180) return { lat, lon, name: str(ref.name) || null, via: "coordinates", points: [{ lat, lon, name: str(ref.name) || null }] };
    name = ref.name;
  }
  name = str(name);
  if (!name) return null;
  const hit = (list, via) => {
    const found = namedLike(list, name);
    if (!found.length) return null;
    const points = found.map((s) => ({ lat: num(s.lat), lon: num(s.lon), name: s.name, ...(s.id != null ? { id: s.id } : {}) }));
    return { lat: points[0].lat, lon: points[0].lon, name: points[0].name, via, points };
  };
  return hit([...(territory?.pois?.items || []), ...(territory?.existing_stops || [])], "territory") || hit(spec.stops, "feed");
};

const distanceTo = (stop, place) => Math.min(...place.points.map((p) => haversineMeters(stop.lat, stop.lon, p.lat, p.lon)));

const locateIn = (ctx, ref) => locate(ref, ctx.spec, ctx.territory);

const nearestTo = (stops, place) => {
  let best = null;
  for (const s of stops) {
    if (!s || s.lat == null) continue;
    const d = distanceTo(s, place);
    if (!best || d < best.d) best = { stop: s, d };
  }
  return best;
};

const directionsOf = (byDirection, params) => {
  const d = params.direction == null || params.direction === "" || params.direction === "both" ? null : String(params.direction);
  if (!d) return [...byDirection.values()];
  return byDirection.has(d) ? [byDirection.get(d)] : [];
};
const directionLabel = (params, resolved = null) => {
  if (resolved) return `, direction ${resolved.label}`;
  const written = str(params.direction);
  return !written || EVERY_DIRECTION.has(written.toLowerCase()) ? "" : `, direction ${written}`;
};

const linesFor = (spec, params) => {
  if (str(params.line)) {
    const l = findLine(spec, params.line);
    return l ? [l] : null;
  }
  return spec.lines || [];
};

// A feed view lists every stop pattern of a line as one of its directions.
const patternsOfLine = (line) => line.directions || [];
const servedStopIds = (line, spec) => [...new Set(patternsOfLine(line, spec).flatMap((p) => p.stops || []))];

// Memoised non-enumerably, so it never serialises; a measured spec is never changed.
const stopNamesOf = (spec) => {
  if (spec._stopNames) return spec._stopNames;
  const names = new Map((spec.stops || []).map((x) => [x.id, x.name]));
  if (Object.isExtensible(spec)) Object.defineProperty(spec, "_stopNames", { value: names, enumerable: false });
  return names;
};
const sameDirection = (t, p) => !given(p.direction) || p.direction === "both" || String(t.direction) === String(p.direction);

// ── Directions

const EVERY_DIRECTION = new Set(["both", "all", "any", "les deux", "les deux sens", "tous", "tous les sens", "toutes"]);
const DIRECTION_WORD = /^(?:en\s+direction|[àa]\s+destination|vers|direction|dir\.?|sens|towards|to)\s+/i;
// After a direction word, « de » is the destination's article: read as an origin it would measure the way back.
const DEST_ARTICLE = /^(?:(?:de|du|des)\s+|d['’]\s*)/i;
// Words naming a direction by where its trips start. A bare « de » is an origin only when written first,
// never after a direction word (DEST_ARTICLE).
const ORIGIN_WORD = /^(?:(?:au\s+d[ée]part|en\s+provenance)\s+)?(?:(?:depuis|from|leaving|du|des|de)\s+|d['’]\s*)/i;
const ORIGIN_EXPLICIT = /^(?:(?:au\s+d[ée]part|en\s+provenance)\s+(?:(?:du|des|de)\s+|d['’]\s*)|(?:depuis|from|leaving)\s+)/i;
const TO_WORD = /\s+(?:vers|towards|to|jusqu['’]\s*(?:à|a|au|aux))\s+/i;
const ARTICLE = /^(?:(?:la|le|les|the)\s+|l['’]\s*)/i;
const LABEL_ARROW = /\s*(?:→|⟶|➔|➜|⇒|->|=>)\s*|\s+>\s+/;
const isDirectionLabel = (v) => LABEL_ARROW.test(str(v && typeof v === "object" ? v.name : v));

/** The line's patterns on each side (the measured feed and, for a relational clause, the feed before), main ones first. */
const directionPatterns = (sides) =>
  sides.flatMap(({ spec, line }) =>
    (line ? patternsOfLine(line, spec) : [])
      .filter((p) => Array.isArray(p.stops) && p.stops.length)
      .map((p) => {
        const names = p.stops.map((id) => stopNamesOf(spec).get(id) || String(id));
        return { dir: str(p.direction ?? p.id) || "0", keys: names.map(nameKey), last: names[names.length - 1], headsigns: [p.headsign, ...(Array.isArray(p.headsigns) ? p.headsigns : [])].map(str).filter(Boolean) };
      }),
  );

const directionsText = (patterns) => {
  const main = new Map();
  for (const p of patterns) if (!main.has(p.dir)) main.set(p.dir, p.last);
  return [...main].sort(([a], [b]) => (a < b ? -1 : 1)).map(([d, last]) => `${d} → ${last}`).join(", ") || "none";
};

/**
 * The readings of a direction's words, the most literal first: as written (an id, a destination, a label
 * « A → B »), then without the introducing word, then as an origin (« depuis A [vers B] »).
 */
const readingsOf = (raw) => {
  const out = [];
  const asWritten = (w) => {
    if (!w) return;
    if (!LABEL_ARROW.test(w)) return out.push({ id: w }, { origin: null, dest: w });
    const parts = w.split(LABEL_ARROW).map((x) => x.trim());
    out.push({ origin: parts[0] || null, dest: parts[parts.length - 1] || null });
  };
  asWritten(raw);
  const bare = raw.replace(DIRECTION_WORD, "").trim();
  const introduced = bare !== raw;
  if (introduced) {
    asWritten(bare);
    if (!ORIGIN_EXPLICIT.test(bare)) {
      const dest = bare.replace(DEST_ARTICLE, "").trim();
      if (dest !== bare) asWritten(dest);
    }
  }
  // After a direction word, only the explicit origin words name an origin.
  for (const [w, word] of [[raw, ORIGIN_WORD], ...(introduced ? [[bare, ORIGIN_EXPLICIT]] : [])]) {
    if (!word.test(w) || LABEL_ARROW.test(w)) continue;
    const ends = w.replace(word, "").trim().split(TO_WORD).map((x) => x.trim());
    if (ends[0]) out.push({ origin: ends[0], dest: ends.length > 1 ? ends[ends.length - 1] || null : null });
  }
  return out;
};

/**
 * The direction ids one reading reaches: both ends, the origin called before the destination; a destination,
 * the patterns ending there or bearing it as headsign; an origin alone, those starting there.
 */
const directionsNamed = (sides, patterns, { origin, dest }, partial) => {
  const namesOf = (name) => [...new Set([name, name.replace(ARTICLE, "").trim()])].filter(Boolean);
  const keysOf = (name) => {
    for (const n of namesOf(name)) {
      const keys = new Set(sides.flatMap(({ spec }) => [...(stopKeys({ spec }, n, { partial })?.keys || [])]));
      if (keys.size) return keys;
    }
    return new Set();
  };
  const signs = (h, name) =>
    namesOf(name).some((n) => {
      const [a, b] = [nameKey(h), nameKey(n)];
      return a === b || (partial === "within" && b.length >= 4 && a.length > b.length && ` ${a} `.includes(` ${b} `));
    });
  const dirs = (test) => [...new Set(patterns.filter(test).map((p) => p.dir))].sort();
  const from = origin ? keysOf(origin) : null;
  const to = dest ? keysOf(dest) : null;
  if (from?.size && to?.size) {
    const found = dirs((p) => p.keys.some((k, i) => from.has(k) && p.keys.slice(i + 1).some((x) => to.has(x))));
    if (found.length) return found;
  }
  if (dest) return dirs((p) => to.has(p.keys[p.keys.length - 1]) || p.headsigns.some((h) => signs(h, dest)));
  return from ? dirs((p) => from.has(p.keys[0])) : [];
};
const readingText = (r) =>
  !r ? null : r.origin && r.dest ? `runs from ${r.origin} to ${r.dest}, ends at ${r.dest} or bears it as its headsign` : r.dest ? `ends at ${r.dest} or bears it as its headsign` : r.origin ? `starts at ${r.origin}` : null;

/**
 * The direction id a clause's words name on a line, every reading tried by exact names first, then by
 * names holding the words whole. null: none named, each direction is measured. { error, none? }: no trip
 * reaches it (none) or it names several directions; it is never measured over all of them.
 */
const directionIn = (sides, value) => {
  const raw = str(value && typeof value === "object" ? value.name ?? value.id : value);
  if (!raw || EVERY_DIRECTION.has(raw.toLowerCase())) return null;
  const patterns = directionPatterns(sides);
  const line = sides.find((x) => x.line)?.line;
  const of = `direction "${raw}" of line ${line?.short_name || line?.id || "?"}`;
  const readings = readingsOf(raw);
  for (const partial of [false, "within"]) {
    for (const r of readings) {
      if (r.id != null) {
        if (partial) continue;
        if (r.id === "0" || r.id === "1" || patterns.some((p) => p.dir === r.id)) return { id: r.id, label: r.id };
        if (/^\d+$/.test(r.id)) return { error: `${of}: not one of its directions (${directionsText(patterns)})`, none: true };
        continue;
      }
      const found = directionsNamed(sides, patterns, r, partial);
      if (found.length === 1) return { id: found[0], label: `${found[0]} (${raw})` };
      if (found.length > 1) return { error: `${of} names ${found.length === 2 ? "both directions" : `directions ${found.join(", ")}`} (${directionsText(patterns)}): give the direction's id` };
    }
  }
  const asked = readingText([...readings].reverse().find((r) => r.id == null));
  return { error: `${of}: ${asked ? `no trip ${asked}` : "names neither where its trips start nor where they end"} (its directions: ${directionsText(patterns)})`, none: true };
};

const withDirection = (p, resolved, key = "direction") => ({ ...p, [key]: resolved ? resolved.id : null });
const readDirection = (d) => (d && d.id != null ? d : null);
// A trip of a single call, which some published feeds carry, both starts and ends there.
const endsThere = (t, i) => i > 0 && i === t.keys.length - 1;
const startsThere = (t, i) => i === 0 && t.keys.length > 1;
/** "leaves" when a pattern leaves from the stop, "ends" when they only end there, null when none calls there. */
const callKind = (spec, line, keys, dir, occurrence = null) => {
  let ends = false;
  for (const p of directionPatterns([{ spec, line }])) {
    if (dir && p.dir !== dir.id) continue;
    const i = callOf(p, keys, occurrence);
    if (i < 0) continue;
    if (!endsThere(p, i)) return "leaves";
    ends = true;
  }
  return ends ? "ends" : null;
};

/**
 * The direction from `direction` and a `towards` label « Origin → Destination », which is read as a direction,
 * never as stops (that would count both directions). Both given, they must name the same one.
 */
const clauseDirection = (spec, line, p) => {
  const dir = directionIn([{ spec, line }], p.direction);
  if (dir?.error) return { error: dir.error };
  if (!isDirectionLabel(p.towards)) return { dir };
  const words = str(p.towards?.name ?? p.towards);
  const by = directionIn([{ spec, line }], words);
  if (!by || by.error) return by ? { error: by.error } : { dir };
  if (dir && by.id !== dir.id) return { error: `direction ${dir.label} and towards "${words}" (direction ${by.id}) name two directions of line ${line.short_name || line.id}` };
  return { dir: dir || by };
};
/**
 * An unreadable direction is the verdict on a line the clause names; said of every line, only when it names
 * several directions: a line whose trips never go that way is not the clause's.
 */
const unreadDirection = (d, named) => Boolean(d?.error) && (named || !d.none);

const _servedKeys = new WeakMap();
const servedKeysOf = (spec, line) => {
  if (!_servedKeys.has(spec)) _servedKeys.set(spec, new Map());
  const cache = _servedKeys.get(spec);
  if (!cache.has(line.id)) {
    const byId = new Map((spec.stops || []).map((s) => [s.id, s]));
    cache.set(line.id, new Set(servedStopIds(line, spec).map((id) => nameKey(byId.get(id)?.name || id))));
  }
  return cache.get(line.id);
};

/** A name no stop matches makes the clause unknown; a stop the line never serves makes it fail. */
const stopsOfClause = (ctx, line, refs) => {
  const stops = [];
  for (const ref of refs) {
    if (ref == null) {
      stops.push(null);
      continue;
    }
    const k = stopKeys(ctx, ref);
    const name = str(ref && typeof ref === "object" ? ref.name : ref);
    if (!k) return { result: (c) => result(c, "unknown", { note: `no stop named ${name} in the network` }) };
    const served = servedKeysOf(ctx.spec, line);
    if (![...k.keys].some((x) => served.has(x))) return { result: (c) => result(c, "fail", { expected: `line ${line.short_name} at ${k.name}`, measured: `line ${line.short_name} does not serve ${k.name}`, lines: [line.id] }) };
    stops.push(k);
  }
  return { stops };
};

/** "first", "last" or a rank from 1; null when unset; { error } otherwise. */
const occurrenceOf = (p) => {
  const v = p.occurrence;
  if (v == null || v === "") return null;
  const word = str(v).toLowerCase();
  if (word === "first" || word === "last") return word;
  const n = num(v);
  return Number.isInteger(n) && n >= 1 ? n : { error: `incomplete clause (occurrence "${str(v)}": first, last or the call's rank from 1)` };
};
const occurrenceText = (occurrence) => (occurrence == null ? "" : typeof occurrence === "number" ? ` (call ${occurrence})` : ` (${occurrence} call)`);

/**
 * The trip's call the clause's stop means: when the name recurs (a loop, two villages' « Centre Bourg »),
 * the one `occurrence` names, else the first, the reading the recorded verdicts rest on. -1 when none.
 */
const callOf = (trip, keys, occurrence = null) => {
  if (occurrence == null) return indexIn(trip, keys);
  const all = [];
  for (let i = 0; i < trip.keys.length; i++) if (keys.has(trip.keys[i])) all.push(i);
  const i = occurrence === "first" ? all[0] : occurrence === "last" ? all[all.length - 1] : all[occurrence - 1];
  return i == null ? -1 : i;
};

// A failing verdict on a repeated stop says the first call was read: the clause may mean another (repeatedNote).
const callsOfStop = (trip, keys) => {
  let n = 0;
  for (const k of trip.keys) if (keys.has(k)) n += 1;
  return n;
};
const repeatedNote = (name, n, past = false) =>
  `measured at the first of ${n} calls at ${name}${past ? " past the trip's origin (no one arrives where it starts)" : ""}: the clause names no occurrence (first, last or a rank tells another call)`;
const endingNote = (name, n) => `${n} trip${n === 1 ? " ends" : "s end"} at ${name}: an arrival there is no departure (not counted)`;
const terminusNote = (name, occurrence, dir) =>
  `no trip leaves from ${name}${occurrenceText(occurrence)}${dir ? ` in direction ${dir.label}` : ""}: the trips end there, and an arrival is no departure — no headway to measure there`;

const linesOfClause = (spec, p) => {
  const names = [...new Set([...listOf(p.lines), ...listOf(p.line)])];
  if (!names.length) return { list: spec.lines || [], label: "every line" };
  const list = [];
  for (const n of names) {
    const l = findLine(spec, n);
    if (!l) return { missing: n };
    list.push(l);
  }
  return { list, label: list.length === 1 ? `line ${list[0].short_name}` : `lines ${list.map((l) => l.short_name).join(", ")}` };
};

/** null without a feed before the plan, or when the measured feed is that feed. */
const baseSpecOf = (ctx) => (ctx.baseline && !ctx.baseline.self ? ctx.baseline.spec : null);

module.exports = { findLine, pairedLine, nameMatches, AUTHORITATIVE, weakest, locate, distanceTo, locateIn, nearestTo, directionsOf, directionLabel, linesFor, patternsOfLine, servedStopIds, stopNamesOf, sameDirection, isDirectionLabel, directionIn, withDirection, readDirection, endsThere, startsThere, callKind, clauseDirection, unreadDirection, servedKeysOf, stopsOfClause, occurrenceOf, occurrenceText, callOf, callsOfStop, repeatedNote, endingNote, terminusNote, linesOfClause, baseSpecOf };
