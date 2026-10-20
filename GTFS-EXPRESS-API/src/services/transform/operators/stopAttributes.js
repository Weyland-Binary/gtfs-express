/**
 * Stop attributes — the stops' own records, not the trips serving them.
 *
 *   rename_stop          "L'arrêt « Gendarmerie » devient « Acacias »."
 *   set_accessibility    "Gare, Mairie et Hôpital sont rendus accessibles UFR ;
 *                         les courses S53 à S75 sont assurées en autocar non accessible."
 *   set_stop_attributes  code, platform code, fare zone, description, url,
 *                        level, parent station, TTS name, timezone, street access
 *   merge_stops          duplicates folded into one stop
 *
 * WHICH STOPS a reference means (the four operators):
 *   • an id is that stop, whatever its location type;
 *   • a name is every stop carrying it (case, accents, punctuation ignored),
 *     of any location type, when they form ONE PLACE: a station with its
 *     platforms, entrances and nodes, or stops ≤ 400 m apart (both sides
 *     of a road). A name carried at several places (the "Église" of two
 *     villages) is a question (stop_ambiguous) unless all: true;
 *   • a name that is only part of stop names is read as the one full name
 *     it points to ("Jean Perrin" → "Collège Jean Perrin", with a warning);
 *     when it points to several names, it is a question.
 *
 * rename_stop — stop_name of the stop(s); by default a renamed station's
 * children follow when they carry its name: exactly ("Grand Central") or
 * inside theirs ("Place Jean-Jaurès (Quai 1)" → "Place de la Paix (Quai 1)").
 * platforms: true also gives the new name to platforms with a name of
 * their own; platforms: false renames the station only. Cascade (default
 * true): trip_headsign and stop_headsign EQUAL to the old name on trips
 * serving a renamed stop take the new name (a headsign naming a homonym
 * elsewhere is left alone). Longer texts that contain the old name are
 * reported, and rewritten only when asked: rename_in_headsigns: true
 * (headsigns), rename_in_routes: true (route_long_name of the lines
 * serving the stop) — never inside the name of another stop ("Gare" is
 * not rewritten inside "Gare Routière"). translations.txt: a translation
 * that equals the old name (an untranslated proper name) follows; a real
 * translation of the old name is wrong afterwards, so the step asks
 * (translations_stale) unless translations gives the new ones
 * ({ fr: "…" }; null drops a language) or says "drop" / "keep"; a
 * spelling-only change (same letters) keeps them. tts_stop_name reading
 * the old name is cleared. GTFS cannot date a name: from_date inside the
 * feed's validity is a warning (the new name shows from the feed's first
 * day), after its end a question; other scope parameters are a question.
 * noop when every stop already carries the new name.
 *
 * set_accessibility — wheelchair_boarding (0 unknown/inherit, 1 accessible,
 * 2 not accessible) on stops, a station's platforms and boarding areas
 * included; and/or wheelchair_accessible (and bikes_allowed) on trips: a
 * line (+ direction, selection: times, window, pattern…) or trips by id or
 * trip_short_name ("S53-S75" is a range). The scope (days, from_date…)
 * applies to the trips: trips also running outside it are split first,
 * the copies keep the old value. Stops cannot be dated (warning).
 * Warnings: a station and its platforms disagreeing, an accessible
 * station without an accessible entrance, 0 on a platform meaning "as its
 * station", vehicle blocks mixing accessible and non-accessible trips,
 * accessible trips calling at inaccessible stops, stops made accessible
 * whose trips have no vehicle accessibility (transport.data.gouv.fr
 * recommends filling both).
 *
 * set_stop_attributes — code, platform_code, zone_id, desc, url, level_id,
 * parent_station, tts_name, timezone (null clears). name and position are
 * refused (rename_stop / relocate_stop), wheelchair_boarding too
 * (set_accessibility). References are checked: the parent is a station
 * (a boarding area's parent is a platform), a station has no parent,
 * entrances/nodes/boarding areas keep one, the level exists, the timezone
 * is an IANA name, the url is http(s). One code for several stops is a
 * question unless all: true. Warnings: fare zones fare_rules do not know
 * or no longer reach, duplicate codes, a parent far away, pathways
 * linking two stations, stop_timezone ignored under a parent.
 *
 * merge_stops — the duplicates are folded into the survivor (keep, else
 * the stop with the most stop_times; a tie is a question). Every reference
 * is repointed through smartEditService.planStopMerge (stop_times,
 * children, transfers, pathways, stop_areas, location groups, fare join
 * rules; optional fields back-filled) plus translations.txt; transfers
 * and pathways that linked two of the merged stops are removed, identical
 * transfers deduplicated. Duplicates farther than max_distance_m (150 m)
 * are a question (merge_far) unless confirm_far: true; different location
 * types cannot merge. Warnings: trips now calling twice in a row (or in a
 * loop) at the survivor, names, zones, codes or accessibility that differed.
 *
 * Questions, warnings and summaries are in ctx.lang (i18n.js).
 */

"use strict";

const R = require("../resolve");
const S = require("../scope");
const calendars = require("../calendars");
const { resolveSelection, SELECTION_PARAMS } = require("../selection");
const { nameKey } = require("../../network/networkSpec")._internals;
const { haversineMeters } = require("../../../utils/geoUtils");
const { tr, number } = require("../i18n");

const SAME_PLACE_M = 400;
const MERGE_DEFAULT_M = 150;
const FAR_PARENT_M = 1000;
const MAX_NAME = 200;
const META_KEYS = new Set(["note", "comment", "reason", "source", "whole_feed"]);
const SCOPE_KEYS = ["to_date", "dates", "period", "except", "days", "region"];

// ── small helpers ────────────────────────────────────────────────────────

const str = (v) => (v == null ? "" : String(v).trim());
const given = (v) => v !== undefined && v !== null && !(typeof v === "string" && v.trim() === "") && !(Array.isArray(v) && !v.length);
const ymdText = (y) => `${y.slice(0, 4)}-${y.slice(4, 6)}-${y.slice(6, 8)}`;
const tableExists = (db, t) => Boolean(db && db.prepare("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = ?").get(t));
const columnsOf = (db, t) => (tableExists(db, t) ? db.prepare(`PRAGMA table_info(${t})`).all().map((c) => c.name) : []);
const chunks = (list, n = 400) => {
  const out = [];
  for (let i = 0; i < list.length; i += n) out.push(list.slice(i, i + n));
  return out;
};
const marks = (list) => list.map(() => "?").join(",");
const quoteList = (list, max = 3, lang) => {
  const shown = list.slice(0, max).map((x) => `"${x}"`).join(", ");
  return list.length > max ? tr(lang, "stop_attributes.quote_more", { names: shown, count: list.length - max }) : shown;
};

/** true / false, null when absent, undefined when unreadable. */
const flag = (v) => {
  if (v === undefined || v === null || v === "") return null;
  if (v === true || v === false) return v;
  const s = String(v).trim().toLowerCase();
  if (["true", "1", "yes", "oui", "y"].includes(s)) return true;
  if (["false", "0", "no", "non", "n"].includes(s)) return false;
  return undefined;
};

const lt = (s) => String(s?.location_type ?? "0") || "0";
// The kind of a stop, as a key ("boarding area"); kindWord / aKind / nKinds say it in a language.
const kindOf = (s) => ({ 1: "station", 2: "entrance", 3: "node", 4: "boarding area" })[lt(s)] || (s.parent ? "platform" : "stop");
const KIND_WORD = { station: "stop_attributes.kind_station", entrance: "stop_attributes.kind_entrance", node: "stop_attributes.kind_node", "boarding area": "stop_attributes.kind_boarding_area", platform: "stop_attributes.kind_platform", stop: "stop_attributes.kind_stop" };
const A_KIND = { station: "stop_attributes.a_kind_station", entrance: "stop_attributes.a_kind_entrance", node: "stop_attributes.a_kind_node", "boarding area": "stop_attributes.a_kind_boarding_area", platform: "stop_attributes.a_kind_platform", stop: "stop_attributes.a_kind_stop" };
const N_KINDS = { station: "stop_attributes.n_kind_station", entrance: "stop_attributes.n_kind_entrance", node: "stop_attributes.n_kind_node", "boarding area": "stop_attributes.n_kind_boarding_area", platform: "stop_attributes.n_kind_platform", stop: "stop_attributes.n_kind_stop" };
const kindWord = (s, lang) => tr(lang, KIND_WORD[kindOf(s)]);
const dist = (a, b) => (a && b && a.lat != null && a.lon != null && b.lat != null && b.lon != null ? haversineMeters(a.lat, a.lon, b.lat, b.lon) : null);
const metres = (m, lang) => (m >= 1000 ? `${number(lang, m / 1000, 1)} km` : `${number(lang, Math.round(m))} m`);

// Whole-word matching, case-insensitive (Unicode letters and digits are word characters).
const escapeRe = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
const wordRe = (text) => new RegExp(`(^|[^\\p{L}\\p{N}])(${escapeRe(text)})(?=$|[^\\p{L}\\p{N}])`, "giu");
const hasWords = (hay, needle) => Boolean(needle) && wordRe(needle).test(String(hay ?? ""));
const replaceWords = (hay, needle, repl) => String(hay ?? "").replace(wordRe(needle), (m, pre) => `${pre}${repl}`);
// Name keys (nameKey) containing another as whole words.
const keyHas = (hay, needle) => Boolean(needle) && ` ${hay} `.includes(` ${needle} `);

const childMap = (model) => {
  const out = new Map();
  for (const s of model.stops.values()) {
    if (!s.parent) continue;
    if (!out.has(s.parent)) out.set(s.parent, []);
    out.get(s.parent).push(s);
  }
  return out;
};

const listOf = (v) => {
  if (Array.isArray(v)) return v.filter(given);
  if (!given(v)) return [];
  if (typeof v === "string" && /[;,]/.test(v)) return v.split(/[;,]/).map((x) => x.trim()).filter(Boolean);
  return [v];
};

// ── which stops a reference means ────────────────────────────────────────

/** Stops of one place: a station with its children, siblings, or ≤ 400 m apart. */
const placesOf = (hits) => {
  const idx = new Map(hits.map((h, i) => [h.id, i]));
  const up = hits.map((_, i) => i);
  const find = (i) => (up[i] === i ? i : (up[i] = find(up[i])));
  const join = (a, b) => {
    const x = find(a);
    const y = find(b);
    if (x !== y) up[Math.max(x, y)] = Math.min(x, y);
  };
  const byParent = new Map();
  hits.forEach((h, i) => {
    if (!h.parent) return;
    if (idx.has(h.parent)) join(i, idx.get(h.parent));
    if (byParent.has(h.parent)) join(i, byParent.get(h.parent));
    else byParent.set(h.parent, i);
  });
  for (let i = 0; i < hits.length; i++) {
    for (let j = i + 1; j < hits.length; j++) {
      const d = dist(hits[i], hits[j]);
      if (d != null && d <= SAME_PLACE_M) join(i, j);
    }
  }
  const groups = new Map();
  hits.forEach((h, i) => {
    const r = find(i);
    if (!groups.has(r)) groups.set(r, []);
    groups.get(r).push(h);
  });
  return [...groups.values()];
};

const describePlace = (place) => `${place[0].name} (${place.map((s) => s.id).slice(0, 4).join(", ")}${place.length > 4 ? ", …" : ""})`;

/**
 * The stops a reference means. → { stops, by: "id" | "name" | "partial", name }
 * or { ambiguity }. `all`: a name carried at several places means all of them.
 */
