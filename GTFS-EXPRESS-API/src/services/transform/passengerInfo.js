/**
 * passengerInfo — what riders must be told about a change plan: the
 * service alerts (GTFS-Realtime) and a notice to post, generated from what
 * the plan actually changes, never from what it was meant to do.
 *
 *   passengerAlerts(before, after, diff) → [{
 *     id, effect, routes: [{ id, label }], stops: { lost: [{ id, name }], gained: [...] },
 *     period: { from, to },              // YYYYMMDD, the dates that change
 *     open_ended: bool,                  // runs to the end of the validity ("from … on")
 *     day, facts: [{ code, … }]           // what changes, as codes (phrased per language)
 *   }]
 *     One alert per line and period; lines changed the same way over the
 *     same dates share one (a detour of B and C). Effects (GTFS-RT):
 *     NO_SERVICE (a line stops running), ADDITIONAL_SERVICE (more trips, a
 *     new day), REDUCED_SERVICE (fewer trips, stops no longer served),
 *     DETOUR (stops replaced over a period), STOP_MOVED (a stop moved),
 *     MODIFIED_SERVICE (times), OTHER_EFFECT (a line renamed).
 *
 *   renderAlerts(alerts, { language, timezone, cause, now }) → {
 *     feed: FeedMessage (protobuf JSON mapping, camelCase),
 *     notice: { language, title, text },   // for a website or a stop poster
 *   }
 *   encodeFeed(feed) → Buffer (application/x-protobuf)
 *
 * Texts in French and English (others fall back to English); dates in the
 * agency's timezone; an alert's active period covers its first date at
 * 00:00 to its last date + 1 at 04:00 (the service day's night trips).
 */

"use strict";

const { tripsOfRoute } = require("./feedModel");
const { addDays, dowOf } = require("./feedModel")._internals;

const EFFECT_RANK = ["NO_SERVICE", "DETOUR", "STOP_MOVED", "REDUCED_SERVICE", "ADDITIONAL_SERVICE", "MODIFIED_SERVICE", "OTHER_EFFECT"];
const NEAR_M = 400;

const stopsServed = (model, routeId, date) => {
  const out = new Set();
  for (const t of tripsOfRoute(model, routeId)) if (model.runsOn(t.service_id, date)) for (const s of t.stops) out.add(s);
  return out;
};
const distM = (a, b) => (a && b && a.lat != null && b.lat != null ? Math.hypot((a.lat - b.lat) * 111320, (a.lon - b.lon) * 111320 * Math.cos((a.lat * Math.PI) / 180)) : Infinity);
const byName = (list) => {
  const seen = new Map();
  for (const s of list) if (!seen.has(s.name)) seen.set(s.name, s);
  return [...seen.values()];
};

