/**
 * Prints the validation report from the page itself, A4 portrait: a dark band naming the report, the verdict in its
 * tone, the figures, the rules in one table, then each rule with its texts and its occurrences (PRINT_ROWS_PER_RULE at
 * most, the rest counted), last the Diagnostic. The browser's print saves it as PDF; the colours are asked to print.
 * Nothing is fixed on the page: a browser lays a fixed element at the top of every page over the tables.
 */
import React from "react";
import { createRoot } from "react-dom/client";
import { flushSync } from "react-dom";
import { PRINT_CELL_CHARS, PRINT_ROWS_PER_RULE } from "./reportExport";

const ROOT_ID = "gx-validation-print";
const PRINT_FALLBACK_MS = 30_000;

const cssOf = ({ ink, rule, soft, band }) => `
@media screen { #${ROOT_ID} { position: fixed; left: -100000px; top: 0; width: 188mm; } }
@media print {
  @page { size: A4 portrait; margin: 12mm 11mm 14mm; }
  body > *:not(#${ROOT_ID}) { display: none !important; }
  #${ROOT_ID} { display: block; }
}
#${ROOT_ID} { font: 8.8pt/1.4 Inter, "Segoe UI", Arial, sans-serif; color: ${ink}; print-color-adjust: exact; -webkit-print-color-adjust: exact; }
#${ROOT_ID} .band { background: ${band}; color: #fff; border-radius: 2.5mm; padding: 5mm 6mm; margin-bottom: 4mm; break-inside: avoid; }
#${ROOT_ID} .band .kicker { font-size: 8pt; letter-spacing: 0.08em; text-transform: uppercase; opacity: 0.75; margin: 0 0 1mm; }
#${ROOT_ID} .band h1 { font-size: 17pt; letter-spacing: -0.01em; margin: 0; line-height: 1.2; }
#${ROOT_ID} .band .sub { margin: 1.5mm 0 0; opacity: 0.8; }
#${ROOT_ID} .verdict { display: flex; align-items: center; gap: 4mm; margin: 0 0 4mm; padding: 3.5mm 4mm; border-radius: 2.5mm; break-inside: avoid; }
#${ROOT_ID} .verdict .mark { width: 9mm; height: 9mm; border-radius: 50%; color: #fff; font-weight: 800; font-size: 13pt; display: flex; align-items: center; justify-content: center; flex-shrink: 0; }
#${ROOT_ID} .verdict b { font-size: 12.5pt; display: block; }
#${ROOT_ID} .verdict span { display: block; margin-top: 0.8mm; }
#${ROOT_ID} .kpis { display: grid; grid-template-columns: repeat(3, 1fr); gap: 3mm; margin-bottom: 2mm; }
#${ROOT_ID} .kpi { border-radius: 2mm; padding: 2.5mm 3mm; border-left: 1.4mm solid; }
#${ROOT_ID} .kpi b { display: block; font-size: 15pt; font-variant-numeric: tabular-nums; line-height: 1.1; }
#${ROOT_ID} .kpi span { color: ${soft}; }
#${ROOT_ID} h2 { font-size: 11.5pt; margin: 7mm 0 2.5mm; padding-bottom: 1mm; border-bottom: 0.5mm solid ${ink}; break-after: avoid; }
#${ROOT_ID} table { width: 100%; border-collapse: collapse; }
#${ROOT_ID} thead { display: table-header-group; }
#${ROOT_ID} th { text-align: left; font-weight: 700; font-size: 8pt; color: ${soft}; text-transform: uppercase; letter-spacing: 0.04em; border-bottom: 0.3mm solid ${ink}; padding: 1.2mm 1.6mm; vertical-align: bottom; }
#${ROOT_ID} td { border-bottom: 0.2mm solid ${rule}; padding: 1.1mm 1.6mm; vertical-align: top; overflow-wrap: anywhere; }
#${ROOT_ID} table.wide { font-size: 7.4pt; }
#${ROOT_ID} table.wide th { font-size: 7pt; letter-spacing: 0.02em; overflow-wrap: anywhere; }
#${ROOT_ID} table.wide td.mono { font-size: 7.2pt; }
#${ROOT_ID} tbody tr:nth-child(even) td { background: #f6f8fa; }
#${ROOT_ID} tr { break-inside: avoid; }
#${ROOT_ID} .n { text-align: right; font-variant-numeric: tabular-nums; white-space: nowrap; }
#${ROOT_ID} .mono { font-family: "JetBrains Mono", "Fira Code", Consolas, monospace; font-size: 7.8pt; color: ${soft}; }
#${ROOT_ID} td.mono { color: ${ink}; }
#${ROOT_ID} .sev { display: inline-block; padding: 0.4mm 2mm; border-radius: 99mm; font-size: 7.5pt; font-weight: 700; color: #fff; white-space: nowrap; letter-spacing: 0.02em; }
#${ROOT_ID} .rule { margin-top: 4.5mm; padding-left: 3.5mm; border-left: 1mm solid ${rule}; }
#${ROOT_ID} .rule header { display: flex; align-items: baseline; gap: 2.5mm; flex-wrap: wrap; break-after: avoid; }
#${ROOT_ID} .rule h3 { font-size: 10.5pt; margin: 0; }
#${ROOT_ID} .rule .meta { color: ${soft}; font-variant-numeric: tabular-nums; }
#${ROOT_ID} .rule p { margin: 1.2mm 0; max-width: 170mm; }
#${ROOT_ID} .rule .note { color: ${soft}; font-style: italic; }
#${ROOT_ID} .rule table { margin-top: 1.5mm; }
#${ROOT_ID} .more { color: ${soft}; padding: 1mm 1.6mm; font-style: italic; }
#${ROOT_ID} .sample b { font-weight: 600; }
#${ROOT_ID} .foot { display: flex; justify-content: space-between; gap: 4mm; margin-top: 8mm; padding-top: 1.5mm; border-top: 0.2mm solid ${rule}; color: ${soft}; font-size: 7.3pt; }
`;

