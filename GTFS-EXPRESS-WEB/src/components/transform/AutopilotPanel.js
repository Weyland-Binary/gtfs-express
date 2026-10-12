/**
 * AutopilotPanel — ③ Changement builds the change by itself (owner's request
 * of 2026-10-05: « l'utilisateur dépose son GTFS et son cahier des charges ;
 * le changement se construit seul, questions seulement si nécessaire ») and
 * says, in one place, where it stands:
 *
 *   what it read        the timetables of the brief's sheets (and the blocks it
 *                       could not take, each with why), the suggestions retained
 *                       at ②, the prose brief the assistant reads, the dates of
 *                       ②'s « Mise en service » it wrote where the brief gives none
 *   what it is doing    reading · writing · simulating · validating
 *   what was measured   the objectives met, the canonical validator's answer
 *   what it decided     the answers the engine took by itself because the
 *                       brief or the network give them (each recorded as an
 *                       assumption the person reads again at the delivery),
 *                       each one changeable here
 *   what it needs       the engine's questions, each asked once, answered here
 *
 * Nothing is computed here: the view is utils/autopilot.autopilotView's, read
 * from the simulation the server returned. Nothing is said only in a tooltip:
 * what a line counts unfolds under it (keyboard and touch read it too).
 *
 *   autopilot-panel            the block (`data-stage`: locked | empty | working | questions | blocked | nochange |
 *                              ready; `data-busy`: reading | planning | simulating | validating)
 *   autopilot-headline         the one sentence that says where the change stands (`data-gaps`: the objectives and
 *                              default guarantees not met or not measurable beside « ready », each named)
 *   autopilot-line             one fact of the list (`data-line`: grids | skipped | covered | suggestions | brief |
 *                              dates | operations | simulation | objectives | desired | guarantees | validator |
 *                              remarks | failed | stuck | accept | uncovered; `simulation`: the simulation's own
 *                              request failed, `autopilot-resimulate`; `data-state`: done | running | waiting |
 *                              problem). `skipped`, `covered` and `remarks` unfold (`autopilot-line-toggle`,
 *                              `autopilot-line-item`): the blocks of the sheets the change does not take; what the
 *                              cell reader could not take and an operation of the change builds from its cells
 *                              (`sources.covered`: [{ text, whole }], said with that operation, never missing — the
 *                              line waits while one of them is only partly covered: the rest is the person's to
 *                              check); what the brief states that no objective measures and no operation carries out
 *                              (kept « à vérifier à la main »). `desired`: the person's desired clauses, apart from
 *                              their mandatory objectives — never a gap to accept
 *   autopilot-validator-rule   one per rule the change breaks (the gate's list); `autopilot-errors` opens the
 *                              delivery's validator tab; `autopilot-revalidate` runs the validator again when its
 *                              request failed
 *   autopilot-brief-retry      asks the assistant again to read the prose brief (its turn failed, or never ran)
 *   autopilot-question         one per question waiting (`autopilot-answer-option`, `autopilot-answer-input`)
 *   autopilot-daytitle         the journey's own question: grids of the brief under a title the sheet reader could
 *                              not read as a day type (« FHD », `data-title`) — which days do they run?
 *                              (`autopilot-daytitle-option`, `data-value`: weekday | saturday | sunday |
 *                              public_holidays | none)
 *   autopilot-eta              while it works: how long it has been running and how long it usually takes
 *                              (`data-busy`); `autopilot-stop` stops the assistant's reading (the plan so far stays)
 *   autopilot-feed             while the assistant reads: what it just read or wrote, one line per tool call
 *                              (`autopilot-feed-line`, `data-tool`) — the wait screen that teaches (UX lot 3)
 *   autopilot-impact           once ready: what the change does in figures (trips, hours, kilometres before → after)
 *   autopilot-decisions        the engine's own answers, folded under their count (`autopilot-decisions-toggle`) —
 *                              unfolded by themselves once the change is ready: the person reads them before the
 *                              delivery asks them to accept them (owner's UX lot 1, 2026-10-11)
 *   autopilot-decision         one of them (`data-code`); `autopilot-decision-change` shows the other answers its
 *                              question offered (`autopilot-decision-option`)
 *   autopilot-objectives       to ② while the objectives are not decided
 *   autopilot-rebuild          « Reconstruire »: asks first (`autopilot-rebuild-confirm`, `autopilot-rebuild-yes`,
 *                              `autopilot-rebuild-no`), then the change is emptied and built again from the brief
 *                              and the objectives
 *   autopilot-delivery         « Voir la livraison » once the change is ready — a text link: the step's one primary
 *                              action (StepFrame's `step-primary`) is the same act, this is its echo in the panel
 */

