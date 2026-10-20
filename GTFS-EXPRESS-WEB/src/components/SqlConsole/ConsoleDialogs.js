import React from "react";
import {
  Box,
  Button,
  Typography,
  Alert,
  Dialog,
  DialogTitle,
  DialogContent,
  DialogActions,
  CircularProgress,
} from "@mui/material";
import { alpha, useTheme } from "@mui/material/styles";
import InfoOutlinedIcon from "@mui/icons-material/InfoOutlined";
import DeleteForeverIcon from "@mui/icons-material/DeleteForever";
import WarningAmberIcon from "@mui/icons-material/WarningAmber";
import StorageIcon from "@mui/icons-material/Storage";
import EditStopDialog from "../edit/EditStopDialog";
import EditRouteDialog from "../edit/EditRouteDialog";
import EditTripDialog from "../edit/EditTripDialog";
import { MONO_FONT } from "./constants";
import Kbd from "./Kbd";

/**
 * DeleteConfirmDialog — the GTFS-aware confirm before a bulk delete: the
 * cascade hint when the table is a parent (its children named), the refusal
 * when the deletion would empty agency or feed_info (the backend refuses too;
 * the reason is said here), and the reminder that Ctrl+Z undoes the whole
 * batch. The cascade's row counts are not pre-computed: the backend reports
 * them and the success toast reflects the total.
 */
export function DeleteConfirmDialog({
  deleteConfirmOpen,
  setDeleteConfirmOpen,
  deleting,
  selectedRows,
  editable,
  willEmptySingletonTable,
  cascadeChildren,
  handleDeleteSelected,
  t,
}) {
  const theme = useTheme();
  return (
    <>
      {/* ---------- Bulk delete confirm dialog ----------
        GTFS-aware delete confirmation: surfaces (a) the immediate cascade
        fan-out hint when deleting from a parent table (agency/routes/
        trips/stops/calendar), (b) a singleton-required warning when the
        user is about to wipe agency or feed_info entirely. We don't
        pre-compute the actual cascade row counts — the backend reports
        them in the response and we reflect the total in the success
        toast. Ctrl+Z hint mentioned explicitly so the action feels safe. */}
      <Dialog
        open={deleteConfirmOpen}
        onClose={() => (deleting ? null : setDeleteConfirmOpen(false))}
        maxWidth="xs"
        fullWidth
        slotProps={{
          paper: {
            sx: {
              border: `1px solid ${alpha(theme.palette.error.main, 0.3)}`,
              borderLeft: `3px solid ${theme.palette.error.main}`,
            },
          },
        }}
      >
        <DialogTitle
          sx={{
            display: "flex",
            alignItems: "center",
            gap: 1,
            fontSize: 14,
            fontWeight: 700,
            pb: 1,
          }}
        >
          <WarningAmberIcon
            sx={{ fontSize: 20, color: theme.palette.error.main }}
          />
          {t("sqlConsole.deleteConfirm.title", {
            count: selectedRows.size,
            table: editable?.table || "",
          })}
        </DialogTitle>
        <DialogContent dividers sx={{ px: 2.5, py: 2 }}>
          {willEmptySingletonTable && (
            <Alert
              severity="error"
              icon={<WarningAmberIcon fontSize="small" />}
              sx={{ mb: 1.5, py: 0.5, fontSize: 12 }}
            >
              {t("sqlConsole.deleteConfirm.singletonWarning", {
                table: editable?.table || "",
              })}
            </Alert>
          )}
          {cascadeChildren && cascadeChildren.length > 0 && (
            <Alert
              severity="warning"
              icon={<InfoOutlinedIcon fontSize="small" />}
              sx={{
                mb: 1.5,
                py: 0.5,
                fontSize: 12,
                "& .MuiAlert-message": {
                  fontFamily: MONO_FONT,
                  fontSize: 11.5,
                },
              }}
            >
              {t("sqlConsole.deleteConfirm.cascadeWarning", {
                tables: cascadeChildren.join(", "),
              })}
            </Alert>
          )}
          <Typography
            variant="caption"
            sx={{
              display: "block",
              fontSize: 11.5,
              color: theme.palette.text.secondary,
              fontStyle: "italic",
            }}
          >
            {t("sqlConsole.deleteConfirm.undoHint")}
          </Typography>
        </DialogContent>
        <DialogActions sx={{ px: 2.5, py: 1 }}>
          <Button
            size="small"
            onClick={() => setDeleteConfirmOpen(false)}
            disabled={deleting}
          >
            {t("app.cancel")}
          </Button>
          <Button
            size="small"
            variant="contained"
            color="error"
            startIcon={
              deleting ? (
                <CircularProgress size={14} color="inherit" />
              ) : (
                <DeleteForeverIcon />
              )
            }
            onClick={handleDeleteSelected}
            disabled={deleting || willEmptySingletonTable}
          >
            {t("sqlConsole.deleteConfirm.confirmBtn", {
              count: selectedRows.size,
            })}
          </Button>
        </DialogActions>
      </Dialog>
    </>
  );
}

