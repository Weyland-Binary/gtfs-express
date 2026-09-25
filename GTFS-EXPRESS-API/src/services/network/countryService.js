/**
 * countryService — what a network designer must know about the country a
 * territory lies in, from public keyless sources, so the plan fits local
 * practice anywhere in the world:
 *
 *   • Wikidata (SPARQL)     — name, current currency (ISO 4217), official
 *                             languages (ISO 639-1), driving side
 *   • World Bank            — region and income level; GDP per capita, urban
 *                             population share, and the price level (PPP
 *                             conversion factor ÷ official exchange rate)
 *   • ExchangeRate-API      — EUR → local currency (open endpoint)
 *   • a built-in table      — the usual weekend days (Friday–Saturday in
 *                             much of the Middle East and North Africa…)
 *
 *   countryContext(cc, { fetchImpl }) → {
 *     code, name, region, income_level, currency: { code, symbol },
 *     languages: ["fr", …], driving_side, weekend: ["sat","sun"],
 *     gdp_per_capita_usd, urban_pct, price_level, price_level_ratio, eur_rate,
 *     cost_factor,        // multiply a EUR cost at French price level to get
 *                         // the local-currency cost at local price level
 *     sources, warnings
 *   }
 *
 * Each source fails soft; results are cached a day per country (the World
 * Bank's price indicators can take several seconds to answer).
 */

"use strict";

const config = require("../../config");

const TIMEOUT_MS = 25000;
const CACHE_TTL_MS = 24 * 60 * 60 * 1000;
const REFERENCE_COUNTRY = "FR"; // the per-mode cost defaults are French orders of magnitude
const _cache = new Map();

// The usual weekly rest days where they differ from Saturday–Sunday.
const WEEKEND = {
  DZ: ["fri", "sat"], BH: ["fri", "sat"], BD: ["fri", "sat"], EG: ["fri", "sat"], IQ: ["fri", "sat"], IL: ["fri", "sat"], JO: ["fri", "sat"], KW: ["fri", "sat"], LY: ["fri", "sat"], OM: ["fri", "sat"], QA: ["fri", "sat"], SA: ["fri", "sat"], SD: ["fri", "sat"], SY: ["fri", "sat"], YE: ["fri", "sat"],
  IR: ["fri"], AF: ["fri"], NP: ["sat"], BN: ["fri", "sun"],
};
const DEFAULT_WEEKEND = ["sat", "sun"];

