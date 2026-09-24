/**
 * aiSuggestService — fill one field of an edit form from context.
 *
 *   POST /gtfs/ai/suggest-field  { entity: "stop"|"route"|"agency", field,
 *                                  form: {…current values}, id? , language }
 *   → { field, value, reason }
 *
 * The server assembles the context the model needs (the feed's naming
 * conventions, the neighbours of a stop, the routes serving it, the other
 * routes of the agency and their colours, feed_info…) and asks for ONE
 * JSON answer. Gated like the chat, charged to the same limiter. The user
 * always sees the suggestion in the field before saving.
 */

"use strict";

const config = require("../config");
const aiCostLimiter = require("./aiCostLimiter");
const freeTierLimiter = require("./freeTierLimiter");
const nl2sqlChatService = require("./nl2sqlChatService");
const { recordEvent, extractReqMeta } = require("./eventLogger");
const { requireSession } = require("./edit/_editCore");
const { haversineMeters } = require("../utils/geoUtils");

const FIELDS = {
  stop: new Set(["stop_name", "stop_desc", "stop_code", "tts_stop_name", "platform_code", "stop_url"]),
  route: new Set(["route_short_name", "route_long_name", "route_desc", "route_color", "route_text_color", "route_url"]),
  agency: new Set(["agency_name", "agency_url", "agency_timezone", "agency_lang", "agency_phone", "agency_email", "agency_fare_url"]),
};
const LANG_NAMES = { en: "English", fr: "French", es: "Spanish", de: "German", pt: "Portuguese", zh: "Chinese", ar: "Arabic", hi: "Hindi" };
const MAX_FORM_CHARS = 200;
const NEARBY_M = 600;

const clip = (v, n = MAX_FORM_CHARS) => (typeof v === "string" && v.length > n ? `${v.slice(0, n)}…` : v);
const num = (v) => {
  const n = typeof v === "number" ? v : parseFloat(v);
  return Number.isFinite(n) ? n : null;
};
const safeForm = (form) => {
  const out = {};
  for (const [k, v] of Object.entries(form && typeof form === "object" ? form : {}).slice(0, 30)) {
    if (!/^[a-z_]{1,40}$/.test(k)) continue;
    if (v == null || v === "") continue;
    out[k] = clip(String(v));
  }
  return out;
};

// ── Context builders ───────────────────────────────────────────────────────

const q = (db, sql, ...args) => {
  try {
    return db.prepare(sql).all(...args);
  } catch {
    return [];
  }
};

const stopContext = (db, form, id) => {
  const lat = num(form.stop_lat);
  const lon = num(form.stop_lon);
  const nearby = [];
  if (lat != null && lon != null) {
    for (const s of q(db, "SELECT stop_id, stop_name, stop_code, stop_desc, stop_lat, stop_lon FROM stops WHERE stop_lat BETWEEN ? AND ? AND stop_lon BETWEEN ? AND ? LIMIT 400", lat - 0.006, lat + 0.006, lon - 0.008, lon + 0.008)) {
      if (s.stop_id === id) continue;
      const sl = num(s.stop_lat);
      const so = num(s.stop_lon);
      if (sl == null || so == null) continue;
      const d = haversineMeters(lat, lon, sl, so);
      if (d <= NEARBY_M) nearby.push({ stop_id: s.stop_id, stop_name: s.stop_name, stop_code: s.stop_code || undefined, stop_desc: clip(s.stop_desc || "", 80) || undefined, distance_m: Math.round(d) });
    }
    nearby.sort((a, b) => a.distance_m - b.distance_m);
  }
  const routes = id
    ? q(db, "SELECT DISTINCT r.route_id, r.route_short_name, r.route_long_name, t.trip_headsign FROM stop_times st JOIN trips t ON t.trip_id = st.trip_id JOIN routes r ON r.route_id = t.route_id WHERE st.stop_id = ? LIMIT 12", id)
    : [];
  const parent = form.parent_station ? q(db, "SELECT stop_id, stop_name FROM stops WHERE stop_id = ?", form.parent_station)[0] : null;
  const naming = q(db, "SELECT stop_name, stop_code, stop_desc FROM stops WHERE stop_name IS NOT NULL AND stop_name != '' ORDER BY RANDOM() LIMIT 8");
  const feed = q(db, "SELECT feed_lang, default_lang FROM feed_info LIMIT 1")[0] || {};
  return { nearby_stops: nearby.slice(0, 10), routes_serving_it: routes, parent_station: parent, naming_examples: naming, feed_language: feed.feed_lang || feed.default_lang || null };
};

const routeContext = (db, form, id) => {
  const agency = form.agency_id ? q(db, "SELECT agency_id, agency_name, agency_url, agency_lang FROM agency WHERE agency_id = ?", form.agency_id)[0] : q(db, "SELECT agency_id, agency_name, agency_url, agency_lang FROM agency LIMIT 1")[0];
  const siblings = q(db, "SELECT route_id, route_short_name, route_long_name, route_type, route_color, route_text_color, route_url, route_desc FROM routes WHERE route_id != ? ORDER BY route_sort_order, route_short_name LIMIT 25", id || "");
  const ends = id
    ? q(
        db,
        `SELECT t.direction_id, t.trip_headsign,
                (SELECT s.stop_name FROM stop_times st JOIN stops s ON s.stop_id = st.stop_id WHERE st.trip_id = t.trip_id ORDER BY CAST(st.stop_sequence AS INTEGER) LIMIT 1) AS first_stop,
                (SELECT s.stop_name FROM stop_times st JOIN stops s ON s.stop_id = st.stop_id WHERE st.trip_id = t.trip_id ORDER BY CAST(st.stop_sequence AS INTEGER) DESC LIMIT 1) AS last_stop
           FROM trips t WHERE t.route_id = ? GROUP BY t.direction_id, t.trip_headsign LIMIT 6`,
        id,
      )
    : [];
  return { agency, other_routes: siblings, termini: ends };
};