const findStops = (model, ref, { all = false, lang } = {}) => {
  const raw = str(ref && typeof ref === "object" ? ref.id || ref.stop_id || ref.name : ref);
  if (!raw) return { ambiguity: { code: "stop_missing", message: tr(lang, "resolve.stop_missing") } };
  if (model.stops.has(raw)) {
    const s = model.stops.get(raw);
    return { stops: [s], by: "id", name: s.name };
  }
  const every = [...model.stops.values()];
  let k = nameKey(raw);
  let hits = k ? every.filter((s) => nameKey(s.name) === k) : [];
  let by = "name";
  if (!hits.length && k.length >= 4) {
    // Part of a name: children follow their station, then one full name must remain.
    // Whole words only: "Gare" is part of "Gare Albi-Ville", not of "Nougarède".
    let part = every.filter((s) => ["0", "1"].includes(lt(s)) && keyHas(nameKey(s.name), k));
    const ids = new Set(part.map((s) => s.id));
    part = part.filter((s) => !(s.parent && ids.has(s.parent)));
    const names = [...new Map(part.map((s) => [nameKey(s.name), s.name])).values()];
    if (names.length > 1) return { ambiguity: { code: "stop_ambiguous", message: tr(lang, "stop_attributes.stop_partial_ambiguous", { ref: raw, count: names.length }), options: names.slice(0, 12) } };
    if (names.length === 1) {
      k = nameKey(names[0]);
      hits = every.filter((s) => nameKey(s.name) === k);
      by = "partial";
    }
  }
  if (!hits.length) return { ambiguity: { code: "stop_unknown", message: tr(lang, "stop_attributes.stop_unknown", { ref: raw }) } };
  const places = placesOf(hits);
  if (places.length > 1 && !all) {
    let far = 0;
    for (let i = 0; i < places.length; i++) for (let j = i + 1; j < places.length; j++) far = Math.max(far, dist(places[i][0], places[j][0]) || 0);
    const message = far ? tr(lang, "stop_attributes.stop_places_far", { ref: raw, count: places.length, distance: metres(far, lang) }) : tr(lang, "stop_attributes.stop_places", { ref: raw, count: places.length });
    return { ambiguity: { code: "stop_ambiguous", message, options: places.map(describePlace).slice(0, 12) } };
  }
  return { stops: hits, by, name: hits[0].name };
};

/** Several references (a list, or names separated by commas). */
const findMany = (model, refs, { all = false, param = "stops", lang } = {}, ambiguities = [], warnings = []) => {
  const out = new Map();
  for (const ref of refs) {
    const f = findStops(model, ref, { all, lang });
    if (f.ambiguity) {
      ambiguities.push({ param, ...f.ambiguity });
      continue;
    }
    if (f.by === "partial") warnings.push(tr(lang, "stop_attributes.read_as", { ref: str(ref && typeof ref === "object" ? ref.name : ref), name: f.name }));
    for (const s of f.stops) out.set(s.id, s);
  }
  return [...out.values()];
};

/**
 * GTFS cannot date a stop's record: from_date inside the validity is a
 * warning, after its end or any other scope parameter a question. `what`:
 * the code of the words naming the record ("stop_attributes.what_name").
 */
const undatable = (model, p, what, ambiguities, warnings, lang) => {
  const words = tr(lang, what);
  const other = SCOPE_KEYS.filter((k) => given(p[k]) && p[k] !== "all");
  if (other.length) ambiguities.push({ param: other[0], code: "scope_unsupported", message: tr(lang, "stop_attributes.scope_unsupported", { what: words, params: other.join(", ") }) });
  if (!given(p.from_date)) return;
  const from = calendars.parseDate(p.from_date);
  if (!from) {
    ambiguities.push({ param: "from_date", code: "date_invalid", message: tr(lang, "scope.date_invalid", { value: String(p.from_date) }) });
    return;
  }
  if (!model.range) return;
  if (from > model.range.end) ambiguities.push({ param: "from_date", code: "after_validity", message: tr(lang, "stop_attributes.after_validity", { end: ymdText(model.range.end), from: ymdText(from) }) });
  else if (from > model.range.start) warnings.push(tr(lang, "stop_attributes.undated", { what: words, start: ymdText(model.range.start), from: ymdText(from) }));
};

// ══ rename_stop ═════════════════════════════════════════════════════════

// The descendants of the renamed stops that follow them (see the header).
const followers = (model, rows, targets, { oldKey, spellings, newName, platforms }) => {
  const kids = childMap(model);
  const changes = new Map();
  const ownKept = [];
  const flagKept = [];
  const seen = new Set(targets.map((s) => s.id));
  const queue = [...targets];
  while (queue.length) {
    const s = queue.shift();
    for (const c of kids.get(s.id) || []) {
      if (seen.has(c.id)) continue;
      seen.add(c.id);
      const cur = rows.get(c.id)?.stop_name ?? "";
      let to = null;
      let how = null;
      if (nameKey(cur) === oldKey) [to, how] = [newName, "same"];
      else {
        const sub = spellings.reduce((t, sp) => replaceWords(t, sp, newName), cur);
        if (sub !== cur) [to, how] = [sub, "derived"];
        else if (platforms === true && lt(c) === "0") [to, how] = [newName, "own"];
      }
      if (to == null) {
        if (lt(c) === "0") ownKept.push(c);
        continue;
      }
      if (platforms === false) {
        flagKept.push(c);
        continue;
      }
      changes.set(c.id, { to, how });
      queue.push(c);
    }
  }
  return { changes, ownKept, flagKept };
};

// Old text → new text, inside a longer text, never inside another stop's name.
const substituter = (pairs, guardKeys) => (text) => {
  const t = String(text ?? "");
  const k = nameKey(t);
  if ([...guardKeys].some((g) => keyHas(k, g))) return t;
  return pairs.reduce((acc, [from, to]) => replaceWords(acc, from, to), t);
};

const TR_FIELDS = [["stops", "stop_name"], ["trips", "trip_headsign"], ["stop_times", "stop_headsign"], ["routes", "route_long_name"]];

/**
 * translations.txt rows translating a text this step changes, and what
 * becomes of each: follows (an untranslated name), kept (spelling only),
 * or stale (a real translation of the old text: the brief decides).
 */
const planTranslations = (db, edits, { oldKey, newName, oldIds, newIds, decision }) => {
  const plan = { update: [], drop: [], insert: [], stale: new Map(), rewriteFailed: 0, kept: 0 };
  if (!tableExists(db, "translations")) return plan;
  const where = TR_FIELDS.map(() => "(table_name = ? AND field_name = ?)").join(" OR ");
  const rows = db.prepare(`SELECT * FROM translations WHERE ${where} ORDER BY id`).all(TR_FIELDS.flat());
  const stAt = db.prepare("SELECT stop_headsign FROM stop_times WHERE trip_id = ? AND stop_sequence = ?");
  // The translation of the old name itself, per language.
  const oldTr = new Map();
  for (const r of rows) {
    if (r.table_name !== "stops") continue;
    const isOld = given(r.record_id) ? oldIds.has(r.record_id) : nameKey(r.field_value) === oldKey;
    if (isOld && !oldTr.has(r.language)) oldTr.set(r.language, r.translation);
  }
  const affected = [];
  for (const r of rows) {
    const e = edits[`${r.table_name}.${r.field_name}`];
    if (!e) continue;
    let hit = null;
    if (given(r.record_id)) {
      if (r.table_name === "stop_times") {
        const v = e.trips.has(r.record_id) ? stAt.get(r.record_id, r.record_sub_id)?.stop_headsign : null;
        const x = v != null ? e.values.get(v) : null;
        if (x) hit = { from: v, to: x.to };
      } else hit = e.records.get(r.record_id) || null;
    } else if (given(r.field_value) && e.values.has(r.field_value)) {
      const x = e.values.get(r.field_value);
      // Still translating records this step leaves alone: untouched.
      if (x.dead) hit = { from: r.field_value, to: x.to, byValue: true };
    }
    if (hit) affected.push({ row: r, ...hit });
  }
  for (const a of affected) {
    const r = a.row;
    const rekey = a.byValue ? { field_value: a.to } : {};
    if (nameKey(r.translation) === nameKey(a.from)) {
      plan.update.push({ id: r.id, translation: a.to, ...rekey });
      continue;
    }
    if (nameKey(a.from) === nameKey(a.to)) {
      if (a.byValue) plan.update.push({ id: r.id, ...rekey });
      continue;
    }
    const d = decision === "drop" || decision === "keep" ? decision : decision && Object.prototype.hasOwnProperty.call(decision, r.language) ? decision[r.language] : undefined;
    if (d === undefined) {
      if (!plan.stale.has(r.language)) plan.stale.set(r.language, r.translation);
      continue;
    }
    if (d === "keep") {
      if (a.byValue) plan.update.push({ id: r.id, ...rekey });
      plan.kept += 1;
      continue;
    }
    if (d === null || d === "drop") {
      plan.drop.push(r.id);
      continue;
    }
    // A new translation: the name itself, or the old one's translation inside a longer text.
    if (a.to === newName) plan.update.push({ id: r.id, translation: d, ...rekey });
    else if (oldTr.has(r.language) && hasWords(r.translation, oldTr.get(r.language))) plan.update.push({ id: r.id, translation: replaceWords(r.translation, oldTr.get(r.language), d), ...rekey });
    else {
      plan.drop.push(r.id);
      plan.rewriteFailed += 1;
    }
  }
  // Languages given for the new name that a renamed stop has no row for.
  if (decision && typeof decision === "object") {
    const dropped = new Set(plan.drop);
    const covered = new Set();
    for (const r of rows) {
      if (r.table_name !== "stops" || dropped.has(r.id)) continue;
      const up = plan.update.find((u) => u.id === r.id);
      if (given(r.record_id)) covered.add(`${r.language}|${r.record_id}`);
      else if ((up?.field_value ?? r.field_value) === newName) for (const id of newIds) covered.add(`${r.language}|${id}`);
    }
    for (const [lang, text] of Object.entries(decision).sort()) {
      if (typeof text !== "string") continue;
      for (const id of [...newIds].sort()) if (!covered.has(`${lang}|${id}`)) plan.insert.push({ table_name: "stops", field_name: "stop_name", language: lang, translation: text, record_id: id });
    }
  }
  return plan;
};

const readDecision = (v, lang) => {
  if (v === undefined || v === null || v === "") return { value: undefined };
  if (typeof v === "string" && ["drop", "keep"].includes(v.trim().toLowerCase())) return { value: v.trim().toLowerCase() };
  if (v && typeof v === "object" && !Array.isArray(v)) {
    const out = {};
    for (const [code, text] of Object.entries(v)) {
      if (!/^[A-Za-z]{2,3}(-[A-Za-z0-9]{2,8})*$/.test(code)) return { error: tr(lang, "rename_stop.translations_lang_invalid", { code }) };
      if (text === null || (typeof text === "string" && ["drop", "keep"].includes(text.trim().toLowerCase()))) out[code] = text === null ? null : text.trim().toLowerCase();
      else if (typeof text === "string" && text.trim()) out[code] = text.trim().replace(/\s+/g, " ");
      else return { error: tr(lang, "rename_stop.translations_text_invalid", { code }) };
    }
    // A language decided as drop/keep is written as such.
    for (const [code, text] of Object.entries(out)) if (text === "drop") out[code] = null;
    return { value: out };
  }
  return { error: tr(lang, "rename_stop.translations_invalid") };
};

