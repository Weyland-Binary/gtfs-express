/**
 * NetworkReportCard — the report of a network built here, a card at the head
 * of its overview (not a dialog over the explorer, which would say "your
 * network is built" a second time); "Explore" (`report-explore`) folds it
 * away. Nothing is published.
 *
 * ONE primary grade: the quality measured on the built GTFS, the same
 * yardstick as an uploaded feed or a Change Studio plan (report.built). The
 * design report (the plan judged before it was built, on other criteria)
 * is folded under "Design detail", with one line saying why the two
 * differ — never two contradictory grades side by side. Then the brief
 * checked clause by clause, the GTFS validation and the Diagnostic, the
 * data sources that answered, and two ways out: explore, or refine.
 */

import React, { useState } from "react";
import { Box, Button, ButtonBase, Chip, Collapse, Link, Tooltip, Typography, alpha, useTheme } from "@mui/material";
import CheckCircleOutlineIcon from "@mui/icons-material/CheckCircleOutline";
import HelpOutlineIcon from "@mui/icons-material/HelpOutline";
import ErrorOutlineIcon from "@mui/icons-material/ErrorOutline";
import TroubleshootOutlinedIcon from "@mui/icons-material/TroubleshootOutlined";
import BuildCircleOutlinedIcon from "@mui/icons-material/BuildCircleOutlined";
import ExploreOutlinedIcon from "@mui/icons-material/ExploreOutlined";
import ExpandMoreIcon from "@mui/icons-material/ExpandMore";
import { useLanguage } from "../../contexts/LanguageContext";
import { QualityCard, ScoreRing, qualityColor } from "./PlanCards";
import { BriefBadge, BriefChecklist } from "./BriefChecklist";
import { soft } from "./StudioUI";
import DescriptionOutlinedIcon from "@mui/icons-material/DescriptionOutlined";
import { downloadNetworkSynthesis } from "./networkSynthesis";

/** A translation, or the fallback when the key is unknown. */
const tr = (t, key, params, fallback) => {
  const v = t(key, params);
  return v === key ? fallback : v;
};

/** A term with its definition on hover (GTFS, deadhead…). */
function Term({ children, definition }) {
  return (
    <Tooltip title={definition} arrow>
      <Box component="span" tabIndex={0} sx={{ textDecoration: "underline dotted", textUnderlineOffset: "3px", cursor: "help" }}>
        {children}
      </Box>
    </Tooltip>
  );
}

/** The built GTFS measured like any feed: the report's one grade. */
function BuiltGrade({ built }) {
  const { t, language } = useLanguage();
  const theme = useTheme();
  const checks = (built.checks || []).filter((c) => c.count > 0 && c.code !== "error");
  const f = built.fleet;
  const color = qualityColor(built.score, theme);
  return (
    <Box data-testid="report-grade" data-score={Math.round(built.score)} sx={{ p: 1.5, borderRadius: "12px", background: alpha(color, theme.palette.mode === "dark" ? 0.1 : 0.06), display: "flex", flexDirection: "column", gap: 1 }}>
      <Box sx={{ display: "flex", alignItems: "center", gap: 1.25 }}>
        <ScoreRing score={Math.round(built.score)} grade={built.grade} size={58} />
        <Box sx={{ flex: 1, minWidth: 0 }}>
          <Typography sx={{ fontSize: "0.9rem", fontWeight: 800 }}>{t("report.grade.title")}</Typography>
          <Typography sx={{ fontSize: "0.76rem", fontWeight: 700, color }}>{built.grade ? t(`network.quality.grade.${built.grade}`) : ""}</Typography>
          <Typography sx={{ fontSize: "0.7rem", color: "text.secondary", lineHeight: 1.45 }}>{t("report.grade.yardstick")}</Typography>
        </Box>
      </Box>
      {(built.dimensions || []).length > 0 && (
        <Box sx={{ display: "grid", gridTemplateColumns: "repeat(auto-fill, minmax(112px, 1fr))", gap: 0.6 }}>
          {built.dimensions.map((d) => (
            <Box key={d.id} data-testid={`report-grade-dim-${d.id}`} sx={{ px: 1, py: 0.6, borderRadius: "10px", background: theme.palette.background.paper }}>
              <Typography sx={{ fontSize: "0.62rem", color: "text.secondary", fontWeight: 600 }}>{tr(t, `transform.quality.dim.${d.id}`, {}, d.id)}</Typography>
              <Typography sx={{ fontSize: "0.82rem", fontWeight: 800, color: qualityColor(d.score, theme) }}>{d.score == null ? "—" : Math.round(d.score)}</Typography>
            </Box>
          ))}
        </Box>
      )}
      {f && (
        <Typography sx={{ fontSize: "0.74rem" }} data-testid="report-grade-fleet">
          {t("report.built.fleet", { vehicles: f.vehicles, lineByLine: f.vehicles_line_by_line })}
          {Number.isFinite(f.deadhead_km) && (
            <>
              {" · "}
              {Math.round(f.deadhead_km).toLocaleString(language)} km <Term definition={t("glossary.deadhead")}>{t("glossary.deadheadTerm")}</Term>
            </>
          )}
        </Typography>
      )}
      <Box sx={{ display: "flex", flexWrap: "wrap", gap: 0.5 }}>
        {checks.length ? (
          checks.map((c) => <Chip key={c.code} size="small" color="warning" variant="outlined" label={tr(t, `transform.health.check.${c.code}`, { count: c.count }, `${c.code.replace(/_/g, " ")} ×${c.count}`)} sx={{ height: 22, fontSize: "0.66rem", fontWeight: 700 }} />)
        ) : (
          <Typography sx={{ fontSize: "0.72rem", color: "success.main" }}>{t("transform.health.checksOk")}</Typography>
        )}
      </Box>
    </Box>
  );
}

