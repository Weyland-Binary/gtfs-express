/**
 * NetworkReportDialog — what the user sees when a designed network lands in
 * the application: the design quality report, the GTFS validation and the
 * Diagnostic in one glance, the requirements it answers, the data sources,
 * and two ways out — explore it, or go back to the Studio to refine.
 */

import React from "react";
import { Box, Button, Chip, Dialog, Link, Typography, alpha, useTheme } from "@mui/material";
import CheckCircleOutlineIcon from "@mui/icons-material/CheckCircleOutline";
import HelpOutlineIcon from "@mui/icons-material/HelpOutline";
import ErrorOutlineIcon from "@mui/icons-material/ErrorOutline";
import TroubleshootOutlinedIcon from "@mui/icons-material/TroubleshootOutlined";
import BuildCircleOutlinedIcon from "@mui/icons-material/BuildCircleOutlined";
import ExploreOutlinedIcon from "@mui/icons-material/ExploreOutlined";
import { useLanguage } from "../../contexts/LanguageContext";
import { QualityCard } from "./PlanCards";

export default function NetworkReportDialog({ open, report, onClose, onRefine }) {
  const { t } = useLanguage();
  const theme = useTheme();
  if (!report) return null;
  const counts = report.counts || {};
  const v = report.validation || { errors: 0, warnings: 0 };
  const audit = report.audit;
  const req = report.requirements;
  return (
    <Dialog open={open} onClose={onClose} maxWidth="sm" fullWidth data-testid="network-report">
      <Box sx={{ p: 2.5, display: "flex", flexDirection: "column", gap: 1.25 }}>
        <Box sx={{ display: "flex", alignItems: "center", gap: 1 }}>
          <Box sx={{ width: 36, height: 36, borderRadius: "10px", display: "flex", alignItems: "center", justifyContent: "center", background: `linear-gradient(135deg, ${theme.palette.ai.gradientStart}, ${theme.palette.ai.gradientEnd})`, color: theme.palette.ai.contrastText }}>
            <ExploreOutlinedIcon sx={{ fontSize: 20 }} />
          </Box>
          <Box sx={{ flex: 1, minWidth: 0 }}>
            <Typography sx={{ fontWeight: 800, fontSize: "1.05rem", lineHeight: 1.2 }}>{t("report.title")}</Typography>
            <Typography sx={{ fontSize: "0.78rem", color: "text.secondary" }}>{t("report.subtitle", { routes: counts.routes ?? 0, stops: counts.stops ?? 0, trips: counts.trips ?? 0 })}</Typography>
          </Box>
        </Box>
        {req && (req.operator || req.area) && (
          <Typography sx={{ fontSize: "0.78rem" }} data-testid="report-requirements">
            {t("report.requirements", { operator: req.operator || "—", area: req.area || "—" })}
            {req.assumptions?.length ? <span style={{ color: theme.palette.text.secondary }}>{` · ${t("report.assumptions", { count: req.assumptions.length })}`}</span> : null}
          </Typography>
        )}
        {report.design ? <QualityCard quality={report.design} dense /> : null}
        <Box sx={{ display: "flex", flexWrap: "wrap", gap: 0.6 }}>
          {v.unverified ? (
            <Chip size="small" icon={<HelpOutlineIcon sx={{ fontSize: 14 }} />} variant="outlined" label={t("network.result.validationUnverified")} data-testid="report-validation" sx={{ height: 24, fontSize: "0.7rem", fontWeight: 700 }} />
          ) : (
            <Chip size="small" icon={v.errors ? <ErrorOutlineIcon sx={{ fontSize: 14 }} /> : <CheckCircleOutlineIcon sx={{ fontSize: 14 }} />} color={v.errors ? "error" : "success"} variant="outlined" label={v.errors ? t("report.validation.errors", { errors: v.errors, warnings: v.warnings }) : t("report.validation.ok", { warnings: v.warnings })} data-testid="report-validation" sx={{ height: 24, fontSize: "0.7rem", fontWeight: 700 }} />
          )}
          {audit && <Chip size="small" icon={<TroubleshootOutlinedIcon sx={{ fontSize: 14 }} />} variant="outlined" color={audit.counts?.warning ? "warning" : "default"} label={t("report.audit", { warnings: audit.counts?.warning ?? 0, infos: audit.counts?.info ?? 0 })} data-testid="report-audit" sx={{ height: 24, fontSize: "0.7rem", fontWeight: 700 }} />}
          {report.routing_fallback_legs > 0 && <Chip size="small" variant="outlined" color="warning" label={t("report.fallback", { count: report.routing_fallback_legs })} sx={{ height: 24, fontSize: "0.7rem" }} />}
        </Box>
        {audit?.findings?.length > 0 && (
          <Box sx={{ display: "flex", flexWrap: "wrap", gap: 0.4 }}>
            {audit.findings.slice(0, 6).map((f) => (
              <Chip key={f.code} size="small" label={`${f.code.replace(/_/g, " ")} ×${f.count}`} sx={{ height: 20, fontSize: "0.64rem", background: alpha(f.severity === "warning" ? theme.palette.warning.main : theme.palette.info.main, 0.1) }} />
            ))}
          </Box>
        )}
        {report.territory?.sources?.length > 0 && (
          <Typography sx={{ fontSize: "0.62rem", color: "text.disabled" }}>
            {t("report.sources")}{" "}
            {report.territory.sources.map((s, i) => (
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
          <Button size="small" startIcon={<BuildCircleOutlinedIcon />} onClick={onRefine} data-testid="report-refine" sx={{ textTransform: "none", fontWeight: 700 }}>
            {t("report.refine")}
          </Button>
          <Button size="small" variant="contained" disableElevation startIcon={<ExploreOutlinedIcon />} onClick={onClose} data-testid="report-explore" sx={{ textTransform: "none", fontWeight: 800 }}>
            {t("report.explore")}
          </Button>
        </Box>
      </Box>
    </Dialog>
  );
}
