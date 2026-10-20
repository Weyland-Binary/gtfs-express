/**
 * coherence/serviceSheet — the coherence report as an operator's
 * service-méthode sheet: a workbook (.xlsx, SheetJS) and a
 * PDF, both rendered by the server from ONE model of the report it computed
 * itself, so that the two files carry the same figures as the JSON report,
 * cell for cell.
 *
 *   sheetModel(report, { header, lang }) → {
 *     title, header: [[label, value]],                 the network, the version, the date, the
 *                                                      validator's engine and the fingerprint of its
 *                                                      report, the version's fingerprint, the day types
 *     anomalies: { name, title, columns, rows },       FIRST, in words (what does not hold together)
 *     sheets: [{ name, title, day_type, period, columns, rows, notes }]
 *                                                      one per day type (and period, when a change
 *                                                      touches part of the validity): lines ×
 *                                                      directions in rows — first and last departure,
 *                                                      headway by band (peak, off-peak), trips,
 *                                                      patterns, running time; « avant » columns and
 *                                                      « modifié » when the report compares
 *   }
 *   xlsxOf(model) → Buffer   one worksheet per entry, the anomalies first; numbers as numbers, times as
 *                            text (GTFS's clock runs past 24:00), every value a plain value (no formula:
 *                            a name starting with "=" stays a name)
 *   pdfOf(model) → Buffer    A4 landscape: the header, the anomalies, then one section per day type,
 *                            each row of a table one line (Courier, columns padded), headings repeated
 *                            on every page, the pages numbered
 *   cellsOfRow(row, { compare }) → the values of one report row, in the columns' order (what both files
 *                            write and the tests compare with the JSON)
 *
 * The header's `header` input (the controller builds it): { network, version, version_at, computed_at,
 * validity, engine, validator_fingerprint, validated_at, version_fingerprint, school, mode, title }.
 */

"use strict";

const XLSX = require("xlsx");
const { wordsOf, say } = require("./sheetWords");
const { pdfDocument, monoWidth } = require("./pdfWriter");

const DAY_ORDER = ["school_weekday", "holiday_weekday", "weekday", "saturday", "sunday_holiday"];
const MAX_SHEET_NAME = 31;

const lineLabel = (r) => r.route_short_name || r.route_long_name || r.route_id || "";
const orDash = (v) => (v === null || v === undefined || v === "" ? "—" : v);

/** The values of one report row, in the columns' order (sheetModel's columns). */
const cellsOfRow = (r, { compare = false, words = wordsOf("fr") } = {}) => {
  const m = (x) => [orDash(x?.first_departure), orDash(x?.last_departure), orDash(x?.headway?.peak), orDash(x?.headway?.offpeak), x?.trips ?? 0];
  const out = [lineLabel(r), orDash(r.route_long_name && r.route_long_name !== lineLabel(r) ? r.route_long_name : ""), orDash(r.direction_name || r.direction_id), r.days ?? 0, orDash(r.date), ...m(r), (r.patterns || []).length, orDash(r.running_time?.min), orDash(r.running_time?.max)];
  if (compare) out.push(...m(r.before), r.changed ? words.yes : words.no);
  return out;
};

const columnsOf = (words, compare) => {
  const cols = ["col.line", "col.lineName", "col.direction", "col.days", "col.date", "col.first", "col.last", "col.peak", "col.offpeak", "col.trips", "col.patterns", "col.runMin", "col.runMax"].map((k) => say(words, k));
  if (compare) cols.push(...["col.first", "col.last", "col.peak", "col.offpeak", "col.trips"].map((k) => say(words, "col.before", { label: say(words, k) })), say(words, "col.changed"));
  return cols;
};

const periodText = (words, period) => (!period ? "" : period.name === "rest" ? say(words, "period.rest") : say(words, "period.range", { from: period.from, to: period.to }));

