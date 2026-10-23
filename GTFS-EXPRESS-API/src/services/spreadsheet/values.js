/**
 * Reads ONE cell of an operator's offer sheet, never guessing: each reader
 * returns what the cell says, null when the cell is not of that kind, or
 * { error: reason } when it is but cannot be read (« 6h75 », « 10 à 12 min »);
 * the parser lists such a cell in `unread`, it never picks a value.
 * A cell is SheetJS's { v, t, w, z }; accents, case and spaces never matter (fold).
 */

"use strict";

const DOW = ["mon", "tue", "wed", "thu", "fri", "sat", "sun"];
const WEEKDAYS = ["mon", "tue", "wed", "thu", "fri"];
const { formatTime, DAY_S } = require("../../utils/time");

/** Lower case, no accents, one space, « à » → « a »: the form every keyword is matched in. */
const fold = (s) =>
  String(s ?? "")
    .normalize("NFD")
    .replace(/[̀-ͯ]/g, "")
    .toLowerCase()
    .replace(/[’`]/g, "'")
    .replace(/\s+/g, " ")
    .trim();

const textOf = (cell) => {
  if (!cell) return "";
  if (cell.w != null && cell.w !== "") return String(cell.w).trim();
  if (cell.v == null) return "";
  return String(cell.v).trim();
};

const isNumber = (cell) => cell && cell.t === "n" && typeof cell.v === "number" && Number.isFinite(cell.v);
// A number format that shows a clock time (h:mm, hh:mm:ss, [h]:mm) or a date.
const TIME_FORMAT = /(^|[^a-z])(h|hh|\[h\])(:|\b)/i;
const DATE_FORMAT = /(d{1,4}|y{2,4}|m{3,5})/i;
const formatOf = (cell) => String(cell?.z || "");
const looksTimeFormatted = (cell) => TIME_FORMAT.test(formatOf(cell)) || /^\d{1,2}:\d{2}(:\d{2})?$/.test(String(cell?.w || "").trim());
const looksDateFormatted = (cell) => DATE_FORMAT.test(formatOf(cell)) && !/^\s*\[?h/i.test(formatOf(cell));

// ── Times ───────────────────────────────────────────────────────────────────

const TIME_TEXT = /^(\d{1,2})\s*(?:[:hH]|heures?)\s*(\d{1,2})?\s*(?::\s*(\d{2}))?\s*(?:min|mn)?$/;
const MAX_HOURS = 47; // a service day runs past midnight (« 25:10 »), never two days

/**
 * An Excel serial is a fraction of a day (≥ 1 past midnight); a whole number without a time format (« 6 ») is not
 * a time, 6 h or 6 min: null, the column decides.
 */
const timeOf = (cell) => {
  if (!cell) return null;
  if (cell.t === "e") return { error: "error_value" };
  if (isNumber(cell)) {
    const v = cell.v;
    if (Number.isInteger(v) && !looksTimeFormatted(cell)) return null;
    if (v < 0 || v >= 2) return looksDateFormatted(cell) ? null : { error: "invalid_time" };
    return { sec: Math.round(v * DAY_S) };
  }
  const text = textOf(cell);
  if (!text) return null;
  const m = TIME_TEXT.exec(text.replace(/ /g, " "));
  if (!m) return /^\d{1,2}\s*[:hH]/.test(text) ? { error: "invalid_time" } : null;
  const h = parseInt(m[1], 10);
  const mi = m[2] == null ? 0 : parseInt(m[2], 10);
  const s = m[3] == null ? 0 : parseInt(m[3], 10);
  // « 6h5 » is not a way to write 06:05 (6h50? 6h05?): read only two-digit minutes.
  if (m[2] != null && m[2].length !== 2) return { error: "invalid_time" };
  if (h > MAX_HOURS || mi > 59 || s > 59) return { error: "invalid_time" };
  return { sec: h * 3600 + mi * 60 + s };
};

/** Seconds only when the time has them. */
const hhmm = (sec) => formatTime(sec, { seconds: "auto", round: false, clamp: false });

// ── Headways ────────────────────────────────────────────────────────────────

const NO_SERVICE = new Set(["-", "--", "—", "–", "/", "x", "nc", "n/c", "ns", "pas de service", "sans service", "aucun service", "no service", "none", "non", "neant", "pas de passage", "pas de bus", "0"]);
const MAX_HEADWAY = 240;

/**
 * Minutes between two departures. « — », « pas de service » mean no departure in that band ({ none: true }); a
 * range (« 10 à 12 min ») states no one headway ({ error: "headway_range" }).
 */
const headwayOf = (cell) => {
  if (!cell) return null;
  if (cell.t === "e") return { error: "error_value" };
  if (isNumber(cell)) {
    const v = cell.v;
    // A time-formatted cell (0:10) is a fraction of a day.
    const min = v < 1 && looksTimeFormatted(cell) ? Math.round(v * 1440 * 100) / 100 : v;
    if (min === 0) return { none: true };
    if (!(min > 0) || min > MAX_HEADWAY) return { error: "invalid_headway" };
    return { min: Math.round(min * 100) / 100 };
  }
  const raw = fold(textOf(cell));
  if (!raw) return null;
  if (NO_SERVICE.has(raw)) return { none: true };
  const text = raw.replace(/^(toutes les|tous les|every|chaque|freq\.?|frequence|cadence)\s*/, "").replace(/\s*(minutes?|mins?|mn|'|′)$/, "").trim();
  if (/^\d+(?:[.,]\d+)?\s*(?:a|à|-|–|\/|to|ou)\s*\d+(?:[.,]\d+)?$/.test(text)) return { error: "headway_range" };
  let min = null;
  let m = /^(\d+(?:[.,]\d+)?)$/.exec(text);
  if (m) min = parseFloat(m[1].replace(",", "."));
  m = m ? null : /^(\d{1,2})\s*h\s*(\d{2})?$/.exec(text);
  if (m) min = parseInt(m[1], 10) * 60 + (m[2] ? parseInt(m[2], 10) : 0);
  m = min != null ? null : /^(\d{1,2}):(\d{2})$/.exec(text);
  if (m) min = parseInt(m[1], 10) * 60 + parseInt(m[2], 10);
  if (min == null) return /\d/.test(text) ? { error: "invalid_headway" } : null;
  if (min === 0) return { none: true };
  if (!(min > 0) || min > MAX_HEADWAY) return { error: "invalid_headway" };
  return { min };
};

// ── Day types ───────────────────────────────────────────────────────────────

// Whole labels first (folded, separators as spaces), then tokens.
const DAY_PHRASES = [
  [/\b(du )?lundi (au |a )?vendredi\b|\bl a v\b|\blav\b|\bl v\b|\blun(di)? (au |a )?ven(dredi)?\b|\blu ve\b|\blmmjv\b|\bmon(day)? (to )?fri(day)?\b|\bweekdays?\b|\bjours? de semaine\b|\bsemaine\b|\bjours ouvres\b/, WEEKDAYS],
  [/\b(du )?lundi (au |a )?samedi\b|\bl a s\b|\blas\b|\blun(di)? (au |a )?sam(edi)?\b|\blmmjvs\b|\bmon(day)? (to )?sat(urday)?\b|\bjours ouvrables\b/, [...WEEKDAYS, "sat"]],
  [/\btous les jours\b|\btlj\b|\bdaily\b|\b7 7\b|\b(du )?lundi (au |a )?dimanche\b|\bevery ?day\b/, DOW],
  [/\blmjv\b/, ["mon", "tue", "thu", "fri"]],
];
const DAY_TOKENS = {
  lundi: "mon", lun: "mon", lu: "mon", monday: "mon", mon: "mon",
  mardi: "tue", mar: "tue", ma: "tue", tuesday: "tue", tue: "tue",
  mercredi: "wed", mer: "wed", me: "wed", wednesday: "wed", wed: "wed",
  jeudi: "thu", jeu: "thu", je: "thu", thursday: "thu", thu: "thu",
  vendredi: "fri", ven: "fri", ve: "fri", friday: "fri", fri: "fri",
  samedi: "sat", samedis: "sat", sam: "sat", sa: "sat", saturday: "sat", sat: "sat", saturdays: "sat",
  dimanche: "sun", dimanches: "sun", dim: "sun", di: "sun", sunday: "sun", sun: "sun", sundays: "sun",
};
const HOLIDAY_WORDS = /\b(jf|j f|jours? feries?|feries?|fetes?|holidays?|public holidays?|bank holidays?|djf|dimjf|dijf)\b/;
const SCHOOL_WORDS = /\b(scolaires?|periode scolaire|ps|en periode scolaire|school( days?| term)?|lps|lav s|ecole)\b/;
const VACATION_WORDS = /\b(vacances( scolaires)?|vs|pvs|periode de vacances|petites vacances|school holidays?|holiday weeks?|conges scolaires)\b/;
// The summer holidays stand apart: the engine names no such period, so `summer_holidays` asks for its dates rather
// than taking the whole school_holidays (which also holds the short holidays). Checked first: « vacances d'été »
// holds « vacances ». « Été » alone names a season, not days: never weekdays assumed.
const SUMMER_WORDS = /\b(gvs|grandes vacances( scolaires)?|vacances d'ete|vacances ete|vacances estivales|ete|summer( holidays?)?)\b/;
const SUMMER_ALONE = /^(?:ete|summer)$/;
// A word qualifying the period without naming its dates (« Semaine PS forte »): read as an assumption the person
// confirms (`assumed: ["qualifier"]`), never dropped silently.
const QUALIFIER_WORDS = /\b(forte|faible|haute|basse|renforcee|reduite|allegee)\b/;
const NOISE = /\b(et|and|du|au|le|les|des|en|de|horaires?|jours?|type|periode|grille|regime)\b/g;

/**
 * A day type as an operator writes it. null when the words hold one it does not know, or two periods: never half a
 * reading (dayTypesOf reads « Semaine PS PVS »).
 */
const dayTypeOf = (text) => {
  const label = String(text ?? "").trim();
  let s = fold(label).replace(/[()[\]{}.;:]/g, " ").replace(/\s+/g, " ").trim();
  if (!s || s.length > 60) return null;
  // « Di/JF » before the separators go.
  s = s.replace(/\b7 ?\/ ?7\b/g, "tous les jours").replace(/\bd ?\/ ?jf\b/g, "dimanche jf").replace(/\bdi ?\/ ?jf\b/g, "dimanche jf").replace(/\bdim\.? ?(&|et) ?jf\b/g, "dimanche jf");
  // A list (« Lundi, Vendredi ») is never a range: its separators become a « , » token the range phrases cannot
  // span; a range's dash becomes a space.
  s = s.replace(/\s*(?:[/&+,]|\bet\b|\band\b)\s*/g, " , ").replace(/[-–—]/g, " ").replace(/\s+/g, " ").trim();
  const days = new Set();
  let period = null;
  let holidays = false;
  let qualifier = null;
  if (QUALIFIER_WORDS.test(s)) {
    qualifier = QUALIFIER_WORDS.exec(s)[1];
    s = s.replace(QUALIFIER_WORDS, " ");
  }
  if (HOLIDAY_WORDS.test(s)) {
    holidays = true;
    s = s.replace(HOLIDAY_WORDS, " ");
  }
  let season = false;
  if (SUMMER_WORDS.test(s)) {
    period = "summer_holidays";
    season = SUMMER_ALONE.test(SUMMER_WORDS.exec(s)[1]);
    s = s.replace(SUMMER_WORDS, " ");
  } else if (VACATION_WORDS.test(s)) {
    period = "school_holidays";
    s = s.replace(VACATION_WORDS, " ");
  } else if (SCHOOL_WORDS.test(s)) {
    period = "school_days";
    s = s.replace(SCHOOL_WORDS, " ");
  }
  for (const [re, list] of DAY_PHRASES) {
    if (re.test(s)) {
      list.forEach((d) => days.add(d));
      s = s.replace(re, " ");
    }
  }
  s = s.replace(NOISE, " ").replace(/\s+/g, " ").trim();
  for (const w of s ? s.split(" ").filter((x) => x !== ",") : []) {
    if (DAY_TOKENS[w]) days.add(DAY_TOKENS[w]);
    else return null;
  }
  // « JF » alone or with Sunday: the Sunday timetable, holidays included.
  if (holidays && !days.size) days.add("sun");
  const assumed = [];
  if (!days.size) {
    if (!period || season) return null;
    // « Scolaire » alone: that period's weekdays, said as assumed.
    WEEKDAYS.forEach((d) => days.add(d));
    assumed.push("day");
  }
  if (qualifier) assumed.push("qualifier");
  const list = DOW.filter((d) => days.has(d));
  const key = list.join(",");
  const day = key === WEEKDAYS.join(",") ? "weekday" : key === DOW.join(",") ? "daily" : key === "sat" ? "saturday" : key === "sun" ? "sunday" : key === "sat,sun" ? "weekend" : list.length === 1 ? list[0] : key;
  return { day, days: list, period, holidays, ...(assumed.length ? { assumed } : {}), ...(qualifier ? { qualifier } : {}), label };
};

const PERIOD_WORDS = [
  ["summer_holidays", SUMMER_WORDS, "ete"],
  ["school_holidays", VACATION_WORDS, "vacances"],
  ["school_days", SCHOOL_WORDS, "scolaire"],
];

/** A cell naming several periods with the same days (« Semaine PS PVS ») gives one day type per period. */
const dayTypesOf = (text) => {
  const one = dayTypeOf(text);
  if (one) return [one];
  const label = String(text ?? "").trim();
  const s = fold(label).replace(/[()[\]{}.;:/&+,]/g, " ").replace(/\s+/g, " ").trim();
  if (!s || s.length > 60) return [];
  // The summer first: « vacances d'été » holds « vacances ».
  let marked = s;
  const found = [];
  for (const [name, re, word] of PERIOD_WORDS) {
    const g = new RegExp(re.source, "g");
    if (!g.test(marked)) continue;
    marked = marked.replace(new RegExp(re.source, "g"), ` §${found.length} `);
    found.push({ name, word });
  }
  if (found.length < 2) return [];
  const out = [];
  for (let i = 0; i < found.length; i++) {
    const own = marked.replace(new RegExp(`§${i}(?!\\d)`, "g"), found[i].word).replace(/§\d+/g, " ").replace(/\b(et|ou|and|or)\b/g, " ");
    const d = dayTypeOf(own);
    if (!d || d.period !== found[i].name) return [];
    out.push({ ...d, label });
  }
  return out;
};

// ── Dates and periods ───────────────────────────────────────────────────────

const MONTHS = { janvier: 1, janv: 1, jan: 1, january: 1, fevrier: 2, fevr: 2, fev: 2, feb: 2, february: 2, mars: 3, mar: 3, march: 3, avril: 4, avr: 4, apr: 4, april: 4, mai: 5, may: 5, juin: 6, jun: 6, june: 6, juillet: 7, juil: 7, jul: 7, july: 7, aout: 8, aug: 8, august: 8, septembre: 9, sept: 9, sep: 9, september: 9, octobre: 10, oct: 10, october: 10, novembre: 11, nov: 11, november: 11, decembre: 12, dec: 12, december: 12 };
const pad = (n) => String(n).padStart(2, "0");
const validDate = (y, m, d) => {
  const dt = new Date(Date.UTC(y, m - 1, d));
  return dt.getUTCFullYear() === y && dt.getUTCMonth() === m - 1 && dt.getUTCDate() === d ? `${y}-${pad(m)}-${pad(d)}` : null;
};
const fullYear = (y) => (y < 100 ? 2000 + y : y);
const DATE_PATTERNS = [
  [/(\d{4})-(\d{1,2})-(\d{1,2})/, (m) => validDate(+m[1], +m[2], +m[3])],
  [/(\d{1,2})[/.](\d{1,2})[/.](\d{2,4})/, (m) => validDate(fullYear(+m[3]), +m[2], +m[1])],
  [/(\d{1,2})(?:er)?\s+([a-z]+)\.?\s+(\d{4})/, (m) => (MONTHS[m[2]] ? validDate(+m[3], MONTHS[m[2]], +m[1]) : null)],
];

/** The first date from `start` on: { iso, index, end } | null. */
const findDate = (folded, start = 0) => {
  let best = null;
  for (const [re, make] of DATE_PATTERNS) {
    const g = new RegExp(re.source, "g");
    g.lastIndex = start;
    let m;
    while ((m = g.exec(folded))) {
      const iso = make(m);
      if (iso && (!best || m.index < best.index)) best = { iso, index: m.index, end: m.index + m[0].length };
      if (iso) break;
    }
  }
  return best;
};

const dateOf = (cell) => {
  if (!cell) return null;
  if (cell.t === "e") return { error: "error_value" };
  if (cell.t === "d" && cell.v instanceof Date) return validDate(cell.v.getUTCFullYear(), cell.v.getUTCMonth() + 1, cell.v.getUTCDate());
  if (isNumber(cell)) {
    if (!looksDateFormatted(cell) || cell.v < 20000 || cell.v > 80000) return null;
    // Excel's 1900 system: serial 25569 is 1970-01-01.
    const dt = new Date(Math.round((cell.v - 25569) * DAY_S) * 1000);
    return validDate(dt.getUTCFullYear(), dt.getUTCMonth() + 1, dt.getUTCDate());
  }
  const folded = fold(textOf(cell));
  if (!folded) return null;
  const d = findDate(folded);
  if (d && d.index === 0 && d.end >= folded.length - 1) return d.iso;
  return /^\d{1,2}[/.]\d{1,2}[/.]\d{2,4}$/.test(folded) ? { error: "invalid_date" } : null;
};

// The weekday a date may carry (« à compter du lundi 4 janvier 2027 ») is no part of the period's words.
const WEEKDAY_BEFORE = /\s*\b(?:lundi|mardi|mercredi|jeudi|vendredi|samedi|dimanche|monday|tuesday|wednesday|thursday|friday|saturday|sunday)\s*$/;
// Words that open or close a period across a weekday — never a bare « du » or « au »: « Horaires du samedi 9 janvier
// 2027 » names one day, « du lundi au vendredi 4 janvier 2027 » a range of days; neither is a period.
const FROM_WITH_DAY = /\b(a partir du|a compter du|des le|depuis le|from)\s*$/;
const TO_WITH_DAY = /(jusqu'?au|\buntil)\s*$/;

/** A period written in one cell: { from?, to? } | { error: "invalid_period" } (dates in the wrong order) | null. */
const periodOf = (text) => {
  const folded = fold(text);
  if (!folded) return null;
  const a = findDate(folded);
  if (!a) return null;
  const b = findDate(folded, a.end);
  const before = folded.slice(0, a.index);
  // The weekday taken out counts only after the words that allow it.
  const dayless = before.replace(WEEKDAY_BEFORE, " ");
  if (!b) {
    if (/(jusqu'?au|until|to|au)\s*$/.test(before) || (dayless !== before && TO_WITH_DAY.test(dayless))) return { to: a.iso };
    if (/(a partir du|a compter du|des le|from|du|depuis le|valable du)\s*$/.test(before) || (dayless !== before && FROM_WITH_DAY.test(dayless))) return { from: a.iso };
    return null;
  }
  const between = folded.slice(a.end, b.index).replace(WEEKDAY_BEFORE, " ");
  if (!/^\s*(au|a|-|–|—|→|->|>|to|until|jusqu'?au|\/)\s*$/.test(between)) return null;
  if (b.iso < a.iso) return { error: "invalid_period" };
  return { from: a.iso, to: b.iso };
};

// ── Bands ───────────────────────────────────────────────────────────────────

const BAND_TEXT = /(\d{1,2})\s*(?:h|:)\s*(\d{2})?\s*(?:-|–|—|à|a|>|→|\/|to|jusqu'?a)\s*(\d{1,2})\s*(?:h|:)?\s*(\d{2})?/;

/** A time window a header names (« HP matin (6h-9h) »). */
const bandOf = (text) => {
  const folded = fold(text).replace(/ /g, " ");
  const m = BAND_TEXT.exec(folded);
  if (!m) return null;
  const from = parseInt(m[1], 10) * 3600 + (m[2] ? parseInt(m[2], 10) : 0) * 60;
  const to = parseInt(m[3], 10) * 3600 + (m[4] ? parseInt(m[4], 10) : 0) * 60;
  if (parseInt(m[1], 10) > MAX_HOURS || parseInt(m[3], 10) > MAX_HOURS || (m[2] && +m[2] > 59) || (m[4] && +m[4] > 59)) return null;
  // A window crossing midnight (« 21h-1h »): its end is on the next service day.
  const end = to <= from ? to + DAY_S : to;
  if (end - from > DAY_S) return null;
  return { from, to: end };
};

// ── Lines and directions ────────────────────────────────────────────────────

const lineOf = (text) => {
  const raw = String(text ?? "").trim();
  if (!raw) return null;
  const m = /^(?:ligne|line|lig\.?|route)\s*(?:n[°o]\s*)?[:\-–]?\s*(.+)$/i.exec(raw);
  const name = (m ? m[1] : raw).trim();
  return name && name.length <= 40 ? name : null;
};

const DIRECTION_WORDS = { aller: "aller", a: "aller", outbound: "aller", retour: "retour", r: "retour", inbound: "retour", "les deux sens": "both", "deux sens": "both", "2 sens": "both", both: "both", "both directions": "both", "aller-retour": "both", "aller retour": "both", "a/r": "both", ar: "both" };

/** A direction word only: « Sens 1 » is the operator's numbering, never a GTFS direction_id. */
const directionOf = (text) => {
  const k = fold(text).replace(/^sens\s*:?\s*/, "");
  return Object.prototype.hasOwnProperty.call(DIRECTION_WORDS, k) ? DIRECTION_WORDS[k] : null;
};

// ── Timetable marks ─────────────────────────────────────────────────────────

const PASS_MARKS = new Set(["|", "||", "-", "--", "—", "–", "↓", "↑", "·", "...", "…", "/", "nc"]);

/** « Not served here »: any run of dots too (a desserte grid's trip skipping a stop). */
const isPassMark = (text) => {
  const f = fold(text);
  return PASS_MARKS.has(f) || /^(?:\.\s?){2,}$|^…+$/.test(f);
};

const isServedMark = (text) => ["oui", "x", "✓", "✔", "☑", "√", "yes"].includes(fold(text));

const BAND_ALONE = /^(?:de\s+)?\d{1,2}\s*(?:h|:)\s*\d{0,2}\s*(?:-|–|—|a|>|→|\/|to)\s*\d{1,2}\s*(?:h|:)?\s*\d{0,2}$/;

/**
 * A cell giving a band and its headway instead of departures (« 7h-9h : 15 min »). Only a band alone before the
 * colon and minutes after it: a stop name holding a time is not one.
 */
const bandHeadwayOf = (text) => {
  const m = /^(.*\S)\s*:\s*([^:]+)$/.exec(String(text ?? "").replace(/ /g, " ").trim());
  if (!m || !BAND_ALONE.test(fold(m[1])) || !/\d\s*(?:min|mn|minutes?|'|′)\s*$/.test(fold(m[2]))) return null;
  const band = bandOf(m[1]);
  const hw = headwayOf({ t: "s", v: m[2], w: m[2] });
  return band && hw && hw.min ? { from: band.from, to: band.to, min: hw.min } : null;
};

// ── Trips' labels and notes ─────────────────────────────────────────────────

// A code of three letters at most before the number (« F1 », « T-12 »); a longer word makes a name (« Quai 2 »). A
// stop named « ZI 2 » reads as a label too: a column of only such names is set aside unless « Arrêts » heads it.
const TRIP_WORD = "(?:courses?|trajets?|services?|departs?|navettes?|voyages?|missions?|trips?|runs?)";
const TRIP_LABEL = new RegExp(`^(?:${TRIP_WORD}\\s*(?:n°|no|num|numero)?|n°|no|num|numero)?\\s*[.:]?\\s*(?:[a-z]{1,3}\\s*[-.]?\\s*)?\\d{1,5}[a-z]?$|^${TRIP_WORD}\\s+[a-z]$|^\\d{1,3}\\s*(?:er|ere|re|e|eme)\\s+${TRIP_WORD}$`);

/** A timetable whose « stops » are all trip labels has its trips down its rows: never read as stops. */
const tripLabelOf = (cell) => {
  if (!cell) return null;
  if (isNumber(cell)) return Number.isInteger(cell.v) && cell.v > 0 && cell.v < 100000 && !looksTimeFormatted(cell) && !looksDateFormatted(cell) ? String(cell.v) : null;
  if (cell.t !== "s") return null;
  const text = textOf(cell);
  return text && TRIP_LABEL.test(fold(text)) ? text : null;
};

const isNoteMark = (text) => /^(?:\(\s*[0-9a-z]{1,3}\s*\)|[0-9a-z]{1,2}\s*\)|\*{1,3}|[†‡§]{1,2}|[¹²³⁴⁵⁶⁷⁸⁹⁰]{1,2})$/i.test(String(text ?? "").trim());

const stopKey = (text) => fold(text).replace(/[^a-z0-9]+/g, " ").trim();

module.exports = { fold, textOf, timeOf, hhmm, headwayOf, dayTypeOf, dayTypesOf, dateOf, periodOf, bandOf, lineOf, directionOf, isPassMark, isServedMark, bandHeadwayOf, tripLabelOf, isNoteMark, stopKey, looksTimeFormatted, DOW, WEEKDAYS };
