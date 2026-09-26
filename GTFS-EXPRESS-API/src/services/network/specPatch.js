/**
 * specPatch — targeted edits of a Network Spec, so a refinement changes
 * what was asked and nothing else (rewriting the whole spec to move one
 * stop loses lines on big networks and costs thousands of tokens).
 *
 *   applyPatch(spec, ops) → { spec, applied: [...], rejected: [{ index, op, reason }], diff }
 *
 * Operations (applied in order on a copy; a rejected one is skipped):
 *   { op: "upsert_stops", stops: [{ id?, name, lat?, lon?, … }] }   by id, else by exact name
 *   { op: "remove_stops", ids: [...] }                              also from every line
 *   { op: "insert_stop", line, stop, after? | before?, direction?: "0"|"1"|"both" }
 *                                                                   a stop (id or name) into a line
 *   { op: "upsert_lines", lines: [{ id? | short_name, …fields }] }  by id or short name; given
 *                                                                   directions / services replace
 *                                                                   the line's own
 *   { op: "remove_lines", ids: [...] }                              ids or short names
 *   { op: "set", field: "agency"|"feed"|"holidays"|"holiday_service"|"weekend"|"sync"|"transfers"|"operations", value }
 *
 * The result is a RAW spec: the caller normalises it (ids, derived returns,
 * calendars) exactly as it would a full set_spec.
 * `diff(before, after)` summarises what changed between two normalised specs.
 */

"use strict";

const { _internals } = require("./networkSpec");

const { nameKey } = _internals;
const SET_FIELDS = new Set(["agency", "feed", "holidays", "holiday_service", "weekend", "sync", "transfers", "operations"]);
const MAX_OPS = 200;

const clone = (x) => JSON.parse(JSON.stringify(x));
const str = (v) => (typeof v === "string" ? v.trim() : v == null ? "" : String(v).trim());

// A normalised spec back to what the model and the editors write: derived
// returns stay derived (they are re-derived from the outbound).
const toRaw = (spec) => clone(spec);

const findLineIndex = (lines, ref) => {
  const k = str(ref);
  if (!k) return -1;
  let i = lines.findIndex((l) => str(l.id) === k);
  if (i < 0) i = lines.findIndex((l) => nameKey(l.short_name) === nameKey(k));
  return i;
};

const findStop = (stops, ref) => {
  const k = str(ref && typeof ref === "object" ? ref.id || ref.name : ref);
  if (!k) return null;
  return stops.find((s) => str(s.id) === k) || stops.find((s) => nameKey(s.name) === nameKey(k)) || null;
};

