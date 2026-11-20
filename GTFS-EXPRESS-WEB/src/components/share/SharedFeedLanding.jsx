/** What a visitor sees on a share link: the feed's card, then explore it (their own copy) or download the GTFS. */

import React, { useEffect, useRef, useState } from "react";
import { Box, Button, Chip, CircularProgress, Link, Typography, alpha, useTheme } from "@mui/material";
import ExploreOutlinedIcon from "@mui/icons-material/ExploreOutlined";
import DownloadOutlinedIcon from "@mui/icons-material/DownloadOutlined";
import CheckCircleOutlineIcon from "@mui/icons-material/CheckCircleOutline";
import ErrorOutlineIcon from "@mui/icons-material/ErrorOutline";
import TroubleshootOutlinedIcon from "@mui/icons-material/TroubleshootOutlined";
import { useLanguage } from "../../contexts/LanguageContext";
import { useDestructiveGuard } from "../../contexts/DestructiveGuardContext";
import { fetchShareCard, openShare, shareZipUrl } from "../../utils/shareApi";

export default function SharedFeedLanding({ token, onOpened, onCancel }) {
  const { t } = useLanguage();
  const { isDirty } = useDestructiveGuard();
  const theme = useTheme();
  const [card, setCard] = useState(undefined); // undefined: loading, null: not found
  const [error, setError] = useState(null);
  const [opening, setOpening] = useState(false);
  const aliveRef = useRef(true);
  useEffect(() => {
    aliveRef.current = true;
    return () => {
      aliveRef.current = false;
    };
  }, []);

  useEffect(() => {
    let alive = true;
    fetchShareCard(token)
      .then((c) => alive && setCard(c))
      .catch((err) => alive && setError(err.message));
    return () => {
      alive = false;
    };
  }, [token]);

  const explore = async () => {
    setOpening(true);
    setError(null);
    try {
      const result = await openShare(token);
      // The app adopts the copy behind its discard guard. With unsaved edits the guard asks first and answers
      // nothing (or `false`): the button comes back, the person may say no. Otherwise the adoption runs at once
      // and replaces this page; a `false` answer still gives the button back.
      const dirty = isDirty();
      const outcome = await onOpened(result);
      if (aliveRef.current && (outcome === false || (dirty && outcome === undefined))) setOpening(false);
    } catch (err) {
      if (!aliveRef.current) return;
      setError(err.status === 503 ? t("share.capacity") : err.message);
      setOpening(false);
    }
  };

  const wrap = (children) => (
    <Box data-testid="share-landing" sx={{ maxWidth: 560, mx: "auto", mt: { xs: 3, md: 6 }, p: 3, borderRadius: 3, border: `1px solid ${alpha(theme.palette.primary.main, 0.25)}`, background: alpha(theme.palette.primary.main, 0.03), display: "flex", flexDirection: "column", gap: 1.5 }}>
      {children}
    </Box>
  );

  if (card === undefined && !error) return wrap(<Box sx={{ display: "flex", alignItems: "center", gap: 1 }}><CircularProgress size={18} /> {t("share.loading")}</Box>);
  if (card === null || (error && card === undefined))
    return wrap(
      <>
        <Typography sx={{ fontWeight: 800, fontSize: "1.05rem" }}>{t("share.notFound")}</Typography>
        <Typography sx={{ fontSize: "0.82rem", color: "text.secondary" }}>{error || t("share.notFoundHint")}</Typography>
        <Button size="small" onClick={onCancel} sx={{ alignSelf: "flex-start", textTransform: "none" }} data-testid="share-cancel">
          {t("share.backToUpload")}
        </Button>
      </>,
    );

  const v = card.validation;
  return wrap(
    <>
      <Box>
        <Typography sx={{ fontSize: "0.72rem", fontWeight: 700, color: "primary.main", textTransform: "uppercase", letterSpacing: 0.5 }}>{t("share.landingKicker")}</Typography>
        <Typography sx={{ fontWeight: 900, fontSize: "1.35rem", lineHeight: 1.2 }} data-testid="share-landing-title">
          {card.title}
        </Typography>
      </Box>
      <Box sx={{ display: "flex", flexWrap: "wrap", gap: 0.6 }}>
        <Chip size="small" label={t("share.counts", { routes: card.counts?.routes ?? 0, stops: card.counts?.stops ?? 0, trips: card.counts?.trips ?? 0 })} sx={{ height: 24, fontSize: "0.72rem", fontWeight: 600 }} />
        {v && <Chip size="small" icon={v.errors ? <ErrorOutlineIcon sx={{ fontSize: 14 }} /> : <CheckCircleOutlineIcon sx={{ fontSize: 14 }} />} color={v.errors ? "error" : "success"} variant="outlined" label={v.errors ? t("report.validation.errors", { errors: v.errors, warnings: v.warnings }) : t("report.validation.ok", { warnings: v.warnings })} data-testid="share-validation" sx={{ height: 24, fontSize: "0.7rem", fontWeight: 700 }} />}
        {card.audit && <Chip size="small" icon={<TroubleshootOutlinedIcon sx={{ fontSize: 14 }} />} variant="outlined" color={card.audit.warning ? "warning" : "default"} label={t("report.audit", { warnings: card.audit.warning ?? 0, infos: card.audit.info ?? 0 })} sx={{ height: 24, fontSize: "0.7rem" }} />}
      </Box>
      {card.versions?.length > 1 && (
        <Box sx={{ display: "flex", flexDirection: "column", gap: 0.3, fontSize: "0.72rem" }} data-testid="share-versions">
          <Typography sx={{ fontSize: "0.7rem", fontWeight: 700, color: "text.secondary", textTransform: "uppercase", letterSpacing: 0.3 }}>{t("share.versions", { count: card.versions.length })}</Typography>
          {[...card.versions].reverse().slice(0, 5).map((v) => (
            <Box key={v.n} sx={{ display: "flex", gap: 0.75, alignItems: "baseline" }}>
              <strong>v{v.n}</strong>
              <span style={{ color: theme.palette.text.secondary }}>{new Date(v.createdAt).toLocaleDateString()}</span>
              <span style={{ flex: 1, minWidth: 0, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{v.note || (v.changelog ? t("share.changelog", { routes: v.changelog.counts?.routes ?? 0, stops: v.changelog.counts?.stops ?? 0, trips: v.changelog.counts?.trips ?? 0 }) : "")}</span>
              {v.n !== card.current_version && (
                <Link href={`${shareZipUrl(token)}?v=${v.n}`} underline="hover" sx={{ fontSize: "0.68rem" }}>
                  zip
                </Link>
              )}
            </Box>
          ))}
        </Box>
      )}
      {error && <Typography sx={{ fontSize: "0.8rem", color: "error.main" }}>{error}</Typography>}
      <Box sx={{ display: "flex", gap: 1, flexWrap: "wrap", alignItems: "center" }}>
        <Button variant="contained" disableElevation disabled={opening} onClick={explore} startIcon={opening ? <CircularProgress size={14} color="inherit" /> : <ExploreOutlinedIcon />} data-testid="share-explore" sx={{ textTransform: "none", fontWeight: 800 }}>
          {opening ? t("share.opening") : t("share.explore")}
        </Button>
        <Button variant="outlined" href={shareZipUrl(token)} startIcon={<DownloadOutlinedIcon />} data-testid="share-download" sx={{ textTransform: "none", fontWeight: 700 }}>
          {t("share.download")}
        </Button>
        <Box sx={{ flex: 1 }} />
        <Button size="small" onClick={onCancel} sx={{ textTransform: "none" }} data-testid="share-cancel">
          {t("share.backToUpload")}
        </Button>
      </Box>
      <Typography sx={{ fontSize: "0.66rem", color: "text.disabled" }}>
        {t("share.landingFoot")}
      </Typography>
    </>,
  );
}
