/**
 * checks/identity — the checks of the network's public identity and
 * attributes: accessibility (wheelchair access of stops or trips),
 * line_identity (a line's number, name and colours), stop_identity (a stop's
 * name and code) and feed_validity (the period the feed's service covers),
 * each either given values or `unchanged` from the feed before the plan.
 * Each check takes (clause, ctx) and returns its result.
 */

"use strict";

const networkSpec = require("../../network/networkSpec");
const { str, num, iso, given, listOf, listText } = require("../values");
const { result } = require("../result");
const { parseYmd, designCalendar, dayWordsOf, scopeOf, gridOf } = require("../calendar");
const { findLine, pairedLine, nameMatches, servedStopIds, linesOfClause, baseSpecOf } = require("../locate");
const { datingOf } = require("../clauseModel");

const { nameKey } = networkSpec._internals;

// ── Helpers of the identity, accessibility and validity kinds ─────────────

/** A colour as GTFS writes it: six hex digits in capitals, without « # »; "" when none. */
const colorOf = (v) => str(v).replace(/^#/, "").toUpperCase();
/** A public name as the brief writes it: trimmed, inner spaces made one (case and dashes kept: « – » is not « - »). */
const plainName = (v) => str(v).replace(/\s+/g, " ");
/** The fields an `unchanged` param names: true → all of them; a list (or one name) → those of `all` it names. */
const unchangedFields = (v, all) => (v === true || v === "true" ? all : v == null || v === false || v === "false" ? [] : listOf(v).filter((f) => all.includes(f)));
const NO_BASELINE = "compares with the feed before the plan: none here";

/**
 * The line an identity clause names. In the network measured by its number,
 * its id or its long name (findLine); else in the feed before the plan by its
 * old number, then the same route by id in the network measured (a renumbered
 * line keeps its route id: « la ligne R devient la ligne 5 » is measured on
 * line R's route). `before` is its counterpart in the feed before (itself
 * when the measured feed is that feed).
 *   → { line: line | null (gone), before: line | null } | null (named nowhere)
 */
const identityLine = (ctx, ref) => {
  const base = baseSpecOf(ctx);
  const a = findLine(ctx.spec, ref);
  if (a) return { line: a, before: base ? pairedLine(base, a) || null : ctx.baseline?.self ? a : null };
  const b = base ? findLine(base, ref) : null;
  if (!b) return null;
  return { line: (ctx.spec.lines || []).find((l) => l.id === b.id) || null, before: b };
};

/** Every stop and station of a spec, each once: [{ id, name, code?, wheelchair?, parent?, station }]. */
const allStopsOf = (spec) => [...(spec.stops || []).map((s) => ({ ...s, station: false })), ...(spec.stations || []).map((s) => ({ ...s, station: true }))];

/**
 * The stops a clause names in a spec, a named station with its platforms:
 * by id, else by exact name (accents, case and punctuation aside), else —
 * with `partial` — by a whole-word part of the name (clauseTrips' rule).
 */
const stopsNamedIn = (spec, ref, { partial = true } = {}) => {
  const name = str(ref && typeof ref === "object" ? ref.name ?? ref.id : ref);
  const k = nameKey(name);
  if (!k) return [];
  const all = allStopsOf(spec);
  const byId = all.filter((s) => s.id != null && String(s.id) === name);
  let hits = byId.length ? byId : all.filter((s) => nameKey(s.name) === k);
  if (!hits.length && partial) hits = all.filter((s) => nameMatches(s.name, name));
  const ids = new Set(hits.map((s) => s.id));
  const stations = new Set(hits.filter((s) => s.station).map((s) => s.id));
  for (const s of all) {
    if (ids.has(s.id) || !s.parent || !stations.has(s.parent)) continue;
    hits.push(s);
    ids.add(s.id);
  }
  return hits;
};

/**
 * The stops an identity clause names, paired with the feed before the plan
 * by id: found in the network measured by id or exact name; else in the feed
 * before by id or exact name (a renamed stop keeps its id); else by a part
 * of the name, measured first.
 *   → [{ id, after: stop | null (removed), before: stop | null }] (empty: named nowhere)
 */
const identityStops = (ctx, ref) => {
  const base = baseSpecOf(ctx);
  const afterById = new Map(allStopsOf(ctx.spec).map((s) => [s.id, s]));
  const beforeById = base ? new Map(allStopsOf(base).map((s) => [s.id, s])) : ctx.baseline?.self ? afterById : null;
  const pair = (list, side) => list.map((s) => ({ id: s.id, after: side === "after" ? s : afterById.get(s.id) || null, before: beforeById ? beforeById.get(s.id) || null : null }));
  for (const partial of [false, true]) {
    const a = stopsNamedIn(ctx.spec, ref, { partial });
    if (a.length) return pair(a, "after");
    const b = base ? stopsNamedIn(base, ref, { partial }) : [];
    if (b.length) return pair(b, "before");
  }
  return [];
};

/** The wheelchair_boarding a stop really has: its own 1 or 2, else its station's (GTFS: a platform without a value inherits). */
const wheelchairOf = (stop, stationsById) => {
  const own = str(stop?.wheelchair);
  if (own === "1" || own === "2") return own;
  const parent = stop?.parent ? stationsById.get(stop.parent) : null;
  const up = str(parent?.wheelchair);
  return up === "1" || up === "2" ? up : "";
};

/** The service validity of a network: a feed view's calendars, a design's feed dates. → { start, end } | null */
const validityOfSpec = (spec) => (spec.kind === "feed" ? spec.validity || null : designCalendar(spec).validity);

/**
 * line_identity / stop_identity without a line or a stop: every line (stop,
 * station) of the feed before the plan that is still there, paired by id,
 * keeps the fields `keep` names, but those the clause's `except` lists. A
 * line or stop the plan removes is not judged here (the timetable clauses
 * measure a removal).
 */
const everyIdentity = (c, ctx, keep, what) => {
  const p = c.params;
  const line = what === "line";
  if (!keep.length || (line ? ["short_name", "long_name", "color", "text_color"] : ["name", "code"]).some((f) => given(p[f]))) return result(c, "unknown", { note: `incomplete clause (${what}; without one, unchanged only)` });
  const except = listOf(p.except).map(nameKey);
  const label = `every ${what}${except.length ? ` but ${listOf(p.except).join(", ")}` : ""}`;
  const expected = `${label}: ${keep.map((f) => f.replace("_", " ")).join(", ")} unchanged`;
  if (!ctx.baseline) return result(c, "unknown", { expected, note: NO_BASELINE });
  if (ctx.baseline.self) return result(c, "pass", { expected, measured: "the feed before the plan (reference)", baseline: "self" });
  const before = ctx.baseline.spec;
  const value = (x, f) => (f === "color" || f === "text_color" ? colorOf(x?.[f]) : f === "code" ? str(x?.code) : plainName(x?.[f]));
  const skip = (x) => except.length && [x.short_name, x.long_name, x.name, x.id].some((v) => v != null && except.includes(nameKey(v)));
  const afterList = line ? ctx.spec.lines || [] : allStopsOf(ctx.spec);
  const after = new Map(afterList.map((x) => [x.id, x]));
  const kept = (line ? before.lines || [] : allStopsOf(before)).filter((b) => !skip(b));
  const pairs = kept.filter((b) => after.has(b.id)).map((b) => [b, after.get(b.id)]);
  // An id the plan renamed (rename_id) leaves its line or stop without a counterpart by id: it is paired by what a
  // person reads — a line's number (else its name), a stop's name and code — when that names exactly one on each
  // side, so a renumbered or recoloured line under a new id is still compared, never skipped.
  const keyOf = (x) => (line ? plainName(x.short_name || x.long_name || "") : `${plainName(x.name || "")}|${str(x.code)}`);
  const unpairedAfter = afterList.filter((a) => !kept.some((b) => b.id === a.id));
  const count = (list, k) => list.filter((x) => keyOf(x) === k).length;
  const lone = kept.filter((b) => !after.has(b.id));
  for (const b of lone) {
    const k = keyOf(b);
    if (!k || k === "|" || count(lone, k) !== 1 || count(unpairedAfter, k) !== 1) continue;
    pairs.push([b, unpairedAfter.find((a) => keyOf(a) === k)]);
  }
  const missing = kept.length - pairs.length;
  // Nothing compared is never a pass: every line or stop of the feed before is gone or unrecognisable.
  if (kept.length && !pairs.length) return result(c, "unknown", { expected, note: `no ${what} of the feed before the plan has a counterpart after it (${kept.length} without one)`, baseline: "before" });
  const wrong = [];
  for (const [b, a] of pairs) for (const f of keep) if (value(a, f) !== value(b, f)) wrong.push(`${line ? `line ${b.short_name || b.id}` : b.id}: ${f.replace("_", " ")} "${value(a, f)}" (was "${value(b, f)}")`);
  const measured = wrong.length ? `${listText(wrong)}` : `${pairs.length} ${what}${pairs.length === 1 ? "" : "s"} compared, none changed${missing ? ` (${missing} of the feed before without a counterpart, not compared)` : ""}`;
  return result(c, wrong.length ? "fail" : "pass", { expected, measured, baseline: "before" });
};

const CHECKS = {
  accessibility(c, ctx) {
    const { spec } = ctx;
    const p = c.params;
    const measure = p.measure === "trips" ? "trips" : "stops";
    const minPct = given(p.min_pct) ? num(p.min_pct) : 100;
    if (minPct == null || minPct < 0 || minPct > 100) return result(c, "unknown", { note: "incomplete clause (min_pct between 0 and 100)" });
    const named = listOf(p.stops);
    const lines = linesOfClause(spec, p);
    if (lines.missing) return result(c, "fail", { expected: `line ${lines.missing}`, measured: "no such line" });
    const share = (ok, total) => Math.round((ok / total) * 1000) / 10;
    const what = minPct >= 100 ? "every" : `at least ${minPct} % of the`;
    if (measure === "trips") {
      const keepUnchanged = p.unchanged === true || str(p.unchanged) === "true";
      const dated = datingOf(p).length > 0 || given(dayWordsOf(p));
      if (named.length) return result(c, "unknown", { note: "trips are measured per line: give a line, not stops" });
      if (spec.kind !== "feed" || typeof spec.lineTrips !== "function") return result(c, "unknown", { note: "a designed network does not say which trips are wheelchair accessible" });
      // Dated: the trips running on the dates named (every timetable of the scope); else every trip of the line.
      let scope = null;
      if (dated) {
        scope = scopeOf(c, ctx, { everyDate: true });
        if (scope.error || scope.note) return result(c, "unknown", { note: scope.error || scope.note });
      }
      const scopeWords = scope ? ` (${scope.label || "the dates named"})` : "";
      if (keepUnchanged) {
        // As in the feed before the plan: every trip running on those dates keeps its accessibility, trips matched
        // by what they are (direction, stops, times: a service the plan split renames its trips).
        const expected = `trips of ${lines.label}: wheelchair accessibility as in the feed before the plan${scopeWords}`;
        if (!ctx.baseline || ctx.baseline.self) return result(c, "unknown", { expected, note: NO_BASELINE });
        const base = ctx.baseline.spec;
        const points = scope ? gridOf(scope, ctx, lines.list) : ["mon", "sat", "sun"].map((d) => spec.representativeDate(d)).filter(Boolean).map((date) => ({ date, dates: [date] }));
        const changed = [];
        const changedIds = new Set();
        const comparedIds = new Set();
        let compared = 0;
        for (const l of lines.list) {
          const bl = pairedLine(base, l);
          if (!bl) return result(c, "unknown", { expected, note: `line ${l.short_name} has no counterpart in the feed before the plan`, baseline: "before" });
          const wcAfter = new Map(spec.lineTrips(l.id).map((t) => [t.id, str(t.wheelchair)]));
          const wcBefore = new Map(base.lineTrips(bl.id).map((t) => [t.id, str(t.wheelchair)]));
          const sigOf = (t) => `${t.direction}|${t.stops.join(">")}|${t.dep.join(",")}`;
          const baseId = (t) => String(t.id).split("#")[0];
          for (const pt of points) {
            if (!pt.date) continue;
            const before = new Map(base.tripsOnDate(bl.id, pt.date).map((t) => [sigOf(t), wcBefore.get(baseId(t)) ?? ""]));
            for (const t of spec.tripsOnDate(l.id, pt.date)) {
              const was = before.get(sigOf(t));
              if (was === undefined) continue;
              if (!comparedIds.has(baseId(t))) {
                comparedIds.add(baseId(t));
                compared += 1;
              }
              const now = wcAfter.get(baseId(t)) ?? "";
              if (now !== was && !changedIds.has(baseId(t))) {
                changedIds.add(baseId(t));
                changed.push(`${baseId(t)} on ${iso(pt.date)} (${was || "none"} → ${now || "none"})`);
              }
            }
          }
        }
        if (!compared) return result(c, "unknown", { expected, note: `no trip of ${lines.label} to compare with the feed before${scopeWords}`, baseline: "before" });
        return result(c, changed.length ? "fail" : "pass", { expected, measured: changed.length ? `${changed.length} of ${compared} trips changed: ${listText(changed)}` : `${compared} trips as before`, lines: lines.list.map((l) => l.id), baseline: "before" });
      }
      const expected = `${what} trip of ${lines.label} wheelchair accessible${scopeWords}`;
      let trips = lines.list.flatMap((l) => spec.lineTrips(l.id));
      if (scope) {
        const running = new Set();
        for (const l of lines.list) for (const pt of gridOf(scope, ctx, [l])) for (const t of pt.date ? spec.tripsOnDate(l.id, pt.date) : []) running.add(String(t.id).split("#")[0]);
        trips = trips.filter((t) => running.has(t.id));
      }
      if (!trips.length) return result(c, "unknown", { expected, note: `no trip of ${lines.label} to measure${scopeWords}` });
      const ok = trips.filter((t) => str(t.wheelchair) === "1").length;
      const pct = share(ok, trips.length);
      return result(c, pct + 1e-9 >= minPct ? "pass" : "fail", { expected, measured: `${ok} of ${trips.length} trips accessible (${pct} %)${scopeWords}`, lines: lines.list.map((l) => l.id) });
    }
    const stationsById = new Map((spec.stations || []).map((s) => [s.id, s]));
    let set;
    if (named.length) {
      const seen = new Map();
      for (const name of named) {
        const hits = stopsNamedIn(spec, name);
        if (!hits.length) return result(c, "unknown", { note: `no stop named ${name} in the network` });
        for (const h of hits) seen.set(h.id, h);
      }
      set = [...seen.values()];
    } else {
      const byId = new Map((spec.stops || []).map((s) => [s.id, s]));
      set = [...new Set(lines.list.flatMap((l) => servedStopIds(l, spec)))].map((id) => byId.get(id)).filter(Boolean);
    }
    const expected = `${what} stop ${named.length ? `named ${listText(named)}` : `served by ${lines.label}`} wheelchair accessible`;
    if (!set.length) return result(c, "unknown", { expected, note: "no stop to measure" });
    const bad = set.filter((s) => wheelchairOf(s, stationsById) !== "1");
    const silent = bad.filter((s) => wheelchairOf(s, stationsById) === "").length;
    const pct = share(set.length - bad.length, set.length);
    const names = [...new Set(bad.map((s) => s.name))];
    const measured = `${set.length - bad.length} of ${set.length} stops accessible (${pct} %)${bad.length ? `; not: ${listText(names)}${silent ? ` (${silent} without information)` : ""}` : ""}`;
    return result(c, pct + 1e-9 >= minPct ? "pass" : "fail", { expected, measured, stops: bad.slice(0, 20).map((s) => s.id), lines: named.length ? [] : lines.list.map((l) => l.id) });
  },

  // A line's public identity: its number, long name and colours are the
  // values the clause gives (names exactly as written, colours as six hex
  // digits), and those `unchanged` names are the feed before the plan's.
  // Without a line, `unchanged` holds every line of the feed before (but
  // those `except` names): none is renumbered, renamed or recoloured.
  line_identity(c, ctx) {
    const p = c.params;
    const FIELDS = ["short_name", "long_name", "color", "text_color"];
    const keep = unchangedFields(p.unchanged, FIELDS);
    if (!str(p.line)) return everyIdentity(c, ctx, keep, "line");
    const want = Object.fromEntries(FIELDS.filter((f) => given(p[f])).map((f) => [f, f === "color" || f === "text_color" ? colorOf(p[f]) : plainName(p[f])]));
    if (!Object.keys(want).length && !keep.length) return result(c, "unknown", { note: "incomplete clause (short_name, long_name, color, text_color or unchanged)" });
    const show = (f, v) => (f === "color" || f === "text_color" ? `${f === "color" ? "colour" : "text colour"} #${v || "none"}` : `${f === "short_name" ? "number" : "name"} "${v}"`);
    const expected = `line ${str(p.line)}: ${[...Object.entries(want).map(([f, v]) => show(f, v)), ...keep.filter((f) => !(f in want)).map((f) => `${f.replace("_", " ")} unchanged`)].join(", ")}`;
    if (keep.length && !ctx.baseline) return result(c, "unknown", { expected, note: NO_BASELINE });
    const found = identityLine(ctx, p.line);
    if (!found) return result(c, "fail", { expected, measured: `no line ${str(p.line)}` });
    if (!found.line) return result(c, "fail", { expected, measured: `line ${str(p.line)} is gone (route ${found.before.id} of the feed before)` });
    const l = found.line;
    const value = (line, f) => (f === "color" || f === "text_color" ? colorOf(line[f]) : plainName(line[f]));
    const wrong = Object.entries(want)
      .filter(([f, v]) => value(l, f) !== v)
      .map(([f, v]) => `${show(f, value(l, f))} (expected ${f === "color" || f === "text_color" ? `#${v}` : `"${v}"`})`);
    if (keep.length && !found.before) return result(c, "unknown", { expected, measured: `line ${l.short_name}`, lines: [l.id], note: `line ${l.short_name} has no counterpart in the feed before the plan`, baseline: "before" });
    for (const f of keep) if (!(f in want) && value(l, f) !== value(found.before, f)) wrong.push(`${show(f, value(l, f))} (was ${f === "color" || f === "text_color" ? `#${value(found.before, f) || "none"}` : `"${value(found.before, f)}"`})`);
    const measured = wrong.length ? wrong.join(", ") : `route ${l.id}: ${FIELDS.filter((f) => f in want || keep.includes(f)).map((f) => show(f, value(l, f))).join(", ")}`;
    return result(c, wrong.length ? "fail" : "pass", { expected, measured, lines: [l.id], ...(keep.length ? { baseline: ctx.baseline?.self ? "self" : "before" } : {}) });
  },

  // Every stop of that name or id (a station with its platforms) bears the
  // name and code the clause gives, and keeps those `unchanged` names. A
  // renamed stop is found by its old name in the feed before the plan.
  stop_identity(c, ctx) {
    const p = c.params;
    const ref = str(p.stop?.name ?? p.stop);
    const FIELDS = ["name", "code"];
    const keep = unchangedFields(p.unchanged, FIELDS);
    if (!ref) return everyIdentity(c, ctx, keep, "stop");
    const want = Object.fromEntries(FIELDS.filter((f) => given(p[f])).map((f) => [f, f === "name" ? plainName(p[f]) : str(p[f])]));
    if (!Object.keys(want).length && !keep.length) return result(c, "unknown", { note: "incomplete clause (name, code or unchanged)" });
    const expected = `stop ${ref}: ${[...Object.entries(want).map(([f, v]) => `${f} "${v}"`), ...keep.filter((f) => !(f in want)).map((f) => `${f} unchanged`)].join(", ")}`;
    if (keep.length && !ctx.baseline) return result(c, "unknown", { expected, note: NO_BASELINE });
    const pairs = identityStops(ctx, ref);
    if (!pairs.length) return result(c, "unknown", { expected, note: `no stop named ${ref} in the network` });
    const value = (s, f) => (f === "name" ? plainName(s?.name) : str(s?.code));
    const wrong = [];
    for (const x of pairs) {
      if (!x.after) {
        wrong.push(`${x.id} removed`);
        continue;
      }
      for (const [f, v] of Object.entries(want)) if (value(x.after, f) !== v) wrong.push(`${x.id}: ${f} "${value(x.after, f)}"`);
      for (const f of keep) if (!(f in want) && x.before && value(x.after, f) !== value(x.before, f)) wrong.push(`${x.id}: ${f} "${value(x.after, f)}" (was "${value(x.before, f)}")`);
    }
    const measured = wrong.length ? `${listText(wrong)} — ${pairs.length} stop${pairs.length === 1 ? "" : "s"} named so` : `${pairs.length} stop${pairs.length === 1 ? "" : "s"}: ${[...new Set(pairs.map((x) => `"${value(x.after, "name")}"${x.after.code ? ` (${x.after.code})` : ""}`))].join(", ")}`;
    return result(c, wrong.length ? "fail" : "pass", { expected, measured, stops: pairs.map((x) => x.id).slice(0, 20), ...(keep.length ? { baseline: ctx.baseline?.self ? "self" : "before" } : {}) });
  },

  // The feed's service covers [from, to]: its calendars' validity starts no
  // later than `from` and ends no earlier than `to`, and feed_info, when it
  // gives dates, says so too; `unchanged`: the validity is the one of the
  // feed before the plan (neither extended nor cut).
  feed_validity(c, ctx) {
    const { spec } = ctx;
    const p = c.params;
    const raw = { from: p.from ?? p.from_date, to: p.to ?? p.to_date };
    const want = {};
    for (const k of ["from", "to"]) {
      if (!given(raw[k])) continue;
      want[k] = parseYmd(raw[k]);
      if (!want[k]) return result(c, "unknown", { note: `${k} "${raw[k]}" is not a date (YYYY-MM-DD)` });
    }
    const keep = p.unchanged === true || p.unchanged === "true";
    if (!want.from && !want.to && !keep) return result(c, "unknown", { note: "incomplete clause (from, to or unchanged)" });
    const expected = [want.from || want.to ? `service from ${want.from ? `${iso(want.from)} or earlier` : "…"} to ${want.to ? `${iso(want.to)} or later` : "…"}` : null, keep ? "the validity of the feed before the plan" : null].filter(Boolean).join("; ");
    if (keep && !ctx.baseline) return result(c, "unknown", { expected, note: NO_BASELINE });
    const v = validityOfSpec(spec);
    if (!v || !v.start || !v.end) return result(c, "unknown", { expected, note: "the network has no validity (service start and end dates)" });
    const ymd = (x) => (/^\d{8}$/.test(str(x)) ? str(x) : null);
    const info = spec.kind === "feed" && spec.feedInfo ? { start: ymd(spec.feedInfo.feed_start_date), end: ymd(spec.feedInfo.feed_end_date) } : null;
    const wrong = [];
    if (want.from && v.start > want.from) wrong.push(`the service starts on ${iso(v.start)}`);
    if (want.to && v.end < want.to) wrong.push(`the service ends on ${iso(v.end)}`);
    if (want.from && info?.start && info.start > want.from) wrong.push(`feed_info starts on ${iso(info.start)}`);
    if (want.to && info?.end && info.end < want.to) wrong.push(`feed_info ends on ${iso(info.end)}`);
    if (keep) {
      const bv = ctx.baseline.self ? v : validityOfSpec(ctx.baseline.spec);
      if (!bv) return result(c, "unknown", { expected, note: "the feed before the plan has no validity" });
      if (bv.start !== v.start || bv.end !== v.end) wrong.push(`the validity was ${iso(bv.start)} → ${iso(bv.end)}`);
      // The validity a consumer reads first is feed_info's: unchanged holds its dates to the feed before's too.
      const bs = ctx.baseline.self ? spec : ctx.baseline.spec;
      const binfo = bs.kind === "feed" && bs.feedInfo ? { start: ymd(bs.feedInfo.feed_start_date), end: ymd(bs.feedInfo.feed_end_date) } : null;
      if ((binfo?.start || null) !== (info?.start || null) || (binfo?.end || null) !== (info?.end || null)) wrong.push(`feed_info was ${binfo?.start ? iso(binfo.start) : "…"} → ${binfo?.end ? iso(binfo.end) : "…"}`);
    }
    const measured = `service ${iso(v.start)} → ${iso(v.end)}${info && (info.start || info.end) ? `, feed_info ${info.start ? iso(info.start) : "…"} → ${info.end ? iso(info.end) : "…"}` : ""}${wrong.length ? `: ${wrong.join("; ")}` : ""}`;
    return result(c, wrong.length ? "fail" : "pass", { expected, measured, ...(keep ? { baseline: ctx.baseline.self ? "self" : "before" } : {}) });
  },
};

module.exports = { CHECKS, identityLine, stopsNamedIn, identityStops, wheelchairOf };
