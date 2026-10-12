const express = require("express");
const router = express.Router();

// Express 4 does not hand a rejected promise to the error middleware: an async handler that threw past its own try
// left the request hanging and the rejection unhandled, which ends the Node process — every user's edit mode,
// previews and AI counters with it (14 handlers could, the review of 2026-10-08). Every handler given to this router
// passes its rejection to next(err), as Express 5 does; error middleware (four arguments) is left as it is.
const forwardRejection = (fn) => {
  if (typeof fn !== "function" || fn.length > 3) return fn;
  return function forwarded(req, res, next) {
    const out = fn.call(this, req, res, next);
    if (out && typeof out.then === "function") out.then(undefined, next);
    return out;
  };
};
for (const method of ["use", "get", "post", "put", "patch", "delete"]) {
  const register = router[method].bind(router);
  router[method] = (...args) => register(...args.map((a) => (Array.isArray(a) ? a.map(forwardRejection) : forwardRejection(a))));
}
const { validateGTFSUpload } = require("../middleware/validateUpload");
const { adminGate } = require("../middleware/adminGate");
const { accountsEnabled, requireUser, entitlementGate } = require("../middleware/userContext");
const { paidAccessGuard } = require("../services/paidAccess");

// The paid offer (PAID_ACCESS_ENABLED): reading stays free, editing and the Network Studio need an account that
// holds the entitlement, checked on every request before any route (services/paidAccess). A pass-through otherwise.
router.use(paidAccessGuard);
// A network uploaded by a signed-in account answers that account (or a member of a project it is bound to) only,
// whatever the route (services/sessionOwner); an anonymous upload keeps its id as its credential.
router.use(require("../services/sessionOwner").sessionOwnerGuard);

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
  getRoutePatterns,
  getQualityAudit,
  getShapeCoverage,
  getUnusedShapes,
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
  sessionHeartbeat,
  sessionStatus,
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
  shiftTripTimes,
  createTripsFromTemplate,
  insertStopInPattern,
  mergeStops,
  renameStopsBatch,
  extendCalendar,
  createCalendar,
  deleteCalendar,
  getStopTime,
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
  // NL2SQL — natural language → SQL via the model (the licence's caps, or the strict ones)
  generateSqlFromNaturalLanguage,
  getFeatures,
  generateChatTurn,
  chatAccessGate,
  recordChatFeedback,
  uploadChatAttachment,
  deleteChatAttachment,
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
router.get("/quality_audit", readCache, getQualityAudit);
router.get("/all_shapes", readCache, getAllShapes);
router.get("/shapes_for_route/:route_id", readCache, getShapesForRoute);
router.get("/route_patterns/:route_id", readCache, getRoutePatterns);
router.get("/shape_coverage/:agency_id", readCache, getShapeCoverage);
router.get("/shapes_unused", readCache, getUnusedShapes);
// Behind the proxy's basic auth (Caddyfile) and only at its exact path: Express would also route /upload-stats/
// and /Upload-Stats here, spellings a proxy rule may not cover (the review of 2026-10-08).
router.get("/upload-stats", (req, res, next) => (req.path === "/upload-stats" ? next() : res.status(404).json({ error: "NOT_FOUND" })), getUploadStats);

// 🔐 Admin dashboard — gated by X-Admin-Token (ADMIN_TOKEN env var).
// Returns the full aggregated stats payload as JSON. 30 s TTL cache.
router.get("/admin/stats", adminGate, getAdminStats);
// Lightweight ping used by the frontend to validate the token before
// loading the dashboard (no payload, no work).
router.get("/admin/ping", adminGate, (req, res) =>
  res.json({ ok: true, ts: new Date().toISOString() }),
);

