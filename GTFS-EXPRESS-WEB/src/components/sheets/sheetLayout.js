/**
 * How a sheet the server computed is laid on paper: the paper, the hours across the page, regular headways folded
 * into « every n min », the line's colours on white, the school holidays, the QR code's address, and the fitting of a
 * page's text to its paper. Pure functions, but `fitPage` which measures a page laid out in the document.
 */

export const FORMATS = Object.freeze({ a4p: { w: 210, h: 297 }, a4l: { w: 297, h: 210 }, a3p: { w: 297, h: 420 }, a3l: { w: 420, h: 297 }, a5p: { w: 148, h: 210 } });
export const FORMAT_KEYS = Object.freeze(Object.keys(FORMATS));

export const paperOf = (prefs) => FORMATS[prefs.format] || FORMATS.a4p;

/** The text's base size: 9 pt on A4, in proportion to the paper's short side (A3 larger, A5 smaller); larger for large print. */
export const baseSizeOf = (paper, large) => Math.round((Math.min(paper.w, paper.h) / 210) * 9 * (large ? 1.2 : 1) * 10) / 10;

const MIN_HOURS = 12;
/**
 * The hours a block's grids run across: from 5 h (earlier when a departure is) to the last departure's hour, twelve
 * columns at least so a short service keeps a regular grid, the same for its day types so their columns line up.
 */
export const hoursOf = (block) => {
  const hs = block.hours.map((x) => x.h);
  const from = Math.min(5, ...hs);
  const to = Math.max(from + MIN_HOURS - 1, ...hs);
  return Array.from({ length: to - from + 1 }, (_, i) => from + i);
};

export const PATH_MAX = 26;
/**
 * The rows of a line's path on the page: every stop when they fit, else the stops already passed folded into one row
 * (the origin and the two before the sheet's stop kept), the stops to come never folded (they are what the sheet
 * tells). [{ stop, i }] or [{ fold: n }].
 */
export const foldPath = (path, max = PATH_MAX) => {
  const rows = path.stops.map((stop, i) => ({ stop, i }));
  const here = path.here;
  const hidden = here - 3;
  if (rows.length <= max || hidden < 2) return rows;
  return [rows[0], { fold: hidden }, ...rows.slice(here - 2)];
};

/** A time as the sheet's language writes it: « 07h05 » in French, « 07:05 » elsewhere. */
export const timeOf = (labels, clock) => {
  if (!clock) return "";
  const [h, m] = clock.split(":");
  return String(labels?.time || "{h}:{m}").replace("{h}", h).replace("{m}", m);
};

const MAX_GAP_S = 15 * 60;
const MAX_SPREAD_S = 2 * 60;
const MIN_RUN_S = 2 * 3600;

/**
 * One day type's grid over `hours`: per hour its departures, and the bands where the departures leave at a steady
 * rhythm (gaps within two minutes of each other, 15 minutes at most, none carrying a note) over three whole hours or
 * more, as { from, span, lo, hi } in hour indexes and minutes.
 */
export const gridOf = (block, column, hours, fold) => {
  const byHour = new Map(block.hours.map((x, i) => [x.h, column.cells[i] || []]));
  const cells = hours.map((h) => byHour.get(h) || []);
  const bands = [];
  if (!fold) return { cells, bands };
  const deps = cells.flat().slice().sort((a, b) => a.sec - b.sec);
  const runs = [];
  let i = 0;
  while (i < deps.length - 1) {
    if (deps[i].mark) {
      i += 1;
      continue;
    }
    let j = i;
    let lo = Infinity;
    let hi = 0;
    while (j + 1 < deps.length && !deps[j + 1].mark) {
      const gap = deps[j + 1].sec - deps[j].sec;
      const nlo = Math.min(lo, gap);
      const nhi = Math.max(hi, gap);
      if (gap <= 0 || nhi > MAX_GAP_S || nhi - nlo > MAX_SPREAD_S) break;
      [lo, hi, j] = [nlo, nhi, j + 1];
    }
    if (j > i && deps[j].sec - deps[i].sec >= MIN_RUN_S) runs.push({ from: deps[i].sec, to: deps[j].sec, lo, hi });
    i = j > i ? j : i + 1;
  }
  // An hour is folded when the run covers it whole: its first departure within a gap of its start, its last of its end.
  const inRun = hours.map((h, k) => runs.find((r) => cells[k].length > 0 && r.from <= h * 3600 + r.hi && r.to >= (h + 1) * 3600 - r.hi && cells[k].every((c) => c.sec >= r.from && c.sec <= r.to)) || null);
  for (let k = 0; k < hours.length; k++) {
    if (!inRun[k]) continue;
    let end = k;
    while (end + 1 < hours.length && inRun[end + 1] === inRun[k]) end += 1;
    if (end - k + 1 >= 3) bands.push({ from: k, span: end - k + 1, lo: Math.round(inRun[k].lo / 60), hi: Math.round(inRun[k].hi / 60) });
    k = end;
  }
  return { cells, bands };
};