// ISO 3166-1 alpha-2 → ISO 4217 (the currency in use; stable enough to ship,
// and more reliable than Wikidata where a country lists several currencies,
// e.g. France with the euro and the CFP franc of its Pacific territories).
const CURRENCY = Object.fromEntries(
  "AD:EUR AE:AED AF:AFN AG:XCD AI:XCD AL:ALL AM:AMD AO:AOA AR:ARS AS:USD AT:EUR AU:AUD AW:AWG AX:EUR AZ:AZN BA:BAM BB:BBD BD:BDT BE:EUR BF:XOF BG:EUR BH:BHD BI:BIF BJ:XOF BL:EUR BM:BMD BN:BND BO:BOB BQ:USD BR:BRL BS:BSD BT:BTN BW:BWP BY:BYN BZ:BZD CA:CAD CD:CDF CF:XAF CG:XAF CH:CHF CI:XOF CK:NZD CL:CLP CM:XAF CN:CNY CO:COP CR:CRC CU:CUP CV:CVE CW:ANG CY:EUR CZ:CZK DE:EUR DJ:DJF DK:DKK DM:XCD DO:DOP DZ:DZD EC:USD EE:EUR EG:EGP ER:ERN ES:EUR ET:ETB FI:EUR FJ:FJD FK:FKP FM:USD FO:DKK FR:EUR GA:XAF GB:GBP GD:XCD GE:GEL GF:EUR GG:GBP GH:GHS GI:GIP GL:DKK GM:GMD GN:GNF GP:EUR GQ:XAF GR:EUR GT:GTQ GU:USD GW:XOF GY:GYD HK:HKD HN:HNL HR:EUR HT:HTG HU:HUF ID:IDR IE:EUR IL:ILS IM:GBP IN:INR IQ:IQD IR:IRR IS:ISK IT:EUR JE:GBP JM:JMD JO:JOD JP:JPY KE:KES KG:KGS KH:KHR KI:AUD KM:KMF KN:XCD KP:KPW KR:KRW KW:KWD KY:KYD KZ:KZT LA:LAK LB:LBP LC:XCD LI:CHF LK:LKR LR:LRD LS:LSL LT:EUR LU:EUR LV:EUR LY:LYD MA:MAD MC:EUR MD:MDL ME:EUR MF:EUR MG:MGA MH:USD MK:MKD ML:XOF MM:MMK MN:MNT MO:MOP MP:USD MQ:EUR MR:MRU MS:XCD MT:EUR MU:MUR MV:MVR MW:MWK MX:MXN MY:MYR MZ:MZN NA:NAD NC:XPF NE:XOF NG:NGN NI:NIO NL:EUR NO:NOK NP:NPR NR:AUD NU:NZD NZ:NZD OM:OMR PA:PAB PE:PEN PF:XPF PG:PGK PH:PHP PK:PKR PL:PLN PM:EUR PR:USD PS:ILS PT:EUR PW:USD PY:PYG QA:QAR RE:EUR RO:RON RS:RSD RU:RUB RW:RWF SA:SAR SB:SBD SC:SCR SD:SDG SE:SEK SG:SGD SH:SHP SI:EUR SK:EUR SL:SLE SM:EUR SN:XOF SO:SOS SR:SRD SS:SSP ST:STN SV:USD SX:ANG SY:SYP SZ:SZL TC:USD TD:XAF TG:XOF TH:THB TJ:TJS TL:USD TM:TMT TN:TND TO:TOP TR:TRY TT:TTD TV:AUD TW:TWD TZ:TZS UA:UAH UG:UGX US:USD UY:UYU UZ:UZS VA:EUR VC:XCD VE:VES VG:USD VI:USD VN:VND VU:VUV WF:XPF WS:WST XK:EUR YE:YER YT:EUR ZA:ZAR ZM:ZMW ZW:ZWG"
    .split(" ")
    .map((p) => p.split(":")),
);

const SOURCES = {
  wikidata: { id: "wikidata", name: "Wikidata", url: "https://www.wikidata.org", license: "CC0" },
  worldbank: { id: "worldbank", name: "World Bank Open Data", url: "https://data.worldbank.org", license: "CC BY 4.0" },
  exchangerate: { id: "exchangerate", name: "ExchangeRate-API (open access)", url: "https://www.exchangerate-api.com", license: "attribution" },
};

const getJson = async (fetchImpl, url, accept = "application/json") => {
  const ctl = new AbortController();
  const timer = setTimeout(() => ctl.abort(), TIMEOUT_MS);
  try {
    const res = await fetchImpl(url, { signal: ctl.signal, headers: { Accept: accept, "User-Agent": "gtfs-express/1.0 (network studio)" } });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    return await res.json();
  } finally {
    clearTimeout(timer);
  }
};

