import React, { useCallback, useState } from "react";
import { Snackbar, Alert, Button } from "@mui/material";
import API_BASE_URL from "../../config";
import { fetchWithSession } from "../../utils/sessionManager";
import { useLanguage } from "../../contexts/LanguageContext";
import { useEditMode } from "../../contexts/EditModeContext";
import { useDetailPanel } from "../../contexts/DetailPanelContext";
import { getFixMetaForRule } from "../../utils/ruleFieldMapping";
import EditStopDialog from "../edit/EditStopDialog";
import EditRouteDialog from "../edit/EditRouteDialog";
import EditTripDialog from "../edit/EditTripDialog";
import EditStopTimeDialog from "../edit/EditStopTimeDialog";
import EditAgencyDialog from "../edit/EditAgencyDialog";

/**
 * useFixDialog — one place that turns a validation finding into the right
 * editor, with the offending fields highlighted.
 *
 *   stop / route / trip   → fetch the row, open the matching edit dialog
 *   stop_time             → EditStopTimeDialog (entityId = "trip_id:stop_sequence")
 *   agency                → EditAgencyDialog (row looked up in GET /agencies)
 *   calendar / shape /
 *   feed_info             → open the side panel on that record
 *
 * Findings need `entityType` + `entityId` (derived server-side from the
 * MobilityData engine's own fields). Outside edit mode the hook offers to
 * enter it and then retries the same finding.
 *
 * Returns { openFix(finding), loadingId, dialogs } — render `dialogs` once
 * in the host component.
 */

// Entity types this hook can act on.
export const FIXABLE_TYPES = new Set([
  "stop",
  "route",
  "trip",
  "stop_time",
  "agency",
  "calendar",
  "shape",
  "feed_info",
]);

// Map entity type to the GET detail endpoint segment (dialog-backed types).
const DETAIL_ENDPOINT = {
  stop: "stop_detail",
  route: "route_detail",
  trip: "trip_detail",
};

const PANEL_TYPES = new Set(["calendar", "shape", "feed_info"]);

/** Resolve { entityType, fields } for a finding, or null when not fixable. */
export const resolveFixMeta = (finding) => {
  if (!finding || finding.aggregate || finding.resolvedByImport) return null;
  if (!finding.entityId) return null;
  const mapping = getFixMetaForRule(finding.ruleCode, finding);
  if (!mapping) return null;
  const entityType = mapping.entityType || finding.entityType || null;
  if (!entityType || !FIXABLE_TYPES.has(entityType)) return null;
  const fields =
    mapping.fields.length > 0
      ? mapping.fields
      : finding.field
        ? [finding.field]
        : [];
  return { entityType, fields };
};

export const isFixableFinding = (finding) => resolveFixMeta(finding) !== null;

