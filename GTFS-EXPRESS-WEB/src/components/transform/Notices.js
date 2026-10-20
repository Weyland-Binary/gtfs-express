/**
 * Notices — the draft's own words over its checks in the decision: the plan's notice (restored, carried, the
 * browser's storage refused) and the last error, said in the person's words. A failure whose action is the offer
 * (the assistant's envelope, the trial) opens the offer from here, as every other lock of the app does
 * (featuresApi.openPaywall). Every value and handler is the studio's (ChangeStudio), given as props.
 */

import React from "react";
import { Alert, Box, Button } from "@mui/material";
import { useLanguage } from "../../contexts/LanguageContext";
import { openPaywall } from "../../utils/featuresApi";

/** A failure as the studio holds it — humanError's answer ({ title, message, action, offer }) or a plain sentence. */
function HumanErrorAlert({ error, onClose = null, testid = "change-error", sx = {} }) {
  if (!error) return null;
  const human = typeof error === "object" ? error : { message: String(error) };
  return (
    <Alert severity="error" sx={{ fontSize: "0.78rem", ...sx }} onClose={onClose || undefined} data-testid={testid} data-code={human.code || undefined} action={human.offer ? <Button color="inherit" size="small" onClick={() => openPaywall("studio")} data-testid={`${testid}-offer`} sx={{ textTransform: "none", fontWeight: 700, whiteSpace: "nowrap" }}>{human.action}</Button> : undefined}>
      {human.title ? <Box component="span" sx={{ fontWeight: 700, mr: 0.5 }}>{human.title}</Box> : null}
      {human.message}
    </Alert>
  );
}

/** The plan's notice and the last error. */
export default function Notices({ notice = null, onCloseNotice, error = null, onCloseError }) {
  const { t } = useLanguage();
  return (
    <>
      {notice && (
        <Alert severity={notice.severity || "info"} sx={{ mb: 1, fontSize: "0.76rem" }} onClose={onCloseNotice} data-testid={`change-notice-${notice.kind}`}>
          {t(`transform.notice.${notice.kind}`, notice.params)}
        </Alert>
      )}
      {error && <HumanErrorAlert error={error} onClose={onCloseError} sx={{ mb: 1 }} />}
    </>
  );
}