/** Name, current currency, official languages and driving side from Wikidata. */
const wikidataCountry = async (cc, fetchImpl) => {
  const q = `SELECT ?countryLabel ?currencyCode ?langCode ?dsLabel WHERE {
  ?country wdt:P297 "${cc}" .
  OPTIONAL { ?country p:P38 ?cst . ?cst ps:P38 ?currency . FILTER NOT EXISTS { ?cst pq:P582 ?end } ?currency wdt:P498 ?currencyCode . }
  OPTIONAL { ?country wdt:P37 ?lang . ?lang wdt:P218 ?langCode . }
  OPTIONAL { ?country wdt:P1622 ?ds . }
  SERVICE wikibase:label { bd:serviceParam wikibase:language "en". }
}`;
  const data = await getJson(fetchImpl, `${config.WIKIDATA_SPARQL_URL}?format=json&query=${encodeURIComponent(q)}`, "application/sparql-results+json");
  const rows = (data?.results?.bindings || []).map((b) => Object.fromEntries(Object.entries(b).map(([k, v]) => [k, v.value])));
  if (!rows.length) return null;
  const uniq = (key) => [...new Set(rows.map((r) => r[key]).filter(Boolean))];
  const side = uniq("dsLabel").map((s) => s.toLowerCase()).find((s) => s.includes("left") || s.includes("right"));
  return { name: rows[0].countryLabel || cc, currency: uniq("currencyCode")[0] || null, languages: uniq("langCode").slice(0, 6), driving_side: side ? (side.includes("left") ? "left" : "right") : null };
};

/** Region and income level from the World Bank country record. */
const worldBankCountry = async (cc, fetchImpl) => {
  const data = await getJson(fetchImpl, `${config.WORLD_BANK_URL}/country/${encodeURIComponent(cc)}?format=json`);
  const row = Array.isArray(data) && Array.isArray(data[1]) ? data[1][0] : null;
  return row ? { region: row.region?.value || null, income_level: row.incomeLevel?.value || null } : null;
};

/** Latest non-empty value of a World Bank indicator for a country (ISO-2). */
const worldBank = async (cc, indicator, fetchImpl) => {
  const data = await getJson(fetchImpl, `${config.WORLD_BANK_URL}/country/${encodeURIComponent(cc)}/indicator/${indicator}?format=json&mrnev=1&per_page=1`);
  const row = Array.isArray(data) && Array.isArray(data[1]) ? data[1][0] : null;
  const v = row && row.value != null ? Number(row.value) : null;
  return Number.isFinite(v) ? { value: v, year: row.date ? Number(row.date) : null } : null;
};

/** Price level: PPP conversion factor (LCU per international $) ÷ official exchange rate (LCU per US$). */
const priceLevelOf = async (cc, fetchImpl, soft) => {
  const [ppp, fx] = await Promise.all([soft(`worldbank ppp ${cc}`, () => worldBank(cc, "PA.NUS.PPP", fetchImpl)), soft(`worldbank exchange rate ${cc}`, () => worldBank(cc, "PA.NUS.FCRF", fetchImpl))]);
  return ppp && fx && fx.value > 0 ? ppp.value / fx.value : null;
};

const symbolOf = (code) => {
  try {
    return new Intl.NumberFormat("en", { style: "currency", currency: code, currencyDisplay: "narrowSymbol" }).formatToParts(1).find((p) => p.type === "currency")?.value || code;
  } catch {
    return code;
  }
};

