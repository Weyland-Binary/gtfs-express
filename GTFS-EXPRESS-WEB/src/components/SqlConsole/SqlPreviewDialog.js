import React from "react";
import {
  Alert,
  Box,
  Button,
  Checkbox,
  Chip,
  CircularProgress,
  Dialog,
  DialogActions,
  DialogContent,
  DialogTitle,
  FormControlLabel,
  Tooltip,
  Typography,
} from "@mui/material";
import { alpha, useTheme } from "@mui/material/styles";
import PlayArrowIcon from "@mui/icons-material/PlayArrow";
import WarningAmberIcon from "@mui/icons-material/WarningAmber";
import { MONO_FONT } from "./constants";

/* ------------------------------------------------------------------ */
/* SqlPreviewDialog — preview-and-confirm modal for mutations          */
/*                                                                     */
/* Rendered when `previewData` is non-null. Surfaces three pieces of   */
/* information the user needs before running a destructive statement:  */
/*   1. Aggregate row count (total affected, formatted with locale     */
/*      separators) and any warnings from the backend.                 */
/*   2. Per-statement breakdown (verb + table + direct affected, plus  */
/*      cascade fan-out for DELETE on parent tables).                  */
/*   3. The exact SQL to run, so the user can sanity-check the WHERE   */
/*      clause one more time before authorising the action.            */
/*                                                                     */
/* When the mutation exceeds the default cap (50k rows) the dialog     */
/* requires an explicit checkbox tick to authorise the larger cap      */
/* (200k); above that, the action is hard-blocked.                     */
/* ------------------------------------------------------------------ */

