/**
 * exampleBriefs — example requests written from the loaded feed, so that
 * each one names lines that exist and a date inside the feed's validity
 * (a static text citing "line 12" would send the planner after a line the
 * feed does not have).
 *
 *   buildExampleBriefs(overview, { t, language, today }) → [{ key, text }]
 *
 * From the overview (/transform/overview): the busiest line on weekdays
 * gets a higher morning frequency, a line with a weekday service gets a
 * later last departure or a Sunday service, and works close another line
 * for a fortnight. The date is the first Monday at least two weeks ahead,
 * kept inside the validity. Without lines, examples that fit any feed.
 */

import { addDaysIso, formatClock, formatDate, toIso } from "./localDates";

const LADDER = [5, 6, 8, 10, 12, 15, 20, 30];
const lineName = (r) => r.short_name || r.long_name || r.id;
const weekdayOf = (r) => r.service?.weekday || null;
const toMin = (hhmm) => {
  const m = /^(\d{1,2}):(\d{2})/.exec(String(hhmm || ""));
  return m ? Number(m[1]) * 60 + Number(m[2]) : null;
};
const toHhmm = (min) => `${String(Math.floor(min / 60)).padStart(2, "0")}:${String(min % 60).padStart(2, "0")}`;

/** The first Monday ≥ today + 14 days, kept inside the validity range. */
export const exampleStartDate = (range, today = new Date()) => {
  const start = toIso(range?.start);
  const end = toIso(range?.end);
  let d = addDaysIso(today, 14);
  if (start && d < start) d = start;
  if (end && d > end) d = addDaysIso(start || end, 7) || end;
  // Next Monday (0 = Sunday).
  const dt = new Date(`${d}T12:00:00`);
  const shift = (8 - dt.getDay()) % 7;
  let monday = addDaysIso(d, shift);
  if (end && monday > end) monday = d;
  return monday;
};

/** A round headway below the one measured at the morning peak (every 10 min when unknown). */
const betterHeadway = (service) => {
  const hs = Object.values(service?.directions || {}).map((d) => d?.headways?.am_peak).filter((x) => Number.isFinite(x) && x > 0);
  if (!hs.length) return 10;
  const now = Math.min(...hs);
  const lower = LADDER.filter((x) => x < now);
  return lower.length ? lower[lower.length - 1] : Math.max(5, Math.round(now));
};

const lastDeparture = (service) => {
  const lasts = Object.values(service?.directions || {}).map((d) => toMin(d?.last)).filter((x) => x != null);
  return lasts.length ? Math.max(...lasts) : null;
};

export const buildExampleBriefs = (overview, { t, language = "en", today = new Date() } = {}) => {
  const routes = (overview?.routes || []).filter((r) => lineName(r));
  const date = exampleStartDate(overview?.range, today);
  const fmt = (d) => formatDate(d, language, "long");
  if (!routes.length) {
    const end = toIso(overview?.range?.end);
    return [
      { key: "holidays", text: t("transform.example.holidays") },
      ...(end ? [{ key: "validity", text: t("transform.example.validity", { date: fmt(addDaysIso(end, 90)) }) }] : []),
    ];
  }
  const out = [];
  const withWeekday = routes.filter((r) => weekdayOf(r)?.trips);
  const busiest = [...withWeekday].sort((a, b) => (weekdayOf(b).trips || 0) - (weekdayOf(a).trips || 0))[0] || routes[0];
  out.push({ key: "headway", text: t("transform.example.headway", { line: lineName(busiest), minutes: betterHeadway(weekdayOf(busiest)), from: formatClock("07:00", language), to: formatClock("09:00", language), date: fmt(date) }) });

  const others = withWeekday.filter((r) => r !== busiest);
  const noSunday = others.find((r) => !r.service?.sunday && r.service?.saturday);
  const evening = others.find((r) => {
    const last = lastDeparture(weekdayOf(r));
    return last != null && last < 22 * 60;
  });
  if (noSunday) out.push({ key: "sunday", text: t("transform.example.sunday", { line: lineName(noSunday), date: fmt(date) }) });
  else if (evening) {
    const last = lastDeparture(weekdayOf(evening));
    const later = Math.min(24 * 60 - 30, Math.ceil((last + 60) / 30) * 30);
    out.push({ key: "evening", text: t("transform.example.evening", { line: lineName(evening), time: formatClock(toHhmm(later), language), current: formatClock(toHhmm(last), language), date: fmt(date) }) });
  }

  const closed = others[others.length - 1] || null;
  if (closed && closed !== noSunday && closed !== evening) {
    const to = addDaysIso(date, 13);
    const end = toIso(overview?.range?.end);
    out.push({ key: "works", text: t("transform.example.works", { line: lineName(closed), other: lineName(busiest), from: fmt(date), to: fmt(end && to > end ? end : to) }) });
  } else out.push({ key: "holidays", text: t("transform.example.holidays") });
  return out.slice(0, 3);
};