const resolveRename = async (model, p, ctx = {}) => {
  const db = ctx.db;
  const lang = ctx.lang;
  const ambiguities = [];
  const warnings = [];
  const newName = str(p.name ?? p.new_name).replace(/\s+/g, " ");
  if (!newName) ambiguities.push({ param: "name", code: "name_missing", message: tr(lang, "rename_stop.name_missing") });
  else if (newName.length > MAX_NAME) ambiguities.push({ param: "name", code: "name_invalid", message: tr(lang, "rename_stop.name_invalid", { length: newName.length, max: MAX_NAME }) });
  const all = flag(p.all) === true;
  const target = findStops(model, p.stop, { all, lang });
  if (target.ambiguity) ambiguities.push({ param: "stop", ...target.ambiguity });
  const platforms = flag(p.platforms);
  const cascade = flag(p.cascade);
  const inRoutes = flag(p.rename_in_routes);
  const inHeadsigns = flag(p.rename_in_headsigns);
  for (const [k, v] of [["platforms", platforms], ["cascade", cascade], ["rename_in_routes", inRoutes], ["rename_in_headsigns", inHeadsigns], ["all", flag(p.all)]]) {
    if (v === undefined) ambiguities.push({ param: k, code: `${k}_invalid`, message: tr(lang, "common.flag_invalid", { name: k }), options: ["true", "false"] });
  }
  const decision = readDecision(p.translations, lang);
  if (decision.error) ambiguities.push({ param: "translations", code: "translations_invalid", message: decision.error, options: ["drop", "keep"] });
  undatable(model, p, "stop_attributes.what_name", ambiguities, warnings, lang);
  if (ambiguities.length) return { ambiguities, warnings };
  if (target.by === "partial") warnings.push(tr(lang, "stop_attributes.read_as", { ref: str(p.stop), name: target.name }));

  const rows = new Map(db.prepare("SELECT * FROM stops").all().map((r) => [r.stop_id, r]));
  const oldKey = nameKey(target.name);
  const spellings = [...new Set(target.stops.map((s) => rows.get(s.id)?.stop_name).filter(given))];
  // platforms: false — the station only, its platforms keep their name.
  let targets = target.stops;
  const flagKept = [];
  if (platforms === false) {
    const ids = new Set(targets.map((s) => s.id));
    flagKept.push(...targets.filter((s) => s.parent && ids.has(s.parent)));
    targets = targets.filter((s) => !(s.parent && ids.has(s.parent)));
  }
  const f = followers(model, rows, targets, { oldKey, spellings, newName, platforms });
  flagKept.push(...f.flagKept);
  const all_ = new Map(targets.map((s) => [s.id, { to: newName, how: "named" }]));
  for (const [id, c] of f.changes) all_.set(id, c);
  const stops = [...all_.entries()].map(([id, c]) => ({ id, from: rows.get(id)?.stop_name ?? "", to: c.to, how: c.how, kind: kindOf(model.stops.get(id)) })).filter((c) => c.from !== c.to);
  const unchanged = all_.size - stops.length;
  const changedIds = new Set(stops.map((c) => c.id));
  const oldIds = new Set(stops.filter((c) => c.how === "named" || c.how === "same").map((c) => c.id));
  const newIds = new Set(stops.filter((c) => c.to === newName).map((c) => c.id));

  // Old text → new text: the name, and the children's names that derive from it.
  const keyMap = new Map();
  for (const c of stops) if (c.how !== "own" && nameKey(c.from) && !keyMap.has(nameKey(c.from))) keyMap.set(nameKey(c.from), c.to);
  const pairs = spellings.filter((sp) => sp !== newName).map((sp) => [sp, newName]);
  // Never rewrite inside the name of another stop that contains the old one ("Gare" in "Gare Routière").
  const guard = new Set();
  for (const r of rows.values()) {
    const k = nameKey(r.stop_name);
    if (!changedIds.has(r.stop_id) && k !== oldKey && keyHas(k, oldKey)) guard.add(k);
  }
  const subst = substituter(pairs, guard);

  // Trips serving a renamed stop.
  const serving = new Set();
  for (const t of model.trips.values()) if (t.stops.some((s) => changedIds.has(s))) serving.add(t.id);
  const doEqual = cascade !== false;

  // trip_headsign
  const tripGroups = new Map();
  const tripEdited = new Map();
  let equalElsewhere = 0;
  let equalKept = 0;
  const longerTrips = new Map();
  const headsignCount = new Map();
  for (const r of db.prepare("SELECT trip_id, trip_headsign FROM trips WHERE trip_headsign IS NOT NULL AND trip_headsign != ''").all()) {
    headsignCount.set(r.trip_headsign, (headsignCount.get(r.trip_headsign) || 0) + 1);
    const to = keyMap.get(nameKey(r.trip_headsign));
    let next = null;
    if (to != null) {
      if (!serving.has(r.trip_id)) equalElsewhere += 1;
      else if (!doEqual) equalKept += 1;
      else if (r.trip_headsign !== to) next = to;
    } else if (serving.has(r.trip_id) && pairs.length) {
      const sub = subst(r.trip_headsign);
      if (sub !== r.trip_headsign) {
        if (inHeadsigns === true) next = sub;
        else longerTrips.set(r.trip_headsign, (longerTrips.get(r.trip_headsign) || 0) + 1);
      }
    }
    if (next == null) continue;
    const key = `${r.trip_headsign}\u0000${next}`;
    if (!tripGroups.has(key)) tripGroups.set(key, { from: r.trip_headsign, to: next, trips: [] });
    tripGroups.get(key).trips.push(r.trip_id);
    tripEdited.set(r.trip_id, { from: r.trip_headsign, to: next });
  }

  // stop_headsign (values first: a feed has few distinct ones)
  const stGroups = [];
  const longerStops = new Map();
  let stEqualKept = 0;
  for (const { v, n } of db.prepare("SELECT stop_headsign AS v, COUNT(*) AS n FROM stop_times WHERE stop_headsign IS NOT NULL AND stop_headsign != '' GROUP BY stop_headsign").all()) {
    const to = keyMap.get(nameKey(v));
    let next = null;
    let longer = false;
    if (to != null) next = v === to ? null : to;
    else if (pairs.length) {
      const sub = subst(v);
      if (sub !== v) [next, longer] = [sub, true];
    }
    if (next == null) continue;
    const on = db.prepare("SELECT trip_id FROM stop_times WHERE stop_headsign = ?").all(v).map((r) => r.trip_id);
    const mine = on.filter((id) => serving.has(id));
    const trips = [...new Set(mine)].sort();
    if (!trips.length) continue;
    if (longer && inHeadsigns !== true) {
      longerStops.set(v, trips.length);
      continue;
    }
    if (!longer && !doEqual) {
      stEqualKept += trips.length;
      continue;
    }
    stGroups.push({ from: v, to: next, trips, dead: mine.length === n });
  }

  // route_long_name
  const servingRoutes = new Set([...serving].map((id) => model.trips.get(id).route_id));
  const routeEdits = [];
  const routeMention = [];
  const routeOther = [];
  const longNames = new Map();
  const routeRows = db.prepare("SELECT route_id, route_short_name, route_long_name FROM routes").all();
  for (const r of routeRows) longNames.set(r.route_long_name, (longNames.get(r.route_long_name) || 0) + 1);
  for (const r of routeRows) {
    if (!given(r.route_long_name) || !pairs.length) continue;
    const sub = subst(r.route_long_name);
    if (sub === r.route_long_name) continue;
    const label = r.route_short_name || r.route_id;
    if (!servingRoutes.has(r.route_id)) routeOther.push(label);
    else if (inRoutes === true) routeEdits.push({ id: r.route_id, label, from: r.route_long_name, to: sub });
    else routeMention.push(`${label} ("${r.route_long_name}")`);
  }

  // translations.txt
  const nameCount = new Map();
  for (const r of rows.values()) nameCount.set(r.stop_name, (nameCount.get(r.stop_name) || 0) + 1);
  const valueMap = (list, counts) => {
    const out = new Map();
    const edited = new Map();
    for (const e of list) edited.set(e.from, (edited.get(e.from) || 0) + e.n);
    for (const e of list) if (!out.has(e.from)) out.set(e.from, { to: e.to, dead: edited.get(e.from) === (counts.get(e.from) || 0) });
    return out;
  };
  const edits = {
    "stops.stop_name": { records: new Map(stops.map((c) => [c.id, { from: c.from, to: c.to }])), values: valueMap(stops.map((c) => ({ from: c.from, to: c.to, n: 1 })), nameCount) },
    "trips.trip_headsign": { records: tripEdited, values: valueMap([...tripGroups.values()].map((g) => ({ from: g.from, to: g.to, n: g.trips.length })), headsignCount) },
    "stop_times.stop_headsign": { trips: new Set(stGroups.flatMap((g) => g.trips)), records: new Map(), values: new Map(stGroups.map((g) => [g.from, { to: g.to, dead: g.dead }])) },
    "routes.route_long_name": { records: new Map(routeEdits.map((r) => [r.id, { from: r.from, to: r.to }])), values: valueMap(routeEdits.map((r) => ({ from: r.from, to: r.to, n: 1 })), longNames) },
  };
  const trPlan = planTranslations(db, edits, { oldKey, newName, oldIds, newIds, decision: decision.value });
  if (trPlan.stale.size) {
    const langs = [...trPlan.stale.entries()].sort((a, b) => a[0].localeCompare(b[0]));
    const example = langs.map(([l, t]) => `${l}: "${t}"`).join("; ");
    const shape = langs.map(([l]) => `${l}: "…"`).join(", ");
    ambiguities.push({ param: "translations", code: "translations_stale", message: tr(lang, "rename_stop.translations_stale", { examples: example, shape }), options: ["drop", "keep"] });
    return { ambiguities, warnings };
  }

  // What stays as it was, and why.
  const keptByFlag = [...new Map(flagKept.map((s) => [s.id, s])).values()];
  if (keptByFlag.length) warnings.push(tr(lang, "rename_stop.kept_by_flag", { count: keptByFlag.length, names: quoteList([...new Set(keptByFlag.map((s) => s.name))], 3, lang) }));
  if (f.ownKept.length && platforms !== true) warnings.push(tr(lang, "rename_stop.own_names_kept", { count: f.ownKept.length, names: quoteList([...new Set(f.ownKept.map((s) => s.name))], 3, lang) }));
  const leftAtPlace = [];
  for (const s of model.stops.values()) {
    if (changedIds.has(s.id) || all_.has(s.id) || nameKey(s.name) !== oldKey || flagKept.some((x) => x.id === s.id)) continue;
    const near = [...changedIds].some((id) => {
      const o = model.stops.get(id);
      return o.parent === s.id || s.parent === o.id || (s.parent && s.parent === o.parent) || (dist(o, s) ?? Infinity) <= SAME_PLACE_M;
    });
    if (near) leftAtPlace.push(s);
  }
  if (leftAtPlace.length) warnings.push(tr(lang, "rename_stop.left_at_place", { count: leftAtPlace.length, name: target.name, stops: leftAtPlace.map((s) => `${kindWord(s, lang)} ${s.id}`).slice(0, 4).join(", ") }));
  const parents = [...new Set(stops.filter((c) => c.how === "named").map((c) => model.stops.get(c.id).parent).filter((id) => id && !all_.has(id)))];
  for (const pid of parents) {
    const ps = model.stops.get(pid);
    if (ps && nameKey(ps.name) !== oldKey && nameKey(ps.name) !== nameKey(newName)) warnings.push(tr(lang, "rename_stop.station_keeps_name", { name: ps.name, id: pid }));
  }
  if (equalElsewhere) warnings.push(tr(lang, "rename_stop.headsign_elsewhere", { count: equalElsewhere, name: target.name }));
  if (equalKept || stEqualKept) warnings.push(tr(lang, equalKept && stEqualKept ? "rename_stop.cascade_both" : equalKept ? "rename_stop.cascade_trips" : "rename_stop.cascade_stops", { trips: equalKept, stops: stEqualKept, name: target.name }));
  if (longerTrips.size || longerStops.size) {
    const vals = [...new Set([...longerTrips.keys(), ...longerStops.keys()])];
    warnings.push(tr(lang, "rename_stop.longer_headsigns", { name: target.name, values: quoteList(vals, 3, lang) }));
  }
  if (routeMention.length) warnings.push(tr(lang, "rename_stop.route_names", { count: routeMention.length, lines: routeMention.join(", "), name: target.name }));
  if (routeOther.length) warnings.push(tr(lang, "rename_stop.other_routes", { count: routeOther.length, lines: routeOther.join(", "), name: target.name }));
  if (trPlan.kept) warnings.push(tr(lang, "rename_stop.translations_kept", { count: trPlan.kept }));
  if (trPlan.rewriteFailed) warnings.push(tr(lang, "rename_stop.translations_dropped", { count: trPlan.rewriteFailed }));
  const tts = stops.filter((c) => given(rows.get(c.id)?.tts_stop_name) && nameKey(c.from) !== nameKey(c.to)).map((c) => c.id);
  if (tts.length) warnings.push(tr(lang, "rename_stop.tts_cleared", { count: tts.length }));
  const spellingOnly = nameKey(newName) === oldKey;
  const descs = spellingOnly ? [] : stops.filter((c) => hasWords(rows.get(c.id)?.stop_desc, target.name));
  if (descs.length) warnings.push(tr(lang, "rename_stop.desc_mentions", { count: descs.length, name: target.name }));
  if (tableExists(db, "pathways") && changedIds.size && !spellingOnly) {
    const ids = [...changedIds];
    const signs = db.prepare(`SELECT signposted_as, reversed_signposted_as FROM pathways WHERE from_stop_id IN (${marks(ids)}) OR to_stop_id IN (${marks(ids)})`).all([...ids, ...ids]).filter((r) => spellings.some((sp) => hasWords(r.signposted_as, sp) || hasWords(r.reversed_signposted_as, sp)));
    if (signs.length) warnings.push(tr(lang, "rename_stop.pathways_signposted", { count: signs.length, name: target.name }));
  }
  const twins = [...model.stops.values()].filter((s) => !all_.has(s.id) && nameKey(s.name) === nameKey(newName) && nameKey(newName) !== oldKey);
  if (twins.length) {
    const close = twins.filter((s) => [...changedIds].some((id) => (dist(model.stops.get(id), s) ?? Infinity) <= MERGE_DEFAULT_M));
    const words = { count: twins.length, name: newName, stops: twins.map((s) => s.id).slice(0, 4).join(", ") };
    warnings.push(close.length ? tr(lang, "rename_stop.twins_close", { ...words, distance: MERGE_DEFAULT_M, close: close.length }) : tr(lang, "rename_stop.twins_far", words));
  }
  if (stops.some((c) => nameKey(rows.get(c.id)?.stop_desc) === nameKey(c.to) && given(rows.get(c.id)?.stop_desc))) warnings.push(tr(lang, "rename_stop.name_equals_desc"));

  return {
    value: {
      oldName: target.name,
      newName,
      stops,
      unchanged,
      tts,
      trips: [...tripGroups.values()],
      stopTimes: stGroups.map((g) => ({ from: g.from, to: g.to, trips: g.trips })),
      routes: routeEdits,
      translations: { update: trPlan.update, drop: trPlan.drop, insert: trPlan.insert },
    },
    ambiguities: [],
    warnings,
  };
};

