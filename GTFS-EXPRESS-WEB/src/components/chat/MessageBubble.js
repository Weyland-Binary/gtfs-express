/**
 * MessageBubble — One conversation turn (user OR assistant) with full
 * inline tooling: SQL accordion, result preview, blocked-state CTA, error
 * surface, regenerate / open-in-console actions.
 *
 * Visual language:
 *  - User: right-aligned, primary-tinted, max-width 85%, plain text.
 *  - Assistant: left-aligned, surface-tinted, max-width 95%, can host
 *    rich children (SqlAccordion, ResultTablePreview).
 *  - Blocked: warning-bordered notice with the draft SQL inline + a
 *    primary CTA to open the SQL Console (mirrors FixInSqlConsoleButton's
 *    edit-mode-aware UX).
 *  - Error: muted, italic, centered.
 *  - Streaming: subtle animated cursor at the end of the live token stream.
 *
 * Footer toolbar (assistant complete only): Open in SQL Console, copy,
 * regenerate. All icon-only with tooltips to keep the bubble light.
 */

import React, { useState } from "react";
import {
  Box,
  IconButton,
  Tooltip,
  Avatar,
  Stack,
  alpha,
  useTheme,
  Snackbar,
  Alert,
} from "@mui/material";
import GTFSAIIcon from "./GTFSAIIcon";
import PersonIcon from "@mui/icons-material/Person";
import ThumbUpOutlinedIcon from "@mui/icons-material/ThumbUpOutlined";
import ThumbDownOutlinedIcon from "@mui/icons-material/ThumbDownOutlined";
import ThumbUpIcon from "@mui/icons-material/ThumbUp";
import ThumbDownIcon from "@mui/icons-material/ThumbDown";
import API_BASE_URL from "../../config";
import { fetchWithSession } from "../../utils/sessionManager";
import OpenInNewIcon from "@mui/icons-material/OpenInNew";
import ContentCopyIcon from "@mui/icons-material/ContentCopy";
import CheckIcon from "@mui/icons-material/Check";
import ReplayIcon from "@mui/icons-material/Replay";
import WarningAmberIcon from "@mui/icons-material/WarningAmber";
import ErrorOutlineIcon from "@mui/icons-material/ErrorOutline";
import { useLanguage } from "../../contexts/LanguageContext";
import { useDetailPanel } from "../../contexts/DetailPanelContext";
import { useEditMode } from "../../contexts/EditModeContext";
import SqlAccordion from "./SqlAccordion";
import ResultTablePreview from "./ResultTablePreview";
import RepairFlow from "./RepairFlow";
import useSmoothText from "./useSmoothText";
import { openInSqlConsole } from "./openInSqlConsole";

const StreamingCursor = () => {
  const theme = useTheme();
  return (
    <Box
      component="span"
      sx={{
        display: "inline-block",
        width: 7,
        height: "0.95em",
        ml: 0.4,
        verticalAlign: "text-bottom",
        background: theme.palette.primary.main,
        borderRadius: 0.5,
        animation: "gtfs-chat-blink 1.05s steps(2, start) infinite",
        "@keyframes gtfs-chat-blink": {
          "0%": { opacity: 1 },
          "50%": { opacity: 0 },
          "100%": { opacity: 1 },
        },
      }}
    />
  );
};

const UserBubble = ({ content }) => {
  const theme = useTheme();
  return (
    <Box
      sx={{
        alignSelf: "flex-end",
        display: "flex",
        gap: 1,
        maxWidth: "88%",
        flexDirection: "row-reverse",
        "@keyframes gtfsBubbleIn": {
          from: { opacity: 0, transform: "translateY(6px)" },
          to: { opacity: 1, transform: "translateY(0)" },
        },
        animation: "gtfsBubbleIn 200ms ease-out",
      }}
    >
      <Avatar
        sx={{
          width: 26,
          height: 26,
          mt: 0.25,
          bgcolor: alpha(theme.palette.primary.main, 0.15),
          color: theme.palette.primary.main,
          flexShrink: 0,
        }}
      >
        <PersonIcon sx={{ fontSize: 16 }} />
      </Avatar>
      <Box
        sx={{
          background: `linear-gradient(135deg, ${theme.palette.primary.main} 0%, ${alpha(theme.palette.primary.dark, 0.95)} 100%)`,
          color: theme.palette.primary.contrastText,
          px: 1.5,
          py: 0.95,
          borderRadius: 2,
          borderTopRightRadius: 0.5,
          fontSize: "0.85rem",
          lineHeight: 1.45,
          whiteSpace: "pre-wrap",
          wordBreak: "break-word",
          boxShadow: `0 1px 3px ${alpha(theme.palette.primary.main, 0.30)}`,
        }}
      >
        {content}
      </Box>
    </Box>
  );
};