const OPS = {
  upsert_stops(spec, op) {
    const list = Array.isArray(op.stops) ? op.stops : [];
    if (!list.length) return "stops[] is required";
    for (const s of list) {
      if (!s || typeof s !== "object") continue;
      const existing = (s.id && spec.stops.find((x) => x.id === s.id)) || (!s.id && s.name && spec.stops.find((x) => nameKey(x.name) === nameKey(s.name)));
      if (existing) Object.assign(existing, s);
      else spec.stops.push({ ...s });
    }
    return null;
  },

  remove_stops(spec, op) {
    const ids = new Set((Array.isArray(op.ids) ? op.ids : []).map(str).filter(Boolean));
    if (!ids.size) return "ids[] is required";
    const before = spec.stops.length;
    spec.stops = spec.stops.filter((s) => !ids.has(s.id));
    if (spec.stops.length === before) return "no such stop";
    for (const l of spec.lines) for (const d of l.directions || []) d.stops = (d.stops || []).filter((id) => !ids.has(id));
    return null;
  },

  insert_stop(spec, op) {
    const li = findLineIndex(spec.lines, op.line);
    if (li < 0) return `no line "${op.line}"`;
    const line = spec.lines[li];
    let stop = findStop(spec.stops, op.stop);
    if (!stop) {
      if (!op.stop || typeof op.stop !== "object" || !str(op.stop.name)) return "stop not found (give an existing id or name, or {name, lat, lon})";
      stop = { ...op.stop };
      spec.stops.push(stop);
    }
    const ref = stop.id || stop.name;
    const which = str(op.direction) || "both";
    let done = 0;
    for (const d of line.directions || []) {
      if (d.derived) continue; // re-derived from the outbound
      if (which !== "both" && d.id !== which) continue;
      const anchorRef = op.after ?? op.before;
      const anchor = anchorRef != null ? findStop(spec.stops, anchorRef) : null;
      const at = anchor ? d.stops.indexOf(anchor.id) : -1;
      if (anchorRef != null && at < 0) continue;
      const pos = anchor ? (op.after != null ? at + 1 : at) : d.stops.length;
      d.stops.splice(pos, 0, ref);
      done += 1;
    }
    return done ? null : "anchor stop not on this line";
  },

  upsert_lines(spec, op) {
    const list = Array.isArray(op.lines) ? op.lines : [];
    if (!list.length) return "lines[] is required";
    for (const l of list) {
      if (!l || typeof l !== "object") continue;
      const i = findLineIndex(spec.lines, l.id || l.short_name);
      if (i < 0) {
        spec.lines.push({ ...l });
        continue;
      }
      const cur = spec.lines[i];
      const next = { ...cur, ...l };
      // New directions replace the old ones; a single one gets its return derived again.
      if (Array.isArray(l.directions)) {
        next.directions = l.directions;
        if (l.directions.length === 1 && l.round_trip === undefined) delete next.round_trip;
      }
      spec.lines[i] = next;
    }
    return null;
  },

  remove_lines(spec, op) {
    const refs = (Array.isArray(op.ids) ? op.ids : []).map(str).filter(Boolean);
    if (!refs.length) return "ids[] is required";
    const before = spec.lines.length;
    spec.lines = spec.lines.filter((l) => !refs.some((r) => str(l.id) === r || nameKey(l.short_name) === nameKey(r)));
    return spec.lines.length === before ? "no such line" : null;
  },

  set(spec, op) {
    const field = str(op.field);
    if (!SET_FIELDS.has(field)) return `field must be one of ${[...SET_FIELDS].join(", ")}`;
    if (op.value === null || op.value === undefined) delete spec[field];
    else if (["agency", "feed", "operations"].includes(field) && typeof op.value === "object" && !Array.isArray(op.value)) spec[field] = { ...(spec[field] || {}), ...op.value };
    else spec[field] = op.value;
    return null;
  },
};

const applyPatch = (spec, ops) => {
  const out = toRaw(spec || {});
  out.stops = Array.isArray(out.stops) ? out.stops : [];
  out.lines = Array.isArray(out.lines) ? out.lines : [];
  const applied = [];
  const rejected = [];
  (Array.isArray(ops) ? ops : []).slice(0, MAX_OPS).forEach((op, index) => {
    const fn = op && OPS[op.op];
    if (!fn) {
      rejected.push({ index, op: op?.op || null, reason: `unknown op (use ${Object.keys(OPS).join(", ")})` });
      return;
    }
    // Each op on its own copy: a failing op leaves no half-change behind.
    const draft = clone(out);
    const reason = fn(draft, op);
    if (reason) rejected.push({ index, op: op.op, reason });
    else {
      Object.assign(out, draft);
      applied.push({ index, op: op.op });
    }
  });
  return { spec: out, applied, rejected };
};