const KIND_ORDER = ["station", "platform", "stop", "entrance", "node", "boarding area"];

const applyRename = (db, v, { lang } = {}) => {
  const up = db.prepare("UPDATE stops SET stop_name = ? WHERE stop_id = ?");
  for (const c of v.stops) up.run(c.to, c.id);
  if (v.tts.length) {
    const clear = db.prepare("UPDATE stops SET tts_stop_name = NULL WHERE stop_id = ?");
    for (const id of v.tts) clear.run(id);
  }
  let trips = 0;
  for (const g of v.trips) for (const ids of chunks(g.trips)) trips += db.prepare(`UPDATE trips SET trip_headsign = ? WHERE trip_headsign = ? AND trip_id IN (${marks(ids)})`).run(g.to, g.from, ...ids).changes;
  let stopTimes = 0;
  for (const g of v.stopTimes) for (const ids of chunks(g.trips)) stopTimes += db.prepare(`UPDATE stop_times SET stop_headsign = ? WHERE stop_headsign = ? AND trip_id IN (${marks(ids)})`).run(g.to, g.from, ...ids).changes;
  const upRoute = db.prepare("UPDATE routes SET route_long_name = ? WHERE route_id = ?");
  for (const r of v.routes) upRoute.run(r.to, r.id);
  const t = v.translations;
  for (const u of t.update) {
    const sets = Object.keys(u).filter((k) => k !== "id");
    if (sets.length) db.prepare(`UPDATE translations SET ${sets.map((k) => `${k} = ?`).join(", ")} WHERE id = ?`).run(...sets.map((k) => u[k]), u.id);
  }
  for (const id of t.drop) db.prepare("DELETE FROM translations WHERE id = ?").run(id);
  for (const r of t.insert) db.prepare("INSERT INTO translations (table_name, field_name, language, translation, record_id) VALUES (?, ?, ?, ?, ?)").run(r.table_name, r.field_name, r.language, r.translation, r.record_id);

  const touched = trips + stopTimes + v.routes.length + t.update.length + t.drop.length + t.insert.length;
  if (!v.stops.length && !touched) return { summary: tr(lang, "rename_stop.noop", { name: v.newName }), noop: true };
  const kinds = new Map(KIND_ORDER.map((k) => [k, 0]));
  for (const c of v.stops) kinds.set(c.kind, (kinds.get(c.kind) || 0) + 1);
  for (const [k, n] of kinds) if (!n) kinds.delete(k);
  const derived = v.stops.filter((c) => c.how === "derived");
  const parts = [];
  if (v.stops.length) parts.push(`${[...kinds.entries()].map(([k, n]) => tr(lang, N_KINDS[k], { count: n })).join(", ")}${derived.length ? ` (${quoteList(derived.map((c) => c.to), 2, lang)})` : ""}`);
  if (trips || stopTimes) parts.push(tr(lang, trips && stopTimes ? "rename_stop.part_headsigns_both" : trips ? "rename_stop.part_headsigns_trips" : "rename_stop.part_headsigns_stop_times", { trips, stops: stopTimes }));
  if (v.routes.length) parts.push(tr(lang, "rename_stop.part_line_names", { lines: v.routes.map((r) => r.label).join(", ") }));
  if (t.update.length || t.insert.length || t.drop.length) parts.push(tr(lang, "rename_stop.part_translations", { written: t.update.length + t.insert.length, dropped: t.drop.length }));
  const already = v.unchanged ? tr(lang, "rename_stop.already", { count: v.unchanged }) : "";
  return { summary: tr(lang, "rename_stop.summary", { old: v.oldName, name: v.newName, parts: parts.join(tr(lang, "common.semicolon")), already }) };
};

// ══ set_accessibility ═══════════════════════════════════════════════════

const WHEELCHAIR = { 0: "0", 1: "1", 2: "2", unknown: "0", inherit: "0", empty: "0", accessible: "1", yes: "1", true: "1", accessibles: "1", not_accessible: "2", inaccessible: "2", no: "2", false: "2", non_accessible: "2" };
const BIKES = { 0: "0", 1: "1", 2: "2", unknown: "0", allowed: "1", yes: "1", true: "1", not_allowed: "2", no: "2", false: "2", forbidden: "2" };
const WORD = { 0: "set_accessibility.word_0", 1: "set_accessibility.word_1", 2: "set_accessibility.word_2" };
const BIKE_WORD = { 0: "set_accessibility.bike_word_0", 1: "set_accessibility.bike_word_1", 2: "set_accessibility.bike_word_2" };
const enumOf = (v, map) => {
  if (!given(v)) return null;
  const k = String(v).trim().toLowerCase().replace(/[\s-]+/g, "_");
  return map[k] ?? undefined;
};

// "S53-S75", "S53 à S75", "S53..75": a prefix, a number, a separator, (the prefix,) a number.
const RANGE_RE = /^(.*?[^\d\s])?0*(\d+)(?:\s*(?:-|–|\.\.)\s*|\s+(?:à|au|to)\s+)(.*?[^\d\s])?0*(\d+)$/i;
const tripKey = (v) => {
  const m = /^(.*?\D)?0*(\d+)$/.exec(str(v));
  return m ? `${(m[1] || "").toUpperCase()}#${m[2]}` : null;
};

/** Trips named by id or trip_short_name; "S53-S75" is every number of the range that exists. */
const findTrips = (db, model, refs, ambiguities, warnings, lang) => {
  const rows = db.prepare("SELECT trip_id, trip_short_name FROM trips").all();
  const byShort = new Map();
  const byKey = new Map();
  const add = (m, k, id) => {
    if (!k) return;
    if (!m.has(k)) m.set(k, []);
    m.get(k).push(id);
  };
  for (const r of rows) {
    add(byShort, str(r.trip_short_name).toLowerCase(), r.trip_id);
    add(byKey, tripKey(r.trip_short_name), r.trip_id);
    add(byKey, tripKey(r.trip_id), r.trip_id);
  }
  const out = new Set();
  for (const ref of refs) {
    const raw = str(ref);
    if (model.trips.has(raw)) {
      out.add(raw);
      continue;
    }
    const short = byShort.get(raw.toLowerCase());
    if (short) {
      short.forEach((id) => out.add(id));
      continue;
    }
    const m = RANGE_RE.exec(raw);
    if (m && (!m[3] || m[3].toUpperCase() === (m[1] || "").toUpperCase())) {
      const [a, b] = [parseInt(m[2], 10), parseInt(m[4], 10)].sort((x, y) => x - y);
      if (b - a > 2000) {
        ambiguities.push({ param: "trips", code: "trips_invalid", message: tr(lang, "set_accessibility.range_too_wide", { range: raw }) });
        continue;
      }
      let n = 0;
      for (let i = a; i <= b; i++) for (const id of byKey.get(`${(m[1] || "").toUpperCase()}#${i}`) || []) {
        out.add(id);
        n += 1;
      }
      if (!n) ambiguities.push({ param: "trips", code: "trip_unknown", message: tr(lang, "set_accessibility.range_no_trip", { range: raw }) });
      else warnings.push(tr(lang, "set_accessibility.range_found", { range: raw, count: n }));
      continue;
    }
    ambiguities.push({ param: "trips", code: "trip_unknown", message: tr(lang, "set_accessibility.trip_unknown", { ref: raw }) });
  }
  return [...out].sort();
};