// How the API sees the caller's address behind the proxies, to set
// TRUST_PROXY_HOPS from what the server receives rather than from a guess
// about the topology (DEPLOYMENT.md, "Client addresses behind the proxies").
// `chain` lists, for each possible hop count, the address req.ip would be
// (0: the socket's peer, 1: the last X-Forwarded-For entry, …): the owner
// calls it from their own computer and picks the smallest count whose
// address is theirs. Admin only: it echoes the forwarding chain.
const { TRUST_PROXY_HOPS } = require("../config");
router.get("/admin/client-address", adminGate, (req, res) => {
  const forwarded = String(req.headers["x-forwarded-for"] || "").split(",").map((s) => s.trim()).filter(Boolean);
  const chain = [req.socket.remoteAddress || null, ...forwarded.slice().reverse()].map((ip, hops) => ({ hops, ip }));
  res.setHeader("Cache-Control", "no-store");
  res.json({ ip: req.ip, trust_proxy_hops: TRUST_PROXY_HOPS, forwarded_for: forwarded, chain, ts: new Date().toISOString() });
});

// Live AI cost-limiter counters — exposes the three sliding windows
// (per-code hourly + daily, global daily) so the operator can see how
// close they are to NL2SQL_DAILY_BUDGET_TOTAL without grepping JSONL, and
// whether the global budget leaves the per-code quotas reachable (`budget`).
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

// Passenger journey simulation inside the loaded feed (read-only).
const { journey } = require("../services/journeyService");
router.post("/journey", journey);