export default function SqlPreviewDialog({
  open,
  onClose,
  onConfirm,
  previewData,
  query,
  confirmedLargeMutation,
  setConfirmedLargeMutation,
  running,
  t,
  language,
}) {
  const theme = useTheme();
  if (!previewData) return null;

  const {
    statements = [],
    totalAffected = 0,
    confirmedCap = 200000,
    exceedsDefaultCap = false,
    exceedsConfirmedCap = false,
  } = previewData;

  const formatCount = (n) => {
    try {
      return Number(n).toLocaleString(language);
    } catch {
      return String(n);
    }
  };

  // Confirm button stays disabled while: (a) mutation absolutely exceeds the
  // hard cap, (b) it exceeds the soft cap and the user hasn't ticked the
  // authorisation checkbox, or (c) a request is already in flight.
  const confirmDisabled =
    running ||
    exceedsConfirmedCap ||
    (exceedsDefaultCap && !confirmedLargeMutation);

  // Visual emphasis ramp: warning above 5,000 rows, default below. We avoid
  // `error` for the confirm button because it would conflict semantically
  // with the cascade-cap error alert above it.
  const confirmColor = totalAffected > 5000 ? "warning" : "primary";

  return (
    <Dialog
      open={open}
      onClose={running ? undefined : onClose}
      maxWidth="sm"
      fullWidth
      slotProps={{
        paper: {
          sx: {
            border: `1px solid ${alpha(theme.palette.warning.main, 0.3)}`,
            borderLeft: `3px solid ${theme.palette.warning.main}`,
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
          sx={{ fontSize: 20, color: theme.palette.warning.main }}
        />
        {t("sqlConsole.preview.title")}
      </DialogTitle>
      <DialogContent dividers sx={{ px: 2.5, py: 2 }}>
        {/* Aggregate count — primary metric the user reads first. */}
        <Typography
          sx={{
            fontSize: 13,
            fontWeight: 600,
            color: theme.palette.text.primary,
            mb: 1.5,
          }}
        >
          {t("sqlConsole.preview.totalAffected", {
            count: formatCount(totalAffected),
          })}
        </Typography>

        {/* Soft-cap warning + opt-in checkbox (50k–200k range). */}
        {exceedsDefaultCap && !exceedsConfirmedCap && (
          <Alert
            severity="warning"
            icon={<WarningAmberIcon fontSize="small" />}
            sx={{ mb: 1.5, py: 0.5, fontSize: 12 }}
          >
            {t("sqlConsole.preview.largeMutationWarning", {
              count: formatCount(totalAffected),
              max: formatCount(confirmedCap),
            })}
          </Alert>
        )}

        {/* Hard-cap blocker (>200k). */}
        {exceedsConfirmedCap && (
          <Alert
            severity="error"
            icon={<WarningAmberIcon fontSize="small" />}
            sx={{ mb: 1.5, py: 0.5, fontSize: 12 }}
          >
            {t("sqlConsole.preview.exceedsCapError", {
              max: formatCount(confirmedCap),
            })}
          </Alert>
        )}

        {/* Per-statement breakdown — verb + table + direct count + cascade */}
        {statements.length > 0 && (
          <Box sx={{ mb: 1.5 }}>
            <Typography
              variant="caption"
              sx={{
                display: "block",
                fontSize: 11,
                fontWeight: 600,
                color: theme.palette.text.secondary,
                textTransform: "uppercase",
                letterSpacing: 0.5,
                mb: 0.5,
              }}
            >
              {t("sqlConsole.preview.statementsTitle")}
            </Typography>
            <Box
              sx={{
                border: `1px solid ${alpha(theme.palette.text.primary, 0.1)}`,
                borderRadius: 1,
                background: alpha(theme.palette.text.primary, 0.02),
              }}
            >
              {statements.map((stmt, idx) => {
                const cascadeTotal = Array.isArray(stmt.cascade)
                  ? stmt.cascade.reduce(
                      (acc, c) => acc + (Number(c.count) || 0),
                      0,
                    )
                  : 0;
                return (
                  <Box
                    key={idx}
                    sx={{
                      display: "flex",
                      alignItems: "center",
                      gap: 1,
                      px: 1.25,
                      py: 0.75,
                      fontFamily: MONO_FONT,
                      fontSize: 11.5,
                      borderTop:
                        idx === 0
                          ? "none"
                          : `1px solid ${alpha(
                              theme.palette.text.primary,
                              0.06,
                            )}`,
                    }}
                  >
                    <Chip
                      label={String(stmt.verb || "").toUpperCase()}
                      size="small"
                      sx={{
                        height: 18,
                        fontSize: 10,
                        fontWeight: 700,
                        fontFamily: MONO_FONT,
                        background: alpha(theme.palette.warning.main, 0.14),
                        color: theme.palette.warning.dark,
                      }}
                    />
                    <Typography
                      sx={{
                        fontFamily: MONO_FONT,
                        fontSize: 11.5,
                        color: theme.palette.text.primary,
                        flex: 1,
                      }}
                    >
                      {stmt.table || "—"}
                    </Typography>
                    <Typography
                      sx={{
                        fontFamily: MONO_FONT,
                        fontSize: 11.5,
                        fontWeight: 700,
                        color: theme.palette.text.primary,
                      }}
                    >
                      {formatCount(stmt.affected || 0)}
                    </Typography>
                    {cascadeTotal > 0 && (
                      <Tooltip
                        title={(stmt.cascade || [])
                          .map(
                            (c) => `${c.table}: ${formatCount(c.count || 0)}`,
                          )
                          .join(", ")}
                      >
                        <Chip
                          label={t("sqlConsole.preview.cascadeLabel", {
                            count: formatCount(cascadeTotal),
                          })}
                          size="small"
                          sx={{
                            height: 18,
                            fontSize: 10,
                            fontFamily: MONO_FONT,
                            background: alpha(theme.palette.error.main, 0.1),
                            color: theme.palette.error.main,
                          }}
                        />
                      </Tooltip>
                    )}
                  </Box>
                );
              })}
            </Box>
          </Box>
        )}

        {/* SQL preview — monospace, scrollable, capped height. */}
        <Typography
          variant="caption"
          sx={{
            display: "block",
            fontSize: 11,
            fontWeight: 600,
            color: theme.palette.text.secondary,
            textTransform: "uppercase",
            letterSpacing: 0.5,
            mb: 0.5,
          }}
        >
          {t("sqlConsole.preview.queryLabel")}
        </Typography>
        <Box
          sx={{
            fontFamily: MONO_FONT,
            fontSize: 11.5,
            background: alpha(theme.palette.text.primary, 0.04),
            border: `1px solid ${alpha(theme.palette.text.primary, 0.1)}`,
            borderRadius: 1,
            px: 1.25,
            py: 1,
            maxHeight: 200,
            overflow: "auto",
            whiteSpace: "pre-wrap",
            color: theme.palette.text.primary,
          }}
        >
          {query}
        </Box>

        {/* Opt-in checkbox shown only when the user CAN authorise (50k–200k). */}
        {exceedsDefaultCap && !exceedsConfirmedCap && (
          <FormControlLabel
            sx={{ mt: 1.5, ml: 0 }}
            control={
              <Checkbox
                size="small"
                checked={confirmedLargeMutation}
                onChange={(e) => setConfirmedLargeMutation(e.target.checked)}
                disabled={running}
              />
            }
            label={
              <Typography sx={{ fontSize: 12 }}>
                {t("sqlConsole.preview.largeMutationCheckbox")}
              </Typography>
            }
          />
        )}
      </DialogContent>
      <DialogActions sx={{ px: 2.5, py: 1 }}>
        <Button size="small" onClick={onClose} disabled={running}>
          {t("sqlConsole.preview.cancel")}
        </Button>
        <Button
          size="small"
          variant="contained"
          color={confirmColor}
          startIcon={
            running ? (
              <CircularProgress size={14} color="inherit" />
            ) : (
              <PlayArrowIcon />
            )
          }
          onClick={onConfirm}
          disabled={confirmDisabled}
        >
          {t("sqlConsole.preview.runAnyway")}
        </Button>
      </DialogActions>
    </Dialog>
  );
}
