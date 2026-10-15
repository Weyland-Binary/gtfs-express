/**
 * draftEvents — the events of the draft's own screen (the reader with its panel « Modifications », 2026-10-13):
 *
 *   DRAFT_OP_EVENT    a retouche captured on the draft (utils/sessionManager, the API's transform/draftCapture):
 *                     detail { op, entry, counts } — the Change Studio's panel appends the operation to the plan
 *   DRAFT_UNDO_EVENT  undo in the draft (EditModeContext's undoLast while capturing): its last retouche taken back
 *   DRAFT_REDO_EVENT  redo in the draft: the retouche taken back put back
 *
 * A module of their own, so that whoever mocks the session or the edit mode in a test still reads their names.
 */

export const DRAFT_OP_EVENT = "gtfs:draft-op";
export const DRAFT_UNDO_EVENT = "gtfs:draft-undo";
export const DRAFT_REDO_EVENT = "gtfs:draft-redo";
