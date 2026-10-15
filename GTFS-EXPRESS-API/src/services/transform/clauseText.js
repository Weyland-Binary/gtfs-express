/**
 * clauseText — a clause of the brief as one line in the user's language,
 * the line a card shows when the model (or a client) sent the clause
 * without its own `text`:
 *
 *   clauseText(clause, lang = "en") → "Ligne K : de Rue Hélène Boucher à Bois
 *     Joly en 38 min (± 2 min), chaque course, tous les jours"
 *
 * Every kind of conformanceService.KINDS is rendered, through the locales'
 * `clause.*` templates (i18n.tr; English is the reference) and a scope
 * built from the clause's own words: its day (or the kind's default day
 * when no date or period decides), its period and school zone, its dates.
 * The machine strings of a verdict (`expected`, `measured`) stay English:
 * this is the clause as the user reads it, not what was measured. It lives
 * with the engine's locales (transform/) so their checks see every code.
 */

"use strict";

const { tr } = require("./i18n");
const { parseDate, canonical } = require("./calendars");

const str = (v) => (typeof v === "string" ? v.trim() : v == null ? "" : String(v).trim());
const given = (v) => v != null && v !== "" && !(Array.isArray(v) && !v.length);
// Which call of a recurring stop name the clause means (occurrence: first | last | a rank), said after the stop.
const occurrenceText = (lang, p) => {
  const o = p?.occurrence;
  if (o === "first") return tr(lang, "clause.occurrence_first");
  if (o === "last") return tr(lang, "clause.occurrence_last");
  const n = Number(o);
  return Number.isInteger(n) && n >= 1 ? tr(lang, "clause.occurrence_rank", { n }) : "";
};
const listOf = (v) => (Array.isArray(v) ? v : given(v) ? [v] : []).map((x) => str(x && typeof x === "object" ? x.name : x)).filter(Boolean);

const DAY_KEYS = ["mon", "tue", "wed", "thu", "fri", "sat", "sun"];
const DAY_CODES = { mon: "common.day_mon", tue: "common.day_tue", wed: "common.day_wed", thu: "common.day_thu", fri: "common.day_fri", sat: "common.day_sat", sun: "common.day_sun" };
const MONTH_CODES = ["clause.month_1", "clause.month_2", "clause.month_3", "clause.month_4", "clause.month_5", "clause.month_6", "clause.month_7", "clause.month_8", "clause.month_9", "clause.month_10", "clause.month_11", "clause.month_12"];
// The day a kind is measured on when the clause names none (conformanceService's defaults).
const DEFAULT_DAY = { headway_max: "weekday", span: "weekday", trips_count: "weekday", departure_at: "weekday", od_max_time: "weekday", running_time: "daily", stop_pattern: "daily", transfer_max_wait: "weekday", pickup_dropoff: "daily" };
// The words a brief uses for a call's pickup or drop-off type (pickup_dropoff), and the word of each code.
const ACCESS_WORDS = { regular: "0", normal: "0", none: "1", no: "1", on_demand: "2", phone: "2", booking: "2", reservation: "2", tad: "2", driver: "3", coordinate: "3" };
const ACCESS_WORD_CODES = { 0: "clause.access_word_0", 1: "clause.access_word_1", 2: "clause.access_word_2", 3: "clause.access_word_3" };

/** A list as the language writes it: "A, B and C" ("A, B et C"); `last`: the code of the last separator. */
const joined = (lang, items, last = "common.and_sep") => (items.length <= 1 ? items.join("") : `${items.slice(0, -1).join(", ")}${tr(lang, last)}${items[items.length - 1]}`);

/** A date as the language writes it in a sentence: "2 November 2026", « 2 novembre 2026 », « 1er août 2026 ». */
const dateText = (lang, v) => {
  const y = parseDate(v);
  if (!y) return str(v);
  const params = { day: String(+y.slice(6, 8)), month: tr(lang, MONTH_CODES[+y.slice(4, 6) - 1]), year: y.slice(0, 4) };
  return +y.slice(6, 8) === 1 ? tr(lang, "clause.date_first", params) : tr(lang, "clause.date", params);
};

