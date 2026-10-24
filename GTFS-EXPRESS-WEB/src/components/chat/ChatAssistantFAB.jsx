/**
 * The reader's assistant panel and what opens or closes it (CHAT_OPEN_EVENT, CHAT_CLOSE_EVENT); it has no button of
 * its own: the toolbar's « Assistant » reads its tooltip and whether it is open through useAssistantNudge. Shown once
 * the server enables the chat and a feed is loaded; the server decides access, and a closed assistant opens the offer
 * or the sign-in instead.
 */

import React, { Suspense, lazy, useCallback, useEffect, useState } from "react";
import { useLanguage } from "../../contexts/LanguageContext";
import { licenceLockOf, openPaywall, useFeatures } from "../../utils/featuresApi";
import { useAccount } from "../../contexts/AccountContext";
import { CHAT_CLOSE_EVENT, CHAT_OPEN_EVENT } from "../../utils/appEvents";
// Loaded the first time it opens: never in the app's first chunk.
const ChatDrawer = lazy(() => import("./ChatDrawer"));

/** { tooltip, open }: one value for the app. */
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
 * "sign_in_required" | "subscription_required" when the paid offer keeps the assistant closed, else null (the server
 * decides). The reading companion opens it to an account with questions left this month.
 */
export const closedAssistant = (features) => {
  const lock = licenceLockOf(features?.access);
  if (lock !== "sign_in_required" && lock !== "subscription_required") return null;
  const reader = features?.chat?.reader || null;
  if (reader) return reader.signInRequired ? "sign_in_required" : reader.remaining > 0 ? null : "subscription_required";
  return features?.chat?.freeMessages > 0 ? null : lock;
};

// detail: { message? }, sent at once when the panel opens.

export default function ChatAssistantFAB({ feedLoaded, feedEpoch, language, sessionContext = null, host = null }) {
  const { t } = useLanguage();
  const { features, loaded } = useFeatures();
  const [open, setOpen] = useState(false);
  // Mounted from its first opening on, so the conversation stays while closed.
  const [everOpened, setEverOpened] = useState(false);
  useEffect(() => {
    if (open) setEverOpened(true);
  }, [open]);
  const [prefillMessage, setPrefillMessage] = useState(null);

  const enabled = loaded && features?.chat?.enabled === true;
  const visible = enabled && feedLoaded;

  const closedBy = closedAssistant(features);
  const { openAccountDialog } = useAccount();
  const readerSignIn = closedBy === "sign_in_required" && features?.chat?.reader?.signInRequired ? features.chat.reader : null;
  const unlock = useCallback(() => {
    if (readerSignIn) openAccountDialog({ tab: "signin", reason: { kind: "reader", limit: readerSignIn.limit } });
    else openPaywall("studio", closedBy, () => window.dispatchEvent(new CustomEvent(CHAT_OPEN_EVENT)));
  }, [readerSignIn, closedBy, openAccountDialog]);

  useEffect(() => {
    if (!visible) return undefined;
    const onOpen = (e) => {
      const message = e?.detail?.message;
      if (typeof message === "string" && message.trim().length >= 2) setPrefillMessage(message);
      if (closedBy) unlock();
      else setOpen(true);
    };
    const onClose = () => setOpen(false);
    window.addEventListener(CHAT_OPEN_EVENT, onOpen);
    window.addEventListener(CHAT_CLOSE_EVENT, onClose);
    return () => {
      window.removeEventListener(CHAT_OPEN_EVENT, onOpen);
      window.removeEventListener(CHAT_CLOSE_EVENT, onClose);
    };
  }, [visible, closedBy, unlock]);

  useEffect(() => {
    if (!visible) setOpen(false);
  }, [visible]);

  const tooltip = readerSignIn ? t("chat.reader.signIn", { count: readerSignIn.limit }) : closedBy ? t("paywall.lock.studio") : t("chat.fab.tooltip");
  useEffect(() => {
    setNudge(visible ? { tooltip, open } : null);
  }, [visible, tooltip, open]);
  useEffect(() => () => setNudge(null), []);

  if (!visible || !(everOpened || open || prefillMessage)) return null;
  return (
    <Suspense fallback={null}>
      <ChatDrawer
        open={open}
        onClose={() => setOpen(false)}
        host={host}
        feedLoaded={feedLoaded}
        feedEpoch={feedEpoch}
        features={features}
        language={language}
        sessionContext={sessionContext}
        prefillMessage={prefillMessage}
        onPrefillConsumed={() => setPrefillMessage(null)}
      />
    </Suspense>
  );
}
