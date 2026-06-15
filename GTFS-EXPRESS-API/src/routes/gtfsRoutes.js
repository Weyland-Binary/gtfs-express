const express = require("express");
const router = express.Router();
const { validateGTFSUpload } = require("../middleware/validateUpload");
const { betaGate } = require("../middleware/betaGate");
const { adminGate } = require("../middleware/adminGate");
const {
  getAdminStats,
  resetStats,
  getActiveSessionsDetails,
} = require("../services/adminStatsService");
const { getActiveSessionsCount } = require("../services/sessionManager");
const { exportNetex } = require("../services/netexExportService");
const { readCache } = require("../middleware/readCache");
const perfStats = require("../services/perfStats");
const {
  getAgencies,
  getRoutes,
  getDirections,
  getStopsAndTimes,
  getShapes,
  getCalendarForRoute,
  getCalendarDatesForRoute,
  getCalendarByServiceId,
  getCalendarDatesByServiceId,
  uploadGTFSFile,
  getAverageTripTimes,
  getStatistics,
  getAllShapes,
  getShapesForRoute,
  getUploadStats,
  getStopDetail,
  getRouteDetail,
  getTripDetail,
  getShapeDetailRead,
  searchEntities,
  getAllStops,
  loadSample,
  enterEditMode,
  exitEditMode,
  getEditModeStatus,
  updateStop,
  updateRoute,
  updateTrip,
  updateCalendar,
  updateAgency,
  createStop,
  deleteStop,
  createRoute,
  deleteRoute,
  createTrip,
  deleteTrip,
  createCalendar,
  deleteCalendar,
  updateStopTime,
  createStopTime,
  insertStopTime,
  deleteStopTime,
  createCalendarDate,
  updateCalendarDate,
  deleteCalendarDate,
  listFrequencies,
  createFrequency,
  updateFrequency,
  deleteFrequency,
  createAgency,
  deleteAgency,
  listTransfers,
  createTransfer,
  updateTransfer,
  deleteTransfer,
  getEditHistory,
  undoLastEdit,
  redoLastEdit,
  jumpToHistory,
  previewDeleteRoute,
  previewDeleteStop,
  previewDeleteTrip,
  previewDeleteService,
  quickFixList,
  quickFixPreview,
  quickFixApply,
  runSqlQuery,
  runSqlQueryReadOnly,
  exportSqlCsv,
  previewSql,
  getSqlSchema,
  getFeedInfo,
  upsertFeedInfo,
  deleteFeedInfo,
  exportGTFS,
  exportProject,
  importProject,
  getProjectMetaHandler,
  getShapeDetail,
  updateShape,
  createShape,
  forkShape,
  deleteShape,
  validateShapeStops,
  revalidate,
  listLevels,
  createLevel,
  updateLevel,
  deleteLevel,
  listPathways,
  createPathway,
  updatePathway,
  deletePathway,
  getTranslationsConfig,
  listTranslations,
  createTranslation,
  updateTranslation,
  deleteTranslation,
  listFareAttributes,
  createFareAttribute,
  updateFareAttribute,
  deleteFareAttribute,
  listFareRules,
  createFareRule,
  updateFareRule,
  deleteFareRule,
  listAreas,
  createArea,
  updateArea,
  deleteArea,
  listStopAreas,
  createStopArea,
  updateStopArea,
  deleteStopArea,
  listNetworks,
  createNetwork,
  updateNetwork,
  deleteNetwork,
  listRouteNetworks,
  createRouteNetwork,
  updateRouteNetwork,
  deleteRouteNetwork,
  listFareMedia,
  createFareMedia,
  updateFareMedia,
  deleteFareMedia,
  listRiderCategories,
  createRiderCategory,
  updateRiderCategory,
  deleteRiderCategory,
  listTimeframes,
  createTimeframe,
  updateTimeframe,
  deleteTimeframe,
  listFareProducts,
  createFareProduct,
  updateFareProduct,
  deleteFareProduct,
  listFareLegRules,
  createFareLegRule,
  updateFareLegRule,
  deleteFareLegRule,
  listFareLegJoinRules,
  createFareLegJoinRule,
  updateFareLegJoinRule,
  deleteFareLegJoinRule,
  listFareTransferRules,
  createFareTransferRule,
  updateFareTransferRule,
  deleteFareTransferRule,
  listBookingRules,
  createBookingRule,
  updateBookingRule,
  deleteBookingRule,
  listLocationsGeojson,
  createLocationGeojson,
  updateLocationGeojson,
  deleteLocationGeojson,
  listLocationGroups,
  createLocationGroup,
  updateLocationGroup,
  deleteLocationGroup,
  listLocationGroupStops,
  createLocationGroupStop,
  deleteLocationGroupStop,
  listAttributions,
  createAttribution,
  updateAttribution,
  deleteAttribution,
  // NL2SQL — natural language → SQL via Anthropic Claude (beta-gated)
  generateSqlFromNaturalLanguage,
  getFeatures,
  generateChatTurn,
  chatAccessGate,
  recordChatFeedback,
} = require("../controllers/gtfsController");

