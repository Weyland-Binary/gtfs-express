/**
 * HandoffCard — the planner recognised a request to MODIFY a network that
 * already runs (SSE `handoff`): redrawing it here would lose its variants,
 * calendar exceptions and real running times. The card says so in one
 * sentence, names the published feed (validity flagged), and "Open and
 * modify" opens it as it is (POST /network/catalog/open) and hands the
 * brief over to the Change Studio, which prefills it for review — nothing
 * is sent on the user's behalf.
 */

import React, { useState } from "react";
import { Box, Button, CircularProgress, Typography, alpha, useTheme } from "@mui/material";
import OpenInNewRoundedIcon from "@mui/icons-material/OpenInNewRounded";
import DirectionsBusFilledOutlinedIcon from "@mui/icons-material/DirectionsBusFilledOutlined";
import TrainOutlinedIcon from "@mui/icons-material/TrainOutlined";
import FormatQuoteRoundedIcon from "@mui/icons-material/FormatQuoteRounded";
import { useLanguage } from "../../contexts/LanguageContext";
import { openCatalogFeed } from "../../utils/networkStudioApi";
import ErrorNotice from "../common/ErrorNotice";
import useElapsed from "../common/useElapsed";
import { Tag } from "./StudioUI";
import { feedDetail, feedTitle, isRailFeed, validityOf } from "./feedInfo";

export default function HandoffCard({ handoff, place = null, onOpened, disabled = false }) {
  const { t, language } = useLanguage();
  const theme = useTheme();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState(null);
  const elapsed = useElapsed(busy);
  const feed = handoff?.feed || {};
  const title = feedTitle(feed) || t("network.handoff.unnamed");
  const detail = feedDetail(feed, t, language);
  const valid = validityOf(feed, t, language);
  const Icon = isRailFeed(feed) ? TrainOutlinedIcon : DirectionsBusFilledOutlinedIcon;
  const canOpen = /^https?:\/\//i.test(feed.url || "");

  const open = async () => {
    if (!canOpen || busy) return;
    setBusy(true);
    setError(null);
    try {
      const r = await openCatalogFeed(feed.url, { name: feed.name || feed.provider || null, place });
      onOpened(r, feed, handoff.brief || null);
    } catch (err) {
      setError(err);
    } finally {
      setBusy(false);
    }
  };

  return (
    <Box data-testid="plan-handoff" sx={{ mt: 1, p: 1.5, borderRadius: "12px", background: alpha(theme.palette.primary.main, theme.palette.mode === "dark" ? 0.12 : 0.06), boxShadow: `inset 0 0 0 1px ${alpha(theme.palette.primary.main, 0.25)}`, display: "flex", flexDirection: "column", gap: 1 }}>
      <Typography sx={{ fontSize: "0.84rem", fontWeight: 800, lineHeight: 1.35 }}>{t("network.handoff.title")}</Typography>
      <Box sx={{ display: "flex", alignItems: "flex-start", gap: 1, p: 1, borderRadius: "10px", background: theme.palette.background.paper }}>
        <Box sx={{ width: 28, height: 28, flexShrink: 0, borderRadius: "8px", display: "flex", alignItems: "center", justifyContent: "center", color: "primary.main", background: alpha(theme.palette.primary.main, 0.1) }}>
          <Icon sx={{ fontSize: 16 }} />
        </Box>
        <Box sx={{ flex: 1, minWidth: 0 }}>
          <Typography sx={{ fontSize: "0.8rem", fontWeight: 700 }} noWrap title={title} data-testid="plan-handoff-feed">
            {title}
          </Typography>
          {detail && (
            <Typography sx={{ fontSize: "0.7rem", color: "text.secondary" }} noWrap title={detail}>
              {detail}
            </Typography>
          )}
          {valid && (
            <Box sx={{ display: "flex", alignItems: "center", gap: 0.5, mt: 0.25 }}>
              <Typography component="span" data-testid="plan-handoff-validity" sx={{ fontSize: "0.68rem", color: valid.color, fontWeight: valid.expired ? 700 : 400 }}>
                {valid.text}
              </Typography>
              {valid.expired && <Tag color={theme.palette.warning.dark}>{t("feeds.expiredTag")}</Tag>}
            </Box>
          )}
        </Box>
      </Box>
      {handoff?.reason && <Typography sx={{ fontSize: "0.74rem", color: "text.secondary", lineHeight: 1.5 }}>{handoff.reason}</Typography>}
      {handoff?.brief && (
        <Box>
          <Typography sx={{ fontSize: "0.7rem", fontWeight: 700, color: "text.secondary", mb: 0.25 }}>{t("network.handoff.briefCarried")}</Typography>
          <Box data-testid="plan-handoff-brief" sx={{ display: "flex", gap: 0.5, fontSize: "0.74rem", lineHeight: 1.45, fontStyle: "italic", color: "text.primary" }}>
            <FormatQuoteRoundedIcon sx={{ fontSize: 14, color: "text.disabled", flexShrink: 0, mt: 0.15 }} />
            <Box component="span" sx={{ display: "-webkit-box", WebkitLineClamp: 3, WebkitBoxOrient: "vertical", overflow: "hidden" }}>
              {handoff.brief}
            </Box>
          </Box>
        </Box>
      )}
      {error && <ErrorNotice error={error} onRetry={open} testid="plan-handoff-error" />}
      <Box sx={{ display: "flex", alignItems: "center", gap: 1, flexWrap: "wrap" }}>
        <Button size="small" variant="contained" disableElevation disabled={disabled || busy || !canOpen} onClick={open} startIcon={busy ? <CircularProgress size={14} color="inherit" /> : <OpenInNewRoundedIcon sx={{ fontSize: "16px !important" }} />} data-testid="plan-handoff-open" sx={{ textTransform: "none", fontWeight: 800, borderRadius: 99, px: 1.75 }}>
          {t("flow.modify.title")}
        </Button>
        {busy && (
          <Typography sx={{ fontSize: "0.7rem", color: "text.secondary" }} data-testid="plan-handoff-progress">
            {t("network.handoff.opening", { seconds: elapsed })}
          </Typography>
        )}
        {!canOpen && <Typography sx={{ fontSize: "0.7rem", color: "text.secondary" }}>{t("network.handoff.noUrl")}</Typography>}
      </Box>
    </Box>
  );
}
