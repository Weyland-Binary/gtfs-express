/**
 * userData — the user's own demand data: a file they upload (ticketing
 * counts per stop or per line, a household-survey origin–destination table,
 * places with residents / jobs / pupils), read, recognised, kept in memory
 * for two hours and merged by buildDemandInputs({ dataIds }).
 *
 *   ingestUserData({ name, buffer, truncated?, mapping? })
 *     → { id, name, kind, rows, columns, mapping, preview, warnings, expiresAt }
 *   applyUserData(draft, dataIds)   merge into a demand-inputs draft
 *
 * Formats: CSV / TSV / TXT (separator sniffed, UTF-8 or Latin-1) and XLSX /
 * XLS / ODS (first sheet with data) through chatAttachmentService's parsers;
 * GeoJSON (Point features; polygons placed at their centre) and JSON (an
 * array of objects).
 *
 * Kinds, recognised from French or English headers (accents, case and
 * punctuation ignored; a header may carry a suffix: "Montées 2024"):
 *   od              origin + destination + flow [+ purpose, coordinates]
 *   stop_ridership  stop + boardings and/or alightings [+ day type, line, coordinates]
 *   line_ridership  line + trips [+ period]
 *   points          latitude + longitude [+ population, jobs, students, weight, name, category]
 * checked in that order (a ridership file with coordinates is ridership).
 * An optional mapping — { kind?, <role>: "<header>", unit?, mode?,
 * purpose?, day_type? } — forces the kind or a column, gives the unit of the
 * counts (day, week, month, year), the merge mode of points (add,
 * replace), the purpose of flows or the day type to read. A file that fits
 * no kind, or where a role matches several columns, is refused with the
 * columns each kind expects. Nothing is guessed silently: every default
 * (unit, day type, merge mode, purpose) is stated in `warnings`.
 */

"use strict";

const crypto = require("crypto");
const path = require("path");
const { decodeBuffer } = require("../csvUtils");
const { _internals: attachment } = require("../chatAttachmentService");
const { addSource } = require("./sources");

const MAX_FILE_BYTES = 20 * 1024 * 1024;
const MAX_ROWS = 50000;
const MAX_TOTAL_BYTES = 64 * 1024 * 1024;
const MAX_ENTRIES = 200;
const DATA_TTL_MS = 2 * 60 * 60 * 1000;
const MAX_USER_GENERATORS = 300;
const FULL_LAYER_MIN_POINTS = 10;
const PREVIEW_ROWS = 5;
const EXTENSIONS = { ".csv": "text", ".tsv": "text", ".txt": "text", ".xlsx": "sheet", ".xls": "sheet", ".ods": "sheet", ".geojson": "json", ".json": "json" };
// Per-weekday conversion of totals: a French urban network carries in a
// year about 290 times its typical weekday ridership.
const WEEKDAYS_PER = { day: 1, week: 290 / 52, month: 290 / 12, year: 290 };
const USER_SOURCE = { id: "user", name: "Données fournies par l'utilisateur", url: null, license: null };

// ── Roles and their header synonyms (folded: no accents, lower case, _) ─────

