/**
 * The History panel: the journal of the project open here (newest first), then the working copy's edits with undo,
 * redo and jump, each with who made it and why, and the NAMED acknowledgement recorded with it (G4), said in the
 * interface's language while the server's English line stays the exact record (`data-describe`, `title`). Outside
 * edit mode the edits are not listed (the working copy is read only); the journal still is.
 */

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
import { useRoute } from "../../utils/routes";
import { useProject } from "../../utils/projectStore";

const ENTITY_COLORS = {
  stop: "warning",
  route: "secondary",
  trip: "success",
  calendar: "primary",
  stop_time: "info",
};

function relativeTime(isoTs, t) {
  if (!isoTs) return "";
  const diff = Math.floor((Date.now() - new Date(isoTs).getTime()) / 1000);
  if (diff < 60) return t("editHistory.justNow");
  if (diff < 3600) return t("editHistory.minutesAgo", { n: Math.floor(diff / 60) });
  if (diff < 86400) return t("editHistory.hoursAgo", { n: Math.floor(diff / 3600) });
  return t("editHistory.daysAgo", { n: Math.floor(diff / 86400) });
}

/** The items of an acknowledgement in words: clauses, sources, assumptions. */
export const acknowledgedWhat = (ack, t) => {
  const items = Array.isArray(ack?.items) ? ack.items : [];
  const clauses = items.filter((i) => i.kind === "clause").map((i) => i.id);
  const sources = items.filter((i) => i.kind === "sources").flatMap((i) => i.operations || []);
  const assumptions = items.filter((i) => i.kind === "assumption").map((i) => i.id);
  return [
    clauses.length ? t("journal.ack.clauses", { ids: clauses.join(", ") }) : null,
    sources.length ? t("journal.ack.sources", { count: sources.length }) : null,
    assumptions.length ? t("journal.ack.assumptions", { ids: assumptions.join(", ") }) : null,
  ]
    .filter(Boolean)
    .join(" · ");
};

const formatWhen = (iso, language) => {
  const d = new Date(iso);
  if (!iso || Number.isNaN(d.getTime())) return "";
  try {
    return new Intl.DateTimeFormat(language || undefined, { dateStyle: "short", timeStyle: "short" }).format(d);
  } catch {
    return d.toISOString().slice(0, 16).replace("T", " ");
  }
};

// The journal's actions and reasons said in words; another one is shown as the server wrote it.
const JOURNAL_ACTIONS = new Set(["created", "network", "document", "contract", "waive", "offer_sheet", "scenario", "built", "applied", "snapshot", "delivered", "undone", "resumed", "restored", "overwrite", "submit", "approve", "reject"]);
const JOURNAL_REASONS = new Set(["manual", "plan", "sql", "working_copy_expired", "version_restore", "autosave_conflict", "acknowledged", "package", "marked", "edits", "idle", "before_expiry"]);
export const journalAction = (action, t) => (JOURNAL_ACTIONS.has(action) ? t(`journal.action.${action}`) : String(action || ""));
export const journalReason = (reason, t) => (!reason ? "" : JOURNAL_REASONS.has(reason) ? t(`journal.reason.${reason}`) : String(reason));

/**
 * The project's journal and its reviews, newest first: [{ at, actor, action, object, reason, comment }]. A review
 * of the approval is a line of its own (submit · approve · reject, its version, its comment).
 */
export const journalOf = (project) => {
  const versions = new Map((project?.versions || []).map((v) => [v.id, v]));
  const lines = (Array.isArray(project?.journal) ? project.journal : []).filter((e) => e && e.action).map((e) => ({ at: e.at, actor: e.actor || null, action: e.action, object: e.object || null, reason: e.reason || null, comment: null }));
  for (const r of Array.isArray(project?.reviews) ? project.reviews : []) {
    const v = versions.get(r.version_id);
    lines.push({ at: r.at, actor: r.by?.name || null, action: r.action, object: v ? `v${v.n}` : null, reason: null, comment: r.comment || null });
  }
  return lines.sort((a, b) => String(b.at || "").localeCompare(String(a.at || "")));
};

/** The project's named journal. */
export function ProjectJournal({ project }) {
  const { t, language } = useLanguage();
  const lines = journalOf(project);
  return (
    <Box data-testid="project-journal" sx={{ mb: 1.5 }}>
      <Typography variant="caption" color="text.secondary" sx={{ px: 1, pb: 0.5, display: "block", textTransform: "uppercase", letterSpacing: "0.06em", fontWeight: 700 }}>
        {t("journal.title")}
      </Typography>
      {lines.length === 0 ? (
        <Typography variant="body2" color="text.secondary" sx={{ px: 1 }}>
          {t("journal.empty")}
        </Typography>
      ) : (
        <Box component="ol" sx={{ m: 0, px: 1, listStyle: "none", display: "flex", flexDirection: "column", gap: 0.5 }}>
          {lines.slice(0, 200).map((e, i) => (
            <Typography component="li" key={`${e.at}-${i}`} data-testid="journal-entry" data-action={e.action} sx={{ fontSize: 12, lineHeight: 1.45 }}>
              <Box component="span" sx={{ color: "text.secondary" }}>
                {formatWhen(e.at, language)}
              </Box>{" "}
              {t("journal.line", { actor: e.actor || t("journal.anonymous"), action: journalAction(e.action, t), object: e.object || "" }).trim()}
              {e.reason ? ` (${journalReason(e.reason, t)})` : ""}
              {e.comment ? ` — « ${e.comment} »` : ""}
            </Typography>
          ))}
        </Box>
      )}
    </Box>
  );
}

/** The History panel: the project's journal (on a project's route), then the working copy's edits. */
function EditHistoryPanel() {
  const route = useRoute();
  const projectId = route?.name === "project" || route?.name === "projectExplorer" ? route.params?.id || null : null;
  const [project] = useProject(projectId);
  return (
    <Box data-testid="journal-panel">
      {project && <ProjectJournal project={project} />}
      <EditLog />
    </Box>
  );
}

/** The edits of the working copy, newest first, with who made them and why. */
function EditLog() {
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
  const { t, language } = useLanguage();

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

  // History comes newest first: the undone tail, then the active entries. Undo targets the first active entry, redo
  // the last undone one.
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
                      {(entry.acknowledgement?.description ? String(entry.description || "").replace(` — ${entry.acknowledgement.description}`, "") : entry.description) || `${entry.action} ${entry.entity_id}`}
                    </Typography>
                    {(entry.actor_name || entry.reason) && (
                      <Typography component="span" variant="caption" data-testid="history-actor" data-reason={entry.reason || ""} sx={{ display: "block", width: "100%", fontSize: 11, lineHeight: 1.4, color: "text.secondary" }}>
                        {t("journal.by", { actor: entry.actor_name || t("journal.anonymous"), reason: journalReason(entry.reason || "manual", t) })}
                      </Typography>
                    )}
                    {entry.acknowledgement && (
                      <Typography
                        component="span"
                        variant="caption"
                        data-testid="history-acknowledgement"
                        data-describe={entry.acknowledgement.description || ""}
                        title={entry.acknowledgement.description || undefined}
                        sx={{ display: "block", width: "100%", fontSize: 11, lineHeight: 1.4, color: "warning.dark" }}
                      >
                        {t("ack.by", { what: acknowledgedWhat(entry.acknowledgement, t), name: entry.acknowledgement.by?.name || "", date: formatWhen(entry.acknowledgement.at, language) })}
                        {entry.acknowledgement.note ? ` — ${t("journal.ack.note", { note: entry.acknowledgement.note })}` : ""}
                      </Typography>
                    )}
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