// 🛡️ Upload route with strict validation
router.post("/upload", validateGTFSUpload, uploadGTFSFile);

// Route to load the bundled GTFS demo feed
router.get("/load-sample", loadSample);

// Simplified routes — sessionId is extracted from headers, no :folderName needed.
// readCache is wired on every endpoint that returns data derived from
// the session SQLite, so the browser short-circuits with 304 when the
// edit log has not advanced since its last fetch.
router.get("/agencies", readCache, getAgencies);
router.get("/routes/:agency_id", readCache, getRoutes);
router.get("/directions/:route_id/:date", readCache, getDirections);
router.get(
  "/stops_and_times/:route_id/:direction_id/:date",
  readCache,
  getStopsAndTimes,
);
router.get("/stops/all", readCache, getAllStops);
router.get("/shapes/:route_id/:direction_id", readCache, getShapes);
router.get("/calendar/:route_id", readCache, getCalendarForRoute);
router.get("/calendar_dates/:route_id", readCache, getCalendarDatesForRoute);
router.get("/calendar_service/:service_id", readCache, getCalendarByServiceId);
router.get(
  "/calendar_dates_service/:service_id",
  readCache,
  getCalendarDatesByServiceId,
);
router.get("/average_trip_times", readCache, getAverageTripTimes);
router.get("/statistics", readCache, getStatistics);
router.get("/all_shapes", readCache, getAllShapes);
router.get("/shapes_for_route/:route_id", readCache, getShapesForRoute);
router.get("/upload-stats", getUploadStats);

// 🔐 Admin dashboard — gated by X-Admin-Token (ADMIN_TOKEN env var).
// Returns the full aggregated stats payload as JSON. 30 s TTL cache.
router.get("/admin/stats", adminGate, getAdminStats);
// Lightweight ping used by the frontend to validate the token before
// loading the dashboard (no payload, no work).
router.get("/admin/ping", adminGate, (req, res) =>
  res.json({ ok: true, ts: new Date().toISOString() }),
);

// Live AI cost-limiter counters — exposes the three sliding windows
// (per-code hourly + daily, global daily) so the operator can see how
// close they are to NL2SQL_DAILY_BUDGET_TOTAL without grepping JSONL.
// no-store: counters move continuously; any cache would mislead.
const aiCostLimiter = require("../services/aiCostLimiter");
router.get("/admin/ai-usage", adminGate, (req, res) => {
  res.setHeader("Cache-Control", "no-store");
  res.json({ ts: new Date().toISOString(), ...aiCostLimiter.snapshot() });
});

// Live active-sessions counter — polled every ~10 s by the dashboard.
// No cache, no JSONL reads — just the session folder count.
router.get("/admin/active", adminGate, (req, res) => {
  res.setHeader("Cache-Control", "no-store");
  res.json({
    activeSessions: getActiveSessionsCount(),
    maxSessions: Number(process.env.MAX_SESSIONS || 50),
    ts: new Date().toISOString(),
  });
});

// Live per-session details — agency, entity counts, validation summary.
// Reads `_session_meta.json` from each session folder. Excludes sessions
// whose upload pipeline is still running.
router.get("/admin/sessions", adminGate, async (req, res, next) => {
  try {
    res.setHeader("Cache-Control", "no-store");
    const sessions = await getActiveSessionsDetails();
    res.json({
      sessions,
      count: sessions.length,
      maxSessions: Number(process.env.MAX_SESSIONS || 50),
      ts: new Date().toISOString(),
    });
  } catch (err) {
    next(err);
  }
});

// 📊 Perf snapshot — live P50/P95/P99 per matched route from a 1000-sample
// per-route ring buffer. Sorted worst-p95 first so regressions are visible
// at a glance.
router.get("/admin/perf/sample", adminGate, (req, res) => {
  res.setHeader("Cache-Control", "no-store");
  res.json(perfStats.summarize());
});

