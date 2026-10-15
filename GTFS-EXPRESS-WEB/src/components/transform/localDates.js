/**
 * localDates — dates as the reader writes them (the app's language, not
 * the browser's): the operation form shows and parses "05/10/2026" in
 * French, "10/05/2026" in English, "05.10.2026" in German…, while plans
 * keep ISO dates (YYYY-MM-DD) that the engine reads.
 *
 *   toIso(v)                        "20261005" | "2026-10-05" | Date → "2026-10-05" | null
 *   formatDate(v, lang, style)      "short" → 05/10/2026, "long" → 5 octobre 2026, "full" → lundi 5 octobre 2026
 *   datePattern(lang)               { order: ["day","month","year"], sep: "/" } + placeholder()
 *   parseDateInput(text, lang)      the reader's text (or ISO) → "2026-10-05" | null
 */

const pad = (n) => String(n).padStart(2, "0");

/** A valid calendar date (no 31 February). */
const valid = (y, m, d) => {
  if (!(y >= 1900 && y <= 2200 && m >= 1 && m <= 12 && d >= 1 && d <= 31)) return false;
  const dt = new Date(Date.UTC(y, m - 1, d));
  return dt.getUTCFullYear() === y && dt.getUTCMonth() === m - 1 && dt.getUTCDate() === d;
};

export const toIso = (v) => {
  if (v == null || v === "") return null;
  if (v instanceof Date) return Number.isNaN(v.getTime()) ? null : `${v.getFullYear()}-${pad(v.getMonth() + 1)}-${pad(v.getDate())}`;
  const m = /^(\d{4})-?(\d{2})-?(\d{2})$/.exec(String(v).trim());
  if (!m) return null;
  const [y, mo, d] = [Number(m[1]), Number(m[2]), Number(m[3])];
  return valid(y, mo, d) ? `${m[1]}-${m[2]}-${m[3]}` : null;
};

/** A local-time Date of an ISO/GTFS date (midday: no timezone slip). */
export const toDate = (v) => {
  const iso = toIso(v);
  if (!iso) return null;
  const [y, m, d] = iso.split("-").map(Number);
  return new Date(y, m - 1, d, 12);
};

// Latin digits whatever the language (the inputs are typed with them).
const locale = (lang) => `${String(lang || "en").slice(0, 2)}-u-nu-latn`;

const STYLES = {
  short: { day: "2-digit", month: "2-digit", year: "numeric" },
  long: { day: "numeric", month: "long", year: "numeric" },
  full: { weekday: "long", day: "numeric", month: "long", year: "numeric" },
  dayMonth: { day: "numeric", month: "long" },
};

export const formatDate = (v, lang = "en", style = "short") => {
  const d = toDate(v);
  if (!d) return v == null ? "" : String(v);
  try {
    return new Intl.DateTimeFormat(locale(lang), STYLES[style] || STYLES.short).format(d);
  } catch {
    return toIso(v);
  }
};

/** The order and separator of the short date in a language. */
export const datePattern = (lang = "en") => {
  try {
    const parts = new Intl.DateTimeFormat(locale(lang), STYLES.short).formatToParts(new Date(2026, 9, 5, 12));
    const order = parts.filter((p) => ["day", "month", "year"].includes(p.type)).map((p) => p.type);
    const sep = (parts.find((p) => p.type === "literal")?.value || "/").replace(/[‎‏]/g, "").trim() || "/";
    if (order.length === 3) return { order, sep };
  } catch {
    /* an unknown locale: the ISO order */
  }
  return { order: ["year", "month", "day"], sep: "-" };
};

/** "jj/mm/aaaa"-like placeholder from the pattern and the language's letters. */
export const datePlaceholder = (lang = "en", letters = { day: "dd", month: "mm", year: "yyyy" }) => {
  const { order, sep } = datePattern(lang);
  return order.map((k) => letters[k]).join(sep);
};

/** The reader's text → ISO, in the language's order (ISO and YYYYMMDD accepted too). */
export const parseDateInput = (text, lang = "en") => {
  const s = String(text || "").trim();
  if (!s) return null;
  const iso = toIso(s);
  if (iso) return iso;
  const nums = s.split(/[^0-9]+/).filter(Boolean);
  if (nums.length !== 3) return null;
  const { order } = datePattern(lang);
  const got = {};
  order.forEach((k, i) => {
    got[k] = Number(nums[i]);
  });
  if (String(nums[order.indexOf("year")]).length === 2) got.year += 2000;
  return valid(got.year, got.month, got.day) ? `${got.year}-${pad(got.month)}-${pad(got.day)}` : null;
};

/** "07:30" → "7 h 30" in French, "07:30" elsewhere (how a brief is written). */
export const formatClock = (hhmm, lang = "en") => {
  const m = /^(\d{1,2}):(\d{2})/.exec(String(hhmm || ""));
  if (!m) return String(hhmm || "");
  const h = Number(m[1]);
  if (String(lang).startsWith("fr")) return m[2] === "00" ? `${h} h` : `${h} h ${m[2]}`;
  return `${pad(h)}:${m[2]}`;
};

/** Days between two dates (ISO or GTFS). */
export const addDaysIso = (v, n) => {
  const d = toDate(v);
  if (!d) return null;
  d.setDate(d.getDate() + n);
  return toIso(d);
};