const ROLES = {
  lat: ["lat", "latitude", "lat_wgs84", "latitude_wgs84", "y_wgs84", "stop_lat"],
  lon: ["lon", "lng", "long", "longitude", "lon_wgs84", "longitude_wgs84", "x_wgs84", "stop_lon"],
  pop: ["population", "pop", "habitants", "nb_habitants", "nombre_habitants", "nombre_d_habitants", "residents", "inhabitants", "pop_totale", "population_totale"],
  jobs: ["emplois", "emploi", "jobs", "employes", "salaries", "nb_emplois", "nombre_emplois", "nombre_d_emplois", "effectif_salarie", "effectifs_salaries", "employees", "workers"],
  students: ["eleves", "etudiants", "students", "pupils", "effectifs", "effectif", "inscrits", "enrolment", "enrollment", "nb_eleves", "nombre_eleves", "nombre_d_eleves", "scolaires"],
  weight: ["weight", "poids", "attractivite", "importance"],
  name: ["name", "nom", "libelle", "label", "designation", "intitule", "nom_lieu"],
  category: ["category", "categorie", "type", "nature", "kind", "famille"],
  stop: ["arret", "arrets", "stop", "stop_id", "stop_name", "stop_code", "nom_arret", "nom_de_l_arret", "code_arret", "id_arret", "point_d_arret", "station"],
  boardings: ["montees", "montee", "validations", "boardings", "boarding", "ons", "nb_montees", "nombre_de_montees", "entrees"],
  alightings: ["descentes", "descente", "alightings", "alighting", "offs", "nb_descentes", "nombre_de_descentes", "sorties"],
  day: ["jour", "day_type", "type_jour", "type_de_jour", "jour_type", "day", "typologie_jour", "periode_jour"],
  line: ["ligne", "lignes", "line", "route", "route_short_name", "route_id", "num_ligne", "numero_ligne", "code_ligne", "nom_ligne", "id_ligne"],
  trips: ["voyages", "trips", "validations", "frequentation", "ridership", "passagers", "passengers", "nb_voyages", "nombre_de_voyages"],
  period: ["periode", "period", "annee", "year", "mois", "month", "date", "semaine", "week"],
  origin: ["origine", "origin", "from", "o", "zone_origine", "commune_origine", "depart", "zone_o", "orig"],
  destination: ["destination", "to", "d", "dest", "zone_destination", "commune_destination", "arrivee", "zone_d"],
  flow: ["flux", "flow", "flows", "trips", "deplacements", "volume", "nb_deplacements", "nombre_de_deplacements", "count", "valeur", "value", "total"],
  purpose: ["motif", "purpose", "reason", "motif_deplacement"],
  o_lat: ["o_lat", "lat_o", "lat_origine", "origine_lat", "origin_lat"],
  o_lon: ["o_lon", "lon_o", "lon_origine", "origine_lon", "origin_lon", "o_lng"],
  d_lat: ["d_lat", "lat_d", "lat_destination", "destination_lat", "dest_lat"],
  d_lon: ["d_lon", "lon_d", "lon_destination", "destination_lon", "dest_lon", "d_lng"],
};
const KINDS = {
  od: { required: [["origin"], ["destination"], ["flow"]], optional: ["purpose", "o_lat", "o_lon", "d_lat", "d_lon"] },
  stop_ridership: { required: [["stop"], ["boardings", "alightings"]], optional: ["day", "line", "lat", "lon", "period"] },
  line_ridership: { required: [["line"], ["trips"]], optional: ["period", "day"] },
  points: { required: [["lat"], ["lon"]], optional: ["pop", "jobs", "students", "weight", "name", "category"] },
};
const EXPECTED = {
  points: "latitude and longitude (+ population / habitants, emplois / jobs, élèves / students, poids / weight, nom / name, catégorie)",
  stop_ridership: "arrêt / stop_id / stop_name + montées / validations / boardings and/or descentes / alightings (+ jour / day_type)",
  line_ridership: "ligne / route / route_short_name + voyages / trips / validations / fréquentation (+ période / année)",
  od: "origine / origin / from + destination / to + flux / flow / trips / déplacements (+ motif / purpose)",
};

const typedError = (status, code, message, extra = {}) => Object.assign(new Error(message), { status, code, userFacing: true, ...extra });

const fold = (s) =>
  String(s ?? "")
    .normalize("NFD")
    .replace(/[̀-ͯ]/g, "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "_")
    .replace(/^_+|_+$/g, "");

/** The columns matching a role: exact synonyms first, else "synonym_suffix". */
const matchRole = (role, folded) => {
  const syn = ROLES[role];
  const exact = folded.map((h, i) => (syn.includes(h) ? i : -1)).filter((i) => i >= 0);
  if (exact.length) return exact;
  return folded.map((h, i) => (syn.some((s) => s.length > 1 && h.startsWith(`${s}_`)) ? i : -1)).filter((i) => i >= 0);
};

/**
 * Recognise the kind and the column of each role. Throws 400 with the
 * expected columns when nothing fits, or when a role needed by the kind
 * matches several columns.
 */
const detect = (headers, forced = {}) => {
  const folded = headers.map(fold);
  const roleCols = {};
  for (const role of Object.keys(ROLES)) {
    if (forced.columns && forced.columns[role] !== undefined) {
      const want = String(forced.columns[role]);
      const i = headers.findIndex((h) => h === want);
      const j = i >= 0 ? i : folded.indexOf(fold(want));
      if (j < 0) throw typedError(400, "INVALID_MAPPING", `The mapping names a column "${want.slice(0, 60)}" for ${role}, which is not in the file.`, { columns: headers });
      roleCols[role] = [j];
    } else roleCols[role] = matchRole(role, folded);
  }
  const fits = (kind) => KINDS[kind].required.every((alts) => alts.some((r) => roleCols[r].length));
  const kind = forced.kind || ["od", "stop_ridership", "line_ridership", "points"].find(fits);
  const expected = Object.fromEntries(Object.entries(EXPECTED));
  if (!kind || !KINDS[kind]) throw typedError(400, "UNRECOGNIZED_DATA", `The columns were not recognised. Expected one of: points — ${EXPECTED.points}; ridership per stop — ${EXPECTED.stop_ridership}; ridership per line — ${EXPECTED.line_ridership}; flows — ${EXPECTED.od}. Rename the columns or send a mapping.`, { expected, columns: headers });
  if (!fits(kind)) throw typedError(400, "UNRECOGNIZED_DATA", `The file lacks the columns of "${kind}": ${EXPECTED[kind]}.`, { expected, columns: headers });
  const roles = [...KINDS[kind].required.flat(), ...KINDS[kind].optional];
  const mapping = {};
  const used = new Set();
  for (const role of roles) {
    const cols = roleCols[role].filter((i) => !used.has(i));
    if (!cols.length) continue;
    if (cols.length > 1) throw typedError(400, "AMBIGUOUS_DATA", `Several columns could be the ${role} of "${kind}": ${cols.map((i) => `"${headers[i]}"`).join(", ")}. Keep one, or send a mapping ({"${role}": "<column>"}).`, { expected, columns: headers });
    mapping[role] = cols[0];
    used.add(cols[0]);
  }
  return { kind, mapping };
};

// ── Values ──────────────────────────────────────────────────────────────────

/**
 * A number from a cell: numbers pass; text accepts spaces as thousands,
 * "1 234,5" and "1.234,5" (French), "1,234.5" (English), "12,5" (decimal
 * comma). `convention` "en" (spreadsheets, comma-separated files) reads
 * "1,234" as 1 234; "fr" (semicolon files) reads "1.234" as 1 234 for a
 * count. Coordinates never take a thousands separator.
 */
const parseNumber = (raw, { convention = "fr", coordinate = false } = {}) => {
  if (typeof raw === "number") return Number.isFinite(raw) ? raw : null;
  let s = String(raw ?? "").trim().replace(/[\s  ]/g, "").replace(/^\+/, "");
  if (!s) return null;
  const hasComma = s.includes(",");
  const hasDot = s.includes(".");
  if (hasComma && hasDot) s = s.lastIndexOf(",") > s.lastIndexOf(".") ? s.replace(/\./g, "").replace(",", ".") : s.replace(/,/g, "");
  else if (hasComma) {
    if (!coordinate && convention === "en" && /^-?\d{1,3}(,\d{3})+$/.test(s)) s = s.replace(/,/g, "");
    else if ((s.match(/,/g) || []).length === 1) s = s.replace(",", ".");
    else return null;
  } else if (hasDot && !coordinate && convention === "fr" && /^-?\d{1,3}(\.\d{3})+$/.test(s)) s = s.replace(/\./g, "");
  const n = Number(s);
  return Number.isFinite(n) ? n : null;
};

const clean = (v, max = 120) =>
  String(v ?? "")
    // eslint-disable-next-line no-control-regex
    .replace(/[\u0000-\u001f\u007f]/g, " ")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, max);

