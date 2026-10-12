/**
 * ChatAssistantFAB — Compact indigo trigger for the chat assistant.
 *
 * Visibility gate:
 *   1. server features.chat.enabled === true  (NL2SQL_CHAT_ENABLED + key)
 *   2. AND a feed has been loaded             (no point asking about nothing)
 *
 * Access (on click): the server decides (the beta access codes are retired,
 * 2026-10-08). The open model serves everyone; under the paid offer a licence
 * holding "studio" gets the full assistant, anyone else the free messages
 * (their end: UpsellPanel in the drawer). Only when the paid offer closes the
 * assistant and grants no free message does the click open the offer
 * (openPaywall) instead of the drawer; a refusal the server answers anyway
 * (402) opens it by itself (fetchWithSession's PAYWALL_EVENT). The FAB is
 * always visible when a feed is loaded so curious users can discover the
 * feature rather than see nothing.
 *
 * Visual identity:
 *   - Bottom-left, above the fixed footer (footer ≈ 50px → bottom: 68px sm+).
 *   - Indigo gradient fill (violet→indigo) — same token as the assistant avatar
 *     in chat bubbles and the empty-state hero icon.
 *   - Rounded-square (borderRadius 12px) reads as a toolbar button.
 *   - White icon on gradient — high contrast, no ambiguity about purpose.
 *   - Small β badge (marks it as early-access).
 */

import React, { Suspense, lazy, useCallback, useEffect, useRef, useState } from "react";
import { Box, ButtonBase, Tooltip, Zoom, alpha, useTheme } from "@mui/material";
import GTFSAIIcon from "./GTFSAIIcon";
import AutoFixHighIcon from "@mui/icons-material/AutoFixHigh";
import { useLanguage } from "../../contexts/LanguageContext";
import { openPaywall, paidLockOf, useFeatures } from "../../utils/featuresApi";
// The drawer (the conversation, its charts) loads the first time it opens: never in the app's first chunk.
const ChatDrawer = lazy(() => import("./ChatDrawer"));

// AI identity colors live in theme.palette.ai (Theme.js) — rule #19.

/**
 * Under the paid offer, what keeps the assistant closed to this person when
 * the server grants no free message: "sign_in_required" |
 * "subscription_required", or null (the drawer opens; the server decides).
 */
const closedAssistant = (features) => {
  const lock = paidLockOf(features?.access, "studio");
  if (lock !== "sign_in_required" && lock !== "subscription_required") return null;
  return features?.chat?.freeMessages > 0 ? null : lock;
};

// ---------------------------------------------------------------------------

// Custom event other surfaces dispatch to open the assistant with a
// pre-filled, auto-sent message (detail: { message }). Used by the
// validation page's "Ask AI" action — the drawer overlays every view, so
// the user keeps their place while the assistant answers.
export const CHAT_OPEN_EVENT = "gtfs:chat-open";

// Opt-in: prepare a repair plan in the background after each import.
export const AUTO_PLAN_STORAGE_KEY = "gtfs:chat-auto-plan";
const AUTO_PLAN_DELAY_MS = 3500;

