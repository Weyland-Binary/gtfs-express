const express = require("express");
const router = express.Router();

// Express 4 does not pass a rejected promise to the error middleware: the request would hang and the unhandled
// rejection would end the process. Every handler here forwards its rejection to next(err); error middleware (four
// arguments) is left as it is.
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
const importProgress = require("../services/importProgress");
const { adminGate } = require("../middleware/adminGate");
const { accountsEnabled, requireUser, entitlementGate } = require("../middleware/userContext");
const { paidAccessGuard } = require("../services/paidAccess");

// Under PAID_ACCESS_ENABLED, editing needs a licensed account, checked before any route.
router.use(paidAccessGuard);
// A network uploaded by a signed-in account answers only that account or its project's members, whatever the route;
// an anonymous upload keeps its id as its credential.
router.use(require("../services/sessionOwner").sessionOwnerGuard);

const {
  getAdminStats,
  resetStats,
} = require("../services/adminStatsService");
const { getActiveSessionsCount } = require("../services/sessionManager");
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
  getShapeDetail,
  updateShape,
  createShape,
  forkShape,
  linkTripsToShape,
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
  generateSqlFromNaturalLanguage,
  getFeatures,
  generateChatTurn,
  chatAccessGate,
  chatTurnGate,
  recordChatFeedback,
  uploadChatAttachment,
  deleteChatAttachment,
} = require("../controllers/gtfsController");

router.post("/upload", importProgress.follow, validateGTFSUpload, uploadGTFSFile);
router.get("/import/progress/:id", importProgress.streamProgress);

router.get("/load-sample", importProgress.follow, loadSample);

// The sessionId comes from the headers, never from the path. readCache answers 304 while the edit log has not
// advanced since the browser's last fetch.
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
// and /Upload-Stats here, spellings a proxy rule may not cover.
router.get("/upload-stats", (req, res, next) => (req.path === "/upload-stats" ? next() : res.status(404).json({ error: "NOT_FOUND" })), getUploadStats);

// ── Operator's console: the operator's account (ADMIN_EMAILS) or X-Admin-Token
router.get("/admin/stats", adminGate, getAdminStats);
const adminConsole = require("../services/admin/adminConsole");
router.get("/admin/me", adminGate, adminConsole.me);
router.get("/admin/attention", adminGate, adminConsole.attention);
router.get("/admin/overview", adminGate, adminConsole.overview);
router.get("/admin/funnel", adminGate, adminConsole.funnel);
router.get("/admin/usage/ai", adminGate, adminConsole.aiUsage);
router.get("/admin/usage/api", adminGate, adminConsole.apiUsage);
router.get("/admin/errors", adminGate, adminConsole.errors);
router.get("/admin/billing", adminGate, adminConsole.billing);
router.get("/admin/quotes", adminGate, adminConsole.quotes);
router.patch("/admin/quotes/:id", adminGate, adminConsole.updateQuote);
router.get("/admin/projects", adminGate, adminConsole.projects);
router.get("/admin/events", adminGate, adminConsole.events);
router.get("/admin/audit", adminGate, adminConsole.audit);
router.get("/admin/mail", adminGate, adminConsole.mail);
router.get("/admin/ping", adminGate, (req, res) =>
  res.json({ ok: true, ts: new Date().toISOString() }),
);

// Sets TRUST_PROXY_HOPS from what the server receives rather than a guess: `chain` gives the address req.ip would be
// for each hop count, and the operator picks the smallest one showing their own. Admin only: it echoes the chain.
const { TRUST_PROXY_HOPS } = require("../config");
router.get("/admin/client-address", adminGate, (req, res) => {
  const forwarded = String(req.headers["x-forwarded-for"] || "").split(",").map((s) => s.trim()).filter(Boolean);
  const chain = [req.socket.remoteAddress || null, ...forwarded.slice().reverse()].map((ip, hops) => ({ hops, ip }));
  res.setHeader("Cache-Control", "no-store");
  res.json({ ip: req.ip, trust_proxy_hops: TRUST_PROXY_HOPS, forwarded_for: forwarded, chain, ts: new Date().toISOString() });
});