import React, { useEffect, useRef, useState } from "react";
import { Box, Button, Chip, CircularProgress, Typography } from "@mui/material";
import { useTheme } from "@mui/material/styles";
import CheckCircleRoundedIcon from "@mui/icons-material/CheckCircleRounded";
import ErrorOutlineRoundedIcon from "@mui/icons-material/ErrorOutlineRounded";
import HelpOutlineRoundedIcon from "@mui/icons-material/HelpOutlineRounded";
import RadioButtonUncheckedRoundedIcon from "@mui/icons-material/RadioButtonUncheckedRounded";
import LockOutlinedIcon from "@mui/icons-material/LockOutlined";
import ArrowForwardRoundedIcon from "@mui/icons-material/ArrowForwardRounded";
import StopRoundedIcon from "@mui/icons-material/StopRounded";
import { useLanguage } from "../../contexts/LanguageContext";
import { tokensOf } from "../studio/studioTheme";
import LockedAction from "../common/LockedAction";
import { operationText } from "../common/SpreadsheetImport";
import { ImpactStrip, QuestionBox } from "./ChangePlanParts";
import { opTitle, optionLabel } from "./catalogueText";
import { DAY_TITLE_ANSWERS } from "../../utils/autopilot";
import { guaranteesSaid } from "../../utils/objectiveCounts";

const STAGE_TONE = { ready: "success", nochange: "success", questions: "warning", blocked: "error" };
// A list a line unfolds shows this many items, then says how many more.
const LINE_ITEMS = 40;
// An answer's chip wraps: two stops or two routes that differ at the end are never cut where they differ.
const chipSx = { fontWeight: 600, fontSize: "0.72rem", height: "auto", minHeight: 24, "& .MuiChip-label": { whiteSpace: "normal", py: 0.25 } };

/** One fact of the list: its state as an icon, its sentence — and, when it counts things, the things under it. */
function Line({ id, state, children, k, items = null, more = 0, t = null, action = null }) {
  const [open, setOpen] = useState(false);
  const icon =
    state === "running" ? (
      <CircularProgress size={13} thickness={5} sx={{ color: k.accent, mt: "3px", flexShrink: 0 }} />
    ) : state === "done" ? (
      <CheckCircleRoundedIcon aria-hidden sx={{ fontSize: 16, color: k.success, mt: "2px", flexShrink: 0 }} />
    ) : state === "problem" ? (
      <ErrorOutlineRoundedIcon aria-hidden sx={{ fontSize: 16, color: k.error, mt: "2px", flexShrink: 0 }} />
    ) : (
      <RadioButtonUncheckedRoundedIcon aria-hidden sx={{ fontSize: 16, color: k.ink3, mt: "2px", flexShrink: 0 }} />
    );
  return (
    <Box component="li" data-testid="autopilot-line" data-line={id} data-state={state} sx={{ display: "flex", flexDirection: "column", gap: 0.25 }}>
      <Box sx={{ display: "flex", gap: 0.75, alignItems: "flex-start" }}>
        {icon}
        <Typography sx={{ flex: 1, minWidth: 0, fontSize: "0.78rem", color: state === "waiting" ? k.ink2 : k.ink, lineHeight: 1.45, overflowWrap: "anywhere" }}>{children}</Typography>
        {items && items.length > 0 && t && (
          <Button size="small" onClick={() => setOpen((v) => !v)} aria-expanded={open} data-testid="autopilot-line-toggle" sx={{ flexShrink: 0, minWidth: 0, px: 0.75, py: 0, fontSize: "0.72rem", color: k.ink2 }}>
            {t(open ? "autopilot.line.hide" : "autopilot.line.show")}
          </Button>
        )}
        {action}
      </Box>
      {open && items && (
        <Box component="ul" sx={{ listStyle: "none", m: 0, pl: 2.75, display: "flex", flexDirection: "column", gap: 0.25 }}>
          {items.map((text, i) => (
            <Typography component="li" key={i} data-testid="autopilot-line-item" sx={{ fontSize: "0.74rem", color: k.ink2, lineHeight: 1.45, overflowWrap: "anywhere" }}>
              {text}
            </Typography>
          ))}
          {more > 0 && t && <Typography component="li" sx={{ fontSize: "0.74rem", color: k.ink3, lineHeight: 1.45 }}>{t("autopilot.line.more", { count: more })}</Typography>}
        </Box>
      )}
    </Box>
  );
}

