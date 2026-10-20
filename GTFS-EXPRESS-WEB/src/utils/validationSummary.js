/**
 * validationSummary.js — the ONE way to count findings in a validation report.
 *
 * Every screen (header badge, home dashboard, validation page, rescue banner,
 * AI session context) counts through here, so the numbers agree: counting
 * list entries (an aggregate "N more not sampled" marker = 1), the engine's
 * weighted counts, or findings the tolerant import already resolved would
 * each give another figure. The semantics, once:
 *
 *   - a finding weighs 1, an aggregate tail marker weighs `aggregateCount`
 *     (the number of real occurrences it stands for);
 *   - findings flagged `resolvedByImport` are NOT outstanding work and are
 *     excluded (they are reported separately as "fixed at import");
 *   - the report is keyed by FILE NAME (`report.errors["stops.txt"]`), each
 *     entry carrying its own `ruleCode` — never treat the key as a rule.
 *
 * `validated` is false when there is no report at all (fresh project open,
 * snapshot restore, reload) or when the report is `unverified` (the server
 * has no validator: `valid: null`, no findings — no verdict), so callers can
 * say "not validated yet" instead of "conformant".
 */

const weightOf = (finding) =>
  finding && finding.aggregate
    ? Math.max(0, Number(finding.aggregateCount) || 0)
    : 1;

const severityOf = (finding) => {
  const sev = finding && finding.severity;
  if (sev === "warning" || sev === "info") return sev;
  return "error";
};

/**
 * @param {object|null} report  { errors: { [file]: finding[] }, counts?, valid? }
 * @returns {{
 *   validated: boolean,
 *   errors: number, warnings: number, infos: number, total: number,
 *   resolvedByImport: number,
 *   byRule: Array<{ code: string, severity: string, count: number }>,
 *   byFile: { [file: string]: number },
 * }}
 */
export function summarizeReport(report) {
  const summary = {
    validated: Boolean(report && !report.unverified && report.errors && typeof report.errors === "object"),
    errors: 0,
    warnings: 0,
    infos: 0,
    total: 0,
    resolvedByImport: 0,
    byRule: [],
    byFile: {},
  };
  if (!summary.validated) return summary;

  const ruleTally = new Map();
  for (const [file, findings] of Object.entries(report.errors)) {
    if (!Array.isArray(findings)) continue;
    for (const f of findings) {
      if (!f) continue;
      const w = weightOf(f);
      if (f.resolvedByImport) {
        summary.resolvedByImport += w;
        continue;
      }
      const sev = severityOf(f);
      if (sev === "error") summary.errors += w;
      else if (sev === "warning") summary.warnings += w;
      else summary.infos += w;
      summary.total += w;
      summary.byFile[file] = (summary.byFile[file] || 0) + w;
      if (f.ruleCode) {
        const key = `${f.ruleCode}::${sev}`;
        const cur = ruleTally.get(key);
        if (cur) cur.count += w;
        else ruleTally.set(key, { code: f.ruleCode, severity: sev, count: w });
      }
    }
  }
  summary.byRule = Array.from(ruleTally.values()).sort(
    (a, b) => b.count - a.count || a.code.localeCompare(b.code),
  );
  return summary;
}

/** Top-N rules of one severity, most frequent first. */
export function topRules(summary, severity, n = 4) {
  return summary.byRule.filter((r) => r.severity === severity).slice(0, n);
}
