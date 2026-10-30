/**
 * The one way to count a validation report's findings, so every screen shows the same numbers:
 * - a finding weighs 1, an aggregate tail marker its `aggregateCount` (the occurrences it stands for);
 * - findings `resolvedByImport` are not outstanding and are counted apart;
 * - the report is keyed by file name, each entry carrying its own `ruleCode`: never read the key as a rule.
 * `validated` is false without a report or with an `unverified` one (no validator, no verdict), so a
 * screen says "not validated yet" rather than "conformant".
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

export function topRules(summary, severity, n = 4) {
  return summary.byRule.filter((r) => r.severity === severity).slice(0, n);
}
