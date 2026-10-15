/**
 * DemandCards — what the planner's demand tools found, shown in the chat
 * turn that ran them: the plan's ridership ESTIMATE (trips a weekday, the
 * busiest lines, how far to trust it), the optimiser's frequency changes
 * with their estimated effect, and the contrasted scenarios side by side
 * (the dominated ones greyed) with a button to take one as the plan.
 * Every figure is an estimate with its uncertainty, never a count.
 */

import React from "react";
import { Box, Button, Typography, alpha, useTheme } from "@mui/material";
import { useLanguage } from "../../contexts/LanguageContext";
import { Tag, compactNumber, soft } from "./StudioUI";
import { estimatedTrips } from "../../utils/ridership";

const STRATEGIES = ["trunk", "coverage", "balanced"];
const num = (v) => (Number.isFinite(Number(v)) ? Number(v) : null);
const whole = (v, language) => (num(v) == null ? "—" : Math.round(num(v)).toLocaleString(language));
const money = (v, currency, language) => (num(v) == null ? "—" : `${compactNumber(Math.round(num(v)), language)}${currency ? ` ${currency}` : ""}`);
const signed = (v, language) => (num(v) == null ? "—" : `${num(v) > 0 ? "+" : num(v) < 0 ? "−" : "±"}${Math.abs(Math.round(num(v))).toLocaleString(language)}`);

/** "Not calibrated ±50 %" / "calibrated on your counts ±20 %". */
function Trust({ calibrated, uncertainty }) {
  const { t } = useLanguage();
  const theme = useTheme();
  return <Tag color={calibrated ? theme.palette.success.main : theme.palette.warning.main}>{calibrated ? t("network.demand.calibrated", { uncertainty: uncertainty || "±30 %" }) : t("network.demand.uncalibrated", { uncertainty: uncertainty || "±50 %" })}</Tag>;
}

const card = (theme) => ({ mt: 0.75, p: 1.25, borderRadius: "12px", background: theme.palette.background.paper, boxShadow: `0 0 0 1px ${theme.palette.divider}`, display: "flex", flexDirection: "column", gap: 0.75 });

/** The plan's ridership estimate. */
export function DemandSummary({ demand }) {
  const { t, language } = useLanguage();
  const theme = useTheme();
  const e = demand?.estimate || null;
  const k = demand?.kpis || null;
  if ((e?.total_boardings_day ?? k?.trips_day ?? null) == null) return null;
  // An estimate of no trip at all is none (utils/ridership): said unavailable, never « ≈ 0 voyages ».
  const perDay = estimatedTrips(e, k);
  const lines = perDay == null ? [] : [...(e?.per_line || [])].filter((l) => num(l.boardings_day) != null).sort((a, b) => b.boardings_day - a.boardings_day).slice(0, 6);
  return (
    <Box data-testid="plan-demand" sx={card(theme)}>
      <Box sx={{ display: "flex", alignItems: "center", gap: 1, flexWrap: "wrap" }}>
        <Typography sx={{ fontSize: "0.8rem", fontWeight: 800, flex: 1 }}>{t("network.demand.title")}</Typography>
        {perDay != null && <Trust calibrated={Boolean(e?.calibrated ?? k?.calibrated)} uncertainty={e?.uncertainty || k?.uncertainty} />}
      </Box>
      <Typography sx={{ fontSize: "0.78rem", ...(perDay == null ? { color: "text.secondary" } : {}) }} data-testid={perDay == null ? "plan-demand-unavailable" : "plan-demand-total"}>
        {perDay == null ? t("network.demand.unavailable") : t("network.demand.total", { trips: whole(perDay, language) })}
      </Typography>
      {lines.length > 0 && (
        <Box sx={{ display: "flex", flexWrap: "wrap", gap: 0.5 }}>
          {lines.map((l) => (
            <Tag key={l.short_name || l.line_id} color={l.overcrowded ? theme.palette.error.main : null}>
              {`${l.short_name || l.line_id} · ${whole(l.boardings_day, language)}${l.overcrowded ? ` · ${t("network.demand.overcrowded")}` : ""}`}
            </Tag>
          ))}
        </Box>
      )}
      {k && (k.cost_per_trip != null || k.pop_400m_pct != null) && (
        <Typography sx={{ fontSize: "0.72rem", color: "text.secondary" }}>
          {[k.cost_per_trip != null ? t("network.demand.costPerTrip", { cost: k.cost_per_trip.toLocaleString(language), currency: k.currency || "" }) : null, k.pop_400m_pct != null ? t("network.demand.coverage", { pct: k.pop_400m_pct }) : null].filter(Boolean).join(" · ")}
        </Typography>
      )}
    </Box>
  );
}

