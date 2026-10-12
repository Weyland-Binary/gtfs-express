/**
 * StepNav — the rail of the project's steps (target design §2.2, D2).
 * Creating: ① Réseau et documents → ② Contrat → ③ Conception → ④ Contrôles
 * → ⑤ Livraison. Modifying (Lot H, 2026-10-05): ① Réseau → ② Objectifs →
 * ③ Changement → ④ Livraison — the checks run while the change is
 * simulated (③) and are read where it is applied, so the delivery holds
 * them; it keeps its own number 5 inside (its address /p/:id/5, the
 * projects that recorded it), shown as the fourth (`stepsOf`,
 * `shownStep`; a modify /p/:id/4 opens it). It generalises the Network
 * Studio's JourneySteps (territory → brief → design → construction) to the
 * project's journey, and says the state of each step honestly:
 *
 *   todo      still ahead;
 *   partial   started, not finished (a name without a network, clauses not
 *             all decided, a design with problems);
 *   done      finished;
 *   locked    cannot be finished here — the reason is written next to it
 *             (edit mode, the plan's size, no validator on this server); the
 *             step still opens, to show the reason and its action in place;
 *   stale     "to redo": the checks (④) and the delivery (⑤) once the design
 *             or the plan changed after they ran — only while nothing was
 *             built or applied (after that the scenario is frozen, D37).
 *
 * `stepStates(facts)` computes the states from what the flow knows (pure,
 * tested); the rail renders them: a `<nav aria-label="Étapes">` (step-nav)
 * of buttons step-1 … step-5 with `data-state`, `aria-current="step"` on
 * the current one, the state in text (never the colour alone), ←/→ and
 * ↑/↓ (Home / End) moving the focus from step to step, ← and → following
 * the reading direction (in Arabic → goes back) — no Alt+←/→, the
 * browser's own Back / Forward (D40): with Alt held the arrows are left to
 * the browser. Under `md` the rail is a native
 * select "Étape 3 sur 5 : Changement". In the explorer inside a project the
 * rail folds into one button, "← Retour à l'étape N" (`folded`), and — in a
 * modify project — says which network the reader shows (`copy`,
 * `reader-copy`: the working copy as received v0, as a version, or with the
 * change applied in vN; utils/changeStates.workingCopyOf), that the simulated
 * draft is not in it (« Voir le brouillon »: the reader's own « Après » while a
 * draft is simulated, else ③), and in edit mode
 * that the retouches made there change the working copy directly, outside
 * the change's plan: the reader is the change's context, never mistaken for
 * its draft (the owner's direction of 2026-10-07).
 *
 * In the Network Studio's bar (the studio's theme, `theme.studio`) the rail
 * is compact: each step a mark — a tick once done, its number, a lock, the
 * "to redo" arrow, a ring in the warning tone while partial — the current
 * step's name beside it (every name on a very wide screen), the other names
 * and every state in words for screen readers and in a tooltip.
 */

import React, { useRef } from "react";
import { Box, Button, ButtonBase, Tooltip, Typography, alpha, useMediaQuery, useTheme } from "@mui/material";
import CheckRoundedIcon from "@mui/icons-material/CheckRounded";
import LockOutlinedIcon from "@mui/icons-material/LockOutlined";
import ReplayRoundedIcon from "@mui/icons-material/ReplayRounded";
import ArrowBackRoundedIcon from "@mui/icons-material/ArrowBackRounded";
import { useLanguage } from "../../contexts/LanguageContext";

export const STEPS = Object.freeze([1, 2, 3, 4, 5]);
// Modifying: ① the network and the brief — which holds the objectives since the owner's UX lot 2 (2026-10-11: « ①
// et ② fusionnés en un écran Cahier des charges »; ② stays a page of its own, reached by the links that name it,
// never by the rail) —, ③ the change, ⑤ the delivery (no ④ of its own).
export const MODIFY_STEPS = Object.freeze([1, 3, 5]);

/** The steps a job shows, by their numbers inside: creating, the five; modifying, three. */
export const stepsOf = (job) => (job === "modify" ? MODIFY_STEPS : STEPS);

/** The number a step is shown by: its place among the job's steps (a modify delivery, 5 inside, is the third; a modify ② is ①'s). */
export const shownStep = (n, job) => {
  if (job === "modify" && n === 2) return 1;
  const i = stepsOf(job).indexOf(n);
  return i >= 0 ? i + 1 : n;
};

/** The step a job opens for a number it does not show (a modify ④, an old address): the next one it has — a modify ② stays its own page. */
export const stepFor = (n, job) => {
  const list = stepsOf(job);
  if (job === "modify" && n === 2) return 2;
  return list.includes(n) ? n : list.find((x) => x > n) || list[list.length - 1];
};

/** The key of a step's name: ③ is "Conception" when creating, "Changement" when modifying; modifying, ① is "Réseau et cahier des charges" and ② "Objectifs". */
export const stepTitleKey = (n, job = "create") => (n === 3 ? `step.3.${job === "modify" ? "modify" : "create"}.title` : (n === 1 || n === 2) && job === "modify" ? `step.${n}.modify.title` : `step.${n}.title`);

