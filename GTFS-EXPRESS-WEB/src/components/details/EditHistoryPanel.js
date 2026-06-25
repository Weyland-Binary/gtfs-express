import React, { useEffect, useState, useCallback } from "react";
import {
  Box,
  Typography,
  List,
  ListItemButton,
  ListItemText,
  Chip,
  CircularProgress,
  IconButton,
  Tooltip,
  Alert,
} from "@mui/material";
import { useTheme } from "@mui/material/styles";
import UndoIcon from "@mui/icons-material/Undo";
import RedoIcon from "@mui/icons-material/Redo";
import SkipNextIcon from "@mui/icons-material/SkipNext";
import API_BASE_URL from "../../config";
import { fetchWithSession } from "../../utils/sessionManager";
import { useEditMode } from "../../contexts/EditModeContext";
import { useLanguage } from "../../contexts/LanguageContext";

// Entity type → chip color mapping (palette-safe)
const ENTITY_COLORS = {
  stop: "warning",
  route: "secondary",
  trip: "success",
  calendar: "primary",
  stop_time: "info",
};

// Returns a relative time string ("just now", "2 min ago", …)
function relativeTime(isoTs, t) {
  if (!isoTs) return "";
  const diff = Math.floor((Date.now() - new Date(isoTs).getTime()) / 1000);
  if (diff < 60) return t("editHistory.justNow");
  if (diff < 3600) return t("editHistory.minutesAgo", { n: Math.floor(diff / 60) });
  if (diff < 86400) return t("editHistory.hoursAgo", { n: Math.floor(diff / 3600) });
  return t("editHistory.daysAgo", { n: Math.floor(diff / 86400) });
}