/** A clock time as the language writes it: "7:40", « 7h40 »; the text itself when it is not a time. */
const timeText = (lang, v) => {
  const m = /^(\d{1,2})(?:[h:](\d{2})?)?(?::\d{2})?$/i.exec(str(v).replace(/\s+/g, ""));
  if (!m) return str(v);
  return tr(lang, "clause.time", { h: String(+m[1]), mm: m[2] || "00" });
};
const timesText = (lang, v) => joined(lang, listOf(v).flatMap((x) => x.split(/\s*[,;]\s*|\s+(?:et|and)\s+|\s+/i)).filter(Boolean).map((x) => timeText(lang, x)));

/** The day words of a clause as a phrase: "Monday to Friday", « du lundi au vendredi », « le lundi et le jeudi ». */
const daysText = (lang, raw) => {
  const words = listOf(raw).map((w) => w.toLowerCase());
  const set = new Set();
  for (const w of words) {
    if (["weekday", "weekdays", "workday", "workdays"].includes(w)) ["mon", "tue", "wed", "thu", "fri"].forEach((d) => set.add(d));
    else if (w === "weekend") ["sat", "sun"].forEach((d) => set.add(d));
    else if (w === "daily") DAY_KEYS.forEach((d) => set.add(d));
    else if (w === "saturday") set.add("sat");
    else if (w === "sunday") set.add("sun");
    else if (DAY_KEYS.includes(w.slice(0, 3))) set.add(w.slice(0, 3));
  }
  const days = DAY_KEYS.filter((d) => set.has(d));
  const key = days.join(",");
  if (!days.length) return "";
  if (key === DAY_KEYS.join(",")) return tr(lang, "clause.scope_daily");
  if (key === "mon,tue,wed,thu,fri") return tr(lang, "clause.scope_weekday");
  if (key === "sat,sun") return tr(lang, "clause.scope_weekend");
  if (key === "sat") return tr(lang, "clause.scope_saturday");
  if (key === "sun") return tr(lang, "clause.scope_sunday");
  return joined(lang, days.map((d) => tr(lang, "clause.scope_dow", { day: tr(lang, DAY_CODES[d]) })));
};

/**
 * When a clause holds, as a phrase: its days (or the kind's default day
 * when no listed date or public-holidays period decides), its period and
 * school zone, its window or dates — « du lundi au vendredi en période
 * scolaire (zone C) à partir du 2 novembre 2026 ». "" when nothing is said.
 */
const scopeText = (lang, c) => {
  const p = c.params || {};
  const parts = [];
  const period = str(p.period);
  const kind = period ? canonical(period) : null;
  const said = given(p.day) ? p.day : given(p.days) ? p.days : null;
  const decided = given(p.dates) || kind === "public_holidays";
  const day = said || (decided ? null : DEFAULT_DAY[c.kind] || null);
  if (day) parts.push(daysText(lang, day));
  if (period) {
    const text = kind === "school_days" ? tr(lang, "clause.scope_school_days") : kind === "school_holidays" ? tr(lang, "clause.scope_school_holidays") : kind === "public_holidays" ? tr(lang, "clause.scope_public_holidays") : tr(lang, "clause.scope_period", { name: period });
    parts.push(given(p.region) ? `${text} ${tr(lang, "clause.scope_region", { region: str(p.region) })}` : text);
  }
  if (given(p.from_date) && given(p.to_date)) parts.push(tr(lang, "clause.scope_between", { from: dateText(lang, p.from_date), to: dateText(lang, p.to_date) }));
  else if (given(p.from_date)) parts.push(tr(lang, "clause.scope_from", { date: dateText(lang, p.from_date) }));
  else if (given(p.to_date)) parts.push(tr(lang, "clause.scope_to", { date: dateText(lang, p.to_date) }));
  if (given(p.dates)) {
    const list = listOf(p.dates).flatMap((x) => x.split(/[\s,;]+/)).filter(Boolean);
    const shown = list.slice(0, 3).map((d) => tr(lang, "clause.scope_date", { date: dateText(lang, d) }));
    if (list.length > 3) shown.push(tr(lang, "clause.scope_more_dates", { count: list.length - 3 }));
    parts.push(joined(lang, shown));
  }
  return parts.filter(Boolean).join(" ");
};

