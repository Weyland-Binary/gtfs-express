/**
 * The steering-committee note of a change plan: one printable HTML page built from the simulation itself, saying only
 * what is true, in the reader's language. An applied version's note is the version's own (applied as vN, by whom,
 * accepted under which name, the validator's answer recorded at its application), never a simulation's gate.
 * `noteSummaryOf` keeps what the page reads of a simulation, small enough to live with the applied scenario, so the
 * note is written again after a reload with no new simulation (a frozen scenario is never simulated again).
 */

import { coherenceNoteHtml } from "../../utils/coherenceApi";
import { estimatedTrips } from "../../utils/ridership";

const esc = (v) =>
  String(v ?? "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");

const num = (v, language, digits = 0) => (Number.isFinite(Number(v)) ? Number(v).toLocaleString(language || undefined, { maximumFractionDigits: digits }) : "—");
const signed = (v, language) => (Number.isFinite(Number(v)) ? `${Number(v) > 0 ? "+" : Number(v) < 0 ? "−" : "±"}${Math.abs(Math.round(Number(v))).toLocaleString(language || undefined)}` : "—");
const ymd = (s) => (/^\d{8}$/.test(String(s || "")) ? `${String(s).slice(6, 8)}/${String(s).slice(4, 6)}/${String(s).slice(0, 4)}` : String(s || ""));
// A count a record holds, or null (never 0 for a missing figure: Number(null) is 0).
const countOf = (v) => (typeof v === "number" ? (Number.isFinite(v) ? v : null) : typeof v === "string" && v.trim() !== "" && Number.isFinite(Number(v)) ? Number(v) : null);

/**
 * What the note says of an applied version, from its own record: the validator's answer at its application (the
 * server's proof first, else the commit's answer) and the name under which what stayed open was accepted.
 */
export const appliedNoteOf = (version, acknowledgements = []) => {
  const n = Number(version?.n);
  if (!version || version.n == null || !Number.isInteger(n)) return null;
  const record = version.proof?.validator || version.validation || null;
  const ack = version.acknowledgement_id ? (Array.isArray(acknowledgements) ? acknowledgements : []).find((a) => a && a.id === version.acknowledgement_id) || null : null;
  return {
    n,
    at: version.at || null,
    by: version.by || null,
    validator: record ? { errors: countOf(record.errors), warnings: countOf(record.warnings) } : null,
    accepted_by: version.acknowledgement_id ? ack?.by?.name || version.by || null : null,
  };
};

const STYLE = `
  body { font: 14px/1.5 -apple-system, "Segoe UI", Roboto, Helvetica, Arial, sans-serif; color: #1f2937; max-width: 860px; margin: 32px auto; padding: 0 24px; }
  h1 { font-size: 22px; margin: 0 0 4px; } h2 { font-size: 16px; margin: 28px 0 8px; padding-bottom: 4px; border-bottom: 1px solid #e5e7eb; }
  .meta { color: #6b7280; font-size: 12px; } table { width: 100%; border-collapse: collapse; margin: 6px 0; font-size: 13px; }
  th, td { text-align: left; padding: 6px 8px; border-bottom: 1px solid #f0f0f0; vertical-align: top; } th { color: #6b7280; font-weight: 600; }
  .num { text-align: right; font-variant-numeric: tabular-nums; white-space: nowrap; }
  .pass { color: #15803d; font-weight: 700; } .fail { color: #b91c1c; font-weight: 700; } .unknown, .waived { color: #6b7280; font-weight: 700; }
  .quote { color: #374151; font-style: italic; } .note { color: #6b7280; font-size: 12px; } .warn { color: #b45309; }
  .box { padding: 10px 12px; border-radius: 10px; background: #f9fafb; margin: 8px 0; }
  @media print { body { margin: 0; } h2 { break-after: avoid; } tr { break-inside: avoid; } }
`;