const passengerAlerts = (before, after, diff) => {
  const end = after.range?.end || before.range?.end || null;
  const raw = [];
  for (const r of diff.routes || []) {
    const route = { id: r.id, label: r.label };
    if (r.status === "added") {
      raw.push({ effect: "ADDITIONAL_SERVICE", routes: [route], stops: { lost: [], gained: [] }, period: { from: after.range?.start, to: end }, open_ended: true, day: null, facts: [{ code: "route_added" }] });
      continue;
    }
    if (r.status === "removed") {
      raw.push({ effect: "NO_SERVICE", routes: [route], stops: { lost: [], gained: [] }, period: { from: before.range?.start, to: end }, open_ended: true, day: null, facts: [{ code: "route_removed" }] });
      continue;
    }
    for (const a of r.attributes || []) if (a.field === "short_name") raw.push({ effect: "OTHER_EFFECT", routes: [route], stops: { lost: [], gained: [] }, period: { from: after.range?.start, to: end }, open_ended: true, day: null, facts: [{ code: "renamed", before: a.before, after: a.after }] });
    for (const p of r.periods || []) {
      const span = p.span || (p.dates ? { from: p.dates.from, to: p.dates.to } : null);
      if (!span) continue;
      const sb = stopsServed(before, r.id, p.date);
      const sa = stopsServed(after, r.id, p.date);
      const lost = byName([...sb].filter((s) => !sa.has(s)).map((s) => ({ id: s, name: before.stops.get(s)?.name || s }))).filter((s) => ![...sa].some((x) => after.stops.get(x)?.name === s.name));
      const gained = byName([...sa].filter((s) => !sb.has(s)).map((s) => ({ id: s, name: after.stops.get(s)?.name || s }))).filter((s) => ![...sb].some((x) => before.stops.get(x)?.name === s.name));
      const tb = p.before?.trips || 0;
      const ta = p.after?.trips || 0;
      let effect;
      if (tb > 0 && ta === 0) effect = "NO_SERVICE";
      else if (lost.length && gained.length) {
        const moved = lost.length === 1 && gained.length === 1 && distM(before.stops.get(lost[0].id), after.stops.get(gained[0].id)) <= NEAR_M;
        effect = moved ? "STOP_MOVED" : "DETOUR";
      } else if (lost.length) effect = "REDUCED_SERVICE";
      else if (ta > tb) effect = "ADDITIONAL_SERVICE";
      else if (ta < tb) effect = "REDUCED_SERVICE";
      else effect = "MODIFIED_SERVICE";
      const facts = [];
      if (tb === 0 && ta > 0) facts.push({ code: "new_day", trips: ta });
      else if (ta === 0) facts.push({ code: "no_service" });
      else {
        const seen = new Set();
        for (const c of p.changes || []) {
          const f = c.code === "headway" ? { code: "headway", period: c.period, before: c.before, after: c.after } : ["first", "last", "running"].includes(c.code) ? { code: c.code, before: c.before, after: c.after } : null;
          if (!f) continue;
          const k = JSON.stringify(f);
          if (seen.has(k)) continue;
          seen.add(k);
          facts.push(f);
        }
        if (ta !== tb) facts.push({ code: "trips", before: tb, after: ta });
      }
      if (lost.length) facts.push({ code: "stops_lost", stops: lost.map((s) => s.name) });
      if (gained.length) facts.push({ code: "stops_gained", stops: gained.map((s) => s.name) });
      if (!facts.length) facts.push({ code: "retimed" });
      if (ta === 0) {
        // The line does not run at all: its stops are not news of their own.
        const k = facts.findIndex((f) => f.code === "stops_lost");
        if (k >= 0) facts.splice(k, 1);
      }
      raw.push({ effect, routes: [route], stops: ta === 0 ? { lost: [], gained: [] } : { lost, gained }, period: { from: span.from, to: span.to }, count: span.count || null, open_ended: Boolean(end && span.to >= addDays(end, -6)), day: p.day, facts });
    }
  }
  // One event (a detour, a closure) over several day types is one alert:
  // its periods merge when they overlap or touch (within a week).
  const EVENTS = new Set(["DETOUR", "NO_SERVICE", "STOP_MOVED"]);
  const stopKey = (a) => JSON.stringify([a.stops.lost.map((x) => x.name).sort(), a.stops.gained.map((x) => x.name).sort()]);
  const events = [];
  const rest = [];
  for (const a of raw) (EVENTS.has(a.effect) ? events : rest).push(a);
  const joined = [];
  for (const a of events.sort((x, y) => String(x.period.from).localeCompare(String(y.period.from)))) {
    const m = joined.find((x) => x.effect === a.effect && x.routes[0].id === a.routes[0].id && stopKey(x) === stopKey(a) && a.period.from <= addDays(x.period.to, 7));
    if (m) {
      if (a.period.to > m.period.to) m.period.to = a.period.to;
      m.open_ended = m.open_ended || a.open_ended;
      m.count = (m.count || 0) + (a.count || 0);
      if (m.day !== a.day) m.day = null;
    } else joined.push({ ...a, period: { ...a.period } });
  }
  // Lines changed the same way over the same dates share one alert (a detour of B and C).
  const factKey = (a) => (EVENTS.has(a.effect) ? stopKey(a) : JSON.stringify(a.facts));
  const merged = [];
  for (const a of [...joined, ...rest]) {
    const m = merged.find((x) => x.effect === a.effect && x.period.from === a.period.from && x.period.to === a.period.to && x.day === a.day && factKey(x) === factKey(a));
    if (m) {
      m.routes.push(...a.routes);
      for (const st of a.stops.lost) if (!m.stops.lost.some((x) => x.id === st.id)) m.stops.lost.push(st);
      for (const st of a.stops.gained) if (!m.stops.gained.some((x) => x.id === st.id)) m.stops.gained.push(st);
    } else merged.push({ ...a, routes: [...a.routes], stops: { lost: [...a.stops.lost], gained: [...a.stops.gained] } });
  }
  return merged
    .map((a) => ({ ...a, facts: a.facts.map((f) => (f.stops ? { ...f, stops: [...new Set(f.stops)].sort((x, y) => x.localeCompare(y)) } : f)), partial: partialOf(a) }))
    .sort((x, y) => EFFECT_RANK.indexOf(x.effect) - EFFECT_RANK.indexOf(y.effect) || String(x.period.from).localeCompare(String(y.period.from)))
    .map((a, i) => ({ id: `alert-${i + 1}`, ...a }));
};

