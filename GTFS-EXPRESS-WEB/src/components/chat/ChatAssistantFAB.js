/**
 * ChatAssistantFAB — the reader's assistant: its drawer and what opens it, without a button of its own since
 * 2026-10-13 (the owner: the floating button repeated the toolbar's « Assistant », edit/ModifyMenu's
 * AssistantButton, which opens it by CHAT_OPEN_EVENT like every other surface).
 *
 * Visibility gate:
 *   1. server features.chat.enabled === true  (NL2SQL_CHAT_ENABLED + key)
 *   2. AND a feed has been loaded             (no point asking about nothing)
 *
 * Access (on open): the server decides. The open model serves everyone;
 * under the paid offer a licence holding "studio" gets the full assistant, anyone else the free messages
 * (their end: UpsellPanel in the drawer). Only when the paid offer closes the
 * assistant and grants no free message does the request open the offer
 * (openPaywall) — or, where the reading companion waits for an account, the sign-in — instead of the drawer; a
 * refusal the server answers anyway (402) opens it by itself (fetchWithSession's PAYWALL_EVENT).
 *
 * What the button said, the toolbar's « Assistant » says now (useAssistantNudge): its tooltip — the reading
 * companion's sign-in, the offer, or the plain hint — and the badge of a repair plan prepared in the background.
 */

import React, { Suspense, lazy, useCallback, useEffect, useRef, useState } from "react";
import { useLanguage } from "../../contexts/LanguageContext";
import { licenceLockOf, openPaywall, useFeatures } from "../../utils/featuresApi";
import { useAccount } from "../../contexts/AccountContext";
// The drawer (the conversation, its charts) loads the first time it opens: never in the app's first chunk.
const ChatDrawer = lazy(() => import("./ChatDrawer"));

/**
 * What the toolbar's « Assistant » says of the assistant (AssistantButton): { tooltip, plan } — `plan` the repair
 * plan prepared in the background, { proposals } until the drawer opens. One value for the app, read by a hook.
 */
let nudge = null;
const nudgeListeners = new Set();
const setNudge = (next) => {
  nudge = next;
  nudgeListeners.forEach((fn) => fn(next));
};
export function useAssistantNudge() {
  const [value, setValue] = useState(nudge);
  useEffect(() => {
    nudgeListeners.add(setValue);
    setValue(nudge);
    return () => nudgeListeners.delete(setValue);
  }, []);
  return value;
}

/**
 * Under the paid offer, what keeps the assistant closed to this person: "sign_in_required" |
 * "subscription_required", or null (the drawer opens; the server decides). The reading companion
 * (features.chat.reader) opens it to an account with free questions left this month, and asks a visitor to sign in.
 */
export const closedAssistant = (features) => {
  const lock = licenceLockOf(features?.access);
  if (lock !== "sign_in_required" && lock !== "subscription_required") return null;
  const reader = features?.chat?.reader || null;
  if (reader) return reader.signInRequired ? "sign_in_required" : reader.remaining > 0 ? null : "subscription_required";
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

  // The assistant closed by the paid offer (no licence, no free message): the click opens the offer — or, where the
  // reading companion waits for an account, the sign-in, saying what it brings.
  const closedBy = closedAssistant(features);
  const { openAccountDialog } = useAccount();
  const readerSignIn = closedBy === "sign_in_required" && features?.chat?.reader?.signInRequired ? features.chat.reader : null;
  const unlock = useCallback(() => {
    if (readerSignIn) openAccountDialog({ tab: "signin", reason: { kind: "reader", limit: readerSignIn.limit } });
    else openPaywall("studio", closedBy, () => window.dispatchEvent(new CustomEvent(CHAT_OPEN_EVENT)));
  }, [readerSignIn, closedBy, openAccountDialog]);

  // External open requests (validation page "Ask AI"): the message is kept
  // pending for the drawer, or the offer opens when the assistant is closed.
  useEffect(() => {
    if (!visible) return undefined;
    const handler = (e) => {
      const message = e?.detail?.message;
      if (typeof message === "string" && message.trim().length >= 2) {
        setPrefillMessage(message);
      }
      if (closedBy) unlock();
      else setOpen(true);
    };
    window.addEventListener(CHAT_OPEN_EVENT, handler);
    return () => window.removeEventListener(CHAT_OPEN_EVENT, handler);
  }, [visible, closedBy, unlock]);

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

  const showPlanBadge = Boolean(planReady) && !open;
  const tooltip = showPlanBadge
    ? planReady.proposals > 0
      ? t("chat.fab.planReady", { count: planReady.proposals })
      : t("chat.fab.planEmpty")
    : readerSignIn
      ? t("chat.reader.signIn", { count: readerSignIn.limit })
      : closedBy
        ? t("paywall.lock.studio")
        : t("chat.fab.tooltip");
  const planCount = showPlanBadge ? planReady.proposals : null;
  // Said to the toolbar's « Assistant » while the assistant can be opened here.
  useEffect(() => {
    setNudge(visible ? { tooltip, plan: planCount === null ? null : { proposals: planCount } } : null);
  }, [visible, tooltip, planCount]);
  useEffect(() => () => setNudge(null), []);

  if (!visible) return null;

  return (
    <>
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
