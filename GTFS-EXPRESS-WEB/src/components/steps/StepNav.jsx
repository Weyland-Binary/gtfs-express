/**
 * The rail of a modify project's steps, three shown 1-2-3: ① network and brief, ③ change, ⑤ delivery (still 5 in
 * its address; ② is a page reached by its links, never by the rail). Each step's state is said in text, never by
 * colour alone.
 */

import React, { useRef } from "react";
import { Box, Button, ButtonBase, Tooltip, Typography, alpha, useMediaQuery, useTheme } from "@mui/material";
import CheckRoundedIcon from "@mui/icons-material/CheckRounded";
import LockOutlinedIcon from "@mui/icons-material/LockOutlined";
import ReplayRoundedIcon from "@mui/icons-material/ReplayRounded";
import ArrowBackRoundedIcon from "@mui/icons-material/ArrowBackRounded";
import { useLanguage } from "../../contexts/LanguageContext";

export const STEPS = Object.freeze([1, 3, 5]);

/** The number a step is shown by: its place on the rail (② is shown as ①). */
export const shownStep = (n) => {
  if (n === 2) return 1;
  const i = STEPS.indexOf(n);
  return i >= 0 ? i + 1 : n;
};

/** The step a number the rail does not show opens (④, an old address): the next one; ② stays its own page. */
export const stepFor = (n) => (n === 2 || STEPS.includes(n) ? n : STEPS.find((x) => x > n) || STEPS[STEPS.length - 1]);

export const stepTitleKey = (n) => (n === 1 || n === 2 || n === 3 ? `step.${n}.modify.title` : `step.${n}.title`);

export const stepHeading = (t, n, name = null) => t("step.of", { n: shownStep(n), total: STEPS.length, name: name || t(stepTitleKey(n)) });

/**
 * `locks`: { n: reasonKey }, why a step cannot be finished here (a delivered ⑤ stays done).
 * → { 1: { state, reason }, 3: …, 5: … }, reason an i18n key or null.
 */
export function stepStates({ named = false, started = false, design = "none", checks = "none", delivered = false, locks = {} } = {}) {
  const base = {
    1: named && started ? "done" : named || started ? "partial" : "todo",
    3: delivered || design === "ready" ? "done" : design === "partial" ? "partial" : "todo",
    5: delivered ? "done" : checks === "stale" ? "stale" : "todo",
  };
  const out = {};
  for (const n of STEPS) out[n] = locks[n] && !(n === 5 && delivered) ? { state: "locked", reason: locks[n] } : { state: base[n], reason: null };
  return out;
}

const ICONS = { done: CheckRoundedIcon, locked: LockOutlinedIcon, stale: ReplayRoundedIcon };

/** The step index a key moves the focus to, or null. Never with Alt, Ctrl or Meta: Alt+←/→ are the browser's Back / Forward. */
export function railKeyTarget(event, i, count = STEPS.length) {
  if (event.altKey || event.ctrlKey || event.metaKey) return null;
  const last = count - 1;
  const to = { ArrowRight: i + 1, ArrowLeft: i - 1, ArrowDown: i + 1, ArrowUp: i - 1, Home: 0, End: last }[event.key];
  return to === undefined ? null : Math.max(0, Math.min(last, to));
}

/** The rail folded in the explorer inside a project: one way back to the step. */
function FoldedRail({ step, onSelect }) {
  const { t } = useLanguage();
  return (
    <Box component="nav" aria-label={t("a11y.stepsNav")} data-testid="step-nav" data-state="folded" sx={{ px: 2, py: 0.5, display: "flex", alignItems: "center", flexWrap: "wrap", columnGap: 1.5 }}>
      <Button size="small" startIcon={<ArrowBackRoundedIcon />} onClick={() => onSelect?.(step)} data-testid="step-back-to" sx={{ textTransform: "none", fontWeight: 700, flexShrink: 0 }}>
        {t("step.backToStep", { n: shownStep(step) }).replace(/^←\s*/, "")}
      </Button>
    </Box>
  );
}

