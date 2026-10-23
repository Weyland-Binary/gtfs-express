/**
 * The way back from the payment provider (?billing=success|cancel|portal), said once and taken out of the address so
 * Back never replays it. A success is never assumed from the return alone: the account is read again until the
 * server's webhook made the subscription active (about 30 s).
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
  // Read once: the effect below may run twice under React's strict mode.
  const outcomeRef = useRef(undefined);
  if (outcomeRef.current === undefined) outcomeRef.current = billingReturnOf();
  // Through refs: a language switched or the account read again never cuts the polling short.
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