const countryContext = async (countryCode, { fetchImpl = null, force = false } = {}) => {
  const cc = String(countryCode || "").toUpperCase();
  if (!/^[A-Z]{2}$/.test(cc)) return null;
  const cached = _cache.get(cc);
  if (cached && !force && Date.now() - cached.at < CACHE_TTL_MS) return cached.value;
  const doFetch = fetchImpl || (typeof fetch === "function" ? fetch : null);
  if (!doFetch) return null;
  const warnings = [];
  const soft = async (label, fn) => {
    try {
      return await fn();
    } catch (err) {
      warnings.push(`${label}: ${err.name === "AbortError" ? "timeout" : err.message}`);
      return null;
    }
  };
  const [wd, wbc, gdp, urban, level, levelRef, fx] = await Promise.all([
    soft("wikidata", () => wikidataCountry(cc, doFetch)),
    soft("worldbank country", () => worldBankCountry(cc, doFetch)),
    soft("worldbank gdp", () => worldBank(cc, "NY.GDP.PCAP.CD", doFetch)),
    soft("worldbank urban", () => worldBank(cc, "SP.URB.TOTL.IN.ZS", doFetch)),
    priceLevelOf(cc, doFetch, soft),
    cc === REFERENCE_COUNTRY ? Promise.resolve(null) : priceLevelOf(REFERENCE_COUNTRY, doFetch, soft),
    soft("exchange rate", () => getJson(doFetch, `${config.EXCHANGE_RATE_URL}/latest/EUR`)),
  ]);
  const currencyCode = CURRENCY[cc] || wd?.currency || null;
  const currency = currencyCode ? { code: currencyCode, symbol: symbolOf(currencyCode) } : null;
  let eurRate = currencyCode === "EUR" ? 1 : null;
  if (currencyCode && eurRate == null) {
    const rate = fx && fx.rates ? Number(fx.rates[currencyCode]) : NaN;
    if (Number.isFinite(rate) && rate > 0) eurRate = rate;
  }
  const ref = cc === REFERENCE_COUNTRY ? level : levelRef;
  // Local cost = EUR cost at French price level × (local / French price level) × EUR→local rate.
  const levelRatio = level && ref ? Math.max(0.1, Math.min(3, level / ref)) : 1;
  const costFactor = eurRate != null ? Math.round(levelRatio * eurRate * 10000) / 10000 : null;
  const value = {
    code: cc,
    name: wd?.name || cc,
    region: wbc?.region || null,
    income_level: wbc?.income_level || null,
    currency,
    languages: wd?.languages || [],
    driving_side: wd?.driving_side || null,
    weekend: WEEKEND[cc] || DEFAULT_WEEKEND,
    gdp_per_capita_usd: gdp ? Math.round(gdp.value) : null,
    gdp_year: gdp ? gdp.year : null,
    urban_pct: urban ? Math.round(urban.value * 10) / 10 : null,
    price_level: level != null ? Math.round(level * 1000) / 1000 : null,
    price_level_ratio: Math.round(levelRatio * 1000) / 1000,
    eur_rate: eurRate,
    cost_factor: costFactor,
    sources: [...(wd ? [SOURCES.wikidata] : []), ...(wbc || gdp || urban || level != null ? [SOURCES.worldbank] : []), ...(eurRate != null && currencyCode !== "EUR" ? [SOURCES.exchangerate] : [])],
    warnings,
  };
  _cache.set(cc, { at: Date.now(), value });
  return value;
};

/** One paragraph for the planner. */
const summarizeCountry = (c) => {
  if (!c) return "";
  const parts = [`Country: ${c.name} (${c.code}${c.region ? `, ${c.region}` : ""}${c.income_level ? `, ${c.income_level}` : ""}).`];
  if (c.currency) parts.push(`Currency ${c.currency.code} (${c.currency.symbol}).`);
  if (c.languages.length) parts.push(`Official languages: ${c.languages.join(", ")} (use the first for agency.lang unless the brief says otherwise).`);
  parts.push(`Usual weekend: ${c.weekend.join("+")}${c.weekend.join() !== DEFAULT_WEEKEND.join() ? " — set spec.weekend to these days so 'weekday' and 'weekend' calendars follow local practice" : ""}.`);
  if (c.driving_side) parts.push(`Traffic drives on the ${c.driving_side}.`);
  if (c.gdp_per_capita_usd) parts.push(`GDP per capita ≈ ${c.gdp_per_capita_usd} USD (${c.gdp_year}); urban population ${c.urban_pct ?? "?"}%.`);
  if (c.cost_factor != null && c.currency) parts.push(`Operating costs are estimated in ${c.currency.code} at the local price level (factor ${c.cost_factor} on EUR costs at French prices).`);
  return parts.join(" ");
};

module.exports = { countryContext, summarizeCountry, WEEKEND, DEFAULT_WEEKEND, CURRENCY, SOURCES, _internals: { _cache, worldBank, wikidataCountry, symbolOf } };
