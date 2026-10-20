/**
 * modelText — what a model reads of the engine, and what the engine keeps of what a model writes.
 *
 * The models that work on a loaded feed (the direct mode's agent, the reader's assistant when it proposes a change
 * plan) read the same texts: the feed at a glance before their first tool call, and a preview
 * as steps, changes, checks and the gate. An operation a model sends keeps only what a model may say of its source.
 *
 *   feedOverview(model)      → the loaded feed in a few lines: its counts, validity and representative dates, then one
 *                              line per route (termini, patterns, trips by day type), MAX_OVERVIEW_ROUTES at most
 *   summarizePreview(p)      → an engine preview as the model reads it: each step with its status, questions and
 *                              warnings, the quotes not verified, the changes, integrity, consumer checks, impact,
 *                              passenger information, the clauses after the plan, the gate
 *   modelOperation(op)       → the operation with its source reduced to MODEL_SOURCE_KEYS
 *   DAY_TYPES                → the day types the overview counts, with the days of week each reads
 */

"use strict";

const { routeStats } = require("./feedModel");

const MAX_OVERVIEW_ROUTES = 150;

const clip = (s, n) => (typeof s === "string" && s.length > n ? `${s.slice(0, n)}…` : s);

// ── The feed, as the model reads it ─────────────────────────────────────────

const DAY_TYPES = [
  ["weekday", ["tue", "mon", "wed", "thu", "fri"]],
  ["saturday", ["sat"]],
  ["sunday", ["sun"]],
];

const feedOverview = (model) => {
  const lines = [];
  lines.push(`[Loaded feed] ${model.counts.routes} lines, ${model.counts.stops} stops, ${model.counts.trips} trips, ${model.counts.services} services. Validity ${model.range ? `${model.range.start} → ${model.range.end}` : "unknown"}. Representative dates: ${Object.entries(model.representative).map(([k, v]) => `${k} ${v}`).join(", ")}.`);
  if (model.feedInfo) lines.push(`[feed_info] ${clip(JSON.stringify(model.feedInfo), 300)}`);
  lines.push("[Lines] id | short | long name | mode | termini | patterns | weekday trips first–last, peak headway | sat | sun");
  const routes = [...model.routes.values()].sort((a, b) => String(a.short_name || a.id).localeCompare(String(b.short_name || b.id), undefined, { numeric: true }));
  for (const r of routes.slice(0, MAX_OVERVIEW_ROUTES)) {
    const main = r.patterns[0];
    const termini = main ? `${model.stops.get(main.stops[0])?.name || "?"} ↔ ${model.stops.get(main.stops[main.stops.length - 1])?.name || "?"}` : "no trips";
    const days = DAY_TYPES.map(([label, dows]) => {
      const date = dows.map((d) => model.representative[d]).find(Boolean);
      if (!date) return `${label} -`;
      const s = routeStats(model, r.id, date);
      if (!s.trips) return `${label} none`;
      const d0 = Object.values(s.directions)[0];
      return label === "weekday" ? `${s.trips} ${d0?.first?.slice(0, 5) || "?"}–${d0?.last?.slice(0, 5) || "?"}, am ${d0?.headways?.am_peak ?? "-"} min` : `${s.trips}`;
    });
    lines.push(`${r.id} | ${r.short_name} | ${clip(r.long_name, 60)} | ${r.mode} | ${termini} | ${r.patterns.length} | ${days.join(" | ")}`);
  }
  if (routes.length > MAX_OVERVIEW_ROUTES) lines.push(`… and ${routes.length - MAX_OVERVIEW_ROUTES} more lines: use lookup.`);
  return lines.join("\n");
};

// ── An operation a model sends ──────────────────────────────────────────────

// Only what the model may say about its source: the words it cites and where they come from. The check's verdict
// (verified, verify_reason) is written by verifyOperations; an author is the client's record (an operation the user
// wrote is never gated at commit, so the model could otherwise exempt its own words with it).
const MODEL_SOURCE_KEYS = ["quote", "page", "document", "generated_by", "objective"];
const modelOperation = (op) => (op && typeof op === "object" && op.source && typeof op.source === "object" ? { ...op, source: Object.fromEntries(Object.entries(op.source).filter(([k]) => MODEL_SOURCE_KEYS.includes(k))) } : op);

// ── A preview, as the model reads it ────────────────────────────────────────

