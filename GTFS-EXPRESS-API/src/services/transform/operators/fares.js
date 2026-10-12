/**
 * update_fares — "From 1 January: single ticket 2.10 € (instead of 2.00 €),
 * 10-trip book 20.00 €", "+5 % on every fare, rounded to 5 cents", "Line 12
 * becomes free".
 *
 * Fares v1 (fare_attributes / fare_rules):
 *   • fare_ids (a list, or "all") with price (the new price), percent (± %)
 *     or prices ({ fare_id: price } — one price per fare, as notices list
 *     them); except: fares left as they are. A percentage is rounded to
 *     `rounding` (default 0.05 in the currency; "none": to the currency's
 *     minor unit); a stated price is taken as is and must fit the currency
 *     (2.105 USD is a question). The feed's own price format is kept
 *     (2 decimals, 0 for JPY…).
 *   • free: { routes } (or a list, or "all") → one fare priced 0 ("free",
 *     reused when a zero fare of that currency exists; one per agency in a
 *     multi-agency feed) whose fare_rules are those routes; the routes'
 *     other fare rules go (warning). A fare left without any rule is
 *     deleted: in fares v1 a fare without rules applies to every trip.
 *   • A feed without fares: price + currency + routes (a list, or "all")
 *     create a v1 fare (fare_id, default "standard"). No currency is ever
 *     guessed (currency_missing). A fare_ids naming one unknown fare with
 *     price and routes creates it beside the others (warning: v1 has no
 *     products, the cheapest applicable fare is what planners show).
 *     payment_method defaults to the one the feed's fares share, else 0
 *     (paid on board, said); transfers default to unlimited (empty).
 * Fares v2 (fare_products): fare_product_ids (or fare_ids in a feed with
 *   only v2) with amount/price, percent or prices likewise, optionally only
 *   the rows of a rider_category or fare_media. free is not written in v2
 *   (it needs networks and leg rules): a question.
 * Not expressible here (a question, never a silent approximation): zones
 *   (a zone restructure needs stops.zone_id or v2 areas), fare capping.
 * Checks: a currency named in the brief must be the fares' (currency_mismatch);
 *   one absolute price for fares in several currencies is a question. GTFS
 *   does not date fares: an effective date is a warning (publish the feed
 *   from that date), days or periods are a question. A feed with both v1
 *   and v2 where only one is changed is warned.
 */

"use strict";

const R = require("../resolve");
const G = require("../gtfsOps");
const { tr, number } = require("../i18n");

const ZERO_DECIMALS = new Set(["BIF", "CLP", "DJF", "GNF", "ISK", "JPY", "KMF", "KRW", "PYG", "RWF", "UGX", "UYI", "VND", "VUV", "XAF", "XOF", "XPF"]);
const THREE_DECIMALS = new Set(["BHD", "IQD", "JOD", "KWD", "LYD", "OMR", "TND"]);
const SYMBOLS = { "€": "EUR", "£": "GBP" }; // "$" and "¥" name several currencies: never read
const PAYMENT = { on_board: "0", onboard: "0", before_boarding: "1", prepaid: "1" };

const given = (v) => v != null && v !== "" && !(Array.isArray(v) && !v.length);
const few = (xs, n = 8) => (xs.length > n ? `${xs.slice(0, n).join(", ")} … (+${xs.length - n})` : xs.join(", "));
const byId = (a, b) => (a < b ? -1 : a > b ? 1 : 0);
const label = (r) => r.short_name || r.id;
const list = (v) => (Array.isArray(v) ? v : String(v).split(/[,;]/)).map((x) => String(x).trim()).filter(Boolean);
const isAll = (v) => typeof v === "string" && ["all", "tous", "toutes", "every", "*"].includes(v.trim().toLowerCase());

const tableExists = (db, t) => Boolean(db.prepare("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = ?").get(t));
const v1Fares = (db) => (tableExists(db, "fare_attributes") ? db.prepare("SELECT * FROM fare_attributes ORDER BY fare_id").all() : []);
const v2Products = (db) => (tableExists(db, "fare_products") ? db.prepare("SELECT rowid AS _rid, * FROM fare_products ORDER BY fare_product_id, rider_category_id, fare_media_id, rowid").all() : []);
const rulesOf = (db) => (tableExists(db, "fare_rules") ? db.prepare("SELECT rowid AS _rid, * FROM fare_rules ORDER BY rowid").all() : []);

const decimalsOf = (cur) => (ZERO_DECIMALS.has(cur) ? 0 : THREE_DECIMALS.has(cur) ? 3 : 2);
const fmt = (n, cur) => Number(n).toFixed(decimalsOf(cur));
/** A price as the language writes it (fr: 2,10), in the currency's format. */
const money = (lang, n, cur) => number(lang, n, decimalsOf(cur));
const fits = (n, cur) => Math.abs(n * 10 ** decimalsOf(cur) - Math.round(n * 10 ** decimalsOf(cur))) < 1e-6;

