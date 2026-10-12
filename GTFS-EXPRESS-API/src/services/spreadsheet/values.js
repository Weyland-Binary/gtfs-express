/**
 * spreadsheet/values — reading ONE cell of an operator's offer sheet, never
 * guessing: a time, a headway, a day type, a date or a date range, a line,
 * a direction. Each reader returns what the cell says, `null` when the cell
 * is not of that kind, or `{ error: reason }` when it is of that kind but
 * cannot be read (a time « 6h75 », a headway « 10 à 12 min »): the parser
 * lists such a cell in `unread` with that reason, it never picks a value.
 *
 *   timeOf(cell)        → { sec } | { error } | null   Excel serial (a fraction of a day), « 6:05 », « 06h05 »,
 *                                                       « 6h », « 6 h 05 », « 24:30 » (after midnight)
 *   headwayOf(cell)     → { min } | { none: true } | { error } | null   « 10 », « 10 min », « 10' », « toutes les
 *                                                       10 min », a time-formatted 0:10, « 1h30 »; « — », « pas de
 *                                                       service » = no service in that band
 *   dayTypeOf(text)     → { day, days, period, holidays, assumed?, qualifier?, label } | null   « LàV »,
 *                                                       « Lundi-Vendredi », « Sa », « Di/JF », « Scolaire », « Vacances »,
 *                                                       « LàV scolaire », « Semaine PS », « SEMAINE PVS », « GVS »…
 *                                                       — « - », « à », « au » make a range, « , », « et », « / », « & »
 *                                                       a list (« Lundi, Vendredi » is two days, never five)
 *   dayTypesOf(text)    → [dayType]   one cell naming several periods with the same days (« Semaine PS PVS »,
 *                                                       « Semaine PS / PVS »): one day type per period; [] when none
 *   isServedMark(text), isPassMark(text), bandHeadwayOf(text)   the marks of a timetable or a desserte grid
 *                                                       (« oui », « x », « ✓ » served without a time; « | », « — »,
 *                                                       « … », « ..... » not served) and a cell giving a band and its
 *                                                       headway instead of departures (« 7h-9h : 15 min »)
 *   tripLabelOf(cell)   → text | null                   a trip's label as a timetable numbers it: « 12 » (a number
 *                                                       cell too), « Course 3 », « N° 12 », « F1 », « D01 », « T-12 »,
 *                                                       « Course A », « 1re course » — never a place (« Quai 2 »,
 *                                                       « Arrêt 3 »: a word of its own)
 *   isNoteMark(text)                                    a note's mark beside a trip (« (1) », « a) », « * », « † »):
 *                                                       what the note says is no cell the reader reads
 *   stopKey(text)                                       a stop name's key (case, accents, punctuation aside), as the
 *                                                       feed's stop names are compared with a sheet's
 *   dateOf(cell)        → "YYYY-MM-DD" | { error } | null   a date serial, « 01/09/2026 », « 1/9/26 », « 2026-09-01 »,
 *                                                       « 1er septembre 2026 »
 *   periodOf(text)      → { from?, to? } | null          « du 01/09/2026 au 03/07/2027 », « 01/09/26 - 03/07/27 »,
 *                                                       « à partir du 2 novembre 2026 », « jusqu'au 3 juillet 2027 »
 *   bandOf(text)        → { from, to } (seconds) | null  a header « 6h-9h », « 06:00 – 09:00 », « HP matin (6h-9h) »,
 *                                                       « de 6h à 9h », « 9h > 16h30 »
 *   lineOf(text), directionOf(text) (a direction WORD: « Aller », « Retour », « les deux sens » — a number is not
 *                                                       one: « Sens 1 » is the operator's numbering, never a GTFS
 *                                                       direction_id), fold(text)
 *
 * A cell is { v (the raw value), t (SheetJS type: n, s, b, d, e), w (the text it displays), z (its number format) }.
 * French and English words; accents, case and spaces never matter (fold).
 */