// Reset the perf stats. Useful between bench runs or after a deploy to
// clear stale samples taken during warm-up.
router.post("/admin/perf/reset", adminGate, (req, res) => {
  perfStats.reset();
  res.json({ ok: true, ts: new Date().toISOString() });
});

// Archive all telemetry logs and reset stats counters to zero.
router.post("/admin/stats/reset", adminGate, async (req, res) => {
  try {
    const result = await resetStats();
    res.json(result);
  } catch (err) {
    console.error("resetStats error:", err);
    res.status(500).json({ error: err.message });
  }
});
router.get("/stop_detail/:stop_id", readCache, getStopDetail);
router.get("/route_detail/:route_id", readCache, getRouteDetail);
router.get("/trip_detail/:trip_id", readCache, getTripDetail);
router.get("/shape_detail/:shape_id", readCache, getShapeDetailRead);
router.get("/search", searchEntities);

// Feed-to-feed comparison: diffs the caller's session against another
// uploaded session (added/removed/changed per table, bounded samples).
// Read-only — both databases are opened without write access.
const { diffFeeds } = require("../services/diffService");
router.post("/diff", diffFeeds);

// SQL console (read-only public — works without entering edit mode).
// Allowed: SELECT / WITH / EXPLAIN / read-only PRAGMA. Mutations always 403.
router.post("/sql", runSqlQueryReadOnly);
// Streaming CSV export for the same read-only surface. Bypasses the DOM
// rendering cap (10k rows) by piping directly to the response.
router.post("/sql/export.csv", exportSqlCsv);
// Same schema introspection endpoint, exposed in read mode for the frontend
// SQL Console autocomplete + table tree. Backed by the same handler as
// `/edit/sql/schema` (which now also accepts read mode — kept for backwards
// compat with frontends that haven't migrated to the unprefixed path yet).
router.get("/sql/schema", getSqlSchema);

// NL2SQL — natural language → SQL generation via Anthropic Claude.
// Beta-only feature, gated by the same X-Beta-Code mechanism as /edit/enter.
// Kill-switched server-side via NL2SQL_ENABLED — the handler returns 503
// when the flag is off, so the frontend can hide the UI without touching
// any other endpoint. Output is INSERTED (not executed) into the editor;
// the user reviews then runs it through /gtfs/sql or /gtfs/edit/sql as usual.
router.post(
  "/sql/nl2sql",
  betaGate("sql/nl2sql"),
  generateSqlFromNaturalLanguage,
);

// NL2SQL chat — multi-turn conversational agent (SSE streaming).
// Access gate: a present X-Beta-Code goes through the SAME betaGate
// validation as before; anonymous requests get a small free-trial
// allowance (NL2SQL_FREE_MESSAGES_PER_SESSION, capped per hashed IP and
// by the global daily AI budget) — the purchase gateway. Server-side
// kill-switch via NL2SQL_CHAT_ENABLED. Model-generated mutations are
// surfaced as `sql_blocked` drafts; the guided RepairFlow applies them
// through the regular /edit/sql pipeline only. Pre-stream errors return
// JSON envelopes so the BetaGateDialog / UpsellPanel flows keep working.
router.post("/sql/nl2sql-chat", chatAccessGate, generateChatTurn);

// Thumbs up/down on an assistant turn — session-gated, quota-free, append-
// only telemetry (chat-usage.jsonl + chat.feedback event).
router.post("/sql/nl2sql-chat/feedback", recordChatFeedback);

// Public feature flags — consumed at frontend boot to decide whether to
// render the NL2SQL panel. Returning the flags up-front avoids a 503 round-
// trip on every page load when the feature is off.
router.get("/config/features", getFeatures);

// ── Edit mode ────────────────────────────────────────────────────────────────────────
// Read ↔ edit toggle + status
router.post("/edit/enter", betaGate("edit/enter"), enterEditMode);
router.post("/edit/exit", exitEditMode);
router.get("/edit/status", getEditModeStatus);