const PURPOSE = [
  [/travail|work|emploi|professionnel|commut|bureau/, "work"],
  [/ecole|etude|scolaire|school|study|education|universit|college|lycee|enseignement/, "school"],
];
const purposeOf = (v) => {
  const f = fold(v);
  if (!f) return null;
  const hit = PURPOSE.find(([re]) => re.test(f));
  return hit ? hit[1] : "other";
};
const WEEKDAY_RE = /^(job|jo|jours?_ouvrables?|jour_ouvrable_de_base|lundi_?(au_)?vendredi|l_?v|lmjv|lmmjv|semaine|jours?_de_semaine|weekdays?|week_day|mon_?fri|monday_?friday|ouvrable|job_hors_vacances|job_scolaire)$/;
const UNIT_HINT = [
  [/(^|_)(an|annee|annuel|annuelle|annuelles|annuels|year|yearly|annual|par_an)($|_)/, "year"],
  [/(^|_)(mois|mensuel|mensuelle|month|monthly)($|_)/, "month"],
  [/(^|_)(semaine|hebdo|hebdomadaire|week|weekly)($|_)/, "week"],
  [/(^|_)(jour|journalier|journaliere|day|daily|jo|job|quotidien|quotidienne)($|_)/, "day"],
];
const unitFromHeader = (header) => {
  const f = fold(header);
  const hit = UNIT_HINT.find(([re]) => re.test(f));
  return hit ? hit[1] : null;
};

// ── Parsing ─────────────────────────────────────────────────────────────────

const isZip = (b) => b.length >= 4 && b[0] === 0x50 && b[1] === 0x4b && b[2] === 0x03 && b[3] === 0x04;
const isOle2 = (b) => b.length >= 4 && b[0] === 0xd0 && b[1] === 0xcf && b[2] === 0x11 && b[3] === 0xe0;

/** Area-weighted centre of a polygon ring ([lon, lat] points), computed relative to its first vertex. */
const ringCentre = (ring) => {
  const [x0, y0] = ring[0];
  let a = 0;
  let x = 0;
  let y = 0;
  for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
    const xi = ring[i][0] - x0;
    const yi = ring[i][1] - y0;
    const xj = ring[j][0] - x0;
    const yj = ring[j][1] - y0;
    const f = xj * yi - xi * yj;
    a += f;
    x += (xj + xi) * f;
    y += (yj + yi) * f;
  }
  if (Math.abs(a) < 1e-15) return { lon: ring.reduce((s, p) => s + p[0], 0) / ring.length, lat: ring.reduce((s, p) => s + p[1], 0) / ring.length };
  return { lon: x0 + x / (3 * a), lat: y0 + y / (3 * a) };
};

