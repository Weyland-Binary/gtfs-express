/**
 * locate — what a clause names, found on the network measured: its lines
 * (findLine, paired with the feed before the plan by pairedLine), its places
 * (locate), its stops and the calls a trip makes there (stopsOfClause,
 * callOf), and its directions (directionIn).
 *
 * Places (serves, via, termini, od_max_time) are located on authority, and
 * each verdict says which (`located_by`): the clause's coordinates, then the
 * territory's named places and existing stops, then the places the designer
 * located on purpose (referenceStops), then the network's stops of that
 * name — ground truth on a real feed ("feed"), a mere candidate on a
 * designed plan ("plan_stop"). A stop named after a place never outweighs
 * an authoritative location of it: `serves` fails when the nearest served
 * stop is beyond the radius, whatever its name, and is "unknown" when only
 * the plan's own homonymous stop locates the place.
 *
 * Directions: a clause's `direction` (except.direction, from_direction,
 * to_direction, and a `towards` written « Origin → Destination ») is read on
 * the line's own patterns (directionIn): its id ("0", "1"), a destination
 * (the direction whose trips end there or bear it as their headsign: « vers
 * … », « direction de Pélissier », « en direction de la Gare » — the « de »
 * after a direction word is an article, never an origin), an
 * origin (« depuis Les Tilleuls », « au départ de … », « from … », « A → »:
 * the direction whose trips start there) or a label « Renaudié → Portes
 * d'Albi » (whose trips run from the one to the other); the verdict names the
 * id beside the words. A direction no trip reaches, or one every direction
 * reaches, makes the clause unknown with its reason — a promise about one
 * direction is never measured over all of them (an except.direction
 * compared with the ids "0" and "1" would carve nothing out and fail on the
 * very trips the plan was asked to change), nor over the other one: a name
 * is a stop's when the words hold it whole, never a stop whose name is only
 * a part of them (read as a destination, « depuis Les Tilleuls » would be
 * the way back).
 * At a stop, a departure is a call a trip leaves from — never its last call,
 * where it arrives and ends — and an arrival one it reaches, never its first
 * (on a loop, its return): a headway or a departure time at a terminus is
 * never read on the arrivals of the trips that end there, and a headway at a
 * stop the trips only end at has nothing to measure — unknown, said why,
 * unless the line left from it before the plan (then it fails).
 */

"use strict";

const networkSpec = require("../network/networkSpec");
const { haversineMeters } = require("../../utils/geoUtils");
const { stopKeys, indexIn } = require("./clauseTrips");
const { str, num, given, listOf } = require("./values");
const { result } = require("./result");

const { nameKey } = networkSpec._internals;

// ── Resolution: lines and places ──────────────────────────────────────────