const resolveAccess = async (model, p, ctx = {}) => {
  const db = ctx.db;
  const lang = ctx.lang;
  const ambiguities = [];
  const warnings = [];
  const stopRefs = [...listOf(p.stops), ...listOf(p.stop)];
  const routeRefs = [...listOf(p.route), ...listOf(p.routes)];
  const tripRefs = listOf(p.trips);
  const hasStops = stopRefs.length > 0;
  const hasTrips = routeRefs.length > 0 || tripRefs.length > 0;
  const wb = enumOf(p.wheelchair_boarding, WHEELCHAIR);
  const wa = enumOf(p.wheelchair_accessible, WHEELCHAIR);
  const ba = enumOf(p.bikes_allowed, BIKES);
  const opts = ["accessible", "not_accessible", "unknown"];
  if (wb === undefined) ambiguities.push({ param: "wheelchair_boarding", code: "wheelchair_boarding_invalid", message: tr(lang, "set_accessibility.wheelchair_boarding_invalid", { value: String(p.wheelchair_boarding) }), options: opts });
  if (wa === undefined) ambiguities.push({ param: "wheelchair_accessible", code: "wheelchair_accessible_invalid", message: tr(lang, "set_accessibility.wheelchair_accessible_invalid", { value: String(p.wheelchair_accessible) }), options: opts });
  if (ba === undefined) ambiguities.push({ param: "bikes_allowed", code: "bikes_allowed_invalid", message: tr(lang, "set_accessibility.bikes_allowed_invalid", { value: String(p.bikes_allowed) }), options: ["allowed", "not_allowed", "unknown"] });
  if (!hasStops && !hasTrips) ambiguities.push({ param: "stops", code: "target_missing", message: tr(lang, "set_accessibility.target_missing") });
  if (hasStops && wb === null) ambiguities.push({ param: "wheelchair_boarding", code: "wheelchair_boarding_missing", message: tr(lang, "set_accessibility.wheelchair_boarding_missing"), options: opts });
  if (!hasStops && wb != null) ambiguities.push({ param: "stops", code: "stops_missing", message: tr(lang, "set_accessibility.stops_missing") });
  if (hasTrips && wa === null && ba === null) ambiguities.push({ param: "wheelchair_accessible", code: "wheelchair_accessible_missing", message: tr(lang, "set_accessibility.wheelchair_accessible_missing"), options: opts });
  if (!hasTrips && (wa != null || ba != null)) ambiguities.push({ param: "route", code: "route_missing", message: tr(lang, "set_accessibility.route_missing") });

  // Stops: a station stands with its platforms (and their boarding areas).
  let stops = [];
  if (hasStops) {
    const found = findMany(model, stopRefs, { all: flag(p.all) === true, lang }, ambiguities, warnings);
    const kids = childMap(model);
    const out = new Map(found.map((s) => [s.id, s]));
    for (const s of found) {
      if (lt(s) !== "1" && lt(s) !== "0") continue;
      for (const c of kids.get(s.id) || []) {
        if (lt(s) === "1" && lt(c) === "0") {
          out.set(c.id, c);
          for (const b of kids.get(c.id) || []) if (lt(b) === "4") out.set(b.id, b);
        }
        if (lt(s) === "0" && lt(c) === "4") out.set(c.id, c);
      }
    }
    stops = [...out.values()];
    if (!hasTrips) undatable(model, p, "stop_attributes.what_access", ambiguities, warnings, lang);
    else if (given(p.from_date) || SCOPE_KEYS.some((k) => given(p[k]))) warnings.push(tr(lang, "set_accessibility.stops_undated"));
  }

  // Trips.
  let trips = [];
  let scope = null;
  let describe = "";
  const routes = [];
  if (hasTrips) {
    const sc = await S.resolveScope(model, p, ctx);
    ambiguities.push(...sc.ambiguities);
    warnings.push(...sc.warnings);
    scope = sc.value || null;
    for (const ref of routeRefs) {
      const r = R.route(model, ref, { lang });
      if (r.ambiguity) ambiguities.push({ param: "route", ...r.ambiguity });
      else routes.push(r.value);
    }
    let direction = "both";
    if (given(p.direction)) {
      if (routes.length !== 1) ambiguities.push({ param: "direction", code: "direction_invalid", message: tr(lang, "set_accessibility.direction_invalid") });
      else {
        const d = R.direction(model, routes[0].id, p.direction, { lang });
        if (d.ambiguity) ambiguities.push({ param: "direction", ...d.ambiguity });
        else direction = d.value;
      }
    }
    const selectionGiven = SELECTION_PARAMS.map((x) => x.name).filter((k) => given(p[k]));
    if (tripRefs.length && selectionGiven.length) ambiguities.push({ param: "trips", code: "selection_conflict", message: tr(lang, "set_accessibility.selection_conflict", { params: selectionGiven.join(", ") }) });
    if (!ambiguities.length) {
      if (tripRefs.length) {
        const ids = findTrips(db, model, tripRefs, ambiguities, warnings, lang);
        const allowed = new Set(routes.map((r) => r.id));
        const off = ids.filter((id) => allowed.size && !allowed.has(model.trips.get(id).route_id));
        if (off.length) ambiguities.push({ param: "trips", code: "trip_not_on_route", message: tr(lang, "set_accessibility.trip_not_on_route", { count: off.length, trips: off.slice(0, 3).join(", "), lines: routes.map((r) => r.short_name || r.id).join(", ") }) });
        const inScope = new Set(S.tripsInScope(model, {}, scope).map((t) => t.id));
        trips = ids.filter((id) => inScope.has(id) && (!allowed.size || allowed.has(model.trips.get(id).route_id)));
        if (ids.length && !trips.length && !off.length) ambiguities.push({ param: "trips", code: "no_trip_in_scope", message: tr(lang, "set_accessibility.no_trip_in_scope", { scope: S.describeScope(scope, lang) }) });
        else if (ids.length > trips.length && !off.length) warnings.push(tr(lang, "set_accessibility.listed_not_in_scope", { count: ids.length - trips.length, scope: S.describeScope(scope, lang) }));
        describe = tr(lang, "set_accessibility.listed_trips", { count: trips.length });
      } else {
        const parts = [];
        for (const r of routes) {
          const sel = resolveSelection(model, p, { routeId: r.id, direction, scope, lang });
          ambiguities.push(...sel.ambiguities);
          warnings.push(...sel.warnings);
          if (!sel.ambiguities.length && !sel.value.trips.length) ambiguities.push({ param: "route", code: "no_trip", message: tr(lang, "set_accessibility.no_trip", { line: r.short_name || r.id, selection: sel.value.describe, scope: S.describeScope(scope, lang) }) });
          trips.push(...sel.value.trips);
          parts.push(sel.value.describe);
        }
        trips = [...new Set(trips)].sort();
        describe = [...new Set(parts)].join(tr(lang, "common.semicolon"));
      }
    }
  }
  if (ambiguities.length) return { ambiguities, warnings };
  return {
    value: {
      stops: stops.map((s) => s.id).sort(),
      wheelchair_boarding: wb,
      trips,
      wheelchair_accessible: wa,
      bikes_allowed: ba,
      scope,
      describe,
      routes: routes.map((r) => r.short_name || r.id),
    },
    ambiguities: [],
    warnings,
  };
};

// Consequences of the new values, read on the result.
const accessWarnings = (db, model, v, { stopIds, tripIds, lang }) => {
  const warnings = [];
  const stops = new Map(db.prepare("SELECT stop_id, stop_name, location_type, parent_station, wheelchair_boarding FROM stops").all().map((r) => [r.stop_id, r]));
  const val = (id) => str(stops.get(id)?.wheelchair_boarding) || "0";
  if (stopIds.length) {
    const kids = new Map();
    for (const r of stops.values()) {
      if (!given(r.parent_station)) continue;
      if (!kids.has(r.parent_station)) kids.set(r.parent_station, []);
      kids.get(r.parent_station).push(r);
    }
    const stations = new Set();
    for (const id of stopIds) {
      const r = stops.get(id);
      if (str(r.location_type) === "1") stations.add(id);
      else if (given(r.parent_station) && str(stops.get(r.parent_station)?.location_type) === "1") stations.add(r.parent_station);
    }
    for (const sid of [...stations].sort()) {
      const sv = val(sid);
      const children = kids.get(sid) || [];
      const platforms = children.filter((c) => (str(c.location_type) || "0") === "0");
      const odd = platforms.filter((c) => sv !== "0" && val(c.stop_id) !== "0" && val(c.stop_id) !== sv);
      if (odd.length) warnings.push(tr(lang, "set_accessibility.station_platforms_differ", { name: stops.get(sid).stop_name, id: sid, value: tr(lang, WORD[sv]), count: odd.length, platforms: odd.slice(0, 3).map((c) => `${c.stop_id}: ${val(c.stop_id)}`).join(", ") }));
      const entrances = children.filter((c) => str(c.location_type) === "2");
      if (sv === "1" && entrances.length && entrances.every((c) => val(c.stop_id) === "2")) warnings.push(tr(lang, "set_accessibility.station_no_entrance", { name: stops.get(sid).stop_name, id: sid, count: entrances.length }));
    }
    if (v.wheelchair_boarding === "0") {
      const inherit = stopIds.filter((id) => given(stops.get(id).parent_station) && val(stops.get(id).parent_station) !== "0");
      if (inherit.length) warnings.push(tr(lang, "set_accessibility.platforms_inherit", { count: inherit.length }));
    }
    if (v.wheelchair_boarding === "1") {
      const set = new Set(stopIds);
      const changedTrips = new Set(tripIds);
      const unknown = new Set();
      const wa = new Map(db.prepare("SELECT trip_id, wheelchair_accessible FROM trips").all().map((r) => [r.trip_id, str(r.wheelchair_accessible) || "0"]));
      for (const t of model.trips.values()) if (t.stops.some((s) => set.has(s)) && (wa.get(t.id) || "0") === "0" && !changedTrips.has(t.id)) unknown.add(t.id);
      if (unknown.size) warnings.push(tr(lang, "set_accessibility.trips_unknown_vehicle", { count: unknown.size }));
    }
  }
  if (tripIds.length) {
    const ph = chunks(tripIds);
    const rows = ph.flatMap((ids) => db.prepare(`SELECT trip_id, block_id, service_id FROM trips WHERE trip_id IN (${marks(ids)})`).all(ids));
    const blocks = [...new Set(rows.filter((r) => given(r.block_id)).map((r) => `${r.block_id}\u0000${r.service_id}`))];
    let mixed = 0;
    for (const b of blocks) {
      const [block, service] = b.split("\u0000");
      const vals = new Set(db.prepare("SELECT wheelchair_accessible AS w FROM trips WHERE block_id = ? AND service_id = ?").all(block, service).map((r) => str(r.w) || "0").filter((w) => w !== "0"));
      if (vals.size > 1) mixed += 1;
    }
    if (mixed) warnings.push(tr(lang, "set_accessibility.blocks_mixed", { count: mixed }));
    if (v.wheelchair_accessible === "1") {
      const bad = new Set();
      for (const id of tripIds) for (const s of model.trips.get(id)?.stops || []) if (val(s) === "2") bad.add(s);
      if (bad.size) warnings.push(tr(lang, "set_accessibility.accessible_trips_bad_stops", { count: bad.size, stops: [...bad].slice(0, 3).map((id) => stops.get(id)?.stop_name || id).join(", ") }));
    }
  }
  return warnings;
};

const applyAccess = (db, v, { model, lang } = {}) => {
  const parts = [];
  let stopsChanged = 0;
  if (v.wheelchair_boarding != null && v.stops.length) {
    const cur = db.prepare("SELECT wheelchair_boarding FROM stops WHERE stop_id = ?");
    const up = db.prepare("UPDATE stops SET wheelchair_boarding = ? WHERE stop_id = ?");
    for (const id of v.stops) {
      if ((str(cur.get(id)?.wheelchair_boarding) || "0") === v.wheelchair_boarding) continue;
      up.run(v.wheelchair_boarding, id);
      stopsChanged += 1;
    }
    const names = [...new Set(v.stops.map((id) => model.stops.get(id)?.name || id))];
    const already = v.stops.length > stopsChanged ? tr(lang, "set_accessibility.already_so", { count: v.stops.length - stopsChanged }) : "";
    parts.push(`${tr(lang, "set_accessibility.part_stops", { value: tr(lang, WORD[v.wheelchair_boarding]), count: stopsChanged, names: quoteList(names, 3, lang) })}${already}`);
  }
  let tripsChanged = [];
  let split = 0;
  if (v.trips.length && (v.wheelchair_accessible != null || v.bikes_allowed != null)) {
    const cur = new Map();
    for (const ids of chunks(v.trips)) for (const r of db.prepare(`SELECT trip_id, wheelchair_accessible, bikes_allowed FROM trips WHERE trip_id IN (${marks(ids)})`).all(ids)) cur.set(r.trip_id, r);
    const differs = (id) => {
      const r = cur.get(id);
      return (v.wheelchair_accessible != null && (str(r.wheelchair_accessible) || "0") !== v.wheelchair_accessible) || (v.bikes_allowed != null && (str(r.bikes_allowed) || "0") !== v.bikes_allowed);
    };
    const todo = v.trips.filter((id) => cur.has(id) && differs(id));
    const before = db.prepare("SELECT COUNT(*) AS n FROM trips").get().n;
    const scoped = S.isolateScope(db, model, todo, v.scope);
    split = db.prepare("SELECT COUNT(*) AS n FROM trips").get().n - before;
    const sets = [];
    if (v.wheelchair_accessible != null) sets.push(["wheelchair_accessible", v.wheelchair_accessible]);
    if (v.bikes_allowed != null) sets.push(["bikes_allowed", v.bikes_allowed]);
    const up = db.prepare(`UPDATE trips SET ${sets.map(([c]) => `${c} = ?`).join(", ")} WHERE trip_id = ?`);
    for (const id of scoped) up.run(...sets.map(([, x]) => x), id);
    tripsChanged = scoped;
    const what = sets.map(([c, x]) => `${c} → ${tr(lang, c === "bikes_allowed" ? BIKE_WORD[x] : WORD[x])}`).join(", ");
    const when = S.isAll(v.scope) ? "" : `, ${S.describeScope(v.scope, lang)}`;
    const words = { what, count: scoped.length, lines: v.routes.join(", "), selection: `${v.describe}${when}` };
    const already = v.trips.length > todo.length ? tr(lang, "set_accessibility.already_so", { count: v.trips.length - todo.length }) : "";
    parts.push(`${tr(lang, v.routes.length ? "set_accessibility.part_trips_line" : "set_accessibility.part_trips", words)}${already}${split ? tr(lang, "set_accessibility.split_off", { count: split }) : ""}`);
  }
  const warnings = accessWarnings(db, model, v, { stopIds: v.wheelchair_boarding != null ? v.stops : [], tripIds: tripsChanged, lang });
  const noop = stopsChanged === 0 && tripsChanged.length === 0;
  return { summary: tr(lang, noop ? "set_accessibility.summary_noop" : "set_accessibility.summary", { parts: parts.join(tr(lang, "common.semicolon")) }), warnings, noop };
};