"use strict";

const DOW = ["mon", "tue", "wed", "thu", "fri", "sat", "sun"];
const WEEKDAYS = ["mon", "tue", "wed", "thu", "fri"];
const DAY_S = 86400;

/** Lower case, no accents, one space, « à » → « a »: the form every keyword is matched in. */
const fold = (s) =>
  String(s ?? "")
    .normalize("NFD")
    .replace(/[̀-ͯ]/g, "")
    .toLowerCase()
    .replace(/[’`]/g, "'")
    .replace(/\s+/g, " ")
    .trim();

/** The text a cell shows (its formatted value when it has one). */
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
 * A clock time. An Excel serial is a fraction of a day (0.2534722 = 06:05; ≥ 1 past midnight); a whole number
 * without a time format (« 6 ») is not a time: is it 6 h or 6 min? (null — the column decides what to say). Text:
 * « 6:05 », « 06h05 », « 6h », « 6 h 05 », « 6:05:30 ». An error value (#REF!) is { error: "error_value" }.
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

/** "06:05" (or "25:10"); seconds only when the time has them. */
const hhmm = (sec) => {
  const h = Math.floor(sec / 3600);
  const m = Math.floor((sec % 3600) / 60);
  const s = sec % 60;
  return `${String(h).padStart(2, "0")}:${String(m).padStart(2, "0")}${s ? `:${String(s).padStart(2, "0")}` : ""}`;
};

// ── Headways ────────────────────────────────────────────────────────────────

const NO_SERVICE = new Set(["-", "--", "—", "–", "/", "x", "nc", "n/c", "ns", "pas de service", "sans service", "aucun service", "no service", "none", "non", "neant", "pas de passage", "pas de bus", "0"]);
const MAX_HEADWAY = 240;

/**
 * Minutes between two departures. A number (10; a time-formatted 0:10 is 10 min), « 10 », « 10 min », « 10' »,
 * « 10mn », « 10 minutes », « toutes les 10 min », « every 10 min », « 1h », « 1h30 ». « — », « x », « pas de
 * service » say there is no departure in that band ({ none: true }). « 10 à 12 min », « 10/12 » is a range: the
 * sheet does not say one headway ({ error: "headway_range" }).
 */
const headwayOf = (cell) => {
  if (!cell) return null;
  if (cell.t === "e") return { error: "error_value" };
  if (isNumber(cell)) {
    const v = cell.v;
    // A time-formatted cell (0:10) is a duration of a day's fraction.
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
// The summer holidays, apart from the others (« GVS », « grandes vacances », « été »): the engine names no such
// period (scope.js, calendars.js: school_days, school_holidays, public_holidays) — `summer_holidays` is a name the
// plan's calendars may define, else a clause or an operation carrying it asks for its dates, never the whole
// school_holidays (which also holds the short holidays a « PVS » column states apart). Checked before the others:
// « vacances d'été » holds « vacances ». « Été » alone names a season, not days: a day type only with its days
// (« Semaine été »), never weekdays assumed.
const SUMMER_WORDS = /\b(gvs|grandes vacances( scolaires)?|vacances d'ete|vacances ete|vacances estivales|ete|summer( holidays?)?)\b/;
const SUMMER_ALONE = /^(?:ete|summer)$/;
// A word that qualifies the period without naming its dates (« Semaine PS forte »: the weeks of strong demand the
// network knows): the day type is read with it, as an assumption (`assumed: ["qualifier"]`, a clause of status
// « assumed »: the person confirms those weeks are the period's), never dropped silently.
const QUALIFIER_WORDS = /\b(forte|faible|haute|basse|renforcee|reduite|allegee)\b/;
const NOISE = /\b(et|and|du|au|le|les|des|en|de|horaires?|jours?|type|periode|grille|regime)\b/g;

/**
 * A day type as an operator writes it: { day: "weekday" | "saturday" | "sunday" | "daily" | "mon"…| a list joined
 * by ",", days: [mon…], period: "school_days" | "school_holidays" | "summer_holidays" | null, holidays: bool
 * (« Di/JF »: Sundays and public holidays), assumed?: ["day" (« Scolaire » alone: the school weekdays, the days
 * not written) | "qualifier" (« forte »)], qualifier?, label }. null when the words are not a day type (or hold a
 * word it does not know, or two periods: never half a reading — dayTypesOf reads « Semaine PS PVS »).
 */
const dayTypeOf = (text) => {
  const label = String(text ?? "").trim();
  let s = fold(label).replace(/[()[\]{}.;:]/g, " ").replace(/\s+/g, " ").trim();
  if (!s || s.length > 60) return null;
  // « Di/JF », « D/JF », « DJF » before the separators go.
  s = s.replace(/\b7 ?\/ ?7\b/g, "tous les jours").replace(/\bd ?\/ ?jf\b/g, "dimanche jf").replace(/\bdi ?\/ ?jf\b/g, "dimanche jf").replace(/\bdim\.? ?(&|et) ?jf\b/g, "dimanche jf");
  // A list (« Lundi, Vendredi », « Sa/Di », « lundi et jeudi ») is never a range: its separators become a « , »
  // token the range phrases below cannot span; a range's (« Lundi-Vendredi », « Mon–Fri ») become spaces.
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
    // « Scolaire », « Vacances » alone: the weekdays of that period (the days are not written: said).
    WEEKDAYS.forEach((d) => days.add(d));
    assumed.push("day");
  }
  if (qualifier) assumed.push("qualifier");
  const list = DOW.filter((d) => days.has(d));
  const key = list.join(",");
  const day = key === WEEKDAYS.join(",") ? "weekday" : key === DOW.join(",") ? "daily" : key === "sat" ? "saturday" : key === "sun" ? "sunday" : key === "sat,sun" ? "weekend" : list.length === 1 ? list[0] : key;
  return { day, days: list, period, holidays, ...(assumed.length ? { assumed } : {}), ...(qualifier ? { qualifier } : {}), label };
};

// The period words a cell may name together (« Semaine PS PVS »): each read on its own with the cell's days.
const PERIOD_WORDS = [
  ["summer_holidays", SUMMER_WORDS, "ete"],
  ["school_holidays", VACATION_WORDS, "vacances"],
  ["school_days", SCHOOL_WORDS, "scolaire"],
];

/**
 * The day types one cell names: [dayTypeOf(text)] when it names one; when it names several periods with the same
 * days (« Semaine PS PVS », « Semaine PS / PVS »: the school weeks and the short holidays), one day type per period,
 * each labelled with the whole cell; [] when it names none (or a word no reading knows).
 */
const dayTypesOf = (text) => {
  const one = dayTypeOf(text);
  if (one) return [one];
  const label = String(text ?? "").trim();
  const s = fold(label).replace(/[()[\]{}.;:/&+,]/g, " ").replace(/\s+/g, " ").trim();
  if (!s || s.length > 60) return [];
  // Each period's words marked once (the summer first: « vacances d'été » holds « vacances »).
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
    // This period's word in place of its mark, the other periods' marks (and the « et » between them) removed.
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

/** The first date a text holds, from `start` on: { iso, index, end } | null. */
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

/** A date: an Excel date serial (a date format), or the text of one. */
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

// The day of the week a date may be written with (« à compter du lundi 4 janvier 2027 »): no part of the period's words.
const WEEKDAY_BEFORE = /\s*\b(?:lundi|mardi|mercredi|jeudi|vendredi|samedi|dimanche|monday|tuesday|wednesday|thursday|friday|saturday|sunday)\s*$/;
// The words that open or close a period whatever day of the week stands between them and the date (« à compter du
// lundi 4 janvier 2027 », « jusqu'au vendredi 2 juillet 2027 ») — never a bare « du » or « au »: « Horaires du samedi 9
// janvier 2027 » names that one day, « du lundi au vendredi 4 janvier 2027 » a range of days ending on a date; neither
// is a period.
const FROM_WITH_DAY = /\b(a partir du|a compter du|des le|depuis le|from)\s*$/;
const TO_WITH_DAY = /(jusqu'?au|\buntil)\s*$/;

/**
 * A period written in one cell: « du 01/09/2026 au 03/07/2027 », « 01/09/26 - 03/07/27 », « 2026-09-01 →
 * 2027-07-03 », « à partir du 2 novembre 2026 », « à compter du lundi 4 janvier 2027 » (from only), « jusqu'au 3
 * juillet 2027 » (to only), « valable du … au … ». → { from?, to? } (ISO dates) | { error: "invalid_period" } (dates in
 * the wrong order) | null — also for « du lundi au vendredi 4 janvier 2027 » (a range of days, no period's end).
 */
const periodOf = (text) => {
  const folded = fold(text);
  if (!folded) return null;
  const a = findDate(folded);
  if (!a) return null;
  const b = findDate(folded, a.end);
  const before = folded.slice(0, a.index);
  // The same words with the day of the week the date may carry taken out — read only after the words that say so.
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

// ── Bands (a header naming a time window) ───────────────────────────────────

const BAND_TEXT = /(\d{1,2})\s*(?:h|:)\s*(\d{2})?\s*(?:-|–|—|à|a|>|→|\/|to|jusqu'?a)\s*(\d{1,2})\s*(?:h|:)?\s*(\d{2})?/;

/** A time window a header names: « 6h-9h », « 06:00 – 09:00 », « HP matin (6h-9h) », « de 6h à 9h ». */
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

/** A line's name as the sheet writes it, without « Ligne » / « Line » / « L ». */
const lineOf = (text) => {
  const raw = String(text ?? "").trim();
  if (!raw) return null;
  const m = /^(?:ligne|line|lig\.?|route)\s*(?:n[°o]\s*)?[:\-–]?\s*(.+)$/i.exec(raw);
  const name = (m ? m[1] : raw).trim();
  return name && name.length <= 40 ? name : null;
};

const DIRECTION_WORDS = { aller: "aller", a: "aller", outbound: "aller", retour: "retour", r: "retour", inbound: "retour", "les deux sens": "both", "deux sens": "both", "2 sens": "both", both: "both", "both directions": "both", "aller-retour": "both", "aller retour": "both", "a/r": "both", ar: "both" };

/** A direction word: aller | retour | both — null for anything else (a destination, a number, say). */
const directionOf = (text) => {
  const k = fold(text).replace(/^sens\s*:?\s*/, "");
  return Object.prototype.hasOwnProperty.call(DIRECTION_WORDS, k) ? DIRECTION_WORDS[k] : null;
};

// ── Timetable marks ─────────────────────────────────────────────────────────

const PASS_MARKS = new Set(["|", "||", "-", "--", "—", "–", "↓", "↑", "·", "...", "…", "/", "nc"]);

/**
 * A cell that says « not served here » in a timetable (a pass-through or no stop): « | », « — », « … », and any run
 * of dots (« ..... »: a desserte grid writes it under a trip that skips a stop the others serve).
 */
const isPassMark = (text) => {
  const f = fold(text);
  return PASS_MARKS.has(f) || /^(?:\.\s?){2,}$|^…+$/.test(f);
};

/** A cell that says « served, no time given » in a desserte grid: « oui », « x », « ✓ ». */
const isServedMark = (text) => ["oui", "x", "✓", "✔", "☑", "√", "yes"].includes(fold(text));

// A band alone (« 7h-9h », « 07:00 – 09:00 », « de 7h à 9h »), the whole of the text before the headway.
const BAND_ALONE = /^(?:de\s+)?\d{1,2}\s*(?:h|:)\s*\d{0,2}\s*(?:-|–|—|a|>|→|\/|to)\s*\d{1,2}\s*(?:h|:)?\s*\d{0,2}$/;

/**
 * A timetable cell giving a band and its headway instead of departures (« 7h - 9h : 15 min », « 7h-9h : toutes les
 * 15 min »), merged over the trips it stands for: { from, to (seconds), min } | null. Only a band alone before the
 * colon and a headway in minutes after it: a stop name holding a time is not one.
 */
const bandHeadwayOf = (text) => {
  const m = /^(.*\S)\s*:\s*([^:]+)$/.exec(String(text ?? "").replace(/ /g, " ").trim());
  if (!m || !BAND_ALONE.test(fold(m[1])) || !/\d\s*(?:min|mn|minutes?|'|′)\s*$/.test(fold(m[2]))) return null;
  const band = bandOf(m[1]);
  const hw = headwayOf({ t: "s", v: m[2], w: m[2] });
  return band && hw && hw.min ? { from: band.from, to: band.to, min: hw.min } : null;
};

// ── Trips' labels and notes ─────────────────────────────────────────────────

// A trip's label: a word naming it as one (« Course », « Départ », « N° »), then a code of three letters at most and a
// number (« F1 », « D01 », « T-12 », « 12a »); « Course A »; « 1re course ». A longer word before the number is a name
// (« Quai 2 », « Arrêt 3 »). A stop named by a short code and a number (« ZI 2 », « RN 7 », « CHU 2 ») reads as a label
// too: a column made only of such names is set aside (unsure) rather than read — unless « Arrêts » heads it.
const TRIP_WORD = "(?:courses?|trajets?|services?|departs?|navettes?|voyages?|missions?|trips?|runs?)";
const TRIP_LABEL = new RegExp(`^(?:${TRIP_WORD}\\s*(?:n°|no|num|numero)?|n°|no|num|numero)?\\s*[.:]?\\s*(?:[a-z]{1,3}\\s*[-.]?\\s*)?\\d{1,5}[a-z]?$|^${TRIP_WORD}\\s+[a-z]$|^\\d{1,3}\\s*(?:er|ere|re|e|eme)\\s+${TRIP_WORD}$`);

/**
 * The label of a trip as a timetable numbers it, as written: a whole number (a number cell neither a time nor a date:
 * « 12 »), « Course 3 », « N° 12 », « F1 », « D01 » — or null. A timetable whose « stops » are all such labels is one
 * whose trips are written down its rows: never read as stops.
 */
const tripLabelOf = (cell) => {
  if (!cell) return null;
  if (isNumber(cell)) return Number.isInteger(cell.v) && cell.v > 0 && cell.v < 100000 && !looksTimeFormatted(cell) && !looksDateFormatted(cell) ? String(cell.v) : null;
  if (cell.t !== "s") return null;
  const text = textOf(cell);
  return text && TRIP_LABEL.test(fold(text)) ? text : null;
};

/** A note's mark beside a trip (« (1) », « (a) », « 1) », « * », « ** », « † », « ¹ »): the note itself is elsewhere. */
const isNoteMark = (text) => /^(?:\(\s*[0-9a-z]{1,3}\s*\)|[0-9a-z]{1,2}\s*\)|\*{1,3}|[†‡§]{1,2}|[¹²³⁴⁵⁶⁷⁸⁹⁰]{1,2})$/i.test(String(text ?? "").trim());

/** A stop name's key: case, accents and punctuation aside (« Place Jean-Jaurès » is « place jean jaures »). */
const stopKey = (text) => fold(text).replace(/[^a-z0-9]+/g, " ").trim();

module.exports = { fold, textOf, timeOf, hhmm, headwayOf, dayTypeOf, dayTypesOf, dateOf, periodOf, bandOf, lineOf, directionOf, isPassMark, isServedMark, bandHeadwayOf, tripLabelOf, isNoteMark, stopKey, looksTimeFormatted, DOW, WEEKDAYS };
