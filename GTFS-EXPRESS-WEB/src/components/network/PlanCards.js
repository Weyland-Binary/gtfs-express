/**
 * PlanCards — what the planner shows besides prose:
 *   • RequirementsCard: the brief as the planner understood it (stated facts,
 *     assumptions with their confidence, questions left open) — every
 *     assumption is one click away from a correction;
 *   • QualityCard: the design quality report (score, seven dimensions,
 *     findings, recommendations) and its compact QualityBadge.
 */

import React from "react";
import { Box, Chip, LinearProgress, Tooltip, Typography, alpha, useTheme } from "@mui/material";
import FactCheckOutlinedIcon from "@mui/icons-material/FactCheckOutlined";
import VerifiedOutlinedIcon from "@mui/icons-material/VerifiedOutlined";
import ErrorOutlineIcon from "@mui/icons-material/ErrorOutline";
import WarningAmberIcon from "@mui/icons-material/WarningAmber";
import InfoOutlinedIcon from "@mui/icons-material/InfoOutlined";
import EditOutlinedIcon from "@mui/icons-material/EditOutlined";
import { useLanguage } from "../../contexts/LanguageContext";

export const DIMENSIONS = ["coverage", "spacing", "directness", "service", "connectivity", "plausibility", "compliance"];

export const qualityColor = (score, theme) => {
  if (score == null) return theme.palette.text.disabled;
  if (score >= 85) return theme.palette.success.main;
  if (score >= 70) return theme.palette.info.main;
  if (score >= 55) return theme.palette.warning.main;
  return theme.palette.error.main;
};

const CONFIDENCE_COLOR = { high: "success", medium: "warning", low: "error" };
const LEVEL_ICON = { major: ErrorOutlineIcon, minor: WarningAmberIcon, info: InfoOutlinedIcon };
const LEVEL_COLOR = { major: "error.main", minor: "warning.dark", info: "text.secondary" };

function Row({ label, children }) {
  return (
    <Box sx={{ display: "flex", gap: 1, alignItems: "flex-start", fontSize: "0.76rem", lineHeight: 1.45 }}>
      <Typography sx={{ fontSize: "0.7rem", fontWeight: 700, color: "text.secondary", minWidth: 78, pt: 0.1, textTransform: "uppercase", letterSpacing: 0.3 }}>{label}</Typography>
      <Box sx={{ flex: 1, minWidth: 0 }}>{children}</Box>
    </Box>
  );
}