// ══ set_stop_attributes ═════════════════════════════════════════════════

const FIELDS = {
  code: "stop_code", stop_code: "stop_code",
  platform_code: "platform_code", platform: "platform_code",
  zone_id: "zone_id", zone: "zone_id",
  desc: "stop_desc", stop_desc: "stop_desc", description: "stop_desc",
  url: "stop_url", stop_url: "stop_url",
  level_id: "level_id", level: "level_id",
  parent_station: "parent_station", parent: "parent_station", station: "parent_station",
  tts_name: "tts_stop_name", tts_stop_name: "tts_stop_name",
  timezone: "stop_timezone", stop_timezone: "stop_timezone",
  access: "stop_access", stop_access: "stop_access",
};
// Fields this operator refuses: [code, the message's code].
const NAME_REFUSED = ["name_refused", "set_stop_attributes.name_refused"];
const POSITION_REFUSED = ["position_refused", "set_stop_attributes.position_refused"];
const REFUSED = {
  name: NAME_REFUSED,
  stop_name: NAME_REFUSED,
  new_name: NAME_REFUSED,
  lat: POSITION_REFUSED,
  lon: POSITION_REFUSED,
  stop_lat: POSITION_REFUSED,
  stop_lon: POSITION_REFUSED,
  position: POSITION_REFUSED,
  coordinates: POSITION_REFUSED,
  wheelchair_boarding: ["field_refused", "set_stop_attributes.accessibility_refused"],
  wheelchair: ["field_refused", "set_stop_attributes.accessibility_refused"],
  location_type: ["field_refused", "set_stop_attributes.location_type_refused"],
  stop_id: ["field_refused", "set_stop_attributes.id_refused"],
  id: ["field_refused", "set_stop_attributes.id_refused"],
};
const CONTROL = new Set(["stop", "stops", "all", "from_date", ...SCOPE_KEYS]);
const FIELD_WORDS = { stop_code: "set_stop_attributes.field_stop_code", platform_code: "set_stop_attributes.field_platform_code", zone_id: "set_stop_attributes.field_zone_id", stop_desc: "set_stop_attributes.field_stop_desc", stop_url: "set_stop_attributes.field_stop_url", level_id: "set_stop_attributes.field_level_id", parent_station: "set_stop_attributes.field_parent_station", tts_stop_name: "set_stop_attributes.field_tts_stop_name", stop_timezone: "set_stop_attributes.field_stop_timezone", stop_access: "set_stop_attributes.field_stop_access" };
// The checked values of generic.js (words or GTFS codes) for the enumerated attributes of a stop.
const { checkValue: checkStopValue } = require("./generic")._internals;

const validTimezone = (tz) => {
  try {
    new Intl.DateTimeFormat("en", { timeZone: tz });
    return /\//.test(tz) || tz === "UTC";
  } catch {
    return false;
  }
};

