/**
 * The validation report as a document: the verdict, the rules with their texts and occurrences, the Diagnostic. The
 * print (printReport) and the workbook's request (workbookRequestOf) both read this model, so they say what the screen
 * says, in its language. The whole report, never the filtered view. A rule's occurrences are bounded in the print; the
 * workbook's are written by the server from the report it keeps.
 */
import { SEVERITIES, weightOf } from "./reportModel";
import { countWords } from "../../utils/countWords";

export const PRINT_ROWS_PER_RULE = 200;
export const PRINT_CELL_CHARS = 120;

const SEVERITY_ONE = { error: "validation.severity.one.error", warning: "validation.severity.one.warning", info: "validation.severity.one.info" };
// The validator's generic fields said in the reader's words; every other field keeps the engine's own name.
const COLUMN_KEYS = { entityId: "validation.column.entity", filename: "validation.column.file", fieldName: "validation.column.field", fieldValue: "validation.column.value", csvRowNumber: "validation.column.row" };

const columnsOf = (rows) => {
  const keys = [];
  const seen = new Set();
  for (const row of rows) {
    for (const key of Object.keys(row.context || {})) {
      if (!seen.has(key)) {
        seen.add(key);
        keys.push(key);
      }
    }
  }
  return keys;
};

const cellText = (v) => (v === null || v === undefined ? "" : typeof v === "object" ? JSON.stringify(v) : String(v));

/** What the report can do about a rule, as RuleDetail says it. */
export const noteOf = ({ ruleCode, occurrences, quickFixCount = 0, safeCount = 0, isFixable = () => false, chatEnabled = false }, t) => {
  if (ruleCode === "__ungrouped__") return "";
  if (safeCount > 0) return t("validation.note.safe");
  if (quickFixCount > 0) return t("validation.note.quick");
  if (occurrences.some((o) => isFixable(o))) return t("validation.note.editor");
  return t(chatEnabled ? "validation.note.ai" : "validation.note.none");
};

/**
 * { title, network, generated, engine, verdict, counts: [{ key, label, count, rules }], notices: [text], rules: [...],
 *   audit: [...] | null }. A rule: { code, severity, severityLabel, title, description, note, count, files, columns:
 *   [{ key, label }], rows: [[text]], notSampled }. An audit finding: { code, severity, severityLabel, title, body,
 *   countText, samples: [{ label, detail }] }.
 */
export const exportModelOf = ({ report, groups, findingCounts, ruleCounts, titleOf, descriptionOf, noteFor = () => "", audit = null, networkName = "", t, language, now = new Date() }) => {
  const counts = SEVERITIES.map((key) => ({ key, label: t({ error: "validation.severity.errors", warning: "validation.severity.warnings", info: "validation.severity.infos" }[key]), count: findingCounts[key] || 0, rules: ruleCounts[key] || 0 }));
  const errors = findingCounts.error || 0;
  const verdict = errors ? t(errors === 1 ? "validation.verdict.errors.one" : "validation.verdict.errors.many", { count: errors }) : t("validation.verdict.clear");
  const notices = [];
  const incomplete = report?.incomplete;
  if (incomplete) {
    const unread = Array.isArray(incomplete.files) ? incomplete.files : null;
    notices.push(`${t("validation.incomplete.title")} ${unread ? t("validation.incomplete.unread", { files: unread.join(", "), n: incomplete.total || 1 }) : t("validation.incomplete.body", { n: incomplete.total || 1 })}`);
  }
  const rules = groups.map((g) => {
    const real = [];
    let notSampled = 0;
    for (const o of g.occurrences) {
      if (o.aggregate) notSampled += weightOf(o);
      else real.push(o);
    }
    const keys = columnsOf(real);
    const known = g.ruleCode !== "__ungrouped__";
    return {
      code: known ? g.ruleCode : "",
      severity: g.severity,
      severityLabel: t(SEVERITY_ONE[g.severity]),
      title: titleOf(g.ruleCode),
      description: known ? descriptionOf(g.ruleCode) : "",
      note: noteFor(g),
      count: g.count,
      files: g.files,
      columns: keys.map((key) => ({ key, label: COLUMN_KEYS[key] ? t(COLUMN_KEYS[key]) : key })),
      rows: real.map((o) => (keys.length ? keys.map((key) => cellText(o.context?.[key])) : [cellText(o.message)])),
      messageOnly: keys.length === 0,
      notSampled,
    };
  });
  const auditRows = audit
    ? audit.map((f) => ({
        code: f.code,
        severity: f.severity === "warning" ? "warning" : "info",
        severityLabel: t(f.severity === "warning" ? "audit.severity.warning" : "audit.severity.info"),
        title: t(`audit.code.${f.code}.title`),
        body: t(`audit.code.${f.code}.body`),
        countText: t(`audit.unit.${f.unit || "items"}`, { count: f.count }),
        samples: (f.samples || []).map((s) => ({ label: cellText(s.label), detail: cellText(s.detail) })),
      }))
    : null;
  const generated = t("validation.export.generated", { date: now.toLocaleString(language || undefined, { dateStyle: "long", timeStyle: "short" }) });
  return {
    title: t("validation.export.title"),
    network: networkName || "",
    generated,
    engine: report?.engine_version ? t("validation.verdict.engine", { version: report.engine_version }) : t("validation.verdict.by"),
    verdict,
    errors,
    counts,
    notices,
    rules,
    audit: auditRows,
  };
};

