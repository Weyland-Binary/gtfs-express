/**
 * DirectReport — the direct mode's report, the left pane of its decision. The verdict first: how many of the brief's
 * demands are done, what is not done, to check or changed without being asked, and the engine's facts (the lines,
 * trips and other tables changed, the canonical validator) — what holds the application (a new validator error, a
 * broken integrity) stated above it all. Then the demands as a checklist, each with the independent reviewer's status
 * and its evidence folded under it (open where the demand is not done or not proven), a demand placed in the network
 * (`where`) linking to that line in the reader beside it; then what was changed without being asked. A demand done
 * reads quiet: the person looks where it matters. Every value is the server's (the report and the facts of POST
 * /transform/direct); nothing is measured here.
 *
 *   direct-report              the pane (`data-complete`: the review ended on its report)
 *   direct-verdict             the verdict on the demands (`data-tone`: success | warning), direct-report-count its words,
 *                              direct-count each point it counts (it leads to the first of them)
 *   direct-report-incomplete   the review did not end on a report
 *   direct-demand              one per demand (`data-status`: done | not_done | unproven, `data-quiet`, `data-open`)
 *   direct-demand-toggle       its row, which folds its evidence
 *   direct-demand-evidence     its evidence
 *   direct-demand-where        the link to its line (or its date and stop said, without a line)
 *   direct-not-asked           « Changé sans être demandé », one direct-not-asked-item each
 *   direct-figures             the facts: direct-figure-lines, direct-figure-trips, direct-figure-tables
 *   direct-validator           the validator (`data-status`: passed | new_errors | not_run | unavailable | error),
 *                              its new errors (direct-validator-error), a broken integrity (direct-integrity)
 */

import React, { useState } from "react";
import { Box, ButtonBase, Typography, alpha, useTheme } from "@mui/material";
import CheckCircleRoundedIcon from "@mui/icons-material/CheckCircleRounded";
import CancelRoundedIcon from "@mui/icons-material/CancelRounded";
import ErrorRoundedIcon from "@mui/icons-material/ErrorRounded";
import HelpRoundedIcon from "@mui/icons-material/HelpRounded";
import ArrowForwardRoundedIcon from "@mui/icons-material/ArrowForwardRounded";
import ExpandMoreRoundedIcon from "@mui/icons-material/ExpandMoreRounded";
import { useLanguage } from "../../contexts/LanguageContext";
import { formatNumber, formatYmd } from "../../utils/formatDate";
import { countWords } from "../../utils/countWords";
import { textToneOf } from "./draftKinds";

// The tables the figures name on their own: the other ones are « autres tables ».
const OWN_TABLES = new Set(["routes", "trips", "stop_times"]);

const statusOf = (d) => (d?.status === "done" ? "done" : d?.status === "not_done" ? "not_done" : "unproven");

/** The demands, the changes not asked and what the person accepts by applying: what is not done, not proven, not asked. */
export const reportCounts = (report) => {
  const demands = Array.isArray(report?.demands) ? report.demands : [];
  const n = (s) => demands.filter((d) => statusOf(d) === s).length;
  const notAsked = Array.isArray(report?.not_asked) ? report.not_asked.length : 0;
  return { total: demands.length, done: n("done"), notDone: n("not_done"), unproven: n("unproven"), notAsked, incomplete: Boolean(report) && report.complete === false };
};

/** What the application accepts under a name: every demand not done or not proven, every change not asked, a review cut short. */
export const toAcceptOf = (report) => {
  const c = reportCounts(report);
  return c.notDone + c.unproven + c.notAsked + (c.incomplete ? 1 : 0);
};

/** The line a diff line of the engine names (« Line 5 · weekday … »), or null: the figure's fallback before the diff is read. */
const lineOfText = (s) => {
  const m = /^Line (.+?)(?: ·|:| added$| removed$| now serves| no longer serves)/.exec(String(s || ""));
  return m ? m[1] : null;
};