// Mutations (sessionId required in headers, edit DB must be open)
router.patch("/edit/stops/:stop_id", updateStop);
router.post("/edit/stops", createStop);
router.delete("/edit/stops/:stop_id", deleteStop);
router.post("/edit/routes", createRoute);
router.patch("/edit/routes/:route_id", updateRoute);
router.delete("/edit/routes/:route_id", deleteRoute);
router.patch("/edit/trips/:trip_id", updateTrip);
router.post("/edit/trips", createTrip);
router.delete("/edit/trips/:trip_id", deleteTrip);
router.post("/edit/calendar", createCalendar);
router.patch("/edit/calendar/:service_id", updateCalendar);
router.delete("/edit/calendar/:service_id", deleteCalendar);
router.patch("/edit/stop_times/:trip_id/:stop_sequence", updateStopTime);
router.post("/edit/stop_times", createStopTime);
router.post("/edit/stop_times/insert", insertStopTime);
router.delete("/edit/stop_times/:trip_id/:stop_sequence", deleteStopTime);
router.post("/edit/calendar_dates", createCalendarDate);
router.patch("/edit/calendar_dates/:service_id/:date", updateCalendarDate);
router.delete("/edit/calendar_dates/:service_id/:date", deleteCalendarDate);

// Frequencies CRUD
// NOTE: start_time contains ":" chars (e.g. "06:00:00") so it cannot be safely
// embedded as a URL segment. PATCH and DELETE receive start_time in the body;
// only trip_id is in the URL param.
router.get("/edit/frequencies/:trip_id", listFrequencies);
router.post("/edit/frequencies", createFrequency);
router.patch("/edit/frequencies/:trip_id", updateFrequency);
router.delete("/edit/frequencies/:trip_id", deleteFrequency);

// Agency CRUD
router.post("/edit/agencies", createAgency);
router.patch("/edit/agencies/:agency_id", updateAgency);
router.delete("/edit/agencies/:agency_id", deleteAgency);

// Transfers CRUD
router.get("/edit/transfers", listTransfers);
router.post("/edit/transfers", createTransfer);
router.patch("/edit/transfers/:id", updateTransfer);
router.delete("/edit/transfers/:id", deleteTransfer);

// Shape CRUD
router.get("/edit/shapes/:shape_id", getShapeDetail);
router.put("/edit/shapes/:shape_id", updateShape);
router.post("/edit/shapes", createShape);
router.post("/edit/shapes/:shape_id/fork", forkShape);
router.delete("/edit/shapes/:shape_id", deleteShape);
router.get("/edit/shapes/:shape_id/validate", validateShapeStops);

// Edit history, undo and redo
router.get("/edit/history", getEditHistory);
router.post("/edit/undo", undoLastEdit);
router.post("/edit/redo", redoLastEdit);
router.post("/edit/jump", jumpToHistory);

// Cascade previews (read-only, no mutations)
router.get("/edit/preview/route/:route_id", previewDeleteRoute);
router.get("/edit/preview/stop/:stop_id", previewDeleteStop);
router.get("/edit/preview/trip/:trip_id", previewDeleteTrip);
router.get("/edit/preview/service/:service_id", previewDeleteService);

// On-demand revalidation (rate-limited by app.js: max 5 req/min per session)
// Accepts ?profile=canonical|strict|lenient|fr-datagouv|... query param.
router.post("/edit/validate", revalidate);

// Canonical-format revalidation: same pipeline, returns the report in the
// MobilityData Canonical Validator JSON shape so the result is portable
// across the wider GTFS tooling ecosystem.
const { revalidateCanonical } = require("../services/validationService");
router.post("/edit/validate.canonical", revalidateCanonical);

// Public discovery: list available validation profiles. Useful for the
// frontend's profile selector and for documentation generators.
router.get("/edit/validate/profiles", (req, res) => {
  const { getAvailableProfiles } = require("../utils/rulesCatalog");
  res.json({ profiles: getAvailableProfiles() });
});

// Public discovery: list available locales for validator messages.
router.get("/edit/validate/locales", (req, res) => {
  const { getAvailableLocales } = require("../utils/rulesCatalog");
  res.json({ locales: getAvailableLocales() });
});

// Public discovery: full rule catalogue (JSON). Unauthenticated, no
// rate limit — it's static data that's safe to expose. Useful for
// integrators building dashboards or alternate UIs.
router.get("/edit/validate/catalogue", (req, res) => {
  const catalogue = require("../utils/rules.json");
  res.json(catalogue);
});

