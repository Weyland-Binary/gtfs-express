/**
 * The validation report as the page reads it: findings flattened, weighed (a sampled tail « N more » counts N, as
 * utils/validationSummary does, so every figure agrees with the header badge and the overview) and grouped by rule.
 */

export const SEVERITIES = ["error", "warning", "info"];
const SEVERITY_ORDER = { error: 0, warning: 1, info: 2 };

export const weightOf = (f) => (f.aggregate ? Math.max(0, Number(f.aggregateCount) || 0) : 1);

export const findingsOf = (occurrences) => occurrences.reduce((n, o) => n + weightOf(o), 0);

/** A rule's severity: the worst of its findings. */
export const severityOfGroup = (occurrences) =>
  occurrences.some((o) => (o.severity || "error") === "error") ? "error" : occurrences.some((o) => o.severity === "warning") ? "warning" : "info";

export function flattenErrors(groupedErrors) {
  const all = [];
  Object.entries(groupedErrors || {}).forEach(([fileName, errors]) => {
    (errors || []).forEach((err) => all.push({ ...err, fileName }));
  });
  return all;
}

/** Severity totals of the findings, and each severity's number of rules (a rule counting under its worst finding). */
export function tallyOf(findings) {
  const findingCounts = { error: 0, warning: 0, info: 0 };
  const byRule = new Map();
  for (const f of findings) {
    const sev = f.severity || "error";
    if (findingCounts[sev] !== undefined) findingCounts[sev] += weightOf(f);
    const key = f.ruleCode || "__ungrouped__";
    if (!byRule.has(key)) byRule.set(key, []);
    byRule.get(key).push(f);
  }
  const ruleCounts = { error: 0, warning: 0, info: 0 };
  for (const occurrences of byRule.values()) ruleCounts[severityOfGroup(occurrences)] += 1;
  return { findingCounts, ruleCounts };
}

/** One group a rule, the worst severity first, then the most findings. */
export function groupByRule(findings) {
  const map = new Map();
  for (const f of findings) {
    const key = f.ruleCode || "__ungrouped__";
    if (!map.has(key)) map.set(key, []);
    map.get(key).push(f);
  }
  return [...map.entries()]
    .map(([ruleCode, occurrences]) => ({
      ruleCode,
      occurrences,
      severity: severityOfGroup(occurrences),
      count: findingsOf(occurrences),
      files: [...new Set(occurrences.map((o) => o.fileName).filter((n) => n && n !== "(unknown)"))].sort(),
    }))
    .sort((a, b) => SEVERITY_ORDER[a.severity] - SEVERITY_ORDER[b.severity] || b.count - a.count || a.ruleCode.localeCompare(b.ruleCode));
}

/** The words a search reads in a finding: its rule, its message and the values the validator gave. */
export const searchTextOf = (f, title = "") =>
  [f.ruleCode, title, f.message, ...Object.values(f.context || {})].filter((v) => v !== undefined && v !== null).join(" ").toLowerCase();