// Network Studio: build a GTFS from a Network Spec (no session needed for
// validate/geocode/estimate/compile; the spec endpoints act on a session).
const networkController = require("../services/network/networkController");
router.post("/network/validate", networkController.validateNetworkSpec);
router.post("/network/geocode", networkController.geocodeStops);
router.post("/network/estimate", networkController.estimateNetwork);
// The "studio" entitlement (ACCOUNTS_ENABLED; granted by the admin for now)
// gates the assistant only — the two planner routes below, the only calls to
// the model. Building a network and storing a document are part of the
// by-hand journey and stay open to everyone: the build is validated by the
// server, the document is read by the assistant only when it runs. With the
// flag off the gate is a pass-through: nothing changes.
const studioGate = entitlementGate("studio");
router.post("/network/compile", networkController.compileNetwork);
router.post("/network/evaluate", networkController.evaluateNetwork);
// The coverage of the brief by the contract (G5): deterministic, no model — step ②'s « Exigences sans clause ». Its own
// limiter (app.js); the caller is someone (an account, the browser's X-Client-Token or a live session) and a document
// a project keeps is read only through its owner's project (contractController).
router.post("/contract/coverage", require("../services/contract/contractController").postCoverage);
// An operator's offer sheet (xlsx, xlsm, xls, ods, csv) read deterministically (mission step 6): the typed model,
// cell by cell, the clauses it states and the build_timetable operations it gives — no model, no feed change. Its own
// limiter (app.js).
router.post("/spreadsheet/parse", require("../services/spreadsheet/spreadsheetController").postParse);
router.post("/network/needs", networkController.networkNeeds);
// The transformation engine: a change plan on the loaded feed (preview on a
// sandbox, commit as one undoable edit).
const transformController = require("../services/transform/transformController");
router.get("/transform/operations", transformController.getOperations);
router.get("/transform/overview", transformController.getOverview);
router.get("/transform/quality", transformController.getQuality);
router.post("/transform/preview", transformController.previewPlanHandler);
router.get("/transform/preview/:id/gtfs-diff/:format", transformController.exportDiffHandler);
router.get("/transform/preview/:id/alerts", transformController.exportAlertsHandler);
// The coherence report (target design §6.2, D11): what each line offers by direction and day type,
// and what does not hold together — read from the feed (or a previewed plan, before → after), never judged.
const coherenceController = require("../services/coherence/coherenceController");
router.get("/transform/preview/:id/coherence", coherenceController.getPreviewCoherence);
router.get("/network/coherence", coherenceController.getNetworkCoherence);
// The same report with the contract's clauses in a JSON body ({ clauses }): a long contract — some thirty clauses a
// line read from offer sheets — outgrows a URL (Node refuses a request line past 16 KB). Same handlers, same report.
router.post("/transform/preview/:id/coherence", coherenceController.getPreviewCoherence);
router.post("/network/coherence", coherenceController.getNetworkCoherence);
// The same report as an operator's service-méthode sheet (mission step 7), rendered by the server from the same
// data: a workbook (one sheet per day type, the anomalies first) and a PDF — by GET, or by POST with the clauses in
// the body as above. And « chaque ligne cochée devient une clause »: the rows a person ticks, named by their key,
// become clauses built by the server on the version it read.
router.get("/network/coherence.xlsx", coherenceController.getNetworkCoherenceXlsx);
router.get("/network/coherence.pdf", coherenceController.getNetworkCoherencePdf);
router.get("/transform/preview/:id/coherence.xlsx", coherenceController.getPreviewCoherenceXlsx);
router.get("/transform/preview/:id/coherence.pdf", coherenceController.getPreviewCoherencePdf);
router.post("/network/coherence.xlsx", coherenceController.getNetworkCoherenceXlsx);
router.post("/network/coherence.pdf", coherenceController.getNetworkCoherencePdf);
router.post("/transform/preview/:id/coherence.xlsx", coherenceController.getPreviewCoherenceXlsx);
router.post("/transform/preview/:id/coherence.pdf", coherenceController.getPreviewCoherencePdf);
router.post("/network/coherence/clauses", coherenceController.postNetworkCoherenceClauses);
router.post("/transform/preview/:id/coherence/clauses", coherenceController.postPreviewCoherenceClauses);
router.get("/transform/references", transformController.listReferencesHandler);
router.post("/transform/references", transformController.addReferenceHandler);
router.delete("/transform/references/:id", transformController.removeReferenceHandler);
router.get("/transform/references/:id/departures", transformController.referenceDeparturesHandler);
router.post("/transform/commit", transformController.commitHandler);
router.post("/transform/compare", transformController.compareHandler);
router.post("/network/refine", networkController.refineNetwork);
router.get("/network/spec", networkController.getNetworkSpec);
router.put("/network/spec", networkController.putNetworkSpec);
router.get("/network/report", networkController.getNetworkReport);
// A network built here, downloaded as it was built — no edit mode (D8): the
// session header names the working copy, :buildId the build (never the
// session id in a URL); the export gate (validatorGate) runs first.
const { exportBuiltNetwork } = require("../services/exportService");
router.get("/network/:buildId/export.zip", exportBuiltNetwork);
// Territory dossier from public worldwide data, and the coverage of a plan.
router.post("/network/territory", networkController.getTerritory);
router.post("/network/coverage", networkController.getCoverage);
router.get("/network/catalog", networkController.getCatalog);
router.post("/network/catalog/import", networkController.importCatalogFeed);
router.post("/network/catalog/open", networkController.openCatalogFeed);
// Demand: ridership estimates (never facts: calibration status and uncertainty
// come with every figure), frequency optimisation, contrasted scenarios.
const demandController = require("../services/demand/demandController");
router.post("/network/demand", demandController.networkDemand);
router.post("/network/optimize", demandController.networkOptimize);
router.post("/network/scenarios", demandController.networkScenarios);
router.post("/transform/demand", demandController.transformDemand);
router.post("/transform/optimize", demandController.transformOptimize);
// « Préconisations »: the loaded feed's measured diagnosis turned into ranked changes, each with its impact and clauses.
router.post("/transform/recommendations", demandController.transformRecommendations);
// The planner: brief → Network Spec, grounded by tools (SSE, gated like the chat).
// Public shares: a read-only snapshot of a feed behind a token.
const shareService = require("../services/shareService");
router.post("/share", shareService.postShare);
router.get("/share/:token", shareService.getShare);
router.post("/share/:token/open", shareService.postOpenShare);
router.post("/share/:token/versions", shareService.postShareVersion);
router.get("/share/:token/gtfs.zip", shareService.getShareZip);