const hexRgb = (hex) => [0, 2, 4].map((i) => parseInt(String(hex).slice(i, i + 2), 16));
const mix = (hex, share) => {
  const [r, g, b] = hexRgb(hex);
  const m = (c) => Math.round(c * share + 255 * (1 - share));
  return `rgb(${m(r)}, ${m(g)}, ${m(b)})`;
};
const luminance = (hex) => {
  const [r, g, b] = hexRgb(hex);
  return (0.299 * r + 0.587 * g + 0.114 * b) / 255;
};

/** The line's colours on the sheet: its own, a soft one for the stop's label, a pale one for the stops passed, and an ink readable on white. */
export const routeColorsOf = (route) => ({
  "--gx-route": `#${route.color}`,
  "--gx-route-text": `#${route.text}`,
  "--gx-route-soft": mix(route.color, 0.28),
  "--gx-route-pale": mix(route.color, 0.3),
  "--gx-route-ink": luminance(route.color) > 0.62 ? "#1a1a1a" : `#${route.color}`,
});

const shortDate = (iso, language) => new Intl.DateTimeFormat(language, { day: "2-digit", month: "2-digit", year: "2-digit", timeZone: "UTC" }).format(new Date(`${iso}T00:00:00Z`));
// « Vacances de la Toussaint » reads « Toussaint » in a box titled « Vacances scolaires ».
const holidayName = (name) => {
  const short = String(name || "").replace(/^vacances\s+(de\s+la\s+|de\s+l['’]|du\s+|des\s+|de\s+|d['’])?/i, "");
  return short.charAt(0).toLocaleUpperCase() + short.slice(1);
};
/** The school holidays the period meets, as the sheet lists them. */
export const schoolLinesOf = (school, language) => (school?.periods || []).filter((p) => !p.assumed).map((p) => ({ name: holidayName(p.name), from: shortDate(p.from, language), to: shortDate(p.to, language) }));

/** The QR code's address for a stop: {stop_id}, {stop_code} and {stop_name} replaced, URL-encoded. */
export const qrAddressOf = (template, stop) =>
  String(template || "")
    .trim()
    .replace(/\{stop_id\}/g, encodeURIComponent(stop.id))
    .replace(/\{stop_code\}/g, encodeURIComponent(stop.code || stop.id))
    .replace(/\{stop_name\}/g, encodeURIComponent(stop.name));

const MIN_SCALE = 0.6;
/**
 * Shrinks a page's text until it fits its paper: the elements marked data-fit must not overflow. Returns the scale
 * kept and whether the page still overflows at the smallest one.
 */
export const fitPage = (page) => {
  if (!page) return { scale: 1, overflow: false };
  const boxes = () => [...page.querySelectorAll("[data-fit]")];
  const overflowing = () => boxes().some((el) => el.scrollHeight > el.clientHeight + 1 || el.scrollWidth > el.clientWidth + 1);
  let scale = 1;
  page.style.setProperty("--gx-scale", "1");
  for (let i = 0; i < 8 && overflowing(); i++) {
    const ratio = Math.min(...boxes().map((el) => Math.min(el.clientHeight / Math.max(1, el.scrollHeight), el.clientWidth / Math.max(1, el.scrollWidth))));
    scale = Math.max(MIN_SCALE, Math.min(scale * 0.97, scale * ratio * 0.99));
    page.style.setProperty("--gx-scale", String(scale));
    if (scale === MIN_SCALE) break;
  }
  return { scale, overflow: overflowing() };
};