/** GeoJSON / JSON → { headers, rows (arrays), notes }. */
const parseJson = (buffer) => {
  let doc;
  try {
    doc = JSON.parse(decodeBuffer(buffer).text);
  } catch {
    throw typedError(400, "INVALID_FILE", "The file is not valid JSON.");
  }
  const notes = [];
  let records;
  if (doc && (doc.type === "FeatureCollection" || doc.type === "Feature")) {
    const feats = doc.type === "Feature" ? [doc] : Array.isArray(doc.features) ? doc.features : [];
    let polygons = 0;
    let skipped = 0;
    records = [];
    for (const f of feats) {
      const g = f?.geometry;
      let at = null;
      if (g?.type === "Point" && Array.isArray(g.coordinates)) at = { lon: g.coordinates[0], lat: g.coordinates[1] };
      else if (g?.type === "Polygon" && Array.isArray(g.coordinates?.[0])) at = ringCentre(g.coordinates[0]);
      else if (g?.type === "MultiPolygon" && Array.isArray(g.coordinates)) {
        const rings = g.coordinates.map((p) => p?.[0]).filter((r) => Array.isArray(r) && r.length >= 3);
        const biggest = rings.sort((r1, r2) => r2.length - r1.length)[0];
        if (biggest) at = ringCentre(biggest);
      }
      if (!at || !Number.isFinite(at.lat) || !Number.isFinite(at.lon)) {
        skipped += 1;
        continue;
      }
      if (g.type !== "Point") polygons += 1;
      records.push({ ...(f.properties && typeof f.properties === "object" ? f.properties : {}), latitude: at.lat, longitude: at.lon });
    }
    if (polygons) notes.push(`${polygons} areas (polygons) placed at their centre`);
    if (skipped) notes.push(`${skipped} features without a usable geometry skipped`);
  } else if (Array.isArray(doc)) records = doc.filter((r) => r && typeof r === "object" && !Array.isArray(r));
  else throw typedError(400, "UNRECOGNIZED_DATA", "The JSON must be a GeoJSON FeatureCollection or an array of objects.");
  const headers = [];
  for (const r of records.slice(0, 2000)) for (const k of Object.keys(r)) if (!headers.includes(k) && headers.length < 64) headers.push(k);
  const truncated = records.length > MAX_ROWS;
  return { headers, rows: records.slice(0, MAX_ROWS).map((r) => headers.map((h) => (r[h] === null || r[h] === undefined ? "" : typeof r[h] === "object" ? "" : r[h]))), truncated, notes };
};

/** The file → { headers, rows, truncated, notes, convention }. */
const parseFile = async ({ name, buffer }) => {
  const ext = path.extname(String(name || "")).toLowerCase();
  const family = EXTENSIONS[ext];
  if (!family || buffer.slice(0, 5).toString("latin1") === "%PDF-") throw typedError(415, "UNSUPPORTED_FORMAT", "Unsupported file: send a CSV, TSV, Excel (.xlsx, .xls), OpenDocument (.ods), GeoJSON or JSON file.");
  if (isZip(buffer) || isOle2(buffer) || family === "sheet") {
    if (!isZip(buffer) && !isOle2(buffer)) throw typedError(415, "UNSUPPORTED_FORMAT", `The file does not look like a ${ext} spreadsheet.`);
    let parsed;
    try {
      parsed = attachment.parseXlsxBuffer(buffer, MAX_ROWS);
    } catch (err) {
      if (err.code === "ATTACHMENT_EMPTY") throw typedError(400, "EMPTY_FILE", err.message);
      throw typedError(415, "UNSUPPORTED_FORMAT", "The spreadsheet could not be read (a GTFS feed goes through the upload screen, not here).");
    }
    const notes = parsed.sheetNames && parsed.sheetNames.length > 1 ? [`sheet "${clean(parsed.sheetName, 40)}" read; other sheets ignored: ${parsed.sheetNames.filter((s) => s !== parsed.sheetName).map((s) => clean(s, 40)).join(", ")}`] : [];
    return { headers: parsed.headers, rows: parsed.rows, truncated: parsed.truncated, notes, convention: "en" };
  }
  if (family === "json") return { ...parseJson(buffer), convention: "en" };
  const decoded = decodeBuffer(buffer, clean(name, 80));
  if (decoded.text.includes("\u0000")) throw typedError(415, "UNSUPPORTED_FORMAT", "The file looks binary, not tabular text.");
  if (!decoded.text.trim()) throw typedError(400, "EMPTY_FILE", "The file is empty.");
  const sep = attachment.sniffSeparator(decoded.text, ext);
  const parsed = await attachment.parseCsvBuffer(decoded.text, sep, MAX_ROWS);
  return { headers: parsed.headers, rows: parsed.rows, truncated: parsed.truncated, notes: [], convention: sep === ";" ? "fr" : "en" };
};

// ── Normalisation per kind ──────────────────────────────────────────────────

