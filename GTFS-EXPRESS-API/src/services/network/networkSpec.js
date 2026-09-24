/**
 * networkSpec — the Network Spec: what a transit network IS, before it is a
 * GTFS. It is the contract between the planner (a person or the assistant)
 * and the deterministic compiler.
 *
 *   {
 *     version: 1,
 *     agency:  { id?, name, url, timezone, lang?, phone?, email? },
 *     feed:    { start_date?, end_date?, publisher?, version?, lang? },   // YYYYMMDD
 *     stops:   [{ id?, name, lat?, lon?, address?, code?, wheelchair? }],
 *     lines:   [{
 *       id?, short_name, long_name?, mode?, color?, text_color?, description?,
 *       speed_kmh?, dwell_s?,
 *       directions: [{ id?: "0"|"1", headsign?, stops: [stop id or name, …] }],
 *       round_trip?: true,                     // derive direction 1 by reversing direction 0
 *       services: [{
 *         calendar: "weekday" | "saturday" | "sunday" | "weekend" | "daily" | "monsat"
 *                   | { id?, days: ["mon", …], start_date?, end_date? },
 *         direction?: "0" | "1" | "both",
 *         periods?: [{ from: "06:00", to: "09:00", headway_min: 10 }],
 *         departures?: ["06:05", "06:35", …],
 *       }],
 *     }],
 *     holidays?: ["20261225", …], holiday_service?: "sunday" | "none",
 *     transfers?: [{ from, to, min_minutes?, type? }],
 *   }
 *
 * `normalizeSpec(raw)` returns `{ spec, issues, blockers }`: a normalised copy
 * (ids, colours, modes, calendars, derived directions, auto-created stops)
 * plus every problem found. Issues of level "error" stop the compilation;
 * blockers are the errors a person (or a tool) must resolve — typically
 * stops without coordinates. `estimateSpec(spec)` counts what the compiled
 * feed would contain without any network access.
 */

"use strict";

const MODES = {
  bus: { route_type: 3, speed_kmh: 20, dwell_s: 20, color: "1E88E5" },
  coach: { route_type: 3, speed_kmh: 45, dwell_s: 30, color: "3949AB" },
  express: { route_type: 3, speed_kmh: 30, dwell_s: 20, color: "8E24AA" },
  shuttle: { route_type: 3, speed_kmh: 20, dwell_s: 20, color: "00897B" },
  trolleybus: { route_type: 11, speed_kmh: 18, dwell_s: 20, color: "F4511E" },
  tram: { route_type: 0, speed_kmh: 22, dwell_s: 25, color: "43A047" },
  metro: { route_type: 1, speed_kmh: 35, dwell_s: 30, color: "E53935" },
  subway: { route_type: 1, speed_kmh: 35, dwell_s: 30, color: "E53935" },
  rail: { route_type: 2, speed_kmh: 60, dwell_s: 45, color: "6D4C41" },
  train: { route_type: 2, speed_kmh: 60, dwell_s: 45, color: "6D4C41" },
  ferry: { route_type: 4, speed_kmh: 25, dwell_s: 120, color: "00ACC1" },
  cable: { route_type: 5, speed_kmh: 12, dwell_s: 30, color: "FB8C00" },
  gondola: { route_type: 6, speed_kmh: 18, dwell_s: 30, color: "FB8C00" },
  funicular: { route_type: 7, speed_kmh: 15, dwell_s: 30, color: "FB8C00" },
  monorail: { route_type: 12, speed_kmh: 30, dwell_s: 30, color: "5E35B1" },
};
const MODE_ALIASES = { autobus: "bus", car: "coach", tramway: "tram", metro: "metro", métro: "metro", subway: "subway", underground: "metro", ter: "rail", train: "rail", rer: "rail", navette: "shuttle", bateau: "ferry", ferry: "ferry", boat: "ferry", trolley: "trolleybus", téléphérique: "gondola", telepherique: "gondola", funiculaire: "funicular" };
const PALETTE = ["1E88E5", "E53935", "43A047", "FB8C00", "8E24AA", "00ACC1", "F4511E", "3949AB", "00897B", "C0CA33", "6D4C41", "D81B60"];
const NAMED_CALENDARS = {
  weekday: { id: "WKD", days: ["mon", "tue", "wed", "thu", "fri"] },
  weekdays: { id: "WKD", days: ["mon", "tue", "wed", "thu", "fri"] },
  monfri: { id: "WKD", days: ["mon", "tue", "wed", "thu", "fri"] },
  saturday: { id: "SAT", days: ["sat"] },
  sunday: { id: "SUN", days: ["sun"] },
  weekend: { id: "WKE", days: ["sat", "sun"] },
  daily: { id: "DAILY", days: ["mon", "tue", "wed", "thu", "fri", "sat", "sun"] },
  everyday: { id: "DAILY", days: ["mon", "tue", "wed", "thu", "fri", "sat", "sun"] },
  monsat: { id: "MONSAT", days: ["mon", "tue", "wed", "thu", "fri", "sat"] },
};
const DAY_KEYS = ["mon", "tue", "wed", "thu", "fri", "sat", "sun"];
const DAY_ALIASES = { monday: "mon", lundi: "mon", tuesday: "tue", mardi: "tue", wednesday: "wed", mercredi: "wed", thursday: "thu", jeudi: "thu", friday: "fri", vendredi: "fri", saturday: "sat", samedi: "sat", sunday: "sun", dimanche: "sun" };
const LIMITS = { lines: 80, stops: 3000, trips: 25000, directions: 2, stopsPerDirection: 150 };