/** One answer the engine took by itself: its sentence, and the other answers its question offered. */
function Decision({ item, def, disabled, onDecision, k }) {
  const { t } = useLanguage();
  const [open, setOpen] = useState(false);
  const param = (def?.params || []).find((p) => p.name === item.param) || item.param;
  return (
    <Box component="li" data-testid="autopilot-decision" data-code={item.code} sx={{ display: "flex", flexDirection: "column", gap: 0.25 }}>
      <Box sx={{ display: "flex", gap: 0.75, alignItems: "flex-start" }}>
        <Typography sx={{ flex: 1, minWidth: 0, fontSize: "0.76rem", color: k.ink, lineHeight: 1.45, overflowWrap: "anywhere" }}>{item.text}</Typography>
        {onDecision && item.options.length > 0 && (
          <Button size="small" onClick={() => setOpen((v) => !v)} aria-expanded={open} aria-label={t("autopilot.decisions.changeOne", { text: item.text })} disabled={disabled} data-testid="autopilot-decision-change" sx={{ flexShrink: 0, minWidth: 0, px: 0.75, py: 0, fontSize: "0.72rem", color: k.ink2 }}>
            {t("autopilot.decisions.change")}
          </Button>
        )}
      </Box>
      {open && (
        <Box sx={{ display: "flex", flexWrap: "wrap", gap: 0.5 }}>
          {item.options.slice(0, 12).map((o) => (
            // A stop is said by its name (the engine's own); an enum value in the reader's words.
            <Chip key={String(o)} size="small" disabled={disabled} label={item.replaceStop ? String(o) : item.param === "country" ? String(o).toUpperCase() : optionLabel(t, item.type, param, o)} onClick={() => { setOpen(false); onDecision(item, o); }} data-testid="autopilot-decision-option" data-value={String(o)} sx={chipSx} />
          ))}
        </Box>
      )}
    </Box>
  );
}