// Passenger documents (print-ready HTML) and the GTFS-Realtime check.
const documentsService = require("../services/documentsService");
router.get("/documents/timetable", documentsService.getTimetable);
router.get("/documents/stop", documentsService.getStopPoster);
const realtimeService = require("../services/realtimeService");
router.post("/realtime/validate", express.raw({ type: ["application/x-protobuf", "application/octet-stream"], limit: "20mb" }), realtimeService.validateRealtime);

const { planNetworkTurn } = require("../services/network/networkPlanController");
router.post("/network/plan", studioGate, chatAccessGate, planNetworkTurn);
// The change planner: a brief → a change plan on the loaded feed (SSE, gated like the chat).
router.post("/transform/plan", studioGate, chatAccessGate, transformController.planHandler);
// The specification documents (PDF, Word, OpenDocument, spreadsheet, text):
// stored for the journey, whatever the assistant's availability. The model
// reads them through the two planner routes above only, and only those sent
// to the assistant; the deterministic checks (the quotes, the coverage
// detector G5: /contract/coverage, the previews, the evaluation and the
// build) read the text of every one the request names, withheld or not.
const briefDocuments = require("../services/network/briefDocumentService");
router.post("/network/documents", briefDocuments.postDocument);
router.delete("/network/documents/:id", briefDocuments.deleteDocument);
// The text the server reads in a document, for the brief annotated on the person's screen (UX lot 3).
router.get("/network/documents/:id/text", briefDocuments.getDocumentText);
// The user's own demand data (counts per stop or line, OD tables, places),
// merged into the demand inputs by id; no session, no AI gate.
const demandData = require("../services/demand/demandDataController");
router.post("/network/demand/data", demandData.postDemandData);
router.delete("/network/demand/data/:id", demandData.deleteDemandData);

// One-shot AI summaries (release notes from the edit log, diff explanation):
// gated like the chat (the licence, or the free trial of messages).
const { summarize } = require("../services/aiSummaryService");
router.post("/ai/summarize", chatAccessGate, summarize);
const { suggestField } = require("../services/aiSuggestService");
router.post("/ai/suggest-field", chatAccessGate, suggestField);

// What the assistant remembers about this session (notes, muted findings).
const { getMemory, putMemory } = require("../services/assistantMemoryService");
router.get("/assistant/memory", getMemory);
router.put("/assistant/memory", putMemory);

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

// NL2SQL — natural language → SQL generation via the model. A licensed account
// gets its own caps (licensedContext), anyone else the strict per-session ones.
// Kill-switched server-side via NL2SQL_ENABLED — the handler returns 503
// when the flag is off, so the frontend can hide the UI without touching
// any other endpoint. Output is INSERTED (not executed) into the editor;
// the user reviews then runs it through /gtfs/sql or /gtfs/edit/sql as usual.
router.post("/sql/nl2sql", require("../services/nl2sqlChatController").licensedContext, generateSqlFromNaturalLanguage);

// NL2SQL chat — multi-turn conversational agent (SSE streaming).
// Access gate (chatAccessGate): a licence holding "studio" gets the full
// assistant; under the paid offer anyone else a small free-trial allowance
// (NL2SQL_FREE_MESSAGES_PER_SESSION, capped per hashed IP and by the global
// daily AI budget) — the purchase gateway. Server-side
// kill-switch via NL2SQL_CHAT_ENABLED. Model-generated mutations are
// surfaced as `sql_blocked` drafts; the guided RepairFlow applies them
// through the regular /edit/sql pipeline only. Pre-stream errors return
// JSON envelopes so the UpsellPanel flow keeps working.
router.post("/sql/nl2sql-chat", chatAccessGate, generateChatTurn);

// Thumbs up/down on an assistant turn — session-gated, quota-free, append-
// only telemetry (chat-usage.jsonl + chat.feedback event).
router.post("/sql/nl2sql-chat/feedback", recordChatFeedback);

// Tabular chat attachment (CSV/TSV/XLSX → read-only `_chat_att_<n>` table in
// the session DB, JOINable by assistant SQL). Upload shares the chat access
// gate (the licence or the free tier) plus a dedicated per-session rate
// limiter wired in app.js; deletion is session-gated only — removing your own
// uploaded data must never burn chat quota.
router.post("/sql/nl2sql-chat/attachment", chatAccessGate, uploadChatAttachment);
router.delete("/sql/nl2sql-chat/attachment/:table", deleteChatAttachment);