const normalise = (kind, headers, rows, mapping, { convention }) => {
  const at = (row, role) => (mapping[role] === undefined ? undefined : row[mapping[role]]);
  const n = (row, role, coordinate = false) => (mapping[role] === undefined ? null : parseNumber(row[mapping[role]], { convention, coordinate }));
  const warnings = [];
  const records = [];
  let skipped = 0;
  let badCoords = 0;
  const coords = (row, latRole, lonRole) => {
    const lat = n(row, latRole, true);
    const lon = n(row, lonRole, true);
    if (lat === null || lon === null) return null;
    if (Math.abs(lat) > 90 || Math.abs(lon) > 180) {
      badCoords += 1;
      return null;
    }
    return { lat, lon };
  };
  for (const row of rows) {
    if (kind === "points") {
      const c = coords(row, "lat", "lon");
      const r = c && { ...c, name: clean(at(row, "name")) || null, category: clean(at(row, "category"), 40) || null, pop: n(row, "pop"), jobs: n(row, "jobs"), students: n(row, "students"), weight: n(row, "weight") };
      if (!r || [r.pop, r.jobs, r.students, r.weight].some((v) => v !== null && v < 0)) skipped += 1;
      else records.push(r);
    } else if (kind === "stop_ridership") {
      const stop = clean(at(row, "stop"));
      const r = { stop, boardings: n(row, "boardings"), alightings: n(row, "alightings"), day: clean(at(row, "day"), 40) || null, line: clean(at(row, "line"), 40) || null, ...(mapping.lat !== undefined && mapping.lon !== undefined ? coords(row, "lat", "lon") || {} : {}) };
      if (!stop || (r.boardings === null && r.alightings === null) || r.boardings < 0 || r.alightings < 0) skipped += 1;
      else records.push(r);
    } else if (kind === "line_ridership") {
      const line = clean(at(row, "line"), 60);
      const r = { line, trips: n(row, "trips"), period: clean(at(row, "period"), 20) || null, day: clean(at(row, "day"), 40) || null };
      if (!line || r.trips === null || r.trips < 0) skipped += 1;
      else records.push(r);
    } else {
      const origin = clean(at(row, "origin"));
      const destination = clean(at(row, "destination"));
      const o = mapping.o_lat !== undefined && mapping.o_lon !== undefined ? coords(row, "o_lat", "o_lon") : null;
      const d = mapping.d_lat !== undefined && mapping.d_lon !== undefined ? coords(row, "d_lat", "d_lon") : null;
      const r = { origin, destination, flow: n(row, "flow"), purpose: mapping.purpose !== undefined ? purposeOf(at(row, "purpose")) : null, ...(o ? { o_lat: o.lat, o_lon: o.lon } : {}), ...(d ? { d_lat: d.lat, d_lon: d.lon } : {}) };
      if (!origin || !destination || r.flow === null || r.flow < 0) skipped += 1;
      else records.push(r);
    }
  }
  if (badCoords) warnings.push(`${badCoords} rows have coordinates out of range (projected coordinates such as Lambert-93 are not read: export latitude/longitude in degrees, WGS84)`);
  if (skipped) warnings.push(`${skipped} rows without the needed values were skipped`);
  return { records, warnings, badCoords };
};

// ── Units, day types, merge modes (explicit defaults) ───────────────────────

/** The unit of the counts: the mapping, else a hint in the header or period, else a typical day (stated). */
const unitOf = (kind, headers, mapping, records, forced, warnings) => {
  if (kind === "points") return null;
  if (forced && WEEKDAYS_PER[forced]) return forced;
  const valueRole = kind === "stop_ridership" ? (mapping.boardings !== undefined ? "boardings" : "alightings") : kind === "line_ridership" ? "trips" : "flow";
  const fromHeader = unitFromHeader(headers[mapping[valueRole]]);
  if (fromHeader) {
    warnings.push(`counts read as ${fromHeader === "day" ? "per day" : `totals per ${fromHeader}`} (from the column "${clean(headers[mapping[valueRole]], 40)}")${fromHeader === "day" ? "" : `, divided by ${WEEKDAYS_PER[fromHeader].toFixed(1)} to give a typical weekday`}; send mapping.unit to change`);
    return fromHeader;
  }
  const periods = records.map((r) => r.period).filter(Boolean);
  if (periods.length && periods.every((p) => /^(19|20)\d{2}$/.test(p))) {
    warnings.push(`counts read as yearly totals (the period column holds years), divided by ${WEEKDAYS_PER.year} to give a typical weekday; send mapping.unit to change`);
    return "year";
  }
  if (periods.length && periods.every((p) => /^(19|20)\d{2}[-/.]\d{1,2}$|^\d{1,2}[-/.](19|20)\d{2}$/.test(p) || /^(jan|fev|feb|mar|avr|apr|mai|may|juin|jun|juil|jul|aou|aug|sep|oct|nov|dec)/.test(fold(p)))) {
    warnings.push(`counts read as monthly totals (the period column holds months), divided by ${WEEKDAYS_PER.month.toFixed(1)} to give a typical weekday; send mapping.unit to change`);
    return "month";
  }
  warnings.push("counts read as a typical weekday (no unit in the file); send mapping.unit (week, month, year) if they are totals");
  return "day";
};

const periodLatest = (records) => {
  const ps = [...new Set(records.map((r) => r.period).filter(Boolean))];
  if (ps.length <= 1) return null;
  return ps.sort().at(-1);
};

// ── The store ───────────────────────────────────────────────────────────────