// A line the brief names: its public number first, then its id, then its long name. The number
// wins over an id: in a real feed a route's id can be another line's number (Cholet: route id 4
// is line 3, route id 2 is line 4), and a brief names the number.
const findLine = (spec, ref) => {
  const k = nameKey(ref);
  if (!k) return null;
  const lines = spec.lines || [];
  const found = lines.find((l) => nameKey(l.short_name) === k) || lines.find((l) => nameKey(l.id) === k) || lines.find((l) => nameKey(l.long_name) === k);
  if (found) return found;
  // The labels the engine's question about a line offers (resolve.route), written back as the answer: « 3 —
  // Gare ↔ Hôpital » (its number and long name), « 3 (R3a) » or « 3 — Gare ↔ Hôpital (R3a) » where two lines share
  // a label — the line they name, its id read against the ids the feed has (an id may hold brackets of its own).
  const label = (l) => `${l.short_name || l.id}${l.long_name ? ` — ${l.long_name}` : ""}`;
  const raw = String(ref).trim();
  const withId = raw.endsWith(")") ? lines.find((l) => raw.endsWith(` (${l.id})`) && [label(l), l.short_name || l.id].some((x) => nameKey(x) === nameKey(raw.slice(0, -` (${l.id})`.length)))) : null;
  if (withId) return withId;
  const labelled = lines.filter((l) => l.long_name && nameKey(label(l)) === k);
  if (labelled.length === 1) return labelled[0];
  // The forms the engine's own resolver reads (transform/resolve route: a clause names a line as the plan does, so
  // the measure finds « Ligne 1 » and « Rapid'Ouest » where the plan runs on them, never « no such line »): the
  // number once « ligne » is taken off (« Ligne 1 » is line 1; « L1 » read as written first, a line may be called
  // so), the number in brackets after a name (« Rapid'Ouest (RO) »), then a name the long name holds as whole words
  // (« Rapid'Ouest » in « RAPID OUEST DUNKERQUE GARE - … »), one line only — never a guess between two.
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

// Who says where a place is, strongest first. The first three are
// AUTHORITATIVE: they overrule a stop's name. The feed's own stops are
// ground truth for a real feed; a designed plan's own stop named after a
// place is only a candidate (a plan cannot prove it serves the hospital by
// naming a stop "Hospital").
const AUTHORITIES = ["coordinates", "territory", "design", "feed", "plan_stop"];
const AUTHORITATIVE = new Set(["coordinates", "territory", "design"]);
const PLAN_STOP_NOTE = "place located only by the plan's own stop: confirm its position";
const weakest = (list) => list.filter(Boolean).sort((a, b) => AUTHORITIES.indexOf(b) - AUTHORITIES.indexOf(a))[0] || null;

// Every entry of a list named like the place: exact names first, else the partial matches.
const namedLike = (list, name) => {
  const k = nameKey(name);
  const located = (list || []).filter((s) => s && Number.isFinite(num(s.lat)) && Number.isFinite(num(s.lon)));
  const exact = located.filter((s) => nameKey(s.name) === k || (s.id != null && nameKey(s.id) === k));
  return exact.length ? exact : located.filter((s) => nameMatches(s.name, name));
};

/**
 * A place of the brief as a point, and on whose authority (`via`):
 * explicit coordinates → a named place or existing stop of the territory
 * (the OSM dossier) → a place the designer located on purpose
 * (referenceStops) → the stops of the network of that name: "feed" when
 * they are a real feed's (ground truth), "plan_stop" when they are the
 * designed plan's own (a candidate only). `points` lists every match (a
 * name may stand for both sides of a street). null when it cannot be
 * located: the clause is then "unknown", never a guess.
 */
const locate = (ref, spec, territory, referenceStops = null, stopsAuthority = "plan") => {
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
  return hit([...(territory?.pois?.items || []), ...(territory?.existing_stops || [])], "territory") || hit(referenceStops, "design") || hit(spec.stops, stopsAuthority === "feed" ? "feed" : "plan_stop");
};

/** Metres from a stop to the nearest point of a located place. */
const distanceTo = (stop, place) => Math.min(...place.points.map((p) => haversineMeters(stop.lat, stop.lon, p.lat, p.lon)));

/** locate() with the check's context: a real feed's stops are ground truth. */
const locateIn = (ctx, ref) => locate(ref, ctx.spec, ctx.territory, ctx.referenceStops, ctx.stopsAuthority);

/** The stop of a list nearest to a located place: { stop, d } | null. */
const nearestTo = (stops, place) => {
  let best = null;
  for (const s of stops) {
    if (!s || s.lat == null) continue;
    const d = distanceTo(s, place);
    if (!best || d < best.d) best = { stop: s, d };
  }
  return best;
};

/** The departures of the directions a clause measures: all, or the one it names (its id, directionIn). */
const directionsOf = (byDirection, params) => {
  const d = params.direction == null || params.direction === "" || params.direction === "both" ? null : String(params.direction);
  if (!d) return [...byDirection.values()];
  return byDirection.has(d) ? [byDirection.get(d)] : [];
};
/** The direction as an expected text says it: ", direction 0"; named by words, its id beside them (", direction 0 (La Baute)"). */
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

/**
 * The stop sequences of a line: every pattern of a feed view; on a design,
 * its directions and (when the spec module knows them) its variants.
 */
const patternsOfLine = (line, spec) => {
  if (spec.kind !== "feed" && typeof networkSpec.patternsOf === "function") {
    try {
      const p = networkSpec.patternsOf(line);
      if (Array.isArray(p) && p.length) return p;
    } catch {
      /* fall back to the directions */
    }
  }
  return line.directions || [];
};
const servedStopIds = (line, spec) => [...new Set(patternsOfLine(line, spec).flatMap((p) => p.stops || []))];

/** The names of a network's stops by id, read once per spec (a memo that never serialises: a spec measured is never changed). */
const stopNamesOf = (spec) => {
  if (spec._stopNames) return spec._stopNames;
  const names = new Map((spec.stops || []).map((x) => [x.id, x.name]));
  if (Object.isExtensible(spec)) Object.defineProperty(spec, "_stopNames", { value: names, enumerable: false });
  return names;
};
const sameDirection = (t, p) => !given(p.direction) || p.direction === "both" || String(t.direction) === String(p.direction);

// ── Directions: the id a clause's words name on a line (see the header) ────

// The words naming no direction (each one is measured), and those a direction is introduced with.
const EVERY_DIRECTION = new Set(["both", "all", "any", "les deux", "les deux sens", "tous", "tous les sens", "toutes"]);
const DIRECTION_WORD = /^(?:en\s+direction|[àa]\s+destination|vers|direction|dir\.?|sens|towards|to)\s+/i;
// After a direction word, « de / du / des / d' » is the article of the destination's name: « direction de
// Pélissier », « en direction de la Gare » go there — read as an origin, they would be measured on the way back.
const DEST_ARTICLE = /^(?:(?:de|du|des)\s+|d['’]\s*)/i;
// The words a direction is named with by where its trips START (« depuis Les Tilleuls », « au départ de … », « from
// … »): an origin, never its destination — read as one, « le sens depuis Les Tilleuls » would be the way back. A bare
// « de / du / des » says it only as written (« des Tilleuls »), never after a direction word (DEST_ARTICLE).
const ORIGIN_WORD = /^(?:(?:au\s+d[ée]part|en\s+provenance)\s+)?(?:(?:depuis|from|leaving|du|des|de)\s+|d['’]\s*)/i;
const ORIGIN_EXPLICIT = /^(?:(?:au\s+d[ée]part|en\s+provenance)\s+(?:(?:du|des|de)\s+|d['’]\s*)|(?:depuis|from|leaving)\s+)/i;
// Between an origin and a destination in words: « depuis Cantepau vers Parking Mézard », « from A to B ».
const TO_WORD = /\s+(?:vers|towards|to|jusqu['’]\s*(?:à|a|au|aux))\s+/i;
// An article a stop's name may not bear: « vers la Gare », « de la Gare » name the stop « Gare ».
const ARTICLE = /^(?:(?:la|le|les|the)\s+|l['’]\s*)/i;
// The arrow a timetable writes between a direction's two ends: « Renaudié → Portes d'Albi ».
const LABEL_ARROW = /\s*(?:→|⟶|➔|➜|⇒|->|=>)\s*|\s+>\s+/;
/** Whether a value names a direction by its two ends (« Origin → Destination ») rather than a stop. */
const isDirectionLabel = (v) => LABEL_ARROW.test(str(v && typeof v === "object" ? v.name : v));

/**
 * The patterns a direction is read on, each side's main ones first (a feed's
 * patterns come by their trips, a design's directions before its variants):
 * the line in the network measured and, for a relational clause, in the feed
 * before the plan → [{ dir, keys, last, headsigns }].
 */
const directionPatterns = (sides) =>
  sides.flatMap(({ spec, line }) =>
    (line ? patternsOfLine(line, spec) : [])
      .filter((p) => Array.isArray(p.stops) && p.stops.length)
      .map((p) => {
        const names = p.stops.map((id) => stopNamesOf(spec).get(id) || String(id));
        return { dir: str(p.direction ?? p.id) || "0", keys: names.map(nameKey), last: names[names.length - 1], headsigns: [p.headsign, ...(Array.isArray(p.headsigns) ? p.headsigns : [])].map(str).filter(Boolean) };
      }),
  );

/** Each direction with the terminus of its main pattern, as a verdict lists them: « 0 → La Baute, 1 → Pélissier ». */
const directionsText = (patterns) => {
  const main = new Map();
  for (const p of patterns) if (!main.has(p.dir)) main.set(p.dir, p.last);
  return [...main].sort(([a], [b]) => (a < b ? -1 : 1)).map(([d, last]) => `${d} → ${last}`).join(", ") || "none";
};

/**
 * The ways a direction's words may be read, the most literal first: as
 * written — an id, a destination, or a label « A → B » (one end left empty
 * names the other alone: « A → » is where the trips start) —, then without
 * the word introducing them (« vers … », « sens 1 », « en direction de … »:
 * the « de » after it is the destination's article, « direction de Pélissier »
 * is the way to Pélissier), then, introduced by where the trips start
 * (« depuis … », « au départ de … », « from … », and as written only « de … »),
 * an origin, or both ends in words (« depuis A vers B »).
 *   → [{ id } | { origin, dest }] (origin or dest null: that end is not named)
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
    // « direction de / du / des / d' X »: the destination X, never where the trips start.
    if (!ORIGIN_EXPLICIT.test(bare)) {
      const dest = bare.replace(DEST_ARTICLE, "").trim();
      if (dest !== bare) asWritten(dest);
    }
  }
  // An origin: as written (« depuis », « au départ de », « de Les Tilleuls »), and after a direction word only by
  // the words that name one (« le sens depuis Les Tilleuls »).
  for (const [w, word] of [[raw, ORIGIN_WORD], ...(introduced ? [[bare, ORIGIN_EXPLICIT]] : [])]) {
    if (!word.test(w) || LABEL_ARROW.test(w)) continue;
    const ends = w.replace(word, "").trim().split(TO_WORD).map((x) => x.trim());
    if (ends[0]) out.push({ origin: ends[0], dest: ends.length > 1 ? ends[ends.length - 1] || null : null });
  }
  return out;
};

/**
 * The directions one reading reaches (`partial`: false, by exact names only;
 * "within", also the stops and headsigns whose name holds the words whole):
 * with both ends, those whose patterns call at the origin and later at the
 * destination, else those the destination alone names; a destination, those
 * whose patterns end there or bear it as their headsign; an origin alone,
 * those whose patterns start there. → [ids]
 */
const directionsNamed = (sides, patterns, { origin, dest }, partial) => {
  // A name, and the same without an article the stop's own name may not bear (« la Gare »).
  const namesOf = (name) => [...new Set([name, name.replace(ARTICLE, "").trim()])].filter(Boolean);
  // The stops a name stands for, in every network read (clauseTrips.stopKeys), the first of its forms that names one.
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
/** What a reading asked of the trips, as a verdict says none does. */
const readingText = (r) =>
  !r ? null : r.origin && r.dest ? `runs from ${r.origin} to ${r.dest}, ends at ${r.dest} or bears it as its headsign` : r.dest ? `ends at ${r.dest} or bears it as its headsign` : r.origin ? `starts at ${r.origin}` : null;

/**
 * The direction a clause names on a line, as the id its trips bear: an id
 * ("0", "1"), a destination (« La Baute », « vers La Baute »: the direction
 * whose trips end there or bear it as their headsign), an origin (« depuis
 * Pélissier », « Pélissier → »: the direction whose trips start there) or a
 * label « Renaudié → Portes d'Albi » (whose trips run from the one to the
 * other), read on the line in each network of `sides` ([{ spec, line }]).
 * Every reading (readingsOf) is tried by exact names first, then by the stops
 * whose name holds the words whole: a destination named « Sens Gare » stays
 * one, « sens 1 » is never a stop « Sens », « depuis Les Tilleuls » never the
 * way to Les Tilleuls.
 *   → null (none named: each direction is measured) | { id, label } |
 *     { error, none? } — a direction no trip reaches (none) or that names
 *     every direction is never measured over all of them.
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
        // A number that is none of the line's ids names no stop either.
        if (/^\d+$/.test(r.id)) return { error: `${of}: not one of its directions (${directionsText(patterns)})`, none: true };
        continue;
      }
      const found = directionsNamed(sides, patterns, r, partial);
      if (found.length === 1) return { id: found[0], label: `${found[0]} (${raw})` };
      if (found.length > 1) return { error: `${of} names ${found.length === 2 ? "both directions" : `directions ${found.join(", ")}`} (${directionsText(patterns)}): give the direction's id` };
    }
  }
  // Said by the most specific reading of the words (an origin when they name where the trips start).
  const asked = readingText([...readings].reverse().find((r) => r.id == null));
  return { error: `${of}: ${asked ? `no trip ${asked}` : "names neither where its trips start nor where they end"} (its directions: ${directionsText(patterns)})`, none: true };
};

/** The params a clause is measured with on a line: its direction read (directionIn) as an id, or none. */
const withDirection = (p, resolved, key = "direction") => ({ ...p, [key]: resolved ? resolved.id : null });
/** A direction read as an expected text names it: null when none was named, or it could not be read. */
const readDirection = (d) => (d && d.id != null ? d : null);
/**
 * Whether the call at position i of a trip is where it ends (its last call: an
 * arrival, no departure) or where it starts (its first: a departure, no
 * arrival). A trip of a single call — some published feeds carry one — does
 * both there.
 */
const endsThere = (t, i) => i > 0 && i === t.keys.length - 1;
const startsThere = (t, i) => i === 0 && t.keys.length > 1;
/**
 * How a line's patterns (in the direction read, when one is) call at a stop,
 * at the call a clause reads there (occurrence, callOf): "leaves" when one
 * leaves from it, "ends" when they only end there, null when none calls there.
 */
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
 * The direction a clause of one line measures (trips_count, departure_at):
 * its `direction`, and a `towards` written « Origin → Destination » — a
 * direction named by its two ends, whose stops are never read as one (read
 * so, « vers Renaudié → Portes d'Albi » would count the trips of both
 * directions, each reaching one of the two). Both given, they must name the same direction.
 *   → { dir: null | { id, label } } | { error }
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
 * Whether a direction that cannot be read on a line is the clause's verdict:
 * on a line the clause names, always; said of every line, only when it names
 * both of the line's directions — a line none of whose trips go that way is
 * not the clause's (the lines that do are measured; none: unknown).
 */
const unreadDirection = (d, named) => Boolean(d?.error) && (named || !d.none);

// The name keys of the stops a line serves (every pattern), memoised per spec.
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

/**
 * The stops a clause names on a line, resolved (clauseTrips.stopKeys): a
 * null ref stays null. A name no stop of the network matches is unknown; a
 * stop the line never serves fails ("line K does not serve X").
 *   → { stops: [{ keys, name } | null] } | { result: (clause) => verdict }
 */
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

/**
 * Which call of a trip a clause's stop is, as the clause says it
 * (`occurrence`): "first", "last" or the call's rank among those bearing the
 * name (1 = the first); null when the clause says nothing; { error } when it
 * says something else.
 */
const occurrenceOf = (p) => {
  const v = p.occurrence;
  if (v == null || v === "") return null;
  const word = str(v).toLowerCase();
  if (word === "first" || word === "last") return word;
  const n = num(v);
  return Number.isInteger(n) && n >= 1 ? n : { error: `incomplete clause (occurrence "${str(v)}": first, last or the call's rank from 1)` };
};
/** The occurrence as the verdict's expected text says it: " (last call)", " (call 2)"; nothing without one. */
const occurrenceText = (occurrence) => (occurrence == null ? "" : typeof occurrence === "number" ? ` (call ${occurrence})` : ` (${occurrence} call)`);

/**
 * The call of a trip the clause's stop means. A name borne by ONE call of the
 * trip is that call. Borne by several (a line through two villages' « Centre
 * Bourg », a loop through the station twice), it is the one `occurrence`
 * names — first, last or its rank among the calls of that name — and, when
 * the clause names none, the first call: the reading the recorded verdicts
 * rest on (the sheet reader writes the occurrence where its grid repeats a
 * name, a planner may too).
 *   → position in the trip | -1 (no such call on this trip)
 */
const callOf = (trip, keys, occurrence = null) => {
  if (occurrence == null) return indexIn(trip, keys);
  const all = [];
  for (let i = 0; i < trip.keys.length; i++) if (keys.has(trip.keys[i])) all.push(i);
  const i = occurrence === "first" ? all[0] : occurrence === "last" ? all[all.length - 1] : all[occurrence - 1];
  return i == null ? -1 : i;
};

/**
 * How many calls of the trip bear the clause's stop (callsOfStop). Where the clause names no occurrence and a trip calls there
 * several times, the measure reads the first: a verdict that fails says so (repeatedNote) — the clause may mean
 * another call (a terminus after a village of the same name), and nothing tells it but its occurrence.
 */
const callsOfStop = (trip, keys) => {
  let n = 0;
  for (const k of trip.keys) if (keys.has(k)) n += 1;
  return n;
};
const repeatedNote = (name, n, past = false) =>
  `measured at the first of ${n} calls at ${name}${past ? " past the trip's origin (no one arrives where it starts)" : ""}: the clause names no occurrence (first, last or a rank tells another call)`;
/** Said of a failure at a stop where trips end: their arrival there was not read as a departure. */
const endingNote = (name, n) => `${n} trip${n === 1 ? " ends" : "s end"} at ${name}: an arrival there is no departure (not counted)`;
/** Said of a headway at a stop that is only where the trips end (callKind "ends"): nothing leaves to measure. */
const terminusNote = (name, occurrence, dir) =>
  `no trip leaves from ${name}${occurrenceText(occurrence)}${dir ? ` in direction ${dir.label}` : ""}: the trips end there, and an arrival is no departure — no headway to measure there`;

/** The lines a relational clause names (line / lines), or every line of the measured network. */
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

/** The feed before the plan as a spec to compare with: null without one, or when the measured feed is that feed. */
const baseSpecOf = (ctx) => (ctx.baseline && !ctx.baseline.self ? ctx.baseline.spec : null);

module.exports = { findLine, pairedLine, nameMatches, AUTHORITATIVE, PLAN_STOP_NOTE, weakest, locate, distanceTo, locateIn, nearestTo, directionsOf, directionLabel, linesFor, patternsOfLine, servedStopIds, stopNamesOf, sameDirection, isDirectionLabel, directionIn, withDirection, readDirection, endsThere, startsThere, callKind, clauseDirection, unreadDirection, servedKeysOf, stopsOfClause, occurrenceOf, occurrenceText, callOf, callsOfStop, repeatedNote, endingNote, terminusNote, linesOfClause, baseSpecOf };