/** A price as written: 2.10, "2,10 €", "EUR 2.10" → { amount, currency|null } or null. */
const parseMoney = (v) => {
  if (typeof v === "number") return Number.isFinite(v) ? { amount: v, currency: null } : null;
  const s = String(v ?? "").trim();
  const m = /-?\d+(?:[.,]\d+)?/.exec(s.replace(/\s+/g, ""));
  if (!m || /[^\d\s.,€£$¥A-Za-z+-]/.test(s)) return null;
  const code = /(?:^|[^A-Za-z])([A-Za-z]{3})(?:$|[^A-Za-z])/.exec(s);
  const sym = Object.keys(SYMBOLS).find((k) => s.includes(k));
  return { amount: parseFloat(m[0].replace(",", ".")), currency: code ? code[1].toUpperCase() : sym ? SYMBOLS[sym] : null };
};
const parsePercent = (v) => {
  const n = typeof v === "number" ? v : parseFloat(String(v ?? "").replace(/\s|%/g, "").replace("−", "-").replace(",", "."));
  return Number.isFinite(n) && n !== 0 && n > -100 && n <= 1000 ? n : null;
};
/** Rounded to the step (never finer than the currency's minor unit), half up. */
const roundTo = (x, step, cur) => {
  const unit = 10 ** -decimalsOf(cur);
  const st = step == null ? unit : Math.max(step, unit);
  return Number((Math.round(x / st + 1e-9) * st).toFixed(decimalsOf(cur)));
};

/** Fare ids as the brief gives them, matched exactly then ignoring case. */
const matchIds = (refs, known, param, what, lang) => {
  const out = [];
  const bad = [];
  for (const r of refs) {
    const hit = known.find((k) => k === r) || known.find((k) => k.toLowerCase() === r.toLowerCase());
    if (hit) out.push(hit);
    else bad.push(r);
  }
  const named = bad.map((b) => `"${b}"`).join(", ");
  return { ids: [...new Set(out)], bad, ambiguity: bad.length ? { param, code: `${what}_unknown`, message: tr(lang, what === "fare" ? "update_fares.fare_unknown" : "update_fares.fare_product_unknown", { refs: named }), options: known } : null };
};

const resolveRoutes = (model, v, param, ambiguities, lang) => {
  if (isAll(v)) return [...model.routes.keys()].sort(byId);
  const out = [];
  for (const ref of Array.isArray(v) ? v : list(v)) {
    const r = R.route(model, ref, { lang });
    if (r.ambiguity) ambiguities.push({ param, ...r.ambiguity });
    else out.push(r.value.id);
  }
  return [...new Set(out)];
};