/** A worksheet name: at most 31 characters, none of []:*?/\, unique in the workbook. */
const sheetName = (wanted, used) => {
  const base = String(wanted || "Sheet").replace(/[[\]:*?/\\]/g, "-").slice(0, MAX_SHEET_NAME).trim() || "Sheet";
  let name = base;
  for (let n = 2; used.has(name.toLowerCase()); n++) name = `${base.slice(0, MAX_SHEET_NAME - String(n).length - 1)} ${n}`;
  used.add(name.toLowerCase());
  return name;
};

/** An anomaly in the document's language (the web's sentences); a code it does not know keeps the server's text. */
const anomalySentence = (words, a) => {
  const key = `anomaly.${a.code}`;
  if (!words[key]) return a.text || a.code;
  const period = a.period ? a.period.name || say(words, "period.range", { from: a.period.from, to: a.period.to }) : "";
  const params = { line: a.route_short_name || a.route_id || "", dayType: a.day_type ? say(words, `dayType.${a.day_type}`) : "", clause: a.clause_id || "", period, trips: a.trips ?? "", from: a.from || "", to: a.to || "", count: a.count ?? "", id: a.id || "" };
  const text = say(words, key, params);
  return a.code === "day_type_touched_out_of_scope" && a.reason === "dates" ? `${text} ${say(words, "anomaly.outOfDates", params)}` : text;
};

const anomalyCells = (words, a) => [a.code, orDash(a.route_short_name || a.route_id), orDash(a.direction_id), a.day_type ? say(words, `dayType.${a.day_type}`) : "—", anomalySentence(words, a), a.preexisting ? words.yes : words.no];

/** The model both files render (see the header). */
const sheetModel = (report, { header = {}, lang = "fr" } = {}) => {
  const words = wordsOf(lang);
  const compare = report?.mode === "compare";
  const h = header || {};
  const rows = [
    [say(words, "head.network"), orDash(h.network)],
    [say(words, "head.version"), orDash(h.version)],
    ...(h.version_at ? [[say(words, "head.versionDate"), h.version_at]] : []),
    [say(words, "head.date"), orDash(h.computed_at || (report?.computed_at ? `${String(report.computed_at).slice(0, 16).replace("T", " ")} UTC` : null))],
    [say(words, "head.validity"), report?.validity ? `${report.validity.from} → ${report.validity.to}` : "—"],
    [say(words, "head.mode"), compare ? say(words, "head.mode.compare", { title: h.title || report?.title || "—" }) : say(words, "head.mode.single")],
    [say(words, "head.engine"), h.engine ? `${h.engine}${h.validated_at ? ` (${say(words, "head.validatedAt", { date: h.validated_at })})` : ""}` : say(words, "head.validatorNone")],
    [say(words, "head.validatorFingerprint"), orDash(h.validator_fingerprint)],
    [say(words, "head.versionFingerprint"), orDash(h.version_fingerprint || report?.version?.fingerprint)],
    [say(words, "head.school"), h.school || schoolText(words, report?.school_calendar)],
  ];
  const anomalies = {
    name: say(words, "sheet.anomalies"),
    title: say(words, "anomalies.title"),
    columns: ["anomalies.col.code", "anomalies.col.line", "anomalies.col.direction", "anomalies.col.dayType", "anomalies.col.text", "anomalies.col.preexisting"].map((k) => say(words, k)),
    rows: (report?.anomalies || []).map((a) => anomalyCells(words, a)),
    empty: say(words, "anomalies.none"),
  };
  // One sheet per day type (and period): the rows in the report's order (line, direction).
  const groups = new Map();
  for (const r of report?.rows || []) {
    const k = `${DAY_ORDER.indexOf(r.day_type)}|${r.period ? `${r.period.name === "rest" ? "1" : "0"}${r.period.from}` : ""}`;
    if (!groups.has(k)) groups.set(k, { day_type: r.day_type, period: r.period || null, rows: [] });
    groups.get(k).rows.push(r);
  }
  const used = new Set([anomalies.name.toLowerCase()]);
  const columns = columnsOf(words, compare);
  const sheets = [...groups.entries()]
    .sort((a, b) => a[0].localeCompare(b[0], undefined, { numeric: true }))
    .map(([, g]) => {
      const day = say(words, `dayType.${g.day_type}`);
      const period = periodText(words, g.period);
      return { name: sheetName(period ? `${day} ${g.period.name === "rest" ? say(words, "period.restShort") : g.period.from}` : day, used), title: period ? `${day} — ${period}` : day, day_type: g.day_type, period: g.period, columns, rows: g.rows.map((r) => cellsOfRow(r, { compare, words })), keys: g.rows.map((r) => r.key || null) };
    });
  return { title: say(words, "doc.title"), subtitle: say(words, "doc.subtitle"), header: rows, anomalies, sheets, notes: [say(words, "sheet.peakBands")], words };
};