/** What changed between two normalised specs, in a few lines. */
const diff = (before, after) => {
  const b = before || { lines: [], stops: [] };
  const a = after || { lines: [], stops: [] };
  const lineKey = (l) => l.id;
  const bl = new Map((b.lines || []).map((l) => [lineKey(l), l]));
  const al = new Map((a.lines || []).map((l) => [lineKey(l), l]));
  const sig = (l) => JSON.stringify({ d: (l.directions || []).filter((d) => !d.derived).map((d) => d.stops), s: l.services, m: l.mode, n: [l.short_name, l.long_name], c: l.color, v: [l.speed_kmh, l.dwell_s] });
  const bs = new Map((b.stops || []).map((s) => [s.id, s]));
  const as = new Map((a.stops || []).map((s) => [s.id, s]));
  const moved = [...as.values()].filter((s) => bs.has(s.id) && (bs.get(s.id).lat !== s.lat || bs.get(s.id).lon !== s.lon || bs.get(s.id).name !== s.name)).map((s) => s.id);
  return {
    lines_added: [...al.keys()].filter((k) => !bl.has(k)),
    lines_removed: [...bl.keys()].filter((k) => !al.has(k)),
    lines_changed: [...al.keys()].filter((k) => bl.has(k) && sig(bl.get(k)) !== sig(al.get(k))),
    stops_added: [...as.keys()].filter((k) => !bs.has(k)),
    stops_removed: [...bs.keys()].filter((k) => !as.has(k)),
    stops_changed: moved,
    settings_changed: ["agency", "feed", "holidays", "holiday_service", "weekend", "sync", "transfers", "operations"].filter((k) => JSON.stringify(b[k] ?? null) !== JSON.stringify(a[k] ?? null)),
  };
};

const summarizeDiff = (d) => {
  const parts = [];
  const list = (label, arr) => arr.length && parts.push(`${label}: ${arr.slice(0, 12).join(", ")}${arr.length > 12 ? "…" : ""}`);
  list("lines added", d.lines_added);
  list("lines removed", d.lines_removed);
  list("lines changed", d.lines_changed);
  list("stops added", d.stops_added);
  list("stops removed", d.stops_removed);
  list("stops moved/renamed", d.stops_changed);
  list("settings changed", d.settings_changed);
  return parts.length ? parts.join("; ") : "no change";
};

/**
 * The spec as the model reads it: derived returns left out (re-derived),
 * long departure lists summarised when the whole would not fit. `budget`
 * is a character budget; get_spec gives any part in full.
 */
const compactSpec = (spec, budget = 30000) => {
  if (!spec) return "";
  const lean = clone(spec);
  for (const l of lean.lines || []) l.directions = (l.directions || []).filter((d) => !d.derived);
  let text = JSON.stringify(lean);
  if (text.length <= budget) return text;
  for (const l of lean.lines || [])
    for (const s of l.services || [])
      if ((s.departures || []).length > 6) s.departures = [`${s.departures.length} departures ${s.departures[0]}…${s.departures[s.departures.length - 1]} (get_spec for all)`];
  text = JSON.stringify(lean);
  if (text.length <= budget) return text;
  // Still too big: stops as id|name|lat|lon rows, lines with their stop ids only.
  const stops = (lean.stops || []).map((s) => `${s.id}|${s.name}|${s.lat ?? ""}|${s.lon ?? ""}`).join("\n");
  const lines = (lean.lines || []).map((l) => `${l.id} ${l.short_name} (${l.mode}): ${(l.directions || []).map((d) => d.stops.join(">")).join(" / ")}; ${(l.services || []).map((s) => `${s.calendar_id} ${(s.periods || []).map((p) => `${p.from}-${p.to}/${p.headway_min}`).join(",")}${(s.departures || []).length ? ` +${s.departures.length}dep` : ""}`).join("; ")}`).join("\n");
  return `(compact view — use get_spec for any part in full, patch_spec to change it)\nagency ${JSON.stringify(lean.agency)} feed ${JSON.stringify(lean.feed)}\nstops (id|name|lat|lon):\n${stops}\nlines:\n${lines}`.slice(0, budget * 2);
};

module.exports = { applyPatch, diff, summarizeDiff, compactSpec, OPS: Object.keys(OPS) };