const resolve = async (model, p, ctx) => {
  const db = ctx.db;
  const lang = ctx.lang;
  const ambiguities = [];
  const warnings = [];
  const push = (param, a) => ambiguities.push({ param, ...a });
  const v1 = v1Fares(db);
  const v2 = v2Products(db);

  // What GTFS cannot say.
  for (const k of ["days", "dates", "period"]) if (given(p[k])) push(k, { code: "days_unsupported", message: tr(lang, "update_fares.days_unsupported") });
  if (given(p.zones)) push("zones", { code: "zones_unsupported", message: tr(lang, "update_fares.zones_unsupported") });
  if (given(p.capping) || given(p.cap)) push("capping", { code: "capping_unsupported", message: tr(lang, "update_fares.capping_unsupported") });
  const when = p.effective_date ?? p.from_date;
  if (given(when)) warnings.push(tr(lang, "update_fares.undated", { date: String(when) }));

  let currency = null;
  if (given(p.currency)) {
    currency = String(p.currency).trim().toUpperCase();
    if (!/^[A-Z]{3}$/.test(currency)) push("currency", { code: "currency_invalid", message: tr(lang, "update_fares.currency_invalid", { value: String(p.currency) }) });
  }
  let rounding = 0.05;
  if (given(p.rounding)) {
    if (String(p.rounding).trim().toLowerCase() === "none") rounding = null;
    else {
      const n = typeof p.rounding === "number" ? p.rounding : parseFloat(String(p.rounding).replace(",", "."));
      if (!(n > 0) || n > 10) push("rounding", { code: "rounding_invalid", message: tr(lang, "update_fares.rounding_invalid") });
      else rounding = n;
    }
  }
  const forms = ["price", "percent", "prices"].filter((k) => given(p[k]) || (k === "price" && given(p.amount)));
  if (forms.length > 1) push("price", { code: "price_conflict", message: tr(lang, "update_fares.price_conflict", { forms: forms.join(tr(lang, "common.and_sep")) }), options: forms });
  let price = null;
  const rawPrice = given(p.price) ? p.price : p.amount;
  if (given(rawPrice)) {
    price = parseMoney(rawPrice);
    if (!price || price.amount < 0) push("price", { code: "price_invalid", message: tr(lang, "update_fares.price_invalid", { value: String(rawPrice) }) });
  }
  let percent = null;
  if (given(p.percent)) {
    percent = parsePercent(p.percent);
    if (percent == null) push("percent", { code: "percent_invalid", message: tr(lang, "update_fares.percent_invalid", { value: String(p.percent) }) });
  }
  let prices = null;
  if (given(p.prices)) {
    if (typeof p.prices !== "object" || Array.isArray(p.prices)) push("prices", { code: "prices_invalid", message: tr(lang, "update_fares.prices_invalid") });
    else {
      prices = new Map();
      for (const [k, x] of Object.entries(p.prices)) {
        const m = parseMoney(x);
        if (!m || m.amount < 0) push("prices", { code: "price_invalid", message: tr(lang, "update_fares.price_invalid_for", { value: String(x), fare: k }) });
        else prices.set(k, m);
      }
    }
  }
  const rider = given(p.rider_category) ? String(p.rider_category).trim() : null;
  const media = given(p.fare_media) ? String(p.fare_media).trim() : null;
  if (ambiguities.length) return { ambiguities, warnings };
  const opts = { currency, rounding, price, percent, prices, rider, media, lang };

  if (given(p.free)) {
    if (forms.length) return { ambiguities: [{ param: "free", code: "free_conflict", message: tr(lang, "update_fares.free_conflict") }], warnings };
    return resolveFree(model, db, p, v1, v2, opts, warnings);
  }
  if (!forms.length) return { ambiguities: [{ param: "price", code: "price_missing", message: tr(lang, "update_fares.price_missing") }], warnings };

  // Which model: v2 when named or when the feed has only v2.
  const wantV2 = given(p.fare_product_ids) || (!v1.length && v2.length > 0);
  if (!v1.length && !v2.length) return resolveCreate(model, db, p, opts, warnings, null);
  if (wantV2) return resolveV2(db, p, v1, v2, opts, warnings);
  return resolveV1(model, db, p, v1, v2, opts, warnings);
};

/** New prices for rows [{ key, currency, price }] → [{ key, currency, before, after }] or an ambiguity. */
const newPrices = (rows, opts, param) => {
  const lang = opts.lang;
  const out = [];
  const currencies = [...new Set(rows.map((r) => r.currency))].sort();
  if (opts.currency) {
    const other = rows.filter((r) => r.currency !== opts.currency);
    if (other.length) return { ambiguity: { param: "currency", code: "currency_mismatch", message: tr(lang, "update_fares.currency_mismatch", { fares: few(other.map((r) => tr(lang, "update_fares.is_in", { fare: r.key, currency: r.currency }))), currency: opts.currency }), options: currencies } };
  }
  if (opts.price && currencies.length > 1) return { ambiguity: { param: "price", code: "currency_mismatch", message: tr(lang, "update_fares.currencies_mixed", { currencies: currencies.join(tr(lang, "common.and_sep")) }), options: currencies } };
  const questions = [];
  for (const r of rows) {
    const before = parseFloat(r.price);
    let after;
    let stated = null;
    if (opts.percent != null) after = roundTo(before * (1 + opts.percent / 100), opts.rounding, r.currency);
    else {
      stated = opts.price || opts.prices.get(r.key) || opts.prices.get(r.id);
      if (!stated) continue;
      after = stated.amount;
    }
    if (stated && stated.currency && stated.currency !== r.currency) questions.push({ param, code: "currency_mismatch", message: tr(lang, "update_fares.currency_conflict", { fare: r.key, currency: r.currency, stated: stated.currency }), options: [r.currency, stated.currency] });
    else if (stated && !fits(after, r.currency)) questions.push({ param, code: "price_invalid", message: tr(lang, "update_fares.too_many_decimals", { price: after, currency: r.currency, decimals: decimalsOf(r.currency), fare: r.key }) });
    else out.push({ ...r, before, after });
  }
  return questions.length ? { ambiguities: questions } : { value: out };
};

/** Fares listed one by one but left without a price in `prices`: a question, not a silent "unchanged". */
const unpriced = (ref, rows, opts, param) => {
  if (!opts.prices || !given(ref) || isAll(ref)) return null;
  const miss = [...new Set(rows.filter((r) => !opts.prices.has(r.id) && !opts.prices.has(r.key)).map((r) => r.id))];
  return miss.length ? { param, code: "price_missing", message: tr(opts.lang, "update_fares.unpriced", { fares: miss.join(", "), count: miss.length }) } : null;
};

