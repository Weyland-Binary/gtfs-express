/**
 * BillingReturn — the way back from the payment provider (?billing=…), said
 * once and taken out of the address (Back never replays it):
 *
 *   success  the payment is done; the subscription opens when the server's
 *            webhook says so — usually within seconds: the account and the
 *            access object are read again until it is active (about 30 s),
 *            then « Abonnement activé ». Never assumed from the return alone.
 *   cancel   nothing was charged
 *   portal   back from managing it: read again, silently
 *
 * Mounted by the AccountProvider while accounts are on.
 */

import React, { useEffect, useRef, useState } from "react";
import { Alert, Snackbar } from "@mui/material";
import { useLanguage } from "../../contexts/LanguageContext";
import { useAccount } from "../../contexts/AccountContext";
import { refreshFeatures } from "../../utils/featuresApi";
import { billingReturnOf, clearBillingReturn } from "../../utils/billingApi";

const POLL_MS = 2000;
const POLL_TRIES = 15;

export default function BillingReturn() {
  const { t } = useLanguage();
  const { refresh, loaded } = useAccount();
  const [notice, setNotice] = useState(null); // { severity, text }
  // The return, read once from the address (the effect below may run twice: React's strict mode).
  const outcomeRef = useRef(undefined);
  if (outcomeRef.current === undefined) outcomeRef.current = billingReturnOf();
  // Read through refs: a language switched or the account read again never cuts the look short.
  const refreshRef = useRef(refresh);
  refreshRef.current = refresh;
  const tRef = useRef(t);
  tRef.current = t;

  useEffect(() => {
    const outcome = outcomeRef.current;
    if (!loaded || !outcome) return undefined;
    clearBillingReturn();
    if (outcome === "cancel") {
      setNotice({ severity: "info", text: tRef.current("billing.return.cancel") });
      return undefined;
    }
    let cancelled = false;
    let timer = null;
    let tries = 0;
    const look = async () => {
      if (cancelled) return;
      tries += 1;
      const user = await refreshRef.current().catch(() => null);
      await refreshFeatures().catch(() => null);
      if (cancelled) return;
      if (user?.subscription?.active) {
        if (outcome === "success") setNotice({ severity: "success", text: tRef.current("billing.return.active") });
        return;
      }
      if (outcome !== "success") return;
      if (tries >= POLL_TRIES) {
        setNotice({ severity: "info", text: tRef.current("billing.return.pending") });
        return;
      }
      timer = setTimeout(look, POLL_MS);
    };
    if (outcome === "success") setNotice({ severity: "info", text: tRef.current("billing.return.activating"), sticky: true });
    look();
    return () => {
      cancelled = true;
      if (timer) clearTimeout(timer);
    };
  }, [loaded]);

  return (
    <Snackbar open={Boolean(notice)} onClose={(e, reason) => reason !== "clickaway" && setNotice(null)} autoHideDuration={notice?.sticky ? null : 8000} anchorOrigin={{ vertical: "bottom", horizontal: "center" }}>
      {notice ? (
        <Alert severity={notice.severity} variant="filled" onClose={() => setNotice(null)} data-testid="billing-return" sx={{ fontWeight: 600 }}>
          {notice.text}
        </Alert>
      ) : (
        <span />
      )}
    </Snackbar>
  );
}
