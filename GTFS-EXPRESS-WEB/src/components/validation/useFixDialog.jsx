import React, { useCallback, useEffect, useRef, useState } from "react";
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
 * Turns a validation finding (its `entityType` and `entityId`) into the right editor, the offending fields
 * highlighted. Outside edit mode it offers to enter it, then retries the same finding. Render `dialogs` once.
 */

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
  // The snackbar's retry reads edit mode here: its closure would still see the old value and loop.
  const editingRef = useRef(editing);
  useEffect(() => {
    editingRef.current = editing;
  }, [editing]);

  const closeSnackbar = useCallback(() => setSnackbar(null), []);
  // Edit mode turned on by other means (a draft's screen does, a moment after it opens) makes the request moot.
  useEffect(() => {
    if (editing) setSnackbar((s) => (s?.needsEditMode ? null : s));
  }, [editing]);
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

      if (!editingRef.current) {
        setSnackbar({
          needsEditMode: true,
          message: t("validation.fix.needsEditMode"),
          severity: "warning",
          action: {
            label: t("validation.fix.enterEditMode"),
            onClick: async () => {
              closeSnackbar();
              const result = await enterEditMode();
              if (result?.ok) {
                editingRef.current = true;
                openFix(finding);
              }
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
    [enterEditMode, openPanel, t, closeSnackbar],
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

  return { openFix, loadingId, dialogs, dialogOpen: Boolean(dialog), editing };
}