export function RequirementsCard({ requirements, onCorrect = null }) {
  const { t } = useLanguage();
  const theme = useTheme();
  const r = requirements;
  if (!r) return null;
  const service = r.service ? [r.service.days, r.service.span, r.service.headways, r.service.holidays].filter(Boolean).join(" · ") : "";
  const openLow = (r.open_questions || []).filter((q) => q.impact !== "high");
  return (
    <Box data-testid="plan-requirements" sx={{ mt: 1, borderRadius: 1.5, border: `1px solid ${alpha(theme.palette.info.main, 0.35)}`, background: alpha(theme.palette.info.main, 0.04), p: 1.25, display: "flex", flexDirection: "column", gap: 0.7 }}>
      <Box sx={{ display: "flex", alignItems: "center", gap: 0.75 }}>
        <FactCheckOutlinedIcon sx={{ fontSize: 16, color: theme.palette.info.main }} />
        <Typography sx={{ fontSize: "0.8rem", fontWeight: 800, flex: 1 }}>{t("network.req.title")}</Typography>
        {onCorrect && (
          <Chip size="small" icon={<EditOutlinedIcon sx={{ fontSize: 13 }} />} label={t("network.req.correct")} onClick={() => onCorrect(t("network.req.correctGeneric"))} variant="outlined" data-testid="plan-requirements-correct" sx={{ height: 22, fontSize: "0.66rem", fontWeight: 700 }} />
        )}
      </Box>
      {(r.operator || r.area) && (
        <Row label={t("network.req.operator")}>
          <strong>{r.operator || "—"}</strong>
          {r.area ? <span style={{ color: theme.palette.text.secondary }}>{` · ${r.area}`}</span> : null}
        </Row>
      )}
      {r.objectives?.length > 0 && (
        <Row label={t("network.req.objectives")}>
          <Box sx={{ display: "flex", flexWrap: "wrap", gap: 0.4 }}>
            {r.objectives.map((o, i) => (
              <Chip key={i} size="small" label={o} sx={{ height: 20, fontSize: "0.66rem" }} />
            ))}
          </Box>
        </Row>
      )}
      {r.lines_requested?.length > 0 && (
        <Row label={t("network.req.lines")}>
          <Box component="ul" sx={{ m: 0, pl: 1.6 }}>
            {r.lines_requested.map((l, i) => (
              <li key={i}>
                <strong>{l.name || "?"}</strong>
                {l.mode ? ` (${l.mode})` : ""}
                {l.from || l.to ? ` : ${l.from || "?"} → ${l.to || "?"}` : ""}
                {l.via?.length ? ` via ${l.via.join(", ")}` : ""}
                {l.notes ? <span style={{ color: theme.palette.text.secondary }}>{` — ${l.notes}`}</span> : null}
              </li>
            ))}
          </Box>
        </Row>
      )}
      {service && <Row label={t("network.req.service")}>{service}</Row>}
      {r.constraints?.length > 0 && <Row label={t("network.req.constraints")}>{r.constraints.join(" · ")}</Row>}
      {r.assumptions?.length > 0 && (
        <Row label={t("network.req.assumptions")}>
          <Box sx={{ display: "flex", flexWrap: "wrap", gap: 0.4 }}>
            {r.assumptions.map((a, i) => (
              <Tooltip key={i} title={`${t(`network.req.confidence.${a.confidence || "medium"}`)}${a.reason ? ` — ${a.reason}` : ""}`}>
                <Chip size="small" color={CONFIDENCE_COLOR[a.confidence] || "default"} variant="outlined" label={`${a.topic}: ${a.value}`} onClick={onCorrect ? () => onCorrect(t("network.req.correctPrefill", { topic: a.topic, value: a.value })) : undefined} data-testid="plan-assumption" sx={{ height: 20, fontSize: "0.66rem", maxWidth: "100%" }} />
              </Tooltip>
            ))}
          </Box>
        </Row>
      )}
      {openLow.length > 0 && (
        <Row label={t("network.req.openQuestions")}>
          <Box component="ul" sx={{ m: 0, pl: 1.6, color: "text.secondary" }}>
            {openLow.map((q) => (
              <li key={q.id}>
                {q.question}
                {q.default ? <strong>{` → ${q.default}`}</strong> : null}
              </li>
            ))}
          </Box>
        </Row>
      )}
    </Box>
  );
}

function ScoreRing({ score, grade, size = 54 }) {
  const theme = useTheme();
  const color = qualityColor(score, theme);
  const pct = score == null ? 0 : Math.max(0, Math.min(100, score));
  return (
    <Box sx={{ width: size, height: size, borderRadius: "50%", flexShrink: 0, background: `conic-gradient(${color} ${pct}%, ${alpha(theme.palette.text.primary, 0.08)} 0)`, display: "flex", alignItems: "center", justifyContent: "center" }} data-testid="quality-ring">
      <Box sx={{ width: size - 10, height: size - 10, borderRadius: "50%", background: theme.palette.background.paper, display: "flex", flexDirection: "column", alignItems: "center", justifyContent: "center", lineHeight: 1 }}>
        <Typography sx={{ fontSize: size > 44 ? "0.95rem" : "0.7rem", fontWeight: 900, color }}>{score == null ? "–" : score}</Typography>
        {grade && size > 44 && <Typography sx={{ fontSize: "0.58rem", fontWeight: 700, color: "text.secondary" }}>{grade}</Typography>}
      </Box>
    </Box>
  );
}

