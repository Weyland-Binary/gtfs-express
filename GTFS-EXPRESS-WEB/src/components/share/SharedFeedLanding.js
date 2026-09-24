/**
 * SharedFeedLanding — what a visitor sees when they open a share link: the
 * feed's card (title, size, GTFS validation, Diagnostic, design quality and
 * operations when the network was designed here, data sources) and two
 * actions: explore it in the application (their own copy) or download the
 * GTFS. No account, nothing to install.
 */

import React, { useEffect, useState } from "react";
import { Box, Button, Chip, CircularProgress, Link, Typography, alpha, useTheme } from "@mui/material";
import ExploreOutlinedIcon from "@mui/icons-material/ExploreOutlined";
import DownloadOutlinedIcon from "@mui/icons-material/DownloadOutlined";
import CheckCircleOutlineIcon from "@mui/icons-material/CheckCircleOutline";
import ErrorOutlineIcon from "@mui/icons-material/ErrorOutline";
import TroubleshootOutlinedIcon from "@mui/icons-material/TroubleshootOutlined";
import DirectionsBusFilledOutlinedIcon from "@mui/icons-material/DirectionsBusFilledOutlined";
import { useLanguage } from "../../contexts/LanguageContext";
import { fetchShareCard, openShare, shareZipUrl } from "../../utils/shareApi";
import { qualityColor, fmtMoney } from "../network/PlanCards";

export default function SharedFeedLanding({ token, onOpened, onCancel }) {
  const { t } = useLanguage();
  const theme = useTheme();
  const [card, setCard] = useState(undefined); // undefined: loading, null: not found
  const [error, setError] = useState(null);
  const [opening, setOpening] = useState(false);

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
      onOpened(result);
    } catch (err) {
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
  const d = card.design;
  const ops = d?.operations;
  return wrap(
    <>
      <Box>
        <Typography sx={{ fontSize: "0.72rem", fontWeight: 700, color: "primary.main", textTransform: "uppercase", letterSpacing: 0.5 }}>{t("share.landingKicker")}</Typography>
        <Typography sx={{ fontWeight: 900, fontSize: "1.35rem", lineHeight: 1.2 }} data-testid="share-landing-title">
          {card.title}
        </Typography>
        {card.requirements?.area && <Typography sx={{ fontSize: "0.82rem", color: "text.secondary" }}>{card.requirements.area}</Typography>}
      </Box>
      <Box sx={{ display: "flex", flexWrap: "wrap", gap: 0.6 }}>
        <Chip size="small" label={t("share.counts", { routes: card.counts?.routes ?? 0, stops: card.counts?.stops ?? 0, trips: card.counts?.trips ?? 0 })} sx={{ height: 24, fontSize: "0.72rem", fontWeight: 600 }} />
        {v && <Chip size="small" icon={v.errors ? <ErrorOutlineIcon sx={{ fontSize: 14 }} /> : <CheckCircleOutlineIcon sx={{ fontSize: 14 }} />} color={v.errors ? "error" : "success"} variant="outlined" label={v.errors ? t("report.validation.errors", { errors: v.errors, warnings: v.warnings }) : t("report.validation.ok", { warnings: v.warnings })} data-testid="share-validation" sx={{ height: 24, fontSize: "0.7rem", fontWeight: 700 }} />}
        {card.audit && <Chip size="small" icon={<TroubleshootOutlinedIcon sx={{ fontSize: 14 }} />} variant="outlined" color={card.audit.warning ? "warning" : "default"} label={t("report.audit", { warnings: card.audit.warning ?? 0, infos: card.audit.info ?? 0 })} sx={{ height: 24, fontSize: "0.7rem" }} />}
      </Box>
      {d && d.score != null && (
        <Box sx={{ display: "flex", alignItems: "center", gap: 1.5, p: 1.25, borderRadius: 2, border: `1px solid ${alpha(qualityColor(d.score, theme), 0.45)}`, background: alpha(qualityColor(d.score, theme), 0.05) }} data-testid="share-quality">
          <Box sx={{ width: 58, height: 58, borderRadius: "50%", flexShrink: 0, background: `conic-gradient(${qualityColor(d.score, theme)} ${d.score}%, ${alpha(theme.palette.text.primary, 0.08)} 0)`, display: "flex", alignItems: "center", justifyContent: "center" }}>
            <Box sx={{ width: 46, height: 46, borderRadius: "50%", background: theme.palette.background.paper, display: "flex", alignItems: "center", justifyContent: "center", fontWeight: 900, color: qualityColor(d.score, theme) }}>{d.score}</Box>
          </Box>
          <Box sx={{ flex: 1, minWidth: 0 }}>
            <Typography sx={{ fontSize: "0.82rem", fontWeight: 800 }}>
              {t("network.quality.title")} · {d.grade ? t(`network.quality.grade.${d.grade}`) : ""}
            </Typography>
            <Box sx={{ display: "flex", flexWrap: "wrap", gap: 0.4, mt: 0.4 }}>
              {(d.dimensions || []).map((x) => (
                <Chip key={x.id} size="small" label={`${t(`network.quality.dim.${x.id}`)} ${x.score == null ? "–" : x.score}`} sx={{ height: 18, fontSize: "0.6rem", color: qualityColor(x.score, theme) }} />
              ))}
            </Box>
            {ops && ops.fleet_total > 0 && (
              <Typography sx={{ fontSize: "0.72rem", color: "text.secondary", mt: 0.4, display: "flex", alignItems: "center", gap: 0.4 }}>
                <DirectionsBusFilledOutlinedIcon sx={{ fontSize: 14 }} /> {t("network.ops.fleet", { count: ops.fleet_total })} · {t("network.ops.cost", { cost: fmtMoney(ops.cost_year, ops.currency) })}
              </Typography>
            )}
          </Box>
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
        {card.territory?.sources?.length ? (
          <>
            {" "}
            {t("report.sources")}{" "}
            {card.territory.sources.map((s, i) => (
              <React.Fragment key={s.id}>
                {i > 0 ? ", " : ""}
                <Link href={s.url} target="_blank" rel="noreferrer" underline="hover" color="inherit">
                  {s.name}
                </Link>
              </React.Fragment>
            ))}
          </>
        ) : null}
      </Typography>
    </>,
  );
}
