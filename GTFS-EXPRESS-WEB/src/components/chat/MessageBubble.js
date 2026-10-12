/**
 * MessageBubble — One conversation turn (user OR assistant).
 *
 * Assistant turns compose, top to bottom:
 *  - the activity timeline (queries run, views opened, tool in progress),
 *  - charts the assistant drew,
 *  - the answer (markdown, streamed with a smooth reveal),
 *  - fix proposals (guided repair cards),
 *  - an error block when the turn failed,
 *  - follow-up question chips (last turn only),
 *  - a footer toolbar: copy answer, regenerate, thumbs.
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
import AttachFileIcon from "@mui/icons-material/AttachFile";
import ThumbUpOutlinedIcon from "@mui/icons-material/ThumbUpOutlined";
import ThumbDownOutlinedIcon from "@mui/icons-material/ThumbDownOutlined";
import ThumbUpIcon from "@mui/icons-material/ThumbUp";
import ThumbDownIcon from "@mui/icons-material/ThumbDown";
import ContentCopyIcon from "@mui/icons-material/ContentCopy";
import CheckIcon from "@mui/icons-material/Check";
import ReplayIcon from "@mui/icons-material/Replay";
import ErrorOutlineIcon from "@mui/icons-material/ErrorOutline";
import ArrowForwardIcon from "@mui/icons-material/ArrowForward";
import API_BASE_URL from "../../config";
import { fetchWithSession } from "../../utils/sessionManager";
import { useLanguage } from "../../contexts/LanguageContext";
import { useDetailPanel } from "../../contexts/DetailPanelContext";
import useSmoothText from "./useSmoothText";
import { openInSqlConsole } from "./openInSqlConsole";
import MarkdownText from "./MarkdownText";
import ActivityTimeline from "./ActivityTimeline";
import ProposalCard from "./ProposalCard";
import OperationProposalCard from "./OperationProposalCard";
import RepairPlanBar from "./RepairPlanBar";
import MiniChart from "./MiniChart";
import JourneyCard from "./JourneyCard";

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

const UserBubble = ({ content, attachment = null }) => {
  const theme = useTheme();
  const { t } = useLanguage();
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
          boxShadow: `0 1px 3px ${alpha(theme.palette.primary.main, 0.3)}`,
        }}
      >
        {attachment && (
          <Box
            sx={{
              display: "flex",
              alignItems: "center",
              gap: 0.5,
              mb: 0.6,
              px: 0.75,
              py: 0.35,
              borderRadius: 1,
              fontSize: "0.7rem",
              fontWeight: 600,
              background: alpha(theme.palette.primary.contrastText, 0.16),
            }}
          >
            <AttachFileIcon sx={{ fontSize: 13, flexShrink: 0 }} />
            <Box component="span" sx={{ overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
              {attachment.filename} · {t("chat.attach.chipRows", { count: attachment.rowCount })}
            </Box>
          </Box>
        )}
        {content}
      </Box>
    </Box>
  );
};

const AssistantAvatar = () => {
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
        boxShadow: `0 2px 6px ${alpha(theme.palette.ai.main, 0.3)}`,
      }}
    >
      <GTFSAIIcon sx={{ fontSize: 15 }} />
    </Avatar>
  );
};

// Latency masking between the send and the first event.
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
        border: `1px solid ${alpha(theme.palette.error.main, 0.3)}`,
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
              "&:hover": { background: alpha(theme.palette.error.main, 0.1) },
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

const FollowupChips = ({ items, onPick }) => {
  const theme = useTheme();
  return (
    <Box sx={{ display: "flex", flexWrap: "wrap", gap: 0.6, mt: 1 }} data-testid="chat-followups">
      {items.map((q, i) => (
        <Box
          key={i}
          component="button"
          type="button"
          onClick={() => onPick(q)}
          sx={{
            all: "unset",
            cursor: "pointer",
            display: "inline-flex",
            alignItems: "center",
            gap: 0.5,
            px: 1.1,
            py: 0.5,
            borderRadius: 99,
            fontSize: "0.74rem",
            fontWeight: 600,
            color: theme.palette.ai.dark,
            background: alpha(theme.palette.ai.main, 0.08),
            border: `1px solid ${alpha(theme.palette.ai.main, 0.3)}`,
            transition: "all 120ms",
            "&:hover": {
              background: alpha(theme.palette.ai.main, 0.16),
              borderColor: theme.palette.ai.main,
            },
          }}
        >
          {q}
          <ArrowForwardIcon sx={{ fontSize: 12, opacity: 0.7 }} />
        </Box>
      ))}
    </Box>
  );
};

const AssistantBubble = ({
  turn,
  onRegenerate,
  currentErrorCount = null,
  onProposalOutcome = null,
  onBatchApplied = null,
  onPickFollowup = null,
  onReplayAction = null,
  showFollowups = false,
}) => {
  const { t } = useLanguage();
  const theme = useTheme();
  const { showSqlConsole } = useDetailPanel();

  const [copied, setCopied] = useState(false);
  const [snackbar, setSnackbar] = useState(null);
  const [rated, setRated] = useState(null); // "up" | "down" | null

  const isStreaming = turn.status === "streaming";
  const isComplete = turn.status === "complete";
  const isError = turn.status === "error";
  const steps = turn.steps || [];
  const proposals = turn.proposals || [];
  const charts = turn.charts || [];
  const journeys = turn.journeys || [];
  const uiActions = turn.uiActions || [];

  const handleOpenInConsole = (sql) => {
    if (!sql) return;
    openInSqlConsole(sql, showSqlConsole);
    setSnackbar({ severity: "success", message: t("chat.toast.openedInConsole") });
  };

  const handleCopy = () => {
    if (!turn.content) return;
    try {
      navigator.clipboard.writeText(turn.content);
      setCopied(true);
      setTimeout(() => setCopied(false), 1400);
    } catch {
      /* clipboard blocked */
    }
  };

  // Thumbs feedback — optimistic UI, fire-and-forget telemetry.
  const handleRate = (rating) => {
    if (rated) return;
    setRated(rating);
    fetchWithSession(`${API_BASE_URL}/sql/nl2sql-chat/feedback`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ turnId: turn.id, rating }),
    }).catch(() => {});
    setSnackbar({ severity: "success", message: t("chat.action.feedbackThanks") });
  };

  // Silky reveal: SSE chunks land bursty — animate the display towards the
  // streamed target (snaps instantly the moment streaming ends).
  const smoothAnswer = useSmoothText(turn.content || "", isStreaming);
  const nothingYet = isStreaming && !smoothAnswer && steps.length === 0 && !turn.pendingTool && charts.length === 0;

  return (
    <Box
      title={turn.startedAt ? new Date(turn.startedAt).toLocaleTimeString() : undefined}
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
      <AssistantAvatar />
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
        {nothingYet && <ThinkingHint />}

        <ActivityTimeline
          steps={steps}
          uiActions={uiActions}
          pendingTool={turn.pendingTool}
          streaming={isStreaming}
          onOpenInConsole={handleOpenInConsole}
          onReplayAction={onReplayAction}
        />

        {charts.map((c) => (
          <MiniChart key={c.chartId} chart={c} />
        ))}
        {journeys.map((j) => (
          <JourneyCard key={j.journeyId} journey={j} />
        ))}

        {(smoothAnswer || (isStreaming && !nothingYet && steps.length === 0)) && (
          <Box sx={{ mt: steps.length || charts.length ? 0.75 : 0 }} data-testid="chat-answer">
            <MarkdownText text={smoothAnswer}>
              {isStreaming && smoothAnswer ? <StreamingCursor /> : null}
            </MarkdownText>
          </Box>
        )}

        {isComplete && (
          <RepairPlanBar
            proposals={proposals.filter((p) => p.kind !== "operation")}
            batchState={turn.batchResults || null}
            currentErrorCount={currentErrorCount}
            onBatchApplied={onBatchApplied ? (results, summary) => onBatchApplied(turn.id, results, summary) : null}
          />
        )}
        {proposals.map((p, i) =>
          p.kind === "operation" ? (
            <OperationProposalCard
              key={p.proposalId}
              proposal={p}
              index={proposals.length > 1 ? i : null}
              onOutcome={onProposalOutcome ? (summary) => onProposalOutcome(turn.id, p.proposalId, summary) : null}
            />
          ) : (
            <ProposalCard
              key={p.proposalId}
              proposal={p}
              index={proposals.length > 1 ? i : null}
              currentErrorCount={currentErrorCount}
              batchResult={turn.batchResults ? turn.batchResults[p.proposalId] || null : null}
              onOutcome={onProposalOutcome ? (summary) => onProposalOutcome(turn.id, p.proposalId, summary) : null}
            />
          ),
        )}

        {isError && turn.error && <ErrorBlock message={turn.error.message} onRetry={onRegenerate || null} />}
        {turn.status === "aborted" && (
          <Box sx={{ mt: 0.75, fontSize: "0.72rem", color: "text.disabled", fontStyle: "italic" }}>
            {t("chat.error.aborted")}
          </Box>
        )}

        {showFollowups && isComplete && Array.isArray(turn.followups) && turn.followups.length > 0 && onPickFollowup && (
          <FollowupChips items={turn.followups} onPick={onPickFollowup} />
        )}

        {/* Action footer — only when the turn is fully done. */}
        {(isComplete || isError) && (
          <Stack direction="row" spacing={0.5} sx={{ mt: 0.85, justifyContent: "flex-end" }}>
            {turn.content && (
              <Tooltip title={copied ? t("chat.sql.copied") : t("chat.action.copyAnswer")}>
                <IconButton size="small" onClick={handleCopy} sx={{ width: 24, height: 24 }}>
                  {copied ? <CheckIcon sx={{ fontSize: 13, color: "success.main" }} /> : <ContentCopyIcon sx={{ fontSize: 13 }} />}
                </IconButton>
              </Tooltip>
            )}
            {onRegenerate && (
              <Tooltip title={t("chat.action.regenerate")}>
                <IconButton size="small" onClick={onRegenerate} sx={{ width: 24, height: 24 }} data-testid="chat-regenerate">
                  <ReplayIcon sx={{ fontSize: 13 }} />
                </IconButton>
              </Tooltip>
            )}
            {isComplete && (
              <>
                <Tooltip title={t("chat.action.thumbsUp")}>
                  <span>
                    <IconButton size="small" onClick={() => handleRate("up")} disabled={Boolean(rated)} data-testid="chat-thumb-up" sx={{ width: 24, height: 24 }}>
                      {rated === "up" ? <ThumbUpIcon sx={{ fontSize: 12, color: "success.main" }} /> : <ThumbUpOutlinedIcon sx={{ fontSize: 12 }} />}
                    </IconButton>
                  </span>
                </Tooltip>
                <Tooltip title={t("chat.action.thumbsDown")}>
                  <span>
                    <IconButton size="small" onClick={() => handleRate("down")} disabled={Boolean(rated)} data-testid="chat-thumb-down" sx={{ width: 24, height: 24 }}>
                      {rated === "down" ? <ThumbDownIcon sx={{ fontSize: 12, color: "error.main" }} /> : <ThumbDownOutlinedIcon sx={{ fontSize: 12 }} />}
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
          <Alert severity={snackbar.severity || "info"} onClose={() => setSnackbar(null)} variant="filled" sx={{ alignItems: "center" }}>
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
  onProposalOutcome = null,
  onBatchApplied = null,
  onPickFollowup = null,
  onReplayAction = null,
  showFollowups = false,
}) {
  if (turn.role === "user") {
    return <UserBubble content={turn.content} attachment={turn.attachment} />;
  }
  return (
    <AssistantBubble
      turn={turn}
      onRegenerate={onRegenerate}
      currentErrorCount={currentErrorCount}
      onProposalOutcome={onProposalOutcome}
      onBatchApplied={onBatchApplied}
      onPickFollowup={onPickFollowup}
      onReplayAction={onReplayAction}
      showFollowups={showFollowups}
    />
  );
}
