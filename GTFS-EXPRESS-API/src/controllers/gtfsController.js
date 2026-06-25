/**
 * gtfsController.js — Aggregator
 *
 * This file re-exports all HTTP handlers from the domain services.
 * Business logic is spread across src/services/:
 *
 *   csvUtils.js         — parseCSV, streamStopTimesStats
 *   sessionManager.js   — cache, validation UUID/date, cleanup, loadData
 *   calendarService.js  — getServiceIdsForDate, calendrier par route
 *   uploadService.js    — upload ZIP, stats dashboard, sample GTFS
 *   routeService.js     — agencies, routes, directions, average durations
 *   scheduleService.js  — horaires, frequencies.txt
 *   shapesService.js    — geographic shapes
 *   statisticsService.js — network statistics, frequency/duration analysis
 *   detailService.js    — stop/route/trip detail, search
 */

const {
  getAgencies,
  getRoutes,
  getDirections,
  getAverageTripTimes,
} = require("../services/routeService");

const { getStopsAndTimes } = require("../services/scheduleService");

const {
  getShapes,
  getAllShapes,
  getShapesForRoute,
} = require("../services/shapesService");

const {
  getCalendarForRoute,
  getCalendarDatesForRoute,
  getCalendarByServiceId,
  getCalendarDatesByServiceId,
} = require("../services/calendarService");

const { getStatistics } = require("../services/statisticsService");

const {
  getStopDetail,
  getRouteDetail,
  getTripDetail,
  getShapeDetailRead,
  searchEntities,
  getAllStops,
} = require("../services/detailService");

const {
  uploadGTFSFile,
  getUploadStats,
  loadSample,
} = require("../services/uploadService");

const {
  enterEditMode,
  exitEditMode,
  getEditModeStatus,
} = require("../services/editSession");

const {
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
  listAttributions,
  createAttribution,
  updateAttribution,
  deleteAttribution,
  listFareAttributes,
  createFareAttribute,
  updateFareAttribute,
  deleteFareAttribute,
  listFareRules,
  createFareRule,
  updateFareRule,
  deleteFareRule,
  // Fares v2 referentials
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
  // Fares v2 products & rules
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
  // Flex DRT + GTFS-Flex
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
} = require("../services/editService");

const { exportGTFS } = require("../services/exportService");

const {
  getShapeDetail,
  updateShape,
  createShape,
  forkShape,
  deleteShape,
  validateShapeStops,
} = require("../services/edit/shapeEditService");

const { revalidate } = require("../services/validationService");

const {
  exportProject,
  importProject,
  getProjectMetaHandler,
} = require("../services/projectService");

// NL2SQL — Anthropic Claude integration. Exposed unconditionally; the
// handler itself returns 503 if NL2SQL_ENABLED=false, so the route can be
// wired statically without conditional require().
const {
  generateSqlFromNaturalLanguage,
  getFeatures,
} = require("../services/nl2sqlController");
const {
  generateChatTurn,
  chatAccessGate,
  recordChatFeedback,
} = require("../services/nl2sqlChatController");

module.exports = {
  // ── Lecture ────────────────────────────────────────────────────────────
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
  // ── Edit mode: toggle ────────────────────────────────────────────
  enterEditMode,
  exitEditMode,
  getEditModeStatus,
  // ── Edit mode: mutations ──────────────────────────────────────────
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
  // ── Edit mode: transfers ───────────────────────────────────────────
  listTransfers,
  createTransfer,
  updateTransfer,
  deleteTransfer,
  getEditHistory,
  undoLastEdit,
  redoLastEdit,
  jumpToHistory,
  // ── Edit mode: cascade previews ───────────────────────────────────
  previewDeleteRoute,
  previewDeleteStop,
  previewDeleteTrip,
  previewDeleteService,
  // ── Edit mode: quick fixes (validation auto-repair) ───────────────
  quickFixList,
  quickFixPreview,
  quickFixApply,
  // ── SQL console (read-only public + edit-mode mutating) ────────────────
  runSqlQuery,
  runSqlQueryReadOnly,
  exportSqlCsv,
  previewSql,
  getSqlSchema,
  // ── Edit mode: shapes ──────────────────────────────────────────────
  getShapeDetail,
  updateShape,
  createShape,
  forkShape,
  deleteShape,
  validateShapeStops,
  // ── Edit mode: export ─────────────────────────────────────────────
  exportGTFS,
  // ── Edit mode: .gtfsproj project (save / open / meta) ──────────────
  exportProject,
  importProject,
  getProjectMetaHandler,
  // ── Edit mode: feed_info (singleton) ──────────────────────────────
  getFeedInfo,
  upsertFeedInfo,
  deleteFeedInfo,
  // ── Edit mode: revalidation ───────────────────────────────────────
  revalidate,
  // ── Edit mode: levels (accessibility floor levels) ────────────────
  listLevels,
  createLevel,
  updateLevel,
  deleteLevel,
  // ── Edit mode: pathways (indoor navigation graph) ─────────────────
  listPathways,
  createPathway,
  updatePathway,
  deletePathway,
  // ── Edit mode: translations (multilingual field translations) ──────
  getTranslationsConfig,
  listTranslations,
  createTranslation,
  updateTranslation,
  deleteTranslation,
  // ── Edit mode: attributions (organization credits) ────────────────
  listAttributions,
  createAttribution,
  updateAttribution,
  deleteAttribution,
  // ── Edit mode: Fares v1 (fare_attributes, fare_rules) ──────────────
  listFareAttributes,
  createFareAttribute,
  updateFareAttribute,
  deleteFareAttribute,
  listFareRules,
  createFareRule,
  updateFareRule,
  deleteFareRule,
  // ── Edit mode: Fares v2 referentials ──────────────────────────────
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
  // ── Edit mode: Fares v2 products & rules ──────────────────────────
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
  // ── Edit mode: Flex DRT (booking_rules) + GTFS-Flex (locations.geojson) ──
  listBookingRules,
  createBookingRule,
  updateBookingRule,
  deleteBookingRule,
  listLocationsGeojson,
  createLocationGeojson,
  updateLocationGeojson,
  deleteLocationGeojson,
  // ── Edit mode: GTFS-Flex location_groups + location_group_stops (v13) ──
  listLocationGroups,
  createLocationGroup,
  updateLocationGroup,
  deleteLocationGroup,
  listLocationGroupStops,
  createLocationGroupStop,
  deleteLocationGroupStop,
  // ── NL2SQL: SQL generation via Claude (beta gate) ─────────────────
  generateSqlFromNaturalLanguage,
  getFeatures,
  // ── NL2SQL chat : agent conversationnel multi-tour (SSE, beta gate) ───
  generateChatTurn,
  chatAccessGate,
  recordChatFeedback,
};
