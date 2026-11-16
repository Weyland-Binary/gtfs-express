import React, { useId } from "react";
import { Box, ButtonBase, CircularProgress, LinearProgress, Typography, alpha, useTheme } from "@mui/material";
import CheckRoundedIcon from "@mui/icons-material/CheckRounded";
import InfoOutlinedIcon from "@mui/icons-material/InfoOutlined";
import PriorityHighRoundedIcon from "@mui/icons-material/PriorityHighRounded";
import { useLanguage } from "../../contexts/LanguageContext";
import { countWords } from "../../utils/countWords";
import { SEVERITIES } from "./reportModel";
import SeverityTile from "./SeverityTile";

const LABELS = { error: "validation.severity.errors", warning: "validation.severity.warnings", info: "validation.severity.infos" };

/** What the check after an edit is doing, said where the verdict's source stands. */
function CheckStatus({ check, t, theme }) {
  if (check.state === "done") {
    const { before, errors } = check;
    const outcome = before == null ? "done" : errors === 0 && before > 0 ? "clear" : errors < before ? "fewer" : errors > before ? "more" : "same";
    const tone = outcome === "more" ? theme.palette.severities.warning.main : outcome === "same" ? theme.palette.text.secondary : theme.palette.success.main;
    const words =
      outcome === "clear"
        ? t("validation.check.doneClear")
        : outcome === "fewer"
          ? countWords(t, "validation.check.doneFewer", before - errors, { count: before - errors })
          : outcome === "more"
            ? countWords(t, "validation.check.doneMore", errors - before, { count: errors - before })
            : outcome === "same"
              ? t("validation.check.doneSame")
              : t("validation.check.done");
    return (
      <Box component="span" data-testid="validation-check" data-state="done" data-outcome={outcome} sx={{ display: "inline-flex", alignItems: "center", gap: 0.5, fontWeight: 600, color: tone }}>
        {outcome === "same" || outcome === "more" ? <InfoOutlinedIcon sx={{ fontSize: 15 }} /> : <CheckRoundedIcon sx={{ fontSize: 15 }} />}
        {words}
      </Box>
    );
  }
  const running = check.state === "running";
  const words = !running
    ? t(check.reason === "copy" ? "validation.check.pendingCopy" : "validation.check.pending")
    : check.estimate && check.seconds <= check.estimate * 3
      ? t("validation.check.runningEstimate", { seconds: check.seconds, estimate: check.estimate })
      : t("validation.check.running", { seconds: check.seconds });
  return (
    <Box component="span" data-testid="validation-check" data-state={check.state} sx={{ display: "inline-flex", alignItems: "center", gap: 0.75, fontWeight: 600, color: "primary.main", fontVariantNumeric: "tabular-nums" }}>
      <CircularProgress size={12} thickness={6} color="inherit" />
      {words}
    </Box>
  );
}

/**
 * The report's head, edge to edge: the verdict, each severity's figure doubling as its filter (an empty severity
 * cannot be pressed), then the report's acts. After an edit it says its check (`check`, from useReportCheck): the
 * state in words, a bar along its foot, the figures dimmed until the fresh report. Colours from theme.palette (#19).
 */
