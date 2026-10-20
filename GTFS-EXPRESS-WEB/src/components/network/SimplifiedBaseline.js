/**
 * SimplifiedBaseline — a published network loaded as a SIMPLIFIED plan
 * (one route per line and direction, running times approximated) is a
 * baseline to compare a redesign with, never the real network. What it
 * loses is said in plain words, from the import's `losses`, before
 * anything happens:
 *
 *   lossLines(losses, t, language) → [{ key, text, info }]
 *   BaselineTag                     the "Simplified baseline — comparison only" label
 *   SimplifiedBaselineDialog        mode "import": load it only once confirmed;
 *                                   mode "build": the server refused to build it
 *                                   (409 SIMPLIFIED_BASELINE) — open the real
 *                                   network instead, or build it as a study.
 */

import React from "react";
import { Box, Button, CircularProgress, Dialog, Tooltip, Typography, alpha, useTheme } from "@mui/material";
import WarningAmberIcon from "@mui/icons-material/WarningAmber";
import InfoOutlinedIcon from "@mui/icons-material/InfoOutlined";
import CallSplitOutlinedIcon from "@mui/icons-material/CallSplitOutlined";
import { useLanguage } from "../../contexts/LanguageContext";
import ErrorNotice from "../common/ErrorNotice";
import { Tag } from "./StudioUI";

const num = (n) => Number.isFinite(Number(n)) ? Number(n) : null;

/** What the simplified plan leaves out of the real network, most serious first. */
export const lossLines = (losses, t, language) => {
  const fmt = (n) => Number(n).toLocaleString(language || undefined);
  if (!losses || typeof losses !== "object") return [{ key: "generic", text: t("network.baseline.loss.generic"), info: false }];
  const out = [];
  const trips = num(losses.trips_on_other_pattern);
  const tripsTotal = num(losses.trips_total);
  if (trips > 0 && tripsTotal > 0) out.push({ key: "trips", text: t("network.baseline.loss.trips", { pct: Math.max(1, Math.round((100 * trips) / tripsTotal)), count: fmt(trips), total: fmt(tripsTotal) }) });
  const exceptions = num(losses.calendar_exceptions_dropped);
  if (exceptions > 0) out.push({ key: "exceptions", text: t("network.baseline.loss.exceptions", { count: fmt(exceptions) }) });
  const spread = num(losses.running_time?.max_spread_min);
  out.push({ key: "runningTime", text: spread > 0 ? t("network.baseline.loss.runningTime", { min: fmt(Math.round(spread)) }) : t("network.baseline.loss.runningTimeApprox") });
  const kept = num(losses.lines_kept);
  const routes = num(losses.routes_total);
  if (kept != null && routes != null && kept < routes) out.push({ key: "lines", text: t("network.baseline.loss.lines", { kept: fmt(kept), total: fmt(routes) }) });
  const datesOnly = num(losses.dates_only_services_approximated);
  if (datesOnly > 0) out.push({ key: "datesOnly", text: t("network.baseline.loss.datesOnly", { count: fmt(datesOnly) }) });
  if (losses.shapes_dropped) out.push({ key: "shapes", text: t("network.baseline.loss.shapes") });
  const freq = num(losses.frequencies_expanded);
  if (freq > 0) out.push({ key: "frequencies", text: t("network.baseline.loss.frequencies", { count: fmt(freq) }), info: true });
  return out;
};

export function BaselineTag({ sx = {} }) {
  const { t } = useLanguage();
  const theme = useTheme();
  return (
    <Tooltip title={t("network.baseline.tagHint")}>
      <span data-testid="baseline-tag">
        <Tag color={theme.palette.warning.dark} sx={sx}>
          {t("network.baseline.tag")}
        </Tag>
      </span>
    </Tooltip>
  );
}