const agencyContext = (db, form, id) => {
  const others = q(db, "SELECT agency_id, agency_name, agency_url, agency_timezone, agency_lang, agency_phone, agency_email FROM agency WHERE agency_id != ? LIMIT 10", id || "");
  const feed = q(db, "SELECT feed_publisher_name, feed_publisher_url, feed_lang, default_lang, feed_contact_email, feed_contact_url FROM feed_info LIMIT 1")[0] || null;
  const bbox = q(db, "SELECT MIN(CAST(stop_lat AS REAL)) AS min_lat, MAX(CAST(stop_lat AS REAL)) AS max_lat, MIN(CAST(stop_lon AS REAL)) AS min_lon, MAX(CAST(stop_lon AS REAL)) AS max_lon FROM stops WHERE stop_lat != '' AND stop_lat IS NOT NULL")[0] || null;
  const routes = q(db, "SELECT route_short_name, route_long_name FROM routes WHERE agency_id = ? OR ? = '' LIMIT 8", id || "", id || "");
  return { other_agencies: others, feed_info: feed, stops_bounding_box: bbox, routes_sample: routes };
};

const CONTEXT = { stop: stopContext, route: routeContext, agency: agencyContext };

const systemPrompt = (entity, field, language) =>
  `You fill ONE field of a GTFS ${entity} edit form from the context of the feed. Field: ${field}. Follow the GTFS specification for that field (format, allowed values: colours are 6 hex digits without '#', timezones are IANA names, languages are BCP-47 codes, URLs start with http(s)://). Match the feed's own conventions visible in the context (naming style, capitalisation, language: ${LANG_NAMES[language] || "English"} unless the feed clearly uses another language). Never invent facts you cannot infer (a phone number, an email): then answer with an empty value and say why. Answer with JSON only: {"value": "<the value or empty string>", "reason": "<one short sentence, in ${LANG_NAMES[language] || "English"}>"}.`;

const suggestField = async (req, res) => {
  if (!config.NL2SQL_CHAT_ENABLED) return res.status(503).json({ error: "NL2SQL_CHAT_DISABLED", message: "The AI assistant is disabled on this server." });
  const sessionCtx = requireSession(req, res);
  if (!sessionCtx) return;
  const body = req.body || {};
  const entity = typeof body.entity === "string" ? body.entity : "";
  const field = typeof body.field === "string" ? body.field : "";
  if (!FIELDS[entity] || !FIELDS[entity].has(field)) return res.status(400).json({ error: "INVALID_INPUT", message: "Unsupported entity/field." });
  const language = typeof body.language === "string" && LANG_NAMES[body.language] ? body.language : "en";
  const form = safeForm(body.form);
  const id = typeof body.id === "string" ? body.id.slice(0, 128) : "";

  const rateKey = req.betaTester?.code || `anon:${sessionCtx.sessionId}`;
  const aiLimits = aiCostLimiter.betaLimitsFor(req.betaTester);
  if (req.freeTier) {
    const quota = freeTierLimiter.check({ sessionId: sessionCtx.sessionId, ip: req.ip });
    if (!quota.ok) return res.status(403).json({ error: "FREE_QUOTA_EXHAUSTED", message: "Free trial messages used up. Enter a beta access code to keep going." });
    freeTierLimiter.consume({ sessionId: sessionCtx.sessionId, ip: req.ip });
  }
  const limit = aiCostLimiter.check({ key: rateKey, scope: "chat", ...aiLimits });
  if (!limit.ok) return res.status(limit.code === "BUDGET_EXHAUSTED" ? 503 : 429).json({ error: limit.code, message: "AI request limit reached. Try again later.", retryAfterSec: limit.retryAfterSec });

  let client;
  try {
    client = nl2sqlChatService.getClient();
  } catch (err) {
    return res.status(err.status || 503).json({ error: err.code || "AI_UNAVAILABLE", message: err.message });
  }
  // Suggestions are small: the cheaper model is enough.
  const model = config.NL2SQL_MODEL;
  const context = CONTEXT[entity](sessionCtx.db, form, id);
  const startedAt = Date.now();
  try {
    const message = await client.messages.create({
      model,
      max_tokens: 300,
      system: systemPrompt(entity, field, language),
      messages: [{ role: "user", content: JSON.stringify({ current_form: form, entity_id: id || null, context }) }],
    });
    const text = (message.content || []).filter((b) => b.type === "text").map((b) => b.text).join("").trim();
    const m = /\{[\s\S]*\}/.exec(text);
    let parsed = null;
    try {
      parsed = m ? JSON.parse(m[0]) : null;
    } catch {
      parsed = null;
    }
    if (!parsed || typeof parsed !== "object") throw new Error("The model did not return a JSON suggestion.");
    let value = typeof parsed.value === "string" ? parsed.value.trim().slice(0, 500) : "";
    if ((field === "route_color" || field === "route_text_color") && value) value = value.replace(/^#/, "").toUpperCase();
    recordEvent("ai.suggest", { ...extractReqMeta(req), entity, field, model, durationMs: Date.now() - startedAt, anon: Boolean(req.freeTier) });
    res.json({ entity, field, value, reason: typeof parsed.reason === "string" ? parsed.reason.slice(0, 300) : "", model });
  } catch (err) {
    console.error("ai suggest error:", err.message);
    res.status(502).json({ error: "AI_ERROR", message: err.message });
  }
};

module.exports = { suggestField, _internals: { FIELDS, stopContext, routeContext, agencyContext, safeForm } };