export default function ReportHead({ findingCounts, ruleCounts, severityFilter, onToggleSeverity, onRevalidate, revalidating = false, engineVersion = null, progress = null, actions = null, check = null }) {
  const theme = useTheme();
  const { t } = useLanguage();
  const progressId = useId();
  const dark = theme.palette.mode === "dark";
  const errors = findingCounts.error || 0;
  const toneOf = (key) => (theme.palette.severities[key] || theme.palette.severities.error).main;
  const verdictTone = errors ? toneOf("error") : theme.palette.success.main;
  const hairline = `1px solid ${theme.palette.divider}`;
  const busy = check?.state === "running" || check?.state === "pending";
  const measured = check?.state === "running" && check.estimate ? Math.min(95, Math.round((check.seconds / check.estimate) * 100)) : null;
  return (
    <Box
      component="section"
      aria-label={t("validation.head.label")}
      aria-busy={busy || undefined}
      data-testid="validation-summary"
      data-verdict={errors ? "errors" : "clear"}
      sx={{ position: "relative", flexShrink: 0, display: "flex", alignItems: "stretch", flexWrap: "wrap", bgcolor: "background.paper", borderBottom: hairline }}
    >
      {busy && (
        <LinearProgress
          variant={measured == null ? "indeterminate" : "determinate"}
          value={measured ?? undefined}
          aria-label={t("validation.check.label")}
          data-testid="validation-check-bar"
          sx={{ position: "absolute", left: 0, right: 0, bottom: -1, height: 3, zIndex: 1, bgcolor: alpha(theme.palette.primary.main, 0.12) }}
        />
      )}
      <Box sx={{ flex: "1 1 320px", minWidth: 0, display: "flex", alignItems: "center", gap: 1.75, px: 3, py: 1.75, background: `linear-gradient(90deg, ${alpha(verdictTone, dark ? 0.16 : 0.09)} 0%, ${alpha(verdictTone, 0)} 80%)` }}>
        <Box aria-hidden sx={{ width: 42, height: 42, flexShrink: 0, borderRadius: "50%", display: "flex", alignItems: "center", justifyContent: "center", color: theme.palette.getContrastText(verdictTone), bgcolor: verdictTone, boxShadow: `0 0 0 5px ${alpha(verdictTone, dark ? 0.22 : 0.14)}` }}>
          {errors ? <PriorityHighRoundedIcon sx={{ fontSize: 22 }} /> : <CheckRoundedIcon sx={{ fontSize: 22 }} />}
        </Box>
        <Box sx={{ minWidth: 0 }}>
          <Typography component="h2" data-testid="validation-verdict" sx={{ fontSize: "1.2rem", fontWeight: 650, letterSpacing: "-0.01em", lineHeight: 1.3, color: verdictTone }}>
            {errors ? countWords(t, "validation.verdict.errors", errors) : t("validation.verdict.clear")}
          </Typography>
          <Box role="status" sx={{ mt: 0.25, display: "flex", alignItems: "center", gap: 0.75, flexWrap: "wrap", fontSize: "0.8rem", color: "text.secondary" }}>
            {check?.state ? (
              <CheckStatus check={check} t={t} theme={theme} />
            ) : (
              <span>{engineVersion ? t("validation.verdict.engine", { version: engineVersion }) : t("validation.verdict.by")}</span>
            )}
            {onRevalidate && !check?.state && (
              <>
                <span aria-hidden>·</span>
                <ButtonBase
                  onClick={onRevalidate}
                  disabled={revalidating}
                  data-testid="validation-revalidate"
                  sx={{ font: "inherit", fontWeight: 600, color: "primary.main", gap: 0.5, borderRadius: "4px", "&.Mui-disabled": { color: "text.secondary" }, "&:hover": { textDecoration: "underline" }, "&.Mui-focusVisible": { outline: `2px solid ${theme.palette.primary.main}`, outlineOffset: 2 } }}
                >
                  {revalidating && <CircularProgress size={11} thickness={6} color="inherit" />}
                  {t(revalidating ? "validation.revalidate.running" : "validation.revalidate.button")}
                </ButtonBase>
              </>
            )}
          </Box>
          {progress && (
            <Box sx={{ mt: 1, display: "flex", alignItems: "center", gap: 1.25 }}>
              <LinearProgress
                variant="determinate"
                color="success"
                value={Math.min(100, Math.round((progress.fixed / progress.total) * 100))}
                aria-labelledby={progressId}
                sx={{ width: 200, height: 5, borderRadius: 3, bgcolor: alpha(theme.palette.text.primary, 0.08) }}
              />
              <Typography id={progressId} sx={{ fontSize: "0.75rem", color: "text.secondary", fontVariantNumeric: "tabular-nums" }}>
                {t("validation.rescue.progress", { fixed: progress.fixed, total: progress.total })}
              </Typography>
            </Box>
          )}
        </Box>
      </Box>

      <Box role="group" aria-label={t("validation.verdict.filters")} sx={{ display: "flex", alignItems: "stretch" }}>
        {SEVERITIES.map((key) => {
          const count = findingCounts[key] || 0;
          const none = count === 0;
          const on = !none && severityFilter.has(key);
          const tone = none ? theme.palette.success.main : toneOf(key);
          return (
            <ButtonBase
              key={key}
              data-testid={`validation-tile-${key}`}
              data-active={on ? "true" : "false"}
              aria-pressed={none ? undefined : on}
              disabled={none}
              onClick={() => onToggleSeverity(key)}
              sx={{
                minWidth: 150,
                px: 2.25,
                py: 1.25,
                display: "flex",
                alignItems: "center",
                justifyContent: "flex-start",
                gap: 1.25,
                textAlign: "left",
                borderLeft: hairline,
                bgcolor: on ? alpha(tone, dark ? 0.14 : 0.07) : "transparent",
                // Until the fresh report, the figures are the old ones: dimmed, never read as current.
                "& > *": { opacity: busy ? 0.4 : none || on ? 1 : 0.45, transition: "opacity 160ms" },
                transition: "background-color 160ms",
                "&:hover": none ? undefined : { bgcolor: alpha(tone, dark ? 0.2 : 0.11) },
                "&.Mui-focusVisible": { outline: `2px solid ${theme.palette.primary.main}`, outlineOffset: -2 },
              }}
            >
              <SeverityTile severity={none ? "ok" : key} size={34} />
              <Box sx={{ display: "flex", flexDirection: "column", gap: 0.25, minWidth: 0 }}>
                <Typography component="span" sx={{ fontSize: "1.4rem", fontWeight: 650, letterSpacing: "-0.02em", lineHeight: 1.1, fontVariantNumeric: "tabular-nums", color: tone }}>
                  {count.toLocaleString()}
                </Typography>
                <Typography component="span" noWrap sx={{ fontSize: "0.75rem", color: "text.secondary" }}>
                  {t(LABELS[key])} · {none ? t("validation.summary.none") : countWords(t, "validation.summary.rules", ruleCounts[key] || 0)}
                </Typography>
              </Box>
            </ButtonBase>
          );
        })}
      </Box>

      {actions && <Box sx={{ display: "flex", alignItems: "center", gap: 1, px: 3, py: 1.75, borderLeft: hairline }}>{actions}</Box>}
    </Box>
  );
}
