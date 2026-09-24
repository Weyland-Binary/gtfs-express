/**
 * ShareButton — a public link to the loaded feed. One click creates a
 * read-only snapshot (the edited state when editing) behind a token and
 * shows the link, the hosted GTFS zip and what the visitor will see. The
 * link lives 90 days; every visitor gets their own copy to explore.
 */

import React, { useCallback, useState } from "react";
import { Box, Button, Chip, CircularProgress, Dialog, IconButton, Link, TextField, Tooltip, Typography, alpha, useTheme } from "@mui/material";
import ShareOutlinedIcon from "@mui/icons-material/ShareOutlined";
import ContentCopyIcon from "@mui/icons-material/ContentCopy";
import CheckCircleOutlineIcon from "@mui/icons-material/CheckCircleOutline";
import DownloadOutlinedIcon from "@mui/icons-material/DownloadOutlined";
import { useLanguage } from "../../contexts/LanguageContext";
import { createShare, shareUrl, shareZipUrl } from "../../utils/shareApi";

export default function ShareButton() {
  const { t } = useLanguage();
  const theme = useTheme();
  const [open, setOpen] = useState(false);
  const [state, setState] = useState({ status: "idle" }); // idle | loading | done | error
  const [copied, setCopied] = useState(false);

  const start = useCallback(async () => {
    setOpen(true);
    setCopied(false);
    setState({ status: "loading" });
    try {
      const res = await createShare();
      setState({ status: "done", token: res.token, expiresAt: res.expiresAt, card: res.card });
    } catch (err) {
      setState({ status: "error", error: err.message });
    }
  }, []);

  const copy = async () => {
    if (state.status !== "done") return;
    try {
      await navigator.clipboard.writeText(shareUrl(state.token));
      setCopied(true);
    } catch {
      /* clipboard unavailable: the field is selectable */
    }
  };

  const card = state.card;
  return (
    <>
      <Tooltip title={t("share.button")}>
        <IconButton size="small" onClick={start} data-testid="share-network" aria-label={t("share.button")} sx={{ padding: 1, borderRadius: 2.5 }}>
          <ShareOutlinedIcon sx={{ fontSize: 20 }} />
        </IconButton>
      </Tooltip>
      <Dialog open={open} onClose={() => setOpen(false)} maxWidth="xs" fullWidth data-testid="share-dialog">
        <Box sx={{ p: 2.5, display: "flex", flexDirection: "column", gap: 1.25 }}>
          <Box sx={{ display: "flex", alignItems: "center", gap: 1 }}>
            <ShareOutlinedIcon sx={{ color: theme.palette.primary.main }} />
            <Typography sx={{ fontWeight: 800, fontSize: "1rem" }}>{t("share.title")}</Typography>
          </Box>
          <Typography sx={{ fontSize: "0.78rem", color: "text.secondary", lineHeight: 1.5 }}>{t("share.intro")}</Typography>
          {state.status === "loading" && (
            <Box sx={{ display: "flex", alignItems: "center", gap: 1, fontSize: "0.8rem" }}>
              <CircularProgress size={16} /> {t("share.creating")}
            </Box>
          )}
          {state.status === "error" && <Typography sx={{ fontSize: "0.8rem", color: "error.main" }}>{state.error}</Typography>}
          {state.status === "done" && (
            <>
              <Box sx={{ display: "flex", gap: 0.5, alignItems: "center" }}>
                <TextField size="small" fullWidth value={shareUrl(state.token)} InputProps={{ readOnly: true }} inputProps={{ "data-testid": "share-link", onFocus: (e) => e.target.select() }} />
                <Tooltip title={copied ? t("share.copied") : t("share.copy")}>
                  <IconButton size="small" onClick={copy} data-testid="share-copy" color={copied ? "success" : "default"}>
                    {copied ? <CheckCircleOutlineIcon /> : <ContentCopyIcon />}
                  </IconButton>
                </Tooltip>
              </Box>
              {card && (
                <Box sx={{ display: "flex", flexWrap: "wrap", gap: 0.5, px: 1, py: 0.75, borderRadius: 1.5, background: alpha(theme.palette.primary.main, 0.05) }}>
                  <Typography sx={{ fontSize: "0.76rem", fontWeight: 700, width: "100%" }} noWrap>
                    {card.title}
                  </Typography>
                  <Chip size="small" label={t("share.counts", { routes: card.counts?.routes ?? 0, stops: card.counts?.stops ?? 0, trips: card.counts?.trips ?? 0 })} sx={{ height: 20, fontSize: "0.64rem" }} />
                  {card.design?.score != null && <Chip size="small" color="primary" variant="outlined" label={t("share.quality", { score: card.design.score })} sx={{ height: 20, fontSize: "0.64rem", fontWeight: 700 }} />}
                  {card.validation && <Chip size="small" color={card.validation.errors ? "error" : "success"} variant="outlined" label={card.validation.errors ? t("report.validation.errors", { errors: card.validation.errors, warnings: card.validation.warnings }) : t("report.validation.ok", { warnings: card.validation.warnings })} sx={{ height: 20, fontSize: "0.64rem" }} />}
                </Box>
              )}
              <Typography sx={{ fontSize: "0.72rem", color: "text.secondary" }}>
                {t("share.expires", { date: new Date(state.expiresAt).toLocaleDateString() })} ·{" "}
                <Link href={shareZipUrl(state.token)} underline="hover" data-testid="share-zip" sx={{ display: "inline-flex", alignItems: "center", gap: 0.3 }}>
                  <DownloadOutlinedIcon sx={{ fontSize: 14 }} /> {t("share.zip")}
                </Link>
              </Typography>
            </>
          )}
          <Box sx={{ display: "flex", justifyContent: "flex-end", gap: 1 }}>
            <Button size="small" onClick={() => setOpen(false)} sx={{ textTransform: "none" }}>
              {t("app.close")}
            </Button>
            {state.status === "done" && (
              <Button size="small" variant="contained" disableElevation onClick={copy} startIcon={<ContentCopyIcon />} sx={{ textTransform: "none", fontWeight: 700 }}>
                {copied ? t("share.copied") : t("share.copy")}
              </Button>
            )}
          </Box>
        </Box>
      </Dialog>
    </>
  );
}