const resolveV1 = (model, db, p, v1, v2, opts, warnings) => {
  const lang = opts.lang;
  const ambiguities = [];
  const known = v1.map((f) => f.fare_id);
  if (opts.rider || opts.media) return { ambiguities: [{ param: opts.rider ? "rider_category" : "fare_media", code: "rider_category_unsupported", message: tr(lang, "update_fares.rider_category_unsupported") }], warnings };
  let ids = [];
  if (opts.prices && !given(p.fare_ids)) ids = [...opts.prices.keys()];
  else if (isAll(p.fare_ids)) ids = known;
  else if (given(p.fare_ids)) ids = list(p.fare_ids);
  else return { ambiguities: [{ param: "fare_ids", code: "fare_ids_missing", message: tr(lang, "update_fares.fare_ids_missing"), options: v1.map((f) => `${f.fare_id} (${f.price} ${f.currency_type})`) }], warnings };
  const m = matchIds(ids, known, "fare_ids", "fare", lang);
  // One unknown fare with a price and routes: a new fare beside the others.
  if (m.bad.length === 1 && !m.ids.length && given(p.routes) && opts.price) return resolveCreate(model, db, p, opts, warnings, m.bad[0]);
  if (m.ambiguity) ambiguities.push(m.ambiguity);
  let except = [];
  if (given(p.except)) {
    const e = matchIds(list(p.except), known, "except", "fare", lang);
    if (e.ambiguity) ambiguities.push(e.ambiguity);
    except = e.ids;
  }
  if (opts.prices) for (const k of opts.prices.keys()) if (!known.includes(k) && !known.some((x) => x.toLowerCase() === k.toLowerCase())) ambiguities.push({ param: "prices", code: "fare_unknown", message: tr(lang, "update_fares.fare_unknown", { refs: `"${k}"` }), options: known });
  if (ambiguities.length) return { ambiguities, warnings };
  const target = v1.filter((f) => m.ids.includes(f.fare_id) && !except.includes(f.fare_id));
  if (!target.length) return { ambiguities: [{ param: "except", code: "nothing_to_change", message: tr(lang, "update_fares.all_excepted") }], warnings };
  const canon = (k) => known.find((x) => x.toLowerCase() === k.toLowerCase());
  const byCanon = opts.prices ? new Map([...opts.prices.entries()].map(([k, x]) => [canon(k), x])) : null;
  const rows = target.map((f) => ({ key: f.fare_id, id: f.fare_id, currency: f.currency_type, price: f.price }));
  const miss = unpriced(p.fare_ids, rows, { ...opts, prices: byCanon }, "prices");
  if (miss) return { ambiguities: [miss], warnings };
  const res = newPrices(rows, { ...opts, prices: byCanon }, opts.prices ? "prices" : "price");
  if (res.ambiguity || res.ambiguities) return { ambiguities: res.ambiguities || [res.ambiguity], warnings };
  if (v2.length) warnings.push(tr(lang, "update_fares.v2_unchanged"));
  return { value: { mode: "v1", changes: res.value, opts: summaryOpts(opts) }, ambiguities: [], warnings };
};

