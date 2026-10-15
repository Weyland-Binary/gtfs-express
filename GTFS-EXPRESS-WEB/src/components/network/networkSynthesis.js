/**
 * networkSynthesis — the steering-committee note of a network built in the
 * Network Studio: one printable HTML page (open it, print to PDF) from the
 * build report, saying what the network is and on what it rests:
 *
 *   • the network: lines, stops, trips, the territory it serves;
 *   • the brief: operator, area, each requirement and its verdict on the
 *     timetable actually built (mandatory ones first), the assumptions;
 *   • the quality measured on the built GTFS, and the GTFS validation;
 *   • the operations estimate: vehicles at peak and with the reserve,
 *     vehicle-km and cost a year with their basis, the contract volume;
 *   • the dated calendars (school periods) and where their dates come from;
 *   • the coherence report, when the caller has it: the
 *     anomalies first, then each line by direction and day type — read from
 *     the built feed (or the design's dry run) by the server;
 *   • the data sources that answered.
 *
 * Pure: buildNetworkSynthesisHtml({ report, coherence, t, language, now })
 * returns the page; downloadNetworkSynthesis(...) saves it.
 */

import { coherenceNoteHtml } from "../../utils/coherenceApi";

const esc = (v) =>
  String(v ?? "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
const num = (v, language) => (Number.isFinite(Number(v)) ? Math.round(Number(v)).toLocaleString(language || undefined) : "—");
const ymd = (s) => (/^\d{8}$/.test(String(s || "")) ? `${String(s).slice(6, 8)}/${String(s).slice(4, 6)}/${String(s).slice(0, 4)}` : String(s || ""));

const STYLE = `
  body { font: 14px/1.5 -apple-system, "Segoe UI", Roboto, Helvetica, Arial, sans-serif; color: #1f2937; max-width: 860px; margin: 32px auto; padding: 0 24px; }
  h1 { font-size: 22px; margin: 0 0 4px; } h2 { font-size: 16px; margin: 28px 0 8px; padding-bottom: 4px; border-bottom: 1px solid #e5e7eb; }
  .meta, .note { color: #6b7280; font-size: 12px; } table { width: 100%; border-collapse: collapse; margin: 6px 0; font-size: 13px; }
  th, td { text-align: left; padding: 6px 8px; border-bottom: 1px solid #f0f0f0; vertical-align: top; } th { color: #6b7280; font-weight: 600; }
  .num { text-align: right; font-variant-numeric: tabular-nums; white-space: nowrap; }
  .pass { color: #15803d; font-weight: 700; } .fail { color: #b91c1c; font-weight: 700; } .unknown, .waived { color: #6b7280; font-weight: 700; }
  .box { padding: 10px 12px; border-radius: 10px; background: #f9fafb; margin: 8px 0; }
  @media print { body { margin: 0; } h2 { break-after: avoid; } tr { break-inside: avoid; } }
`;

export const buildNetworkSynthesisHtml = ({ report, coherence = null, t, language = "en", now = new Date() }) => {
  const counts = report?.counts || {};
  const req = report?.requirements || null;
  const conformance = report?.live?.conformance || report?.conformance || null;
  const results = [...(conformance?.results || [])].sort((a, b) => (a.level === "must" ? 0 : 1) - (b.level === "must" ? 0 : 1));
  const built = report?.built && !report.built.error && report.built.score != null ? report.built : null;
  const ops = report?.design?.operations || null;
  const v = report?.validation || null;
  const place = report?.territory?.place || req?.area || "";
  const out = [];
  out.push(`<!doctype html><html lang="${esc(String(language).slice(0, 2))}"><head><meta charset="utf-8"><title>${esc(t("network.synthesis.title"))}${place ? ` — ${esc(place)}` : ""}</title><style>${STYLE}</style></head><body>`);
  out.push(`<h1>${esc(t("network.synthesis.title"))}${place ? ` — ${esc(place)}` : ""}</h1><div class="meta">${esc(t("network.synthesis.subtitle", { date: now.toLocaleDateString(language || undefined) }))}</div>`);
  out.push(`<div class="box">${esc(t("network.synthesis.counts", { routes: counts.routes ?? 0, stops: counts.stops ?? 0, trips: counts.trips ?? 0 }))}${report?.territory?.population ? ` · ${esc(t("network.synthesis.population", { population: num(report.territory.population, language) }))}` : ""}</div>`);

  if (req || results.length) {
    out.push(`<h2>${esc(t("network.synthesis.brief"))}</h2>`);
    if (req) out.push(`<p>${esc(t("report.requirements", { operator: req.operator || "—", area: req.area || "—" }))}</p>`);
    if (results.length) {
      const pass = results.filter((r) => r.level === "must" && r.status === "pass").length;
      const must = results.filter((r) => r.level === "must" && r.status !== "waived").length;
      out.push(`<p><strong>${esc(t("network.synthesis.mustMet", { pass, total: must }))}</strong></p><table><tr><th>${esc(t("transform.synthesis.requirement"))}</th><th>${esc(t("network.synthesis.verdict"))}</th></tr>`);
      for (const r of results) {
        const measured = r.status !== "pass" && r.measured != null ? ` <span class="note">(${esc(r.measured)})</span>` : "";
        out.push(`<tr><td>${r.level === "must" ? `<strong>${esc(t("transform.synthesis.must"))}</strong> ` : ""}${esc(r.text || r.kind)}${measured}</td><td class="${esc(r.status)}">${esc(t(`transform.synthesis.clause.${r.status}`))}</td></tr>`);
      }
      out.push("</table>");
    }
    const assumptions = req?.assumptions || [];
    if (assumptions.length) {
      out.push(`<h2>${esc(t("transform.synthesis.assumptions"))}</h2><ul>`);
      for (const a of assumptions) out.push(`<li>${esc(a.text || a.topic || a)}${a.confidence ? ` <span class="note">(${esc(t(`transform.synthesis.confidence.${a.confidence}`))})</span>` : ""}</li>`);
      out.push("</ul>");
    }
  }

  out.push(`<h2>${esc(t("network.synthesis.quality"))}</h2>`);
  if (built) out.push(`<p>${esc(`${built.grade ?? ""} ${Math.round(built.score)}`)} <span class="note">${esc(t("network.synthesis.qualityBasis"))}</span></p>`);
  if (v) out.push(`<p>${esc(v.errors ? t("report.validation.errors", { errors: v.errors, warnings: v.warnings }) : t("report.validation.ok", { warnings: v.warnings ?? 0 }))}</p>`);

  if (ops) {
    const cur = ops.currency || "";
    out.push(`<h2>${esc(t("network.synthesis.operations"))}</h2><table>`);
    const row = (label, value) => out.push(`<tr><td>${esc(label)}</td><td class="num">${esc(value)}</td></tr>`);
    row(t("network.synthesis.fleetPeak"), num(ops.fleet_peak ?? ops.fleet_total, language));
    if (ops.fleet_with_reserve != null) row(t("network.synthesis.fleetReserve"), num(ops.fleet_with_reserve, language));
    if (ops.veh_km_year != null) row(t("network.synthesis.vehKm"), num(ops.veh_km_year, language));
    if (ops.cost_year != null) row(t("network.synthesis.cost"), `${num(ops.cost_year, language)} ${cur}`);
    if (ops.contract?.commercial_km != null) row(t("network.synthesis.contract"), `${num(ops.contract.commercial_km, language)} → ${num(ops.contract.estimated_km, language)} (${ops.contract.gap_pct > 0 ? "+" : ""}${ops.contract.gap_pct} %)`);
    out.push("</table>");
    const defaults = ops.assumptions?.defaults || [];
    if (defaults.length) out.push(`<p class="note">${esc(t("network.synthesis.defaults", { fields: defaults.join(", ") }))}</p>`);
  }

  const calendars = report?.calendars || [];
  if (calendars.length) {
    out.push(`<h2>${esc(t("network.synthesis.calendars"))}</h2><table><tr><th></th><th>${esc(t("network.synthesis.period"))}</th><th class="num">${esc(t("network.synthesis.days"))}</th></tr>`);
    for (const c of calendars) out.push(`<tr><td>${esc(c.id)}</td><td>${esc(`${c.period || ""}${c.region ? ` (${c.region})` : ""} ${ymd(c.from)} → ${ymd(c.to)}`)}${(c.holiday_periods || []).some((h) => h.assumed) ? ` <span class="note">${esc(t("network.synthesis.summerAssumed"))}</span>` : ""}</td><td class="num">${esc(c.active_days ?? "—")}</td></tr>`);
    out.push("</table>");
  }

  if (coherence) out.push(coherenceNoteHtml(coherence, { t, language, esc }));

  const sources = report?.territory?.sources || [];
  if (sources.length) out.push(`<h2>${esc(t("report.sources"))}</h2><p class="note">${sources.map((s) => esc(`${s.name}${s.license ? ` (${s.license})` : ""}`)).join(" · ")}</p>`);
  out.push(`<p class="note">${esc(t("network.synthesis.footer"))}</p></body></html>`);
  return out.join("\n");
};

export const downloadNetworkSynthesis = (args) => {
  const html = buildNetworkSynthesisHtml(args);
  const place = String(args.report?.territory?.place || args.report?.requirements?.area || "reseau")
    .normalize("NFD")
    .replace(/[̀-ͯ]/g, "")
    .replace(/[^A-Za-z0-9]+/g, "-")
    .replace(/^-|-$/g, "")
    .slice(0, 60) || "reseau";
  const blob = new Blob([html], { type: "text/html;charset=utf-8" });
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = `note-reseau-${place}.html`;
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
};