const AssistantHeader = () => {
  const theme = useTheme();
  return (
    <Avatar
      sx={{
        width: 26,
        height: 26,
        mt: 0.25,
        background: `linear-gradient(135deg, ${theme.palette.ai.gradientStart} 0%, ${theme.palette.ai.gradientEnd} 100%)`,
        color: theme.palette.ai.contrastText,
        flexShrink: 0,
        boxShadow: `0 2px 6px ${alpha(theme.palette.ai.main, 0.30)}`,
      }}
    >
      <GTFSAIIcon sx={{ fontSize: 15 }} />
    </Avatar>
  );
};

// Latency masking: a "thinking…" pulse shown between the user's send and
// the first streamed token (2-5s on complex questions) — without it the
// empty bubble reads as a hang.
const ThinkingHint = () => {
  const { t } = useLanguage();
  const theme = useTheme();
  return (
    <Box
      data-testid="chat-thinking"
      sx={{
        display: "inline-flex",
        alignItems: "center",
        gap: 0.75,
        fontSize: "0.8rem",
        color: "text.secondary",
        "@keyframes gtfsChatPulse": {
          "0%": { opacity: 0.35 },
          "50%": { opacity: 1 },
          "100%": { opacity: 0.35 },
        },
        animation: "gtfsChatPulse 1.6s ease-in-out infinite",
      }}
    >
      <GTFSAIIcon sx={{ fontSize: 13, color: theme.palette.ai.main }} />
      {t("chat.thinking")}
    </Box>
  );
};

const ProseBlock = ({ text, streaming, muted = false }) => {
  if (!text && !streaming) return null;
  return (
    <Box
      sx={{
        fontSize: "0.85rem",
        lineHeight: 1.5,
        color: muted ? "text.secondary" : "text.primary",
        whiteSpace: "pre-wrap",
        wordBreak: "break-word",
      }}
    >
      {text}
      {streaming && <StreamingCursor />}
    </Box>
  );
};

const BlockedNotice = ({
  blocked,
  onOpen,
  editing,
  onEnterEditMode,
  requestingEditMode,
  repairFlow = null,
  repairApplied = false,
}) => {
  const { t } = useLanguage();
  const theme = useTheme();
  const isMutation = blocked.reason === "mutation_in_read_mode";
  const titleKey = isMutation ? "chat.blocked.mutationTitle" : "chat.blocked.forbiddenTitle";
  // With the guided flow embedded, "open the console and run it yourself"
  // is wrong advice — the flow right below applies it safely. The console
  // stays a review escape hatch only.
  const bodyKey = isMutation
    ? repairFlow
      ? "chat.blocked.mutationBodyGuided"
      : "chat.blocked.mutationBody"
    : "chat.blocked.forbiddenBody";

  return (
    <Box
      sx={{
        mt: 1,
        borderRadius: 1.5,
        overflow: "hidden",
        border: `1px solid ${alpha(theme.palette.warning.main, 0.45)}`,
        background: alpha(theme.palette.warning.main, 0.06),
      }}
    >
      <Box
        sx={{
          px: 1.5,
          py: 1,
          display: "flex",
          alignItems: "flex-start",
          gap: 1,
          borderBottom: `1px solid ${alpha(theme.palette.warning.main, 0.20)}`,
        }}
      >
        <WarningAmberIcon
          sx={{ fontSize: 18, color: theme.palette.warning.dark, mt: 0.1 }}
        />
        <Box sx={{ flex: 1, minWidth: 0 }}>
          <Box
            sx={{
              fontSize: "0.78rem",
              fontWeight: 700,
              color: theme.palette.warning.dark,
              lineHeight: 1.35,
            }}
          >
            {t(titleKey)}
          </Box>
          <Box
            sx={{
              fontSize: "0.74rem",
              color: "text.secondary",
              mt: 0.35,
              lineHeight: 1.5,
            }}
          >
            {t(bodyKey)}
          </Box>
        </Box>
      </Box>
      <Box sx={{ px: 1.25, py: 1, display: "flex", flexDirection: "column", gap: 0.75 }}>
        <SqlAccordion sql={blocked.draftSql} defaultExpanded dense />
        {/* Guided repair loop — preview/apply/revalidate without leaving the
            chat. The console hand-off below stays as the power-user escape
            hatch; the redundant standalone "Enter Edit Mode" button is hidden
            because RepairFlow embeds its own. */}
        {repairFlow}
        {/* Once the draft has been applied through the guided flow, the
            "Open in SQL Console" hand-off disappears: running the same
            statement a second time is never what the user wants (e.g. a
            re-run INSERT INTO feed_info trips the at-most-one-row guard
            and reads like a failure). */}
        {repairApplied ? (
          <Box
            sx={{ fontSize: "0.7rem", color: "text.secondary", mt: 0.25 }}
            data-testid="chat-blocked-applied"
          >
            {t("chat.blocked.alreadyApplied")}
          </Box>
        ) : (
        <Stack direction="row" spacing={0.75} sx={{ mt: 0.25 }}>
          <Box
            component="button"
            type="button"
            onClick={onOpen}
            sx={{
              all: "unset",
              cursor: "pointer",
              fontSize: "0.72rem",
              fontWeight: 700,
              px: 1.1,
              py: 0.5,
              borderRadius: 1,
              background: theme.palette.warning.main,
              color: theme.palette.warning.contrastText,
              display: "inline-flex",
              alignItems: "center",
              gap: 0.4,
              transition: "background 120ms",
              "&:hover": { background: theme.palette.warning.dark },
            }}
          >
            {t("chat.blocked.openConsole")}
            <OpenInNewIcon sx={{ fontSize: 12 }} />
          </Box>
          {isMutation && !editing && onEnterEditMode && !repairFlow && (
            <Box
              component="button"
              type="button"
              disabled={requestingEditMode}
              onClick={onEnterEditMode}
              sx={{
                all: "unset",
                cursor: requestingEditMode ? "wait" : "pointer",
                opacity: requestingEditMode ? 0.6 : 1,
                fontSize: "0.7rem",
                fontWeight: 600,
                px: 1.1,
                py: 0.5,
                borderRadius: 1,
                color: theme.palette.warning.dark,
                border: `1px solid ${alpha(theme.palette.warning.main, 0.55)}`,
                "&:hover": {
                  background: alpha(theme.palette.warning.main, 0.10),
                },
              }}
            >
              {t("chat.blocked.enterEditMode")}
            </Box>
          )}
        </Stack>
        )}
      </Box>
    </Box>
  );
};