const clip = (s) => (String(s).length > PRINT_CELL_CHARS ? `${String(s).slice(0, PRINT_CELL_CHARS - 1)}…` : s);
// A pale shade of a tone, for the grounds the colour fills.
const pale = (hex, alpha = 0.1) => {
  const m = /^#?([0-9a-f]{2})([0-9a-f]{2})([0-9a-f]{2})$/i.exec(String(hex).trim());
  return m ? `rgba(${parseInt(m[1], 16)}, ${parseInt(m[2], 16)}, ${parseInt(m[3], 16)}, ${alpha})` : "transparent";
};

function Severity({ label, tone }) {
  return (
    <span className="sev" style={{ background: tone }}>
      {label}
    </span>
  );
}

function ReportPrint({ model, labels, colors }) {
  const tone = (sev) => colors.tones[sev] || colors.tones.info;
  const verdictTone = model.errors ? colors.tones.error : colors.ok;
  return (
    <>
      <div className="band">
        <p className="kicker">GTFS Express</p>
        <h1>{model.network ? `${model.title} · ${model.network}` : model.title}</h1>
        <p className="sub">
          {model.generated} · {model.engine}
        </p>
      </div>
      <div className="verdict" style={{ background: pale(verdictTone, 0.1), border: `0.3mm solid ${pale(verdictTone, 0.35)}` }}>
        <div className="mark" style={{ background: verdictTone }}>
          {model.errors ? "!" : "✓"}
        </div>
        <div>
          <b style={{ color: verdictTone }}>{model.verdict}</b>
          {model.notices.map((n, i) => (
            <span key={i}>{n}</span>
          ))}
        </div>
      </div>
      <div className="kpis">
        {model.counts.map((c) => {
          const t = c.count ? tone(c.key) : colors.ok;
          return (
            <div className="kpi" key={c.key} style={{ borderLeftColor: t, background: pale(t, 0.07) }}>
              <b style={{ color: t }}>{c.count.toLocaleString()}</b>
              <span>
                {c.label} · {c.rules ? labels.rules(c.rules) : labels.none}
              </span>
            </div>
          );
        })}
      </div>

      {model.rules.length > 0 && (
        <>
          <h2>{labels.summary}</h2>
          <table>
            <thead>
              <tr>
                <th>{labels.col.severity}</th>
                <th>{labels.col.rule}</th>
                <th className="n">{labels.col.count}</th>
                <th>{labels.col.files}</th>
              </tr>
            </thead>
            <tbody>
              {model.rules.map((r, i) => (
                <tr key={`${r.code}-${i}`}>
                  <td>
                    <Severity label={r.severityLabel} tone={tone(r.severity)} />
                  </td>
                  <td>
                    {r.title}
                    {r.code ? <span className="mono"> · {r.code}</span> : null}
                  </td>
                  <td className="n">{r.count.toLocaleString()}</td>
                  <td className="mono">{r.files.join(", ")}</td>
                </tr>
              ))}
            </tbody>
          </table>
          <h2>{labels.details}</h2>
          {model.rules.map((r, i) => {
            const shown = r.rows.slice(0, PRINT_ROWS_PER_RULE);
            const left = r.rows.length - shown.length + r.notSampled;
            return (
              <section className="rule" key={`${r.code}-${i}`} style={{ borderLeftColor: tone(r.severity) }}>
                <header>
                  <Severity label={r.severityLabel} tone={tone(r.severity)} />
                  <h3>{r.title}</h3>
                  {r.code ? <span className="mono">{r.code}</span> : null}
                  <span className="meta">{labels.occurrences(r.count)}</span>
                </header>
                {r.description ? <p>{r.description}</p> : null}
                {r.note ? <p className="note">{r.note}</p> : null}
                {shown.length > 0 && (
                  <table className={r.columns.length > 5 ? "wide" : undefined}>
                    <thead>
                      <tr>{r.messageOnly ? <th>{labels.col.message}</th> : r.columns.map((c) => <th key={c.key}>{c.label}</th>)}</tr>
                    </thead>
                    <tbody>
                      {shown.map((row, k) => (
                        <tr key={k}>
                          {row.map((v, j) => (
                            <td key={j} className="mono">
                              {clip(v)}
                            </td>
                          ))}
                        </tr>
                      ))}
                    </tbody>
                  </table>
                )}
                {left > 0 && <div className="more">{labels.more(left)}</div>}
              </section>
            );
          })}
        </>
      )}

      {model.audit && model.audit.length > 0 && (
        <>
          <h2>{labels.audit}</h2>
          <p className="mono">{labels.auditBy}</p>
          {model.audit.map((f) => (
            <section className="rule" key={f.code} style={{ borderLeftColor: tone(f.severity) }}>
              <header>
                <Severity label={f.severityLabel} tone={tone(f.severity)} />
                <h3>{f.title}</h3>
                <span className="meta">{f.countText}</span>
              </header>
              <p>{f.body}</p>
              {f.samples.length > 0 && (
                <table>
                  <tbody>
                    {f.samples.map((s, k) => (
                      <tr key={k} className="sample">
                        <td>
                          <b>{clip(s.label)}</b>
                        </td>
                        <td>{clip(s.detail)}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              )}
            </section>
          ))}
        </>
      )}
      <div className="foot">
        <span>{model.network ? `${model.title} · ${model.network}` : model.title}</span>
        <span>{labels.foot}</span>
      </div>
    </>
  );
}

/** Resolves once the print dialog closed. */
export default async function printReport({ model, labels, colors }) {
  document.getElementById(ROOT_ID)?.remove();
  const host = document.createElement("div");
  host.id = ROOT_ID;
  const style = document.createElement("style");
  style.textContent = cssOf(colors);
  host.appendChild(style);
  const mount = document.createElement("div");
  host.appendChild(mount);
  document.body.appendChild(host);
  const root = createRoot(mount);
  flushSync(() => root.render(<ReportPrint model={model} labels={labels} colors={colors} />));
  await new Promise((resolve) => requestAnimationFrame(() => resolve()));
  await new Promise((resolve) => {
    const media = typeof window.matchMedia === "function" ? window.matchMedia("print") : null;
    let timer = null;
    const onMedia = (e) => {
      if (!e.matches) done();
    };
    const done = () => {
      window.removeEventListener("afterprint", done);
      media?.removeEventListener?.("change", onMedia);
      clearTimeout(timer);
      resolve();
    };
    window.addEventListener("afterprint", done);
    media?.addEventListener?.("change", onMedia);
    window.print();
    timer = setTimeout(done, PRINT_FALLBACK_MS);
  });
  root.unmount();
  host.remove();
}