/** The lines a clause is about: « Ligne C », « Lignes 1, 2 », « Toutes les lignes ». */
const headText = (lang, p) => {
  const lines = [...new Set([...listOf(p.lines), ...listOf(p.line)])];
  if (!lines.length) return tr(lang, "clause.lines_all");
  return lines.length === 1 ? tr(lang, "clause.line_one", { line: lines[0] }) : tr(lang, "clause.lines_some", { lines: joined(lang, lines) });
};

const num = (v) => {
  const n = typeof v === "number" ? v : parseFloat(String(v ?? "").replace(",", "."));
  return Number.isFinite(n) ? n : null;
};

/** The one direction a trip clause measures (its `direction`, "both" meaning none), or null. */
const directionOf = (p) => (given(p.direction) && str(p.direction) !== "both" ? str(p.direction) : null);

/** The head with the direction the checker measures: « Ligne D (sens 0) »; the head alone without one. */
const headInDirection = (lang, head, p) => (directionOf(p) != null ? `${head}${tr(lang, "clause.direction", { direction: directionOf(p) })}` : head);

/** A window on the trips' departures: « entre 7h00 et 9h00 » (a leading space), "" without one. */
const windowText = (lang, p) => (given(p.from) && given(p.to) ? tr(lang, "clause.window", { from: timeText(lang, p.from), to: timeText(lang, p.to) }) : given(p.from) ? tr(lang, "clause.window_from", { from: timeText(lang, p.from) }) : given(p.to) ? tr(lang, "clause.window_to", { to: timeText(lang, p.to) }) : "");

/** The head of an identity clause: the line or stop, or all of them but those `except` names (« Toutes les lignes sauf C »). */
const identityHead = (lang, p, head) => (listOf(p.except).length ? `${head}${tr(lang, "clause.identity_except", { names: joined(lang, listOf(p.except)) })}` : head);