const ErrorBlock = ({ message, onRetry }) => {
  const { t } = useLanguage();
  const theme = useTheme();
  return (
    <Box
      sx={{
        mt: 1,
        px: 1.25,
        py: 0.85,
        borderRadius: 1.25,
        background: alpha(theme.palette.error.main, 0.07),
        border: `1px solid ${alpha(theme.palette.error.main, 0.30)}`,
        color: theme.palette.error.dark,
        fontSize: "0.74rem",
        lineHeight: 1.45,
        display: "flex",
        alignItems: "flex-start",
        gap: 0.85,
      }}
    >
      <ErrorOutlineIcon sx={{ fontSize: 15, mt: 0.15, flexShrink: 0 }} />
      <Box sx={{ flex: 1, minWidth: 0 }}>
        <Box sx={{ fontWeight: 700, mb: 0.2 }}>{t("chat.error.title")}</Box>
        <Box sx={{ color: "text.secondary" }}>{message}</Box>
        {onRetry && (
          <Box
            component="button"
            type="button"
            onClick={onRetry}
            data-testid="chat-retry"
            sx={{
              all: "unset",
              cursor: "pointer",
              mt: 0.75,
              display: "inline-flex",
              alignItems: "center",
              gap: 0.4,
              px: 1,
              py: 0.4,
              borderRadius: 1,
              fontSize: "0.72rem",
              fontWeight: 700,
              color: theme.palette.error.dark,
              border: `1px solid ${alpha(theme.palette.error.main, 0.45)}`,
              transition: "background 120ms",
              "&:hover": { background: alpha(theme.palette.error.main, 0.10) },
            }}
          >
            <ReplayIcon sx={{ fontSize: 13 }} />
            {t("chat.action.retry")}
          </Box>
        )}
      </Box>
    </Box>
  );
};