/** The three figures from the facts: the lines changed (from the structured diff when read), the trips, the other tables. */
export const figuresOf = (facts, diffItems = null) => {
  const tables = Array.isArray(facts?.tables) ? facts.tables : [];
  const lines = Array.isArray(diffItems) ? new Set(diffItems.filter((it) => it?.route || it?.label).map((it) => String(it.route || it.label))) : new Set((facts?.diff || []).map(lineOfText).filter(Boolean));
  const trips = tables.find((x) => x.table === "trips") || { added: 0, removed: 0, changed: 0 };
  const others = tables.filter((x) => !OWN_TABLES.has(x.table) && (x.added || x.removed || x.changed));
  return { lines: lines.size, trips: { total: (trips.added || 0) + (trips.removed || 0) + (trips.changed || 0), added: trips.added || 0, removed: trips.removed || 0, changed: trips.changed || 0 }, tables: others.map((x) => x.table) };
};

/** Whether the facts block the application: a new error of the canonical validator, or a broken integrity. */
export const blockingOf = (facts) => ({ validator: (facts?.validator?.new_errors || []).length, integrity: (facts?.integrity || []).length });

const STATUS_ICON = { done: CheckCircleRoundedIcon, not_done: CancelRoundedIcon, unproven: HelpRoundedIcon };

function Demand({ demand, onLocate, id }) {
  const theme = useTheme();
  const { t, language } = useLanguage();
  const status = statusOf(demand);
  const quiet = status === "done";
  const [open, setOpen] = useState(!quiet);
  const palette = status === "not_done" ? theme.palette.error : status === "unproven" ? theme.palette.warning : theme.palette.success;
  const tone = textToneOf(theme, palette);
  const Icon = STATUS_ICON[status];
  const where = demand?.where && typeof demand.where === "object" ? demand.where : null;
  const whereText = where ? [where.line ? t("direct.report.whereLine", { line: where.line }) : null, where.date ? formatYmd(String(where.date).replace(/-/g, ""), language) || where.date : null, where.stop ? t("direct.report.whereStop", { stop: where.stop }) : null].filter(Boolean).join(" · ") : "";
  const folds = Boolean(demand.evidence || whereText);
  return (
    <Box component="li" id={id} data-testid="direct-demand" data-status={status} data-quiet={quiet ? "true" : "false"} data-open={open ? "true" : "false"} sx={{ borderTop: `1px solid ${theme.palette.divider}`, "&:first-of-type": { borderTop: "none" } }}>
      <ButtonBase
        onClick={() => folds && setOpen((v) => !v)}
        disabled={!folds}
        aria-expanded={folds ? (open ? "true" : "false") : undefined}
        data-testid="direct-demand-toggle"
        sx={{ width: "100%", display: "flex", alignItems: "flex-start", gap: 1.25, px: 1, py: 1.25, borderRadius: "8px", textAlign: "left", "&:hover": { backgroundColor: alpha(theme.palette.text.primary, 0.03) }, "&.Mui-focusVisible": { outline: `2px solid ${theme.palette.primary.main}`, outlineOffset: -2 } }}
      >
        <Icon aria-hidden sx={{ fontSize: 20, mt: "1px", flexShrink: 0, color: quiet ? alpha(palette.main, 0.8) : palette.main }} />
        <Typography component="span" sx={{ flex: 1, minWidth: 0, fontSize: "0.88rem", lineHeight: 1.5, fontWeight: quiet ? 450 : 600, color: quiet ? "text.secondary" : "text.primary" }}>
          {demand.quote}
        </Typography>
        {/* A demand done says so to a screen reader; on screen its mark is enough. */}
        <Typography component="span" className={quiet ? "visually-hidden" : undefined} sx={{ flexShrink: 0, fontSize: "0.76rem", fontWeight: 700, color: tone, mt: "2px" }}>
          {t(`direct.report.status.${status}`)}
        </Typography>
        {folds && <ExpandMoreRoundedIcon aria-hidden sx={{ fontSize: 18, mt: "1px", flexShrink: 0, color: "text.secondary", transform: open ? "rotate(180deg)" : "none", transition: "transform 160ms", "@media (prefers-reduced-motion: reduce)": { transition: "none" } }} />}
      </ButtonBase>
      {open && folds && (
        <Box sx={{ pl: 5, pr: 1, pb: 1.5, mt: -0.5, display: "flex", flexDirection: "column", alignItems: "flex-start", gap: 0.5 }}>
          {demand.evidence && (
            <Typography data-testid="direct-demand-evidence" sx={{ fontSize: "0.82rem", lineHeight: 1.5, color: quiet ? "text.secondary" : tone }}>
              {demand.evidence}
            </Typography>
          )}
          {whereText ? (
            where.line && onLocate ? (
              <ButtonBase onClick={() => onLocate(where)} data-testid="direct-demand-where" sx={{ gap: 0.5, ml: -0.75, px: 0.75, py: 0.25, borderRadius: "6px", fontSize: "0.78rem", fontWeight: 650, color: textToneOf(theme, theme.palette.primary), "&:hover": { backgroundColor: alpha(theme.palette.primary.main, 0.08) } }}>
                {whereText}
                <ArrowForwardRoundedIcon aria-hidden sx={{ fontSize: 15 }} />
              </ButtonBase>
            ) : (
              <Typography data-testid="direct-demand-where" sx={{ fontSize: "0.78rem", color: "text.secondary" }}>
                {whereText}
              </Typography>
            )
          ) : null}
        </Box>
      )}
    </Box>
  );
}