export function QualityCard({ quality, dense = false }) {
  const { t } = useLanguage();
  const theme = useTheme();
  const q = quality;
  if (!q) return null;
  const findings = (q.dimensions || []).flatMap((d) => d.findings.filter((x) => x.level !== "info").map((x) => ({ ...x, dimension: d.id }))).sort((a, b) => (a.level === "major" ? 0 : 1) - (b.level === "major" ? 0 : 1)).slice(0, dense ? 4 : 8);
  return (
    <Box data-testid="plan-quality" sx={{ mt: dense ? 0 : 1, borderRadius: 1.5, border: `1px solid ${alpha(qualityColor(q.score, theme), 0.45)}`, background: alpha(qualityColor(q.score, theme), 0.04), p: 1.25, display: "flex", flexDirection: "column", gap: 0.9 }}>
      <Box sx={{ display: "flex", alignItems: "center", gap: 1.25 }}>
        <ScoreRing score={q.score} grade={q.grade} />
        <Box sx={{ flex: 1, minWidth: 0 }}>
          <Box sx={{ display: "flex", alignItems: "center", gap: 0.6 }}>
            <VerifiedOutlinedIcon sx={{ fontSize: 16, color: qualityColor(q.score, theme) }} />
            <Typography sx={{ fontSize: "0.82rem", fontWeight: 800 }}>{t("network.quality.title")}</Typography>
          </Box>
          <Typography sx={{ fontSize: "0.72rem", color: "text.secondary" }}>
            {q.grade ? t(`network.quality.grade.${q.grade}`) : t("network.quality.na")}
            {q.majors ? ` · ${t("network.quality.majors", { count: q.majors })}` : ""}
          </Typography>
        </Box>
      </Box>
      <Box sx={{ display: "grid", gridTemplateColumns: dense ? "1fr" : "1fr 1fr", columnGap: 1.5, rowGap: 0.45 }}>
        {(q.dimensions || []).map((d) => (
          <Box key={d.id} data-testid={`quality-dim-${d.id}`}>
            <Box sx={{ display: "flex", justifyContent: "space-between", fontSize: "0.68rem", lineHeight: 1.3 }}>
              <span>{t(`network.quality.dim.${d.id}`)}</span>
              <strong style={{ color: qualityColor(d.score, theme) }}>{d.score == null ? t("network.quality.na") : d.score}</strong>
            </Box>
            <LinearProgress variant="determinate" value={d.score == null ? 0 : d.score} sx={{ height: 4, borderRadius: 2, background: alpha(theme.palette.text.primary, 0.08), "& .MuiLinearProgress-bar": { background: qualityColor(d.score, theme) } }} />
          </Box>
        ))}
      </Box>
      {findings.length > 0 ? (
        <Box sx={{ display: "flex", flexDirection: "column", gap: 0.35 }}>
          {findings.map((x, i) => {
            const Icon = LEVEL_ICON[x.level] || InfoOutlinedIcon;
            return (
              <Box key={i} sx={{ display: "flex", alignItems: "flex-start", gap: 0.5, fontSize: "0.72rem", lineHeight: 1.4, color: LEVEL_COLOR[x.level] }} data-testid="quality-finding">
                <Icon sx={{ fontSize: 13, mt: 0.25, flexShrink: 0 }} />
                <span>
                  {x.message}
                  {x.hint && !dense ? <span style={{ color: theme.palette.text.secondary }}>{` ${x.hint}`}</span> : null}
                </span>
              </Box>
            );
          })}
        </Box>
      ) : (
        <Typography sx={{ fontSize: "0.72rem", color: "success.main" }}>{t("network.quality.noFindings")}</Typography>
      )}
    </Box>
  );
}

export function QualityBadge({ quality, onClick = null }) {
  const { t } = useLanguage();
  const theme = useTheme();
  if (!quality || quality.score == null) return null;
  const color = qualityColor(quality.score, theme);
  return (
    <Tooltip title={t("network.quality.open")}>
      <Chip size="small" icon={<VerifiedOutlinedIcon sx={{ fontSize: 14, color: `${color} !important` }} />} label={`${t("network.quality.score", { score: quality.score })} · ${quality.grade || ""}`} onClick={onClick || undefined} variant="outlined" data-testid="quality-badge" sx={{ height: 22, fontSize: "0.68rem", fontWeight: 800, borderColor: alpha(color, 0.6), color }} />
    </Tooltip>
  );
}