/**
 * EditRowDialogs — the entity's own dialog for the row the pencil opened
 * (stop, route or trip), the only entities with a dedicated editor.
 */
export function EditRowDialogs({ editTarget, setEditTarget }) {
  return (
    <>
      {/* ---------- Edit row dialog (single) ---------- */}
      {editTarget?.entity === "stop" && (
        <EditStopDialog
          open
          stop={editTarget.row}
          onClose={() => setEditTarget(null)}
        />
      )}
      {editTarget?.entity === "route" && (
        <EditRouteDialog
          open
          route={editTarget.row}
          onClose={() => setEditTarget(null)}
        />
      )}
      {editTarget?.entity === "trip" && (
        <EditTripDialog
          open
          trip={editTarget.row}
          onClose={() => setEditTarget(null)}
        />
      )}
    </>
  );
}

/**
 * HelpDialog — the console's own shortcut sheet (« ? »), distinct from the
 * app-wide ShortcutsHelpDialog: the keys of the SQL features only.
 */
export function HelpDialog({ helpOpen, setHelpOpen, t }) {
  const theme = useTheme();
  return (
    <>
      {/* ---------- Shortcut help dialog (compact, scoped to SQL Console) */}
      <Dialog
        open={helpOpen}
        onClose={() => setHelpOpen(false)}
        maxWidth="xs"
        fullWidth
        slotProps={{
          paper: {
            sx: {
              border: `1px solid ${alpha(theme.palette.text.primary, 0.08)}`,
              backgroundImage: "none",
            },
          },
        }}
      >
        <DialogTitle
          sx={{
            display: "flex",
            alignItems: "center",
            gap: 1,
            pb: 1,
            fontSize: 14,
            fontWeight: 700,
            letterSpacing: "0.02em",
          }}
        >
          <StorageIcon
            sx={{ fontSize: 16, color: theme.palette.primary.main }}
          />
          {t("sqlConsole.help.title")}
        </DialogTitle>
        <DialogContent dividers sx={{ px: 2.5, py: 1.5 }}>
          {[
            { keys: ["⌘", "↵"], label: t("sqlConsole.kbd.run") },
            { keys: ["⌘", "S"], label: t("sqlConsole.kbd.savePreset") },
            { keys: ["⌘", "L"], label: t("sqlConsole.kbd.clearAll") },
            {
              keys: ["⌘", "1-9"],
              label: t("sqlConsole.help.fileJumpRange"),
            },
            { keys: ["Esc"], label: t("sqlConsole.help.escape") },
            { keys: ["F2"], label: t("sqlConsole.help.f2") },
            { keys: ["⌘", "C"], label: t("sqlConsole.help.copy") },
            { keys: ["?"], label: t("sqlConsole.kbd.help") },
          ].map((row, i) => (
            <Box
              key={i}
              sx={{
                display: "flex",
                alignItems: "center",
                gap: 1,
                py: 0.625,
                borderBottom:
                  i === 7
                    ? "none"
                    : `1px solid ${alpha(theme.palette.text.primary, 0.06)}`,
              }}
            >
              <Box
                sx={{
                  flex: 1,
                  fontSize: 12,
                  color: theme.palette.text.primary,
                }}
              >
                {row.label}
              </Box>
              <Box sx={{ display: "inline-flex", gap: 0.25 }}>
                {row.keys.map((k, j) => (
                  <Kbd key={j} sx={{ ml: 0 }}>
                    {k}
                  </Kbd>
                ))}
              </Box>
            </Box>
          ))}
        </DialogContent>
        <DialogActions sx={{ px: 2.5, py: 1 }}>
          <Button onClick={() => setHelpOpen(false)} size="small">
            {t("app.cancel")}
          </Button>
        </DialogActions>
      </Dialog>
    </>
  );
}
