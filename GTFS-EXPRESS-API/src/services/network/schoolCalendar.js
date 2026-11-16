/**
 * School holidays by region: the codes that stand for a school zone (in France a zone, a région or an académie,
 * onto OpenHolidays' subdivisions), a region's periods, and the summer assumed after an « end of classes » marker.
 */

"use strict";

// France publishes the next school year's start with the next calendar: after an "end of classes" marker the
// summer holidays are assumed to run to the calendar's end, at most this long.
const SUMMER_ASSUMED_MAX_DAYS = 60;
const END_OF_CLASSES_RE = /fin des cours|end of (the )?(school )?(year|classes|term)|last day of school|schuljahresende|letzter schultag|fin del? curso|fine (delle )?lezioni|einde (van het )?schooljaar/i;

// France: the régions wholly in each school zone.
const FR_ZONE_REGIONS = { ZA: ["AR", "BF", "NA"], ZB: ["BT", "CV", "GE", "HF", "NO", "PC", "PL"], ZC: ["IF", "OC"] };
// France: the régions by their names as a geocoder writes them (letters only, no accents) onto the codes above.
const FR_REGION_NAMES = { AUVERGNERHONEALPES: "AR", BOURGOGNEFRANCHECOMTE: "BF", NOUVELLEAQUITAINE: "NA", BRETAGNE: "BT", CENTREVALDELOIRE: "CV", GRANDEST: "GE", HAUTSDEFRANCE: "HF", NORMANDIE: "NO", PROVENCEALPESCOTEDAZUR: "PC", PAYSDELALOIRE: "PL", ILEDEFRANCE: "IF", OCCITANIE: "OC", CORSE: "CO", CORSICA: "CO" };
// A subdivision code: short segments (FR-ZC, ZC-TO), never a name written with hyphens (ILE-DE-FRANCE).
const CODE_RE = /^[A-Z0-9]{1,3}(?:-[A-Z0-9]{1,3})+$/;
// France: the académies of each zone (letters only, no accents).
const FR_ZONE_ACADEMIES = {
  ZA: ["BESANCON", "BORDEAUX", "CLERMONTFERRAND", "DIJON", "GRENOBLE", "LIMOGES", "LYON", "POITIERS"],
  ZB: ["AIXMARSEILLE", "AMIENS", "LILLE", "NANCYMETZ", "NANTES", "NICE", "NORMANDIE", "ORLEANSTOURS", "REIMS", "RENNES", "STRASBOURG"],
  ZC: ["CRETEIL", "MONTPELLIER", "PARIS", "TOULOUSE", "VERSAILLES"],
};

const str = (v) => (typeof v === "string" ? v.trim() : v == null ? "" : String(v).trim());

/** "2026-10-18", "20261018" or an ISO time → "20261018"; null otherwise. */
const toYmd = (v) => {
  const s = str(v).slice(0, 10).replace(/-/g, "");
  return /^\d{8}$/.test(s) ? s : null;
};
const dateOf = (ymd) => new Date(Date.UTC(+ymd.slice(0, 4), +ymd.slice(4, 6) - 1, +ymd.slice(6, 8)));
const addDays = (ymd, n) => {
  const d = dateOf(ymd);
  d.setUTCDate(d.getUTCDate() + n);
  return d.toISOString().slice(0, 10).replace(/-/g, "");
};

/** Upper case, no accents, "zone c" → "C", spaces → "-" (region codes). */
const canon = (v) =>
  str(v)
    .normalize("NFD")
    .replace(/[̀-ͯ]/g, "")
    .toUpperCase()
    .replace(/[\s_]+/g, " ")
    .replace(/^(ZONE|ZONA)\s+/, "")
    .replace(/^ACADEMIE\s+(DE\s+|D')?/, "")
    .trim();
const codeOf = (v, country) => {
  let c = canon(v).replace(/\s+/g, "-");
  if (country && c.startsWith(`${country}-`)) c = c.slice(country.length + 1);
  return c;
};

/**
 * The subdivision codes that stand for a region: itself, without its
 * country prefix, its parent (ZC-TO → ZC) and, in France, its zone and the
 * régions of that zone.
 */
const regionCandidates = (region, country = null) => {
  const out = new Set();
  const r = canon(region);
  if (!r) return out;
  const code = codeOf(r, country);
  out.add(code);
  // Without a known country, "FR-ZC" may still carry one.
  if (!country && /^[A-Z]{2}-[A-Z0-9]/.test(code)) out.add(code.slice(3));
  for (const c of [...out]) for (let x = c; CODE_RE.test(x); x = x.slice(0, x.lastIndexOf("-"))) out.add(x.slice(0, x.lastIndexOf("-")));
  if (country === "FR") {
    const letters = r.replace(/[^A-Z]/g, "");
    if (/^[ABC]$/.test(code)) out.add(`Z${code}`);
    for (const [zone, list] of Object.entries(FR_ZONE_ACADEMIES)) if (list.includes(letters)) out.add(zone);
    if (FR_REGION_NAMES[letters]) out.add(FR_REGION_NAMES[letters]);
    for (const [zone, regions] of Object.entries(FR_ZONE_REGIONS)) if (regions.some((x) => out.has(x))) out.add(zone);
    for (const [zone, regions] of Object.entries(FR_ZONE_REGIONS)) if (out.has(zone)) regions.forEach((x) => out.add(x));
  }
  return out;
};

const matchEntries = (entries, region, country) => {
  const cands = region ? regionCandidates(region, country) : new Set();
  return entries.filter((e) => e.nationwide || (region && e.regions.some((x) => cands.has(codeOf(x, country)))));
};

const entriesOf = (list) =>
  (Array.isArray(list) ? list : [])
    .map((h) => ({ start: toYmd(h?.start), end: toYmd(h?.end), name: str(h?.name), regions: (Array.isArray(h?.regions) ? h.regions : []).map(str).filter(Boolean), nationwide: h?.nationwide === true || !(Array.isArray(h?.regions) && h.regions.length) }))
    .filter((e) => e.start && e.end && e.end >= e.start);

/** The school regions a territory's holidays distinguish (France: its zones as A, B, C). */
const schoolRegions = (territory) => {
  const country = str(territory?.place?.country_code).toUpperCase() || null;
  const codes = [...new Set(entriesOf(territory?.school_holidays).filter((e) => !e.nationwide).flatMap((e) => e.regions.map((x) => codeOf(x, country))))];
  if (country !== "FR") return codes.sort();
  const zoneRegions = new Set(Object.values(FR_ZONE_REGIONS).flat());
  const zones = codes.filter((c) => /^Z[ABC]$/.test(c)).map((c) => c.slice(1));
  const others = codes.filter((c) => !/^Z[ABC]$/.test(c) && !zoneRegions.has(c));
  // A dossier whose zone codes were cut off still names the zones' régions.
  for (const [zone, regions] of Object.entries(FR_ZONE_REGIONS)) if (!zones.includes(zone.slice(1)) && regions.some((x) => codes.includes(x))) zones.push(zone.slice(1));
  return [...zones.sort(), ...others.sort()];
};

module.exports = { _internals: { FR_REGION_NAMES, FR_ZONE_REGIONS, str, toYmd, dateOf, addDays, canon, codeOf, regionCandidates, matchEntries, entriesOf, schoolRegions, END_OF_CLASSES_RE, SUMMER_ASSUMED_MAX_DAYS } };
