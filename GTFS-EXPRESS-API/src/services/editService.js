/**
 * editService.js — Re-export facade.
 *
 * Implementation has been split into per-entity sub-modules under
 * services/edit/. This file is the single stable public surface consumed
 * by gtfsController.js — its module.exports must never change shape
 * without coordinated updates to the controller and the routes.
 *
 * Sub-modules:
 *   edit/_editCore.js          — shared infrastructure (not re-exported here)
 *   edit/stopEditService.js    — stop CRUD
 *   edit/routeEditService.js   — route CRUD + cascade delete
 *   edit/tripEditService.js    — trip CRUD + duplication
 *   edit/scheduleEditService.js — stop_times, calendar, calendar_dates, frequencies
 *   edit/metadataEditService.js — agency, transfers, levels, pathways, translations, feed_info
 *   edit/historyEditService.js — undo, redo, jump, quickfix
 *   edit/sqlConsoleService.js  — SQL console (read + UPDATE/INSERT/DELETE),
 *                                read-only public endpoint, schema inspection,
 *                                and the programmatic `executeSqlInSession`
 *                                hook (used by future AI / automation).
 *
 * Bulk update / bulk delete handlers have been retired: the SQL console
 * handles every multi-row mutation in a single transaction with one
 * `_edit_log` entry, so the dedicated bulk endpoints are no longer needed.
 */

const {
  updateStop,
  createStop,
  deleteStop,
  previewDeleteStop,
} = require("./edit/stopEditService");

const {
  updateRoute,
  createRoute,
  deleteRoute,
  previewDeleteRoute,
} = require("./edit/routeEditService");

const {
  updateTrip,
  createTrip,
  deleteTrip,
  previewDeleteTrip,
} = require("./edit/tripEditService");

const {
  updateCalendar,
  updateStopTime,
  createStopTime,
  insertStopTime,
  deleteStopTime,
  createCalendar,
  deleteCalendar,
  previewDeleteService,
  createCalendarDate,
  updateCalendarDate,
  deleteCalendarDate,
  listFrequencies,
  createFrequency,
  updateFrequency,
  deleteFrequency,
} = require("./edit/scheduleEditService");

const {
  updateAgency,
  createAgency,
  deleteAgency,
  listTransfers,
  createTransfer,
  updateTransfer,
  deleteTransfer,
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
  getFeedInfo,
  upsertFeedInfo,
  deleteFeedInfo,
  listAttributions,
  createAttribution,
  updateAttribution,
  deleteAttribution,
} = require("./edit/metadataEditService");

const {
  getEditHistory,
  undoLastEdit,
  redoLastEdit,
  jumpToHistory,
  quickFixList,
  quickFixPreview,
  quickFixApply,
} = require("./edit/historyEditService");

const {
  runSqlQuery,
  runSqlQueryReadOnly,
  exportSqlCsv,
  previewSql,
  getSqlSchema,
  executeSqlInSession,
} = require("./edit/sqlConsoleService");

const {
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
} = require("./edit/faresEditService");

const {
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
} = require("./edit/flexEditService");

module.exports = {
  // UPDATEs
  updateStop,
  updateRoute,
  updateTrip,
  updateCalendar,
  updateAgency,
  // Stop CRUD
  createStop,
  deleteStop,
  // Route CRUD
  createRoute,
  deleteRoute,
  // Trip CRUD
  createTrip,
  deleteTrip,
  // Calendar CRUD
  createCalendar,
  deleteCalendar,
  // Stop_times CRUD
  updateStopTime,
  createStopTime,
  insertStopTime,
  deleteStopTime,
  // Calendar_dates CRUD
  createCalendarDate,
  updateCalendarDate,
  deleteCalendarDate,
  // Frequencies CRUD
  listFrequencies,
  createFrequency,
  updateFrequency,
  deleteFrequency,
  // Agency CRUD
  createAgency,
  deleteAgency,
  // Transfers CRUD
  listTransfers,
  createTransfer,
  updateTransfer,
  deleteTransfer,
  // History + undo/redo/jump
  getEditHistory,
  undoLastEdit,
  redoLastEdit,
  jumpToHistory,
  // Cascade previews
  previewDeleteRoute,
  previewDeleteStop,
  previewDeleteTrip,
  previewDeleteService,
  // Quick fixes (validation report auto-repair)
  quickFixList,
  quickFixPreview,
  quickFixApply,
  // SQL console (read-only public + edit-mode mutating)
  runSqlQuery,
  runSqlQueryReadOnly,
  exportSqlCsv,
  previewSql,
  getSqlSchema,
  executeSqlInSession,
  // feed_info singleton
  getFeedInfo,
  upsertFeedInfo,
  deleteFeedInfo,
  // Levels CRUD (accessibility)
  listLevels,
  createLevel,
  updateLevel,
  deleteLevel,
  // Pathways CRUD (indoor navigation graph)
  listPathways,
  createPathway,
  updatePathway,
  deletePathway,
  // Translations CRUD (multilingual field translations)
  getTranslationsConfig,
  listTranslations,
  createTranslation,
  updateTranslation,
  deleteTranslation,
  // Attributions CRUD (organization credits)
  listAttributions,
  createAttribution,
  updateAttribution,
  deleteAttribution,
  // Fares v1 (fare_attributes, fare_rules)
  listFareAttributes,
  createFareAttribute,
  updateFareAttribute,
  deleteFareAttribute,
  listFareRules,
  createFareRule,
  updateFareRule,
  deleteFareRule,
  // Fares v2 referentials (areas, stop_areas, networks, route_networks,
  // fare_media, rider_categories, timeframes)
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
  // Fares v2 products & rules (fare_products, fare_leg_rules,
  // fare_leg_join_rules, fare_transfer_rules)
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
  // Flex DRT (booking_rules) + GTFS-Flex (locations.geojson)
  listBookingRules,
  createBookingRule,
  updateBookingRule,
  deleteBookingRule,
  listLocationsGeojson,
  createLocationGeojson,
  updateLocationGeojson,
  deleteLocationGeojson,
  // GTFS-Flex location_groups + location_group_stops (schema v13)
  listLocationGroups,
  createLocationGroup,
  updateLocationGroup,
  deleteLocationGroup,
  listLocationGroupStops,
  createLocationGroupStop,
  deleteLocationGroupStop,
};