/** A counted point of the verdict, in its tone: it leads to the first of what it counts (`target`, an element's id). */
function Count({ palette, target, children }) {
  const theme = useTheme();
  const go = () => {
    const el = document.getElementById(target);
    if (!el) return;
    const still = window.matchMedia?.("(prefers-reduced-motion: reduce)").matches;
    el.scrollIntoView?.({ block: "center", behavior: still ? "auto" : "smooth" });
    (el.querySelector("button") || el).focus?.({ preventScroll: true });
  };
  return (
    <ButtonBase onClick={go} data-testid="direct-count" sx={{ display: "inline-flex", alignItems: "center", gap: 0.6, px: 1, py: 0.3, borderRadius: 99, fontSize: "0.78rem", fontWeight: 700, color: textToneOf(theme, palette), backgroundColor: alpha(palette.main, theme.palette.mode === "dark" ? 0.2 : 0.1), "&:hover": { backgroundColor: alpha(palette.main, theme.palette.mode === "dark" ? 0.3 : 0.18) }, "&.Mui-focusVisible": { outline: `2px solid ${palette.main}`, outlineOffset: 2 } }}>
      <Box component="span" aria-hidden sx={{ width: 7, height: 7, borderRadius: "50%", backgroundColor: palette.main }} />
      {children}
    </ButtonBase>
  );
}

const Heading = ({ children, id = null }) => (
  <Typography id={id} component="h3" sx={{ fontSize: "0.8rem", fontWeight: 700, color: "text.secondary", m: 0 }}>
    {children}
  </Typography>
);