const HEX_RE = /^[0-9A-Fa-f]{6}$/;
const DATE_RE = /^\d{8}$/;
const TIME_RE = /^(\d{1,2}):(\d{2})(?::(\d{2}))?$/;
const TZ_RE = /^[A-Za-z_]+\/[A-Za-z_+\-0-9]+(\/[A-Za-z_+\-0-9]+)?$|^UTC$|^Etc\/[A-Za-z0-9+\-]+$/;

const str = (v) => (typeof v === "string" ? v.trim() : v == null ? "" : String(v).trim());
const num = (v) => {
  if (v === null || v === undefined || v === "") return null;
  const n = typeof v === "number" ? v : parseFloat(String(v).replace(",", "."));
  return Number.isFinite(n) ? n : null;
};
const timeToSec = (t) => {
  const m = TIME_RE.exec(str(t));
  if (!m) return null;
  const h = parseInt(m[1], 10);
  const mi = parseInt(m[2], 10);
  const s = m[3] ? parseInt(m[3], 10) : 0;
  if (mi > 59 || s > 59) return null;
  return h * 3600 + mi * 60 + s;
};
const secToTime = (v) => `${String(Math.floor(v / 3600)).padStart(2, "0")}:${String(Math.floor((v % 3600) / 60)).padStart(2, "0")}:${String(v % 60).padStart(2, "0")}`;
const slug = (s) =>
  str(s)
    .normalize("NFD")
    .replace(/[̀-ͯ]/g, "")
    .replace(/[^A-Za-z0-9]+/g, "_")
    .replace(/^_+|_+$/g, "")
    .toUpperCase()
    .slice(0, 40) || "X";
const nameKey = (s) => str(s).normalize("NFD").replace(/[̀-ͯ]/g, "").toLowerCase().replace(/[^a-z0-9]+/g, " ").trim();
const todayYmd = () => {
  const d = new Date();
  return `${d.getFullYear()}${String(d.getMonth() + 1).padStart(2, "0")}${String(d.getDate()).padStart(2, "0")}`;
};
const addYearYmd = (ymd) => `${parseInt(ymd.slice(0, 4), 10) + 1}${ymd.slice(4)}`;
const luminance = (hex) => {
  const c = [0, 2, 4].map((i) => parseInt(hex.slice(i, i + 2), 16) / 255).map((v) => (v <= 0.03928 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4));
  return 0.2126 * c[0] + 0.7152 * c[1] + 0.0722 * c[2];
};
const textColorFor = (hex) => (luminance(hex) > 0.4 ? "000000" : "FFFFFF");

const resolveMode = (raw) => {
  const k = str(raw).toLowerCase();
  if (!k) return "bus";
  if (MODES[k]) return k;
  if (MODE_ALIASES[k]) return MODE_ALIASES[k];
  return null;
};