/** "Étape 3 sur 4 : Changement": a step's heading, numbered as the job shows it (`name` in place of the step's own). */
export const stepHeading = (t, n, job, name = null) => t("step.of", { n: shownStep(n, job), total: stepsOf(job).length, name: name || t(stepTitleKey(n, job)) });

/**
 * The state of each step, from what the flow knows:
 *   named      the project has a name
 *   started    ① beyond the name: the design begun (create), the network chosen (modify)
 *   contract   the contract's status (draft | decided | assumed | empty) and `clauses` its count
 *   design     none | partial | ready — ③: nothing yet, something with problems, ready to check
 *   checks     none | fresh | stale — ④: not run, run on the current design, run on an older one
 *   delivered  a version was built or applied (the scenario is frozen, D37)
 *   locks      { n: reasonKey } — why a step cannot be finished here (a delivered ⑤ stays done)
 * → { 1: { state, reason }, … 5: { state, reason } } (reason: an i18n key, or null)
 */
export function stepStates({ named = false, started = false, contract = "draft", clauses = 0, design = "none", checks = "none", delivered = false, locks = {} } = {}) {
  const base = {
    1: named && started ? "done" : named || started ? "partial" : "todo",
    2: ["decided", "assumed", "empty"].includes(contract) ? "done" : clauses > 0 ? "partial" : "todo",
    3: delivered || design === "ready" ? "done" : design === "partial" ? "partial" : "todo",
    4: checks === "fresh" || delivered ? "done" : checks === "stale" ? "stale" : "todo",
    5: delivered ? "done" : checks === "stale" ? "stale" : "todo",
  };
  const out = {};
  for (const n of STEPS) out[n] = locks[n] && !(n >= 4 && delivered) ? { state: "locked", reason: locks[n] } : { state: base[n], reason: null };
  return out;
}

const ICONS = { done: CheckRoundedIcon, locked: LockOutlinedIcon, stale: ReplayRoundedIcon };

/** Whether an element reads right to left (the interface in Arabic). */
const isRtl = (el) => {
  try {
    const computed = el && typeof window !== "undefined" ? window.getComputedStyle(el).direction : "";
    if (computed === "rtl" || computed === "ltr") return computed === "rtl";
    // No computed direction: the nearest `dir`, else the document's.
    return (el?.closest?.("[dir]")?.getAttribute("dir") || document.documentElement.dir) === "rtl";
  } catch {
    return false;
  }
};

/**
 * Where a key moves the focus along the rail from step index `i` (0-based) of
 * `count`, or null when the key is not the rail's: ↓ and ↑ go to the next and
 * the previous step, → and ← too in the reading direction (reversed right to
 * left), Home and End to the ends. A key pressed with Alt, Ctrl or Meta is
 * never the rail's: Alt+←/→ are the browser's Back / Forward (D40).
 */
export function railKeyTarget(event, i, count = STEPS.length) {
  if (event.altKey || event.ctrlKey || event.metaKey) return null;
  const last = count - 1;
  const forward = isRtl(event.currentTarget) ? -1 : 1;
  const to = { ArrowRight: i + forward, ArrowLeft: i - forward, ArrowDown: i + 1, ArrowUp: i - 1, Home: 0, End: last }[event.key];
  return to === undefined ? null : Math.max(0, Math.min(last, to));
}

/**
 * Which network the reader of a modify project shows (`copy`: { state: workingCopyOf, edits: the retouches no version
 * holds yet, draft: the draft's operations not applied, editing, onSeeDraft }), in words.
 */
export function ReaderCopy({ copy }) {
  const { t } = useLanguage();
  const theme = useTheme();
  if (!copy?.state) return null;
  const { state, edits = 0, draft = 0, editing = false, onSeeDraft = null, lens = false } = copy;
  const said = t(`reader.copy.${state.kind}`, { n: state.n });
  // « Après »: the reader shows the simulated draft, not the working copy (ReaderLens says the rest).
  if (lens) {
    return (
      <Box data-testid="reader-copy" data-state="lens" sx={{ display: "flex", alignItems: "center", minWidth: 0, fontSize: "0.76rem", lineHeight: 1.45 }}>
        <Typography component="span" sx={{ fontSize: "inherit", fontWeight: 700, color: theme.palette.warning.dark }}>
          {t("reader.copy.lens", { count: draft })}
        </Typography>
      </Box>
    );
  }
  return (
    <Box data-testid="reader-copy" data-state={state.kind} data-version={state.n} sx={{ display: "flex", alignItems: "center", flexWrap: "wrap", columnGap: 1, rowGap: 0.25, minWidth: 0, fontSize: "0.76rem", color: "text.secondary", lineHeight: 1.45 }}>
      <Typography component="span" sx={{ fontSize: "inherit", fontWeight: 700, color: state.kind === "applied" ? theme.palette.success.dark : "text.primary" }}>
        {said}
      </Typography>
      {edits > 0 && (
        <Typography component="span" data-testid="reader-copy-retouched" sx={{ fontSize: "inherit" }}>
          {t("reader.copy.retouched", { count: edits })}
        </Typography>
      )}
      {draft > 0 && (
        <Typography component="span" data-testid="reader-copy-draft" sx={{ fontSize: "inherit" }}>
          {t("reader.copy.draft", { count: draft })}
          {onSeeDraft && (
            <Button size="small" onClick={onSeeDraft} data-testid="reader-copy-see-draft" sx={{ ml: 0.5, p: 0, minWidth: 0, verticalAlign: "baseline", textTransform: "none", fontSize: "inherit", fontWeight: 700 }}>
              {t("reader.copy.seeDraft")}
            </Button>
          )}
        </Typography>
      )}
      {editing && (
        <Typography component="span" data-testid="reader-copy-editing" sx={{ fontSize: "inherit", color: theme.palette.warning.dark }}>
          {t("reader.copy.editing")}
        </Typography>
      )}
    </Box>
  );
}

