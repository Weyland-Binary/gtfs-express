/**
 * ChatDrawer — Side panel hosting the chat assistant.
 *
 * Responsibilities:
 *  - Owns conversation state (via useChatHistory)
 *  - Drives the SSE stream (via streamChat) and maps its events onto the
 *    turn: tool activity, results, proposals, charts, the markdown answer,
 *    follow-up questions
 *  - Performs the assistant's navigation requests in the app (detail
 *    panel, schedule & map, validation report, SQL console, shape studio)
 *  - Surfaces 403 → BetaGateDialog with auto-retry on success
 *  - Manages AbortController for the active stream
 *
 * Layout: a docked, non-modal panel on the left (next to the assistant
 * button) so the app stays usable while chatting — the assistant opens
 * routes and stops on the right side. Full-screen bottom sheet on phones.
 */

import React, {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import {
  Drawer,
  SwipeableDrawer,
  Box,
  IconButton,
  Tooltip,
  Chip,
  Dialog,
  DialogTitle,
  DialogContent,
  DialogActions,
  Button,
  Snackbar,
  Alert,
  alpha,
  useTheme,
  useMediaQuery,
} from "@mui/material";
import CloseIcon from "@mui/icons-material/Close";
import RestartAltIcon from "@mui/icons-material/RestartAlt";
import ContentCopyIcon from "@mui/icons-material/ContentCopy";
import CheckIcon from "@mui/icons-material/Check";
import VerifiedUserOutlinedIcon from "@mui/icons-material/VerifiedUserOutlined";
import CloudOffIcon from "@mui/icons-material/CloudOff";
import OpenInFullIcon from "@mui/icons-material/OpenInFull";
import CloseFullscreenIcon from "@mui/icons-material/CloseFullscreen";
import GTFSAIIcon from "./GTFSAIIcon";
import { useLanguage } from "../../contexts/LanguageContext";
import { useDetailPanel } from "../../contexts/DetailPanelContext";
import useChatHistory, { turnsToWireMessages, newChatId } from "./useChatHistory";
import { streamChat } from "../../utils/chatStream";
import {
  uploadChatAttachment,
  deleteChatAttachment,
  MAX_ATTACHMENT_BYTES,
  MAX_ATTACHMENT_MB,
  MAX_ATTACHMENT_COLS,
  ACCEPTED_EXTENSIONS,
} from "../../utils/chatAttachment";
import ChatHistoryList from "./ChatHistoryList";
import ChatInputBar from "./ChatInputBar";
import UpsellPanel from "./UpsellPanel";
import BetaGateDialog, {
  BETA_CODE_STORAGE_KEY,
} from "../edit/BetaGateDialog";

const WIDTH_NORMAL = "min(520px, 100vw)";
const WIDTH_WIDE = "min(50vw, 100vw)";
const WIDTH_KEY = "gtfs.chat.wide";

const isBetaError = (code) =>
  code === "INVALID_BETA_CODE" ||
  code === "BETA_REVOKED" ||
  code === "BETA_CODE_REQUIRED" ||
  code === "BETA_CONFIG_ERROR";

// Custom event the app shell listens to for view-level navigation requested
// by the assistant (schedule & map of a route, shape studio, home).
export const NAVIGATE_EVENT = "gtfs:navigate";

export default function ChatDrawer({
  open,
  onClose,
  feedLoaded,
  feedEpoch,
  features,
  language,
  sessionContext = null,
  prefillMessage = null,
  onPrefillConsumed = null,
}) {
  const { t } = useLanguage();
  const theme = useTheme();
  const isMobile = useMediaQuery(theme.breakpoints.down("sm"));
  const { openPanel, showSqlConsole } = useDetailPanel();

  const {
    conversationId,
    turns,
    appendUser,
    appendAssistant,
    updateTurn,
    removeTurn,
    reset,
  } = useChatHistory();

  const [draft, setDraft] = useState("");
  const [streaming, setStreaming] = useState(false);
  const [confirmReset, setConfirmReset] = useState(false);
  const [betaGate, setBetaGate] = useState(null);
  const [freeRemaining, setFreeRemaining] = useState(null);
  const [upsell, setUpsell] = useState(false);
  const [attachment, setAttachment] = useState(null);
  const [attachmentUploading, setAttachmentUploading] = useState(null);
  const [attachmentError, setAttachmentError] = useState(null);
  const [wide, setWide] = useState(() => {
    try {
      return localStorage.getItem(WIDTH_KEY) === "1";
    } catch {
      return false;
    }
  });
  const [navToast, setNavToast] = useState(null);

  const pendingRetryRef = useRef(null);
  const abortRef = useRef(null);
  const feedEpochRef = useRef(feedEpoch);

  // Reset conversation history when a new feed is loaded.
  useEffect(() => {
    if (feedEpoch === feedEpochRef.current) return;
    feedEpochRef.current = feedEpoch;
    if (abortRef.current) {
      abortRef.current.abort();
      abortRef.current = null;
      setStreaming(false);
    }
    setAttachment(null);
    setAttachmentUploading(null);
    reset();
  }, [feedEpoch, reset]);

  useEffect(() => {
    if (!open && abortRef.current) {
      abortRef.current.abort();
      abortRef.current = null;
      setStreaming(false);
    }
  }, [open]);

  const toggleWide = useCallback(() => {
    setWide((w) => {
      try {
        localStorage.setItem(WIDTH_KEY, w ? "0" : "1");
      } catch {
        /* storage disabled */
      }
      return !w;
    });
  }, []);

  // ── Navigation requested by the assistant ───────────────────────────
  const performUiAction = useCallback(
    (action) => {
      if (!action || typeof action !== "object") return;
      const dispatch = (detail) =>
        window.dispatchEvent(new CustomEvent(NAVIGATE_EVENT, { detail }));
      switch (action.target) {
        case "route":
          dispatch({ target: "schedule", routeId: action.id, agencyId: action.agencyId || null });
          openPanel("route", action.id);
          break;
        case "stop":
        case "trip":
        case "shape":
          openPanel(action.target, action.id);
          break;
        case "validation":
          window.dispatchEvent(new CustomEvent("gtfs:review-errors"));
          break;
        case "sql_console":
          window.dispatchEvent(new CustomEvent("gtfs:close-validation-report"));
          showSqlConsole();
          break;
        case "schedule":
        case "shape_studio":
        case "home":
          dispatch({
            target: action.target,
            routeId: action.routeId || null,
            agencyId: action.agencyId || null,
          });
          break;
        default:
          return;
      }
      if (action.label) setNavToast(t("chat.activity.opened", { label: action.label }));
    },
    [openPanel, showSqlConsole, t],
  );

  const sendTurn = useCallback(
    async ({ userMessage, regenerateOf = null, retryOf = null }) => {
      if (streaming) return;

      let userTurnId = null;
      let assistantTurnId = null;

      if (regenerateOf) {
        const idx = turns.findIndex((tt) => tt.id === regenerateOf);
        if (idx <= 0) return;
        const prevUser = turns[idx - 1];
        if (prevUser.role !== "user") return;
        userMessage = prevUser.content;
        userTurnId = prevUser.id;
        removeTurn(regenerateOf);
      } else if (retryOf) {
        userMessage = retryOf.userMessage;
        userTurnId = retryOf.userTurnId;
        if (retryOf.assistantTurnId) removeTurn(retryOf.assistantTurnId);
      } else {
        const userTurn = appendUser(
          userMessage,
          attachment
            ? {
                attachment: {
                  table: attachment.table,
                  filename: attachment.filename,
                  rowCount: attachment.rowCount,
                },
              }
            : {},
        );
        userTurnId = userTurn.id;
      }

      const assistantTurn = appendAssistant({});
      assistantTurnId = assistantTurn.id;

      const turnId = newChatId();
      const wireMessages = turnsToWireMessages(
        regenerateOf
          ? turns.filter((tt) => tt.id !== regenerateOf)
          : retryOf
            ? turns.filter((tt) => tt.id !== retryOf.assistantTurnId)
            : [...turns, { role: "user", content: userMessage }],
      );

      const abort = new AbortController();
      abortRef.current = abort;
      setStreaming(true);
      if (!regenerateOf && !retryOf) setDraft("");

      const patchStep = (stepId, patch) =>
        updateTurn(assistantTurnId, (prev) => ({
          steps: (prev.steps || []).map((s) => (s.stepId === stepId ? { ...s, ...patch } : s)),
        }));

      try {
        await streamChat({
          messages: wireMessages,
          userMessage,
          language,
          sessionContext,
          attachments: attachment ? [{ table: attachment.table }] : [],
          conversationId,
          turnId,
          signal: abort.signal,
          onEvent: (event, data) => {
            switch (event) {
              case "meta":
                updateTurn(assistantTurnId, { model: data.model });
                setFreeRemaining(typeof data.freeRemaining === "number" ? data.freeRemaining : null);
                break;
              case "tool_pending":
                updateTurn(assistantTurnId, { pendingTool: data.name || null });
                break;
              case "step_start":
                updateTurn(assistantTurnId, (prev) => ({
                  pendingTool: null,
                  steps: [
                    ...(prev.steps || []),
                    { stepId: data.stepId, kind: data.kind, sql: data.sql, purpose: data.purpose || "", status: "running" },
                  ],
                }));
                break;
              case "step_result":
                patchStep(data.stepId, {
                  status: data.error ? "error" : "done",
                  error: data.error || null,
                  rowCount: data.rowCount,
                  columns: data.columns || [],
                  rowsPreview: data.rowsPreview || [],
                  truncated: Boolean(data.truncated),
                  durationMs: data.durationMs,
                });
                break;
              case "proposal":
                updateTurn(assistantTurnId, (prev) => ({
                  pendingTool: null,
                  proposals: [
                    ...(prev.proposals || []),
                    {
                      proposalId: data.proposalId,
                      kind: data.kind === "operation" ? "operation" : "sql",
                      operation: data.operation || null,
                      params: data.params || null,
                      title: data.title,
                      rationale: data.rationale || "",
                      sql: data.sql || "",
                      preview: data.preview || null,
                    },
                  ],
                }));
                break;
              case "ui_action":
                updateTurn(assistantTurnId, (prev) => ({
                  pendingTool: null,
                  uiActions: [...(prev.uiActions || []), data],
                }));
                performUiAction(data);
                break;
              case "chart":
                updateTurn(assistantTurnId, (prev) => ({
                  pendingTool: null,
                  charts: [...(prev.charts || []), data],
                }));
                break;
              case "token":
                updateTurn(assistantTurnId, (prev) => ({
                  pendingTool: null,
                  content: (prev.content || "") + (data.text || ""),
                }));
                break;
              case "followups":
                updateTurn(assistantTurnId, { followups: Array.isArray(data.items) ? data.items : [] });
                break;
              case "error":
                updateTurn(assistantTurnId, {
                  status: "error",
                  pendingTool: null,
                  error: { message: data.message, code: data.code },
                });
                break;
              case "done":
                updateTurn(assistantTurnId, (prev) => ({
                  pendingTool: null,
                  status: prev.status === "error" ? prev.status : "complete",
                }));
                break;
              default:
                break;
            }
          },
        });
      } catch (err) {
        if (err.code === "ABORTED") {
          updateTurn(assistantTurnId, (prev) => ({
            pendingTool: null,
            status: prev.status === "complete" ? "complete" : "aborted",
          }));
        } else if (err.code === "FREE_QUOTA_EXHAUSTED") {
          removeTurn(assistantTurnId);
          pendingRetryRef.current = { userMessage, userTurnId, assistantTurnId: null };
          setFreeRemaining(0);
          setUpsell(true);
        } else if (isBetaError(err.code)) {
          pendingRetryRef.current = { userMessage, userTurnId, assistantTurnId };
          updateTurn(assistantTurnId, {
            status: "error",
            error: { message: err.message || t("chat.error.betaRequired"), code: err.code },
          });
          setBetaGate({ initialError: { code: err.code, message: err.message } });
        } else if (
          err.code === "RATE_LIMITED" ||
          err.code === "DAILY_LIMIT_REACHED" ||
          err.code === "BUDGET_EXHAUSTED"
        ) {
          const messageByCode = {
            RATE_LIMITED: t("nl2sql.error.rateLimited"),
            DAILY_LIMIT_REACHED: t("nl2sql.error.dailyLimit"),
            BUDGET_EXHAUSTED: t("nl2sql.error.budgetExhausted"),
          };
          updateTurn(assistantTurnId, {
            status: "error",
            error: { message: messageByCode[err.code] || err.message, code: err.code },
          });
        } else if (err.code === "ATTACHMENT_NOT_FOUND") {
          setAttachment(null);
          updateTurn(assistantTurnId, {
            status: "error",
            error: { message: t("chat.attach.error.gone"), code: err.code },
          });
        } else if (err.code === "NL2SQL_CHAT_DISABLED" || err.code === "HTTP_503") {
          updateTurn(assistantTurnId, {
            status: "error",
            error: { message: err.message || t("chat.error.disabled"), code: err.code },
          });
        } else {
          updateTurn(assistantTurnId, {
            status: "error",
            error: { message: err.message || t("chat.error.generic"), code: err.code },
          });
        }
      } finally {
        if (abortRef.current === abort) abortRef.current = null;
        setStreaming(false);
      }
    },
    [
      streaming,
      turns,
      appendUser,
      appendAssistant,
      updateTurn,
      removeTurn,
      conversationId,
      language,
      sessionContext,
      attachment,
      performUiAction,
      t,
    ],
  );

  // Auto-send a message handed off by another surface (e.g. "Ask AI" on a
  // validation finding). Consumed exactly once per hand-off.
  useEffect(() => {
    if (!open || !prefillMessage || streaming) return;
    const msg = String(prefillMessage).trim().slice(0, 2000);
    if (onPrefillConsumed) onPrefillConsumed();
    if (msg.length >= 2) sendTurn({ userMessage: msg });
  }, [open, prefillMessage, streaming, sendTurn, onPrefillConsumed]);

  const handleSend = useCallback(() => {
    const trimmed = draft.trim();
    if (trimmed.length < 2 || trimmed.length > 2000 || streaming) return;
    sendTurn({ userMessage: trimmed });
  }, [draft, streaming, sendTurn]);

  const handleStop = useCallback(() => {
    if (abortRef.current) abortRef.current.abort();
  }, []);

  const attachErrorMessage = useCallback(
    (err) => {
      const byCode = {
        ATTACHMENT_TOO_LARGE: t("chat.attach.error.tooLarge", { max: MAX_ATTACHMENT_MB }),
        UNSUPPORTED_FORMAT: t("chat.attach.error.format"),
        ATTACHMENT_EMPTY: t("chat.attach.error.empty"),
        ATTACHMENT_TOO_MANY_COLUMNS: t("chat.attach.error.columns", { max: MAX_ATTACHMENT_COLS }),
        ATTACHMENT_LIMIT_REACHED: t("chat.attach.error.limit"),
        ATTACHMENT_NOT_FOUND: t("chat.attach.error.gone"),
      };
      return byCode[err.code] || err.message || t("chat.attach.error.generic");
    },
    [t],
  );

  const handleAttachFile = useCallback(
    async (file) => {
      if (attachmentUploading || attachment) return;
      const ext = (file.name.match(/\.[^.]+$/) || [""])[0].toLowerCase();
      if (!ACCEPTED_EXTENSIONS.split(",").includes(ext)) {
        setAttachmentError(t("chat.attach.error.format"));
        return;
      }
      if (file.size > MAX_ATTACHMENT_BYTES) {
        setAttachmentError(t("chat.attach.error.tooLarge", { max: MAX_ATTACHMENT_MB }));
        return;
      }
      setAttachmentUploading(file);
      try {
        const meta = await uploadChatAttachment(file);
        setAttachment(meta);
      } catch (err) {
        setAttachmentError(attachErrorMessage(err));
      } finally {
        setAttachmentUploading(null);
      }
    },
    [attachment, attachmentUploading, attachErrorMessage, t],
  );

  const handleRemoveAttachment = useCallback(() => {
    if (!attachment) return;
    const { table } = attachment;
    setAttachment(null);
    deleteChatAttachment(table).catch(() => {});
  }, [attachment]);

  const handleRegenerate = useCallback(
    (assistantTurnId) => sendTurn({ userMessage: "", regenerateOf: assistantTurnId }),
    [sendTurn],
  );

  const handlePickExample = useCallback(
    (example) => {
      if (!streaming) sendTurn({ userMessage: example });
    },
    [streaming, sendTurn],
  );

  // Copy the whole conversation as markdown (Q/A + the queries run).
  const [conversationCopied, setConversationCopied] = useState(false);
  const handleCopyConversation = useCallback(() => {
    const parts = [];
    for (const turn of turns) {
      if (turn.role === "user") {
        parts.push(`**Q:** ${turn.content}`);
      } else {
        if (turn.content) parts.push(`**A:** ${turn.content}`);
        for (const s of turn.steps || []) {
          if (s.kind === "sql" && s.sql) {
            parts.push("```sql\n" + s.sql + "\n```");
            if (typeof s.rowCount === "number") parts.push(`_${s.rowCount} row(s)._`);
          }
        }
        for (const p of turn.proposals || []) {
          parts.push(`**Fix — ${p.title}**\n\`\`\`sql\n${p.sql}\n\`\`\`${p.outcome ? `\n_${p.outcome}_` : ""}`);
        }
      }
    }
    try {
      navigator.clipboard.writeText(parts.join("\n\n"));
      setConversationCopied(true);
      setTimeout(() => setConversationCopied(false), 1600);
    } catch {
      /* clipboard blocked */
    }
  }, [turns]);

  // Contextual quick-starts: the top validation findings become one-click
  // "fix this" suggestions in the empty state.
  const suggestions = useMemo(() => {
    const rules = sessionContext?.validation?.topRules || [];
    return rules.slice(0, 3).map((r) => ({
      label: t("chat.empty.fixChip", { code: r.code, count: r.count }),
      message: t("chat.empty.fixMessage", { code: r.code, count: r.count }),
    }));
  }, [sessionContext, t]);

  const handlePickSuggestion = useCallback(
    (message) => {
      if (!streaming) sendTurn({ userMessage: message });
    },
    [streaming, sendTurn],
  );

  // Outcome of a guided repair (applied / undone): stored on the proposal
  // so the next turn's history tells the model what actually happened.
  const handleProposalOutcome = useCallback(
    (turnId, proposalId, summary) => {
      updateTurn(turnId, (prev) => ({
        proposals: (prev.proposals || []).map((p) =>
          p.proposalId === proposalId ? { ...p, outcome: summary } : p,
        ),
      }));
    },
    [updateTurn],
  );

  // The repair plan applied several proposals at once: store each result
  // on the turn and tell the model what happened.
  const handleBatchApplied = useCallback(
    (turnId, results, summary) => {
      updateTurn(turnId, (prev) => ({
        batchResults: { ...(prev.batchResults || {}), ...results },
        proposals: (prev.proposals || []).map((p) =>
          results[p.proposalId]
            ? {
                ...p,
                outcome: results[p.proposalId].ok
                  ? `applied in bulk (${results[p.proposalId].affected} row(s))`
                  : `failed: ${results[p.proposalId].error}`,
              }
            : p,
        ),
      }));
      if (summary && summary.after != null) {
        setNavToast(
          t("chat.plan.done", { applied: summary.applied, rows: summary.rows }),
        );
      }
    },
    [updateTurn, t],
  );

  const handleResetConfirmed = useCallback(() => {
    if (abortRef.current) abortRef.current.abort();
    if (attachment) {
      deleteChatAttachment(attachment.table).catch(() => {});
      setAttachment(null);
    }
    reset();
    setDraft("");
    setConfirmReset(false);
  }, [reset, attachment]);

  const handleBetaGateSubmit = useCallback(
    async (code) => {
      try {
        localStorage.setItem(BETA_CODE_STORAGE_KEY, code);
      } catch {
        /* ignore */
      }
      const pending = pendingRetryRef.current;
      pendingRetryRef.current = null;
      setBetaGate(null);
      setUpsell(false);
      setFreeRemaining(null);
      if (pending) sendTurn({ retryOf: pending });
      return { ok: true };
    },
    [sendTurn],
  );

  const width = isMobile ? "100vw" : wide ? WIDTH_WIDE : WIDTH_NORMAL;

  // ── Render ──────────────────────────────────────────────────────────
  const drawerContent = (
    <Box
      data-testid="chat-drawer"
      sx={{
        height: "100%",
        width,
        display: "flex",
        flexDirection: "column",
        background: theme.palette.background.default,
      }}
    >
      {/* Header */}
      <Box
        sx={{
          px: 1.5,
          py: 1,
          display: "flex",
          alignItems: "center",
          gap: 1,
          borderBottom: `1px solid ${alpha(theme.palette.text.primary, 0.1)}`,
          background: alpha(theme.palette.background.paper, 0.95),
          backdropFilter: "blur(10px)",
        }}
      >
        <Box
          sx={{
            width: 30,
            height: 30,
            borderRadius: "10px",
            display: "flex",
            alignItems: "center",
            justifyContent: "center",
            flexShrink: 0,
            background: `linear-gradient(135deg, ${theme.palette.ai.gradientStart} 0%, ${theme.palette.ai.gradientEnd} 100%)`,
            color: theme.palette.ai.contrastText,
            boxShadow: `0 2px 8px ${alpha(theme.palette.ai.main, 0.35)}`,
          }}
        >
          <GTFSAIIcon sx={{ fontSize: 17 }} />
        </Box>
        <Box sx={{ flex: 1, minWidth: 0 }}>
          <Box sx={{ fontSize: "0.92rem", fontWeight: 700, color: "text.primary", lineHeight: 1.2 }}>
            {t("chat.title")}
          </Box>
          <Box sx={{ display: "flex", gap: 0.5, mt: 0.3, alignItems: "center", flexWrap: "wrap" }}>
            <Tooltip title={t("chat.safeChipTooltip")} arrow>
              <Chip
                icon={<VerifiedUserOutlinedIcon sx={{ fontSize: 11 }} />}
                label={t("chat.safeChip")}
                size="small"
                sx={{
                  height: 16,
                  fontSize: "0.58rem",
                  fontWeight: 700,
                  color: "success.dark",
                  bgcolor: alpha(theme.palette.success.main, 0.1),
                  "& .MuiChip-label": { px: 0.6 },
                  "& .MuiChip-icon": { ml: 0.4, color: "success.dark" },
                }}
              />
            </Tooltip>
            {features?.chat?.model && (
              <Chip
                label={features.chat.model}
                size="small"
                sx={{
                  height: 16,
                  fontSize: "0.58rem",
                  fontWeight: 600,
                  color: "text.disabled",
                  bgcolor: alpha(theme.palette.text.primary, 0.06),
                  "& .MuiChip-label": { px: 0.6 },
                }}
              />
            )}
            {freeRemaining != null && (
              <Chip
                label={t("chat.free.remainingChip", { count: freeRemaining })}
                size="small"
                data-testid="chat-free-chip"
                sx={{
                  height: 16,
                  fontSize: "0.58rem",
                  fontWeight: 700,
                  color: "warning.dark",
                  bgcolor: alpha(theme.palette.warning.main, 0.12),
                  "& .MuiChip-label": { px: 0.6 },
                }}
              />
            )}
          </Box>
        </Box>
        {!isMobile && (
          <Tooltip title={wide ? t("chat.action.narrow") : t("chat.action.widen")}>
            <IconButton size="small" onClick={toggleWide} aria-label={wide ? t("chat.action.narrow") : t("chat.action.widen")} sx={{ width: 28, height: 28 }}>
              {wide ? <CloseFullscreenIcon sx={{ fontSize: 15 }} /> : <OpenInFullIcon sx={{ fontSize: 15 }} />}
            </IconButton>
          </Tooltip>
        )}
        <Tooltip title={conversationCopied ? t("chat.action.conversationCopied") : t("chat.action.copyConversation")}>
          <span>
            <IconButton
              size="small"
              onClick={handleCopyConversation}
              disabled={turns.length === 0}
              aria-label={t("chat.action.copyConversation")}
              sx={{ width: 28, height: 28 }}
            >
              {conversationCopied ? <CheckIcon sx={{ fontSize: 15, color: "success.main" }} /> : <ContentCopyIcon sx={{ fontSize: 15 }} />}
            </IconButton>
          </span>
        </Tooltip>
        <Tooltip title={t("chat.action.newConversation")}>
          <span>
            <IconButton
              size="small"
              onClick={() => setConfirmReset(true)}
              disabled={turns.length === 0 && !streaming}
              aria-label={t("chat.action.newConversation")}
              data-testid="chat-new-conversation"
              sx={{ width: 28, height: 28 }}
            >
              <RestartAltIcon sx={{ fontSize: 16 }} />
            </IconButton>
          </span>
        </Tooltip>
        <Tooltip title={t("chat.action.close")}>
          <IconButton size="small" onClick={onClose} aria-label={t("chat.action.close")} data-testid="chat-close" sx={{ width: 28, height: 28 }}>
            <CloseIcon sx={{ fontSize: 16 }} />
          </IconButton>
        </Tooltip>
      </Box>

      {/* Body */}
      {!feedLoaded ? (
        <Box
          sx={{
            flex: 1,
            display: "flex",
            flexDirection: "column",
            justifyContent: "center",
            alignItems: "center",
            px: 3,
            py: 4,
            textAlign: "center",
            color: "text.secondary",
          }}
        >
          <Box
            sx={{
              width: 56,
              height: 56,
              borderRadius: "50%",
              display: "flex",
              alignItems: "center",
              justifyContent: "center",
              background: alpha(theme.palette.text.primary, 0.06),
              color: "text.disabled",
              mb: 1.5,
            }}
          >
            <CloudOffIcon sx={{ fontSize: 28 }} />
          </Box>
          <Box sx={{ fontSize: "0.95rem", fontWeight: 700, color: "text.primary", mb: 0.5 }}>
            {t("chat.disabled.noFeedTitle")}
          </Box>
          <Box sx={{ fontSize: "0.8rem", maxWidth: 280, lineHeight: 1.5 }}>{t("chat.disabled.noFeedBody")}</Box>
        </Box>
      ) : (
        <ChatHistoryList
          turns={turns}
          onPickExample={handlePickExample}
          onRegenerateTurn={handleRegenerate}
          currentErrorCount={sessionContext?.validation?.errors ?? null}
          onProposalOutcome={handleProposalOutcome}
          onBatchApplied={handleBatchApplied}
          onPickFollowup={handlePickSuggestion}
          onReplayAction={performUiAction}
          suggestions={suggestions}
          onPickSuggestion={handlePickSuggestion}
        />
      )}

      {feedLoaded &&
        (upsell ? (
          <UpsellPanel onHaveCode={() => setBetaGate({ initialError: null })} />
        ) : (
          <ChatInputBar
            value={draft}
            onChange={setDraft}
            onSend={handleSend}
            onStop={handleStop}
            streaming={streaming}
            autoFocus={open}
            attachment={attachment}
            attachmentUploading={attachmentUploading}
            onAttachFile={handleAttachFile}
            onRemoveAttachment={handleRemoveAttachment}
            onQuickAction={handlePickSuggestion}
          />
        ))}
      <Snackbar
        open={Boolean(attachmentError)}
        autoHideDuration={5000}
        onClose={() => setAttachmentError(null)}
        anchorOrigin={{ vertical: "bottom", horizontal: "center" }}
      >
        <Alert severity="error" variant="filled" onClose={() => setAttachmentError(null)} sx={{ fontSize: "0.8rem" }}>
          {attachmentError}
        </Alert>
      </Snackbar>
      <Snackbar
        open={Boolean(navToast)}
        autoHideDuration={2200}
        onClose={() => setNavToast(null)}
        anchorOrigin={{ vertical: "bottom", horizontal: "center" }}
      >
        <Alert severity="info" variant="filled" onClose={() => setNavToast(null)} sx={{ fontSize: "0.8rem" }}>
          {navToast}
        </Alert>
      </Snackbar>
    </Box>
  );

  return (
    <>
      {isMobile ? (
        <SwipeableDrawer
          anchor="bottom"
          open={open}
          onClose={onClose}
          onOpen={() => {}}
          disableSwipeToOpen
          PaperProps={{
            sx: {
              width: "100vw",
              height: "85vh",
              borderTopLeftRadius: 16,
              borderTopRightRadius: 16,
              boxShadow: `0 -8px 32px ${alpha("#000", theme.palette.mode === "dark" ? 0.45 : 0.15)}`,
            },
          }}
          ModalProps={{ keepMounted: false }}
        >
          <Box
            aria-hidden
            sx={{
              width: 36,
              height: 4,
              borderRadius: 2,
              bgcolor: alpha(theme.palette.text.primary, 0.25),
              mx: "auto",
              mt: 1,
              mb: 0.25,
              flexShrink: 0,
            }}
          />
          {drawerContent}
        </SwipeableDrawer>
      ) : (
        /* Docked companion: no backdrop, no focus trap, no scroll lock —
           the user keeps working in the app while the assistant answers
           and opens things on the right. */
        <Drawer
          anchor="left"
          open={open}
          onClose={onClose}
          hideBackdrop
          ModalProps={{
            keepMounted: false,
            disableEnforceFocus: true,
            disableAutoFocus: true,
            disableRestoreFocus: true,
            disableScrollLock: true,
            disableEscapeKeyDown: true,
          }}
          PaperProps={{
            sx: {
              width,
              height: "100%",
              borderRight: `1px solid ${alpha(theme.palette.text.primary, 0.1)}`,
              boxShadow: `8px 0 32px ${alpha("#000", theme.palette.mode === "dark" ? 0.45 : 0.15)}`,
            },
          }}
          sx={{ pointerEvents: "none", "& .MuiDrawer-paper": { pointerEvents: "auto" } }}
        >
          {drawerContent}
        </Drawer>
      )}

      <Dialog open={confirmReset} onClose={() => setConfirmReset(false)} maxWidth="xs" fullWidth>
        <DialogTitle sx={{ pb: 1 }}>{t("chat.confirmReset.title")}</DialogTitle>
        <DialogContent>
          <Box sx={{ fontSize: "0.85rem", color: "text.secondary" }}>{t("chat.confirmReset.body")}</Box>
        </DialogContent>
        <DialogActions>
          <Button onClick={() => setConfirmReset(false)} color="inherit">
            {t("app.cancel")}
          </Button>
          <Button onClick={handleResetConfirmed} variant="contained" color="error">
            {t("chat.confirmReset.confirm")}
          </Button>
        </DialogActions>
      </Dialog>

      <BetaGateDialog
        open={Boolean(betaGate)}
        onClose={() => {
          pendingRetryRef.current = null;
          setBetaGate(null);
        }}
        onSubmit={handleBetaGateSubmit}
        initialError={betaGate?.initialError || null}
        bodyKey="beta.bodyChat"
      />
    </>
  );
}