// Public docs: human-readable rules page (HTML). Computed on the fly
// from rules.json + locales/{en,fr}.json with mtime-based caching.
// Same source of truth as the React ValidationRulesPage, no static
// artefact to keep in sync — see services/rulesDocService.js.
router.get("/edit/validate/rules", (req, res) => {
  const { getRulesDocHtml } = require("../services/rulesDocService");
  res.setHeader("Content-Type", "text/html; charset=utf-8");
  res.setHeader("Cache-Control", "public, max-age=600");
  res.send(getRulesDocHtml());
});

// Quick Fix (validation report auto-repair)
router.get("/edit/quickfix", quickFixList);
router.post("/edit/quickfix/preview", quickFixPreview);
router.post("/edit/quickfix/apply", quickFixApply);

// feed_info singleton (global GTFS feed metadata)
router.get("/edit/feed_info", getFeedInfo);
router.put("/edit/feed_info", upsertFeedInfo);
router.delete("/edit/feed_info", deleteFeedInfo);

// SQL console: full mutation endpoint + dry-run preview for the
// confirmation dialog. Both are gated by edit mode (handler-level check).
router.post("/edit/sql", runSqlQuery);
router.post("/edit/sql/preview", previewSql);
router.get("/edit/sql/schema", getSqlSchema);

// Levels CRUD (accessibility floor levels within a station)
router.get("/edit/levels", listLevels);
router.post("/edit/levels", createLevel);
router.patch("/edit/levels/:level_id", updateLevel);
router.delete("/edit/levels/:level_id", deleteLevel);

// Pathways CRUD (indoor navigation graph — must come before :param routes)
router.get("/edit/pathways", listPathways);
router.post("/edit/pathways", createPathway);
router.patch("/edit/pathways/:pathway_id", updatePathway);
router.delete("/edit/pathways/:pathway_id", deletePathway);

// Translations CRUD (multilingual field translations)
// NOTE: /config must come BEFORE /:id to avoid Express shadowing
router.get("/edit/translations/config", getTranslationsConfig);
router.get("/edit/translations", listTranslations);
router.post("/edit/translations", createTranslation);
router.patch("/edit/translations/:id", updateTranslation);
router.delete("/edit/translations/:id", deleteTranslation);

// Attributions CRUD (organization credits — attributions.txt)
router.get("/edit/attributions", listAttributions);
router.post("/edit/attributions", createAttribution);
router.patch("/edit/attributions/:rowid", updateAttribution);
router.delete("/edit/attributions/:rowid", deleteAttribution);

// ── Fares v1 (legacy) — fare_attributes.txt + fare_rules.txt ───────────────
router.get("/edit/fare_attributes", listFareAttributes);
router.post("/edit/fare_attributes", createFareAttribute);
router.patch("/edit/fare_attributes/:fare_id", updateFareAttribute);
router.delete("/edit/fare_attributes/:fare_id", deleteFareAttribute);

router.get("/edit/fare_rules", listFareRules);
router.post("/edit/fare_rules", createFareRule);
router.patch("/edit/fare_rules/:rowid", updateFareRule);
router.delete("/edit/fare_rules/:rowid", deleteFareRule);

// ── Fares v2 — Areas (zonal fare structure) ────────────────────────────────
router.get("/edit/areas", listAreas);
router.post("/edit/areas", createArea);
router.patch("/edit/areas/:area_id", updateArea);
router.delete("/edit/areas/:area_id", deleteArea);

router.get("/edit/stop_areas", listStopAreas);
router.post("/edit/stop_areas", createStopArea);
router.patch("/edit/stop_areas/:rowid", updateStopArea);
router.delete("/edit/stop_areas/:rowid", deleteStopArea);

// ── Fares v2 — Networks (logical route grouping) ───────────────────────────
router.get("/edit/networks", listNetworks);
router.post("/edit/networks", createNetwork);
router.patch("/edit/networks/:network_id", updateNetwork);
router.delete("/edit/networks/:network_id", deleteNetwork);

router.get("/edit/route_networks", listRouteNetworks);
router.post("/edit/route_networks", createRouteNetwork);
router.patch("/edit/route_networks/:rowid", updateRouteNetwork);
router.delete("/edit/route_networks/:rowid", deleteRouteNetwork);

// ── Fares v2 — Fare media (cash, card, paper, cEMV, mobile) ────────────────
router.get("/edit/fare_media", listFareMedia);
router.post("/edit/fare_media", createFareMedia);
router.patch("/edit/fare_media/:fare_media_id", updateFareMedia);
router.delete("/edit/fare_media/:fare_media_id", deleteFareMedia);