export default function useFixDialog() {
  const { t } = useLanguage();
  const { editing, enterEditMode } = useEditMode();
  const { openPanel } = useDetailPanel();
  const [dialog, setDialog] = useState(null); // { entityType, entity, highlightFields }
  const [loadingId, setLoadingId] = useState(null);
  const [snackbar, setSnackbar] = useState(null); // { message, severity, action? }

  const closeSnackbar = useCallback(() => setSnackbar(null), []);
  const closeDialog = useCallback(() => setDialog(null), []);

  const openFix = useCallback(
    async (finding) => {
      const meta = resolveFixMeta(finding);
      if (!meta) return false;
      const { entityType, fields } = meta;
      const entityId = String(finding.entityId);

      if (PANEL_TYPES.has(entityType)) {
        openPanel(entityType, entityType === "feed_info" ? "feed_info.txt" : entityId);
        return true;
      }

      if (!editing) {
        setSnackbar({
          message: t("validation.fix.needsEditMode"),
          severity: "warning",
          action: {
            label: t("validation.fix.enterEditMode"),
            onClick: async () => {
              closeSnackbar();
              const result = await enterEditMode();
              if (result?.ok) openFix(finding);
            },
          },
        });
        return false;
      }

      if (entityType === "stop_time") {
        const sep = entityId.lastIndexOf(":");
        if (sep <= 0) return false;
        const tripId = entityId.slice(0, sep);
        const seq = Number(entityId.slice(sep + 1));
        if (!Number.isInteger(seq)) return false;
        setDialog({
          entityType,
          entity: { trip_id: tripId, stop_sequence: seq },
          highlightFields: fields,
        });
        return true;
      }

      setLoadingId(entityId);
      try {
        if (entityType === "agency") {
          const res = await fetchWithSession(`${API_BASE_URL}/agencies`);
          const list = res.ok ? await res.json() : [];
          const agency = Array.isArray(list)
            ? list.find((a) => String(a.agency_id) === entityId)
            : null;
          if (!agency) {
            setSnackbar({
              message: t("validation.fix.entityNotFound", { id: entityId }),
              severity: "error",
            });
            return false;
          }
          setDialog({ entityType, entity: agency, highlightFields: fields });
          return true;
        }

        const endpoint = DETAIL_ENDPOINT[entityType];
        const res = await fetchWithSession(
          `${API_BASE_URL}/${endpoint}/${encodeURIComponent(entityId)}`,
        );
        if (res.status === 404) {
          setSnackbar({
            message: t("validation.fix.entityNotFound", { id: entityId }),
            severity: "error",
          });
          return false;
        }
        if (!res.ok) {
          const body = await res.json().catch(() => ({}));
          setSnackbar({
            message: t("validation.fix.fetchError", {
              type: entityType,
              error: body.error || res.statusText,
            }),
            severity: "error",
          });
          return false;
        }
        const data = await res.json();
        const entity =
          data[entityType] || data.stop || data.route || data.trip || data;
        setDialog({ entityType, entity, highlightFields: fields });
        return true;
      } catch (err) {
        setSnackbar({
          message: t("validation.fix.fetchError", {
            type: entityType,
            error: err.message,
          }),
          severity: "error",
        });
        return false;
      } finally {
        setLoadingId(null);
      }
    },
    [editing, enterEditMode, openPanel, t, closeSnackbar],
  );

  const dialogs = (
    <>
      {dialog?.entityType === "stop" && (
        <EditStopDialog
          open
          stop={dialog.entity}
          onClose={closeDialog}
          mode="edit"
          highlightFields={dialog.highlightFields}
        />
      )}
      {dialog?.entityType === "route" && (
        <EditRouteDialog
          open
          route={dialog.entity}
          onClose={closeDialog}
          mode="edit"
          highlightFields={dialog.highlightFields}
        />
      )}
      {dialog?.entityType === "trip" && (
        <EditTripDialog
          open
          trip={dialog.entity}
          onClose={closeDialog}
          mode="edit"
          highlightFields={dialog.highlightFields}
        />
      )}
      {dialog?.entityType === "stop_time" && (
        <EditStopTimeDialog open stopTime={dialog.entity} onClose={closeDialog} />
      )}
      {dialog?.entityType === "agency" && (
        <EditAgencyDialog open agency={dialog.entity} onClose={closeDialog} />
      )}
      <Snackbar
        open={Boolean(snackbar)}
        autoHideDuration={snackbar?.action ? null : 5000}
        onClose={closeSnackbar}
        anchorOrigin={{ vertical: "bottom", horizontal: "center" }}
      >
        {snackbar ? (
          <Alert
            severity={snackbar.severity || "info"}
            onClose={closeSnackbar}
            action={
              snackbar.action ? (
                <Button color="inherit" size="small" onClick={snackbar.action.onClick}>
                  {snackbar.action.label}
                </Button>
              ) : undefined
            }
            sx={{ alignItems: "center" }}
          >
            {snackbar.message}
          </Alert>
        ) : (
          <span />
        )}
      </Snackbar>
    </>
  );

  return { openFix, loadingId, dialogs, dialogOpen: Boolean(dialog) };
}