export default function DirectReport({ report = null, facts = null, diffItems = null, onLocate = null, applied = false }) {
  const theme = useTheme();
  const { t, language } = useLanguage();
  const demands = Array.isArray(report?.demands) ? report.demands : [];
  const notAsked = Array.isArray(report?.not_asked) ? report.not_asked : [];
  const counts = reportCounts(report);
  const figures = figuresOf(facts, diffItems);
  const v = facts?.validator || { status: "not_run", new_errors: [] };
  const integrity = Array.isArray(facts?.integrity) ? facts.integrity : [];
  const errorTone = textToneOf(theme, theme.palette.error);
  const n = (x) => formatNumber(x, language);
  const validatorBad = v.status === "new_errors";
  const validatorOk = v.status === "passed";
  const blocks = validatorBad || integrity.length > 0;
  const validatorLine = v.status === "passed" ? t("direct.validator.passed") : validatorBad ? countWords(t, "direct.validator.newErrors", v.new_errors.length) : v.status === "unavailable" ? t("direct.validator.unavailable") : v.status === "error" ? t("direct.validator.error") : t("direct.validator.notRun");
  const toAccept = counts.notDone + counts.unproven + counts.notAsked;
  // The verdict is the demands': what holds the application is said apart, above it.
  const tone = toAccept || counts.incomplete ? "warning" : "success";
  const VerdictIcon = tone === "success" ? CheckCircleRoundedIcon : ErrorRoundedIcon;
  const verdictText = !counts.total ? t("direct.verdict.none") : counts.done === counts.total ? countWords(t, "direct.verdict.all", counts.total) : countWords(t, "direct.verdict.some", counts.done, { total: counts.total });
  const sep = <Box component="span" aria-hidden sx={{ color: "text.disabled" }}>·</Box>;
  return (
    <Box component="section" aria-labelledby="direct-report-title" data-testid="direct-report" data-complete={report?.complete === false ? "false" : "true"} sx={{ display: "flex", flexDirection: "column", gap: 2.5 }}>
      {/* What holds the application is read before anything else. */}
      {blocks && (
        <Box data-testid="direct-validator" data-status={v.status} role="alert" sx={{ display: "flex", flexDirection: "column", gap: 0.75, p: 1.75, borderRadius: "12px", border: `1px solid ${alpha(theme.palette.error.main, 0.45)}`, backgroundColor: alpha(theme.palette.error.main, theme.palette.mode === "dark" ? 0.14 : 0.06) }}>
          <Typography sx={{ fontSize: "0.92rem", fontWeight: 750, color: errorTone }}>{t("direct.block.title")}</Typography>
          {validatorBad && (
            <>
              <Typography sx={{ fontSize: "0.84rem", lineHeight: 1.5 }}>{countWords(t, "direct.block.validator", v.new_errors.length)}</Typography>
              <Box component="ul" sx={{ m: 0, pl: 2.5, display: "flex", flexDirection: "column", gap: 0.25 }}>
                {v.new_errors.map((e) => (
                  <Box component="li" key={e.code} data-testid="direct-validator-error" sx={{ fontSize: "0.8rem", color: "text.secondary" }}>
                    <Box component="code" lang="en" sx={{ fontFamily: "monospace", fontSize: "0.78rem", color: "text.primary" }}>{e.code}</Box>
                    {` ${t("direct.validator.errorCount", { before: n(e.before ?? 0), after: n(e.after ?? 0) })}`}
                  </Box>
                ))}
              </Box>
            </>
          )}
          {integrity.length > 0 && (
            <Typography data-testid="direct-integrity" sx={{ fontSize: "0.84rem", lineHeight: 1.5 }}>
              {t("direct.integrity", { problems: integrity.map((i) => `${i.code} ×${i.count}`).join(", ") })}
            </Typography>
          )}
        </Box>
      )}
      <Box component="header" data-testid="direct-verdict" data-tone={tone} sx={{ display: "flex", flexDirection: "column", gap: 1.25 }}>
        <Box sx={{ display: "flex", alignItems: "flex-start", gap: 1.25 }}>
          <VerdictIcon aria-hidden sx={{ fontSize: 30, flexShrink: 0, color: theme.palette[tone].main }} />
          <Typography id="direct-report-title" component="h2" data-testid="direct-report-count" sx={{ fontSize: "1.3rem", fontWeight: 750, letterSpacing: "-0.015em", lineHeight: 1.25, m: 0, pt: "2px" }}>
            {verdictText}
          </Typography>
        </Box>
        {(counts.notDone > 0 || counts.unproven > 0 || counts.notAsked > 0) && (
          <Box sx={{ display: "flex", flexWrap: "wrap", gap: 0.75, pl: "42px" }}>
            {counts.notDone > 0 && <Count palette={theme.palette.error} target={`direct-demand-${demands.findIndex((d) => statusOf(d) === "not_done")}`}>{countWords(t, "direct.count.notDone", counts.notDone)}</Count>}
            {counts.unproven > 0 && <Count palette={theme.palette.warning} target={`direct-demand-${demands.findIndex((d) => statusOf(d) === "unproven")}`}>{countWords(t, "direct.count.unproven", counts.unproven)}</Count>}
            {counts.notAsked > 0 && <Count palette={theme.palette.warning} target="direct-not-asked">{countWords(t, "direct.count.notAsked", counts.notAsked)}</Count>}
          </Box>
        )}
        {/* The engine's facts, in one line: what changes, and the validator. */}
        <Box sx={{ pl: "42px", display: "flex", flexDirection: "column", gap: 0.5 }}>
          <Box data-testid="direct-figures" sx={{ display: "flex", flexWrap: "wrap", alignItems: "center", columnGap: 0.75, rowGap: 0.25, fontSize: "0.84rem", color: "text.secondary" }}>
            <Box component="span" data-testid="direct-figure-lines">{countWords(t, "direct.figures.lines", figures.lines, { count: n(figures.lines) })}</Box>
            {sep}
            <Box component="span" data-testid="direct-figure-trips" title={figures.trips.total ? t("direct.figures.tripsHint", { added: n(figures.trips.added), removed: n(figures.trips.removed), changed: n(figures.trips.changed) }) : undefined}>
              {countWords(t, "direct.figures.trips", figures.trips.total, { count: n(figures.trips.total) })}
            </Box>
            {figures.tables.length > 0 && (
              <>
                {sep}
                <Box component="span" data-testid="direct-figure-tables" title={figures.tables.join(", ")}>
                  {countWords(t, "direct.figures.tables", figures.tables.length)}
                </Box>
              </>
            )}
          </Box>
          {!blocks && (
            <Box data-testid="direct-validator" data-status={v.status} sx={{ display: "flex", alignItems: "center", gap: 0.6 }}>
              {validatorOk ? <CheckCircleRoundedIcon aria-hidden sx={{ fontSize: 16, color: theme.palette.success.main }} /> : <HelpRoundedIcon aria-hidden sx={{ fontSize: 16, color: theme.palette.text.disabled }} />}
              <Typography sx={{ fontSize: "0.84rem", color: validatorOk ? "text.primary" : "text.secondary" }}>{validatorLine}</Typography>
            </Box>
          )}
        </Box>
      </Box>
      {counts.incomplete && (
        <Box data-testid="direct-report-incomplete" sx={{ display: "flex", gap: 1, p: 1.5, borderRadius: "12px", border: `1px solid ${alpha(theme.palette.warning.main, 0.45)}`, backgroundColor: alpha(theme.palette.warning.main, theme.palette.mode === "dark" ? 0.12 : 0.06) }}>
          <HelpRoundedIcon aria-hidden sx={{ fontSize: 18, color: theme.palette.warning.main, mt: "1px" }} />
          <Typography sx={{ fontSize: "0.84rem", lineHeight: 1.5, color: textToneOf(theme, theme.palette.warning) }}>{t("direct.report.incomplete")}</Typography>
        </Box>
      )}
      {demands.length > 0 && (
        <Box component="section" aria-labelledby="direct-demands-title" sx={{ display: "flex", flexDirection: "column", gap: 0.5 }}>
          <Heading id="direct-demands-title">{t(applied ? "direct.report.demandsApplied" : "direct.report.demands")}</Heading>
          <Box component="ol" sx={{ listStyle: "none", m: 0, p: 0 }}>
            {demands.map((d, i) => (
              <Demand key={`${i}-${d.quote}`} id={`direct-demand-${i}`} demand={d} onLocate={onLocate} />
            ))}
          </Box>
        </Box>
      )}
      {notAsked.length > 0 && (
        <Box component="section" id="direct-not-asked" tabIndex={-1} aria-labelledby="direct-not-asked-title" data-testid="direct-not-asked" sx={{ display: "flex", flexDirection: "column", gap: 1, p: 1.75, borderRadius: "12px", border: `1px solid ${alpha(theme.palette.warning.main, 0.45)}`, backgroundColor: alpha(theme.palette.warning.main, theme.palette.mode === "dark" ? 0.12 : 0.06) }}>
          <Typography id="direct-not-asked-title" component="h3" sx={{ fontSize: "0.88rem", fontWeight: 750, color: textToneOf(theme, theme.palette.warning), m: 0 }}>
            {t("direct.report.notAsked", { count: notAsked.length })}
          </Typography>
          <Box component="ul" sx={{ m: 0, pl: 2.5, display: "flex", flexDirection: "column", gap: 0.5 }}>
            {notAsked.map((x, i) => (
              <Box component="li" key={`${i}-${x.what}`} data-testid="direct-not-asked-item" sx={{ fontSize: "0.86rem", lineHeight: 1.5 }}>
                <Box component="span" sx={{ fontWeight: 650 }}>{x.what}</Box>
                {x.why ? <Box component="span" sx={{ color: "text.secondary" }}>{` — ${x.why}`}</Box> : null}
              </Box>
            ))}
          </Box>
        </Box>
      )}
    </Box>
  );
}