const schoolText = (words, sc) => {
  if (!sc || !sc.region) return say(words, sc && sc.status === "ok" ? "school.common" : "school.none");
  return say(words, "school.zone", { region: sc.region });
};

// ── The workbook ────────────────────────────────────────────────────────────

const colWidths = (table) => table[0].map((_, i) => ({ wch: Math.min(60, Math.max(6, ...table.map((r) => String(r[i] ?? "").length + 1))) }));

/** The workbook: the anomalies (with the header) first, then one worksheet per day type. */
const xlsxOf = (model) => {
  const wb = XLSX.utils.book_new();
  const headerBlock = [[model.title], [model.subtitle], ...model.header, []];
  const anomalies = [...headerBlock, [model.anomalies.title], model.anomalies.columns, ...(model.anomalies.rows.length ? model.anomalies.rows : [[model.anomalies.empty]])];
  const first = XLSX.utils.aoa_to_sheet(anomalies);
  first["!cols"] = colWidths([model.anomalies.columns, ...model.anomalies.rows, ...model.header]);
  XLSX.utils.book_append_sheet(wb, first, model.anomalies.name);
  for (const s of model.sheets) {
    // The header in short on every sheet (a sheet printed alone still says what it is), then the table.
    const lead = [[`${model.title} — ${s.title}`], [model.header[0].join(" : "), model.header[1].join(" : "), model.header.find((r) => r[0] === model.words["head.date"])?.join(" : ") || ""], [model.header.find((r) => r[0] === model.words["head.versionFingerprint"])?.join(" : ") || ""], [model.notes[0]], []];
    const ws = XLSX.utils.aoa_to_sheet([...lead, s.columns, ...s.rows]);
    ws["!cols"] = colWidths([s.columns, ...s.rows]);
    ws["!freeze"] = { xSplit: 3, ySplit: lead.length + 1 };
    XLSX.utils.book_append_sheet(wb, ws, s.name);
  }
  wb.Props = { Title: model.title, Author: "GTFS Express" };
  return XLSX.write(wb, { type: "buffer", bookType: "xlsx", compression: true });
};

// ── The PDF ─────────────────────────────────────────────────────────────────

const MARGIN = 32;
const SIZE = 7;
const LEAD = 9.2;

const fit = (s, n) => {
  const t = String(s ?? "");
  return t.length <= n ? t.padEnd(n) : `${t.slice(0, Math.max(0, n - 1))}…`;
};
const wrap = (s, n) => {
  const out = [];
  let line = "";
  for (const word of String(s ?? "").split(/\s+/)) {
    if (line && `${line} ${word}`.length > n) {
      out.push(line);
      line = word;
    } else line = line ? `${line} ${word}` : word;
    while (line.length > n) {
      out.push(line.slice(0, n));
      line = line.slice(n);
    }
  }
  if (line) out.push(line);
  return out.length ? out : [""];
};