const AssistantBubble = ({
  turn,
  onRegenerate,
  currentErrorCount = null,
  onRepairOutcome = null,
}) => {
  const { t } = useLanguage();
  const theme = useTheme();
  const { showSqlConsole } = useDetailPanel();
  const editModeCtx = useEditMode();
  const editing = Boolean(editModeCtx?.editing);
  const enterEditMode = editModeCtx?.enterEditMode;

  const [copied, setCopied] = useState(false);
  const [snackbar, setSnackbar] = useState(null);
  const [requestingEditMode, setRequestingEditMode] = useState(false);
  const [rated, setRated] = useState(null); // "up" | "down" | null
  // True once the embedded RepairFlow applied the draft (false again after
  // an undo) — drives the console hand-off visibility in BlockedNotice.
  const [repairApplied, setRepairApplied] = useState(false);

  const isStreaming = turn.status === "streaming";
  const isComplete = turn.status === "complete";
  const isBlocked = turn.status === "blocked" && turn.blocked;
  const isError = turn.status === "error";

  const handleOpenInConsole = (sql) => {
    if (!sql) return;
    openInSqlConsole(sql, showSqlConsole);
    setSnackbar({ severity: "success", message: t("chat.toast.openedInConsole") });
  };

  const handleEnterEditMode = async () => {
    if (!enterEditMode || requestingEditMode) return;
    setRequestingEditMode(true);
    try {
      const res = await enterEditMode();
      if (res === true || res?.ok) {
        // After entering edit mode, open the draft SQL in the console.
        if (turn.blocked?.draftSql) {
          openInSqlConsole(turn.blocked.draftSql, showSqlConsole);
        }
      }
    } finally {
      setRequestingEditMode(false);
    }
  };

  const handleCopy = (text) => {
    if (!text) return;
    try {
      navigator.clipboard.writeText(text);
      setCopied(true);
      setTimeout(() => setCopied(false), 1400);
    } catch {
      /* clipboard blocked */
    }
  };

  // Thumbs feedback — optimistic UI, fire-and-forget telemetry. Quota-free
  // server-side; failures are silent (rating must never block the flow).
  const handleRate = (rating) => {
    if (rated) return;
    setRated(rating);
    fetchWithSession(`${API_BASE_URL}/sql/nl2sql-chat/feedback`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ turnId: turn.id, rating }),
    }).catch(() => {});
    setSnackbar({
      severity: "success",
      message: t("chat.action.feedbackThanks"),
    });
  };

  // Combine preamble + summary as the main prose. During streaming we want
  // smooth concat; once complete we keep them separated by a blank line for
  // readability.
  const proseSeparator = isComplete && turn.preamble && turn.summary ? "\n\n" : "";
  const prose = (turn.preamble || "") + proseSeparator + (turn.summary || "");
  // Silky reveal: SSE chunks land bursty — animate the display towards the
  // streamed target (snaps instantly the moment streaming ends).
  const smoothProse = useSmoothText(prose, turn.status === "streaming");

  // Show streaming cursor only on the active phase (no SQL yet OR no
  // summary yet AND a SQL was generated).
  const cursorShouldShow = isStreaming;

  return (
    <Box
      title={
        turn.startedAt
          ? new Date(turn.startedAt).toLocaleTimeString()
          : undefined
      }
      sx={{
        alignSelf: "flex-start",
        display: "flex",
        gap: 1,
        maxWidth: "98%",
        width: "100%",
        "@keyframes gtfsBubbleIn": {
          from: { opacity: 0, transform: "translateY(6px)" },
          to: { opacity: 1, transform: "translateY(0)" },
        },
        animation: "gtfsBubbleIn 200ms ease-out",
      }}
    >
      <AssistantHeader />
      <Box
        sx={{
          flex: 1,
          minWidth: 0,
          background: alpha(theme.palette.background.default, 0.6),
          backgroundImage:
            theme.palette.mode === "dark"
              ? `linear-gradient(180deg, ${alpha("#fff", 0.025)}, ${alpha("#fff", 0.01)})`
              : `linear-gradient(180deg, ${alpha("#000", 0.018)}, ${alpha("#000", 0.005)})`,
          border: `1px solid ${alpha(theme.palette.text.primary, 0.08)}`,
          borderRadius: 2,
          borderTopLeftRadius: 0.5,
          px: 1.5,
          py: 1.1,
        }}
      >
        {/* Pre-first-token latency masking */}
        {isStreaming && !prose && !turn.sql && <ThinkingHint />}

        <ProseBlock
          text={smoothProse}
          streaming={cursorShouldShow && Boolean(smoothProse)}
        />

        {/* SQL is shown as soon as the server emits sql_generated, even
            before execution finishes — gives the user immediate feedback. */}
        {turn.sql && !isBlocked && (
          <SqlAccordion sql={turn.sql} defaultExpanded={false} />
        )}

        {/* Result table — only after sql_result lands. */}
        {turn.result && !isBlocked && (
          <ResultTablePreview
            result={turn.result}
            durationMs={turn.result.durationMs}
            onOpenInConsole={turn.sql ? () => handleOpenInConsole(turn.sql) : null}
          />
        )}

        {isBlocked && (
          <BlockedNotice
            blocked={turn.blocked}
            onOpen={() => handleOpenInConsole(turn.blocked.draftSql)}
            editing={editing}
            onEnterEditMode={turn.blocked.reason === "mutation_in_read_mode" ? handleEnterEditMode : null}
            requestingEditMode={requestingEditMode}
            repairApplied={repairApplied}
            repairFlow={
              turn.blocked.reason === "mutation_in_read_mode" &&
              turn.blocked.draftSql ? (
                <RepairFlow
                  draftSql={turn.blocked.draftSql}
                  currentErrorCount={currentErrorCount}
                  onApplied={setRepairApplied}
                  onOutcome={
                    onRepairOutcome
                      ? (summary) => onRepairOutcome(turn.id, summary)
                      : null
                  }
                />
              ) : null
            }
          />
        )}

        {isError && turn.error && (
          <ErrorBlock
            message={turn.error.message}
            onRetry={onRegenerate || null}
          />
        )}

        {/* Action footer — only when the turn is fully done. */}
        {(isComplete || isBlocked || isError) && turn.sql && !isError && (
          <Stack direction="row" spacing={0.5} sx={{ mt: 0.85, justifyContent: "flex-end" }}>
            {turn.sql && (
              <>
                <Tooltip title={t("chat.action.openInConsole")}>
                  <IconButton
                    size="small"
                    onClick={() => handleOpenInConsole(turn.sql)}
                    sx={{ width: 24, height: 24 }}
                  >
                    <OpenInNewIcon sx={{ fontSize: 13 }} />
                  </IconButton>
                </Tooltip>
                <Tooltip title={copied ? t("chat.sql.copied") : t("chat.action.copySql")}>
                  <IconButton
                    size="small"
                    onClick={() => handleCopy(turn.sql)}
                    sx={{ width: 24, height: 24 }}
                  >
                    {copied ? (
                      <CheckIcon sx={{ fontSize: 13, color: "success.main" }} />
                    ) : (
                      <ContentCopyIcon sx={{ fontSize: 13 }} />
                    )}
                  </IconButton>
                </Tooltip>
              </>
            )}
            {onRegenerate && (
              <Tooltip title={t("chat.action.regenerate")}>
                <IconButton
                  size="small"
                  onClick={onRegenerate}
                  sx={{ width: 24, height: 24 }}
                >
                  <ReplayIcon sx={{ fontSize: 13 }} />
                </IconButton>
              </Tooltip>
            )}
            {isComplete && (
              <>
                <Tooltip title={t("chat.action.thumbsUp")}>
                  <span>
                    <IconButton
                      size="small"
                      onClick={() => handleRate("up")}
                      disabled={Boolean(rated)}
                      data-testid="chat-thumb-up"
                      sx={{ width: 24, height: 24 }}
                    >
                      {rated === "up" ? (
                        <ThumbUpIcon
                          sx={{ fontSize: 12, color: "success.main" }}
                        />
                      ) : (
                        <ThumbUpOutlinedIcon sx={{ fontSize: 12 }} />
                      )}
                    </IconButton>
                  </span>
                </Tooltip>
                <Tooltip title={t("chat.action.thumbsDown")}>
                  <span>
                    <IconButton
                      size="small"
                      onClick={() => handleRate("down")}
                      disabled={Boolean(rated)}
                      data-testid="chat-thumb-down"
                      sx={{ width: 24, height: 24 }}
                    >
                      {rated === "down" ? (
                        <ThumbDownIcon
                          sx={{ fontSize: 12, color: "error.main" }}
                        />
                      ) : (
                        <ThumbDownOutlinedIcon sx={{ fontSize: 12 }} />
                      )}
                    </IconButton>
                  </span>
                </Tooltip>
              </>
            )}
          </Stack>
        )}
      </Box>
      <Snackbar
        open={Boolean(snackbar)}
        autoHideDuration={2200}
        onClose={() => setSnackbar(null)}
        anchorOrigin={{ vertical: "bottom", horizontal: "center" }}
      >
        {snackbar ? (
          <Alert
            severity={snackbar.severity || "info"}
            onClose={() => setSnackbar(null)}
            variant="filled"
            sx={{ alignItems: "center" }}
          >
            {snackbar.message}
          </Alert>
        ) : (
          <span />
        )}
      </Snackbar>
    </Box>
  );
};

export default function MessageBubble({
  turn,
  onRegenerate,
  currentErrorCount = null,
  onRepairOutcome = null,
}) {
  if (turn.role === "user") {
    return <UserBubble content={turn.content} />;
  }
  return (
    <AssistantBubble
      turn={turn}
      onRegenerate={onRegenerate}
      currentErrorCount={currentErrorCount}
      onRepairOutcome={onRepairOutcome}
    />
  );
}
