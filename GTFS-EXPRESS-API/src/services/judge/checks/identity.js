/**
 * The checks of the network's public identity and attributes (accessibility, line_identity, stop_identity,
 * feed_validity), each against given values or `unchanged` from the feed before the plan.
 */

"use strict";

const { nameKey } = require("../../network/feedText");
const { str, num, iso, given, listOf, listText } = require("../values");
const { result } = require("../result");
const { parseYmd, dayWordsOf, scopeOf, gridOf } = require("../calendar");
const { findLine, pairedLine, nameMatches, servedStopIds, linesOfClause, baseSpecOf } = require("../locate");
const { datingOf } = require("../clauseModel");


/** Six hex digits in capitals, without « # »; "" when none. */
const colorOf = (v) => str(v).replace(/^#/, "").toUpperCase();
/** Inner spaces made one; case and dashes kept (« – » is not « - »). */
const plainName = (v) => str(v).replace(/\s+/g, " ");
const unchangedFields = (v, all) => (v === true || v === "true" ? all : v == null || v === false || v === "false" ? [] : listOf(v).filter((f) => all.includes(f)));
const NO_BASELINE = "compares with the feed before the plan: none here";

/**
 * Found in the network measured (findLine); else in the feed before by its old number, then by route id in the network
 * measured: a renumbered line keeps its route id (« la ligne R devient la ligne 5 » is measured on line R's route).
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

const allStopsOf = (spec) => [...(spec.stops || []).map((s) => ({ ...s, station: false })), ...(spec.stations || []).map((s) => ({ ...s, station: true }))];

/**
 * By id, else by exact name (accents, case and punctuation aside), else with `partial` by a whole-word part of the
 * name; a named station with its platforms.
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
 * Paired with the feed before by id (a renamed stop keeps its id); exact matches on either side before partial ones.
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

/** GTFS: a platform without a wheelchair_boarding of its own inherits its station's. */
const wheelchairOf = (stop, stationsById) => {
  const own = str(stop?.wheelchair);
  if (own === "1" || own === "2") return own;
  const parent = stop?.parent ? stationsById.get(stop.parent) : null;
  const up = str(parent?.wheelchair);
  return up === "1" || up === "2" ? up : "";
};

const validityOfSpec = (spec) => spec.validity || null;

/**
 * line_identity / stop_identity without a line or a stop: every one of the feed before still there keeps the fields
 * `keep` names, but those `except` lists. A removal is the timetable clauses' to measure.
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
  // An id renamed leaves no counterpart by id: paired by what a person reads (a line's number, else its name; a
  // stop's name and code) when that names exactly one on each side, so it is still compared, never skipped.
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
  // Nothing compared is never a pass.
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
      let scope = null;
      if (dated) {
        scope = scopeOf(c, ctx, { everyDate: true });
        if (scope.error || scope.note) return result(c, "unknown", { note: scope.error || scope.note });
      }
      const scopeWords = scope ? ` (${scope.label || "the dates named"})` : "";
      if (keepUnchanged) {
        // Trips matched by what they are (direction, stops, times): a service the plan split renames its trips.
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

  // The service covers at least [from, to], feed_info's dates too when it gives them.
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
    const info = spec.feedInfo ? { start: ymd(spec.feedInfo.feed_start_date), end: ymd(spec.feedInfo.feed_end_date) } : null;
    const wrong = [];
    if (want.from && v.start > want.from) wrong.push(`the service starts on ${iso(v.start)}`);
    if (want.to && v.end < want.to) wrong.push(`the service ends on ${iso(v.end)}`);
    if (want.from && info?.start && info.start > want.from) wrong.push(`feed_info starts on ${iso(info.start)}`);
    if (want.to && info?.end && info.end < want.to) wrong.push(`feed_info ends on ${iso(info.end)}`);
    if (keep) {
      const bv = ctx.baseline.self ? v : validityOfSpec(ctx.baseline.spec);
      if (!bv) return result(c, "unknown", { expected, note: "the feed before the plan has no validity" });
      if (bv.start !== v.start || bv.end !== v.end) wrong.push(`the validity was ${iso(bv.start)} → ${iso(bv.end)}`);
      // A consumer reads feed_info's validity first: unchanged holds its dates too.
      const bs = ctx.baseline.self ? spec : ctx.baseline.spec;
      const binfo = bs.feedInfo ? { start: ymd(bs.feedInfo.feed_start_date), end: ymd(bs.feedInfo.feed_end_date) } : null;
      if ((binfo?.start || null) !== (info?.start || null) || (binfo?.end || null) !== (info?.end || null)) wrong.push(`feed_info was ${binfo?.start ? iso(binfo.start) : "…"} → ${binfo?.end ? iso(binfo.end) : "…"}`);
    }
    const measured = `service ${iso(v.start)} → ${iso(v.end)}${info && (info.start || info.end) ? `, feed_info ${info.start ? iso(info.start) : "…"} → ${info.end ? iso(info.end) : "…"}` : ""}${wrong.length ? `: ${wrong.join("; ")}` : ""}`;
    return result(c, wrong.length ? "fail" : "pass", { expected, measured, ...(keep ? { baseline: ctx.baseline.self ? "self" : "before" } : {}) });
  },
};

module.exports = { CHECKS, identityLine, stopsNamedIn, identityStops, wheelchairOf };
