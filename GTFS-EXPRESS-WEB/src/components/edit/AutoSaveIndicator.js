import React, { useEffect, useMemo, useState } from "react";
import { Box, Tooltip, CircularProgress } from "@mui/material";
import { useTheme, alpha } from "@mui/material/styles";
import { useEditMode } from "../../contexts/EditModeContext";
import { useLanguage } from "../../contexts/LanguageContext";

/**
 * Tiny "auto-save status" pill rendered in the Header while edit mode is on.
 *
 * UX intent: turn the abstract "your work is being protected" promise into a
 * passive but always-visible signal — same pattern as Notion / Figma /
 * Google Docs. Five visual states (priority, top wins):
 *
 *   1. !editing                                    → render nothing
 *   2. autoSaveInFlight === true                   → spinner + "Saving…"
 *   3. pendingEdits > 0  &&  lastAutoSaveAt        → amber dot + "{n} unsaved"
 *   4. pendingEdits === 0 && lastAutoSaveAt        → green dot + "Saved {t} ago"
 *   5. pendingEdits > 0  && !lastAutoSaveAt        → amber dot + "Edits not saved yet"
 *   6. else (no edits, no save yet)                → grey dot  + "Up to date"
 *
 * The relative timestamp self-refreshes every 15 s so a "Saved 23s ago" label
 * keeps drifting forward without user interaction. Hovering reveals the
 * absolute timestamp, formatted in the user's current language.
 */
function AutoSaveIndicator() {
  const theme = useTheme();
  const { t, language } = useLanguage();
  const { editing, autoSaveInFlight, lastAutoSaveAt, pendingEdits } =
    useEditMode();

  // Tick every 15 s to refresh "Saved Xs ago" without forcing the entire
  // tree to re-render. Local state, scoped to this component only.
  const [, setTick] = useState(0);
  useEffect(() => {
    if (!editing) return undefined;
    const id = setInterval(() => setTick((n) => n + 1), 15_000);
    return () => clearInterval(id);
  }, [editing]);

  // Format an elapsed delta (ms) as a compact relative label.
  const formatRelative = useMemo(
    () => (ms) => {
      if (ms == null || ms < 0) return "";
      const sec = Math.floor(ms / 1000);
      if (sec < 60) return `${sec}s`;
      const min = Math.floor(sec / 60);
      if (min < 60) return `${min}m`;
      const hr = Math.floor(min / 60);
      if (hr < 24) return `${hr}h`;
      // Beyond 24 h: short locale date (no time component — too long for a pill).
      try {
        return new Intl.DateTimeFormat(language, {
          month: "short",
          day: "numeric",
        }).format(new Date(Date.now() - ms));
      } catch {
        return new Date(Date.now() - ms).toLocaleDateString();
      }
    },
    [language],
  );

  // Absolute tooltip label ("Last save: 14:23:05") — hidden when no save yet.
  const absoluteTooltip = useMemo(() => {
    if (!lastAutoSaveAt) return "";
    let formatted;
    try {
      formatted = new Intl.DateTimeFormat(language, {
        hour: "2-digit",
        minute: "2-digit",
        second: "2-digit",
      }).format(new Date(lastAutoSaveAt));
    } catch {
      formatted = new Date(lastAutoSaveAt).toLocaleTimeString();
    }
    return t("autoSave.lastSaveAt", { time: formatted });
  }, [lastAutoSaveAt, language, t]);

  if (!editing) return null;

  // ── State resolution (priority order matches the JSDoc above) ──
  let dotColor;
  let label;
  let showSpinner = false;

  if (autoSaveInFlight) {
    showSpinner = true;
    label = t("autoSave.saving");
  } else if (pendingEdits > 0 && lastAutoSaveAt) {
    dotColor = theme.palette.warning.main;
    label = t("autoSave.unsavedChanges", { count: pendingEdits });
  } else if (pendingEdits === 0 && lastAutoSaveAt) {
    dotColor = theme.palette.success.main;
    label = t("autoSave.savedRelative", {
      time: formatRelative(Date.now() - lastAutoSaveAt),
    });
  } else if (pendingEdits > 0 && !lastAutoSaveAt) {
    dotColor = theme.palette.warning.main;
    label = t("autoSave.notSavedYet");
  } else {
    dotColor = alpha(theme.palette.text.secondary, 0.45);
    label = t("autoSave.idle");
  }

  const content = (
    <Box
      sx={{
        display: "inline-flex",
        alignItems: "center",
        gap: 0.75,
        fontSize: 11,
        lineHeight: 1,
        color: theme.palette.text.secondary,
        userSelect: "none",
        whiteSpace: "nowrap",
      }}
    >
      {showSpinner ? (
        <CircularProgress
          size={12}
          thickness={5}
          sx={{ color: theme.palette.text.secondary }}
        />
      ) : (
        <Box
          sx={{
            width: 6,
            height: 6,
            borderRadius: "50%",
            backgroundColor: dotColor,
            flexShrink: 0,
          }}
        />
      )}
      <span>{label}</span>
    </Box>
  );

  // No tooltip when there's nothing to disclose (idle / never-saved states).
  if (!absoluteTooltip) return content;
  return (
    <Tooltip title={absoluteTooltip} arrow>
      {content}
    </Tooltip>
  );
}

export default AutoSaveIndicator;