/** The rail folded in the explorer inside a project: one way back to the step, and what the reader shows. */
function FoldedRail({ step, job, onSelect, copy = null }) {
  const { t } = useLanguage();
  return (
    <Box component="nav" aria-label={t("a11y.stepsNav")} data-testid="step-nav" data-state="folded" sx={{ px: 2, py: 0.5, display: "flex", alignItems: "center", flexWrap: "wrap", columnGap: 1.5 }}>
      <Button size="small" startIcon={<ArrowBackRoundedIcon />} onClick={() => onSelect?.(step)} data-testid="step-back-to" sx={{ textTransform: "none", fontWeight: 700, flexShrink: 0 }}>
        {t("step.backToStep", { n: shownStep(step, job) }).replace(/^←\s*/, "")}
      </Button>
      <ReaderCopy copy={copy} />
    </Box>
  );
}

export default function StepNav({ job = "create", current = 1, states = {}, onSelect, folded = false, actions = null, copy = null }) {
  const { t } = useLanguage();
  const theme = useTheme();
  const narrow = useMediaQuery(theme.breakpoints.down("md"));
  const allNames = useMediaQuery("(min-width:1760px)");
  const refs = useRef([]);
  const studio = Boolean(theme.studio);
  const steps = stepsOf(job);
  if (folded) return <FoldedRail step={current} job={job} onSelect={onSelect} copy={copy} />;

  const titleOf = (n) => t(stepTitleKey(n, job));
  const stateOf = (n) => states[n]?.state || "todo";
  // The state in words, next to the name: "(fait)", "(verrouillée : Nécessite l'édition…)".
  const stateText = (n) => {
    const state = stateOf(n);
    if (state === "todo") return null;
    const reason = states[n]?.reason ? t(states[n].reason) : null;
    return state === "locked" && reason ? `${t("step.state.locked")} : ${reason}` : t(`step.state.${state}`);
  };
  // Arrows move the focus along the rail; Enter / Space follow the step.
  const onKeyDown = (event, i) => {
    const target = railKeyTarget(event, i, steps.length);
    if (target === null) return;
    event.preventDefault();
    refs.current[target]?.focus();
  };

  if (narrow) {
    return (
      <Box component="nav" aria-label={t("a11y.stepsNav")} data-testid="step-nav" data-job={job} sx={{ px: 2, py: 0.75, display: "flex", alignItems: "center", gap: 1, borderBottom: `1px solid ${theme.palette.divider}` }}>
        <Box component="select" value={current} onChange={(e) => onSelect?.(Number(e.target.value))} data-testid="step-select" aria-label={t("a11y.stepsNav")} sx={{ flex: 1, minWidth: 0, font: "inherit", fontSize: "0.9rem", fontWeight: 700, p: 0.75, borderRadius: 1, border: `1px solid ${theme.palette.divider}`, background: theme.palette.background.paper, color: theme.palette.text.primary }}>
          {steps.map((n) => (
            <option key={n} value={n}>
              {stepHeading(t, n, job)}
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
      <Box component="nav" aria-label={t("a11y.stepsNav")} data-testid="step-nav" data-job={job} data-compact="true" sx={{ display: "flex", alignItems: "center", gap: 1, px: 2, py: 0.5, minWidth: 0 }}>
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
                <Tooltip title={`${stepHeading(t, n, job)}${words ? ` (${words})` : ""}`}>
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
                      {Icon ? <Icon sx={{ fontSize: 13 }} /> : shownStep(n, job)}
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
    <Box component="nav" aria-label={t("a11y.stepsNav")} data-testid="step-nav" data-job={job} sx={{ display: "flex", alignItems: "center", gap: 1, px: 2, py: 0.5, borderBottom: `1px solid ${theme.palette.divider}`, background: theme.palette.background.paper }}>
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
                  {Icon ? <Icon sx={{ fontSize: 13 }} /> : shownStep(n, job)}
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