export default function NetworkReportCard({ open = true, report, onClose, onRefine = null }) {
  const { t, language } = useLanguage();
  const theme = useTheme();
  const [designOpen, setDesignOpen] = useState(false);
  if (!report || !open) return null;
  const counts = report.counts || {};
  const v = report.validation || { errors: 0, warnings: 0 };
  const audit = report.audit;
  const req = report.requirements;
  const built = report.built && !report.built.error && report.built.score != null ? report.built : null;
  const design = report.design || null;
  const sources = report.territory?.sources || [];
  return (
    <Box component="section" aria-labelledby="network-report-title" data-testid="network-report" sx={{ mb: 1.5, mt: 1, borderRadius: "14px", border: `1px solid ${theme.palette.divider}`, background: theme.palette.background.paper }}>
      <Box sx={{ p: 2.5, display: "flex", flexDirection: "column", gap: 1.25, maxWidth: 880 }}>
        <Box sx={{ display: "flex", alignItems: "center", gap: 1 }}>
          <Box sx={{ width: 36, height: 36, flexShrink: 0, borderRadius: "10px", display: "flex", alignItems: "center", justifyContent: "center", background: `linear-gradient(135deg, ${theme.palette.ai.gradientStart}, ${theme.palette.ai.gradientEnd})`, color: theme.palette.ai.contrastText }}>
            <ExploreOutlinedIcon sx={{ fontSize: 20 }} />
          </Box>
          <Box sx={{ flex: 1, minWidth: 0 }}>
            <Typography component="h2" id="network-report-title" sx={{ fontWeight: 800, fontSize: "1.05rem", lineHeight: 1.2 }} data-testid="report-title">
              {t("report.title")}
            </Typography>
            <Typography sx={{ fontSize: "0.78rem", color: "text.secondary" }}>{t("report.subtitle", { routes: counts.routes ?? 0, stops: counts.stops ?? 0, trips: counts.trips ?? 0 })}</Typography>
          </Box>
        </Box>
        {req && (req.operator || req.area) && (
          <Typography sx={{ fontSize: "0.78rem" }} data-testid="report-requirements">
            {t("report.requirements", { operator: req.operator || "—", area: req.area || "—" })}
            {req.assumptions?.length ? <span style={{ color: theme.palette.text.secondary }}>{` · ${t("report.assumptions", { count: req.assumptions.length })}`}</span> : null}
          </Typography>
        )}
        {/* One grade: the built GTFS; the design report stands in only when the measure is missing. */}
        {built ? <BuiltGrade built={built} /> : design ? <QualityCard quality={design} dense /> : null}
        {report.live?.conformance || report.conformance ? (
          <Box data-testid="report-conformance" sx={{ display: "flex", flexDirection: "column", gap: 0.5 }}>
            <Box sx={{ display: "flex", alignItems: "center", gap: 1 }}>
              <Typography sx={{ fontSize: "0.8rem", fontWeight: 800, flex: 1 }}>{t("contract.title")}</Typography>
              <BriefBadge conformance={report.live?.conformance || report.conformance} />
            </Box>
            {/* On the feed as it is now when the report was asked for later; else at build. */}
            <Typography sx={{ fontSize: "0.68rem", color: "text.secondary" }} data-testid="report-conformance-when">
              {report.live?.conformance ? t("network.contract.liveNow") : t("network.contract.atBuild")}
            </Typography>
            <BriefChecklist clauses={req?.clauses || []} conformance={report.live?.conformance || report.conformance} />
          </Box>
        ) : null}
        <Box sx={{ display: "flex", flexWrap: "wrap", gap: 0.6 }}>
          {v.unverified ? (
            <Chip size="small" icon={<HelpOutlineIcon sx={{ fontSize: 14 }} />} variant="outlined" label={t("report.validation.unverified")} data-testid="report-validation" sx={{ height: 24, fontSize: "0.7rem", fontWeight: 700 }} />
          ) : (
            <Tooltip title={t("glossary.gtfs")} arrow>
              <Chip size="small" icon={v.errors ? <ErrorOutlineIcon sx={{ fontSize: 14 }} /> : <CheckCircleOutlineIcon sx={{ fontSize: 14 }} />} color={v.errors ? "error" : "success"} variant="outlined" label={v.errors ? t("report.validation.errors", { errors: v.errors, warnings: v.warnings }) : t("report.validation.ok", { warnings: v.warnings })} data-testid="report-validation" sx={{ height: 24, fontSize: "0.7rem", fontWeight: 700 }} />
            </Tooltip>
          )}
          {audit && <Chip size="small" icon={<TroubleshootOutlinedIcon sx={{ fontSize: 14 }} />} variant="outlined" color={audit.counts?.warning ? "warning" : "default"} label={t("report.audit", { warnings: audit.counts?.warning ?? 0, infos: audit.counts?.info ?? 0 })} data-testid="report-audit" sx={{ height: 24, fontSize: "0.7rem", fontWeight: 700 }} />}
          {report.routing_fallback_legs > 0 && <Chip size="small" variant="outlined" color="warning" label={t("report.fallback", { count: report.routing_fallback_legs })} sx={{ height: 24, fontSize: "0.7rem" }} />}
        </Box>
        {audit?.findings?.length > 0 && (
          <Box sx={{ display: "flex", flexWrap: "wrap", gap: 0.4 }}>
            {audit.findings.slice(0, 6).map((f) => (
              <Chip key={f.code} size="small" label={`${tr(t, `audit.code.${f.code}.title`, {}, f.code.replace(/_/g, " "))} ×${f.count}`} sx={{ height: 20, fontSize: "0.64rem", background: alpha(f.severity === "warning" ? theme.palette.warning.main : theme.palette.info.main, 0.1) }} />
            ))}
          </Box>
        )}
        {/* School periods: their dates come from the official school holidays; an assumed summer break is said */}
        {(report.calendars || []).some((c) => c.period) && (
          <Box data-testid="report-calendars" sx={{ display: "flex", flexDirection: "column", gap: 0.25 }}>
            <Typography sx={{ fontSize: "0.76rem", fontWeight: 700 }}>{t("report.calendars.title")}</Typography>
            {(report.calendars || [])
              .filter((c) => c.period)
              .map((c) => (
                <Typography key={c.id} sx={{ fontSize: "0.72rem", color: "text.secondary" }}>
                  {t("report.calendars.item", { period: tr(t, `network.calendar.${c.period}`, {}, c.period), region: c.region || "—", days: c.active_days ?? "—" })}
                  {(c.holiday_periods || []).some((h) => h.assumed) ? ` — ${t("report.calendars.summerAssumed")}` : ""}
                </Typography>
              ))}
          </Box>
        )}
        {/* The design report: folded, and why its grade differs */}
        {built && design && (
          <Box sx={{ borderRadius: "12px", background: soft(theme), px: 1.25, py: 0.75 }}>
            <ButtonBase onClick={() => setDesignOpen((o) => !o)} aria-expanded={designOpen} data-testid="report-design-toggle" sx={{ width: "100%", justifyContent: "flex-start", gap: 0.5, borderRadius: 1, fontSize: "0.78rem", fontWeight: 700 }}>
              <ExpandMoreIcon sx={{ fontSize: 18, transform: designOpen ? "none" : "rotate(-90deg)", transition: "transform 150ms" }} />
              {t("report.design.title", { score: design.score ?? "–" })}
            </ButtonBase>
            <Typography sx={{ fontSize: "0.7rem", color: "text.secondary", lineHeight: 1.45, pl: 2.75 }}>{t("report.design.why")}</Typography>
            <Collapse in={designOpen} unmountOnExit>
              <Box sx={{ mt: 1 }}>
                <QualityCard quality={design} dense />
              </Box>
            </Collapse>
          </Box>
        )}
        {sources.length > 0 && (
          <Typography sx={{ fontSize: "0.62rem", color: "text.disabled" }} data-testid="report-sources">
            {t("report.sources")}{" "}
            {sources.map((s, i) => (
              <React.Fragment key={s.id}>
                {i > 0 ? ", " : ""}
                <Link href={s.url} target="_blank" rel="noreferrer" underline="hover" color="inherit">
                  {s.name}
                </Link>
              </React.Fragment>
            ))}
          </Typography>
        )}
        <Box sx={{ display: "flex", gap: 1, justifyContent: "flex-end", mt: 0.5, flexWrap: "wrap" }}>
          <Button size="small" startIcon={<DescriptionOutlinedIcon />} onClick={() => downloadNetworkSynthesis({ report, t, language })} data-testid="report-note" sx={{ textTransform: "none", fontWeight: 700, mr: "auto" }}>
            {t("network.synthesis.download")}
          </Button>
          {onRefine && (
            <Button size="small" startIcon={<BuildCircleOutlinedIcon />} onClick={onRefine} data-testid="report-refine" sx={{ textTransform: "none", fontWeight: 700 }}>
              {t("report.refine")}
            </Button>
          )}
          <Button size="small" variant="contained" disableElevation startIcon={<ExploreOutlinedIcon />} onClick={onClose} data-testid="report-explore" sx={{ textTransform: "none", fontWeight: 800 }}>
            {t("report.explore")}
          </Button>
        </Box>
      </Box>
    </Box>
  );
}