/**
 * Whether an alert covers only some of the days between its first and last
 * date (the school holidays inside a range, say): then its text says how
 * many days rather than "from … to …".
 */
const partialOf = (a) => {
  if (!a.count || !a.period.from || !a.period.to || a.open_ended) return null;
  const dows = a.day === "weekday" ? ["mon", "tue", "wed", "thu", "fri"] : a.day === "saturday" ? ["sat"] : a.day === "sunday" ? ["sun"] : a.day ? a.day.split("+") : null;
  if (!dows) return null;
  let possible = 0;
  for (let d = a.period.from, i = 0; d <= a.period.to && i < 1200; d = addDays(d, 1), i++) if (dows.includes(dowOf(d))) possible += 1;
  return a.count < possible * 0.8 ? { count: a.count } : null;
};

// ── Texts ───────────────────────────────────────────────────────────────────

const MONTHS = {
  fr: ["janvier", "février", "mars", "avril", "mai", "juin", "juillet", "août", "septembre", "octobre", "novembre", "décembre"],
  en: ["January", "February", "March", "April", "May", "June", "July", "August", "September", "October", "November", "December"],
};
const T = {
  fr: {
    line: (ls) => (ls.length > 1 ? `Lignes ${ls.join(", ")}` : `Ligne ${ls[0]}`),
    from: (d) => `à partir du ${d}`,
    on: (d) => `le ${d}`,
    range: (a, b) => `du ${a} au ${b}`,
    some: (n, a, b) => `sur ${n} jours entre le ${a} et le ${b}`,
    day: { weekday: "du lundi au vendredi", saturday: "le samedi", sunday: "le dimanche" },
    dows: { mon: "lundi", tue: "mardi", wed: "mercredi", thu: "jeudi", fri: "vendredi", sat: "samedi", sun: "dimanche" },
    period: { early: "tôt le matin", am_peak: "de 7 h à 9 h", midday: "de 9 h à 16 h", pm_peak: "de 16 h à 19 h", evening: "après 19 h" },
    head: {
      NO_SERVICE: "ne circule pas",
      DETOUR: "déviation",
      STOP_MOVED: "arrêt déplacé",
      REDUCED_SERVICE: "service réduit",
      ADDITIONAL_SERVICE: "service renforcé",
      MODIFIED_SERVICE: "horaires modifiés",
      OTHER_EFFECT: "changement",
    },
    fact: {
      route_added: () => "Nouvelle ligne.",
      route_removed: () => "La ligne est supprimée.",
      renamed: (f) => `La ligne ${f.before} devient la ligne ${f.after}.`,
      new_day: (f, day) => `Nouveau service ${day || ""} : ${f.trips} départs.`.replace("  ", " "),
      no_service: () => "Aucun départ.",
      headway: (f, day, per) => `${cap(day)}${per ? `, ${per}` : ""} : un départ toutes les ${f.after} min${f.before ? ` (au lieu de ${f.before})` : ""}.`,
      first: (f, day) => `${cap(day)} : premier départ à ${hm(f.after)}${f.before ? ` (au lieu de ${hm(f.before)})` : ""}.`,
      last: (f, day) => `${cap(day)} : dernier départ à ${hm(f.after)}${f.before ? ` (au lieu de ${hm(f.before)})` : ""}.`,
      running: (f) => `Temps de parcours : ${f.after} min (au lieu de ${f.before}).`,
      trips: (f, day) => `${cap(day)} : ${f.after} départs (au lieu de ${f.before}).`,
      stops_lost: (f) => `${f.stops.length > 1 ? "Arrêts non desservis" : "Arrêt non desservi"} : ${f.stops.join(", ")}.`,
      stops_gained: (f) => `${f.stops.length > 1 ? "Arrêts desservis" : "Arrêt desservi"} : ${f.stops.join(", ")}.`,
      retimed: () => "Les horaires changent : consultez les nouvelles fiches horaires.",
    },
    notice: "Information voyageurs",
  },
  en: {
    line: (ls) => (ls.length > 1 ? `Lines ${ls.join(", ")}` : `Line ${ls[0]}`),
    from: (d) => `from ${d}`,
    on: (d) => `on ${d}`,
    range: (a, b) => `from ${a} to ${b}`,
    some: (n, a, b) => `on ${n} days between ${a} and ${b}`,
    day: { weekday: "Monday to Friday", saturday: "on Saturdays", sunday: "on Sundays" },
    dows: { mon: "Monday", tue: "Tuesday", wed: "Wednesday", thu: "Thursday", fri: "Friday", sat: "Saturday", sun: "Sunday" },
    period: { early: "early morning", am_peak: "7–9 am", midday: "9 am–4 pm", pm_peak: "4–7 pm", evening: "after 7 pm" },
    head: {
      NO_SERVICE: "no service",
      DETOUR: "detour",
      STOP_MOVED: "stop moved",
      REDUCED_SERVICE: "reduced service",
      ADDITIONAL_SERVICE: "more service",
      MODIFIED_SERVICE: "new times",
      OTHER_EFFECT: "change",
    },
    fact: {
      route_added: () => "New line.",
      route_removed: () => "The line is withdrawn.",
      renamed: (f) => `Line ${f.before} becomes line ${f.after}.`,
      new_day: (f, day) => `New service ${day || ""}: ${f.trips} departures.`.replace("  ", " "),
      no_service: () => "No departures.",
      headway: (f, day, per) => `${cap(day)}${per ? `, ${per}` : ""}: every ${f.after} min${f.before ? ` (was ${f.before})` : ""}.`,
      first: (f, day) => `${cap(day)}: first departure at ${hm(f.after)}${f.before ? ` (was ${hm(f.before)})` : ""}.`,
      last: (f, day) => `${cap(day)}: last departure at ${hm(f.after)}${f.before ? ` (was ${hm(f.before)})` : ""}.`,
      running: (f) => `Journey time: ${f.after} min (was ${f.before}).`,
      trips: (f, day) => `${cap(day)}: ${f.after} departures (was ${f.before}).`,
      stops_lost: (f) => `${f.stops.length > 1 ? "Stops not served" : "Stop not served"}: ${f.stops.join(", ")}.`,
      stops_gained: (f) => `${f.stops.length > 1 ? "Stops served" : "Stop served"}: ${f.stops.join(", ")}.`,
      retimed: () => "Times change: see the new timetables.",
    },
    notice: "Service change",
  },
};
const cap = (s) => (s ? s[0].toUpperCase() + s.slice(1) : "");
const hm = (t) => String(t || "").slice(0, 5);
const fmtDate = (ymd, lang) => {
  const d = Number(ymd.slice(6, 8));
  const m = MONTHS[lang][Number(ymd.slice(4, 6)) - 1];
  return lang === "fr" ? `${d === 1 ? "1er" : d} ${m} ${ymd.slice(0, 4)}` : `${d} ${m} ${ymd.slice(0, 4)}`;
};
const whenText = (a, L, lang) => {
  const { from, to } = a.period;
  if (!from) return "";
  if (a.open_ended) return L.from(fmtDate(from, lang));
  if (from === to) return L.on(fmtDate(from, lang));
  // "du 2 au 20 novembre 2026", "du 21 décembre 2026 au 7 mai 2027"
  const sameYear = from.slice(0, 4) === to.slice(0, 4);
  const sameMonth = sameYear && from.slice(4, 6) === to.slice(4, 6);
  const a0 = sameMonth ? fmtDate(from, lang).split(" ")[0] : sameYear ? fmtDate(from, lang).split(" ").slice(0, 2).join(" ") : fmtDate(from, lang);
  if (a.partial) return L.some(a.partial.count, a0, fmtDate(to, lang));
  return L.range(a0, fmtDate(to, lang));
};
const dayText = (day, L) => {
  if (!day) return "";
  if (L.day[day]) return L.day[day];
  return day
    .split("+")
    .map((d) => L.dows[d] || d)
    .join(", ");
};