export function SimplifiedBaselineDialog({ open, mode = "import", losses = null, feedName = "", busy = null, error = null, onConfirm, onOpenReal = null, onClose }) {
  const { t, language } = useLanguage();
  const theme = useTheme();
  const lines = lossLines(losses, t, language);
  const build = mode === "build";
  const name = feedName || t("network.baseline.unnamed");
  return (
    <Dialog open={open} onClose={busy ? undefined : onClose} maxWidth="sm" fullWidth data-testid="baseline-dialog" data-mode={mode}>
      <Box sx={{ p: 2.5, display: "flex", flexDirection: "column", gap: 1.25 }}>
        <Box sx={{ display: "flex", alignItems: "center", gap: 1 }}>
          <Box sx={{ width: 34, height: 34, borderRadius: "10px", flexShrink: 0, display: "flex", alignItems: "center", justifyContent: "center", color: theme.palette.warning.dark, background: alpha(theme.palette.warning.main, 0.14) }}>
            <CallSplitOutlinedIcon sx={{ fontSize: 19 }} />
          </Box>
          <Box sx={{ minWidth: 0 }}>
            <Typography sx={{ fontWeight: 800, fontSize: "1.02rem", lineHeight: 1.25 }}>{t(build ? "network.baseline.buildTitle" : "network.baseline.importTitle")}</Typography>
            <Box sx={{ mt: 0.4 }}>
              <BaselineTag />
            </Box>
          </Box>
        </Box>
        <Typography sx={{ fontSize: "0.82rem", lineHeight: 1.55 }}>{t(build ? "network.baseline.buildIntro" : "network.baseline.importIntro", { name })}</Typography>
        <Box component="ul" data-testid="baseline-losses" sx={{ listStyle: "none", m: 0, p: 0, display: "flex", flexDirection: "column", gap: 0.6 }}>
          {lines.map((l) => (
            <Box component="li" key={l.key} data-loss={l.key} sx={{ display: "flex", alignItems: "flex-start", gap: 0.75, fontSize: "0.8rem", lineHeight: 1.45 }}>
              {l.info ? <InfoOutlinedIcon sx={{ fontSize: 16, mt: 0.15, color: "text.secondary", flexShrink: 0 }} /> : <WarningAmberIcon sx={{ fontSize: 16, mt: 0.15, color: "warning.dark", flexShrink: 0 }} />}
              <span>{l.text}</span>
            </Box>
          ))}
        </Box>
        <Typography sx={{ fontSize: "0.76rem", color: "text.secondary", lineHeight: 1.5, px: 1.25, py: 0.75, borderRadius: 1.5, background: alpha(theme.palette.primary.main, theme.palette.mode === "dark" ? 0.12 : 0.06) }}>
          {t("network.baseline.advice")}
        </Typography>
        {error && <ErrorNotice error={error} testid="baseline-error" />}
        <Box sx={{ display: "flex", gap: 1, justifyContent: "flex-end", flexWrap: "wrap", mt: 0.5 }}>
          <Button onClick={onClose} disabled={Boolean(busy)} sx={{ textTransform: "none", mr: "auto" }}>
            {t("network.baseline.cancel")}
          </Button>
          {onOpenReal && (
            <Button variant={build ? "contained" : "outlined"} disableElevation onClick={onOpenReal} disabled={Boolean(busy)} startIcon={busy === "open" ? <CircularProgress size={14} color="inherit" /> : null} data-testid="baseline-open-real" sx={{ textTransform: "none", fontWeight: 700 }}>
              {t(build ? "network.baseline.openRealToModify" : "network.baseline.openReal")}
            </Button>
          )}
          <Button variant={build ? "outlined" : "contained"} color={build ? "warning" : "primary"} disableElevation onClick={onConfirm} disabled={Boolean(busy)} startIcon={busy === "confirm" ? <CircularProgress size={14} color="inherit" /> : null} data-testid="baseline-confirm" sx={{ textTransform: "none", fontWeight: 700 }}>
            {t(build ? "network.baseline.buildAnyway" : "network.baseline.load")}
          </Button>
        </Box>
      </Box>
    </Dialog>
  );
}