export default function ChatAssistantFAB({
  feedLoaded,
  feedEpoch,
  language,
  sessionContext = null,
}) {
  const { t } = useLanguage();
  const theme = useTheme();
  const { features, loaded } = useFeatures();
  const [open, setOpen] = useState(false);
  // Mounted from its first opening on (its conversation then stays while closed, as before).
  const [everOpened, setEverOpened] = useState(false);
  useEffect(() => {
    if (open) setEverOpened(true);
  }, [open]);
  const [prefillMessage, setPrefillMessage] = useState(null);
  const [backgroundMessage, setBackgroundMessage] = useState(null);
  const [planReady, setPlanReady] = useState(null); // { proposals, error }
  const [autoPlan, setAutoPlanState] = useState(() => {
    try {
      return localStorage.getItem(AUTO_PLAN_STORAGE_KEY) === "1";
    } catch {
      return false;
    }
  });
  const isDark = theme.palette.mode === "dark";
  const setAutoPlan = useCallback((on) => {
    setAutoPlanState(on);
    try {
      localStorage.setItem(AUTO_PLAN_STORAGE_KEY, on ? "1" : "0");
    } catch {
      /* storage disabled */
    }
  }, []);

  const enabled = loaded && features?.chat?.enabled === true;
  const visible = enabled && feedLoaded;

  // The assistant closed by the paid offer (no licence, no free message): the click opens the offer.
  const closedBy = closedAssistant(features);

  // External open requests (validation page "Ask AI"): the message is kept
  // pending for the drawer, or the offer opens when the assistant is closed.
  useEffect(() => {
    if (!visible) return undefined;
    const handler = (e) => {
      const message = e?.detail?.message;
      if (typeof message === "string" && message.trim().length >= 2) {
        setPrefillMessage(message);
      }
      if (closedBy) openPaywall("studio", closedBy);
      else setOpen(true);
    };
    window.addEventListener(CHAT_OPEN_EVENT, handler);
    return () => window.removeEventListener(CHAT_OPEN_EVENT, handler);
  }, [visible, closedBy]);

  // Background repair plan: a few seconds after a new feed lands (the
  // conversation was just reset), send the "repair everything" prompt while
  // the drawer stays closed; the badge below tells the user when it is done.
  const lastPlannedEpochRef = useRef(0);
  useEffect(() => {
    if (!visible || !autoPlan || !feedEpoch || feedEpoch === lastPlannedEpochRef.current) return undefined;
    // Never in the background where the assistant is closed (the offer is opened by a click only).
    if (closedBy) return undefined;
    lastPlannedEpochRef.current = feedEpoch;
    setPlanReady(null);
    const id = setTimeout(() => setBackgroundMessage(t("audit.aiRepairAllPrompt")), AUTO_PLAN_DELAY_MS);
    return () => clearTimeout(id);
  }, [visible, autoPlan, feedEpoch, closedBy, t]);

  const handleTurnComplete = useCallback(({ background, proposals, error }) => {
    if (background) setPlanReady({ proposals, error });
  }, []);
  useEffect(() => {
    if (open) setPlanReady(null);
  }, [open]);

  const errorCount = sessionContext?.validation?.errors || 0;
  const showRescueBadge = errorCount > 0 && !open && !planReady;
  const showPlanBadge = Boolean(planReady) && !open;

  if (!visible) return null;

  const handleFabClick = () => {
    if (closedBy) openPaywall("studio", closedBy);
    else setOpen(true);
  };

  return (
    <>
      <Zoom in timeout={240}>
        <Box
          sx={{
            position: "fixed",
            bottom: { xs: 60, sm: 68 },
            left: { xs: 12, sm: 16 },
            zIndex: theme.zIndex.speedDial + 1,
          }}
        >
          <Tooltip
            title={
              showPlanBadge
                ? planReady.proposals > 0
                  ? t("chat.fab.planReady", { count: planReady.proposals })
                  : t("chat.fab.planEmpty")
                : showRescueBadge
                  ? t("chat.fab.rescueTooltip", { count: errorCount })
                  : closedBy
                    ? t("paywall.lock.studio")
                    : t("chat.fab.tooltip")
            }
            placement="right"
            arrow
          >
            <ButtonBase
              aria-label={t("chat.fab.tooltip")}
              onClick={handleFabClick}
              sx={{
                width: 40,
                height: 40,
                borderRadius: "12px",
                border: `1px solid ${alpha("#fff", 0.18)}`,
                background: `linear-gradient(135deg, ${theme.palette.ai.gradientStart} 0%, ${theme.palette.ai.gradientEnd} 100%)`,
                boxShadow: isDark
                  ? `0 2px 14px ${alpha(theme.palette.ai.main, 0.50)}, 0 1px 3px rgba(0,0,0,0.35)`
                  : `0 2px 12px ${alpha(theme.palette.ai.main, 0.38)}, 0 1px 3px rgba(0,0,0,0.12)`,
                color: theme.palette.ai.contrastText,
                transition:
                  "transform 160ms ease, box-shadow 160ms ease, filter 160ms ease",
                "&:hover": {
                  filter: "brightness(1.12)",
                  transform: "scale(1.07)",
                  boxShadow: isDark
                    ? `0 4px 22px ${alpha(theme.palette.ai.main, 0.65)}, 0 1px 4px rgba(0,0,0,0.40)`
                    : `0 4px 20px ${alpha(theme.palette.ai.main, 0.52)}, 0 1px 4px rgba(0,0,0,0.15)`,
                },
                "&:active": {
                  transform: "scale(0.96)",
                  filter: "brightness(0.95)",
                },
                "&:focus-visible": {
                  outline: `2px solid ${theme.palette.ai.main}`,
                  outlineOffset: 2,
                },
              }}
            >
              <GTFSAIIcon sx={{ fontSize: 20 }} />
            </ButtonBase>
          </Tooltip>

          {/* Rescue nudge — blocking-error count, invites the user to ask
              the assistant for help fixing the feed */}
          {showRescueBadge && (
            <Box
              aria-hidden
              sx={{
                position: "absolute",
                top: -7,
                left: -7,
                minWidth: 18,
                height: 18,
                px: "4px",
                borderRadius: "9px",
                display: "flex",
                alignItems: "center",
                justifyContent: "center",
                background: theme.palette.error.main,
                color: theme.palette.error.contrastText,
                fontSize: "0.6rem",
                fontWeight: 700,
                lineHeight: 1,
                pointerEvents: "none",
                userSelect: "none",
                boxShadow: `0 0 0 2px ${theme.palette.background.default}`,
              }}
            >
              {errorCount > 99 ? "99+" : errorCount}
            </Box>
          )}

          {/* Background repair plan ready */}
          {showPlanBadge && (
            <Box
              aria-hidden
              data-testid="chat-plan-badge"
              sx={{
                position: "absolute",
                top: -7,
                left: -7,
                minWidth: 18,
                height: 18,
                px: "4px",
                borderRadius: "9px",
                display: "flex",
                alignItems: "center",
                justifyContent: "center",
                gap: "2px",
                background: planReady.proposals > 0 ? theme.palette.warning.main : theme.palette.success.main,
                color: "#fff",
                fontSize: "0.6rem",
                fontWeight: 700,
                lineHeight: 1,
                pointerEvents: "none",
                userSelect: "none",
                boxShadow: `0 0 0 2px ${theme.palette.background.default}`,
                animation: "gtfsPlanPulse 1.6s ease-in-out 3",
                "@keyframes gtfsPlanPulse": { "0%, 100%": { transform: "scale(1)" }, "50%": { transform: "scale(1.25)" } },
              }}
            >
              <AutoFixHighIcon sx={{ fontSize: 10 }} />
              {planReady.proposals > 0 ? planReady.proposals : ""}
            </Box>
          )}

          {/* β badge */}
          <Box
            aria-hidden
            sx={{
              position: "absolute",
              top: -5,
              right: -5,
              px: "3px",
              py: "1.5px",
              borderRadius: "4px",
              background: alpha("#fff", 0.22),
              color: "#fff",
              fontSize: "0.52rem",
              fontWeight: 700,
              lineHeight: 1,
              letterSpacing: "0.02em",
              pointerEvents: "none",
              userSelect: "none",
            }}
          >
            β
          </Box>
        </Box>
      </Zoom>

      {(everOpened || open || prefillMessage || backgroundMessage) && (
        <Suspense fallback={null}>
          <ChatDrawer
            open={open}
            onClose={() => setOpen(false)}
            feedLoaded={feedLoaded}
            feedEpoch={feedEpoch}
            features={features}
            language={language}
            sessionContext={sessionContext}
            prefillMessage={prefillMessage}
            onPrefillConsumed={() => setPrefillMessage(null)}
            backgroundMessage={backgroundMessage}
            onBackgroundConsumed={() => setBackgroundMessage(null)}
            onTurnComplete={handleTurnComplete}
            autoPlan={autoPlan}
            onToggleAutoPlan={setAutoPlan}
          />
        </Suspense>
      )}
    </>
  );
}
