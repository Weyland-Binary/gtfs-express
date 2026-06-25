/**
 * ChatDrawer — Side panel hosting the multi-turn chat assistant.
 *
 * Responsibilities:
 *  - Owns conversation state (via useChatHistory)
 *  - Drives the SSE stream (via streamChat)
 *  - Translates SSE events into turn updates
 *  - Surfaces 403 → BetaGateDialog with auto-retry on success
 *  - Manages AbortController for the active stream
 *  - Confirms "new conversation" before wiping history
 *
 * Layout:
 *  - Right-anchored Drawer, 480 px on md+, full width on xs.
 *  - Sticky header with title, model chip, "Read-only" chip, action buttons.
 *  - Scrollable history list (auto-stick-to-bottom).
 *  - Sticky input bar.
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
  alpha,
  useTheme,
  useMediaQuery,
} from "@mui/material";
import CloseIcon from "@mui/icons-material/Close";
import RestartAltIcon from "@mui/icons-material/RestartAlt";
import ContentCopyIcon from "@mui/icons-material/ContentCopy";
import CheckIcon from "@mui/icons-material/Check";
import LockOutlinedIcon from "@mui/icons-material/LockOutlined";
import CloudOffIcon from "@mui/icons-material/CloudOff";
import { useLanguage } from "../../contexts/LanguageContext";
import useChatHistory, { turnsToWireMessages, newChatId } from "./useChatHistory";
import { streamChat } from "../../utils/chatStream";
import ChatHistoryList from "./ChatHistoryList";
import ChatInputBar from "./ChatInputBar";
import UpsellPanel from "./UpsellPanel";
import BetaGateDialog, {
  BETA_CODE_STORAGE_KEY,
} from "../edit/BetaGateDialog";

const DRAWER_WIDTH = "50vw";

const isBetaError = (code) =>
  code === "INVALID_BETA_CODE" ||
  code === "BETA_REVOKED" ||
  code === "BETA_CODE_REQUIRED" ||
  code === "BETA_CONFIG_ERROR";

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
  const [betaGate, setBetaGate] = useState(null); // { initialError, pendingTurnPair? }
  // Anonymous free-trial state: allowance left (from the SSE meta event,
  // null for coded users) and whether the paywall replaces the input bar.
  const [freeRemaining, setFreeRemaining] = useState(null);
  const [upsell, setUpsell] = useState(false);

  // The current pending pair we re-run after a successful beta-gate retry.
  // Stored as a ref because the BetaGateDialog onSubmit closure must read
  // the latest value without re-rendering.
  const pendingRetryRef = useRef(null);
  const abortRef = useRef(null);
  const feedEpochRef = useRef(feedEpoch);

  // Reset conversation history when a new feed is loaded (upload, sample, project).
  // feedEpochRef skips the initial mount — useChatHistory handles stale sessionStorage
  // across page reloads via APP_LAUNCH_ID, so no first-mount reset is needed here.
  useEffect(() => {
    if (feedEpoch === feedEpochRef.current) return;
    feedEpochRef.current = feedEpoch;
    if (abortRef.current) {
      abortRef.current.abort();
      abortRef.current = null;
      setStreaming(false);
    }
    reset();
  }, [feedEpoch, reset]);

  // Reset everything when the drawer is fully closed (avoids stale state
  // bleeding into the next open).
  useEffect(() => {
    if (!open && abortRef.current) {
      abortRef.current.abort();
      abortRef.current = null;
      setStreaming(false);
    }
  }, [open]);

  const sendTurn = useCallback(
    async ({ userMessage, regenerateOf = null, retryOf = null }) => {
      if (streaming) return;

      // ── Resolve the user-message + history to send ───────────────────
      let userTurnId = null;
      let assistantTurnId = null;

      if (regenerateOf) {
        // We're re-running an existing assistant turn — find the user
        // turn immediately preceding it. Drop the assistant turn first.
        const idx = turns.findIndex((t) => t.id === regenerateOf);
        if (idx <= 0) return;
        const prevUser = turns[idx - 1];
        if (prevUser.role !== "user") return;
        userMessage = prevUser.content;
        userTurnId = prevUser.id;
        // Wipe the existing assistant turn and create a fresh one.
        removeTurn(regenerateOf);
      } else if (retryOf) {
        // We're retrying after a beta-code prompt. The user+assistant
        // pair already exists — keep the user turn, recreate assistant.
        userMessage = retryOf.userMessage;
        userTurnId = retryOf.userTurnId;
        if (retryOf.assistantTurnId) removeTurn(retryOf.assistantTurnId);
      } else {
        // Fresh send.
        const userTurn = appendUser(userMessage);
        userTurnId = userTurn.id;
      }

      const assistantTurn = appendAssistant({});
      assistantTurnId = assistantTurn.id;

      const turnId = newChatId();
      const wireMessages = turnsToWireMessages(
        // Recompute fresh: we just appended; turns state from closure is
        // stale. Reconstruct the wire messages from `turns` + the new user.
        // For "new" sends, the user turn isn't in `turns` yet (state hasn't
        // re-rendered) — include it manually.
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

      try {
        await streamChat({
          messages: wireMessages,
          userMessage,
          language,
          sessionContext,
          conversationId,
          turnId,
          signal: abort.signal,
          onEvent: (event, data) => {
            switch (event) {
              case "meta":
                updateTurn(assistantTurnId, { model: data.model });
                setFreeRemaining(
                  typeof data.freeRemaining === "number"
                    ? data.freeRemaining
                    : null,
                );
                break;
              case "token":
                if (data.phase === "preamble") {
                  updateTurn(assistantTurnId, (prev) => ({
                    preamble: (prev.preamble || "") + (data.text || ""),
                  }));
                } else if (data.phase === "summary") {
                  updateTurn(assistantTurnId, (prev) => ({
                    summary: (prev.summary || "") + (data.text || ""),
                  }));
                }
                break;
              case "sql_generated":
                updateTurn(assistantTurnId, {
                  sql: data.sql,
                  preamble: data.preamble || "",
                });
                break;
              case "sql_blocked":
                updateTurn(assistantTurnId, {
                  status: "blocked",
                  preamble: data.preamble || "",
                  sql: data.draftSql || "",
                  blocked: {
                    reason: data.reason,
                    message: data.message,
                    draftSql: data.draftSql,
                  },
                });
                break;
              case "sql_executing":
                // No state change — the streaming cursor is enough UX.
                break;
              case "sql_result":
                updateTurn(assistantTurnId, {
                  result: {
                    rowCount: data.rowCount,
                    columns: data.columns || [],
                    rowsPreview: data.rowsPreview || [],
                    truncated: Boolean(data.truncated),
                    durationMs: data.durationMs,
                  },
                });
                break;
              case "sql_error":
                updateTurn(assistantTurnId, {
                  status: "error",
                  error: { message: data.message },
                });
                break;
              case "error":
                updateTurn(assistantTurnId, {
                  status: "error",
                  error: { message: data.message, code: data.code },
                });
                break;
              case "done":
                updateTurn(assistantTurnId, (prev) => ({
                  status:
                    prev.status === "blocked" ||
                    prev.status === "error"
                      ? prev.status
                      : "complete",
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
            status: prev.status === "complete" ? "complete" : "aborted",
            error: prev.error || { message: t("chat.error.aborted") },
          }));
        } else if (err.code === "FREE_QUOTA_EXHAUSTED") {
          // The free trial is over — this is the conversion moment. Drop the
          // dangling assistant placeholder, keep the user's question visible
          // and swap the input bar for the UpsellPanel. If the user unlocks
          // with a code, the blocked question is retried automatically.
          removeTurn(assistantTurnId);
          pendingRetryRef.current = {
            userMessage,
            userTurnId,
            assistantTurnId: null,
          };
          setFreeRemaining(0);
          setUpsell(true);
        } else if (isBetaError(err.code)) {
          // Surface the beta dialog. On success, retry this same turn.
          pendingRetryRef.current = {
            userMessage,
            userTurnId,
            assistantTurnId,
          };
          updateTurn(assistantTurnId, {
            status: "error",
            error: {
              message: err.message || t("chat.error.betaRequired"),
              code: err.code,
            },
          });
          setBetaGate({
            initialError: { code: err.code, message: err.message },
          });
        } else if (
          err.code === "RATE_LIMITED" ||
          err.code === "DAILY_LIMIT_REACHED" ||
          err.code === "BUDGET_EXHAUSTED"
        ) {
          // Three-tier AI cost guard from services/aiCostLimiter — render
          // a localised message per code so testers know whether to retry
          // soon (hourly), tomorrow (daily), or wait for the operator
          // budget reset (global).
          const messageByCode = {
            RATE_LIMITED: t("nl2sql.error.rateLimited"),
            DAILY_LIMIT_REACHED: t("nl2sql.error.dailyLimit"),
            BUDGET_EXHAUSTED: t("nl2sql.error.budgetExhausted"),
          };
          updateTurn(assistantTurnId, {
            status: "error",
            error: {
              message: messageByCode[err.code] || err.message,
              code: err.code,
            },
          });
        } else if (
          err.code === "NL2SQL_CHAT_DISABLED" ||
          err.code === "HTTP_503"
        ) {
          updateTurn(assistantTurnId, {
            status: "error",
            error: {
              message: err.message || t("chat.error.disabled"),
              code: err.code,
            },
          });
        } else {
          updateTurn(assistantTurnId, {
            status: "error",
            error: {
              message: err.message || t("chat.error.generic"),
              code: err.code,
            },
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
      t,
    ],
  );

  // Auto-send a message handed off by another surface (e.g. "Ask AI" on a
  // validation finding). Consumed exactly once per hand-off — the consume
  // callback runs BEFORE the send so a re-render can't double-fire it.
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
    if (abortRef.current) {
      abortRef.current.abort();
    }
  }, []);

  const handleRegenerate = useCallback(
    (assistantTurnId) => {
      sendTurn({ userMessage: "", regenerateOf: assistantTurnId });
    },
    [sendTurn],
  );

  const handlePickExample = useCallback((example) => {
    setDraft(example);
  }, []);

  // Copy the whole conversation as readable markdown (Q/A + SQL + result
  // line) — for sharing findings or pasting into a ticket.
  const [conversationCopied, setConversationCopied] = useState(false);
  const handleCopyConversation = useCallback(() => {
    const parts = [];
    for (const turn of turns) {
      if (turn.role === "user") {
        parts.push(`**Q:** ${turn.content}`);
      } else {
        const prose = [turn.preamble, turn.summary]
          .filter(Boolean)
          .join("\n\n");
        if (prose) parts.push(`**A:** ${prose}`);
        if (turn.sql) parts.push("```sql\n" + turn.sql + "\n```");
        if (turn.result)
          parts.push(`_Result: ${turn.result.rowCount} row(s)._`);
        if (turn.resultSummary) parts.push(`_${turn.resultSummary}_`);
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
  // "fix this" suggestions in the empty state — the shortest path from a
  // broken feed to the guided repair flow.
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

  // Outcome of a guided repair flow (RepairFlow inside a blocked bubble).
  // Persisting it as `resultSummary` makes flattenAssistantTurn feed the real
  // outcome ("applied, errors 12 -> 0" / "undone") back to the model on the
  // next turn — the assistant always knows what actually happened.
  const handleRepairOutcome = useCallback(
    (turnId, summary) => {
      updateTurn(turnId, { resultSummary: summary });
    },
    [updateTurn],
  );

  const handleResetConfirmed = useCallback(() => {
    if (abortRef.current) abortRef.current.abort();
    reset();
    setDraft("");
    setConfirmReset(false);
  }, [reset]);

  const handleBetaGateSubmit = useCallback(
    async (code) => {
      // No dedicated validation endpoint — we persist the code optimistically
      // and re-trigger the pending chat turn. If the code is bad, streamChat
      // 403s again and we re-open the dialog with the fresh error message
      // (handled in the sendTurn catch block).
      try {
        localStorage.setItem(BETA_CODE_STORAGE_KEY, code);
      } catch {
        /* ignore — streamChat will silently send no header */
      }
      const pending = pendingRetryRef.current;
      pendingRetryRef.current = null;
      setBetaGate(null);
      // Unlocking with a code also clears the free-trial paywall.
      setUpsell(false);
      setFreeRemaining(null);
      if (pending) sendTurn({ retryOf: pending });
      return { ok: true };
    },
    [sendTurn],
  );

  // ── Render ──────────────────────────────────────────────────────────
  const drawerContent = (
    <Box
      sx={{
        height: "100%",
        width: isMobile ? "100vw" : DRAWER_WIDTH,
        display: "flex",
        flexDirection: "column",
        background: theme.palette.background.default,
      }}
    >
      {/* Header */}
      <Box
        sx={{
          px: 1.5,
          py: 1.25,
          display: "flex",
          alignItems: "center",
          gap: 0.75,
          borderBottom: `1px solid ${alpha(theme.palette.text.primary, 0.10)}`,
          background: alpha(theme.palette.background.paper, 0.95),
          backdropFilter: "blur(10px)",
        }}
      >

        <Box sx={{ flex: 1, minWidth: 0 }}>
          <Box
            sx={{
              fontSize: "0.92rem",
              fontWeight: 700,
              color: "text.primary",
              lineHeight: 1.2,
            }}
          >
            {t("chat.title")}
          </Box>
          <Box sx={{ display: "flex", gap: 0.5, mt: 0.3 }}>
            <Chip
              icon={<LockOutlinedIcon sx={{ fontSize: 11 }} />}
              label={t("chat.readOnlyChip")}
              size="small"
              sx={{
                height: 16,
                fontSize: "0.58rem",
                fontWeight: 700,
                color: "info.dark",
                bgcolor: alpha(theme.palette.info.main, 0.10),
                "& .MuiChip-label": { px: 0.6 },
                "& .MuiChip-icon": { ml: 0.4, color: "info.dark" },
              }}
            />
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
        <Tooltip
          title={
            conversationCopied
              ? t("chat.action.conversationCopied")
              : t("chat.action.copyConversation")
          }
        >
          <span>
            <IconButton
              size="small"
              onClick={handleCopyConversation}
              disabled={turns.length === 0}
              aria-label={t("chat.action.copyConversation")}
              sx={{ width: 28, height: 28 }}
            >
              {conversationCopied ? (
                <CheckIcon sx={{ fontSize: 15, color: "success.main" }} />
              ) : (
                <ContentCopyIcon sx={{ fontSize: 15 }} />
              )}
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
              sx={{ width: 28, height: 28 }}
            >
              <RestartAltIcon sx={{ fontSize: 16 }} />
            </IconButton>
          </span>
        </Tooltip>
        <Tooltip title={t("chat.action.close")}>
          <IconButton
            size="small"
            onClick={onClose}
            aria-label={t("chat.action.close")}
            sx={{ width: 28, height: 28 }}
          >
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
          <Box
            sx={{
              fontSize: "0.95rem",
              fontWeight: 700,
              color: "text.primary",
              mb: 0.5,
            }}
          >
            {t("chat.disabled.noFeedTitle")}
          </Box>
          <Box sx={{ fontSize: "0.8rem", maxWidth: 280, lineHeight: 1.5 }}>
            {t("chat.disabled.noFeedBody")}
          </Box>
        </Box>
      ) : (
        <ChatHistoryList
          turns={turns}
          onPickExample={handlePickExample}
          onRegenerateTurn={handleRegenerate}
          currentErrorCount={sessionContext?.validation?.errors ?? null}
          onRepairOutcome={handleRepairOutcome}
          suggestions={suggestions}
          onPickSuggestion={handlePickSuggestion}
        />
      )}

      {/* Input — replaced by the paywall once the free trial is used up */}
      {feedLoaded &&
        (upsell ? (
          <UpsellPanel
            onHaveCode={() => setBetaGate({ initialError: null })}
          />
        ) : (
          <ChatInputBar
            value={draft}
            onChange={setDraft}
            onSend={handleSend}
            onStop={handleStop}
            streaming={streaming}
            autoFocus={open}
          />
        ))}
    </Box>
  );

  return (
    <>
      {isMobile ? (
        /* Bottom sheet with native swipe-to-dismiss + a grab handle —
           the expected mobile affordance for a chat surface. */
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
        <Drawer
          anchor="right"
          open={open}
          onClose={onClose}
          PaperProps={{
            sx: {
              width: DRAWER_WIDTH,
              height: "100%",
              borderLeft: `1px solid ${alpha(theme.palette.text.primary, 0.10)}`,
              boxShadow: `-8px 0 32px ${alpha("#000", theme.palette.mode === "dark" ? 0.45 : 0.15)}`,
            },
          }}
          ModalProps={{ keepMounted: false }}
        >
          {drawerContent}
        </Drawer>
      )}

      {/* New-conversation confirmation */}
      <Dialog
        open={confirmReset}
        onClose={() => setConfirmReset(false)}
        maxWidth="xs"
        fullWidth
      >
        <DialogTitle sx={{ pb: 1 }}>{t("chat.confirmReset.title")}</DialogTitle>
        <DialogContent>
          <Box sx={{ fontSize: "0.85rem", color: "text.secondary" }}>
            {t("chat.confirmReset.body")}
          </Box>
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