function EditHistoryPanel() {
  const [history, setHistory] = useState([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(null);
  const theme = useTheme();
  const isDark = theme.palette.mode === "dark";
  const {
    dataVersion,
    undoLast,
    redoLast,
    jumpToHistory,
    editing,
    undoing,
    redoing,
  } = useEditMode();
  const { t } = useLanguage();

  const loadHistory = useCallback(async () => {
    setError(null);
    try {
      const res = await fetchWithSession(`${API_BASE_URL}/edit/history`, { cache: "no-store" });
      const body = await res.json();
      if (!res.ok) throw new Error(body.error || t("editHistory.loadError"));
      setHistory(body.history || []);
    } catch (err) {
      setError(err.message);
    } finally {
      setLoading(false);
    }
  }, [t]);

  useEffect(() => {
    if (!editing) return;
    loadHistory();
  }, [editing, dataVersion, loadHistory]);

  // Assuming history is returned ordered by id DESC (newest first):
  //   undone tail (highest ids) then active entries (non-undone).
  // Next undo target = first non-undone entry (top of the active stack).
  // Next redo target = last undone entry (the one just "above" active).
  const firstActiveIdx = history.findIndex((e) => !e.undone);
  const lastUndoneIdx =
    firstActiveIdx === -1 ? history.length - 1 : firstActiveIdx - 1;

  if (!editing) {
    return (
      <Box p={2}>
        <Alert severity="info">{t("editHistory.notInEditMode")}</Alert>
      </Box>
    );
  }

  if (loading) {
    return (
      <Box display="flex" justifyContent="center" py={4}>
        <CircularProgress size={28} />
      </Box>
    );
  }

  if (error) {
    return (
      <Box p={2}>
        <Alert severity="error">{error}</Alert>
      </Box>
    );
  }

  if (history.length === 0) {
    return (
      <Box p={2}>
        <Typography variant="body2" color="text.secondary">
          {t("editHistory.empty")}
        </Typography>
      </Box>
    );
  }

  return (
    <Box>
      <Typography
        variant="caption"
        color="text.secondary"
        sx={{
          px: 1,
          pb: 0.5,
          display: "block",
          textTransform: "uppercase",
          letterSpacing: "0.06em",
          fontWeight: 700,
        }}
      >
        {t("editHistory.title")}
      </Typography>

      <List dense disablePadding>
        {history.map((entry, idx) => {
          const isUndone = Boolean(entry.undone);
          const isNextUndo = idx === firstActiveIdx && !undoing;
          const isNextRedo = idx === lastUndoneIdx && isUndone && !redoing;
          const canRedo = isUndone && Boolean(entry.has_redo_ops ?? true);

          const handleJump = () => {
            if (entry.id == null) return;
            jumpToHistory?.(entry.id);
          };

          return (
            <ListItemButton
              key={entry.id}
              onClick={handleJump}
              sx={{
                px: 1,
                py: 0.5,
                borderBottom: isDark
                  ? "1px solid rgba(255,255,255,0.05)"
                  : "1px solid rgba(0,0,0,0.04)",
                opacity: isUndone ? 0.55 : 1,
                transition: "opacity 0.2s ease, background 0.15s ease",
                position: "relative",
                "&::before":
                  isNextUndo || isNextRedo
                    ? {
                        content: '""',
                        position: "absolute",
                        left: 0,
                        top: 0,
                        bottom: 0,
                        width: 3,
                        background: (th) =>
                          isNextUndo
                            ? th.palette.warning.main
                            : th.palette.info.main,
                      }
                    : undefined,
              }}
            >
              <ListItemText
                primary={
                  <Box display="flex" alignItems="center" gap={0.75} flexWrap="wrap">
                    <Chip
                      label={entry.entity || "—"}
                      size="small"
                      color={ENTITY_COLORS[entry.entity] || "default"}
                      sx={{
                        height: 18,
                        fontSize: 10,
                        fontWeight: 700,
                        letterSpacing: "0.03em",
                        "& .MuiChip-label": { px: 0.75 },
                      }}
                    />
                    {isUndone && (
                      <Chip
                        label={t("editHistory.undoneLabel")}
                        size="small"
                        variant="outlined"
                        sx={{
                          height: 18,
                          fontSize: 10,
                          "& .MuiChip-label": { px: 0.75 },
                        }}
                      />
                    )}
                    <Typography
                      component="span"
                      variant="body2"
                      sx={{
                        fontSize: 12,
                        fontWeight: isUndone ? 400 : 500,
                        textDecoration: isUndone ? "line-through" : "none",
                        color: isUndone ? "text.disabled" : "text.primary",
                      }}
                    >
                      {entry.description || `${entry.action} ${entry.entity_id}`}
                    </Typography>
                  </Box>
                }
                secondary={
                  <Typography
                    component="span"
                    variant="caption"
                    color="text.secondary"
                    sx={{ fontSize: 11 }}
                  >
                    {relativeTime(entry.ts, t)}
                    {" · #"}
                    {entry.id}
                  </Typography>
                }
                sx={{ my: 0, pr: 6 }}
              />
              <Box
                sx={{
                  display: "flex",
                  alignItems: "center",
                  gap: 0.25,
                  position: "absolute",
                  right: 4,
                  top: "50%",
                  transform: "translateY(-50%)",
                }}
                onClick={(e) => e.stopPropagation()}
              >
                {isNextUndo && (
                  <Tooltip title={t("edit.undoTooltip")} arrow>
                    <span>
                      <IconButton
                        size="small"
                        onClick={undoLast}
                        disabled={undoing}
                        sx={{ color: theme.palette.warning.main }}
                      >
                        <UndoIcon sx={{ fontSize: 16 }} />
                      </IconButton>
                    </span>
                  </Tooltip>
                )}
                {isNextRedo && canRedo && (
                  <Tooltip title={t("edit.redoTooltip")} arrow>
                    <span>
                      <IconButton
                        size="small"
                        onClick={redoLast}
                        disabled={redoing}
                        sx={{ color: theme.palette.info.main }}
                      >
                        <RedoIcon sx={{ fontSize: 16 }} />
                      </IconButton>
                    </span>
                  </Tooltip>
                )}
                <Tooltip title={t("editHistory.jumpTooltip")} arrow>
                  <span>
                    <IconButton
                      size="small"
                      onClick={(e) => {
                        e.stopPropagation();
                        handleJump();
                      }}
                      sx={{ color: "text.secondary" }}
                    >
                      <SkipNextIcon sx={{ fontSize: 16 }} />
                    </IconButton>
                  </span>
                </Tooltip>
              </Box>
            </ListItemButton>
          );
        })}
      </List>
    </Box>
  );
}

export default EditHistoryPanel;
