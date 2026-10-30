/**
 * Every event the app sends through `window`, named here and nowhere else: a screen that sends or listens imports
 * the name, so a typo is an import the build refuses rather than a listener that never fires (appEvents.test.js
 * holds the closure). The detail each one carries is noted beside it; the localStorage keys stay with their modules.
 */

// ── Accounts, licence, session

/** detail: { signedIn } — the account signed in or out. */
export const ACCOUNT_CHANGED_EVENT = "gtfs:account-changed";
/** detail: { entitlement, state, explicit?, resume? } — the licence's gate: opens the offer, `resume` run once the licence runs. */
export const PAYWALL_EVENT = "gtfs:paywall";
/** detail: { reason?, way? } — the offer asked for by name; way « quote » brings the quote's way into view, « quote-form » opens its form. */
export const PRICING_EVENT = "gtfs:open-pricing";
/** detail: { code } — the session's working copy is gone from the server. */
export const SESSION_LOST_EVENT = "gtfs:session-lost";
/** detail: { code, previewId } — the reader's lens (a simulated preview) is gone. */
export const LENS_LOST_EVENT = "gtfs:lens-lost";
/** detail: { on } — « Expert » switched. */
export const EXPERT_EVENT = "gtfs:expert-mode";

// ── Home and the reader

/** no detail — the finder opened (the palette, Home). */
export const FIND_NETWORK_EVENT = "gtfs:find-network";
/** no detail — the file picker of GTFSUploader opened. */
export const PICK_GTFS_FILE_EVENT = "gtfs:pick-gtfs-file";
/** detail: { file } — a GTFS file chosen on Home, read by GTFSUploader. */
export const READ_GTFS_FILE_EVENT = "gtfs:read-gtfs-file";
/** detail: { target, routeId?, agencyId?, date?, … } — the reader moves to a screen (useReaderNavigation). */
export const NAVIGATE_EVENT = "gtfs:navigate";
/** no detail — the command palette opened. */
export const PALETTE_OPEN_EVENT = "gtfs:open-palette";
/** no detail — the works dialog opened. */
export const WORKS_OPEN_EVENT = "gtfs:open-works";
/** no detail — the stop sheets opened on the stop of the panel that asked. */
export const OPEN_SHEETS_EVENT = "gtfs:open-sheets";
/** detail: { basemap } — the map's basemap changed. */
export const BASEMAP_CHANGED_EVENT = "gtfs:basemap-changed";
/** detail: { query, autorun } — a statement handed to the SQL console. */
export const SET_QUERY_EVENT = "gtfs:sql-set-query";

// ── The assistant

/** detail: { message? } — the assistant's panel opens, the message sent at once when given. */
export const CHAT_OPEN_EVENT = "gtfs:chat-open";
/** no detail — the assistant's panel closes. */
export const CHAT_CLOSE_EVENT = "gtfs:chat-close";
/** detail: the memory body, or none — the assistant's memory changed. */
export const MEMORY_EVENT = "gtfs:memory-changed";

// ── Validation

/** detail: { report, startedAt } — a validation ran again and its report replaces the one shown. */
export const VALIDATION_REFRESHED_EVENT = "gtfs:validation-refreshed";
/** detail: { errors, warnings } — the counts a validation vouched for. */
export const VALIDATED_EVENT = "gtfs:validated";
/** no detail — the validation report's page opens on its errors. */
export const REVIEW_ERRORS_EVENT = "gtfs:review-errors";
/** no detail — the validation report's page closes (a fix opened elsewhere). */
export const CLOSE_VALIDATION_REPORT_EVENT = "gtfs:close-validation-report";

// ── The modify journey

/** detail: { kind?, brief?, fresh? } — a modify project opens on the network shown. */
export const OPEN_CHANGE_STUDIO_EVENT = "gtfs:open-change-studio";
/** no detail — edit mode asked for on the reader (« Éditer », the palette). */
export const ENTER_EDIT_MODE_EVENT = "gtfs:enter-edit-mode";
/** detail: {} answered in place ({ moved: true }) — the draft's screen takes an edit asked outside it. */
export const BEFORE_EDIT_EVENT = "gtfs:before-edit";
/** no detail — the draft's decision opens. */
export const OPEN_DECISION_EVENT = "gtfs:open-decision";
/** no detail — the export's preflight dialog opens. */
export const OPEN_EXPORT_PREFLIGHT_EVENT = "gtfs:open-export-preflight";
/** no detail — the export's preflight dialog closed. */
export const EXPORT_PREFLIGHT_CLOSED_EVENT = "gtfs:export-preflight-closed";
/** no detail — the Change Studio simulates its plan again. */
export const RESIMULATE_EVENT = "gtfs:resimulate";
/** no detail — the working copy went back to its frozen version (its edits undone). */
export const WORK_FROZEN_EVENT = "gtfs:work-frozen";
/** detail: { filename, delivery } — a version delivered. */
export const DELIVERED_EVENT = "gtfs:delivered";
/** detail: { id } — a project's version restored. */
export const PROJECT_RESTORED_EVENT = "gtfs:project-restored";
/** detail: { action: "added" | "removed", document } — a project's document added or removed. */
export const DOCUMENT_EVENT = "gtfs:project-document";

// ── The shape editor

/** detail: { shapeId, initialPoints, linkTripIds, routeId?, agencyId?, directionId?, fitStops? } — a new shape drawn on the map. */
export const CREATE_SHAPE_EVENT = "gtfs:create-shape";
/** detail: { shapeId, routeId } — a shape opened in the editor. */
export const EDIT_SHAPE_EVENT = "gtfs:edit-shape";
/** detail: { shapeId } — the editor holds a shape. */
export const SHAPE_EDITOR_ACTIVE_EVENT = "gtfs:shape-editor-active";
/** detail: { shapeId, saved, created }, or none — the editor closed (saved, cancelled or unmounted). */
export const SHAPE_EDITOR_CLOSED_EVENT = "gtfs:shape-editor-closed";
/** detail: { dirty } — the editor's changes not saved yet, or none left. */
export const SHAPE_EDITOR_DIRTY_EVENT = "gtfs:shape-editor-dirty";
/** no detail — the editor asked to close without saving. */
export const CANCEL_SHAPE_EDITOR_EVENT = "gtfs:cancel-shape-editor";