/** The optimiser's frequency changes, proposals the user validates. */
export function OptimizationSummary({ optimization }) {
  const { t, language } = useLanguage();
  const theme = useTheme();
  const changes = optimization?.changes || [];
  const before = optimization?.before || null;
  const after = optimization?.after || null;
  return (
    <Box data-testid="plan-optimization" sx={card(theme)}>
      <Typography sx={{ fontSize: "0.8rem", fontWeight: 800 }}>{t(`network.optimization.title.${optimization?.objective || "ridership"}`)}</Typography>
      {changes.length === 0 ? (
        <Typography sx={{ fontSize: "0.76rem", color: "text.secondary" }}>{t("network.optimization.none")}</Typography>
      ) : (
        <Box component="ul" sx={{ m: 0, pl: 2.25, fontSize: "0.76rem", display: "flex", flexDirection: "column", gap: 0.25 }}>
          {changes.slice(0, 8).map((c, i) => (
            <li key={i} data-testid="plan-optimization-change">
              {t("network.optimization.change", { line: c.line, period: c.period || "", before: c.headway_before, after: c.headway_after, trips: signed(c.trips_delta, language), cost: signed(c.cost_delta, language), currency: before?.currency || "" })}
            </li>
          ))}
        </Box>
      )}
      {before && after && (
        <Typography sx={{ fontSize: "0.72rem", color: "text.secondary" }}>
          {t("network.optimization.network", { tripsBefore: compactNumber(Math.round(before.trips_year || 0), language), tripsAfter: compactNumber(Math.round(after.trips_year || 0), language), costBefore: money(before.cost_year, before.currency, language), costAfter: money(after.cost_year, after.currency, language), fleetBefore: before.fleet_peak ?? "—", fleetAfter: after.fleet_peak ?? "—" })}
        </Typography>
      )}
      <Typography sx={{ fontSize: "0.7rem", color: "text.secondary", fontStyle: "italic" }}>{t("network.optimization.proposals")}</Typography>
    </Box>
  );
}

/** The contrasted scenarios, compared; one can become the plan. */
export function ScenarioTable({ scenarios, onAdopt = null, disabled = false }) {
  const { t, language } = useLanguage();
  const theme = useTheme();
  const rows = scenarios?.rows || [];
  const byId = new Map((scenarios?.list || []).map((s) => [s.id, s]));
  if (!rows.length) return null;
  return (
    <Box data-testid="plan-scenarios" sx={card(theme)}>
      <Typography sx={{ fontSize: "0.8rem", fontWeight: 800 }}>{t("network.scenarios.title")}</Typography>
      {rows.map((r) => {
        const s = byId.get(r.id);
        return (
          <Box key={r.id} data-testid="plan-scenario" data-dominated={r.dominated ? "true" : "false"} sx={{ p: 1, borderRadius: "10px", background: r.dominated ? soft(theme, 0.8) : alpha(theme.palette.primary.main, theme.palette.mode === "dark" ? 0.12 : 0.05), opacity: r.dominated ? 0.75 : 1, display: "flex", flexDirection: "column", gap: 0.4 }}>
            <Box sx={{ display: "flex", alignItems: "center", gap: 0.75, flexWrap: "wrap" }}>
              <Typography sx={{ fontSize: "0.78rem", fontWeight: 800, flex: 1, minWidth: 0 }}>{STRATEGIES.includes(r.strategy) ? t(`network.scenarios.strategy.${r.strategy}`) : s?.name || r.id}</Typography>
              {r.brief && <Tag color={r.brief.conforms ? theme.palette.success.main : theme.palette.warning.main}>{t("network.scenarios.brief", { pass: r.brief.must_pass, total: r.brief.must_total })}</Tag>}
              {r.dominated && <Tag>{t("network.scenarios.dominated")}</Tag>}
            </Box>
            {STRATEGIES.includes(r.strategy) && <Typography sx={{ fontSize: "0.72rem", color: "text.secondary", lineHeight: 1.45 }}>{t(`network.scenarios.rationale.${r.strategy}`)}</Typography>}
            <Typography sx={{ fontSize: "0.74rem", fontVariantNumeric: "tabular-nums" }}>
              {t("network.scenarios.figures", { lines: r.lines ?? "—", trips: compactNumber(Math.round(r.trips_year || 0), language), cost: money(r.cost_year, r.currency, language), perTrip: r.cost_per_trip != null ? r.cost_per_trip.toLocaleString(language) : "—", fleet: r.fleet_peak ?? "—", coverage: r.pop_400m_pct ?? "—" })}
            </Typography>
            <Box sx={{ display: "flex", alignItems: "center", gap: 1 }}>
              <Trust calibrated={Boolean(r.calibrated)} uncertainty={r.uncertainty} />
              <Box sx={{ flex: 1 }} />
              {onAdopt && s?.spec && (
                <Button size="small" variant="outlined" disabled={disabled} onClick={() => onAdopt(s)} data-testid="plan-scenario-adopt" sx={{ textTransform: "none", fontWeight: 700, borderRadius: 99, py: 0, fontSize: "0.72rem" }}>
                  {t("network.scenarios.adopt")}
                </Button>
              )}
            </Box>
          </Box>
        );
      })}
      <Typography sx={{ fontSize: "0.7rem", color: "text.secondary", fontStyle: "italic" }}>{t("network.scenarios.note")}</Typography>
    </Box>
  );
}