export default function StepNav({ current = 1, states = {}, onSelect, folded = false, actions = null }) {
  const { t } = useLanguage();
  const theme = useTheme();
  const narrow = useMediaQuery(theme.breakpoints.down("md"));
  const allNames = useMediaQuery("(min-width:1760px)");
  const refs = useRef([]);
  const studio = Boolean(theme.studio);
  const steps = STEPS;
  if (folded) return <FoldedRail step={current} onSelect={onSelect} />;

  const titleOf = (n) => t(stepTitleKey(n));
  const stateOf = (n) => states[n]?.state || "todo";
  const stateText = (n) => {
    const state = stateOf(n);
    if (state === "todo") return null;
    const reason = states[n]?.reason ? t(states[n].reason) : null;
    return state === "locked" && reason ? `${t("step.state.locked")} : ${reason}` : t(`step.state.${state}`);
  };
  const onKeyDown = (event, i) => {
    const target = railKeyTarget(event, i, steps.length);
    if (target === null) return;
    event.preventDefault();
    refs.current[target]?.focus();
  };

  if (narrow) {
    return (
      <Box component="nav" aria-label={t("a11y.stepsNav")} data-testid="step-nav" sx={{ px: 2, py: 0.75, display: "flex", alignItems: "center", gap: 1, borderBottom: `1px solid ${theme.palette.divider}` }}>
        <Box component="select" value={current} onChange={(e) => onSelect?.(Number(e.target.value))} data-testid="step-select" aria-label={t("a11y.stepsNav")} sx={{ flex: 1, minWidth: 0, font: "inherit", fontSize: "0.9rem", fontWeight: 700, p: 0.75, borderRadius: 1, border: `1px solid ${theme.palette.divider}`, background: theme.palette.background.paper, color: theme.palette.text.primary }}>
          {steps.map((n) => (
            <option key={n} value={n}>
              {stepHeading(t, n)}
              {stateText(n) ? ` (${stateText(n)})` : ""}
            </option>
          ))}
        </Box>
        {actions}
      </Box>
    );
  }

  if (studio) {
    const k = theme.studio;
    return (
      <Box component="nav" aria-label={t("a11y.stepsNav")} data-testid="step-nav" data-compact="true" sx={{ display: "flex", alignItems: "center", gap: 1, px: 2, py: 0.5, minWidth: 0 }}>
        <Box component="ol" sx={{ listStyle: "none", m: 0, p: 0, display: "flex", alignItems: "center", gap: "2px", minWidth: 0 }}>
          {steps.map((n, i) => {
            const state = stateOf(n);
            const isNow = n === current;
            const words = stateText(n);
            const named = isNow || allNames;
            const ring = state === "done" ? k.success : state === "partial" || state === "stale" ? k.warning : isNow ? k.accent : k.lineStrong;
            const Icon = ICONS[state];
            return (
              <Box component="li" key={n} sx={{ display: "flex", alignItems: "center" }}>
                {i > 0 && <Box aria-hidden sx={{ width: 12, height: "1px", mx: "3px", backgroundColor: k.lineStrong }} />}
                <Tooltip title={`${stepHeading(t, n)}${words ? ` (${words})` : ""}`}>
                  <ButtonBase
                    ref={(el) => {
                      refs.current[i] = el;
                    }}
                    onClick={() => onSelect?.(n)}
                    onKeyDown={(e) => onKeyDown(e, i)}
                    data-testid={`step-${n}`}
                    data-state={state}
                    aria-current={isNow ? "step" : undefined}
                    sx={{ height: 30, display: "flex", alignItems: "center", gap: "7px", pl: "5px", pr: named ? "11px" : "5px", borderRadius: 999, color: isNow ? (theme.palette.mode === "dark" ? k.accent : k.accentDark) : k.ink2, backgroundColor: isNow ? k.accentSoft : "transparent", "&:hover": { backgroundColor: isNow ? k.accentSoft : k.hover, color: k.ink } }}
                  >
                    <Box aria-hidden sx={{ width: 20, height: 20, borderRadius: "50%", flexShrink: 0, display: "flex", alignItems: "center", justifyContent: "center", fontSize: "0.68rem", fontWeight: 600, fontVariantNumeric: "tabular-nums", color: state === "done" || (isNow && !Icon) ? k.onAccent : ring === k.lineStrong ? k.ink2 : ring, backgroundColor: state === "done" ? k.success : isNow && !Icon ? k.accent : "transparent", border: state === "done" || (isNow && !Icon) ? "none" : `1.5px ${state === "locked" ? "dashed" : "solid"} ${ring}` }}>
                      {Icon ? <Icon sx={{ fontSize: 13 }} /> : shownStep(n)}
                    </Box>
                    <Typography component="span" className={named ? undefined : "visually-hidden"} sx={{ fontSize: "0.8rem", fontWeight: isNow ? 600 : 500, whiteSpace: "nowrap", color: "inherit" }}>
                      {titleOf(n)}
                    </Typography>
                    {words && (
                      <Typography component="span" className="visually-hidden" data-testid={`step-${n}-state`}>
                        ({words})
                      </Typography>
                    )}
                  </ButtonBase>
                </Tooltip>
              </Box>
            );
          })}
        </Box>
        {actions}
      </Box>
    );
  }

  return (
    <Box component="nav" aria-label={t("a11y.stepsNav")} data-testid="step-nav" sx={{ display: "flex", alignItems: "center", gap: 1, px: 2, py: 0.5, borderBottom: `1px solid ${theme.palette.divider}`, background: theme.palette.background.paper }}>
      <Box component="ol" sx={{ listStyle: "none", m: 0, p: 0, display: "flex", alignItems: "center", flexWrap: "wrap", gap: 0.25, flex: 1, minWidth: 0 }}>
        {steps.map((n, i) => {
          const state = stateOf(n);
          const isNow = n === current;
          const color = state === "done" ? theme.palette.success.main : state === "partial" || state === "stale" ? theme.palette.warning.dark : isNow ? theme.palette.primary.main : theme.palette.text.secondary;
          const Icon = ICONS[state];
          const words = stateText(n);
          return (
            <Box component="li" key={n} sx={{ display: "flex", alignItems: "center" }}>
              {i > 0 && <Box aria-hidden sx={{ width: 16, height: 2, borderRadius: 1, mx: 0.25, background: alpha(theme.palette.text.primary, 0.14) }} />}
              <ButtonBase
                ref={(el) => {
                  refs.current[i] = el;
                }}
                onClick={() => onSelect?.(n)}
                onKeyDown={(e) => onKeyDown(e, i)}
                data-testid={`step-${n}`}
                data-state={state}
                aria-current={isNow ? "step" : undefined}
                sx={{ display: "flex", alignItems: "center", gap: 0.6, px: 1, py: 0.5, borderRadius: 99, background: isNow ? alpha(theme.palette.primary.main, theme.palette.mode === "dark" ? 0.2 : 0.1) : "transparent", "&:hover": { background: alpha(theme.palette.primary.main, 0.14) }, "&.Mui-focusVisible": { outline: `2px solid ${theme.palette.primary.main}`, outlineOffset: 2 } }}
              >
                <Box aria-hidden sx={{ width: 20, height: 20, borderRadius: "50%", flexShrink: 0, display: "flex", alignItems: "center", justifyContent: "center", fontSize: "0.7rem", fontWeight: 800, color: state === "done" ? "#fff" : color, background: state === "done" ? color : "transparent", border: state === "done" ? "none" : `1.5px ${state === "locked" ? "dashed" : "solid"} ${color}` }}>
                  {Icon ? <Icon sx={{ fontSize: 13 }} /> : shownStep(n)}
                </Box>
                <Typography component="span" sx={{ fontSize: "0.8rem", fontWeight: isNow ? 800 : 600, color: isNow ? "text.primary" : "text.secondary", whiteSpace: "nowrap" }}>
                  {titleOf(n)}
                </Typography>
                {words && (
                  <Typography component="span" data-testid={`step-${n}-state`} sx={{ fontSize: "0.7rem", fontWeight: 600, color, whiteSpace: state === "locked" ? "normal" : "nowrap", maxWidth: state === "locked" ? 280 : "none", textAlign: "left", lineHeight: 1.3 }}>
                    ({words})
                  </Typography>
                )}
              </ButtonBase>
            </Box>
          );
        })}
      </Box>
      {actions}
    </Box>
  );
}