const resolveV2 = (db, p, v1, v2, opts, warnings) => {
  const lang = opts.lang;
  const ambiguities = [];
  const known = [...new Set(v2.map((r) => r.fare_product_id))].sort(byId);
  const ref = given(p.fare_product_ids) ? p.fare_product_ids : p.fare_ids;
  let ids;
  if (opts.prices && !given(ref)) ids = [...opts.prices.keys()];
  else if (isAll(ref)) ids = known;
  else if (given(ref)) ids = list(ref);
  else return { ambiguities: [{ param: "fare_product_ids", code: "fare_ids_missing", message: tr(lang, "update_fares.fare_product_ids_missing"), options: known }], warnings };
  const m = matchIds(ids, known, given(p.fare_product_ids) ? "fare_product_ids" : "fare_ids", "fare_product", lang);
  if (m.ambiguity) ambiguities.push(m.ambiguity);
  let except = [];
  if (given(p.except)) {
    const e = matchIds(list(p.except), known, "except", "fare_product", lang);
    if (e.ambiguity) ambiguities.push(e.ambiguity);
    except = e.ids;
  }
  if (opts.prices) for (const k of opts.prices.keys()) if (!known.includes(k)) ambiguities.push({ param: "prices", code: "fare_product_unknown", message: tr(lang, "update_fares.fare_product_unknown", { refs: `"${k}"` }), options: known });
  const riders = [...new Set(v2.map((r) => r.rider_category_id).filter(Boolean))].sort(byId);
  const medias = [...new Set(v2.map((r) => r.fare_media_id).filter(Boolean))].sort(byId);
  if (opts.rider && !riders.includes(opts.rider)) ambiguities.push({ param: "rider_category", code: "rider_category_unknown", message: tr(lang, "update_fares.rider_category_unknown", { value: opts.rider }), options: riders });
  if (opts.media && !medias.includes(opts.media)) ambiguities.push({ param: "fare_media", code: "fare_media_unknown", message: tr(lang, "update_fares.fare_media_unknown", { value: opts.media }), options: medias });
  if (ambiguities.length) return { ambiguities, warnings };
  const rows = v2.filter((r) => m.ids.includes(r.fare_product_id) && !except.includes(r.fare_product_id) && (!opts.rider || r.rider_category_id === opts.rider) && (!opts.media || r.fare_media_id === opts.media));
  if (!rows.length) return { ambiguities: [{ param: "fare_product_ids", code: "nothing_to_change", message: tr(lang, "update_fares.no_product_row"), options: known }], warnings };
  const keyOf = (r) => `${r.fare_product_id}${r.rider_category_id || r.fare_media_id ? ` (${[r.rider_category_id, r.fare_media_id].filter(Boolean).join(", ")})` : ""}`;
  const priced = rows.map((r) => ({ key: keyOf(r), id: r.fare_product_id, rid: r._rid, currency: r.currency, price: r.amount }));
  const miss = unpriced(ref, priced, opts, "prices");
  if (miss) return { ambiguities: [miss], warnings };
  const res = newPrices(priced, opts, opts.prices ? "prices" : "price");
  if (res.ambiguity || res.ambiguities) return { ambiguities: res.ambiguities || [res.ambiguity], warnings };
  if (v1.length) warnings.push(tr(lang, "update_fares.v1_unchanged"));
  return { value: { mode: "v2", changes: res.value, opts: summaryOpts(opts) }, ambiguities: [], warnings };
};

const summaryOpts = (o) => ({ percent: o.percent, rounding: o.rounding });

/** The currency of new fares: as given, else the one the feed's fares share; never guessed. */
const feedCurrency = (v1, opts, param) => {
  const lang = opts.lang;
  const cur = [...new Set(v1.map((f) => f.currency_type))].sort();
  if (opts.currency) {
    if (cur.length && !cur.includes(opts.currency)) return { value: opts.currency, warning: tr(lang, "update_fares.other_currency", { currencies: cur.join(", "), currency: opts.currency }) };
    return { value: opts.currency };
  }
  const fromPrice = opts.price?.currency;
  if (fromPrice) return { value: fromPrice };
  if (cur.length === 1) return { value: cur[0] };
  return { ambiguity: { param, code: "currency_missing", message: cur.length ? tr(lang, "update_fares.which_currency_of", { currencies: cur.join(tr(lang, "common.and_sep")) }) : tr(lang, "update_fares.which_currency"), options: cur } };
};

const agencies = (db) => (tableExists(db, "agency") ? db.prepare("SELECT agency_id FROM agency ORDER BY agency_id").all().map((a) => a.agency_id) : []);

// Routes by agency (one fare per agency when the feed has several).
const byAgency = (model, db, routes) => {
  const ags = agencies(db);
  const out = new Map();
  for (const id of routes) {
    const a = ags.length > 1 ? model.routes.get(id)?.agency_id || null : ags[0] ?? null;
    if (!out.has(a)) out.set(a, []);
    out.get(a).push(id);
  }
  return { groups: out, multi: ags.length > 1 };
};

