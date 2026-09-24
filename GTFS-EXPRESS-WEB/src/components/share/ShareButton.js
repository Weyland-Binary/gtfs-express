/**
 * ShareButton — a public link to the loaded feed, and its next versions.
 * One click creates a read-only snapshot (the edited state when editing)
 * behind a token and shows the link, the hosted GTFS zip and what the
 * visitor will see. A share this browser created can be re-published as
 * a new version (same link, same zip URL, a changelog): the publication
 * pipeline of a small operator, without an account.
 */

import React, { useCallback, useState } from "react";
import { Box, Button, Chip, CircularProgress, Dialog, IconButton, Link, TextField, Tooltip, Typography, alpha, useTheme } from "@mui/material";
import ShareOutlinedIcon from "@mui/icons-material/ShareOutlined";
import ContentCopyIcon from "@mui/icons-material/ContentCopy";
import CheckCircleOutlineIcon from "@mui/icons-material/CheckCircleOutline";
import DownloadOutlinedIcon from "@mui/icons-material/DownloadOutlined";
import PublishOutlinedIcon from "@mui/icons-material/PublishOutlined";
import { useLanguage } from "../../contexts/LanguageContext";
import { createShare, publishShareVersion, rememberedShares, forgetShare, shareUrl, shareZipUrl } from "../../utils/shareApi";

export default function ShareButton() {
  const { t } = useLanguage();
  const theme = useTheme();
  const [open, setOpen] = useState(false);
  const [state, setState] = useState({ status: "idle" }); // idle | choose | loading | done | error
  const [copied, setCopied] = useState(false);
  const [note, setNote] = useState("");

  const createNew = useCallback(async () => {
    setCopied(false);
    setState({ status: "loading" });
    try {
      const res = await createShare();
      setState({ status: "done", token: res.token, expiresAt: res.expiresAt, card: res.card, version: 1 });
    } catch (err) {
      setState({ status: "error", error: err.message });
    }
  }, []);

  const publish = useCallback(
    async (entry) => {
      setCopied(false);
      setState({ status: "loading" });
      try {
        const res = await publishShareVersion(entry.token, entry.secret, note.trim() || null);
        setState({ status: "done", token: res.token, expiresAt: res.card.expiresAt, card: res.card, version: res.version.n, changelog: res.version.changelog });
      } catch (err) {
        if (err.status === 404 || err.status === 403) forgetShare(entry.token);
        setState({ status: "error", error: err.status === 404 ? t("share.notFound") : err.message });
      }
    },
    [note, t],
  );

  const start = useCallback(() => {
    setOpen(true);
    setCopied(false);
    setNote("");
    const mine = rememberedShares();
    if (mine.length) setState({ status: "choose", mine });
    else createNew();
  }, [createNew]);

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
          {state.status === "choose" && (
            <Box sx={{ display: "flex", flexDirection: "column", gap: 0.75 }} data-testid="share-choose">
              <Typography sx={{ fontSize: "0.76rem", fontWeight: 700 }}>{t("share.publishTo")}</Typography>
              <TextField size="small" fullWidth placeholder={t("share.notePlaceholder")} value={note} onChange={(e) => setNote(e.target.value.slice(0, 500))} inputProps={{ "data-testid": "share-note" }} />
              {state.mine.slice(0, 5).map((s) => (
                <Button key={s.token} size="small" variant="outlined" startIcon={<PublishOutlinedIcon />} onClick={() => publish(s)} data-testid="share-publish" sx={{ textTransform: "none", fontWeight: 700, justifyContent: "flex-start" }}>
                  {t("share.publishVersion", { title: s.title || s.token.slice(0, 8) })}
                </Button>
              ))}
              <Button size="small" variant="text" onClick={createNew} data-testid="share-new" sx={{ textTransform: "none", alignSelf: "flex-start" }}>
                {t("share.newLink")}
              </Button>
            </Box>
          )}
          {state.status === "loading" && (
            <Box sx={{ display: "flex", alignItems: "center", gap: 1, fontSize: "0.8rem" }}>
              <CircularProgress size={16} /> {t("share.creating")}
            </Box>
          )}
          {state.status === "error" && <Typography sx={{ fontSize: "0.8rem", color: "error.main" }}>{state.error}</Typography>}
          {state.status === "done" && (
            <>
              {state.version > 1 && (
                <Chip size="small" color="success" variant="outlined" icon={<PublishOutlinedIcon sx={{ fontSize: 14 }} />} label={t("share.published", { version: state.version })} data-testid="share-version" sx={{ alignSelf: "flex-start", height: 22, fontSize: "0.68rem", fontWeight: 700 }} />
              )}
              {state.changelog && (
                <Typography sx={{ fontSize: "0.72rem", color: "text.secondary" }} data-testid="share-changelog">
                  {t("share.changelog", { routes: state.changelog.counts?.routes ?? 0, stops: state.changelog.counts?.stops ?? 0, trips: state.changelog.counts?.trips ?? 0 })}
                  {state.changelog.routes?.added?.length ? ` · + ${state.changelog.routes.added.join(", ")}` : ""}
                  {state.changelog.routes?.removed?.length ? ` · − ${state.changelog.routes.removed.join(", ")}` : ""}
                </Typography>
              )}
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
