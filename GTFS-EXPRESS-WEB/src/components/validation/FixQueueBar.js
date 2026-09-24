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
 * FixQueueBar — walk through the fixable findings one by one.
 *
 * A docked bar at the bottom of the validation page: "3 / 42 · rule · entity",
 * Previous / Next, and the editor for the current finding opens automatically
 * (same dialogs as the per-row Fix button, offending fields highlighted).
 * Alt+→ / Alt+← move without touching the mouse.
 *
 * Props:
 *   findings  — ordered array of fixable findings (see isFixableFinding)
 *   onClose   — callback
 */
function FixQueueBar({ findings, onClose }) {
  const theme = useTheme();
  const { t } = useLanguage();
  const { openFix, loadingId, dialogs, dialogOpen } = useFixDialog();
  const [index, setIndex] = useState(0);
  const total = findings.length;
  const keyOf = (f) => (f ? `${f.ruleCode}|${f.entityType}|${f.entityId}` : null);
  // The cursor is anchored to the finding's identity, not its position: when
  // the background re-validation removes fixed findings the list shifts, and
  // the user must stay on the finding they were looking at (or the next one
  // if theirs is gone) instead of jumping to whatever now sits at that index.
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

  // Open the editor whenever the cursor lands on a new finding — never while
  // the user is already typing in one (a list refresh must not replace it).
  useEffect(() => {
    if (!current) return;
    const key = keyOf(current);
    currentKeyRef.current = key;
    if (openedForRef.current === key) return;
    if (dialogOpen) return;
    openedForRef.current = key;
    openFix(current);
  }, [current, openFix, dialogOpen]);

  const goto = useCallback(
    (next) => {
      if (total === 0) return;
      setIndex(((next % total) + total) % total);
    },
    [total],
  );

  // Keyboard: Alt+→ / Alt+← (never hijack plain arrows inside dialogs).
  useEffect(() => {
    const onKey = (e) => {
      if (!e.altKey) return;
      if (e.key === "ArrowRight") {
        e.preventDefault();
        goto(index + 1);
      } else if (e.key === "ArrowLeft") {
        e.preventDefault();
        goto(index - 1);
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [goto, index]);

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
            <IconButton size="small" onClick={() => goto(index - 1)} disabled={total < 2}>
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