const resolveAttrs = async (model, p, ctx = {}) => {
  const db = ctx.db;
  const lang = ctx.lang;
  const ambiguities = [];
  const warnings = [];
  const patch = {};
  for (const [k, raw] of Object.entries(p || {})) {
    if (CONTROL.has(k) || META_KEYS.has(k)) continue;
    if (REFUSED[k]) {
      ambiguities.push({ param: k, code: REFUSED[k][0], message: tr(lang, REFUSED[k][1]) });
      continue;
    }
    const col = FIELDS[k];
    if (!col) {
      ambiguities.push({ param: k, code: "field_unknown", message: tr(lang, "set_stop_attributes.field_unknown", { field: k }), options: ["code", "platform_code", "zone_id", "desc", "url", "level_id", "parent_station", "tts_name", "timezone", "access"] });
      continue;
    }
    if (Object.prototype.hasOwnProperty.call(patch, col)) {
      ambiguities.push({ param: k, code: "field_repeated", message: tr(lang, "set_stop_attributes.field_repeated", { field: tr(lang, FIELD_WORDS[col]) }) });
      continue;
    }
    patch[col] = raw === null || str(raw) === "" ? null : str(raw).replace(/\s+/g, " ");
  }
  if (!Object.keys(patch).length && !ambiguities.length) ambiguities.push({ param: "code", code: "fields_missing", message: tr(lang, "set_stop_attributes.fields_missing") });
  const refs = [...listOf(p.stops), ...listOf(p.stop)];
  const all = flag(p.all) === true;
  let stops = [];
  if (!refs.length) ambiguities.push({ param: "stop", code: "stop_missing", message: tr(lang, "resolve.stop_missing") });
  else stops = findMany(model, refs, { all, param: refs.length === listOf(p.stop).length ? "stop" : "stops", lang }, ambiguities, warnings);
  undatable(model, p, "stop_attributes.what_attrs", ambiguities, warnings, lang);

  // Values.
  if (patch.stop_url != null && !/^https?:\/\/[^\s/$.?#].[^\s]*$/i.test(patch.stop_url)) ambiguities.push({ param: "url", code: "url_invalid", message: tr(lang, "set_stop_attributes.url_invalid", { value: patch.stop_url }) });
  if (patch.stop_timezone != null && !validTimezone(patch.stop_timezone)) ambiguities.push({ param: "timezone", code: "timezone_invalid", message: tr(lang, "set_stop_attributes.timezone_invalid", { value: patch.stop_timezone }) });
  if (patch.stop_access != null) {
    const v = checkStopValue("stops", "stop_access", patch.stop_access, lang);
    if (v.error) ambiguities.push({ param: "access", code: "value_invalid", message: tr(lang, "generic.value_invalid", { table: "stops", column: "stop_access", value: JSON.stringify(patch.stop_access), error: v.error }) });
    else patch.stop_access = v.value;
  }
  if (patch.level_id != null) {
    const levels = tableExists(db, "levels") ? db.prepare("SELECT level_id, level_name FROM levels ORDER BY level_index, level_id").all() : [];
    const byName = levels.filter((l) => nameKey(l.level_name) === nameKey(patch.level_id));
    const hit = levels.find((l) => l.level_id === patch.level_id) || (byName.length === 1 ? byName[0] : null);
    if (hit) patch.level_id = hit.level_id;
    else ambiguities.push({ param: "level_id", code: "level_unknown", message: tr(lang, "set_stop_attributes.level_unknown", { level: patch.level_id }), options: levels.map((l) => l.level_id) });
  }
  let parent = null;
  if (patch.parent_station != null) {
    const f = findStops(model, patch.parent_station, { lang });
    const cands = f.stops ? f.stops.filter((s) => ["0", "1"].includes(lt(s))) : [];
    const stations = cands.filter((s) => lt(s) === "1");
    if (f.ambiguity) ambiguities.push({ param: "parent_station", ...f.ambiguity, code: f.ambiguity.code === "stop_unknown" ? "parent_station_unknown" : f.ambiguity.code });
    else if (stations.length === 1 || cands.length === 1) parent = stations[0] || cands[0];
    else ambiguities.push({ param: "parent_station", code: "parent_station_ambiguous", message: tr(lang, "set_stop_attributes.parent_station_ambiguous", { ref: patch.parent_station }), options: cands.map((s) => `${s.name} (${s.id}, ${kindWord(s, lang)})`) });
    if (parent) patch.parent_station = parent.id;
  }
  const parentOk = !Object.prototype.hasOwnProperty.call(patch, "parent_station") || patch.parent_station === null || parent;

  // Per stop: references and types.
  if (stops.length > 1 && !all && ["stop_code", "platform_code"].some((c) => patch[c] != null)) {
    const col = ["stop_code", "platform_code"].find((c) => patch[c] != null);
    ambiguities.push({ param: "stop", code: "code_for_many", message: tr(lang, "set_stop_attributes.code_for_many", { refs: refs.join(", "), count: stops.length, field: tr(lang, FIELD_WORDS[col]) }), options: stops.map((s) => `${s.name} (${s.id}, ${kindWord(s, lang)})`) });
  }
  const rows = new Map(stops.map((s) => [s.id, db.prepare("SELECT * FROM stops WHERE stop_id = ?").get(s.id)]));
  if (Object.prototype.hasOwnProperty.call(patch, "parent_station") && parentOk) {
    for (const s of stops) {
      const t = lt(s);
      const it = { name: s.name, id: s.id };
      if (parent && parent.id === s.id) ambiguities.push({ param: "parent_station", code: "parent_station_invalid", message: tr(lang, "set_stop_attributes.own_parent", it) });
      else if (parent && t === "1") ambiguities.push({ param: "parent_station", code: "parent_station_invalid", message: tr(lang, "set_stop_attributes.station_parent", it) });
      else if (parent && t === "4" && lt(parent) !== "0") ambiguities.push({ param: "parent_station", code: "parent_station_invalid", message: tr(lang, "set_stop_attributes.boarding_area_parent", { ...it, kind: kindWord(parent, lang), parent: parent.id }) });
      else if (parent && t !== "4" && lt(parent) !== "1") ambiguities.push({ param: "parent_station", code: "parent_station_invalid", message: tr(lang, "set_stop_attributes.not_a_station", { name: parent.name, id: parent.id, kind: kindWord(parent, lang) }) });
      else if (!parent && ["2", "3", "4"].includes(t)) ambiguities.push({ param: "parent_station", code: "parent_station_required", message: tr(lang, "set_stop_attributes.parent_required", { ...it, a_kind: tr(lang, A_KIND[kindOf(s)]) }) });
    }
  }
  // stop_access is for a stop or platform of a station only (location_type 0 with a parent_station): set elsewhere, the
  // canonical validator refuses it (stop_access_specified_for_stop_with_no_parent_station), so the person is asked.
  if (patch.stop_access != null && !ambiguities.some((x) => x.param === "access")) {
    for (const s of stops) {
      const parentAfter = Object.prototype.hasOwnProperty.call(patch, "parent_station") ? patch.parent_station : rows.get(s.id)?.parent_station;
      if (lt(s) !== "0" || !str(parentAfter)) ambiguities.push({ param: "access", code: "access_needs_station", message: tr(lang, "set_stop_attributes.access_needs_station", { name: s.name, id: s.id }) });
    }
  }
  if (ambiguities.length) return { ambiguities, warnings };

  // Consequences.
  const changes = [];
  for (const s of stops) {
    const r = rows.get(s.id);
    const diff = Object.entries(patch).filter(([c, val]) => str(r[c]) !== str(val));
    if (diff.length) changes.push({ id: s.id, name: s.name, set: Object.fromEntries(diff), old: Object.fromEntries(diff.map(([c]) => [c, r[c] ?? null])) });
  }
  if (patch.stop_code != null) {
    const dup = db.prepare("SELECT stop_id FROM stops WHERE stop_code = ?").all(patch.stop_code).map((r) => r.stop_id).filter((id) => !rows.has(id));
    if (dup.length) warnings.push(tr(lang, "set_stop_attributes.code_taken", { code: patch.stop_code, stops: dup.slice(0, 3).join(", ") }));
  }
  if (patch.platform_code != null) {
    const stations = stops.filter((s) => lt(s) === "1");
    if (stations.length) warnings.push(tr(lang, "set_stop_attributes.platform_code_on_station", { stops: stations.map((s) => s.id).join(", ") }));
  }
  if (Object.prototype.hasOwnProperty.call(patch, "zone_id") && tableExists(db, "fare_rules")) {
    const zones = new Set(db.prepare("SELECT origin_id AS z FROM fare_rules UNION SELECT destination_id FROM fare_rules UNION SELECT contains_id FROM fare_rules").all().map((r) => r.z).filter(given));
    if (zones.size && patch.zone_id != null && !zones.has(patch.zone_id)) warnings.push(tr(lang, "set_stop_attributes.zone_without_rule", { zone: patch.zone_id, count: stops.length }));
    const oldZones = [...new Set(changes.map((c) => c.old.zone_id).filter((z) => given(z) && zones.has(z)))];
    for (const z of oldZones) {
      const left = db.prepare(`SELECT COUNT(*) AS n FROM stops WHERE zone_id = ? AND stop_id NOT IN (${marks(stops)})`).get(z, ...stops.map((s) => s.id)).n;
      if (!left) warnings.push(tr(lang, "set_stop_attributes.zone_emptied", { zone: String(z) }));
    }
  }
  if (parent) {
    const far = stops.filter((s) => (dist(s, parent) ?? 0) > FAR_PARENT_M);
    if (far.length) warnings.push(tr(lang, "set_stop_attributes.parent_far", { stops: far.map((s) => s.id).join(", "), count: far.length, distance: metres(dist(far[0], parent), lang), station: parent.name }));
    if (tableExists(db, "pathways")) {
      const moved = changes.filter((c) => c.set.parent_station !== undefined && given(c.old.parent_station)).map((c) => c.id);
      if (moved.length) {
        const n = db.prepare(`SELECT COUNT(*) AS n FROM pathways WHERE from_stop_id IN (${marks(moved)}) OR to_stop_id IN (${marks(moved)})`).get([...moved, ...moved]).n;
        if (n) warnings.push(tr(lang, "set_stop_attributes.pathways_two_stations", { count: n, stops: moved.length }));
      }
    }
    for (const c of changes.filter((x) => given(x.old.parent_station) && x.set.parent_station !== undefined)) {
      const left = db.prepare("SELECT COUNT(*) AS n FROM stops WHERE parent_station = ? AND stop_id != ? AND COALESCE(location_type, '0') IN ('0', '')").get(c.old.parent_station, c.id).n;
      if (!left) warnings.push(tr(lang, "set_stop_attributes.station_no_platform", { station: String(c.old.parent_station) }));
    }
  }
  if (patch.stop_timezone != null) {
    const under = stops.filter((s) => s.parent || parent);
    if (under.length) warnings.push(tr(lang, "set_stop_attributes.timezone_ignored", { stops: under.map((s) => s.id).slice(0, 3).join(", "), count: under.length }));
  }
  if (patch.stop_desc != null && stops.some((s) => nameKey(s.name) === nameKey(patch.stop_desc))) warnings.push(tr(lang, "set_stop_attributes.desc_repeats_name"));
  return { value: { changes, count: stops.length }, ambiguities: [], warnings };
};

const applyAttrs = (db, v, { lang } = {}) => {
  const parts = [];
  const none = tr(lang, "set_stop_attributes.none");
  for (const c of v.changes) {
    const cols = Object.keys(c.set);
    db.prepare(`UPDATE stops SET ${cols.map((k) => `${k} = ?`).join(", ")} WHERE stop_id = ?`).run(...cols.map((k) => c.set[k]), c.id);
    parts.push(tr(lang, "set_stop_attributes.change", { name: c.name, id: c.id, changes: cols.map((k) => `${tr(lang, FIELD_WORDS[k])} ${c.old[k] ?? none} → ${c.set[k] ?? none}`).join(", ") }));
  }
  if (!parts.length) return { summary: tr(lang, "set_stop_attributes.noop", { count: v.count }), noop: true };
  const shown = parts.slice(0, 4).join(tr(lang, "common.semicolon"));
  return { summary: parts.length > 4 ? tr(lang, "set_stop_attributes.summary_more", { count: parts.length, changes: shown, more: parts.length - 4 }) : tr(lang, "set_stop_attributes.summary", { count: parts.length, changes: shown }) };
};

// ══ merge_stops ═════════════════════════════════════════════════════════

const smartEdit = () => require("../../edit/smartEditService");

const resolveMerge = async (model, p, ctx = {}) => {
  const db = ctx.db;
  const lang = ctx.lang;
  const ambiguities = [];
  const warnings = [];
  const refs = listOf(p.stops);
  if (!refs.length) ambiguities.push({ param: "stops", code: "stops_missing", message: tr(lang, "merge_stops.stops_missing") });
  const found = findMany(model, refs, { all: true, lang }, ambiguities, warnings);
  let keep = null;
  if (given(p.keep)) {
    const k = findStops(model, p.keep, { lang });
    if (k.ambiguity) ambiguities.push({ param: "keep", ...k.ambiguity, code: k.ambiguity.code === "stop_unknown" ? "keep_unknown" : k.ambiguity.code });
    else {
      const listed = k.stops.filter((s) => found.some((x) => x.id === s.id));
      const pick = listed.length === 1 ? listed[0] : k.stops.length === 1 ? k.stops[0] : null;
      if (!pick) ambiguities.push({ param: "keep", code: "keep_ambiguous", message: tr(lang, "merge_stops.keep_ambiguous", { ref: String(p.keep), count: k.stops.length }), options: k.stops.map((s) => `${s.name} (${s.id})`) });
      else keep = pick;
    }
  }
  const maxM = given(p.max_distance_m) ? R.positive(p.max_distance_m, "max_distance_m", { max: 5000, lang }) : { value: MERGE_DEFAULT_M };
  if (maxM.ambiguity) ambiguities.push({ param: "max_distance_m", ...maxM.ambiguity });
  const confirmFar = flag(p.confirm_far);
  if (confirmFar === undefined) ambiguities.push({ param: "confirm_far", code: "confirm_far_invalid", message: tr(lang, "common.flag_invalid", { name: "confirm_far" }), options: ["true", "false"] });
  undatable(model, p, "stop_attributes.what_merge", ambiguities, warnings, lang);
  if (ambiguities.length) return { ambiguities, warnings };

  const set = new Map(found.map((s) => [s.id, s]));
  if (keep) set.set(keep.id, keep);
  const members = [...set.values()];
  if (members.length < 2) return { ambiguities: [{ param: "stops", code: "stops_too_few", message: members.length === 1 ? tr(lang, "merge_stops.single", { refs: refs.join(", "), id: members[0].id }) : tr(lang, "merge_stops.none", { refs: refs.join(", ") }) }], warnings };
  const types = [...new Set(members.map(lt))];
  if (types.length > 1) return { ambiguities: [{ param: "stops", code: "merge_location_types", message: tr(lang, "merge_stops.location_types", { kinds: members.map((s) => tr(lang, "stop_attributes.id_kind", { id: s.id, kind: kindWord(s, lang) })).join(", ") }), options: members.map((s) => `${s.name} (${s.id}, ${kindWord(s, lang)})`) }], warnings };

  // The survivor: the one said, else the most served.
  const counts = new Map(members.map((s) => [s.id, 0]));
  for (const r of db.prepare(`SELECT stop_id, COUNT(*) AS n FROM stop_times WHERE stop_id IN (${marks(members)}) GROUP BY stop_id`).all(members.map((s) => s.id))) counts.set(r.stop_id, r.n);
  if (!keep) {
    const top = Math.max(...counts.values());
    const best = members.filter((s) => counts.get(s.id) === top);
    if (best.length > 1) return { ambiguities: [{ param: "keep", code: "keep_ambiguous", message: tr(lang, "merge_stops.equally_served", { stops: best.map((s) => `${s.name} (${s.id})`).join(tr(lang, "common.and_sep")), count: top }), options: best.map((s) => s.id) }], warnings };
    keep = best[0];
  }
  const dups = members.filter((s) => s.id !== keep.id);
  const far = dups.map((s) => ({ s, d: dist(s, keep) })).filter((x) => x.d != null && x.d > maxM.value);
  if (far.length && confirmFar !== true) return { ambiguities: [{ param: "confirm_far", code: "merge_far", message: tr(lang, "merge_stops.far", { items: far.map((x) => tr(lang, "merge_stops.far_item", { name: x.s.name, id: x.s.id, distance: metres(x.d, lang) })).join(", "), keep: keep.name, id: keep.id, max: Math.round(maxM.value) }), options: ["true", "false"] }], warnings };
  const plan = smartEdit().planStopMerge(db, { survivor_id: keep.id, duplicate_ids: dups.map((s) => s.id) });
  if (!plan.ok) return { ambiguities: [{ param: "stops", code: "merge_invalid", message: plan.error }], warnings };

  // What riders or fares may notice.
  const rows = new Map(members.map((s) => [s.id, db.prepare("SELECT * FROM stops WHERE stop_id = ?").get(s.id)]));
  const k = rows.get(keep.id);
  const differ = (col) => [...new Set(dups.map((s) => str(rows.get(s.id)[col])).filter((x) => x !== "" && x !== str(k[col])))];
  const names = differ("stop_name");
  if (names.length) warnings.push(tr(lang, "merge_stops.names_differ", { name: k.stop_name, names: quoteList(names, 3, lang) }));
  const zones = differ("zone_id");
  if (zones.length && given(k.zone_id)) warnings.push(tr(lang, "merge_stops.zones_differ", { zone: String(k.zone_id), zones: zones.join(", ") }));
  const codes = differ("stop_code");
  if (codes.length && given(k.stop_code)) warnings.push(tr(lang, "merge_stops.codes_differ", { code: String(k.stop_code), count: codes.length, codes: codes.join(", ") }));
  const access = differ("wheelchair_boarding").filter((x) => x !== "0");
  if (access.length && given(k.wheelchair_boarding)) warnings.push(tr(lang, "merge_stops.access_differ", { values: access.join(", "), value: String(k.wheelchair_boarding) }));
  if (far.length) warnings.push(tr(lang, "merge_stops.far_confirmed", { distance: metres(Math.max(...far.map((x) => x.d)), lang), name: keep.name }));
  return {
    value: { survivor: keep.id, survivorName: keep.name, dups: dups.map((s) => s.id), dupNames: dups.map((s) => s.name), counts: Object.fromEntries(counts) },
    ambiguities: [],
    warnings,
  };
};

// translations.txt keyed to a duplicate: repointed, unless the survivor has one already or the name differs.
const mergeTranslations = (db, survivor, dups) => {
  if (!tableExists(db, "translations")) return { moved: 0, dropped: 0 };
  const sv = db.prepare("SELECT stop_name FROM stops WHERE stop_id = ?").get(survivor);
  const has = new Set(db.prepare("SELECT field_name, language FROM translations WHERE table_name = 'stops' AND record_id = ?").all(survivor).map((r) => `${r.field_name}|${r.language}`));
  let moved = 0;
  let dropped = 0;
  for (const d of dups) {
    const name = db.prepare("SELECT stop_name FROM stops WHERE stop_id = ?").get(d)?.stop_name;
    for (const r of db.prepare("SELECT * FROM translations WHERE table_name = 'stops' AND record_id = ? ORDER BY id").all(d)) {
      const key = `${r.field_name}|${r.language}`;
      if (has.has(key) || (r.field_name === "stop_name" && nameKey(name) !== nameKey(sv?.stop_name))) {
        db.prepare("DELETE FROM translations WHERE id = ?").run(r.id);
        dropped += 1;
      } else {
        db.prepare("UPDATE translations SET record_id = ? WHERE id = ?").run(survivor, r.id);
        has.add(key);
        moved += 1;
      }
    }
  }
  return { moved, dropped };
};

const applyMerge = (db, v, { lang } = {}) => {
  const warnings = [];
  const plan = smartEdit().planStopMerge(db, { survivor_id: v.survivor, duplicate_ids: v.dups });
  if (!plan.ok) throw new Error(plan.error);
  const merged = new Set([v.survivor, ...v.dups]);
  // Links between two of the merged stops describe a walk that no longer exists.
  let links = 0;
  const inner = (a, b) => merged.has(a) && merged.has(b) && a !== b;
  for (const t of ["transfers", "pathways"]) {
    if (!tableExists(db, t)) continue;
    for (const r of db.prepare(`SELECT rowid AS _rid, from_stop_id, to_stop_id FROM ${t} WHERE from_stop_id IN (${marks([...merged])}) AND to_stop_id IN (${marks([...merged])})`).all([...merged, ...merged])) {
      if (!inner(r.from_stop_id, r.to_stop_id)) continue;
      db.prepare(`DELETE FROM ${t} WHERE rowid = ?`).run(r._rid);
      links += 1;
    }
  }
  const byTable = {};
  for (const r of plan.refs) {
    if ((r.table === "transfers" || r.table === "pathways") && inner(r.row.from_stop_id, r.row.to_stop_id)) continue;
    if (r.action === "delete") db.prepare(`DELETE FROM ${r.table} WHERE rowid = ?`).run(r.rowid);
    else db.prepare(`UPDATE ${r.table} SET ${r.col} = ? WHERE rowid = ?`).run(v.survivor, r.rowid);
    byTable[r.table] = (byTable[r.table] || 0) + 1;
  }
  const sets = [];
  const vals = [];
  if (plan.survivor_parent !== undefined) {
    sets.push("parent_station = ?");
    vals.push(plan.survivor_parent);
  }
  for (const [f, val] of Object.entries(plan.filled)) {
    sets.push(`${f} = ?`);
    vals.push(val);
  }
  if (sets.length) db.prepare(`UPDATE stops SET ${sets.join(", ")} WHERE stop_id = ?`).run(...vals, v.survivor);
  // Transfers made identical by the repointing.
  let twins = 0;
  if (tableExists(db, "transfers")) {
    const cols = columnsOf(db, "transfers").filter((c) => c !== "id");
    const seen = new Set();
    for (const r of db.prepare(`SELECT rowid AS _rid, * FROM transfers WHERE from_stop_id = ? OR to_stop_id = ? ORDER BY rowid`).all(v.survivor, v.survivor)) {
      const key = JSON.stringify(cols.map((c) => r[c] ?? null));
      if (seen.has(key)) {
        db.prepare("DELETE FROM transfers WHERE rowid = ?").run(r._rid);
        twins += 1;
      } else seen.add(key);
    }
  }
  const trMoves = mergeTranslations(db, v.survivor, v.dups);
  db.prepare(`DELETE FROM stops WHERE stop_id IN (${marks(v.dups)})`).run(v.dups);

  // Trips now calling at the survivor twice.
  const twice = db.prepare(`SELECT COUNT(DISTINCT trip_id) AS n FROM (SELECT trip_id, stop_id, LAG(stop_id) OVER (PARTITION BY trip_id ORDER BY stop_sequence) AS prev FROM stop_times WHERE trip_id IN (SELECT trip_id FROM stop_times WHERE stop_id = ?)) WHERE stop_id = ? AND prev = ?`).get(v.survivor, v.survivor, v.survivor).n;
  if (twice) warnings.push(tr(lang, "merge_stops.twice", { count: twice, name: v.survivorName }));
  const loops = plan.trips_with_both - twice;
  if (loops > 0) warnings.push(tr(lang, "merge_stops.loops", { count: loops, name: v.survivorName }));
  if (links) warnings.push(tr(lang, "merge_stops.links_removed", { count: links }));
  if (twins) warnings.push(tr(lang, "merge_stops.twins_removed", { count: twins }));
  if (trMoves.dropped) warnings.push(tr(lang, "merge_stops.translations_dropped", { count: trMoves.dropped }));
  if (Object.keys(plan.filled).length) warnings.push(tr(lang, "merge_stops.fields_filled", { fields: Object.keys(plan.filled).join(", ") }));
  // Duplicates under another station: that station may be left without platform.
  const svParent = db.prepare("SELECT parent_station FROM stops WHERE stop_id = ?").get(v.survivor)?.parent_station || null;
  for (const pid of [...new Set(plan.dupRows.map((d) => d.parent_station).filter((x) => given(x) && x !== svParent))].sort()) {
    const left = db.prepare("SELECT COUNT(*) AS n FROM stops WHERE parent_station = ? AND COALESCE(location_type, '0') IN ('0', '')").get(pid).n;
    const paths = plan.refs.filter((r) => r.table === "pathways" && !inner(r.row.from_stop_id, r.row.to_stop_id) && plan.dupRows.some((d) => d.parent_station === pid && d.stop_id === r.old)).length;
    if (!left) warnings.push(tr(lang, "merge_stops.station_no_platform", { station: String(pid) }));
    if (paths) warnings.push(tr(lang, "merge_stops.pathways_moved", { count: paths, station: String(pid), name: v.survivorName, id: v.survivor }));
  }
  const refs = Object.entries(byTable).map(([t, n]) => `${t}: ${n}`).join(", ");
  const words = { count: v.dups.length, stops: v.dups.map((id, i) => `${v.dupNames[i]} ${id}`).join(", "), name: v.survivorName, id: v.survivor, refs, moved: trMoves.moved ? tr(lang, "merge_stops.translations_moved", { count: trMoves.moved }) : "" };
  return {
    summary: tr(lang, refs ? "merge_stops.summary" : "merge_stops.summary_no_ref", words),
    warnings,
  };
};

// ══ catalogue ═══════════════════════════════════════════════════════════

const FROM_DATE = { name: "from_date", type: "date", required: false, description: "Effective date. GTFS cannot date a stop's record: inside the feed's validity the change shows from its first day (warning)." };

module.exports = [
  {
    type: "rename_stop",
    title: "Rename a stop",
    category: "stops",
    tables: ["stops", "trips", "stop_times", "routes", "translations"],
    description: "Rename a stop — every stop of one place carrying the name (both sides, a station and its platforms) — with the headsigns equal to the old name on the trips serving it, and its translations. Line names and longer headsigns are reported, rewritten on request.",
    params: [
      { name: "stop", type: "stop", required: true, description: "The stop: an id (that stop) or its current name (every stop of that place carrying it)." },
      { name: "name", type: "string", required: true, description: "The new name." },
      { name: "platforms", type: "boolean", required: false, description: "Station's children: default, those carrying the old name follow; true: its platforms all take the new name; false: the station only." },
      { name: "cascade", type: "boolean", required: false, description: "Headsigns equal to the old name (trips serving the stop) take the new one (default true)." },
      { name: "rename_in_headsigns", type: "boolean", required: false, description: "Also rewrite the old name inside longer headsigns (\"Gendarmerie via Centre\"). Default false (reported)." },
      { name: "rename_in_routes", type: "boolean", required: false, description: "Also rewrite it inside the long names of the lines serving the stop. Default false (reported)." },
      { name: "translations", type: "object", required: false, description: "The new name's translations { fr: \"…\" } (null drops a language), or \"drop\" / \"keep\" for the old ones. Asked when the old name has real translations." },
      { name: "all", type: "boolean", required: false, description: "A name carried at several places: rename every one." },
      FROM_DATE,
    ],
    example: { stop: "Gendarmerie", name: "Acacias" },
    resolve: resolveRename,
    apply: applyRename,
  },
  {
    type: "set_accessibility",
    title: "Set stop or vehicle accessibility",
    category: "stops",
    tables: ["stops", "trips", "stop_times", "frequencies", "calendar", "calendar_dates", "transfers"],
    description: "Set wheelchair_boarding on stops (a station's platforms included) and/or wheelchair_accessible (and bikes_allowed) on the trips of a line or listed trips, on the scope's dates only (trips running on other dates are split).",
    params: [
      { name: "stops", type: "stops", required: false, description: "Stops (ids or names; a station includes its platforms)." },
      { name: "wheelchair_boarding", type: "enum", enum: ["0", "1", "2", "unknown", "accessible", "not_accessible"], required: false, description: "The stops' accessibility: 1 accessible, 2 not accessible, 0 unknown (on a platform: as its station)." },
      { name: "route", type: "route", required: false, description: "The line whose trips change (or a list)." },
      { name: "direction", type: "direction", required: false, description: "0, 1 or both (default)." },
      { name: "trips", type: "list", required: false, description: "Trips by trip_id or trip_short_name; \"S53-S75\" is a range." },
      { name: "wheelchair_accessible", type: "enum", enum: ["0", "1", "2", "unknown", "accessible", "not_accessible"], required: false, description: "The vehicles: 1 accessible, 2 not accessible (e.g. coaches), 0 unknown." },
      { name: "bikes_allowed", type: "enum", enum: ["0", "1", "2", "unknown", "allowed", "not_allowed"], required: false, description: "Bikes on board: 1 allowed, 2 not allowed, 0 unknown." },
      { name: "days", type: "days", required: false, description: "Only the trips of these days (default: all)." },
      ...S.SCOPE_PARAMS,
      ...SELECTION_PARAMS,
      { name: "all", type: "boolean", required: false, description: "A stop name carried at several places: every one." },
    ],
    example: { stops: ["Gare", "Mairie", "Hôpital"], wheelchair_boarding: "accessible" },
    resolve: resolveAccess,
    apply: applyAccess,
  },
  {
    type: "set_stop_attributes",
    title: "Change a stop's code, zone, platform, level or station",
    category: "stops",
    tables: ["stops"],
    description: "Set a stop's code, platform_code, zone_id, desc, url, level_id, parent_station, tts_name, timezone or access from the street (null clears), references checked. Names, positions and accessibility have their own operations.",
    params: [
      { name: "stop", type: "stop", required: false, description: "The stop (id or name); or give stops (one of the two: requires_one_of)." },
      { name: "stops", type: "stops", required: false, description: "Several stops getting the same values (one of stop and stops: requires_one_of)." },
      { name: "code", type: "string", required: false, description: "stop_code (the number riders see)." },
      { name: "platform_code", type: "string", required: false, description: "Platform identifier (\"A\", \"3\")." },
      { name: "zone_id", type: "string", required: false, description: "Fare zone." },
      { name: "desc", type: "string", required: false, description: "stop_desc (where the stop is, not its name)." },
      { name: "url", type: "string", required: false, description: "stop_url (http/https)." },
      { name: "level_id", type: "string", required: false, description: "A level of levels.txt." },
      { name: "parent_station", type: "stop", required: false, description: "The station (id or name) — a platform for a boarding area." },
      { name: "tts_name", type: "string", required: false, description: "tts_stop_name: how the name is read aloud." },
      { name: "timezone", type: "string", required: false, description: "stop_timezone (IANA, e.g. Europe/Paris)." },
      { name: "access", type: "enum", enum: ["0", "1", "no", "yes"], required: false, description: "stop_access: whether riders reach the stop or platform directly from the street — 1 yes, 0 no (through the station)." },
      { name: "all", type: "boolean", required: false, description: "Confirm the same code for several stops, or a name carried at several places." },
      FROM_DATE,
    ],
    requires_one_of: [["stop", "stops"]],
    example: { stop: "Grand Central", zone_id: "Z2" },
    resolve: resolveAttrs,
    apply: applyAttrs,
  },
  {
    type: "merge_stops",
    title: "Merge duplicate stops",
    category: "stops",
    tables: ["stops", "stop_times", "transfers", "pathways", "stop_areas", "location_group_stops", "fare_leg_join_rules", "translations"],
    description: "Fold duplicate stops into one: every reference (stop_times, children, transfers, pathways, areas, translations) repointed, then the duplicates deleted. Survivor: keep, else the most served; farther than 150 m must be confirmed.",
    params: [
      { name: "stops", type: "stops", required: true, description: "The duplicates (ids or names, at least two stops; a name means every stop carrying it)." },
      { name: "keep", type: "stop", required: false, description: "The survivor (default: the one most served by stop_times)." },
      { name: "max_distance_m", type: "number", required: false, description: "Farthest duplicate merged without confirmation (default 150 m)." },
      { name: "confirm_far", type: "boolean", required: false, description: "Merge although farther than max_distance_m." },
      FROM_DATE,
    ],
    example: { stops: ["Jackson Heights / Sunnyside 1"], keep: "B1_0_X2_1" },
    resolve: resolveMerge,
    apply: applyMerge,
  },
];