const resolveCreate = (model, db, p, opts, warnings, newId) => {
  const lang = opts.lang;
  const ambiguities = [];
  const push = (param, a) => ambiguities.push({ param, ...a });
  const v1 = v1Fares(db);
  if (opts.percent != null) push("percent", { code: "percent_without_fare", message: v1.length ? tr(lang, "update_fares.percent_without_fare", { fare: String(newId) }) : tr(lang, "update_fares.percent_without_fares") });
  else if (!opts.price) push("price", { code: "price_missing", message: tr(lang, "update_fares.new_price_missing") });
  const cur = feedCurrency(v1, opts, "currency");
  if (cur.ambiguity) ambiguities.push(cur.ambiguity);
  else if (cur.warning) warnings.push(cur.warning);
  let routes = null;
  if (!given(p.routes)) push("routes", { code: "routes_missing", message: tr(lang, "update_fares.routes_missing"), options: ["all", ...[...model.routes.values()].map(label)] });
  else routes = resolveRoutes(model, p.routes, "routes", ambiguities, lang);
  let payment = null;
  if (given(p.payment_method)) {
    const k = String(p.payment_method).trim().toLowerCase();
    payment = ["0", "1"].includes(k) ? k : PAYMENT[k.replace(/\s+/g, "_")] ?? null;
    if (payment == null) push("payment_method", { code: "payment_method_invalid", message: tr(lang, "update_fares.payment_method_invalid"), options: ["0", "1"] });
  }
  let transfers = null;
  if (given(p.transfers)) {
    const k = String(p.transfers).trim().toLowerCase();
    if (["unlimited", "illimité", "illimite", ""].includes(k)) transfers = null;
    else if (["0", "1", "2"].includes(k)) transfers = k;
    else push("transfers", { code: "transfers_invalid", message: tr(lang, "update_fares.transfers_invalid") });
  }
  let duration = null;
  if (given(p.transfer_duration_min)) {
    const d = R.positive(p.transfer_duration_min, "transfer_duration_min", { max: 24 * 60, lang });
    if (d.ambiguity) push("transfer_duration_min", d.ambiguity);
    else duration = Math.round(d.value * 60);
  }
  if (ambiguities.length) return { ambiguities, warnings };
  if (opts.price.currency && opts.price.currency !== cur.value) return { ambiguities: [{ param: "price", code: "currency_mismatch", message: tr(lang, "update_fares.price_currency_conflict", { stated: opts.price.currency, currency: cur.value }), options: [cur.value, opts.price.currency] }], warnings };
  if (!fits(opts.price.amount, cur.value)) return { ambiguities: [{ param: "price", code: "price_invalid", message: tr(lang, "update_fares.new_price_decimals", { price: opts.price.amount, currency: cur.value }) }], warnings };
  if (!routes.length) return { ambiguities: [{ param: "routes", code: "routes_missing", message: tr(lang, "update_fares.routes_empty") }], warnings };
  const shared = [...new Set(v1.map((f) => String(f.payment_method)))];
  const pay = payment ?? (shared.length === 1 ? shared[0] : "0");
  if (payment == null && shared.length !== 1) warnings.push(tr(lang, "update_fares.payment_default"));
  if (v1.length) {
    const already = rulesOf(db).filter((r) => routes.includes(r.route_id)).map((r) => r.fare_id);
    if (already.length) warnings.push(tr(lang, "update_fares.lines_have_fares", { fares: few([...new Set(already)].sort(byId)) }));
  }
  const all = isAll(p.routes);
  return { value: { mode: "create", fareId: String(newId || p.fare_id || "standard").trim(), price: opts.price.amount, currency: cur.value, routes, all: all && !v1.length, payment: pay, transfers, duration }, ambiguities: [], warnings };
};

const resolveFree = (model, db, p, v1, v2, opts, warnings) => {
  const lang = opts.lang;
  const ambiguities = [];
  const ref = p.free && typeof p.free === "object" && !Array.isArray(p.free) ? p.free.routes : p.free;
  if (!given(ref) || ref === true) return { ambiguities: [{ param: "free", code: "routes_missing", message: tr(lang, "update_fares.free_routes_missing"), options: ["all", ...[...model.routes.values()].map(label)] }], warnings };
  const routes = resolveRoutes(model, ref, "free", ambiguities, lang);
  if (!v1.length && v2.length) return { ambiguities: [...ambiguities, { param: "free", code: "free_v2_unsupported", message: tr(lang, "update_fares.free_v2_unsupported") }], warnings };
  const cur = feedCurrency(v1, opts, "currency");
  if (cur.ambiguity) ambiguities.push(cur.ambiguity);
  if (ambiguities.length) return { ambiguities, warnings };
  if (v2.length) warnings.push(tr(lang, "update_fares.free_v1_only"));
  return { value: { mode: "free", routes, currency: cur.value, all: isAll(ref) }, ambiguities: [], warnings };
};

// ── apply ────────────────────────────────────────────────────────────────

const pctText = (o, lang) => {
  if (o.percent == null) return "";
  const p = { sign: o.percent > 0 ? "+" : "−", percent: Math.abs(o.percent) };
  return o.rounding ? tr(lang, "update_fares.pct_rounded", { ...p, rounding: o.rounding }) : tr(lang, "update_fares.pct", p);
};

const applyPrices = (db, v, lang) => {
  const lines = [];
  let changed = 0;
  for (const c of v.changes) {
    const after = fmt(c.after, c.currency);
    if (parseFloat(after) === c.before) {
      lines.push(tr(lang, "update_fares.price_unchanged", { fare: c.key, before: money(lang, c.before, c.currency), currency: c.currency }));
      continue;
    }
    if (v.mode === "v1") db.prepare("UPDATE fare_attributes SET price = ? WHERE fare_id = ?").run(after, c.id);
    else db.prepare("UPDATE fare_products SET amount = ? WHERE rowid = ?").run(after, c.rid);
    lines.push(tr(lang, "update_fares.price_changed", { fare: c.key, before: money(lang, c.before, c.currency), after: money(lang, c.after, c.currency), currency: c.currency }));
    changed += 1;
  }
  return { summary: tr(lang, v.mode === "v1" ? "update_fares.summary_v1" : "update_fares.summary_v2", { changes: few(lines, 10), pct: pctText(v.opts, lang) }), noop: !changed };
};