/** The file's name, without its extension. */
export const fileNameOf = (model) => `${model.title}${model.network ? ` ${model.network}` : ""}`.replace(/[\\/:*?"<>|]+/g, " ").trim();

const width = (label, rows, i, min = 10, max = 60) => Math.max(min, Math.min(max, Math.max(String(label).length, ...rows.map((r) => String(r[i] ?? "").length)) + 2));

/**
 * What the server needs to write the workbook: the cover, the Diagnostic and the words of this language. The rules'
 * figures and their occurrences are the server's, read from the report it keeps, so the request stays small whatever
 * the report holds.
 */
export const workbookRequestOf = (model, t) => {
  const summary = [[model.title, model.network], [model.generated], [model.engine], [], [model.verdict], []];
  const summaryTones = [null, "muted", "muted", null, model.errors ? "error" : "ok", null];
  for (const c of model.counts) {
    summary.push([c.label, c.count, t(c.rules === 1 ? "validation.summary.rules.one" : "validation.summary.rules.many", { count: c.rules })]);
    summaryTones.push(c.count ? c.key : "ok");
  }
  for (const n of model.notices) {
    summary.push([], [n]);
    summaryTones.push(null, "warning");
  }
  let audit = null;
  if (model.audit) {
    const head = [t("validation.export.col.severity"), t("validation.export.col.rule"), t("validation.export.col.code"), t("validation.export.col.count"), t("validation.export.col.sample"), t("validation.export.col.detail")];
    const rows = [];
    const tones = [null];
    const add = (f, row) => {
      rows.push(row);
      tones.push(f.severity);
    };
    for (const f of model.audit) {
      if (!f.samples.length) add(f, [f.severityLabel, f.title, f.code, f.countText, "", ""]);
      for (const s of f.samples) add(f, [f.severityLabel, f.title, f.code, f.countText, s.label, s.detail]);
    }
    audit = { name: t("audit.title"), rows: [head, ...rows], widths: head.map((h, i) => width(h, rows, i)), header: true, tones };
  }
  const ungrouped = model.rules.find((r) => !r.code);
  return {
    summary: { name: t("validation.export.sheet.summary"), rows: summary, widths: [44, 14, 18], summary: true, tones: summaryTones },
    audit,
    texts: {
      sheets: { rules: t("validation.export.sheet.rules") },
      head: {
        severity: t("validation.export.col.severity"),
        rule: t("validation.export.col.rule"),
        code: t("validation.export.col.code"),
        count: t("validation.export.col.count"),
        files: t("validation.export.col.files"),
        description: t("validation.export.col.description"),
        note: t("validation.export.col.note"),
        message: t("validation.export.col.message"),
      },
      columns: Object.fromEntries(Object.entries(COLUMN_KEYS).map(([key, label]) => [key, t(label)])),
      severity: Object.fromEntries(Object.entries(SEVERITY_ONE).map(([key, label]) => [key, t(label)])),
      count: { one: countWords(t, "validation.detail.occurrences", 1), many: countWords(t, "validation.detail.occurrences", 2, { count: "{count}" }) },
      tail: t("validation.export.notDetailed", { count: "{count}" }),
      ungrouped: ungrouped ? ungrouped.title : "",
      rules: Object.fromEntries(model.rules.filter((r) => r.code).map((r) => [r.code, { title: r.title, description: r.description, note: r.note }])),
    },
  };
};