const summarizePreview = (p) => {
  const out = [];
  out.push(`Preview: ${p.steps.filter((s) => s.status === "applied").length} applied, ${p.steps.filter((s) => s.status === "blocked").length} blocked, ${p.steps.filter((s) => s.status === "failed").length} failed, ${p.steps.filter((s) => s.status === "skipped").length} skipped.`);
  for (const s of p.steps) {
    let line = `- ${s.id} ${s.type}: ${s.status}`;
    if (s.summary) line += ` — ${s.summary}`;
    if (s.error) line += ` — ERROR: ${s.error}`;
    // A step after a blocked step of its line: its questions read a feed that step has not changed yet — asked once
    // that step is answered, never answered now.
    if (Array.isArray(s.waiting_for) && s.waiting_for.length) {
      line += ` — waits for ${s.waiting_for.join(", ")}: its questions come once that step is answered (answer none of them now)`;
      out.push(line);
      continue;
    }
    for (const a of s.ambiguities || []) line += `\n    ? ${a.param}: [${a.code}] ${a.message}${a.options ? ` options: ${a.options.slice(0, 8).join(" | ")}` : ""}`;
    for (const w of (s.warnings || []).slice(0, 4)) line += `\n    ! ${clip(w, 200)}`;
    out.push(line);
  }
  const unverified = p.steps.filter((s) => s.quote_verified === false);
  if (unverified.length) out.push(`Quotes not verified against the brief: ${unverified.map((s) => `${s.id} (${s.quote_reason})`).join(", ")}${unverified.some((s) => s.quote_reason === "pdf") ? " — from a PDF the server cannot read: the user sees them marked" : ""}.`);
  if (p.lines?.length) out.push(`Changes:\n${p.lines.slice(0, 40).map((l) => `  ${l}`).join("\n")}${p.lines.length > 40 ? `\n  … ${p.lines.length - 40} more` : ""}`);
  if (p.integrity?.length) out.push(`Integrity problems introduced: ${p.integrity.map((i) => `${i.code} ×${i.count}`).join(", ")}`);
  if (p.checks?.length) out.push(`Consumer checks made worse (Google-style): ${p.checks.map((c) => `${c.code} ${c.before} → ${c.count}${c.examples?.[0] ? ` e.g. ${JSON.stringify(c.examples[0])}` : ""}`).join("; ")}`);
  const im = p.impact;
  if (im && im.totals) out.push(`Impact (${im.window.days} running days): km ${im.totals.km.before} → ${im.totals.km.after} (${im.totals.km.pct ?? 0}%), hours ${im.totals.hours.before} → ${im.totals.hours.after}, cost ${im.totals.cost.before} → ${im.totals.cost.after} ${im.currency}, vehicles at peak ${im.totals.fleet.before} → ${im.totals.fleet.after}${im.stops.lost.length ? `; stops no longer served: ${im.stops.lost.map((s) => s.name).slice(0, 10).join(", ")}` : ""}${im.flags.filter((f) => f.code !== "stop_unserved").length ? `; major-change flags: ${im.flags.filter((f) => f.code !== "stop_unserved").map((f) => `${f.code} ${f.label || ""}`).join(", ")}` : ""}`);
  if (p.passenger?.length) out.push(`Passenger information (GTFS-RT alerts the user can publish): ${p.passenger.slice(0, 8).map((a) => `${a.effect} ${a.routes.map((r) => r.label).join("+")} ${a.period?.from || ""}${a.open_ended ? "→" : `–${a.period?.to || ""}`}`).join("; ")}${p.passenger.length > 8 ? ` … +${p.passenger.length - 8}` : ""}`);
  const res = p.conformance?.after?.results || [];
  if (res.length) out.push(`Clauses after the plan: ${res.map((r) => `${r.id} ${r.status}${r.status === "unknown" ? ` (${r.note || "not measurable"})` : r.status !== "pass" ? ` (expected ${r.expected}, measured ${r.measured})` : ""}`).join("; ")}`);
  const g = p.gate;
  if (g?.blocking?.length) out.push(`The commit is blocked: ${g.blocking.map((b) => b.code).join(", ")}.`);
  if (g?.acknowledgeable?.length) out.push(`The commit asks a named person to acknowledge: ${g.acknowledgeable.map((a) => a.code).join(", ")}.`);
  return out.join("\n");
};

module.exports = { feedOverview, summarizePreview, modelOperation, DAY_TYPES, MODEL_SOURCE_KEYS, MAX_OVERVIEW_ROUTES };
