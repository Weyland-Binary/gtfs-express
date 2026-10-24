/**
 * The assistant's panel: holds the conversation, maps the SSE stream's events onto the turn and performs the
 * assistant's navigation requests in the app. Docked beside the reader (`host`, the shell's aside) and never modal, so
 * the network stays in view and usable while the assistant reads it and opens things.
 */

import React, { useCallback, useEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import {
  Drawer,
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
  Typography,
  alpha,
  useTheme,
} from "@mui/material";
import CloseRoundedIcon from "@mui/icons-material/CloseRounded";
import RestartAltIcon from "@mui/icons-material/RestartAlt";
import ContentCopyIcon from "@mui/icons-material/ContentCopy";
import CheckIcon from "@mui/icons-material/Check";
import CloudOffIcon from "@mui/icons-material/CloudOff";
import OpenInFullIcon from "@mui/icons-material/OpenInFull";
import CloseFullscreenIcon from "@mui/icons-material/CloseFullscreen";
import GTFSAIIcon from "./GTFSAIIcon";
import { useLanguage } from "../../contexts/LanguageContext";
import { useDetailPanel } from "../../contexts/DetailPanelContext";
import useChatHistory, { turnsToWireMessages, newChatId } from "./useChatHistory";
import { streamChat } from "../../utils/chatStream";
import { getReaderLens } from "../../utils/sessionManager";
import {
  uploadChatAttachment,
  deleteChatAttachment,
  MAX_ATTACHMENT_BYTES,
  MAX_ATTACHMENT_MB,
  MAX_ATTACHMENT_COLS,
  ACCEPTED_EXTENSIONS,
} from "../../utils/chatAttachment";
import ChatHistoryList from "./ChatHistoryList";
import useAssistantMemory from "./useAssistantMemory";
import MemoryChip from "./MemoryChip";
import ChatInputBar from "./ChatInputBar";
import UpsellPanel from "./UpsellPanel";
import { CLOSE_VALIDATION_REPORT_EVENT, MEMORY_EVENT, NAVIGATE_EVENT, REVIEW_ERRORS_EVENT } from "../../utils/appEvents";

const WIDTH_NORMAL = 440;
const WIDTH_WIDE = 720;
const WIDTH_KEY = "gtfs.chat.wide";
const LEAVE_MS = 220;

const MOTION = {
  "@keyframes chatPanelIn": { "0%": { transform: "translateX(28px)", opacity: 0 }, "100%": { transform: "translateX(0)", opacity: 1 } },
  "@keyframes chatPanelOut": { "0%": { transform: "translateX(0)", opacity: 1 }, "100%": { transform: "translateX(28px)", opacity: 0 } },
  "@keyframes chatHeadPop": { "0%": { transform: "scale(.6) rotate(-12deg)", opacity: 0 }, "100%": { transform: "none", opacity: 1 } },
};

const reducedMotion = () => typeof window === "undefined" || typeof window.matchMedia !== "function" || window.matchMedia("(prefers-reduced-motion: reduce)").matches;


export default function ChatDrawer({
  open,
  onClose,
  host = null,
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
  const dark = theme.palette.mode === "dark";
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
  const [freeRemaining, setFreeRemaining] = useState(null);
  // The reading companion (an account without the licence): its questions left this month.
  const readerQuota = features?.chat?.reader && !features.chat.reader.signInRequired ? features.chat.reader : null;
  const [reading, setReading] = useState(false);
  const [upsell, setUpsell] = useState(null); // null | { month: boolean, resets }
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

  const abortRef = useRef(null);
  // On a draft's « Après » the assistant's tools still read the working copy: said, so an answer is never taken for
  // the draft's.
  const [readsSource, setReadsSource] = useState(false);
  useEffect(() => {
    setReadsSource(Boolean(open && getReaderLens()));
  }, [open, feedEpoch]);
  const feedEpochRef = useRef(feedEpoch);
  const { memory, update: updateMemory } = useAssistantMemory({ enabled: feedLoaded, feedEpoch });

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
          window.dispatchEvent(new CustomEvent(REVIEW_ERRORS_EVENT));
          break;
        case "sql_console":
          window.dispatchEvent(new CustomEvent(CLOSE_VALIDATION_REPORT_EVENT));
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
    async ({ userMessage, regenerateOf = null }) => {
      if (streaming) return;

      let assistantTurnId = null;

      if (regenerateOf) {
        const idx = turns.findIndex((tt) => tt.id === regenerateOf);
        if (idx <= 0) return;
        const prevUser = turns[idx - 1];
        if (prevUser.role !== "user") return;
        userMessage = prevUser.content;
        removeTurn(regenerateOf);
      } else {
        appendUser(
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
      }

      const assistantTurn = appendAssistant({});
      assistantTurnId = assistantTurn.id;

      const turnId = newChatId();
      const wireMessages = turnsToWireMessages(
        regenerateOf
          ? turns.filter((tt) => tt.id !== regenerateOf)
          : [...turns, { role: "user", content: userMessage }],
      );

      const abort = new AbortController();
      abortRef.current = abort;
      setStreaming(true);
      if (!regenerateOf) setDraft("");

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
                setReading(data.reader === true);
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
              case "change":
                if (typeof data.brief !== "string" || !data.brief.trim()) break;
                updateTurn(assistantTurnId, (prev) => ({
                  pendingTool: null,
                  changes: [...(prev.changes || []), { changeId: data.changeId, brief: data.brief, sql: data.sql || null }],
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
              case "journey":
                updateTurn(assistantTurnId, (prev) => ({
                  pendingTool: null,
                  journeys: [...(prev.journeys || []), data],
                }));
                break;
              case "memory":
                // remember/forget: the memory chip and the Diagnostic's muted list read again.
                window.dispatchEvent(new CustomEvent(MEMORY_EVENT));
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
        } else if (err.code === "FREE_QUOTA_EXHAUSTED" || (err.code === "AI_ALLOWANCE_EXHAUSTED" && err.body?.allowance?.kind === "reader")) {
          removeTurn(assistantTurnId);
          setFreeRemaining(0);
          setUpsell({ month: err.body?.scope === "month" || err.body?.allowance?.kind === "reader", resets: err.body?.resets || null });
        } else if (
          err.code === "RATE_LIMITED" ||
          err.code === "DAILY_LIMIT_REACHED" ||
          err.code === "BUDGET_EXHAUSTED" ||
          err.code === "AI_BUDGET_EXHAUSTED"
        ) {
          const messageByCode = {
            RATE_LIMITED: t("nl2sql.error.rateLimited"),
            DAILY_LIMIT_REACHED: t("nl2sql.error.dailyLimit"),
            BUDGET_EXHAUSTED: t("nl2sql.error.budgetExhausted"),
            AI_BUDGET_EXHAUSTED: t("nl2sql.error.budgetExhausted"),
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

  // Consumed exactly once per hand-off.
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
        for (const c of turn.changes || []) parts.push(`**${t("chat.change.title")}:** ${c.brief}`);
      }
    }
    try {
      navigator.clipboard.writeText(parts.join("\n\n"));
      setConversationCopied(true);
      setTimeout(() => setConversationCopied(false), 1600);
    } catch {
      /* clipboard blocked */
    }
  }, [turns, t]);

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

  // The panel slides out before it closes; the conversation stays mounted.
  const [leaving, setLeaving] = useState(false);
  const leaveTimer = useRef(null);
  const close = useCallback(() => {
    if (!host || reducedMotion()) {
      onClose();
      return;
    }
    setLeaving(true);
    clearTimeout(leaveTimer.current);
    leaveTimer.current = setTimeout(() => {
      setLeaving(false);
      onClose();
    }, LEAVE_MS);
  }, [host, onClose]);
  useEffect(() => () => clearTimeout(leaveTimer.current), []);
  useEffect(() => {
    if (open) setLeaving(false);
  }, [open]);

  const width = wide ? WIDTH_WIDE : WIDTH_NORMAL;
  const quota = freeRemaining ?? readerQuota?.remaining;

  const drawerContent = (
    <Box
      data-testid="chat-drawer"
      sx={{
        height: "100%",
        width: "100%",
        minHeight: 0,
        display: "flex",
        flexDirection: "column",
        background: theme.palette.background.paper,
      }}
    >
      <Box sx={{ px: 2, pt: 1.75, pb: 1.25, display: "flex", alignItems: "center", gap: 1.25, borderBottom: `1px solid ${theme.palette.divider}` }}>
        <Box
          aria-hidden
          sx={{
            ...MOTION,
            width: 34,
            height: 34,
            borderRadius: "10px",
            display: "flex",
            alignItems: "center",
            justifyContent: "center",
            flexShrink: 0,
            background: `linear-gradient(135deg, ${theme.palette.ai.gradientStart} 0%, ${theme.palette.ai.gradientEnd} 100%)`,
            color: theme.palette.ai.contrastText,
            boxShadow: `0 4px 14px ${alpha(theme.palette.ai.main, 0.35)}`,
            animation: "chatHeadPop 420ms cubic-bezier(.2,.9,.3,1.3) both",
            "@media (prefers-reduced-motion: reduce)": { animation: "none" },
          }}
        >
          <GTFSAIIcon sx={{ fontSize: 19 }} />
        </Box>
        <Box sx={{ flex: 1, minWidth: 0 }}>
          <Typography id="chat-panel-title" component="h2" sx={{ m: 0, fontSize: "1rem", fontWeight: 750, color: "text.primary", lineHeight: 1.2 }}>
            {t("chat.title")}
          </Typography>
          <Box sx={{ display: "flex", gap: 0.5, mt: 0.3, alignItems: "center", flexWrap: "wrap", fontSize: "0.72rem", color: "text.secondary" }}>
            {t("chat.subtitle")}
            {quota != null && (
              <Chip
                label={reading || readerQuota ? t("chat.reader.remaining", { count: quota }) : t("chat.free.remainingChip", { count: freeRemaining })}
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
        {feedLoaded && <MemoryChip memory={memory} onUpdate={updateMemory} />}
        {host && (
          <Tooltip title={wide ? t("chat.action.narrow") : t("chat.action.widen")}>
            <IconButton size="small" onClick={toggleWide} aria-label={wide ? t("chat.action.narrow") : t("chat.action.widen")} data-testid="chat-widen" sx={{ width: 28, height: 28 }}>
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
          <IconButton size="small" onClick={close} aria-label={t("chat.action.close")} data-testid="chat-close" sx={{ width: 32, height: 32, borderRadius: "10px", color: "text.secondary", transition: "transform .18s", "&:hover": { transform: "rotate(90deg)" }, "@media (prefers-reduced-motion: reduce)": { transition: "none", "&:hover": { transform: "none" } } }}>
            <CloseRoundedIcon sx={{ fontSize: 19 }} />
          </IconButton>
        </Tooltip>
      </Box>

      {readsSource && feedLoaded && (
        <Typography data-testid="chat-reads-source" sx={{ px: 1.5, py: 0.5, fontSize: "0.72rem", color: "text.secondary", borderBottom: `1px solid ${alpha(theme.palette.text.primary, 0.08)}` }}>
          {t("chat.readsSource")}
        </Typography>
      )}
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
          onPickFollowup={handlePickExample}
          onReplayAction={performUiAction}
          context={sessionContext}
        />
      )}

      {feedLoaded &&
        (upsell ? (
          <UpsellPanel month={upsell.month} resets={upsell.resets} />
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

  const docked = open && host ? (
    <Box
      component="aside"
      aria-labelledby="chat-panel-title"
      data-testid="chat-panel"
      data-wide={wide ? "on" : "off"}
      sx={{
        ...MOTION,
        position: "relative",
        width,
        maxWidth: "min(720px, 60vw)",
        height: "100%",
        minHeight: 0,
        flexShrink: 0,
        display: "flex",
        borderLeft: `1px solid ${theme.palette.divider}`,
        backgroundColor: theme.palette.background.paper,
        boxShadow: `-16px 0 40px ${alpha(theme.palette.common.black, dark ? 0.35 : 0.06)}`,
        transition: "width 380ms cubic-bezier(.2,.8,.2,1)",
        animation: leaving ? `chatPanelOut ${LEAVE_MS}ms cubic-bezier(.4,0,1,1) both` : "chatPanelIn 420ms cubic-bezier(.2,.8,.2,1) both",
        "@media (prefers-reduced-motion: reduce)": { animation: "none", transition: "none" },
      }}
    >
      {drawerContent}
    </Box>
  ) : null;

  return (
    <>
      {host ? (
        docked && createPortal(docked, host)
      ) : (
        /* No shell aside (a screen without one): the same panel over the right edge, never modal. */
        <Drawer
          anchor="right"
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
              maxWidth: "100vw",
              height: "100%",
              borderLeft: `1px solid ${theme.palette.divider}`,
              boxShadow: `-16px 0 40px ${alpha(theme.palette.common.black, dark ? 0.45 : 0.12)}`,
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
    </>
  );
}