const _store = new Map(); // id → { id, name, kind, columns, mapping, records, unit, mode, purpose, dayType, warnings, size, createdAt }

const sweep = () => {
  const now = Date.now();
  for (const [id, d] of _store) if (now - d.createdAt > DATA_TTL_MS) _store.delete(id);
  let total = [..._store.values()].reduce((s, d) => s + d.size, 0);
  for (const [id, d] of [..._store.entries()].sort((a, b) => a[1].createdAt - b[1].createdAt)) {
    if (total <= MAX_TOTAL_BYTES && _store.size <= MAX_ENTRIES) break;
    _store.delete(id);
    total -= d.size;
  }
};
setInterval(sweep, 10 * 60 * 1000).unref();

const describe = (d) => ({
  id: d.id,
  name: d.name,
  kind: d.kind,
  rows: d.records.length,
  columns: d.columns,
  mapping: { ...Object.fromEntries(Object.entries(d.mapping).map(([role, i]) => [role, d.columns[i]])), ...(d.unit ? { unit: d.unit } : {}), ...(d.mode ? { mode: d.mode } : {}), ...(d.purpose ? { purpose: d.purpose } : {}), ...(d.dayType ? { day_type: d.dayType } : {}) },
  preview: d.records.slice(0, PREVIEW_ROWS),
  warnings: d.warnings,
  expiresAt: new Date(d.createdAt + DATA_TTL_MS).toISOString(),
});

/** Validate a client mapping: { kind?, unit?, mode?, purpose?, day_type?, columns?, <role>: header }. */
const readMapping = (raw) => {
  if (raw === null || raw === undefined || raw === "") return {};
  let m = raw;
  if (typeof raw === "string") {
    if (raw.length > 4000) throw typedError(400, "INVALID_MAPPING", "The mapping is too long.");
    try {
      m = JSON.parse(raw);
    } catch {
      throw typedError(400, "INVALID_MAPPING", "The mapping must be a JSON object.");
    }
  }
  if (!m || typeof m !== "object" || Array.isArray(m)) throw typedError(400, "INVALID_MAPPING", "The mapping must be a JSON object.");
  const out = { columns: {} };
  if (m.kind !== undefined) {
    if (!KINDS[m.kind]) throw typedError(400, "INVALID_MAPPING", `mapping.kind must be one of ${Object.keys(KINDS).join(", ")}.`);
    out.kind = m.kind;
  }
  if (m.unit !== undefined) {
    if (!WEEKDAYS_PER[m.unit]) throw typedError(400, "INVALID_MAPPING", "mapping.unit must be day, week, month or year.");
    out.unit = m.unit;
  }
  if (m.mode !== undefined) {
    if (!["add", "replace"].includes(m.mode)) throw typedError(400, "INVALID_MAPPING", "mapping.mode must be add or replace.");
    out.mode = m.mode;
  }
  if (m.purpose !== undefined) {
    if (!["work", "school", "other"].includes(m.purpose)) throw typedError(400, "INVALID_MAPPING", "mapping.purpose must be work, school or other.");
    out.purpose = m.purpose;
  }
  if (m.day_type !== undefined) out.dayType = clean(m.day_type, 40);
  const cols = { ...(m.columns && typeof m.columns === "object" ? m.columns : {}), ...m };
  for (const [role, header] of Object.entries(cols)) {
    if (!ROLES[role]) continue;
    if (typeof header !== "string" || !header.trim()) throw typedError(400, "INVALID_MAPPING", `mapping.${role} must be a column name.`);
    out.columns[role] = header.trim();
  }
  return out;
};

/** Read, recognise and store an uploaded file. Throws { status, code } on refusal. */
const ingestUserData = async ({ name, buffer, truncated = false, mapping = null }) => {
  const fileName = clean(path.basename(String(name || "data")), 160) || "data";
  if (!buffer || !buffer.length) throw typedError(400, "EMPTY_FILE", "The file is empty.");
  if (truncated || buffer.length > MAX_FILE_BYTES) throw typedError(413, "DATA_TOO_LARGE", `The file exceeds ${MAX_FILE_BYTES / 1024 / 1024} MB.`);
  const forced = readMapping(mapping);
  const parsed = await parseFile({ name: fileName, buffer });
  const pruned = attachment.pruneGhostColumns(parsed.headers, parsed.rows);
  const headers = pruned.headers.map((h, i) => clean(h, 80) || `column ${i + 1}`);
  if (!headers.length || !pruned.rows.length) throw typedError(400, "EMPTY_FILE", "The file has no data rows.");
  const { kind, mapping: cols } = detect(headers, forced);
  const warnings = [...parsed.notes];
  if (parsed.truncated) warnings.push(`only the first ${MAX_ROWS} rows were read`);
  const norm = normalise(kind, headers, pruned.rows, cols, { convention: parsed.convention });
  warnings.push(...norm.warnings);
  if (!norm.records.length) throw typedError(400, norm.badCoords ? "INVALID_COORDINATES" : "EMPTY_FILE", norm.badCoords ? "No row has usable coordinates: latitude and longitude must be in degrees (WGS84), not projected (Lambert-93…)." : `No row has the values "${kind}" needs: ${EXPECTED[kind]}.`, { columns: headers });
  let records = norm.records;
  // Several periods: the latest one is read (stated).
  const latest = kind === "line_ridership" || kind === "stop_ridership" ? periodLatest(records) : null;
  if (latest) {
    warnings.push(`several periods in the file: the latest one ("${latest}") is read`);
    records = records.filter((r) => !r.period || r.period === latest);
  }
  const unit = unitOf(kind, headers, cols, records, forced.unit, warnings);
  let purpose = null;
  if (kind === "od" && cols.purpose === undefined) {
    purpose = forced.purpose || "other";
    warnings.push(forced.purpose ? `every flow read as purpose "${purpose}" (mapping)` : 'no purpose column: flows counted as purpose "other"; send mapping.purpose (work, school) if they are commutes');
  }
  const id = crypto.randomBytes(12).toString("hex");
  const stored = { id, name: fileName, kind, columns: headers, mapping: cols, records, unit, mode: kind === "points" ? forced.mode || null : null, purpose, dayType: forced.dayType || null, warnings, size: JSON.stringify(records).length + 512, createdAt: Date.now() };
  sweep();
  _store.set(id, stored);
  sweep();
  return describe(stored);
};