// ── Fares v2 — Rider categories (adult, child, senior, …) ──────────────────
router.get("/edit/rider_categories", listRiderCategories);
router.post("/edit/rider_categories", createRiderCategory);
router.patch("/edit/rider_categories/:rider_category_id", updateRiderCategory);
router.delete("/edit/rider_categories/:rider_category_id", deleteRiderCategory);

// ── Fares v2 — Timeframes (per-window fare bands) ──────────────────────────
router.get("/edit/timeframes", listTimeframes);
router.post("/edit/timeframes", createTimeframe);
router.patch("/edit/timeframes/:rowid", updateTimeframe);
router.delete("/edit/timeframes/:rowid", deleteTimeframe);

// ── Fares v2 — Fare products (priced offerings) ────────────────────────────
router.get("/edit/fare_products", listFareProducts);
router.post("/edit/fare_products", createFareProduct);
router.patch("/edit/fare_products/:rowid", updateFareProduct);
router.delete("/edit/fare_products/:rowid", deleteFareProduct);

// ── Fares v2 — Leg rules (per-leg pricing) ─────────────────────────────────
router.get("/edit/fare_leg_rules", listFareLegRules);
router.post("/edit/fare_leg_rules", createFareLegRule);
router.patch("/edit/fare_leg_rules/:rowid", updateFareLegRule);
router.delete("/edit/fare_leg_rules/:rowid", deleteFareLegRule);

// ── Fares v2 — Leg join rules (transfers between networks at stops) ────────
router.get("/edit/fare_leg_join_rules", listFareLegJoinRules);
router.post("/edit/fare_leg_join_rules", createFareLegJoinRule);
router.patch("/edit/fare_leg_join_rules/:rowid", updateFareLegJoinRule);
router.delete("/edit/fare_leg_join_rules/:rowid", deleteFareLegJoinRule);

// ── Fares v2 — Transfer rules ──────────────────────────────────────────────
router.get("/edit/fare_transfer_rules", listFareTransferRules);
router.post("/edit/fare_transfer_rules", createFareTransferRule);
router.patch("/edit/fare_transfer_rules/:rowid", updateFareTransferRule);
router.delete("/edit/fare_transfer_rules/:rowid", deleteFareTransferRule);

// ── Flex DRT — booking_rules.txt ───────────────────────────────────────────
router.get("/edit/booking_rules", listBookingRules);
router.post("/edit/booking_rules", createBookingRule);
router.patch("/edit/booking_rules/:booking_rule_id", updateBookingRule);
router.delete("/edit/booking_rules/:booking_rule_id", deleteBookingRule);

// ── GTFS-Flex — locations.geojson (one row per Feature) ────────────────────
router.get("/edit/locations_geojson", listLocationsGeojson);
router.post("/edit/locations_geojson", createLocationGeojson);
router.patch("/edit/locations_geojson/:feature_id", updateLocationGeojson);
router.delete("/edit/locations_geojson/:feature_id", deleteLocationGeojson);

// ── GTFS-Flex — location_groups (named stop groups for DRT booking) ────────
router.get("/edit/location_groups", listLocationGroups);
router.post("/edit/location_groups", createLocationGroup);
router.patch("/edit/location_groups/:location_group_id", updateLocationGroup);
router.delete("/edit/location_groups/:location_group_id", deleteLocationGroup);

// ── GTFS-Flex — location_group_stops (junction, composite PK) ─────────────
router.get("/edit/location_group_stops", listLocationGroupStops);
router.post("/edit/location_group_stops", createLocationGroupStop);
router.delete(
  "/edit/location_group_stops/:location_group_id/:stop_id",
  deleteLocationGroupStop,
);

// Export the modified GTFS as a ZIP
router.get("/edit/export", exportGTFS);

// Export as NeTEx France (gtfs2netexfr converter — optional capability,
// 503 when the binary is not embedded in the image)
router.get("/edit/export/netex", exportNetex);

// ── .gtfsproj project (disk persistence, Save/Open) ───────────────────────
// Save as… → stream a self-contained SQLite file
// Open…    → upload + validation + atomic swap
// Meta     → info on the current project (updated_at, source_feed_name, etc.)
router.get("/edit/project/export", exportProject);
router.post(
  "/edit/project/import",
  betaGate("edit/project/import"),
  importProject,
);
router.get("/edit/project/meta", getProjectMetaHandler);

module.exports = router;