/** The note as a complete HTML document. */
export const buildSynthesisHtml = ({ plan = null, preview, demand = null, coherence = null, applied = null, t, language = "en", now = new Date() }) => {
  const tt = (key, params) => t(key, params);
  const title = plan?.title || preview?.title || tt("transform.synthesis.untitled");
  const steps = preview?.steps || [];
  const results = preview?.conformance?.after?.results || [];
  const before = new Map((preview?.conformance?.before?.results || []).map((r) => [r.id, r]));
  const impact = preview?.impact && !preview.impact.error ? preview.impact : null;
  const quality = preview?.quality && !preview.quality.error ? preview.quality.score : null;
  const gate = preview?.gate || null;
  const day = (v) => {
    const d = v ? new Date(v) : null;
    return d && !Number.isNaN(d.getTime()) ? d.toLocaleDateString(language || undefined) : null;
  };
  const today = now.toLocaleDateString(language || undefined);
  // The columns the measures are read in: today and with the plan — or, the plan applied, before the change and in vN.
  const beforeLabel = applied ? tt("transform.synthesis.beforeApplied") : tt("transform.synthesis.before");
  const afterLabel = applied ? tt("transform.synthesis.afterApplied", { n: applied.n }) : tt("transform.synthesis.after");
  const out = [];
  out.push(`<!doctype html><html lang="${esc(String(language).slice(0, 2))}"><head><meta charset="utf-8"><title>${esc(tt("transform.synthesis.title"))} — ${esc(title)}</title><style>${STYLE}</style></head><body>`);
  out.push(`<h1>${esc(title)}</h1><div class="meta">${esc(applied ? tt("transform.synthesis.subtitle.applied", { n: applied.n, date: day(applied.at) || today }) : tt("transform.synthesis.subtitle", { date: today }))}</div>`);

  // Where it stands: a simulation says what holds the application; an applied version, what it is and who accepted
  // what stayed open (a must clause failing is applied only once a named person accepted it).
  const stuck = steps.filter((s) => s.status === "blocked" || s.status === "failed").length;
  // The plan's mandatory requirements not met (a desired clause is none of them).
  const failingMust = results.filter((r) => r && r.level === "must" && r.status === "fail").length;
  const failing = failingMust ? tt("transform.synthesis.verdict.failing", { count: failingMust }) : null;
  const verdict = applied
    ? [failing || tt("transform.synthesis.verdict.applied", { n: applied.n }), applied.accepted_by ? tt("transform.synthesis.verdict.accepted", { name: applied.accepted_by }) : null].filter(Boolean).join(" ")
    : stuck
      ? tt("transform.synthesis.verdict.blocked", { count: stuck })
      : failing || (gate?.can_commit ? tt("transform.synthesis.verdict.ready") : tt("transform.synthesis.verdict.review"));
  out.push(`<div class="box"><strong>${esc(verdict)}</strong></div>`);

  out.push(`<h2>${esc(tt("transform.synthesis.plan"))}</h2><table><tr><th>#</th><th>${esc(tt("transform.synthesis.step"))}</th><th>${esc(tt("transform.synthesis.source"))}</th></tr>`);
  steps.forEach((s, i) => {
    const op = (plan?.operations || []).find((o) => o.id === s.id) || null;
    const quote = s.source?.quote || op?.source?.quote || null;
    const generated = (s.source?.generated_by || op?.source?.generated_by) === "optimizer";
    const verified = s.quote_verified === true ? ` <span class="pass">✓</span>` : s.quote_verified === false ? ` <span class="fail">${esc(tt("transform.synthesis.quoteNotFound"))}</span>` : "";
    const status = s.status === "applied" ? "" : ` <span class="${s.status === "skipped" ? "unknown" : "fail"}">(${esc(tt(`transform.synthesis.status.${s.status}`))})</span>`;
    out.push(`<tr><td>${i + 1}</td><td>${esc(s.summary || s.type)}${status}</td><td>${generated ? `<span class="note">${esc(tt("transform.synthesis.generated"))}</span>` : quote ? `<span class="quote">« ${esc(quote)} »</span>${verified}` : "—"}</td></tr>`);
  });
  if (!steps.length) out.push(`<tr><td colspan="3" class="note">${esc(tt("transform.synthesis.noSteps"))}</td></tr>`);
  out.push("</table>");

  if (results.length) {
    const ordered = [...results].sort((a, b) => (a.level === "must" ? 0 : 1) - (b.level === "must" ? 0 : 1));
    out.push(`<h2>${esc(tt("transform.synthesis.requirements"))}</h2><table><tr><th>${esc(tt("transform.synthesis.requirement"))}</th><th>${esc(beforeLabel)}</th><th>${esc(afterLabel)}</th></tr>`);
    for (const r of ordered) {
      const b = before.get(r.id);
      // Its words and its status in the reader's language; what the engine measured, in its own terms, is a detail
      // opened on demand (never the text of a French note).
      const measured = r.status !== "pass" && r.measured != null && r.measured !== "" ? `<details class="note"><summary>${esc(tt("ack.clause.measure"))}</summary><span lang="en">${esc(r.measured)}</span></details>` : "";
      out.push(`<tr><td>${r.level === "must" ? `<strong>${esc(tt("transform.synthesis.must"))}</strong> ` : ""}${esc(r.text || r.kind)}${measured}</td><td class="${esc(b?.status || "unknown")}">${esc(b ? tt(`transform.synthesis.clause.${b.status}`) : "—")}</td><td class="${esc(r.status)}">${esc(tt(`transform.synthesis.clause.${r.status}`))}</td></tr>`);
    }
    out.push("</table>");
  }

  if (impact) {
    const rows = [
      ["km", impact.totals?.km, ""],
      ["hours", impact.totals?.hours, ""],
      ["cost", impact.totals?.cost, impact.currency || ""],
      ["fleet", impact.totals?.fleet, ""],
    ].filter(([, x]) => x);
    out.push(`<h2>${esc(tt("transform.synthesis.impact"))}</h2><div class="note">${esc(tt("transform.synthesis.window", { from: ymd(impact.window?.from), to: ymd(impact.window?.to), days: impact.window?.days ?? "—" }))}</div>`);
    out.push(`<table><tr><th></th><th class="num">${esc(beforeLabel)}</th><th class="num">${esc(afterLabel)}</th><th class="num">${esc(tt("transform.synthesis.change"))}</th></tr>`);
    for (const [k, x, unit] of rows) out.push(`<tr><td>${esc(tt(`transform.impact.${k}`))}</td><td class="num">${esc(num(x.before, language))}${unit ? ` ${esc(unit)}` : ""}</td><td class="num">${esc(num(x.after, language))}${unit ? ` ${esc(unit)}` : ""}</td><td class="num">${esc(signed(x.delta, language))}${x.pct != null && x.delta ? ` (${x.pct > 0 ? "+" : ""}${esc(x.pct)} %)` : ""}</td></tr>`);
    out.push("</table>");
    const lost = impact.stops?.lost || [];
    if (lost.length) out.push(`<p class="warn">${esc(tt("transform.impact.lost", { count: lost.length, stops: lost.slice(0, 12).map((s) => s.name).join(", ") }))}</p>`);
    if (impact.assumptions?.cost_per_km != null) out.push(`<p class="note">${esc(tt("transform.impact.costBasis", { perKm: impact.assumptions.cost_per_km, currency: impact.currency || "" }))}</p>`);
  }

  if (coherence) out.push(coherenceNoteHtml(coherence, { t, language, esc }));

  if (quality && quality.before != null) out.push(`<h2>${esc(tt("transform.synthesis.quality"))}</h2><p>${esc(`${quality.grade_before ?? ""} ${Math.round(quality.before)} → ${quality.grade_after ?? ""} ${Math.round(quality.after)}`)}</p>`);

  // Ridership, estimated: an estimate of no trip at all is none (utils/ridership), never « ≈ 0 » in the note.
  const dBefore = estimatedTrips(demand?.before?.estimate) != null ? demand.before.estimate : null;
  const dAfter = estimatedTrips(demand?.after?.estimate) != null ? demand.after.estimate : null;
  if (dBefore || dAfter) {
    const trust = (e) => (e?.calibrated ? tt("transform.synthesis.calibrated", { uncertainty: e.uncertainty || "" }) : tt("transform.synthesis.uncalibrated", { uncertainty: e?.uncertainty || "±50 %" }));
    out.push(`<h2>${esc(tt("transform.synthesis.ridership"))}</h2><table><tr><th></th><th class="num">${esc(tt("transform.synthesis.tripsDay"))}</th></tr>`);
    if (dBefore) out.push(`<tr><td>${esc(tt("transform.synthesis.today"))}</td><td class="num">≈ ${esc(num(dBefore.total_boardings_day, language))}</td></tr>`);
    if (dAfter) out.push(`<tr><td>${esc(tt("transform.synthesis.withPlan"))}</td><td class="num">≈ ${esc(num(dAfter.total_boardings_day, language))}</td></tr>`);
    out.push(`</table><p class="note">${esc(trust(dAfter || dBefore))} ${esc(tt("transform.synthesis.estimateNote"))}</p>`);
  }

  // The validator: an applied version's own answer — the commit runs the canonical validator on the very feed it
  // leaves, and nothing is applied with a new error — else the gate of this simulation.
  if (applied) {
    const v = applied.validator;
    const counted = v && v.errors !== null && v.warnings !== null;
    const line = counted ? tt(v.errors > 0 ? "transform.synthesis.validator.appliedBaseline" : "transform.synthesis.validator.applied", { n: applied.n, errors: num(v.errors, language), warnings: num(v.warnings, language) }) : tt("recap.validator.applied");
    out.push(`<h2>${esc(tt("transform.synthesis.validation"))}</h2><p>${esc(line)}</p>`);
  } else {
    const validation = gate?.validation || (preview?.validation?.error ? "unavailable" : null);
    if (validation) out.push(`<h2>${esc(tt("transform.synthesis.validation"))}</h2><p>${esc(tt(`transform.synthesis.validator.${validation}`))}</p>`);
  }
  out.push(`<p class="note">${esc(applied ? tt("transform.synthesis.footer.applied", { n: applied.n }) : tt("transform.synthesis.footer"))}</p></body></html>`);
  return out.join("\n");
};