const parseDays = (raw) => {
  if (!Array.isArray(raw)) return null;
  const out = [];
  for (const d of raw) {
    const k = str(d).toLowerCase().slice(0, 3);
    const key = DAY_KEYS.includes(k) ? k : DAY_ALIASES[str(d).toLowerCase()];
    if (!key) return null;
    if (!out.includes(key)) out.push(key);
  }
  return out;
};

// ── Normalisation + validation ─────────────────────────────────────────────

const normalizeSpec = (raw) => {
  const issues = [];
  const err = (code, path, message, extra = {}) => issues.push({ level: "error", code, path, message, ...extra });
  const warn = (code, path, message, extra = {}) => issues.push({ level: "warning", code, path, message, ...extra });
  const input = raw && typeof raw === "object" ? raw : {};

  // Agency.
  const a = input.agency && typeof input.agency === "object" ? input.agency : {};
  const agency = {
    id: str(a.id || a.agency_id) || slug(a.name || a.agency_name || "AGENCY"),
    name: str(a.name || a.agency_name),
    url: str(a.url || a.agency_url),
    timezone: str(a.timezone || a.agency_timezone),
    lang: str(a.lang || a.agency_lang).toLowerCase() || undefined,
    phone: str(a.phone || a.agency_phone) || undefined,
    email: str(a.email || a.agency_email) || undefined,
  };
  if (!agency.name) err("agency_missing_field", "agency.name", "The agency needs a name.");
  if (!agency.url) err("agency_missing_field", "agency.url", "The agency needs a URL (agency_url).");
  else if (!/^https?:\/\//i.test(agency.url)) err("agency_invalid_url", "agency.url", "agency_url must start with http:// or https://.");
  if (!agency.timezone) err("agency_missing_field", "agency.timezone", "The agency needs an IANA timezone (e.g. Europe/Paris).");
  else if (!TZ_RE.test(agency.timezone)) err("invalid_timezone", "agency.timezone", `"${agency.timezone}" is not an IANA timezone (e.g. Europe/Paris).`);

  // Feed dates.
  const f = input.feed && typeof input.feed === "object" ? input.feed : {};
  const start = str(f.start_date).replace(/-/g, "") || todayYmd();
  const end = str(f.end_date).replace(/-/g, "") || addYearYmd(start);
  if (!DATE_RE.test(start)) err("invalid_dates", "feed.start_date", "feed.start_date must be YYYYMMDD.");
  if (!DATE_RE.test(end)) err("invalid_dates", "feed.end_date", "feed.end_date must be YYYYMMDD.");
  if (DATE_RE.test(start) && DATE_RE.test(end) && end < start) err("invalid_dates", "feed.end_date", "feed.end_date is before feed.start_date.");
  const feed = {
    start_date: start,
    end_date: end,
    publisher: str(f.publisher) || agency.name,
    publisher_url: str(f.publisher_url) || agency.url,
    version: str(f.version) || `${start}-v1`,
    lang: str(f.lang).toLowerCase() || agency.lang || "en",
  };

  // Stops.
  const stops = [];
  const stopById = new Map();
  const stopByName = new Map();
  const usedIds = new Set();
  const addStop = (s, path, { auto = false } = {}) => {
    const name = str(s.name || s.stop_name);
    if (!name) {
      err("stop_missing_name", path, "A stop needs a name.");
      return null;
    }
    let id = str(s.id || s.stop_id) || slug(name);
    if (usedIds.has(id)) {
      if (str(s.id || s.stop_id)) err("duplicate_stop_id", path, `Stop id "${id}" is used twice.`);
      let n = 2;
      while (usedIds.has(`${id}_${n}`)) n += 1;
      id = `${id}_${n}`;
    }
    usedIds.add(id);
    const lat = num(s.lat ?? s.stop_lat);
    const lon = num(s.lon ?? s.stop_lon);
    if ((lat != null && (lat < -90 || lat > 90)) || (lon != null && (lon < -180 || lon > 180))) err("invalid_coordinates", path, `Stop "${name}" has coordinates out of range.`);
    const stop = {
      id,
      name,
      lat: lat != null && lon != null ? lat : null,
      lon: lat != null && lon != null ? lon : null,
      address: str(s.address) || undefined,
      code: str(s.code || s.stop_code) || undefined,
      wheelchair: s.wheelchair === true || s.wheelchair === 1 || s.wheelchair === "1" ? "1" : undefined,
      auto: auto || undefined,
    };
    stops.push(stop);
    stopById.set(id, stop);
    if (!stopByName.has(nameKey(name))) stopByName.set(nameKey(name), stop);
    return stop;
  };
  (Array.isArray(input.stops) ? input.stops : []).forEach((s, i) => s && typeof s === "object" && addStop(s, `stops[${i}]`));

  const resolveStopRef = (ref, path) => {
    if (ref && typeof ref === "object") {
      const byId = str(ref.id || ref.stop_id);
      if (byId && stopById.has(byId)) return stopById.get(byId);
      const byName = stopByName.get(nameKey(ref.name || ref.stop_name));
      if (byName) return byName;
      const created = addStop(ref, path, { auto: true });
      if (created) warn("stop_auto_created", path, `Stop "${created.name}" was created from the line definition.`, { stopId: created.id });
      return created;
    }
    const key = str(ref);
    if (!key) return null;
    if (stopById.has(key)) return stopById.get(key);
    if (stopByName.has(nameKey(key))) return stopByName.get(nameKey(key));
    const created = addStop({ name: key }, path, { auto: true });
    if (created) warn("stop_auto_created", path, `Stop "${created.name}" was created from the line definition; it needs coordinates.`, { stopId: created.id });
    return created;
  };

  // Calendars.
  const calendars = new Map(); // id -> { id, days, start_date, end_date }
  // A normalised spec round-trips: its calendars[] are registered first so
  // services may refer to them by id (calendar_id).
  (Array.isArray(input.calendars) ? input.calendars : []).forEach((c) => {
    const id = c && str(c.id);
    const days = c && parseDays(c.days);
    if (!id || !days || !days.length) return;
    const sd = str(c.start_date).replace(/-/g, "") || feed.start_date;
    const ed = str(c.end_date).replace(/-/g, "") || feed.end_date;
    if (DATE_RE.test(sd) && DATE_RE.test(ed) && sd <= ed) calendars.set(id, { id, days, start_date: sd, end_date: ed });
  });
  const resolveCalendar = (raw, path) => {
    if (typeof raw === "string" || raw == null) {
      if (raw && calendars.has(str(raw))) return calendars.get(str(raw));
      const key = str(raw || "weekday").toLowerCase().replace(/[^a-z]/g, "");
      const named = NAMED_CALENDARS[key] || Object.values(NAMED_CALENDARS).find((c) => c.id.toLowerCase() === key);
      if (!named) {
        err("unknown_calendar", path, `Unknown calendar "${raw}" (use weekday, saturday, sunday, weekend, daily, monsat or {days:[…]}).`);
        return null;
      }
      if (!calendars.has(named.id)) calendars.set(named.id, { id: named.id, days: named.days, start_date: feed.start_date, end_date: feed.end_date });
      return calendars.get(named.id);
    }
    if (typeof raw !== "object") return null;
    const days = parseDays(raw.days) || (raw.name && NAMED_CALENDARS[str(raw.name).toLowerCase()] ? NAMED_CALENDARS[str(raw.name).toLowerCase()].days : null);
    if (!days || days.length === 0) {
      err("invalid_calendar_days", path, "A custom calendar needs days: [\"mon\", …].");
      return null;
    }
    const sd = str(raw.start_date).replace(/-/g, "") || feed.start_date;
    const ed = str(raw.end_date).replace(/-/g, "") || feed.end_date;
    if (!DATE_RE.test(sd) || !DATE_RE.test(ed) || ed < sd) {
      err("invalid_dates", path, "Calendar dates must be YYYYMMDD with start ≤ end.");
      return null;
    }
    const id = str(raw.id) ? slug(raw.id) : `${days.map((d) => d[0].toUpperCase() + d.slice(1)).join("")}${sd === feed.start_date && ed === feed.end_date ? "" : `_${sd}`}`;
    if (!calendars.has(id)) calendars.set(id, { id, days, start_date: sd, end_date: ed });
    return calendars.get(id);
  };

  // Lines.
  const lines = [];
  const lineIds = new Set();
  const rawLines = Array.isArray(input.lines) ? input.lines : Array.isArray(input.routes) ? input.routes : [];
  if (rawLines.length === 0) err("no_lines", "lines", "The network needs at least one line.");
  if (rawLines.length > LIMITS.lines) err("too_many_lines", "lines", `At most ${LIMITS.lines} lines per network.`);
  rawLines.forEach((l, li) => {
    if (!l || typeof l !== "object") return;
    const path = `lines[${li}]`;
    const shortName = str(l.short_name || l.route_short_name || l.name || l.number);
    const longName = str(l.long_name || l.route_long_name);
    if (!shortName && !longName) {
      err("line_missing_name", path, "A line needs a short_name (e.g. 12) or a long_name.");
      return;
    }
    let id = str(l.id || l.route_id) || slug(shortName || longName);
    if (lineIds.has(id)) {
      if (str(l.id || l.route_id)) err("duplicate_line_id", path, `Line id "${id}" is used twice.`);
      let n = 2;
      while (lineIds.has(`${id}_${n}`)) n += 1;
      id = `${id}_${n}`;
    }
    lineIds.add(id);
    let mode = resolveMode(l.mode || l.type);
    if (!mode) {
      warn("mode_unknown", `${path}.mode`, `Unknown mode "${l.mode}", using bus.`);
      mode = "bus";
    }
    const modeDef = MODES[mode];
    let color = str(l.color || l.route_color).replace(/^#/, "").toUpperCase();
    if (color && !HEX_RE.test(color)) {
      warn("invalid_color", `${path}.color`, `"${l.color}" is not a 6-digit hex colour; a palette colour is used.`);
      color = "";
    }
    if (!color) color = PALETTE[li % PALETTE.length];
    let textColor = str(l.text_color || l.route_text_color).replace(/^#/, "").toUpperCase();
    if (!HEX_RE.test(textColor)) textColor = textColorFor(color);
    const speed = num(l.speed_kmh) || modeDef.speed_kmh;
    const dwell = num(l.dwell_s) ?? modeDef.dwell_s;
    if (speed <= 0 || speed > 400) err("invalid_speed", `${path}.speed_kmh`, "speed_kmh must be between 1 and 400.");

    // Directions.
    const rawDirs = Array.isArray(l.directions) ? l.directions : Array.isArray(l.stops) ? [{ id: "0", stops: l.stops, headsign: l.headsign }] : [];
    const directions = [];
    rawDirs.slice(0, LIMITS.directions).forEach((d, di) => {
      if (!d || typeof d !== "object") return;
      const dpath = `${path}.directions[${di}]`;
      const refs = Array.isArray(d.stops) ? d.stops : [];
      if (refs.length > LIMITS.stopsPerDirection) err("too_many_stops", dpath, `At most ${LIMITS.stopsPerDirection} stops per direction.`);
      const resolved = [];
      refs.slice(0, LIMITS.stopsPerDirection).forEach((r, si) => {
        const s = resolveStopRef(r, `${dpath}.stops[${si}]`);
        if (s && resolved[resolved.length - 1] !== s.id) resolved.push(s.id);
      });
      if (resolved.length < 2) {
        err("direction_too_short", dpath, `Direction ${di} of line ${shortName || longName} needs at least two distinct stops.`);
        return;
      }
      const dirId = str(d.id ?? d.direction_id) === "1" || di === 1 ? "1" : "0";
      directions.push({ id: dirId, headsign: str(d.headsign) || stopById.get(resolved[resolved.length - 1]).name, stops: resolved });
    });
    if (directions.length === 1 && l.round_trip !== false && !(rawDirs.length > 1)) {
      const d0 = directions[0];
      directions.push({ id: d0.id === "0" ? "1" : "0", headsign: stopById.get(d0.stops[0]).name, stops: [...d0.stops].reverse(), derived: true });
    }
    if (directions.length === 0) err("line_no_directions", path, `Line ${shortName || longName} has no usable direction.`);
    if (directions.length === 2 && directions[0].id === directions[1].id) directions[1].id = directions[0].id === "0" ? "1" : "0";

    // Services.
    const services = [];
    const rawServices = Array.isArray(l.services) ? l.services : Array.isArray(l.service) ? l.service : l.services && typeof l.services === "object" ? [l.services] : [];
    if (rawServices.length === 0) err("no_service", `${path}.services`, `Line ${shortName || longName} needs at least one service (calendar + headways or departures).`);
    rawServices.forEach((s, si) => {
      if (!s || typeof s !== "object") return;
      const spath = `${path}.services[${si}]`;
      const cal = resolveCalendar(s.calendar ?? s.calendar_id ?? (Array.isArray(s.days) ? { days: s.days } : undefined), `${spath}.calendar`);
      if (!cal) return;
      const dir = str(s.direction ?? "both");
      const direction = dir === "0" || dir === "1" ? dir : "both";
      const periods = [];
      (Array.isArray(s.periods) ? s.periods : Array.isArray(s.headways) ? s.headways : []).forEach((p, pi) => {
        const from = timeToSec(p?.from ?? p?.start);
        const to = timeToSec(p?.to ?? p?.end);
        const headway = num(p?.headway_min ?? p?.every_min ?? p?.headway);
        if (from == null || to == null) return err("invalid_time", `${spath}.periods[${pi}]`, "Period times must be HH:MM.");
        if (to <= from) return err("invalid_period", `${spath}.periods[${pi}]`, "A period must end after it starts.");
        if (!(headway >= 1 && headway <= 720)) return err("invalid_headway", `${spath}.periods[${pi}]`, "headway_min must be between 1 and 720.");
        periods.push({ from: secToTime(from), to: secToTime(to), headway_min: headway });
      });
      const departures = [];
      (Array.isArray(s.departures) ? s.departures : []).forEach((d, di) => {
        const sec = timeToSec(d);
        if (sec == null) return err("invalid_time", `${spath}.departures[${di}]`, `"${d}" is not a HH:MM time.`);
        departures.push(secToTime(sec));
      });
      if (periods.length === 0 && departures.length === 0) return err("no_service", spath, "A service needs periods (headways) or departures.");
      services.push({ calendar_id: cal.id, direction, periods, departures: [...new Set(departures)].sort(), reverse_offset_min: num(s.reverse_offset_min) ?? null });
    });

    lines.push({
      id,
      short_name: shortName || longName.slice(0, 12),
      long_name: longName || (directions.length ? `${stopById.get(directions[0].stops[0]).name} ↔ ${stopById.get(directions[0].stops[directions[0].stops.length - 1]).name}` : shortName),
      description: str(l.description || l.route_desc) || undefined,
      mode,
      route_type: modeDef.route_type,
      color,
      text_color: textColor,
      speed_kmh: speed,
      dwell_s: dwell,
      url: str(l.url) || undefined,
      directions,
      services,
    });
  });

  // Holidays, transfers.
  const holidays = [];
  (Array.isArray(input.holidays) ? input.holidays : []).forEach((h, i) => {
    const d = str(h).replace(/-/g, "");
    if (!DATE_RE.test(d)) return err("invalid_dates", `holidays[${i}]`, `"${h}" is not a YYYYMMDD date.`);
    if (!holidays.includes(d)) holidays.push(d);
  });
  const holidayService = ["sunday", "none", "saturday"].includes(str(input.holiday_service).toLowerCase()) ? str(input.holiday_service).toLowerCase() : "sunday";
  const transfers = [];
  (Array.isArray(input.transfers) ? input.transfers : []).forEach((t, i) => {
    const from = t && resolveStopRef(t.from, `transfers[${i}].from`);
    const to = t && resolveStopRef(t.to, `transfers[${i}].to`);
    if (!from || !to) return;
    const minutes = num(t.min_minutes);
    transfers.push({ from: from.id, to: to.id, min_minutes: minutes != null && minutes >= 0 ? minutes : 3, type: str(t.type) || "2" });
  });

  // Operations (optional): what running the network costs, and the caps the
  // brief imposes. Kept as given; the operations estimate reads them.
  let operations;
  if (input.operations && typeof input.operations === "object") {
    const o = input.operations;
    const nonNeg = (v, path) => {
      const n = num(v);
      if (n != null && n < 0) err("invalid_operations", path, "Operations figures must be ≥ 0.");
      return n != null && n >= 0 ? n : undefined;
    };
    const currency = str(o.currency).toUpperCase();
    let costPerKm;
    if (o.cost_per_km && typeof o.cost_per_km === "object") {
      costPerKm = {};
      for (const [k, v] of Object.entries(o.cost_per_km)) {
        const n = nonNeg(v, `operations.cost_per_km.${k}`);
        if (n != null) costPerKm[k] = n;
      }
    } else costPerKm = nonNeg(o.cost_per_km, "operations.cost_per_km");
    operations = {
      currency: /^[A-Z]{3}$/.test(currency) ? currency : "EUR",
      cost_per_km: costPerKm,
      cost_per_hour: nonNeg(o.cost_per_hour, "operations.cost_per_hour"),
      layover_min: nonNeg(o.layover_min, "operations.layover_min"),
      max_vehicles: nonNeg(o.max_vehicles, "operations.max_vehicles"),
      max_cost_year: nonNeg(o.max_cost_year, "operations.max_cost_year"),
    };
    for (const k of Object.keys(operations)) if (operations[k] === undefined) delete operations[k];
  }

  // Coordinates: the blockers.
  const unresolved = stops.filter((s) => s.lat == null);
  for (const s of unresolved) err("stop_needs_coordinates", `stops.${s.id}`, `Stop "${s.name}" has no coordinates.`, { stopId: s.id, stopName: s.name, address: s.address || null });
  if (stops.length > LIMITS.stops) err("too_many_stops", "stops", `At most ${LIMITS.stops} stops per network.`);
  const unused = stops.filter((s) => !lines.some((l) => l.directions.some((d) => d.stops.includes(s.id))));
  for (const s of unused) warn("stop_unused", `stops.${s.id}`, `Stop "${s.name}" is not served by any line.`, { stopId: s.id });

  const spec = {
    version: 1,
    agency,
    feed,
    stops,
    lines,
    calendars: [...calendars.values()],
    holidays,
    holiday_service: holidayService,
    transfers,
    ...(operations ? { operations } : {}),
  };
  const estimate = estimateSpec(spec);
  if (estimate.trips > LIMITS.trips) err("too_many_trips", "lines", `The network would have ${estimate.trips} trips; the limit is ${LIMITS.trips}. Reduce the periods or headways.`);
  const blockers = issues.filter((i) => i.level === "error");
  return { spec, issues, blockers, estimate, ok: blockers.length === 0 };
};

// ── Estimate (no network) ──────────────────────────────────────────────────

const departuresOf = (service) => {
  const times = new Set(service.departures.map(timeToSec));
  for (const p of service.periods) {
    const from = timeToSec(p.from);
    const to = timeToSec(p.to);
    const step = Math.round(p.headway_min * 60);
    for (let t = from; t <= to; t += step) times.add(t);
  }
  return [...times].filter((t) => t != null).sort((a, b) => a - b);
};

const estimateSpec = (spec) => {
  let trips = 0;
  let stopTimes = 0;
  const perLine = [];
  for (const line of spec.lines || []) {
    let lineTrips = 0;
    let lineStopTimes = 0;
    for (const svc of line.services || []) {
      const deps = departuresOf(svc).length;
      for (const d of line.directions || []) {
        if (svc.direction !== "both" && svc.direction !== d.id) continue;
        lineTrips += deps;
        lineStopTimes += deps * d.stops.length;
      }
    }
    trips += lineTrips;
    stopTimes += lineStopTimes;
    perLine.push({ id: line.id, short_name: line.short_name, trips: lineTrips, stops: new Set((line.directions || []).flatMap((d) => d.stops)).size, directions: (line.directions || []).length });
  }
  return {
    lines: (spec.lines || []).length,
    stops: (spec.stops || []).length,
    stops_without_coordinates: (spec.stops || []).filter((s) => s.lat == null).length,
    calendars: (spec.calendars || []).length,
    trips,
    stop_times: stopTimes,
    per_line: perLine,
  };
};

/** Fill coordinates of stops from a map { stopId: {lat, lon} }. Returns the count applied. */
const applyCoordinates = (spec, coords) => {
  let n = 0;
  for (const s of spec.stops || []) {
    const c = coords && coords[s.id];
    if (c && Number.isFinite(c.lat) && Number.isFinite(c.lon)) {
      s.lat = c.lat;
      s.lon = c.lon;
      n += 1;
    }
  }
  return n;
};

module.exports = {
  normalizeSpec,
  estimateSpec,
  applyCoordinates,
  departuresOf,
  MODES,
  NAMED_CALENDARS,
  LIMITS,
  _internals: { timeToSec, secToTime, slug, nameKey, textColorFor, resolveMode, parseDays },
};