// Public feature flags — consumed at frontend boot to decide whether to
// render the NL2SQL panel. Returning the flags up-front avoids a 503 round-
// trip on every page load when the feature is off.
router.get("/config/features", getFeatures);
// The offer (reading, the licence) and the plan the caller's licence grants.
router.get("/config/plans", require("../services/plansService").getPlans);

// ── Accounts (ACCOUNTS_ENABLED; 503 ACCOUNTS_DISABLED otherwise) ─────────────
// Read is free; signing in is a code sent by e-mail (no password: the code verifies the address, the first one
// creates the account); the licence (a subscription, the administrator's grant, the free trial, the operator's own
// address) opens every modification. Cookie session (gtfs_session).
const accounts = require("../services/accounts/accountsController");
router.post("/auth/code", accountsEnabled, accounts.requestCode);
router.post("/auth/code/verify", accountsEnabled, accounts.verifyCode);
router.post("/auth/logout", accountsEnabled, accounts.logout);
router.get("/auth/me", accountsEnabled, requireUser, accounts.me);
router.patch("/auth/me", accountsEnabled, requireUser, accounts.updateMe);
// The rights of the persons: the account's data as JSON, the account deleted by its owner (typed confirmation).
router.get("/auth/me/export", accountsEnabled, requireUser, accounts.exportMine);
router.delete("/auth/me", accountsEnabled, requireUser, accounts.deleteMine);
router.get("/admin/users", accountsEnabled, adminGate, accounts.adminListUsers);
router.post("/admin/users/:id/entitlements", accountsEnabled, adminGate, accounts.adminSetEntitlements);
// The "memory" mail provider's last messages (the tests, the end-to-end runs read a sign-in code there).
router.get("/admin/mail/outbox", adminGate, accounts.adminMailOutbox);

// ── The licence (PAID_ACCESS_ENABLED; services/billing) ───────────────────────
// Three ways to it: the free trial (once per verified address), paying online (Checkout; the provider's portal
// manages it) and a quote asked of the operator (then the administrator's grant, with its end). The provider's
// webhook (raw body, app.js; signature checked) is the only writer of a subscription.
const billing = require("../services/billing/billingController");
router.post("/billing/checkout", accountsEnabled, requireUser, billing.checkout);
router.post("/billing/portal", accountsEnabled, requireUser, billing.portal);
router.get("/billing/subscription", accountsEnabled, requireUser, billing.subscription);
router.post("/billing/trial", accountsEnabled, requireUser, billing.trial);
router.post("/billing/quote", billing.quote);
router.post("/billing/webhook", accountsEnabled, billing.webhook);