const removeUserData = (id) => _store.delete(String(id || ""));

/** The stored data of a list of ids: { found, missing }. */
const getUserData = (ids) => {
  sweep();
  const found = [];
  const missing = [];
  for (const id of Array.isArray(ids) ? ids.slice(0, 20) : []) {
    const d = typeof id === "string" ? _store.get(id) : null;
    if (d) found.push(d);
    else missing.push(clean(id, 40));
  }
  return { found, missing };
};

// ── Merge into a demand-inputs draft ────────────────────────────────────────

const LAYER_OF = { pop: "pop", jobs: "jobs", students: "students" };
const QUALITY_OF = { pop: "population", jobs: "jobs", students: "schools" };
const inBox = (draft, lat, lon) => !draft.bbox || (lat >= draft.bbox[0] && lat <= draft.bbox[2] && lon >= draft.bbox[1] && lon <= draft.bbox[3]);
const fmt = (n) => Math.round(n).toLocaleString("en-US").replace(/,/g, " ");

const mergePoints = (draft, d, used) => {
  for (const field of Object.keys(LAYER_OF)) {
    const pts = d.records.filter((r) => r[field] > 0).map((r) => ({ lat: r.lat, lon: r.lon, v: r[field], kind: "user" }));
    if (!pts.length) continue;
    const layer = LAYER_OF[field];
    const userTotal = pts.reduce((s, p) => s + p.v, 0);
    const current = draft.layers[layer].filter((p) => inBox(draft, p.lat, p.lon)).reduce((s, p) => s + p.v, 0);
    // Default: a file that looks like a whole layer (10+ places holding at
    // least half the current total) replaces it; a few places are added.
    const mode = d.mode || (current === 0 || (pts.length >= FULL_LAYER_MIN_POINTS && userTotal >= 0.5 * current) ? "replace" : "add");
    if (mode === "replace") {
      draft.layers[layer] = pts;
      draft.quality[QUALITY_OF[field]] = "user";
    } else draft.layers[layer] = [...draft.layers[layer], ...pts];
    draft.warnings.push(`${layer === "pop" ? "population" : layer}: your file "${d.name}" (${fmt(userTotal)} in ${pts.length} places) ${mode === "replace" ? `replaces the previous layer (${fmt(current)})` : `is added to the previous layer (${fmt(current)})`}${d.mode ? "" : " — chosen from the file's size; send mapping.mode (add, replace) to change"}`);
    used.add(QUALITY_OF[field]);
  }
  const places = d.records.filter((r) => r.name || r.weight > 0);
  const gens = places.map((r, i) => {
    const weight = r.weight > 0 ? r.weight : (r.jobs || 0) + (r.students || 0) + (r.pop || 0);
    return { id: `user:${d.id}:${i}`, name: r.name || `${d.name} #${i + 1}`, category: r.category || (r.jobs > 0 ? "work" : r.students > 0 ? "school" : "user"), lat: r.lat, lon: r.lon, weight, ...(r.jobs > 0 ? { jobs: r.jobs } : {}), ...(r.students > 0 ? { students: r.students } : {}), source: "user" };
  });
  gens.sort((a, b) => b.weight - a.weight);
  if (gens.length) {
    draft.generators.push(...gens.slice(0, MAX_USER_GENERATORS));
    used.add("generators");
  }
  if (gens.length > MAX_USER_GENERATORS) draft.warnings.push(`generators: the ${MAX_USER_GENERATORS} largest places of "${d.name}" kept`);
};

const WEEKDAY = (value) => WEEKDAY_RE.test(fold(value));
/** A Map of counts → a plain object of counts rounded to 0.1 (own properties only). */
const toCounts = (m) => Object.fromEntries([...m.entries()].map(([k, v]) => [k, Math.round(v * 10) / 10]));

