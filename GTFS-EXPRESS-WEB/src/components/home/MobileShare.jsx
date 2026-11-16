/** The phone's way to hand the product over to a computer: its share sheet, else the link copied (Home, the relay). */

import React, { useCallback, useState } from "react";
import { Button, Snackbar, alpha, useTheme } from "@mui/material";
import IosShareRoundedIcon from "@mui/icons-material/IosShareRounded";
import { useLanguage } from "../../contexts/LanguageContext";
import { copyLink, linkForComputer, sendToComputer } from "../../utils/sendToComputer";
import { trackUi } from "../../utils/uiTelemetry";

export function useSendToComputer(source, link = null) {
  const { t } = useLanguage();
  const [note, setNote] = useState(null);
  const send = useCallback(async () => {
    trackUi("mobile.share", source);
    const url = link || linkForComputer();
    const outcome = await sendToComputer({ url, title: "GTFS Express", text: t("mobile.share.text") });
    if (outcome === "copied") setNote(t("mobile.copied"));
    else if (outcome === "failed") setNote(url);
  }, [source, link, t]);
  // Refused (a page served over plain http, a browser that blocks it): the link is shown to be copied by hand.
  const copy = useCallback(async () => {
    const url = link || linkForComputer();
    const outcome = await copyLink(url);
    if (outcome === "failed") setNote(url);
    return outcome;
  }, [link]);
  const snackbar = <Snackbar open={Boolean(note)} autoHideDuration={4000} onClose={() => setNote(null)} message={note} anchorOrigin={{ vertical: "bottom", horizontal: "center" }} data-testid="mobile-share-note" />;
  return { send, copy, snackbar };
}

export function ShareButton({ onClick, onBlue = false, sx = {} }) {
  const theme = useTheme();
  const { t } = useLanguage();
  const dark = theme.palette.mode === "dark";
  const filled = onBlue ? { color: dark ? theme.palette.primary.contrastText : theme.palette.primary.dark, backgroundColor: dark ? theme.palette.primary.main : theme.palette.common.white } : { color: theme.palette.primary.contrastText, backgroundColor: theme.palette.primary.main, boxShadow: `0 10px 24px ${alpha(theme.palette.primary.main, 0.28)}` };
  return (
    <Button onClick={onClick} startIcon={<IosShareRoundedIcon />} data-testid="mobile-share" sx={{ minHeight: 54, py: 1.25, borderRadius: "14px", textTransform: "none", fontSize: "1rem", lineHeight: 1.3, fontWeight: 700, ...filled, "&:hover": filled, ...sx }}>
      {t("mobile.share")}
    </Button>
  );
}