const insertFare = (db, row) => {
  const cols = new Set(db.prepare("PRAGMA table_info(fare_attributes)").all().map((c) => c.name));
  const use = Object.keys(row).filter((c) => cols.has(c));
  db.prepare(`INSERT INTO fare_attributes (${use.join(", ")}) VALUES (${use.map(() => "?").join(", ")})`).run(use.map((c) => row[c]));
};

const applyCreate = (db, v, { model, lang } = {}) => {
  const { groups, multi } = byAgency(model, db, v.routes);
  const made = [];
  const ins = db.prepare("INSERT INTO fare_rules (fare_id, route_id) VALUES (?, ?)");
  let rules = 0;
  for (const [agency, routes] of [...groups.entries()].sort((a, b) => byId(String(a[0]), String(b[0])))) {
    const id = G.uniqueId(db, "fare_attributes", "fare_id", multi ? `${v.fareId}_${agency || "none"}` : v.fareId);
    const agencyId = multi ? agency : v1Fares(db).find((f) => f.agency_id)?.agency_id ?? null;
    insertFare(db, { fare_id: id, price: fmt(v.price, v.currency), currency_type: v.currency, payment_method: v.payment, transfers: v.transfers, agency_id: agencyId, transfer_duration: v.duration == null ? null : String(v.duration) });
    // A fare without rules applies to every trip: only when the brief says all lines and nothing else is priced.
    if (!(v.all && !multi)) for (const r of routes) {
      ins.run(id, r);
      rules += 1;
    }
    made.push(id);
  }
  const lines = v.all && !multi ? tr(lang, "update_fares.every_line") : tr(lang, "update_fares.lines", { lines: few(v.routes.map((r) => label(model.routes.get(r) || { id: r }))) });
  const transfers = v.transfers == null ? tr(lang, "update_fares.transfers_unlimited") : tr(lang, "update_fares.transfers_n", { count: v.transfers });
  const within = v.duration ? tr(lang, "update_fares.transfers_within", { minutes: Math.round(v.duration / 60) }) : "";
  const payment = tr(lang, v.payment === "1" ? "update_fares.paid_before" : "update_fares.paid_on_board");
  return { summary: tr(lang, "update_fares.summary_create", { fares: few(made), price: money(lang, v.price, v.currency), currency: v.currency, lines, payment, transfers, within, rules }) };
};

const applyFree = (db, v, { model, lang } = {}) => {
  const warnings = [];
  const { groups, multi } = byAgency(model, db, v.routes);
  const fares = v1Fares(db);
  const before = rulesOf(db);
  const hadRules = new Set(before.map((r) => r.fare_id));
  const ins = db.prepare("INSERT INTO fare_rules (fare_id, route_id) VALUES (?, ?)");
  const lost = new Map();
  let changed = 0;
  const used = [];
  for (const [agency, routes] of [...groups.entries()].sort((a, b) => byId(String(a[0]), String(b[0])))) {
    // A zero fare of that currency (and agency) is reused.
    const zero = fares.find((f) => parseFloat(f.price) === 0 && f.currency_type === v.currency && (!multi || f.agency_id === agency));
    let id = zero?.fare_id;
    if (!id) {
      id = G.uniqueId(db, "fare_attributes", "fare_id", multi ? `free_${agency || "none"}` : "free");
      const pay = [...new Set(fares.map((f) => String(f.payment_method)))];
      insertFare(db, { fare_id: id, price: fmt(0, v.currency), currency_type: v.currency, payment_method: pay.length === 1 ? pay[0] : "0", transfers: null, agency_id: multi ? agency : fares.find((f) => f.agency_id)?.agency_id ?? null, transfer_duration: null });
      changed += 1;
    }
    used.push(id);
    for (const r of routes) {
      const mine = before.filter((x) => x.route_id === r);
      if (mine.length === 1 && mine[0].fare_id === id && !mine[0].origin_id && !mine[0].destination_id && !mine[0].contains_id) continue;
      for (const x of mine) {
        if (x.fare_id !== id) {
          if (!lost.has(x.fare_id)) lost.set(x.fare_id, new Set());
          lost.get(x.fare_id).add(label(model.routes.get(r) || { id: r }));
        }
        db.prepare("DELETE FROM fare_rules WHERE rowid = ?").run(x._rid);
      }
      ins.run(id, r);
      changed += 1;
    }
  }
  if (lost.size) warnings.push(tr(lang, "update_fares.rules_replaced", { rules: [...lost.entries()].sort((a, b) => byId(a[0], b[0])).map(([f, rs]) => tr(lang, "update_fares.no_longer_on", { fare: f, lines: [...rs].sort().join(", ") })).join(tr(lang, "common.semicolon")) }));
  // A fare left without rules would apply to every trip: it goes.
  const gone = [];
  for (const f of hadRules) {
    if (used.includes(f) || db.prepare("SELECT 1 FROM fare_rules WHERE fare_id = ? LIMIT 1").get(f)) continue;
    db.prepare("DELETE FROM fare_attributes WHERE fare_id = ?").run(f);
    gone.push(f);
  }
  if (gone.length) warnings.push(tr(lang, "update_fares.fares_deleted", { fares: few(gone.sort(byId)), count: gone.length }));
  const zoneOnly = rulesOf(db).filter((r) => !r.route_id && (r.origin_id || r.destination_id || r.contains_id)).length;
  if (zoneOnly) warnings.push(tr(lang, "update_fares.zone_rules", { count: zoneOnly }));
  const lines = v.all ? tr(lang, "update_fares.every_line") : tr(lang, "update_fares.lines", { lines: few(v.routes.map((r) => label(model.routes.get(r) || { id: r }))) });
  const replacing = lost.size ? tr(lang, "update_fares.free_replacing", { fares: few([...lost.keys()].sort(byId)) }) : "";
  const deleted = gone.length ? tr(lang, "update_fares.free_deleted", { count: gone.length }) : "";
  return { summary: tr(lang, "update_fares.summary_free", { lines, fares: few([...new Set(used)]), price: money(lang, 0, v.currency), currency: v.currency, replacing, deleted }), warnings, noop: !changed && !gone.length };
};

