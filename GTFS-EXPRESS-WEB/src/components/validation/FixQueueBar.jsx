import React, { useCallback, useEffect, useRef, useState } from "react";
import {
  Box,
  Button,
  IconButton,
  Typography,
  Tooltip,
  Chip,
  CircularProgress,
  useTheme,
  alpha,
} from "@mui/material";
import ChevronLeftIcon from "@mui/icons-material/ChevronLeft";
import ChevronRightIcon from "@mui/icons-material/ChevronRight";
import CloseIcon from "@mui/icons-material/Close";
import AutoFixHighIcon from "@mui/icons-material/AutoFixHigh";
import HelpOutlineIcon from "@mui/icons-material/HelpOutline";
import { useLanguage } from "../../contexts/LanguageContext";
import { getRuleTitle, getRuleDocUrl } from "./ruleCatalog";
import useFixDialog from "./useFixDialog";

/**
 * Walks through the fixable findings one by one, the current one's editor opened by itself. No key chord of its own:
 * Alt+← / Alt+→ are the browser's Back / Forward, and a bar that took them would trap the person on the page.
 */
function FixQueueBar({ findings, onClose }) {
  const theme = useTheme();
  const { t } = useLanguage();
  const { openFix, loadingId, dialogs, dialogOpen, editing } = useFixDialog();
  const [index, setIndex] = useState(0);
  const total = findings.length;
  const keyOf = (f) => (f ? `${f.ruleCode}|${f.entityType}|${f.entityId}` : null);
  // The cursor follows the finding's identity, not its index: a re-validation removing fixed findings shifts the
  // list, and the person stays on their finding (or the next one if it is gone).
  const currentKeyRef = useRef(null);
  useEffect(() => {
    if (!currentKeyRef.current) return;
    const at = findings.findIndex((f) => keyOf(f) === currentKeyRef.current);
    if (at >= 0 && at !== index) setIndex(at);
    if (at < 0) setIndex((i) => Math.min(i, Math.max(0, total - 1)));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [findings]);
  const current = findings[Math.min(index, Math.max(0, total - 1))] || null;
  const openedForRef = useRef(null);

  // Never while the person types in an editor (a list refresh must not replace it). A draft's screen turns edit
  // mode on a moment after it opens: the editor then waits for it.
  useEffect(() => {
    if (!current) return;
    const key = keyOf(current);
    currentKeyRef.current = key;
    if (openedForRef.current === key) return;
    if (dialogOpen) return;
    openedForRef.current = key;
    const waitsForEditing = !editing;
    Promise.resolve(openFix(current)).then((opened) => {
      if (!opened && waitsForEditing && openedForRef.current === key) openedForRef.current = null;
    });
  }, [current, openFix, dialogOpen, editing]);

  const goto = useCallback(
    (next) => {
      if (total === 0) return;
      setIndex(((next % total) + total) % total);
    },
    [total],
  );

  if (total === 0) return null;

  const accent = theme.palette.warning.main;

  return (
    <>
      <Box
        data-testid="fix-queue-bar"
        role="toolbar"
        aria-label={t("validation.fixQueue.title")}
        sx={{
          flexShrink: 0,
          display: "flex",
          alignItems: "center",
          gap: 1.25,
          px: 2,
          py: 1,
          borderTop: `2px solid ${accent}`,
          bgcolor: alpha(accent, theme.palette.mode === "dark" ? 0.12 : 0.07),
        }}
      >
        <AutoFixHighIcon sx={{ fontSize: 18, color: accent }} />
        <Typography
          variant="body2"
          sx={{ fontWeight: 700, fontVariantNumeric: "tabular-nums", minWidth: 64 }}
          data-testid="fix-queue-position"
        >
          {index + 1} / {total}
        </Typography>
        {current && (
          <Box sx={{ display: "flex", alignItems: "center", gap: 1, minWidth: 0, flex: 1 }}>
            <Typography variant="body2" noWrap sx={{ fontWeight: 600 }}>
              {getRuleTitle(current.ruleCode) || current.ruleCode}
            </Typography>
            <Chip
              size="small"
              label={`${current.entityType} · ${current.entityId}`}
              sx={{ height: 20, fontSize: "0.68rem", fontFamily: "monospace" }}
            />
            {loadingId === String(current.entityId) && <CircularProgress size={14} />}
            {getRuleDocUrl(current.ruleCode) && (
              <Tooltip title={current.ruleCode} arrow>
                <IconButton
                  size="small"
                  component="a"
                  href={getRuleDocUrl(current.ruleCode)}
                  target="_blank"
                  rel="noopener noreferrer"
                  aria-label={current.ruleCode}
                >
                  <HelpOutlineIcon sx={{ fontSize: 16 }} />
                </IconButton>
              </Tooltip>
            )}
          </Box>
        )}
        <Tooltip title={t("validation.fixQueue.prev")} arrow>
          <span>
            <IconButton size="small" onClick={() => goto(index - 1)} disabled={total < 2} aria-label={t("validation.fixQueue.prev")}>
              <ChevronLeftIcon fontSize="small" />
            </IconButton>
          </span>
        </Tooltip>
        <Button
          size="small"
          variant="contained"
          disableElevation
          onClick={() => (dialogOpen ? goto(index + 1) : openFix(current))}
          data-testid="fix-queue-next"
          endIcon={<ChevronRightIcon sx={{ fontSize: 16 }} />}
          sx={{ textTransform: "none", fontWeight: 700 }}
        >
          {dialogOpen ? t("validation.fixQueue.next") : t("validation.fixQueue.open")}
        </Button>
        <Tooltip title={t("app.close")} arrow>
          <IconButton size="small" onClick={onClose} aria-label={t("app.close")}>
            <CloseIcon fontSize="small" />
          </IconButton>
        </Tooltip>
      </Box>
      {dialogs}
    </>
  );
}

export default FixQueueBar;