// ── Project Studio (PROJECT_STUDIO_ENABLED with ACCOUNTS_ENABLED; 503 otherwise) ──
// A network project from its reference to its validated deliverables. Every
// route needs a signed-in member; roles per project (reader, contributor,
// approver); creating a project and the AI turns need the "studio" entitlement.
const projects = require("../services/projects/projectController");
router.get("/projects", projects.enabled, projects.signedIn, projects.list);
router.post("/projects", projects.enabled, projects.signedIn, projects.create);
router.get("/projects/:projectId", projects.enabled, projects.signedIn, projects.get);
router.patch("/projects/:projectId", projects.enabled, projects.signedIn, projects.update);
router.post("/projects/:projectId/members", projects.enabled, projects.signedIn, projects.addMember);
router.delete("/projects/:projectId/members/:userId", projects.enabled, projects.signedIn, projects.removeMember);
router.post("/projects/:projectId/documents", projects.enabled, projects.signedIn, projects.addDocument);
router.get("/projects/:projectId/documents/:documentId", projects.enabled, projects.signedIn, projects.downloadDocument);
router.delete("/projects/:projectId/documents/:documentId", projects.enabled, projects.signedIn, projects.removeDocument);
router.post("/projects/:projectId/reference", projects.enabled, projects.signedIn, projects.setReference);
router.get("/projects/:projectId/diagnosis", projects.enabled, projects.signedIn, projects.diagnosis);
router.post("/projects/:projectId/objectives", projects.enabled, projects.signedIn, projects.addObjective);
router.post("/projects/:projectId/objectives/extract", projects.enabled, projects.signedIn, projects.extractObjectives);
router.patch("/projects/:projectId/objectives/:objectiveId", projects.enabled, projects.signedIn, projects.decideObjective);
router.delete("/projects/:projectId/objectives/:objectiveId", projects.enabled, projects.signedIn, projects.removeObjective);
router.post("/projects/:projectId/scenarios", projects.enabled, projects.signedIn, projects.addScenario);
router.patch("/projects/:projectId/scenarios/:scenarioId", projects.enabled, projects.signedIn, projects.updateScenario);
router.delete("/projects/:projectId/scenarios/:scenarioId", projects.enabled, projects.signedIn, projects.removeScenario);
router.post("/projects/:projectId/scenarios/:scenarioId/evaluate", projects.enabled, projects.signedIn, projects.evaluateScenario);
router.post("/projects/:projectId/scenarios/:scenarioId/plan", projects.enabled, projects.signedIn, projects.planScenario);
router.post("/projects/:projectId/scenarios/:scenarioId/open", projects.enabled, projects.signedIn, projects.openScenario);
router.post("/projects/:projectId/scenarios/:scenarioId/capture", projects.enabled, projects.signedIn, projects.captureScenario);
router.post("/projects/:projectId/scenarios/:scenarioId/review", projects.enabled, projects.signedIn, projects.review);
router.get("/projects/:projectId/compare", projects.enabled, projects.signedIn, projects.compare);
router.post("/projects/:projectId/comments", projects.enabled, projects.signedIn, projects.addComment);
router.post("/projects/:projectId/comments/:commentId/resolve", projects.enabled, projects.signedIn, projects.resolveComment);
router.post("/projects/:projectId/versions/:versionId/deliverables", projects.enabled, projects.signedIn, projects.generateDeliverable);
router.get("/projects/:projectId/deliverables/:deliverableId", projects.enabled, projects.signedIn, projects.downloadDeliverable);

// ── The workspace: the journey's projects, for everyone (target design §2.4, §9) ──
// Owned by an account or, without one, by the browser's token (X-Client-Token,
// minted here, stored hashed, never listed across owners); autosave with
// If-Match (409 AUTOSAVE_CONFLICT); versions frozen as zips within their caps,
// restored from them ("Reprendre", D46); the documents kept with the project.
// The Project Studio's /projects routes stay for the API's own clients; its screen is dissolved in the
// journey (WP10): the workspace below is what the web uses.
const workspace = require("../services/workspace/workspaceController");
router.post("/workspace/token", workspace.postToken);
router.get("/workspace/projects", workspace.listProjects);
router.post("/workspace/projects", workspace.createProject);
router.get("/workspace/projects/:projectId", workspace.getProject);
router.patch("/workspace/projects/:projectId", workspace.patchProject);
router.delete("/workspace/projects/:projectId", workspace.deleteProject);
router.post("/workspace/projects/:projectId/bind", workspace.bindSession);
router.post("/workspace/projects/:projectId/versions", workspace.postVersion);
router.delete("/workspace/projects/:projectId/versions/:versionId", workspace.deleteVersion);
router.post("/workspace/projects/:projectId/versions/:versionId/restore", workspace.restoreVersion);
// WP10 — a version read back (its coherence report, its diff), its approval, « Tout le paquet » and « Marquer livrée ».
router.get("/workspace/projects/:projectId/versions/:versionId/coherence", workspace.getVersionCoherence);
// The same report with a long contract's clauses in a JSON body (the URL cannot carry 240 of them).
router.post("/workspace/projects/:projectId/versions/:versionId/coherence", workspace.getVersionCoherence);
router.get("/workspace/projects/:projectId/versions/:versionId/diff", workspace.getVersionDiff);
router.post("/workspace/projects/:projectId/versions/:versionId/review", workspace.postReview);
router.post("/workspace/projects/:projectId/versions/:versionId/package", workspace.postPackage);
router.get("/workspace/projects/:projectId/packages/:packageId", workspace.getPackage);
router.post("/workspace/projects/:projectId/versions/:versionId/delivered", workspace.postDelivered);
router.post("/workspace/projects/:projectId/members", workspace.postMember);
router.delete("/workspace/projects/:projectId/members/:userId", workspace.deleteMember);
router.post("/workspace/projects/:projectId/owner", workspace.postOwner);
router.post("/workspace/projects/:projectId/documents", workspace.postDocument);
router.delete("/workspace/projects/:projectId/documents/:documentId", workspace.deleteDocument);
router.post("/workspace/attach", workspace.attach);
workspace.start();