export default function AutopilotPanel({ view, seconds = 0, impact = null, feed = [], sources = {}, questions = [], dayTitles = [], decisions = [], catalogue = [], disabled = false, lock = null, heading = "h2", rebuildNote = null, onAnswer = null, onDayTitle = null, onDecision = null, onObjectives = null, onRebuild = null, onDelivery = null, onErrors = null, onRevalidate = null, onRetryBrief = null, onResimulate = null, onStop = null }) {
  const { t } = useLanguage();
  const k = tokensOf(useTheme());
  const [decisionsOpen, setDecisionsOpen] = useState(false);
  const [confirming, setConfirming] = useState(false);
  // The change ready: the engine's own answers unfold by themselves (the person reads them here, before the delivery
  // asks them to accept each by name); folded again by the person, they stay so until the change is built again.
  const ready = Boolean(view && view.stage === "ready");
  const wasReady = useRef(false);
  useEffect(() => {
    if (ready && !wasReady.current) setDecisionsOpen(true);
    wasReady.current = ready;
  }, [ready]);
  // An answer unmounts its own control: the keyboard's place goes to the headline, never back to the page's top.
  const headRef = useRef(null);
  const asking = questions.length + dayTitles.length;
  const asked = useRef(asking);
  useEffect(() => {
    if (asking < asked.current && typeof document !== "undefined" && (!document.activeElement || document.activeElement === document.body)) headRef.current?.focus?.();
    asked.current = asking;
  }, [asking]);
  // An applied scenario has no change being built: the delivery says what was done.
  if (!view || view.stage === "applied") return null;
  const { stage, busy } = view;
  const defOf = (type) => catalogue.find((c) => c.type === type) || null;
  const briefState = sources.briefState || null;
  // « Ready » with objectives not met or not measurable is said as it is: built, with what is left to accept — the
  // person's objectives and the default guarantees each by their name, as their own lines count them.
  const gaps = stage === "ready" ? view.gaps || 0 : 0;
  const guaranteeGaps = Math.min(gaps, view.guaranteeGaps || 0);
  const objectiveGaps = gaps - guaranteeGaps;
  const tone = gaps ? k.warning : STAGE_TONE[stage] ? k[STAGE_TONE[stage]] : k.ink;
  const headline =
    stage === "working"
      ? t(`autopilot.stage.working.${busy || "simulating"}`)
      : stage === "questions"
        ? t("autopilot.stage.questions", { count: view.questions })
        : stage === "empty" && briefState === "asked"
          ? t("autopilot.stage.asked")
          : objectiveGaps && guaranteeGaps
            ? t("autopilot.stage.ready.gaps.both", { count: objectiveGaps, guarantees: guaranteeGaps })
            : guaranteeGaps
              ? t("autopilot.stage.ready.gaps.guarantees", { count: guaranteeGaps })
              : gaps
                ? t("autopilot.stage.ready.gaps", { count: gaps })
                : t(`autopilot.stage.${stage}`);
  const skipped = sources.skipped || [];
  const skippedReasons = [...new Set(skipped.map((s) => s?.reason).filter(Boolean))].map((r) => operationText(t, r)).join(", ");
  const skippedItems = skipped.slice(0, LINE_ITEMS).map((s) => `${s?.label || "?"} — ${operationText(t, s?.reason)}${s?.sheet ? ` (${s.sheet}${s.cell ? `!${s.cell}` : ""})` : ""}`);
  // What the cell reader could not take and an operation of the change builds from its cells: in words, by the host —
  // done only when each is wholly covered (part of one still to check by hand keeps the line waiting).
  const covered = (sources.covered || []).map((c) => (typeof c === "string" ? { text: c, whole: true } : c)).filter((c) => c && c.text);
  const remarks = sources.remarks || [];
  const o = view.objectives;
  const d = view.desired;
  const g = view.guarantees;
  const guaranteesLine = guaranteesSaid(g);
  const settled = stage === "ready" || stage === "nochange" || stage === "blocked" || stage === "questions";
  const validatorState = { passed: "done", running: "running", new_errors: "problem", unavailable: "problem", failed: "problem", not_run: "waiting" }[view.validator] || "waiting";
  const baseline = view.validator === "passed" ? view.baselineErrors || 0 : 0;
  const rules = view.validator === "new_errors" ? (view.newErrorRules || []).slice(0, 5) : [];
  const Heading = heading;
  const smallButton = { flexShrink: 0, minWidth: 0, px: 0.75, py: 0, fontSize: "0.72rem", color: k.ink2 };
  return (
    <Box component="section" aria-labelledby="autopilot-title" data-testid="autopilot-panel" data-stage={stage} data-busy={busy || undefined} sx={{ display: "flex", flexDirection: "column", gap: 1, p: 1.5, borderRadius: "12px", border: `1px solid ${stage === "ready" && !gaps ? k.success : stage === "questions" || gaps ? k.warning : k.line}`, backgroundColor: k.surface }}>
      <Box sx={{ display: "flex", alignItems: "center", gap: 1 }}>
        <Typography id="autopilot-title" component={Heading} sx={{ flex: 1, minWidth: 0, m: 0, fontSize: "0.72rem", fontWeight: 600, letterSpacing: "0.04em", textTransform: "uppercase", color: k.ink2 }}>
          {t("autopilot.title")}
        </Typography>
        {onRebuild && stage !== "locked" && !confirming && (
          <Button size="small" onClick={() => setConfirming(true)} disabled={disabled && stage !== "working"} data-testid="autopilot-rebuild" sx={smallButton}>
            {t("autopilot.rebuild")}
          </Button>
        )}
      </Box>
      {/* « Reconstruire » empties what the person wrote too: said in words, confirmed, before anything goes. */}
      {confirming && onRebuild && (
        <Box role="alertdialog" aria-labelledby="autopilot-rebuild-text" data-testid="autopilot-rebuild-confirm" sx={{ p: 1, borderRadius: "8px", backgroundColor: k.warningSoft, display: "flex", flexDirection: "column", gap: 0.75 }}>
          <Typography id="autopilot-rebuild-text" sx={{ fontSize: "0.76rem", color: k.ink, lineHeight: 1.45 }}>
            {t("autopilot.rebuild.confirm")}
            {rebuildNote ? ` ${rebuildNote}` : ""}
          </Typography>
          <Box sx={{ display: "flex", gap: 0.75 }}>
            <Button size="small" variant="contained" disableElevation color="warning" onClick={() => { setConfirming(false); onRebuild(); }} data-testid="autopilot-rebuild-yes" sx={{ fontWeight: 600 }}>
              {t("autopilot.rebuild")}
            </Button>
            <Button size="small" onClick={() => setConfirming(false)} data-testid="autopilot-rebuild-no" sx={{ color: k.ink2 }}>
              {t("app.cancel")}
            </Button>
          </Box>
        </Box>
      )}
      <Box sx={{ display: "flex", alignItems: "flex-start", gap: 0.75 }}>
        {stage === "working" ? (
          <CircularProgress size={16} thickness={5} sx={{ color: k.accent, mt: "3px", flexShrink: 0 }} />
        ) : gaps ? (
          <ErrorOutlineRoundedIcon aria-hidden sx={{ fontSize: 20, color: k.warning, mt: "1px", flexShrink: 0 }} />
        ) : stage === "ready" || stage === "nochange" ? (
          <CheckCircleRoundedIcon aria-hidden sx={{ fontSize: 20, color: k.success, mt: "1px", flexShrink: 0 }} />
        ) : stage === "questions" || (stage === "empty" && briefState === "asked") ? (
          <HelpOutlineRoundedIcon aria-hidden sx={{ fontSize: 20, color: k.warning, mt: "1px", flexShrink: 0 }} />
        ) : stage === "blocked" ? (
          <ErrorOutlineRoundedIcon aria-hidden sx={{ fontSize: 20, color: k.error, mt: "1px", flexShrink: 0 }} />
        ) : stage === "locked" ? (
          <LockOutlinedIcon aria-hidden sx={{ fontSize: 18, color: k.ink3, mt: "2px", flexShrink: 0 }} />
        ) : null}
        <Typography ref={headRef} tabIndex={-1} data-testid="autopilot-headline" data-gaps={gaps || undefined} sx={{ minWidth: 0, fontSize: "0.92rem", fontWeight: 600, lineHeight: 1.35, color: tone, letterSpacing: "-0.01em", outline: "none" }}>
          {/* The sentence is announced once; the seconds tick beside it, out of the live region. */}
          <Box component="span" role="status">{headline}</Box>
          {stage === "working" && busy === "validating" && <Box component="span" aria-hidden>{` ${t("autopilot.seconds", { seconds })}`}</Box>}
        </Typography>
      </Box>
      {/* How long it has run and how long it usually takes (owner's UX lot 1: a wait is never a bare spinner), with the
          way to stop the assistant's reading — what it built so far stays. The seconds tick out of the live region. */}
      {stage === "working" && (
        <Box data-testid="autopilot-eta" data-busy={busy || "simulating"} sx={{ display: "flex", alignItems: "center", flexWrap: "wrap", gap: 1, pl: 3.25 }}>
          <Typography aria-hidden sx={{ fontSize: "0.74rem", color: k.ink2, lineHeight: 1.45 }}>
            {busy !== "validating" && seconds > 0 ? `${t("autopilot.seconds", { seconds })} · ` : ""}
            {t(`autopilot.eta.${busy || "simulating"}`)}
          </Typography>
          {(busy === "planning" || busy === "reading") && onStop && (
            <Button size="small" startIcon={<StopRoundedIcon sx={{ fontSize: "16px !important" }} />} onClick={onStop} data-testid="autopilot-stop" sx={{ ...smallButton, pl: 0.5 }}>
              {t("autopilot.stop")}
            </Button>
          )}
        </Box>
      )}
      {/* What the assistant reads and writes, as it happens (the wait screen, UX lot 3): the last lines of its turn —
          the grid read by its cells, the line looked up, the plan written — never its words. */}
      {stage === "working" && busy === "planning" && feed.length > 0 && (
        <Box component="ol" data-testid="autopilot-feed" aria-label={t("autopilot.feed.title")} sx={{ listStyle: "none", m: 0, pl: 3.25, display: "flex", flexDirection: "column", gap: 0.15 }}>
          {feed.slice(-5).map((f, i, all) => (
            <Typography component="li" key={`${f.at || i}-${i}`} data-testid="autopilot-feed-line" data-tool={f.name} sx={{ fontSize: "0.72rem", color: i === all.length - 1 ? k.ink : k.ink3, lineHeight: 1.45, overflowWrap: "anywhere", transition: "color 300ms" }}>
              {t(`autopilot.feed.${["read_grid", "route_timetable", "reference_timetable", "lookup", "query", "set_plan", "patch_plan", "ask_user", "propose_clause_corrections", "set_requirements", "record_objectives"].includes(f.name) ? f.name : "other"}`, { name: f.name, document: f.document || "", sheet: f.sheet || "", cells: f.cells || "", route: f.route || "", day: f.day || "", query: f.query || "", operations: f.operations ?? 0, questions: f.questions ?? 0, corrections: f.corrections ?? 0, clauses: f.clauses ?? 0 })}
              {f.error ? t("autopilot.feed.error") : ""}
            </Typography>
          ))}
        </Box>
      )}
      {stage === "empty" && briefState !== "asked" && <Typography sx={{ fontSize: "0.76rem", color: k.ink2, lineHeight: 1.5 }}>{t(briefState === "locked" ? "autopilot.stage.empty.hint.prose" : sources.assistant ? "autopilot.stage.empty.hint.assistant" : "autopilot.stage.empty.hint.manual")}</Typography>}
      {stage === "ready" && <Typography sx={{ fontSize: "0.76rem", color: k.ink2, lineHeight: 1.5 }}>{t("autopilot.ready.hint")}</Typography>}
      {/* Ready: what the change does, in figures the operator reads (trips, hours, kilometres before → after). */}
      {stage === "ready" && impact && <ImpactStrip impact={impact} testid="autopilot-impact" />}
      {stage === "nochange" && <Typography sx={{ fontSize: "0.76rem", color: k.ink2, lineHeight: 1.5 }}>{t("autopilot.nochange.hint")}</Typography>}
      {stage === "locked" ? (
        onObjectives && (
          <Button size="small" variant="contained" disableElevation onClick={onObjectives} data-testid="autopilot-objectives" sx={{ alignSelf: "flex-start", fontWeight: 600 }}>
            {t("autopilot.objectives")}
          </Button>
        )
      ) : (
        <Box component="ul" sx={{ listStyle: "none", m: 0, p: 0, display: "flex", flexDirection: "column", gap: 0.5 }}>
          {sources.grids > 0 && (
            <Line id="grids" state="done" k={k}>
              {t("autopilot.line.grids", { count: sources.grids })}
            </Line>
          )}
          {skipped.length > 0 && (
            <Line id="skipped" state="problem" k={k} t={t} items={skippedItems} more={skipped.length - skippedItems.length}>
              {t("autopilot.line.skipped", { count: skipped.length, reasons: skippedReasons })}
            </Line>
          )}
          {covered.length > 0 && (
            <Line id="covered" state={covered.every((c) => c.whole) ? "done" : "waiting"} k={k} t={t} items={covered.slice(0, LINE_ITEMS).map((c) => c.text)} more={covered.length - Math.min(covered.length, LINE_ITEMS)}>
              {t("autopilot.line.covered", { count: covered.length })}
            </Line>
          )}
          {sources.suggestions > 0 && (
            <Line id="suggestions" state="done" k={k}>
              {t("autopilot.line.suggestions", { count: sources.suggestions })}
            </Line>
          )}
          {briefState && (
            <Line
              id="brief"
              state={briefState === "read" ? "done" : briefState === "reading" ? "running" : briefState === "locked" || briefState === "failed" ? "problem" : "waiting"}
              items={briefState === "kept" ? [t("autopilot.line.brief.kept.hint")] : null}
              t={t}
              k={k}
              action={
                (briefState === "failed" || briefState === "unread") && onRetryBrief ? (
                  <Button size="small" onClick={onRetryBrief} disabled={disabled} data-testid="autopilot-brief-retry" sx={smallButton}>
                    {t(briefState === "failed" ? "autopilot.line.brief.retry" : "autopilot.line.brief.read.now")}
                  </Button>
                ) : null
              }
            >
              {t(`autopilot.line.brief.${briefState}`)}
            </Line>
          )}
          {sources.dates && (
            <Line id="dates" state="done" k={k}>
              {t("autopilot.line.dates", { dates: sources.dates })}
            </Line>
          )}
          {(view.operations > 0 || stage === "working") && (
            <Line id="operations" state={view.operations > 0 ? (busy === "simulating" || busy === "planning" ? "running" : "done") : "waiting"} k={k}>
              {view.operations > 0 ? t("autopilot.line.operations", { count: view.operations }) : t("autopilot.line.operations.none")}
            </Line>
          )}
          {view.simulationFailed && (
            <Line
              id="simulation"
              state="problem"
              k={k}
              action={
                onResimulate ? (
                  <Button size="small" onClick={onResimulate} disabled={disabled} data-testid="autopilot-resimulate" sx={smallButton}>
                    {t("transform.previewAgain")}
                  </Button>
                ) : null
              }
            >
              {t("autopilot.line.simulation.failed")}
            </Line>
          )}
          {view.failed > 0 && (
            <Line id="failed" state="problem" k={k}>
              {t("autopilot.line.failed", { count: view.failed })}
            </Line>
          )}
          {/* The operations whose questions come once an earlier operation of their line is answered: said, never asked early. */}
          {view.waiting > 0 && settled && (
            <Line id="waiting" state="waiting" k={k}>
              {t("autopilot.line.waiting", { count: view.waiting })}
            </Line>
          )}
          {view.unanswerable > 0 && settled && (
            <Line id="stuck" state="problem" k={k}>
              {t("autopilot.line.stuck", { count: view.unanswerable })}
            </Line>
          )}
          {view.operations > 0 && settled && o && o.total > 0 && (
            <Line id="objectives" state={o.fail ? "problem" : o.pass === o.total ? "done" : "waiting"} k={k}>
              {t("autopilot.line.objectives", { pass: o.pass, total: o.total })}
              {o.fail > 0 ? ` · ${t("autopilot.line.objectives.fail", { count: o.fail })}` : ""}
              {o.unknown > 0 ? ` · ${t("autopilot.line.objectives.unknown", { count: o.unknown })}` : ""}
            </Line>
          )}
          {/* The desired clauses, apart: met or not, nothing the delivery asks to accept. */}
          {view.operations > 0 && settled && d && d.total > 0 && (
            <Line id="desired" state={d.pass === d.total ? "done" : "waiting"} k={k}>
              {t("autopilot.line.desired", { pass: d.pass, total: d.total })}
              {d.fail > 0 ? ` · ${t("autopilot.line.desired.fail", { count: d.fail })}` : ""}
              {d.unknown > 0 ? ` · ${t("autopilot.line.objectives.unknown", { count: d.unknown })}` : ""}
            </Line>
          )}
          {/* The two default guarantees, apart from the person's objectives (② never counted them as such): held, only
              the ones measured are named (one made desired or set aside at ② is not). */}
          {view.operations > 0 && settled && g && g.total > 0 && (
            <Line id="guarantees" state={g.fail ? "problem" : g.pass === g.total ? "done" : "waiting"} k={k}>
              {t(guaranteesLine.key, guaranteesLine.params)}
            </Line>
          )}
          {view.operations > 0 && (settled || busy === "validating") && stage !== "nochange" && (
            <Line
              id="validator"
              state={baseline ? "waiting" : validatorState}
              k={k}
              action={
                view.validator === "failed" && onRevalidate ? (
                  <Button size="small" onClick={onRevalidate} disabled={disabled} data-testid="autopilot-revalidate" sx={smallButton}>
                    {t("autopilot.line.validator.again")}
                  </Button>
                ) : view.validator === "new_errors" && onErrors ? (
                  <Button size="small" onClick={onErrors} data-testid="autopilot-errors" sx={smallButton}>
                    {t("autopilot.line.validator.see")}
                  </Button>
                ) : null
              }
            >
              {baseline ? t("autopilot.line.validator.passedBaseline", { count: baseline }) : t(`autopilot.line.validator.${view.validator}`, { count: view.newErrors, seconds })}
              {rules.map((r) => (
                <Box component="span" key={r.code} data-testid="autopilot-validator-rule" sx={{ display: "block", fontSize: "0.74rem", color: k.ink2 }}>
                  {t("gtfsCheck.rule", { code: r.code, before: r.before ?? 0, after: r.after ?? 0 })}
                </Box>
              ))}
            </Line>
          )}
          {settled && remarks.length > 0 && (
            <Line id="remarks" state="waiting" k={k} t={t} items={remarks.slice(0, LINE_ITEMS)} more={remarks.length - Math.min(remarks.length, LINE_ITEMS)}>
              {t("autopilot.line.remarks", { count: remarks.length })}
            </Line>
          )}
          {stage === "ready" && view.toAccept > 0 && (
            <Line id="accept" state="waiting" k={k}>
              {t("autopilot.line.toAccept", { count: view.toAccept })}
            </Line>
          )}
          {settled && view.uncovered > 0 && (
            <Line id="uncovered" state="problem" k={k}>
              {t("autopilot.line.uncovered", { count: view.uncovered })}
            </Line>
          )}
        </Box>
      )}
      {/* What holds the plan is answered at ②: the way back, where the panel says it. */}
      {stage === "blocked" && (view.uncovered > 0 || view.contractRequired) && onObjectives && (
        <Button size="small" variant="outlined" onClick={onObjectives} data-testid="autopilot-objectives" sx={{ alignSelf: "flex-start", fontWeight: 600 }}>
          {t("autopilot.objectives")}
        </Button>
      )}
      {/* The prose brief only the assistant reads: what would lift the lock, said where the brief is counted. */}
      {briefState === "locked" && lock && <LockedAction lock={lock} testid="autopilot-lock">{t("autopilot.lock.action")}</LockedAction>}
      {/* The journey's own question: a title of the sheet that names no day type — which days do its grids run? */}
      {stage !== "locked" && onDayTitle && dayTitles.map((q) => (
        <Box key={q.title} data-testid="autopilot-daytitle" data-title={q.title} sx={{ p: 1, borderRadius: "8px", backgroundColor: k.warningSoft }}>
          <Typography sx={{ fontSize: "0.78rem", fontWeight: 600, lineHeight: 1.4, color: k.ink }}>
            {t("autopilot.daytitle.question", { count: q.count, title: q.title })}
          </Typography>
          {q.labels.length > 0 && <Typography sx={{ fontSize: "0.72rem", color: k.ink2, lineHeight: 1.4, overflowWrap: "anywhere" }}>{q.labels.slice(0, 12).join(" · ")}</Typography>}
          <Box sx={{ display: "flex", flexWrap: "wrap", gap: 0.5, mt: 0.5 }}>
            {DAY_TITLE_ANSWERS.map((a) => (
              <Chip key={a} size="small" disabled={disabled} variant={a === "none" ? "outlined" : "filled"} label={t(`autopilot.daytitle.${a}`)} onClick={() => onDayTitle(q.title, a)} data-testid="autopilot-daytitle-option" data-value={a} sx={chipSx} />
            ))}
          </Box>
        </Box>
      ))}
      {/* What only the person can say: every question once, answered here (the operations' cards show them too). */}
      {stage === "questions" && onAnswer && questions.length > 0 && (
        <Box data-testid="autopilot-questions" sx={{ display: "flex", flexDirection: "column" }}>
          {questions.map((q) => (
            <QuestionBox key={q.key} ambiguity={q.ambiguity} op={q.op} def={defOf(q.op.type)} together={q.together} context={q.op.label || opTitle(t, q.op.type, defOf(q.op.type))} onAnswer={onAnswer} testid="autopilot-question" answerTestid="autopilot-answer" />
          ))}
        </Box>
      )}
      {decisions.length > 0 && stage !== "locked" && (
        <Box data-testid="autopilot-decisions" data-count={decisions.length} sx={{ borderTop: `1px solid ${k.lineSoft}`, pt: 0.75 }}>
          <Button size="small" onClick={() => setDecisionsOpen((v) => !v)} aria-expanded={decisionsOpen} data-testid="autopilot-decisions-toggle" sx={{ ml: -0.75, px: 0.75, minWidth: 0, fontSize: "0.76rem", fontWeight: 600, color: k.ink }}>
            {t(decisionsOpen ? "autopilot.decisions.hide" : "autopilot.decisions.show", { count: decisions.length })}
          </Button>
          {decisionsOpen && (
            <>
              <Typography sx={{ fontSize: "0.72rem", color: k.ink2, lineHeight: 1.45, mb: 0.5 }}>{t("autopilot.decisions.hint")}</Typography>
              <Box component="ul" sx={{ listStyle: "none", m: 0, p: 0, display: "flex", flexDirection: "column", gap: 0.75 }}>
                {decisions.map((item) => (
                  <Decision key={item.key} item={item} def={defOf(item.type)} disabled={disabled} onDecision={onDecision} k={k} />
                ))}
              </Box>
            </>
          )}
        </Box>
      )}
      {/* The way on, as a text link: the step's one primary action (StepFrame) is this very act. */}
      {stage === "ready" && onDelivery && (
        <Button size="small" variant="text" endIcon={<ArrowForwardRoundedIcon sx={{ fontSize: "16px !important" }} />} onClick={onDelivery} data-testid="autopilot-delivery" sx={{ alignSelf: "flex-start", ml: -0.75, fontWeight: 600 }}>
          {t("autopilot.delivery")}
        </Button>
      )}
    </Box>
  );
}
