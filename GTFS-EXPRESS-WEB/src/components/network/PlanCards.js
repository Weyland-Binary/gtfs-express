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
import DirectionsBusFilledOutlinedIcon from "@mui/icons-material/DirectionsBusFilledOutlined";
import DirectionsWalkOutlinedIcon from "@mui/icons-material/DirectionsWalkOutlined";
import { useLanguage } from "../../contexts/LanguageContext";

export const DIMENSIONS = ["coverage", "spacing", "directness", "service", "connectivity", "plausibility", "compliance"];

export const qualityColor = (score, theme) => {
  if (score == null) return theme.palette.text.disabled;
  if (score >= 85) return theme.palette.success.main;
  if (score >= 70) return theme.palette.info.main;
  if (score >= 55) return theme.palette.warning.main;
  return theme.palette.error.main;
};

/** 1 234 567 → "1.23 M EUR"; 45 600 → "46 k EUR". */
export const fmtMoney = (v, currency = "EUR") => {
  const n = Number(v) || 0;
  const s = n >= 1e6 ? `${(n / 1e6).toFixed(2)} M` : n >= 1e3 ? `${Math.round(n / 1e3)} k` : String(Math.round(n));
  return `${s} ${currency}`;
};

/**
 * A quality finding in the reader's language: its code picks the translation
 * (numbers in the reader's format), the server's English text is the fallback.
 */
export const findingText = (x, t, language) => {
  const key = x.code ? `network.finding.${x.code}` : null;
  const message = key ? t(key) : key;
  if (!key || message === key) return { message: x.message, hint: x.hint };
  let nf = null;
  try {
    nf = new Intl.NumberFormat(language, { maximumFractionDigits: 2 });
  } catch {
    nf = null;
  }
  const params = {};
  for (const [k, v] of Object.entries(x.params || {})) params[k] = typeof v === "number" && nf ? nf.format(v) : String(v);
  if (x.params?.category) {
    const label = t(`territory.category.${x.params.category}`);
    if (label !== `territory.category.${x.params.category}`) params.category = label;
  }
  const hint = t(`${key}.hint`, params);
  return { message: t(key, params), hint: hint === `${key}.hint` ? x.hint : hint };
};

/**
 * Why a plan is not ready, or not clean, in the reader's language: one line
 * per reason the planner's `done` event gave (codes, with the major
 * findings translated like in the quality card).
 */
export const readinessLines = (reasons, t, language) =>
  (reasons || []).map((r) => {
    if (r.finding) return findingText(r.finding, t, language).message;
    const key = `network.notReady.${r.code}`;
    const text = t(key, { count: r.count ?? "", max: r.max ?? "" });
    return text === key ? r.code : text;
  });

const CONFIDENCE_COLOR = { high: "success", medium: "warning", low: "error" };
const LEVEL_ICON = { major: ErrorOutlineIcon, minor: WarningAmberIcon, info: InfoOutlinedIcon };
const LEVEL_COLOR = { major: "error.main", minor: "warning.dark", info: "text.secondary" };