/** The UTC epoch seconds of a local wall-clock time in a timezone. */
const zonedEpoch = (ymd, hour, tz) => {
  const guess = Date.UTC(+ymd.slice(0, 4), +ymd.slice(4, 6) - 1, +ymd.slice(6, 8), hour);
  if (!tz) return Math.floor(guess / 1000);
  const offsetAt = (ms) => {
    try {
      const parts = Object.fromEntries(new Intl.DateTimeFormat("en-US", { timeZone: tz, hourCycle: "h23", year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit", second: "2-digit" }).formatToParts(new Date(ms)).map((p) => [p.type, p.value]));
      return Date.UTC(+parts.year, +parts.month - 1, +parts.day, +parts.hour, +parts.minute, +parts.second) - ms;
    } catch {
      return 0;
    }
  };
  let t = guess - offsetAt(guess);
  t = guess - offsetAt(t);
  return Math.floor(t / 1000);
};

const CAUSES = new Set(["UNKNOWN_CAUSE", "OTHER_CAUSE", "TECHNICAL_PROBLEM", "STRIKE", "DEMONSTRATION", "ACCIDENT", "HOLIDAY", "WEATHER", "MAINTENANCE", "CONSTRUCTION", "POLICE_ACTIVITY", "MEDICAL_EMERGENCY"]);

const renderAlerts = (alerts, { language = "en", timezone = null, cause = null, now = Math.floor(Date.now() / 1000), title = null } = {}) => {
  const lang = T[String(language || "").slice(0, 2)] ? String(language).slice(0, 2) : "en";
  const L = T[lang];
  const c = CAUSES.has(String(cause || "").toUpperCase()) ? String(cause).toUpperCase() : "OTHER_CAUSE";
  const entity = [];
  const blocks = [];
  for (const a of alerts) {
    const labels = a.routes.map((r) => r.label).sort((x, y) => String(x).localeCompare(String(y), undefined, { numeric: true }));
    const when = whenText(a, L, lang);
    const header = `${L.line(labels)}${lang === "fr" ? " : " : ": "}${L.head[a.effect]}${when ? ` ${when}` : ""}`;
    const day = dayText(a.day, L);
    const lines = a.facts.map((f) => (L.fact[f.code] ? L.fact[f.code](f, day, f.period ? L.period[f.period] || f.period : "") : f.code));
    const description = [...new Set(lines)].join("\n");
    const informed = [];
    for (const r of a.routes) informed.push({ routeId: r.id });
    for (const s of [...a.stops.lost, ...a.stops.gained]) for (const r of a.routes) informed.push({ routeId: r.id, stopId: s.id });
    const period = a.period.from ? { start: zonedEpoch(a.period.from, 0, timezone), ...(a.open_ended ? {} : { end: zonedEpoch(addDays(a.period.to, 1), 4, timezone) }) } : null;
    entity.push({
      id: a.id,
      alert: {
        ...(period ? { activePeriod: [period] } : {}),
        informedEntity: informed,
        cause: c,
        effect: a.effect,
        headerText: { translation: [{ text: header, language: lang }] },
        descriptionText: { translation: [{ text: description, language: lang }] },
      },
    });
    blocks.push(`${header}\n${description}`);
  }
  const noticeTitle = title ? `${L.notice} — ${title}` : L.notice;
  return {
    feed: { header: { gtfsRealtimeVersion: "2.0", incrementality: "FULL_DATASET", timestamp: now }, entity },
    notice: { language: lang, title: noticeTitle, text: `${noticeTitle}\n\n${blocks.join("\n\n")}\n` },
  };
};

const encodeFeed = (feed) => {
  const { transit_realtime: rt } = require("gtfs-realtime-bindings");
  return Buffer.from(rt.FeedMessage.encode(rt.FeedMessage.fromObject(feed)).finish());
};

module.exports = { passengerAlerts, renderAlerts, encodeFeed, _internals: { zonedEpoch, fmtDate, stopsServed } };