const TOTALS = ["km", "hours", "cost", "fleet"];
const resultOf = (r) => ({ id: r?.id ?? null, level: r?.level ?? null, status: r?.status ?? null, text: r?.text ?? null, kind: r?.kind ?? null, measured: r?.measured ?? null });
const totalOf = (x) => (x && typeof x === "object" ? { before: x.before ?? null, after: x.after ?? null, delta: x.delta ?? null, pct: x.pct ?? null } : null);

/**
 * What buildSynthesisHtml reads of a simulation, and nothing else (never its tables): the steps, the plan's
 * requirements before → after, the impact, the quality, the validator's verdict. Bounded; null without one.
 */
export const noteSummaryOf = (preview) => {
  if (!preview || typeof preview !== "object") return null;
  const impact = preview.impact && !preview.impact.error ? preview.impact : null;
  const score = preview.quality && !preview.quality.error ? preview.quality.score : null;
  return {
    title: preview.title || null,
    steps: (preview.steps || []).slice(0, 200).map((s) => ({ id: s.id ?? null, type: s.type ?? null, status: s.status ?? null, summary: s.summary ?? null, quote_verified: s.quote_verified ?? null, source: s.source ? { quote: s.source.quote || null, generated_by: s.source.generated_by || null } : null })),
    conformance: { before: { results: (preview.conformance?.before?.results || []).slice(0, 200).map(resultOf) }, after: { results: (preview.conformance?.after?.results || []).slice(0, 200).map(resultOf) } },
    impact: impact
      ? { window: impact.window || null, currency: impact.currency || null, totals: Object.fromEntries(TOTALS.map((k) => [k, totalOf(impact.totals?.[k])])), stops: { lost: (impact.stops?.lost || []).slice(0, 50).map((x) => ({ name: x?.name ?? "" })) }, assumptions: { cost_per_km: impact.assumptions?.cost_per_km ?? null } }
      : null,
    quality: score ? { score: { before: score.before ?? null, after: score.after ?? null, grade_before: score.grade_before ?? null, grade_after: score.grade_after ?? null } } : null,
    gate: preview.gate ? { can_commit: Boolean(preview.gate.can_commit), validation: preview.gate.validation || null } : null,
    validation: preview.validation?.error ? { error: true } : null,
  };
};

/** Save the note as an .html file (the browser prints it to PDF). */
export const downloadSynthesis = (args) => {
  const html = buildSynthesisHtml(args);
  const name = String(args.plan?.title || args.preview?.title || "plan")
    .normalize("NFD")
    .replace(/[̀-ͯ]/g, "")
    .replace(/[^A-Za-z0-9]+/g, "-")
    .replace(/^-|-$/g, "")
    .slice(0, 60) || "plan";
  const blob = new Blob([html], { type: "text/html;charset=utf-8" });
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = `note-${name}.html`;
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
};