// no-store: the counters move continuously, a cache would mislead.
const aiCostLimiter = require("../services/aiCostLimiter");
router.get("/admin/ai-usage", adminGate, (req, res) => {
  res.setHeader("Cache-Control", "no-store");
  res.json({ ts: new Date().toISOString(), ...aiCostLimiter.snapshot() });
});

router.get("/admin/active", adminGate, (req, res) => {
  res.setHeader("Cache-Control", "no-store");
  res.json({
    activeSessions: getActiveSessionsCount(),
    maxSessions: require("../config").MAX_SESSIONS,
    ts: new Date().toISOString(),
  });
});

router.get("/admin/sessions", adminGate, adminConsole.sessions);
router.delete("/admin/sessions/:id", adminGate, adminConsole.endSession);

router.get("/admin/perf/sample", adminGate, (req, res) => {
  res.setHeader("Cache-Control", "no-store");
  res.json(perfStats.summarize());
});

router.post("/admin/perf/reset", adminGate, (req, res) => {
  perfStats.reset();
  require("../services/admin/opsData").logAdminAction(req.admin, "perf.reset");
  res.json({ ok: true, ts: new Date().toISOString() });
});

router.post("/admin/stats/reset", adminGate, async (req, res) => {
  try {
    const result = await resetStats();
    require("../services/admin/opsData").logAdminAction(req.admin, "stats.reset", null, { files: result.archivedFiles.length });
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

// Read-only: both databases are opened without write access.
const { diffFeeds } = require("../services/diffService");
router.post("/diff", diffFeeds);

const { journey } = require("../services/journeyService");
router.post("/journey", journey);

// Every licence holds "studio"; it gates the direct mode, the one model call below.
const studioGate = entitlementGate("studio");
const transformController = require("../services/transform/transformController");
router.get("/transform/operations", transformController.getOperations);
router.get("/transform/overview", transformController.getOverview);
router.post("/transform/preview", transformController.previewPlanHandler);
router.get("/transform/preview/:id/gtfs-diff/:format", transformController.exportDiffHandler);
router.get("/transform/preview/:id/diff", transformController.previewDiffHandler);
router.get("/transform/preview/:id/alerts", transformController.exportAlertsHandler);
const draftController = require("../services/transform/draftController");
router.get("/transform/draft", draftController.getDraft);
router.post("/transform/draft", draftController.postDraft);
router.delete("/transform/draft", draftController.deleteDraft);
router.post("/transform/draft/preview", draftController.previewDraftHandler);
router.post("/transform/draft/merge", draftController.mergeDraftHandler);
router.post("/transform/draft/apply", draftController.applyDraftHandler);
router.post("/transform/draft/reopen", draftController.reopenDraftHandler);
const coherenceController = require("../services/coherence/coherenceController");
router.get("/transform/preview/:id/coherence", coherenceController.getPreviewCoherence);
router.get("/network/coherence", coherenceController.getNetworkCoherence);
// The POST variants take the clauses in a JSON body: a long list outgrows a URL (Node refuses a request line past
// 16 KB).
router.post("/transform/preview/:id/coherence", coherenceController.getPreviewCoherence);
router.post("/network/coherence", coherenceController.getNetworkCoherence);
router.get("/network/coherence.xlsx", coherenceController.getNetworkCoherenceXlsx);
router.get("/network/coherence.pdf", coherenceController.getNetworkCoherencePdf);
router.get("/transform/preview/:id/coherence.xlsx", coherenceController.getPreviewCoherenceXlsx);
router.get("/transform/preview/:id/coherence.pdf", coherenceController.getPreviewCoherencePdf);
router.post("/network/coherence.xlsx", coherenceController.getNetworkCoherenceXlsx);
router.post("/network/coherence.pdf", coherenceController.getNetworkCoherencePdf);
router.post("/transform/preview/:id/coherence.xlsx", coherenceController.getPreviewCoherenceXlsx);
router.post("/transform/preview/:id/coherence.pdf", coherenceController.getPreviewCoherencePdf);
router.post("/transform/commit", transformController.commitHandler);
const catalogController = require("../services/catalog/catalogController");
router.get("/network/catalog", catalogController.getCatalog);
router.post("/network/catalog/open", importProgress.follow, catalogController.openCatalogFeed);
const demandController = require("../services/demand/demandController");
router.post("/transform/demand", demandController.transformDemand);
const shareService = require("../services/shareService");
router.post("/share", shareService.postShare);
router.get("/share/:token", shareService.getShare);
router.post("/share/:token/open", shareService.postOpenShare);
router.post("/share/:token/versions", shareService.postShareVersion);
router.get("/share/:token/gtfs.zip", shareService.getShareZip);

const documentsService = require("../services/documentsService");
router.get("/documents/timetable", documentsService.getTimetable);
const stopSheets = require("../services/stopSheets/stopSheetsController");
router.get("/documents/sheets/setup", stopSheets.getSetup);
router.post("/documents/sheets", stopSheets.postSheets);
router.post("/documents/sheets/plan", stopSheets.postPlan);
router.post("/documents/sheets/network", stopSheets.postNetwork);
router.post("/documents/sheets/changes", stopSheets.postChanges);
router.post("/documents/sheets/notices", stopSheets.postNotices);
router.get("/documents/sheets/calendar", stopSheets.getCalendar);
router.put("/documents/sheets/calendar", stopSheets.putCalendar);
router.post("/documents/sheets/calendar/suggest", studioGate, chatAccessGate, stopSheets.suggestCalendar);
const realtimeService = require("../services/realtimeService");
router.post("/realtime/validate", express.raw({ type: ["application/x-protobuf", "application/octet-stream"], limit: "20mb" }), realtimeService.validateRealtime);

const directController = require("../services/direct/directController");
router.post("/transform/direct", studioGate, chatAccessGate, directController.directHandler);
router.post("/transform/direct/review", studioGate, chatAccessGate, directController.reviewHandler);
const briefDocuments = require("../services/documents/briefDocumentService");
router.post("/network/documents", briefDocuments.postDocument);
router.delete("/network/documents/:id", briefDocuments.deleteDocument);

const { summarize } = require("../services/aiSummaryService");
router.post("/ai/summarize", chatAccessGate, summarize);
const { suggestField } = require("../services/aiSuggestService");
router.post("/ai/suggest-field", chatAccessGate, suggestField);

const { getMemory, putMemory } = require("../services/assistantMemoryService");
router.get("/assistant/memory", getMemory);
router.put("/assistant/memory", putMemory);

// Read-only, without edit mode: mutations always answer 403.
router.post("/sql", runSqlQueryReadOnly);
router.post("/sql/export.csv", exportSqlCsv);
router.get("/sql/schema", getSqlSchema);

// The generated SQL goes into the editor, never executed here: the person runs it through /sql or /edit/sql.
router.post("/sql/nl2sql", require("../services/nl2sqlChatController").licensedContext, generateSqlFromNaturalLanguage);

// The model's mutations come back as `sql_blocked` drafts, applied only through /edit/sql.
router.post("/sql/nl2sql-chat", chatTurnGate, generateChatTurn);

router.post("/sql/nl2sql-chat/feedback", recordChatFeedback);

// Deletion is session-gated only: removing one's own data must never spend chat quota.
router.post("/sql/nl2sql-chat/attachment", chatAccessGate, uploadChatAttachment);
router.delete("/sql/nl2sql-chat/attachment/:table", deleteChatAttachment);

router.get("/config/features", getFeatures);
router.get("/config/plans", require("../services/plansService").getPlans);
// Never refused by the paid offer; rate-limited in app.js.
router.post("/telemetry/ui", require("../services/admin/funnel").track);

// ── Accounts (ACCOUNTS_ENABLED, else 503 ACCOUNTS_DISABLED)
const accounts = require("../services/accounts/accountsController");
router.post("/auth/code", accountsEnabled, accounts.requestCode);
router.post("/auth/code/verify", accountsEnabled, accounts.verifyCode);
router.post("/auth/logout", accountsEnabled, accounts.logout);
router.get("/auth/me", accountsEnabled, requireUser, accounts.me);
router.patch("/auth/me", accountsEnabled, requireUser, accounts.updateMe);
router.get("/auth/me/export", accountsEnabled, requireUser, accounts.exportMine);
router.delete("/auth/me", accountsEnabled, requireUser, accounts.deleteMine);
router.get("/admin/users", accountsEnabled, adminGate, adminConsole.listUsers);
router.get("/admin/users/:id", accountsEnabled, adminGate, adminConsole.userDetail);
router.post("/admin/users/:id/entitlements", accountsEnabled, adminGate, accounts.adminSetEntitlements);
router.post("/admin/users/:id/logout", accountsEnabled, adminGate, adminConsole.logoutUser);
// The "memory" mail provider's outbox, where tests and end-to-end runs read sign-in codes.
router.get("/admin/mail/outbox", adminGate, accounts.adminMailOutbox);

// ── The licence (PAID_ACCESS_ENABLED)
// The provider's signed webhook (raw body, app.js) is the only writer of a subscription.
const billing = require("../services/billing/billingController");
router.post("/billing/checkout", accountsEnabled, requireUser, billing.checkout);
router.post("/billing/portal", accountsEnabled, requireUser, billing.portal);
router.get("/billing/subscription", accountsEnabled, requireUser, billing.subscription);
router.post("/billing/trial", accountsEnabled, requireUser, billing.trial);
router.post("/billing/quote", billing.quote);
router.post("/billing/webhook", accountsEnabled, billing.webhook);

// ── Workspace
// A project is owned by an account or by the browser's token (X-Client-Token, stored hashed, never listed across
// owners).
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
router.get("/workspace/projects/:projectId/versions/:versionId/coherence", workspace.getVersionCoherence);
// The POST takes the clauses in a JSON body: a URL cannot carry hundreds of them.
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

// ── Edit mode
router.post("/edit/enter", enterEditMode);
router.post("/edit/exit", exitEditMode);
router.post("/session/heartbeat", sessionHeartbeat);
// Never touches the session, so polling it does not delay the sweep.
router.get("/session/status", sessionStatus);
router.get("/edit/status", getEditModeStatus);

router.patch("/edit/stops/:stop_id", updateStop);
router.post("/edit/stops", createStop);
router.delete("/edit/stops/:stop_id", deleteStop);
router.post("/edit/routes", createRoute);
router.patch("/edit/routes/:route_id", updateRoute);
router.delete("/edit/routes/:route_id", deleteRoute);
// Before the :trip_id routes, so `shift` is never captured as a trip id.
router.post("/edit/trips/shift", shiftTripTimes);
router.post("/edit/trips/create_from_template", createTripsFromTemplate);
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

// start_time holds ":" and cannot safely be a URL segment: PATCH and DELETE take it in the body.
router.get("/edit/frequencies/:trip_id", listFrequencies);
router.post("/edit/frequencies", createFrequency);
router.patch("/edit/frequencies/:trip_id", updateFrequency);
router.delete("/edit/frequencies/:trip_id", deleteFrequency);

router.post("/edit/agencies", createAgency);
router.patch("/edit/agencies/:agency_id", updateAgency);
router.delete("/edit/agencies/:agency_id", deleteAgency);

router.get("/edit/transfers", listTransfers);
router.post("/edit/transfers", createTransfer);
router.patch("/edit/transfers/:id", updateTransfer);
router.delete("/edit/transfers/:id", deleteTransfer);

router.get("/edit/shapes/:shape_id", getShapeDetail);
router.put("/edit/shapes/:shape_id", updateShape);
router.post("/edit/shapes", createShape);
router.post("/edit/shapes/:shape_id/fork", forkShape);
router.post("/edit/shapes/:shape_id/link", linkTripsToShape);
router.delete("/edit/shapes/:shape_id", deleteShape);
router.get("/edit/shapes/:shape_id/validate", validateShapeStops);
// Through the server's router (OSRM_URL): the browser calls no routing service.
router.post("/edit/route", require("../services/edit/roadRouteService").routeAlongRoads);

router.get("/edit/history", getEditHistory);
router.post("/edit/undo", undoLastEdit);
router.post("/edit/redo", redoLastEdit);
router.post("/edit/jump", jumpToHistory);

router.get("/edit/preview/route/:route_id", previewDeleteRoute);
router.get("/edit/preview/stop/:stop_id", previewDeleteStop);
router.get("/edit/preview/trip/:trip_id", previewDeleteTrip);
router.get("/edit/preview/service/:service_id", previewDeleteService);

router.post("/edit/validate", revalidate);

const { revalidateCanonical } = require("../services/validationService");
router.post("/edit/validate.canonical", revalidateCanonical);

router.get("/edit/validate/profiles", (req, res) => {
  const { getAvailableProfiles } = require("../utils/rulesCatalog");
  res.json({ profiles: getAvailableProfiles() });
});

router.get("/edit/validate/locales", (req, res) => {
  const { getAvailableLocales } = require("../utils/rulesCatalog");
  res.json({ locales: getAvailableLocales() });
});

// Public and unthrottled: static data, safe to expose.
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

router.get("/edit/validate/rules", (req, res) => {
  const { getRulesDocHtml } = require("../services/rulesDocService");
  res.setHeader("Content-Type", "text/html; charset=utf-8");
  res.setHeader("Cache-Control", "public, max-age=600");
  res.send(getRulesDocHtml());
});

router.get("/edit/quickfix", quickFixList);
router.post("/edit/quickfix/preview", quickFixPreview);
router.post("/edit/quickfix/apply", quickFixApply);

router.get("/edit/feed_info", getFeedInfo);
router.put("/edit/feed_info", upsertFeedInfo);
router.delete("/edit/feed_info", deleteFeedInfo);

// The handlers check edit mode themselves.
router.post("/edit/sql", runSqlQuery);
router.post("/edit/sql/preview", previewSql);
router.get("/edit/sql/schema", getSqlSchema);

router.get("/edit/levels", listLevels);
router.post("/edit/levels", createLevel);
router.patch("/edit/levels/:level_id", updateLevel);
router.delete("/edit/levels/:level_id", deleteLevel);

router.get("/edit/pathways", listPathways);
router.post("/edit/pathways", createPathway);
router.patch("/edit/pathways/:pathway_id", updatePathway);
router.delete("/edit/pathways/:pathway_id", deletePathway);

// /config before /:id, so it is never captured as an id.
router.get("/edit/translations/config", getTranslationsConfig);
router.get("/edit/translations", listTranslations);
router.post("/edit/translations", createTranslation);
router.patch("/edit/translations/:id", updateTranslation);
router.delete("/edit/translations/:id", deleteTranslation);

router.get("/edit/attributions", listAttributions);
router.post("/edit/attributions", createAttribution);
router.patch("/edit/attributions/:rowid", updateAttribution);
router.delete("/edit/attributions/:rowid", deleteAttribution);

// ── Fares v1
router.get("/edit/fare_attributes", listFareAttributes);
router.post("/edit/fare_attributes", createFareAttribute);
router.patch("/edit/fare_attributes/:fare_id", updateFareAttribute);
router.delete("/edit/fare_attributes/:fare_id", deleteFareAttribute);

router.get("/edit/fare_rules", listFareRules);
router.post("/edit/fare_rules", createFareRule);
router.patch("/edit/fare_rules/:rowid", updateFareRule);
router.delete("/edit/fare_rules/:rowid", deleteFareRule);

// ── Fares v2
router.get("/edit/areas", listAreas);
router.post("/edit/areas", createArea);
router.patch("/edit/areas/:area_id", updateArea);
router.delete("/edit/areas/:area_id", deleteArea);

router.get("/edit/stop_areas", listStopAreas);
router.post("/edit/stop_areas", createStopArea);
router.patch("/edit/stop_areas/:rowid", updateStopArea);
router.delete("/edit/stop_areas/:rowid", deleteStopArea);

router.get("/edit/networks", listNetworks);
router.post("/edit/networks", createNetwork);
router.patch("/edit/networks/:network_id", updateNetwork);
router.delete("/edit/networks/:network_id", deleteNetwork);

router.get("/edit/route_networks", listRouteNetworks);
router.post("/edit/route_networks", createRouteNetwork);
router.patch("/edit/route_networks/:rowid", updateRouteNetwork);
router.delete("/edit/route_networks/:rowid", deleteRouteNetwork);

router.get("/edit/fare_media", listFareMedia);
router.post("/edit/fare_media", createFareMedia);
router.patch("/edit/fare_media/:fare_media_id", updateFareMedia);
router.delete("/edit/fare_media/:fare_media_id", deleteFareMedia);

router.get("/edit/rider_categories", listRiderCategories);
router.post("/edit/rider_categories", createRiderCategory);
router.patch("/edit/rider_categories/:rider_category_id", updateRiderCategory);
router.delete("/edit/rider_categories/:rider_category_id", deleteRiderCategory);

router.get("/edit/timeframes", listTimeframes);
router.post("/edit/timeframes", createTimeframe);
router.patch("/edit/timeframes/:rowid", updateTimeframe);
router.delete("/edit/timeframes/:rowid", deleteTimeframe);

router.get("/edit/fare_products", listFareProducts);
router.post("/edit/fare_products", createFareProduct);
router.patch("/edit/fare_products/:rowid", updateFareProduct);
router.delete("/edit/fare_products/:rowid", deleteFareProduct);

router.get("/edit/fare_leg_rules", listFareLegRules);
router.post("/edit/fare_leg_rules", createFareLegRule);
router.patch("/edit/fare_leg_rules/:rowid", updateFareLegRule);
router.delete("/edit/fare_leg_rules/:rowid", deleteFareLegRule);

router.get("/edit/fare_leg_join_rules", listFareLegJoinRules);
router.post("/edit/fare_leg_join_rules", createFareLegJoinRule);
router.patch("/edit/fare_leg_join_rules/:rowid", updateFareLegJoinRule);
router.delete("/edit/fare_leg_join_rules/:rowid", deleteFareLegJoinRule);

router.get("/edit/fare_transfer_rules", listFareTransferRules);
router.post("/edit/fare_transfer_rules", createFareTransferRule);
router.patch("/edit/fare_transfer_rules/:rowid", updateFareTransferRule);
router.delete("/edit/fare_transfer_rules/:rowid", deleteFareTransferRule);

// ── GTFS-Flex
router.get("/edit/booking_rules", listBookingRules);
router.post("/edit/booking_rules", createBookingRule);
router.patch("/edit/booking_rules/:booking_rule_id", updateBookingRule);
router.delete("/edit/booking_rules/:booking_rule_id", deleteBookingRule);

router.get("/edit/locations_geojson", listLocationsGeojson);
router.post("/edit/locations_geojson", createLocationGeojson);
router.patch("/edit/locations_geojson/:feature_id", updateLocationGeojson);
router.delete("/edit/locations_geojson/:feature_id", deleteLocationGeojson);

router.get("/edit/location_groups", listLocationGroups);
router.post("/edit/location_groups", createLocationGroup);
router.patch("/edit/location_groups/:location_group_id", updateLocationGroup);
router.delete("/edit/location_groups/:location_group_id", deleteLocationGroup);

router.get("/edit/location_group_stops", listLocationGroupStops);
router.post("/edit/location_group_stops", createLocationGroupStop);
router.delete(
  "/edit/location_group_stops/:location_group_id/:stop_id",
  deleteLocationGroupStop,
);

router.get("/edit/export", exportGTFS);

module.exports = router;