/** The PDF: the same model, page by page (see the header). */
const pdfOf = (model) => {
  const doc = pdfDocument({ title: model.title });
  const chars = Math.floor((doc.width - 2 * MARGIN) / monoWidth(SIZE));
  let y = 0;
  let pageNo = 0;
  let repeat = null; // the heading of the table running over a page break
  const newPage = () => {
    doc.page();
    pageNo += 1;
    y = doc.height - MARGIN;
    const named = [model.header[0][1], model.header[1][1]].filter((v) => v && v !== "—");
    doc.text(MARGIN, MARGIN / 2, [model.title, ...named, say(model.words, "page", { n: pageNo })].join(" — "), { size: 6.5 });
    if (repeat) repeat();
  };
  const need = (h) => {
    if (y - h < MARGIN + 6) newPage();
  };
  const line = (text, { font = "mono", size = SIZE, lead = LEAD } = {}) => {
    need(lead);
    doc.text(MARGIN, y - size, text, { font, size });
    y -= lead;
  };
  const table = (columns, rows, widths) => {
    const fmt = (cells) => cells.map((c, i) => fit(c, widths[i])).join("  ").trimEnd();
    // A column's heading wraps on its own width (never cut): its lines stacked above the rule.
    const heads = columns.map((c, i) => wrap(c, widths[i]));
    const depth = Math.max(...heads.map((h) => h.length));
    const head = () => {
      need(LEAD * (depth + 1));
      for (let k = 0; k < depth; k++) line(fmt(heads.map((h) => h[k] || "")));
      doc.rule(MARGIN, y + 2, doc.width - MARGIN, y + 2);
    };
    repeat = head;
    head();
    for (const r of rows) line(fmt(r));
    repeat = null;
    y -= 4;
  };
  // The widths of a table: each column as wide as its values (a heading wraps), the text columns (`shrink`) narrowed
  // first when the row does not fit the page — the figures are never cut.
  const widthsOf = (columns, rows, shrink = [1, 2]) => {
    const w = columns.map((c, i) => Math.min(30, Math.max(Math.min(14, Math.max(...String(c).split(/\s+/).map((x) => x.length))), ...rows.map((r) => String(r[i] ?? "").length))));
    const total = () => w.reduce((a, b) => a + b, 0) + 2 * (w.length - 1);
    const order = [...shrink, ...w.map((_, i) => i).filter((i) => !shrink.includes(i))];
    for (const i of order) {
      while (total() > chars && w[i] > 6) w[i] -= 1;
      if (total() <= chars) break;
    }
    return w;
  };

  newPage();
  line(model.title, { font: "bold", size: 13, lead: 17 });
  line(model.subtitle, { size: 8, lead: 12 });
  const labelWidth = Math.max(...model.header.map((r) => String(r[0]).length)) + 1;
  for (const [k, v] of model.header) for (const [i, part] of wrap(v, chars - labelWidth - 2).entries()) line(`${fit(i ? "" : `${k}`, labelWidth)}  ${part}`);
  y -= 6;
  line(model.anomalies.title, { font: "bold", size: 10, lead: 14 });
  if (!model.anomalies.rows.length) line(model.anomalies.empty);
  else {
    // The anomalies' finding is a sentence: wrapped under its row rather than cut.
    const cols = model.anomalies.columns;
    const fixed = [30, 10, 6, 18];
    const textWidth = Math.max(30, chars - fixed.reduce((a, b) => a + b + 2, 0) - 8);
    const widths = [...fixed, textWidth, 6];
    const fmt = (cells) => cells.map((c, i) => fit(c, widths[i])).join("  ").trimEnd();
    repeat = () => line(fmt(cols));
    repeat();
    for (const r of model.anomalies.rows) {
      const parts = wrap(r[4], textWidth);
      line(fmt([r[0], r[1], r[2], r[3], parts[0], r[5]]));
      for (const more of parts.slice(1)) line(`${" ".repeat(fixed.reduce((a, b) => a + b + 2, 0))}${more}`);
    }
    repeat = null;
  }
  for (const s of model.sheets) {
    y -= 8;
    need(LEAD * 4);
    line(s.title, { font: "bold", size: 10, lead: 14 });
    table(s.columns, s.rows, widthsOf(s.columns, s.rows));
  }
  y -= 4;
  for (const n of model.notes) for (const part of wrap(n, chars)) line(part, { size: 6.5, lead: 8.5 });
  return doc.toBuffer();
};

module.exports = { sheetModel, xlsxOf, pdfOf, cellsOfRow, sheetName };