// Label above its content: the side panel is narrow and labels are long in some languages.
function Row({ label, children }) {
  return (
    <Box sx={{ fontSize: "0.76rem", lineHeight: 1.45, minWidth: 0 }}>
      <Typography sx={{ fontSize: "0.64rem", fontWeight: 700, color: "text.secondary", textTransform: "uppercase", letterSpacing: 0.4, mb: 0.25 }}>{label}</Typography>
      <Box sx={{ minWidth: 0, overflowWrap: "anywhere" }}>{children}</Box>
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
    <Box data-testid="plan-requirements" sx={{ mt: 0.5, borderRadius: "12px", background: alpha(theme.palette.info.main, theme.palette.mode === "dark" ? 0.1 : 0.05), p: 1.5, display: "flex", flexDirection: "column", gap: 0.8 }}>
      <Box sx={{ display: "flex", alignItems: "center", gap: 0.75 }}>
        <FactCheckOutlinedIcon sx={{ fontSize: 16, color: theme.palette.info.main }} />
        <Typography sx={{ fontSize: "0.8rem", fontWeight: 800, flex: 1 }}>{t("network.req.title")}</Typography>
        {onCorrect && (
          <Chip size="small" icon={<EditOutlinedIcon sx={{ fontSize: 13 }} />} label={t("network.req.correct")} onClick={() => onCorrect(t("network.req.correctGeneric"))} data-testid="plan-requirements-correct" sx={{ height: 24, fontSize: "0.68rem", fontWeight: 700, background: theme.palette.background.paper }} />
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
              <Chip key={i} size="small" label={o} sx={{ height: "auto", minHeight: 20, py: 0.2, fontSize: "0.66rem", maxWidth: "100%", "& .MuiChip-label": { whiteSpace: "normal", lineHeight: 1.35 } }} />
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
                <Chip size="small" label={`${a.topic}: ${a.value}`} onClick={onCorrect ? () => onCorrect(t("network.req.correctPrefill", { topic: a.topic, value: a.value })) : undefined} data-testid="plan-assumption" sx={{ height: "auto", minHeight: 22, py: 0.25, fontSize: "0.68rem", maxWidth: "100%", background: theme.palette.background.paper, "& .MuiChip-label": { display: "flex", alignItems: "center", gap: 0.6, whiteSpace: "normal", lineHeight: 1.35 }, "&::before": { content: '""', width: 6, height: 6, borderRadius: "50%", ml: 1, flexShrink: 0, background: theme.palette[CONFIDENCE_COLOR[a.confidence] || "info"].main } }} />
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
  const { t, language } = useLanguage();
  const theme = useTheme();
  const q = quality;
  if (!q) return null;
  const findings = (q.dimensions || []).flatMap((d) => d.findings.filter((x) => x.level !== "info").map((x) => ({ ...x, dimension: d.id }))).sort((a, b) => (a.level === "major" ? 0 : 1) - (b.level === "major" ? 0 : 1)).slice(0, dense ? 4 : 8);
  return (
    <Box data-testid="plan-quality" sx={{ mt: dense ? 0 : 1, borderRadius: "12px", background: alpha(qualityColor(q.score, theme), theme.palette.mode === "dark" ? 0.1 : 0.06), p: 1.5, display: "flex", flexDirection: "column", gap: 1 }}>
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
      {q.operations && q.operations.fleet_total > 0 && (
        <Box data-testid="quality-operations" sx={{ display: "flex", flexWrap: "wrap", gap: 0.5, alignItems: "center", fontSize: "0.72rem", px: 1, py: 0.6, borderRadius: 1.5, background: alpha(theme.palette.text.primary, 0.04) }}>
          <DirectionsBusFilledOutlinedIcon sx={{ fontSize: 15, color: "text.secondary" }} />
          <strong>{t("network.ops.title")}</strong>
          <span>{t("network.ops.fleet", { count: q.operations.fleet_total })}</span>
          <span>· {t("network.ops.km", { km: q.operations.veh_km_year.toLocaleString() })}</span>
          <span>· {t("network.ops.cost", { cost: fmtMoney(q.operations.cost_year, q.operations.currency) })}</span>
          {q.operations.limits?.max_vehicles != null && <Chip size="small" color={q.operations.fleet_total > q.operations.limits.max_vehicles ? "error" : "success"} label={t("network.ops.cap", { max: q.operations.limits.max_vehicles })} sx={{ height: 18, fontSize: "0.62rem" }} />}
          {q.operations.limits?.max_cost_year != null && <Chip size="small" color={q.operations.cost_year > q.operations.limits.max_cost_year ? "error" : "success"} label={t("network.ops.budget", { budget: fmtMoney(q.operations.limits.max_cost_year, q.operations.currency) })} sx={{ height: 18, fontSize: "0.62rem" }} />}
        </Box>
      )}
      {q.accessibility && q.accessibility.targets?.length > 0 && (
        <Box data-testid="quality-accessibility" sx={{ display: "flex", flexDirection: "column", gap: 0.3, px: 1, py: 0.6, borderRadius: 1.5, background: alpha(theme.palette.text.primary, 0.04), fontSize: "0.7rem" }}>
          <Box sx={{ display: "flex", alignItems: "center", gap: 0.5, fontWeight: 700 }}>
            <DirectionsWalkOutlinedIcon sx={{ fontSize: 14, color: "text.secondary" }} />
            {t("network.access.title", { at: q.accessibility.at })}
            <span style={{ fontWeight: 400, color: theme.palette.text.secondary }}>· {t("network.access.served", { pct: q.accessibility.residents_served_pct })}</span>
          </Box>
          {q.accessibility.targets.map((x) => (
            <Box key={`${x.category}-${x.name}`} sx={{ display: "flex", gap: 0.75, alignItems: "baseline" }}>
              <span style={{ minWidth: 0, flex: 1, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{x.name}</span>
              {x.served ? (
                q.accessibility.cutoffs_min.map((m) => (
                  <span key={m} style={{ color: qualityColor(x.within[m], theme), fontWeight: 700, minWidth: 52, textAlign: "right" }}>
                    {x.within[m]}% <span style={{ fontWeight: 400, color: theme.palette.text.secondary }}>{m}′</span>
                  </span>
                ))
              ) : (
                <span style={{ color: theme.palette.error.main, fontWeight: 700 }}>{t("network.access.unserved")}</span>
              )}
            </Box>
          ))}
        </Box>
      )}
      {findings.length > 0 ? (
        <Box sx={{ display: "flex", flexDirection: "column", gap: 0.35 }}>
          {findings.map((x, i) => {
            const Icon = LEVEL_ICON[x.level] || InfoOutlinedIcon;
            const text = findingText(x, t, language);
            return (
              <Box key={i} sx={{ display: "flex", alignItems: "flex-start", gap: 0.5, fontSize: "0.72rem", lineHeight: 1.4, color: LEVEL_COLOR[x.level] }} data-testid="quality-finding">
                <Icon sx={{ fontSize: 13, mt: 0.25, flexShrink: 0 }} />
                <span>
                  {text.message}
                  {text.hint && !dense ? <span style={{ color: theme.palette.text.secondary }}>{` ${text.hint}`}</span> : null}
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
      <Chip size="small" icon={<VerifiedOutlinedIcon sx={{ fontSize: 14, color: `${color} !important` }} />} label={`${t("network.quality.score", { score: quality.score })} · ${quality.grade || ""}`} onClick={onClick || undefined} data-testid="quality-badge" sx={{ height: 24, fontSize: "0.7rem", fontWeight: 800, color, background: alpha(color, theme.palette.mode === "dark" ? 0.18 : 0.1), "&:hover": { background: alpha(color, theme.palette.mode === "dark" ? 0.26 : 0.16) } }} />
    </Tooltip>
  );
}