// ── Edit mode ────────────────────────────────────────────────────────────────────────
// Read ↔ edit toggle + status
// Under the paid offer, services/paidAccess (mounted first) wants the licence's "edit"; open otherwise.
router.post("/edit/enter", enterEditMode);
router.post("/edit/exit", exitEditMode);
// Keep-alive for open tabs (read-only sessions included) — see sessionManager.
router.post("/session/heartbeat", sessionHeartbeat);
// When the working copy will be swept (read only, never a touch): the status bar's T-10 min.
router.get("/session/status", sessionStatus);
router.get("/edit/status", getEditModeStatus);

// Mutations (sessionId required in headers, edit DB must be open)
router.patch("/edit/stops/:stop_id", updateStop);
router.post("/edit/stops", createStop);
router.delete("/edit/stops/:stop_id", deleteStop);
router.post("/edit/routes", createRoute);
router.patch("/edit/routes/:route_id", updateRoute);
router.delete("/edit/routes/:route_id", deleteRoute);
// Batch time shift — declared BEFORE the :trip_id routes so the literal
// `shift` segment can never be captured as a trip id.
router.post("/edit/trips/shift", shiftTripTimes);
router.post("/edit/trips/create_from_template", createTripsFromTemplate);
// Assistant-planned batch operations (dry_run supported, one undo entry each).
router.post("/edit/stop_times/insert_pattern", insertStopInPattern);
router.post("/edit/stops/merge", mergeStops);
router.post("/edit/stops/rename_batch", renameStopsBatch);
router.post("/edit/calendar/extend", extendCalendar);
router.patch("/edit/trips/:trip_id", updateTrip);
router.post("/edit/trips", createTrip);
router.delete("/edit/trips/:trip_id", deleteTrip);
router.post("/edit/calendar", createCalendar);
router.patch("/edit/calendar/:service_id", updateCalendar);
router.delete("/edit/calendar/:service_id", deleteCalendar);
router.get("/edit/stop_times/:trip_id/:stop_sequence", getStopTime);
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
// integrators building dashboards or alternate UIs, and read by the web's
// rules page (/regles): `?lang=` puts each rule's description in that
// language when the validator's messages have it (utils/locales), else
// English, and says which language it served.
router.get("/edit/validate/catalogue", (req, res) => {
  const catalogue = require("../utils/rules.json");
  const { getAvailableLocales, t, DEFAULT_LOCALE } = require("../utils/rulesCatalog");
  const wanted = typeof req.query.lang === "string" ? req.query.lang.trim().toLowerCase().slice(0, 8) : "";
  if (!wanted) return res.json(catalogue);
  const language = getAvailableLocales().includes(wanted) ? wanted : DEFAULT_LOCALE;
  const rules = Object.fromEntries(Object.entries(catalogue.rules).map(([code, rule]) => [code, { ...rule, description: t(code, language) }]));
  res.setHeader("Cache-Control", "public, max-age=600");
  return res.json({ ...catalogue, language, rules });
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
router.post("/edit/project/import", importProject);
router.get("/edit/project/meta", getProjectMetaHandler);

module.exports = router;