/** Stop counts → per stop (and per line when the file has lines), a typical weekday. */
const mergeStops = (draft, d, used) => {
  const factor = 1 / WEEKDAYS_PER[d.unit || "day"];
  let rows = d.records;
  const days = [...new Set(rows.map((r) => r.day).filter(Boolean))];
  let dayType = null;
  if (days.length) {
    dayType = d.dayType && days.includes(d.dayType) ? d.dayType : days.find(WEEKDAY) || null;
    if (!dayType) {
      const count = (t) => rows.filter((r) => r.day === t).length;
      dayType = [...days].sort((a, b) => count(b) - count(a))[0];
      draft.warnings.push(`observed: "${d.name}" has day types ${days.slice(0, 6).map((x) => `"${x}"`).join(", ")} and none reads as a weekday: "${dayType}" is used; send mapping.day_type to choose`);
    } else if (days.length > 1) draft.warnings.push(`observed: day type "${dayType}" of "${d.name}" read as the typical weekday`);
    rows = rows.filter((r) => r.day === dayType);
  }
  // Maps, not plain objects: a stop or line may be named anything ("__proto__").
  const perStop = new Map();
  const perLine = new Map();
  let hasBoardings = false;
  for (const r of rows) {
    const v = r.boardings !== null ? r.boardings : r.alightings;
    if (r.boardings !== null) hasBoardings = true;
    perStop.set(r.stop, (perStop.get(r.stop) || 0) + v * factor);
    if (r.line) perLine.set(r.line, (perLine.get(r.line) || 0) + v * factor);
  }
  const obs = draft.observed || { source: "user" };
  obs.per_stop = { ...(obs.per_stop || {}), ...toCounts(perStop) };
  if (perLine.size && !obs.per_line) {
    obs.per_line = toCounts(perLine);
    obs.per_line_basis = "stop_boardings";
  }
  if (!obs.network_daily) obs.network_daily = Math.round([...perStop.values()].reduce((s, v) => s + v, 0));
  obs.day_type = obs.day_type || dayType;
  if (!hasBoardings) draft.warnings.push(`observed: "${d.name}" has alightings only: they stand in for boardings`);
  draft.observed = obs;
  used.add("observed");
};

const mergeLines = (draft, d, used) => {
  const factor = 1 / WEEKDAYS_PER[d.unit || "day"];
  let rows = d.records;
  const days = [...new Set(rows.map((r) => r.day).filter(Boolean))];
  if (days.length > 1) {
    const dayType = d.dayType && days.includes(d.dayType) ? d.dayType : days.find(WEEKDAY) || days[0];
    rows = rows.filter((r) => r.day === dayType);
    draft.warnings.push(`observed: day type "${dayType}" of "${d.name}" is read`);
  }
  const perLine = new Map();
  for (const r of rows) perLine.set(r.line, (perLine.get(r.line) || 0) + r.trips * factor);
  const obs = draft.observed || { source: "user" };
  obs.per_line = toCounts(perLine);
  delete obs.per_line_basis;
  obs.network_daily = Math.round([...perLine.values()].reduce((s, v) => s + v, 0));
  draft.observed = obs;
  used.add("observed");
};

const mergeOd = (draft, d, used) => {
  const factor = 1 / WEEKDAYS_PER[d.unit || "day"];
  const place = (name, lat, lon) => ({ name, ...(Number.isFinite(lat) && Number.isFinite(lon) ? { lat, lon } : {}) });
  for (const r of d.records) draft.od.push({ from: place(r.origin, r.o_lat, r.o_lon), to: place(r.destination, r.d_lat, r.d_lon), flow: Math.round(r.flow * factor * 10) / 10, unit: "trips", purpose: r.purpose || d.purpose || "other", source: "user", observed: true });
  draft.quality.od = "user";
  used.add("od");
};

/** Merge the user's stored data into a draft (missing ids are warnings). */
const applyUserData = (draft, dataIds) => {
  const { found, missing } = getUserData(dataIds);
  for (const id of missing) draft.warnings.push(`your data "${id}": expired or unknown — upload the file again (files are kept ${DATA_TTL_MS / 3600000} hours)`);
  const used = new Set();
  for (const d of found) {
    if (d.kind === "points") mergePoints(draft, d, used);
    else if (d.kind === "stop_ridership") mergeStops(draft, d, used);
    else if (d.kind === "line_ridership") mergeLines(draft, d, used);
    else if (d.kind === "od") mergeOd(draft, d, used);
  }
  if (used.has("observed")) draft.quality.observed = "user";
  if (used.size) addSource(draft, { ...USER_SOURCE, used_for: [...used] });
};

module.exports = { ingestUserData, removeUserData, getUserData, applyUserData, describe, MAX_FILE_BYTES, MAX_ROWS, DATA_TTL_MS, _internals: { _store, sweep, detect, parseNumber, fold, readMapping, unitFromHeader, purposeOf, WEEKDAY_RE, WEEKDAYS_PER, MAX_TOTAL_BYTES, MAX_ENTRIES } };