const apply = (db, v, ctx) => {
  if (v.mode === "create") return applyCreate(db, v, ctx);
  if (v.mode === "free") return applyFree(db, v, ctx);
  return applyPrices(db, v, ctx?.lang);
};

module.exports = {
  type: "update_fares",
  title: "Change fares",
  category: "fares",
  tables: ["fare_attributes", "fare_rules", "fare_products"],
  description: "Change fare prices (a new price, ± % rounded to 0.05 by default, or one price per fare) in fares v1 or v2, make lines free (a zero fare replacing their rules), or create the first fare of a feed; currencies are checked, never guessed.",
  params: [
    { name: "fare_ids", type: "list", required: false, description: "Fares v1 to change (fare_id list or \"all\"); in a feed with only v2, fare product ids." },
    { name: "fare_product_ids", type: "list", required: false, description: "Fares v2 products to change (list or \"all\")." },
    { name: "price", type: "money", required: false, description: "The new price (e.g. 2.10 or \"2,10 €\")." },
    { name: "percent", type: "number", required: false, description: "Change in % (+5, −10), rounded to `rounding`." },
    { name: "prices", type: "object", required: false, description: "{ fare_id: price } — one new price per fare." },
    { name: "rounding", type: "number", required: false, description: "Rounding step of a % change (default 0.05; \"none\": the currency's minor unit)." },
    { name: "except", type: "list", required: false, description: "Fares left unchanged (with \"all\")." },
    { name: "currency", type: "string", required: false, description: "ISO 4217 code: checked against the fares; required to create the first fare." },
    { name: "free", type: "object", required: false, description: "{ routes } (or a list, or \"all\"): these lines become free (fare priced 0)." },
    { name: "routes", type: "list", required: false, description: "Lines of a new fare (list or \"all\")." },
    { name: "fare_id", type: "string", required: false, description: "Id of a new fare (default \"standard\")." },
    { name: "payment_method", type: "enum", enum: ["0", "1"], required: false, description: "New fare: 0 paid on board, 1 before boarding (default: as the feed's fares, else 0)." },
    { name: "transfers", type: "enum", enum: ["0", "1", "2", "unlimited"], required: false, description: "New fare: transfers allowed (default unlimited)." },
    { name: "transfer_duration_min", type: "number", required: false, description: "New fare: minutes a ticket stays valid for transfers." },
    { name: "rider_category", type: "string", required: false, description: "Fares v2: only the products of this rider category." },
    { name: "fare_media", type: "string", required: false, description: "Fares v2: only the products on this fare media." },
    { name: "effective_date", type: "date", required: false, description: "When the new prices apply (GTFS does not date fares: a reminder to publish the feed then)." },
  ],
  example: { fare_ids: "all", percent: 5, rounding: 0.05, except: ["fare_ferry"] },
  resolve,
  apply,
};