const KINDS = {
  running_time(lang, c, head, scope) {
    const p = c.params;
    const minutes = num(p.minutes);
    const tol = num(p.tolerance_min) ?? 2;
    const lo = num(p.min_minutes);
    const hi = num(p.max_minutes);
    const bounds = minutes != null ? tr(lang, "clause.bounds_tolerance", { minutes, tolerance: tol }) : lo != null && hi != null ? tr(lang, "clause.bounds_range", { min: lo, max: hi }) : hi != null ? tr(lang, "clause.bounds_max", { max: hi }) : lo != null ? tr(lang, "clause.bounds_min", { min: lo }) : "?";
    if (given(p.like_day)) return tr(lang, "clause.running_time_like_day", { head: headInDirection(lang, head, p), from_stop: str(p.from_stop) || "?", to_stop: str(p.to_stop) || "?", day: daysText(lang, p.like_day) || str(p.like_day), tolerance: tol, window: windowText(lang, p), measure: p.measure === "median" ? "median" : "each", scope });
    return tr(lang, "clause.running_time", { head: headInDirection(lang, head, p), from_stop: str(p.from_stop) || "?", to_stop: str(p.to_stop) || "?", bounds, window: windowText(lang, p), measure: p.measure === "median" ? "median" : "each", scope });
  },
  // The route between two stops follows a reference line's shape.
  shape_follows(lang, c, head, scope) {
    const p = c.params;
    return tr(lang, "clause.shape_follows", { head: headInDirection(lang, head, p), from_stop: str(p.from_stop) || "?", to_stop: str(p.to_stop) || "?", like_line: str(p.like_line) || "?", tolerance: num(p.tolerance_m) ?? 30, scope });
  },
  trips_count(lang, c, head, scope) {
    const p = c.params;
    const exactly = num(p.exactly);
    const lo = exactly ?? num(p.min);
    const hi = exactly ?? num(p.max);
    const count = lo != null && hi != null ? (lo === hi ? tr(lang, "clause.count_exactly", { n: lo }) : tr(lang, "clause.count_range", { min: lo, max: hi })) : lo != null ? tr(lang, "clause.count_min", { n: lo }) : tr(lang, "clause.count_max", { n: hi ?? "?" });
    // A direction named: only its trips are counted (whatever `per` says), never « au total » — said by the
    // destination's name when the clause gives one (the direction's number beside it would say the same twice).
    const direction = directionOf(p);
    const directional = direction != null || given(p.towards);
    const per = direction != null && !given(p.towards) ? tr(lang, "clause.per_in_direction", { direction }) : p.per === "total" || (p.per !== "direction" && directional) ? tr(lang, "clause.per_total") : tr(lang, "clause.per_direction");
    const at = given(p.at_stop) ? tr(lang, "clause.serving", { stop: str(p.at_stop?.name ?? p.at_stop) + occurrenceText(lang, p) }) : "";
    const towards = given(p.towards) ? tr(lang, "clause.towards", { stop: str(p.towards?.name ?? p.towards) }) : "";
    return tr(lang, "clause.trips_count", { head, count, n: hi ?? lo ?? 0, per, at, towards, window: windowText(lang, p), scope });
  },
  departure_at(lang, c, head, scope) {
    const p = c.params;
    const times = listOf(p.times).flatMap((x) => x.split(/\s*[,;]\s*|\s+(?:et|and)\s+|\s+/i)).filter(Boolean);
    const towards = given(p.towards) ? tr(lang, "clause.towards", { stop: str(p.towards?.name ?? p.towards) }) : "";
    const tolerance = num(p.tolerance_min) ? tr(lang, "clause.tolerance", { n: num(p.tolerance_min) }) : "";
    // The destination's name says the direction; its number is added only when the clause names no destination.
    const params = { head: given(p.towards) ? head : headInDirection(lang, head, p), stop: (str(p.stop?.name ?? p.stop) || "?") + occurrenceText(lang, p), times: timesText(lang, p.times) || "?", count: times.length, towards, tolerance, scope };
    if (p.present === false || p.present === "false") return tr(lang, "clause.departure_at_absent", params);
    return tr(lang, "clause.departure_at", { ...params, event: p.event === "arrival" ? "arrival" : "departure" });
  },
  stop_pattern(lang, c, head_, scope) {
    const p = c.params;
    const head = headInDirection(lang, head_, p);
    const stops = listOf(p.stops);
    const avoid = listOf(p.avoid);
    const avoidText = avoid.length ? joined(lang, avoid, "clause.nor_sep") : "";
    if (stops.length < 2) return tr(lang, "clause.stop_pattern_avoid", { head, stops: avoidText || "?", scope });
    const extras = `${p.ends === true || p.ends === "true" ? tr(lang, "clause.ends") : ""}${p.exact === true || p.exact === "true" ? tr(lang, "clause.exact") : ""}${avoid.length ? tr(lang, "clause.avoid", { stops: avoidText }) : ""}`;
    const params = { head, trips: p.trips === "any" ? "any" : "each", first: stops[0], last: stops[stops.length - 1], extras, scope };
    if (stops.length === 2) return tr(lang, "clause.stop_pattern_direct", params);
    return tr(lang, "clause.stop_pattern", { ...params, middle: joined(lang, stops.slice(1, -1), "clause.then_sep") });
  },
  same_as(lang, c, head, scope) {
    const p = c.params;
    const ref = given(p.like_week) ? tr(lang, "clause.ref_week", { date: dateText(lang, p.like_week) }) : tr(lang, "clause.ref_date", { date: dateText(lang, p.like_date) });
    return tr(lang, "clause.same_as", { head, scope: scope.replace(/^, /, ""), ref, before: p.like_in === "before" ? tr(lang, "clause.ref_before") : "" });
  },
  unchanged_except(lang, c, head, scope) {
    const p = c.params;
    const ex = p.except && typeof p.except === "object" ? p.except : {};
    const lines = listOf(ex.lines);
    const exceptLines = lines.length ? tr(lang, "clause.except_lines", { count: lines.length, lines: joined(lang, lines) }) : "";
    const window = given(ex.from) || given(ex.to) ? tr(lang, "clause.except_window", { from: given(ex.from) ? timeText(lang, ex.from) : "…", to: given(ex.to) ? timeText(lang, ex.to) : "…" }) : "";
    const beyond = ex.beyond && typeof ex.beyond === "object" ? tr(lang, "clause.except_beyond", { stop: str(ex.beyond.stop) || "?", towards: str(ex.beyond.towards) || "?" }) : "";
    const stops = `${listOf(ex.stops).length ? tr(lang, "clause.except_stops", { stops: joined(lang, listOf(ex.stops)) }) : ""}${beyond}`;
    const direction = given(ex.direction) ? tr(lang, "clause.direction", { direction: str(ex.direction) }) : "";
    return tr(lang, "clause.unchanged_except", { head, except_lines: exceptLines, window, stops, direction, scope });
  },
  headway_max(lang, c, head, scope) {
    const p = c.params;
    // A headway the brief states at a stop (a timing point): said there.
    const stop = str(p.stop?.name ?? p.stop);
    return tr(lang, "clause.headway_max", { head, minutes: num(p.minutes) ?? "?", from: timeText(lang, p.from || "07:00"), to: timeText(lang, p.to || "09:00"), at: stop ? tr(lang, "clause.at_stop", { stop: stop + occurrenceText(lang, p) }) : "", scope });
  },
  span(lang, c, head, scope) {
    const p = c.params;
    // Both bounds on the same time say the time itself: « premier départ à 6h30 ».
    const same = (a, b) => given(p[a]) && given(p[b]) && timeText(lang, p[a]) === timeText(lang, p[b]);
    const firstAt = same("first_before", "first_after");
    const lastAt = same("last_after", "last_before");
    const parts = [
      firstAt ? tr(lang, "clause.span_first_at", { time: timeText(lang, p.first_before) }) : null,
      !firstAt && given(p.first_before) ? tr(lang, "clause.span_first", { time: timeText(lang, p.first_before) }) : null,
      !firstAt && given(p.first_after) ? tr(lang, "clause.span_first_after", { time: timeText(lang, p.first_after) }) : null,
      lastAt ? tr(lang, "clause.span_last_at", { time: timeText(lang, p.last_after) }) : null,
      !lastAt && given(p.last_after) ? tr(lang, "clause.span_last", { time: timeText(lang, p.last_after) }) : null,
      !lastAt && given(p.last_before) ? tr(lang, "clause.span_last_before", { time: timeText(lang, p.last_before) }) : null,
      num(p.amplitude_h) != null ? tr(lang, "clause.span_amplitude", { hours: num(p.amplitude_h) }) : null,
    ].filter(Boolean);
    return tr(lang, "clause.span", { head, parts: parts.join(", ") || "?", scope });
  },
  transfer_max_wait(lang, c, head, scope) {
    const p = c.params;
    // Each side of the connection: a line (and its direction), or the external times the brief lists.
    const sideText = (line, times, direction) => (str(line) ? `${tr(lang, "clause.transfer_line", { line: str(line) })}${given(direction) && str(direction) !== "both" ? tr(lang, "clause.direction", { direction: str(direction) }) : ""}` : given(times) ? tr(lang, "clause.transfer_times", { times: timesText(lang, times) }) : "?");
    const max = num(p.max_wait);
    const min = num(p.min_wait);
    // each departure: the guarantee reads from the departures, the feeder arriving before them.
    const before = p.each === "departure";
    const bounds = min ? tr(lang, before ? "clause.transfer_between_before" : "clause.transfer_between", { min, max: max ?? "?" }) : tr(lang, before ? "clause.transfer_within_before" : "clause.transfer_within", { max: max ?? "?" });
    const radius = num(p.radius_m) ? tr(lang, "clause.transfer_radius", { radius: num(p.radius_m) }) : "";
    const params = { stop: str(p.stop?.name ?? p.stop) || "?", radius, from: sideText(p.from_line, p.from_times, p.from_direction), to: sideText(p.to_line, p.to_times, p.to_direction), bounds, window: windowText(lang, p), scope };
    return tr(lang, before ? "clause.transfer_max_wait_departures" : "clause.transfer_max_wait", params);
  },
  accessibility(lang, c, head, scope) {
    const p = c.params;
    const pct = num(p.min_pct) != null && num(p.min_pct) < 100 ? tr(lang, "clause.accessibility_pct", { pct: num(p.min_pct) }) : "";
    if (p.measure === "trips" && (p.unchanged === true || str(p.unchanged) === "true")) return tr(lang, "clause.accessibility_unchanged", { head, scope });
    if (p.measure === "trips") return tr(lang, "clause.accessibility_trips", { head, pct: `${pct}${scope}` });
    const stops = listOf(p.stops);
    if (stops.length) return tr(lang, "clause.accessibility_named", { stops: joined(lang, stops), pct });
    return tr(lang, "clause.accessibility_stops", { head, pct });
  },
  // The calls' pickup and drop-off types: on demand (TAD), regular, drop-off only, pickup only, or the types named.
  pickup_dropoff(lang, c, head, scope) {
    const p = c.params;
    const stops = listOf(p.stops);
    const where = stops.length ? joined(lang, stops) : given(p.from_stop) && given(p.to_stop) ? tr(lang, "clause.stretch_from_to", { from: str(p.from_stop), to: str(p.to_stop) }) : given(p.from_stop) ? tr(lang, "clause.stretch_from", { from: str(p.from_stop) }) : given(p.to_stop) ? tr(lang, "clause.stretch_to", { to: str(p.to_stop) }) : "?";
    const h = headInDirection(lang, head, p);
    const od = p.on_demand === true || p.on_demand === "true" ? true : p.on_demand === false || p.on_demand === "false" ? false : null;
    if (od === true) return tr(lang, "clause.pickup_dropoff_on_demand", { head: h, stops: where, scope });
    if (od === false) return tr(lang, "clause.pickup_dropoff_regular", { head: h, stops: where, scope });
    const code = (v) => {
      const s = str(v).toLowerCase().replace(/[\s-]+/g, "_");
      return /^[0-3]$/.test(s) ? s : ACCESS_WORDS[s] ?? null;
    };
    const pk = given(p.pickup) ? code(p.pickup) : null;
    const dk = given(p.drop_off) ? code(p.drop_off) : null;
    if (pk === "1" && dk == null) return tr(lang, "clause.pickup_dropoff_no_pickup", { head: h, stops: where, scope });
    if (dk === "1" && pk == null) return tr(lang, "clause.pickup_dropoff_no_drop_off", { head: h, stops: where, scope });
    const word = (v) => (v == null ? "?" : tr(lang, ACCESS_WORD_CODES[v]));
    return tr(lang, "clause.pickup_dropoff_types", { head: h, pickup: word(pk), drop_off: word(dk), stops: where, scope });
  },
  line_identity(lang, c) {
    const p = c.params;
    const keep = p.unchanged === true || p.unchanged === "true" ? ["short_name", "long_name", "color", "text_color"] : listOf(p.unchanged);
    const color = (v) => str(v).replace(/^#/, "").toUpperCase();
    const parts = [
      given(p.short_name) ? tr(lang, "clause.identity_number", { value: str(p.short_name) }) : keep.includes("short_name") ? tr(lang, "clause.identity_number_kept") : null,
      given(p.long_name) ? tr(lang, "clause.identity_name", { value: str(p.long_name) }) : keep.includes("long_name") ? tr(lang, "clause.identity_name_kept") : null,
      given(p.color) ? tr(lang, "clause.identity_color", { value: color(p.color) }) : keep.includes("color") ? tr(lang, "clause.identity_color_kept") : null,
      given(p.text_color) ? tr(lang, "clause.identity_text_color", { value: color(p.text_color) }) : keep.includes("text_color") ? tr(lang, "clause.identity_text_color_kept") : null,
    ].filter(Boolean);
    return tr(lang, "clause.identity", { head: identityHead(lang, p, str(p.line) ? tr(lang, "clause.line_one", { line: str(p.line) }) : tr(lang, "clause.lines_all")), parts: parts.join(", ") || "?" });
  },
  stop_identity(lang, c) {
    const p = c.params;
    const keep = p.unchanged === true || p.unchanged === "true" ? ["name", "code"] : listOf(p.unchanged);
    const parts = [
      given(p.name) ? tr(lang, "clause.identity_stop_name", { value: str(p.name) }) : keep.includes("name") ? tr(lang, "clause.identity_name_kept") : null,
      given(p.code) ? tr(lang, "clause.identity_code", { value: str(p.code) }) : keep.includes("code") ? tr(lang, "clause.identity_code_kept") : null,
    ].filter(Boolean);
    const stop = str(p.stop?.name ?? p.stop);
    return tr(lang, "clause.identity", { head: identityHead(lang, p, stop ? tr(lang, "clause.stop_one", { stop }) : tr(lang, "clause.stops_all")), parts: parts.join(", ") || "?" });
  },
  feed_validity(lang, c) {
    const p = c.params;
    const from = p.from ?? p.from_date;
    const to = p.to ?? p.to_date;
    const range = given(from) && given(to) ? tr(lang, "clause.scope_between", { from: dateText(lang, from), to: dateText(lang, to) }) : given(from) ? tr(lang, "clause.scope_from", { date: dateText(lang, from) }) : given(to) ? tr(lang, "clause.scope_to", { date: dateText(lang, to) }) : null;
    return range ? tr(lang, "clause.feed_validity", { range }) : tr(lang, "clause.feed_validity_unchanged");
  },
  population_coverage: (lang, c) => tr(lang, "clause.population_coverage", { pct: num(c.params.min_pct) ?? "?", radius: num(c.params.radius_m) || 400, line: str(c.params.line) ? tr(lang, "clause.of_line", { line: str(c.params.line) }) : "" }),
  service_km_max: (lang, c) => tr(lang, "clause.service_km_max", { km: num(c.params.km) ?? "?", line: str(c.params.line) ? tr(lang, "clause.on_line", { line: str(c.params.line) }) : "" }),
  vehicle_hours_max: (lang, c) => tr(lang, "clause.vehicle_hours_max", { hours: num(c.params.hours) ?? "?", line: str(c.params.line) ? tr(lang, "clause.on_line", { line: str(c.params.line) }) : "" }),
  days: (lang, c, head, scope) => tr(lang, "clause.days", { head, scope: scope.replace(/^, /, " ") }),
  no_service: (lang, c, head, scope) => tr(lang, "clause.no_service", { head, scope: scope.replace(/^, /, " ") }),
  line_exists: (lang, c) => tr(lang, "clause.line_one", { line: str(c.params.line) || "?" }),
  termini: (lang, c) => tr(lang, "clause.termini", { line: str(c.params.line) || "?", from: str(c.params.from?.name ?? c.params.from) || "?", to: str(c.params.to?.name ?? c.params.to) || "?" }),
  via: (lang, c) => tr(lang, "clause.via", { line: str(c.params.line) || "?", stops: joined(lang, listOf(c.params.stops)) || "?" }),
  serves: (lang, c) => tr(lang, "clause.serves", { place: str(c.params.place) || "?", radius: num(c.params.radius_m) || 400 }),
  mode: (lang, c) => tr(lang, "clause.mode", { line: str(c.params.line) || "?", mode: str(c.params.mode) || "?" }),
  lines_max: (lang, c) => tr(lang, "clause.lines_max", { count: num(c.params.count) ?? "?" }),
  lines_min: (lang, c) => tr(lang, "clause.lines_min", { count: num(c.params.count) ?? "?" }),
  fleet_max: (lang, c) => tr(lang, "clause.fleet_max", { vehicles: num(c.params.vehicles) ?? "?" }),
  budget_max: (lang, c) => tr(lang, "clause.budget_max", { amount: num(c.params.amount) ?? "?" }),
  od_max_time: (lang, c, head, scope) => tr(lang, "clause.od_max_time", { from: str(c.params.from?.name ?? c.params.from) || "?", to: str(c.params.to?.name ?? c.params.to) || "?", minutes: num(c.params.max_minutes) ?? "?", scope }),
};

/** One line saying the clause in `lang` (fr, en…); null for a kind the checker does not know. */
const clauseText = (clause, lang = "en") => {
  if (!clause || typeof clause !== "object" || !KINDS[clause.kind]) return null;
  const c = { ...clause, params: clause.params && typeof clause.params === "object" ? clause.params : {} };
  const scope = scopeText(lang, c);
  return KINDS[c.kind](lang, c, headText(lang, c.params), scope ? `, ${scope}` : "");
};

module.exports = { clauseText, _internals: { scopeText, dateText, timeText, daysText } };
