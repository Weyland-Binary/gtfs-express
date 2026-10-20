/**
 * ChangePlanParts — the pieces of the Change Studio's review side:
 *
 *   OperationCard     one step of the plan: what it does (the engine's
 *                     summary, as simulated on a copy of the feed), where
 *                     the brief asks it (the quote, with whether the engine
 *                     found it in the brief), its parameters in the
 *                     reader's words, and — when the engine blocked it —
 *                     the questions, answered with one click on an option
 *   ChangesPanel      the semantic diff, phrased in the reader's language,
 *                     grouped by line, with when each change applies
 *   ChecksPanel       the engine's verdict pinned first (common/VerdictCard,
 *                     from the preview's `verdict`, `gate` and `validation`;
 *                     "not measured yet" before any simulation), what stands
 *                     between the plan and "Apply" (the gate), the brief's
 *                     clauses before → after, integrity, and the canonical
 *                     validator — run by itself on a stable simulation (the
 *                     studio), re-run with "Validate again"; its new errors
 *                     block and are never accepted, they are fixed in the change
 */

import React, { useEffect, useState } from "react";
import { Alert, Box, Button, Chip, IconButton, Menu, MenuItem, TextField, Tooltip, Typography, alpha, useTheme } from "@mui/material";
import MoreVertIcon from "@mui/icons-material/MoreVert";
import DeleteOutlineIcon from "@mui/icons-material/DeleteOutline";
import ArrowUpwardIcon from "@mui/icons-material/ArrowUpward";
import ArrowDownwardIcon from "@mui/icons-material/ArrowDownward";
import FormatQuoteIcon from "@mui/icons-material/FormatQuote";
import CheckCircleOutlineIcon from "@mui/icons-material/CheckCircleOutline";
import HelpOutlineIcon from "@mui/icons-material/HelpOutline";
import ErrorOutlineIcon from "@mui/icons-material/ErrorOutline";
import RemoveCircleOutlineIcon from "@mui/icons-material/RemoveCircleOutline";
import WarningAmberIcon from "@mui/icons-material/WarningAmber";
import AutoAwesomeOutlinedIcon from "@mui/icons-material/AutoAwesomeOutlined";
import PlaceOutlinedIcon from "@mui/icons-material/PlaceOutlined";
import { useLanguage } from "../../contexts/LanguageContext";
import { Tag, soft } from "../network/StudioUI";
import { fetchAlerts, downloadPreviewExport, fetchDemand } from "../../utils/transformApi";
import { downloadSynthesis } from "./synthesis";
import { formatParamValue, opTitle, optionLabel, paramLabel, questionText, tf } from "./catalogueText";
import { blockedSteps, gateOf } from "./gate";
import { formatDate } from "./localDates";
import { formatYmd } from "../../utils/formatDate";
import { countWords } from "../../utils/countWords";
import VerdictCard from "../common/VerdictCard";
import useElapsed from "../common/useElapsed";
import { engineNote } from "../../utils/engineNotes";


export const STATUS = {
  applied: { color: "success", Icon: CheckCircleOutlineIcon },
  skipped: { color: "default", Icon: RemoveCircleOutlineIcon },
  blocked: { color: "warning", Icon: HelpOutlineIcon },
  failed: { color: "error", Icon: ErrorOutlineIcon },
  pending: { color: "default", Icon: HelpOutlineIcon },
};

/**
 * Where the step's quote stands: proposed by the optimizer, found in the
 * brief, only in a PDF the server cannot read, or not found.
 */
export const quoteBadge = (op, step) => {
  if (op?.source?.generated_by === "optimizer" || step?.quote_reason === "generated") return "engine";
  if (step?.quote_verified === true) return "verified";
  if (step?.quote_verified === false) return step.quote_reason === "pdf" ? "pdf" : "missing";
  return null;
};

/**
 * The questions several operations ask alike: a grid's stop the network does not know (by its name), the
 * days a line does not run yet, the network's school zone and its country (the plan's own: plan.region,
 * plan.country). Asked once, on the first card asking it; the answer goes to every operation asking it
 * (ChangeStudio's answer). A change that starts after the feed's end (`after_validity` with its dates, `extend`) is
 * one question too: its answer extends the feed's validity first, for every operation. Null for a question of one
 * operation only.
 */
export const SHARED_QUESTIONS = new Set(["new_dates_missing"]);
const REGION_QUESTIONS = new Set(["calendar_region_missing", "calendar_region_unknown"]);
export const sharedKey = (a) => (a?.code === "timetable_stop" && a.stop ? `stop|${a.stop}` : a?.code === "after_validity" && a.extend ? "validity" : REGION_QUESTIONS.has(a?.code) ? "region" : a?.code === "calendar_country_missing" ? "country" : SHARED_QUESTIONS.has(a?.code) ? `${a.code}|${a.param}` : null);

// Questions no answer here can settle (a trip no route of the line holds): said, with nothing to fill in.
export const UNANSWERABLE = new Set(["timetable_no_pattern"]);
const localDate = (iso, language) => formatDate(iso, language);
// The engine's own identifiers a question may end with, for the model that reads it too: not the reader's words.
const ENGINE_WORDS = /\s*\((?:`?extend_validity`?|weekday|network|pattern)\)/g;
const plainQuestion = (text) => String(text || "").replace(ENGINE_WORDS, "");
// A route's label says its stop count in the engine's words (« (31 stops) »): said in the reader's.
const routeLabel = (t, o) => String(o).replace(/\((\d+) stops\)$/, (_, n) => t("transform.question.stopsCount", { count: Number(n) }));

/**
 * The one act that answers a change starting after the feed's end: the date the feed's validity is extended to (the
 * operation « Prolonger la validité » is then placed first in the change, by the person's answer).
 */
function ExtendAnswer({ ambiguity, onAnswer, testid = "change-answer" }) {
  const { t } = useLanguage();
  const [value, setValue] = useState("");
  const from = ambiguity.extend?.from || "";
  const ok = /^\d{4}-\d{2}-\d{2}$/.test(value) && (!from || value >= from);
  return (
    <Box component="form" onSubmit={(e) => { e.preventDefault(); if (ok) onAnswer(ambiguity.param, value); }} sx={{ display: "flex", flexWrap: "wrap", alignItems: "center", gap: 0.5, mt: 0.5 }}>
      <TextField size="small" type="date" value={value} onChange={(e) => setValue(e.target.value)} label={t("transform.question.extendUntil")} InputLabelProps={{ shrink: true }} inputProps={{ "data-testid": `${testid}-extend`, min: from || undefined }} sx={{ flex: "1 1 150px", "& input": { fontSize: "0.78rem" } }} />
      <Button type="submit" size="small" variant="outlined" disabled={!ok} data-testid={`${testid}-extend-submit`} sx={{ textTransform: "none" }}>
        {t("transform.question.extend")}
      </Button>
    </Box>
  );
}

/** One answer field for a blocked parameter: the options as chips (in the reader's words, the engine's value sent), else a text field. */
function Answer({ ambiguity, onAnswer, label, opType = null, param = null, testid = "change-answer" }) {
  const { t } = useLanguage();
  const [value, setValue] = useState("");
  if (UNANSWERABLE.has(ambiguity.code)) return null;
  if (ambiguity.code === "after_validity" && ambiguity.extend) return <ExtendAnswer ambiguity={ambiguity} onAnswer={onAnswer} testid={testid} />;
  if (Array.isArray(ambiguity.options) && ambiguity.options.length) {
    return (
      <Box sx={{ display: "flex", flexWrap: "wrap", gap: 0.5, mt: 0.5 }}>
        {ambiguity.options.slice(0, 12).map((o) => (
          <Chip key={o} size="small" label={ambiguity.labels?.[o] || (ambiguity.param === "pattern" ? (o === "main" ? t("transform.question.patternMain") : routeLabel(t, o)) : optionLabel(t, opType, param || ambiguity.param, o))} onClick={() => onAnswer(ambiguity.param, o)} data-testid={`${testid}-option`} data-value={o} sx={{ fontWeight: 600, fontSize: "0.72rem", height: "auto", minHeight: 24, "& .MuiChip-label": { whiteSpace: "normal", py: 0.25 } }} />
        ))}
      </Box>
    );
  }
  return (
    <Box component="form" onSubmit={(e) => { e.preventDefault(); if (value.trim()) onAnswer(ambiguity.param, value.trim()); }} sx={{ display: "flex", gap: 0.5, mt: 0.5 }}>
      <TextField size="small" value={value} onChange={(e) => setValue(e.target.value)} placeholder={ambiguity.code === "timetable_stop" ? t("transform.question.stopPlaceholder") : t("transform.answerPlaceholder", { param: label || ambiguity.param })} inputProps={{ "data-testid": `${testid}-input` }} sx={{ flex: 1, "& input": { fontSize: "0.78rem", py: 0.6 } }} />
      <Button type="submit" size="small" variant="outlined" disabled={!value.trim()} sx={{ textTransform: "none" }}>
        {t("transform.answer")}
      </Button>
    </Box>
  );
}

/**
 * One question of the engine, asked in plain words with its answer (chips, else a field) on the operation's card.
 * `together`: how many operations one answer settles.
 */
function QuestionBox({ ambiguity: a, op, def = null, together = 1, onAnswer }) {
  const testid = "change-question";
  const answerTestid = "change-answer";
  const { t, language } = useLanguage();
  const theme = useTheme();
  const paramOf = (name) => (def?.params || []).find((p) => p.name === name) || name;
  return (
    <Box data-testid={testid} data-code={a.code} sx={{ mt: 1, p: 1, borderRadius: "8px", background: alpha(theme.palette.warning.main, 0.08) }}>
      {/* A grid's stop the network does not know: asked in plain words; the answer goes to every grid naming it. */}
      <Typography data-testid={`${testid}-text`} title={a.code === "timetable_stop" ? questionText(t, a, op.type) : undefined} sx={{ fontSize: "0.78rem", fontWeight: 600, lineHeight: 1.4 }}>{a.code === "timetable_stop" && a.stop ? t("transform.question.timetableStop", { stop: a.stop }) : a.code === "after_validity" && a.extend ? t("transform.question.afterValidity", { from: localDate(a.extend.from, language), end: localDate(a.extend.end, language) }) : plainQuestion(questionText(t, a, op.type))}</Typography>
      {together > 1 && <Typography data-testid={`${testid}-together`} sx={{ fontSize: "0.72rem", color: "text.secondary", lineHeight: 1.4 }}>{t("transform.question.together", { count: together })}</Typography>}
      <Answer ambiguity={a} opType={op.type} param={a.param ? paramOf(a.param) : null} label={a.param ? paramLabel(t, op.type, paramOf(a.param)) : ""} testid={answerTestid} onAnswer={(param, value) => onAnswer(op.id, param, value, a)} />
    </Box>
  );
}

const BADGE_TONE = { verified: "success", pdf: "info", missing: "warning", engine: "secondary" };

/**
 * The parameters a card says in its one line (where, when, which days), the others under « Détails »; a grid
 * (stops × trips), a band list or a long list said by its size, never as data.
 */
const LEAD_PARAMS = ["route", "routes", "direction", "days", "period", "from_date", "to_date", "from", "to", "headway_min", "first", "last"];
const paramText = (t, language, k, type, v) => {
  if (k === "timetable" && v && Array.isArray(v.trips)) return t("transform.param.timetableSize", { trips: v.trips.length, stops: Array.isArray(v.stops) ? v.stops.length : 0 });
  if (k === "bands" && Array.isArray(v)) return t("transform.param.bandsSize", { count: v.length });
  if (Array.isArray(v) && v.length > 6) return t("transform.param.listSize", { count: v.length });
  if (v && typeof v === "object" && !Array.isArray(v)) return t("transform.param.detailed");
  return formatParamValue(t, language, k, type, v);
};

/**
 * One operation of the plan, said simply: its name (the offer sheet's label when it came from
 * one, « 16 · BEAULIEU · SEMAINE PS », else the catalogue's), one line of what it does (the engine's summary once
 * simulated, else its main parameters), what it waits for (the engine's questions, answered in place, and its
 * error), and its state when it is not applied. The rest — every parameter, the brief's quote and its check, the
 * engine's warnings — stays under « Détails » (change-operation-details). Removing it is at hand; moving it is in
 * its menu.
 */
// `appliedIn`: the version the operation was applied in (a frozen scenario) — said in place of a simulation's
// status, which a frozen scenario does not keep; `line` / `onFocusLine`: the line the operation acts on
// (utils/changeStates.routeOfOperation), shown in the reader on a click — kept open on a frozen scenario too.
export function OperationCard({ op, step, def, index, count, onAnswer, onRemove, onMove, busy, shared = null, appliedIn = null, line = null, onFocusLine = null }) {
  const { t, language } = useLanguage();
  const theme = useTheme();
  const [details, setDetails] = useState(false);
  const [menu, setMenu] = useState(null);
  // A frozen scenario's operation was applied (its simulation is not kept): its mark is the applied one, never « pending ».
  const frozenIn = appliedIn !== null && appliedIn !== undefined;
  const status = frozenIn ? "applied" : step?.status || "pending";
  const S = STATUS[status] || STATUS.pending;
  const tone = S.color === "default" ? theme.palette.text.secondary : theme.palette[S.color].main;
  const title = op.label || opTitle(t, op.type, def);
  // A retouche of the person's hand (captured on the draft): its words are its title, its rows are no parameters to
  // read — it is removed (or undone) as a whole, and redone in the reader.
  const hand = op?.source?.kind === "hand";
  const badge = quoteBadge(op, step);
  const typeOf = (name) => (def?.params || []).find((p) => p.name === name)?.type || null;
  const paramOf = (name) => (def?.params || []).find((p) => p.name === name) || name;
  const entries = Object.entries(op.params || {});
  const lead = entries.filter(([k]) => LEAD_PARAMS.includes(k)).map(([k, v]) => paramText(t, language, k, typeOf(k), v));
  // A step after a blocked step of its line (waiting_for): its questions come once that step is answered — said, never asked early.
  const waitingFor = Array.isArray(step?.waiting_for) && step.waiting_for.length ? step.waiting_for : null;
  const questions = waitingFor ? [] : step?.ambiguities || [];
  const warnings = step?.warnings || [];
  const badgeTag = badge && (
    <Tooltip title={badge === "missing" && step?.quote_reason ? tf(t, `transform.quote.reason.${step.quote_reason}`, null, t("transform.quote.missing.hint")) : t(`transform.quote.${badge}.hint`)}>
      <Box component="span" data-testid="change-quote-badge" data-badge={badge} sx={{ display: "inline-flex" }}>
        <Tag color={theme.palette[BADGE_TONE[badge]]?.main}>
          {badge === "engine" && <AutoAwesomeOutlinedIcon sx={{ fontSize: 11 }} />}
          {t(`transform.quote.${badge}`)}
        </Tag>
      </Box>
    </Tooltip>
  );
  return (
    <Box data-testid="change-operation" data-status={status} sx={{ p: 1.25, borderRadius: "12px", background: theme.palette.background.paper, boxShadow: `0 0 0 1px ${status === "blocked" || status === "failed" ? alpha(tone, 0.5) : theme.palette.divider}` }}>
      <Box sx={{ display: "flex", alignItems: "flex-start", gap: 1 }}>
        <S.Icon aria-hidden sx={{ fontSize: 18, color: tone, mt: "1px", flexShrink: 0 }} />
        <Box sx={{ minWidth: 0, flex: 1 }}>
          <Typography sx={{ fontSize: "0.86rem", fontWeight: 600, lineHeight: 1.35, overflowWrap: "anywhere" }} title={hand ? t("transform.hand.hint") : `${opTitle(t, op.type, def)} (${op.type})`} data-testid="change-operation-title" data-hand={hand ? "true" : undefined}>
            {hand && <Box component="span" aria-hidden sx={{ mr: 0.5, color: "text.secondary" }}>✎</Box>}
            {title}
          </Typography>
          <Typography data-testid="change-operation-summary" sx={{ fontSize: "0.76rem", color: "text.secondary", lineHeight: 1.45, mt: 0.25 }}>
            {step?.summary || (op.label ? opTitle(t, op.type, def) : lead.join(" · "))}
          </Typography>
        </Box>
        {frozenIn ? (
          <Chip size="small" label={t("change.operation.applied", { n: appliedIn })} color="success" variant="outlined" data-testid="change-operation-status" data-state="applied" sx={{ height: 20, fontSize: "0.64rem", fontWeight: 600, flexShrink: 0 }} />
        ) : (
          status !== "applied" && (
            <Tooltip title={t(`transform.status.${status}.hint`)}>
              <Chip size="small" label={t(`transform.status.${status}`)} color={S.color === "default" ? undefined : S.color} variant="outlined" data-testid="change-operation-status" sx={{ height: 20, fontSize: "0.64rem", fontWeight: 600, flexShrink: 0 }} />
            </Tooltip>
          )
        )}
        <Box sx={{ display: "flex", alignItems: "center", flexShrink: 0, mt: "-3px" }}>
          {line && onFocusLine && (
            <Tooltip title={t("change.operation.focus", { line })}>
              <IconButton size="small" onClick={() => onFocusLine()} aria-label={t("change.operation.focus", { line })} data-testid="change-operation-focus" sx={{ pointerEvents: "auto" }}>
                <PlaceOutlinedIcon sx={{ fontSize: 16 }} />
              </IconButton>
            </Tooltip>
          )}
          <Tooltip title={t("transform.remove")}>
            <span>
              <IconButton size="small" disabled={busy} onClick={() => onRemove(op.id)} aria-label={t("transform.remove")} data-testid="change-remove">
                <DeleteOutlineIcon sx={{ fontSize: 16 }} />
              </IconButton>
            </span>
          </Tooltip>
          {count > 1 && (
            <>
              <Tooltip title={t("transform.more")}>
                <span>
                  <IconButton size="small" disabled={busy} onClick={(e) => setMenu(e.currentTarget)} aria-label={t("transform.more")} data-testid="change-operation-menu">
                    <MoreVertIcon sx={{ fontSize: 16 }} />
                  </IconButton>
                </span>
              </Tooltip>
              <Menu anchorEl={menu} open={Boolean(menu)} onClose={() => setMenu(null)}>
                <MenuItem dense disabled={index === 0} onClick={() => { setMenu(null); onMove(op.id, -1); }}>
                  <ArrowUpwardIcon sx={{ fontSize: 16, mr: 1 }} />
                  {t("transform.moveUp")}
                </MenuItem>
                <MenuItem dense disabled={index === count - 1} onClick={() => { setMenu(null); onMove(op.id, 1); }}>
                  <ArrowDownwardIcon sx={{ fontSize: 16, mr: 1 }} />
                  {t("transform.moveDown")}
                </MenuItem>
              </Menu>
            </>
          )}
        </Box>
      </Box>
      {step?.error && (
        <Alert severity="error" sx={{ mt: 0.75, py: 0, fontSize: "0.74rem" }}>
          {step.error}
        </Alert>
      )}
      {waitingFor && (
        <Typography data-testid="change-question-waiting" sx={{ mt: 0.75, fontSize: "0.74rem", color: "text.secondary", lineHeight: 1.4 }}>
          {t("transform.question.waiting", { ops: waitingFor.join(", ") })}
        </Typography>
      )}
      {questions.map((a, i) => {
        const key = sharedKey(a);
        // Asked on an earlier card: said in one line here, answered there.
        if (key && shared?.first?.get(key) && shared.first.get(key) !== op.id) {
          return (
            <Typography key={`${a.param}-${i}`} data-testid="change-question-shared" sx={{ mt: 0.75, fontSize: "0.74rem", color: "text.secondary", lineHeight: 1.4 }}>
              {t("transform.question.askedAbove")}
            </Typography>
          );
        }
        const together = key ? shared?.count?.get(key) || 1 : 1;
        return <QuestionBox key={`${a.param}-${i}`} ambiguity={a} op={op} def={def} together={together} onAnswer={onAnswer} />;
      })}
      {!hand && <Button size="small" onClick={() => setDetails((v) => !v)} aria-expanded={details} data-testid="change-operation-details-toggle" sx={{ mt: 0.5, ml: -0.75, px: 0.75, minWidth: 0, fontSize: "0.72rem", color: "text.secondary", textTransform: "none" }}>
        {details ? t("transform.details.hide") : t("transform.details.show")}
        {!details && warnings.length > 0 ? ` · ${t("transform.details.warnings", { count: warnings.length })}` : ""}
      </Button>}
      {details && !hand && (
        <Box data-testid="change-operation-details" sx={{ display: "flex", flexDirection: "column", gap: 0.75, mt: 0.25 }}>
          <Box sx={{ display: "flex", flexWrap: "wrap", gap: 0.5 }}>
            {entries.map(([k, v]) => {
              const text = `${paramLabel(t, op.type, paramOf(k))} : ${paramText(t, language, k, typeOf(k), v)}`;
              return (
                <Box component="span" key={k} data-testid="change-param-chip" title={`${text} (${k})`} sx={{ px: 0.75, py: 0.2, borderRadius: 99, background: soft(theme), fontSize: "0.68rem", lineHeight: 1.5, maxWidth: "100%", overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
                  {text}
                </Box>
              );
            })}
          </Box>
          {op.source?.quote ? (
            <Box sx={{ display: "flex", gap: 0.5, alignItems: "flex-start", p: 0.75, borderRadius: "8px", background: soft(theme) }}>
              <FormatQuoteIcon sx={{ fontSize: 14, color: "text.secondary", flexShrink: 0, mt: 0.1 }} />
              <Typography sx={{ flex: 1, fontSize: "0.72rem", fontStyle: "italic", color: "text.secondary", lineHeight: 1.45 }}>
                {op.source.quote}
                {op.source.page ? ` — ${t("transform.page", { page: op.source.page })}` : ""}
              </Typography>
              {badgeTag}
            </Box>
          ) : (
            badge && (
              <Box sx={{ display: "flex", gap: 0.75, alignItems: "center" }}>
                {badgeTag}
                {op.source?.note && <Typography sx={{ fontSize: "0.72rem", color: "text.secondary", lineHeight: 1.45 }}>{op.source.note}</Typography>}
              </Box>
            )
          )}
          {warnings.length > 0 && (
            <Box sx={{ display: "flex", flexDirection: "column", gap: 0.25 }}>
              {warnings.slice(0, 6).map((w, i) => (
                <Box key={i} sx={{ display: "flex", gap: 0.5, alignItems: "flex-start" }}>
                  <WarningAmberIcon sx={{ fontSize: 13, color: "warning.main", mt: 0.2, flexShrink: 0 }} />
                  <Typography sx={{ fontSize: "0.7rem", color: "text.secondary", lineHeight: 1.4 }}>{w}</Typography>
                </Box>
              ))}
            </Box>
          )}
        </Box>
      )}
    </Box>
  );
}


// ── The changes, in the reader's language ───────────────────────────────────

/**
 * One diff item as a sentence (the server's codes, phrased here). `language`: its dates said in that language
 * (« 31/08/2026 », never the GTFS « 20260831 »); without it they stay as sent.
 */
export const describeItem = (t, it, language = null) => {
  const ymd = (d) => (language && formatYmd(d, language, "short")) || d;
  const when = it.dates ? ` (${it.dates.count === 1 ? ymd(it.dates.from) : t("transform.diff.period", { from: ymd(it.dates.from), to: ymd(it.dates.to), count: it.dates.count })})` : "";
  const day = it.day ? `${tf(t, `transform.day.${it.day}`, null, it.day)}${when}` : "";
  const v = (x) => (x == null ? t("transform.diff.none") : x);
  switch (it.code) {
    case "route_added": return t("transform.diff.routeAdded");
    case "route_removed": return t("transform.diff.routeRemoved");
    case "route_attribute": return t("transform.diff.attribute", { field: it.field, before: v(it.before), after: v(it.after) });
    case "route_stops_added": return t("transform.diff.stopsAdded", { stops: it.stops.join(", ") });
    case "route_stops_removed": return t("transform.diff.stopsRemoved", { stops: it.stops.join(", ") });
    case "service_trips": return t("transform.diff.trips", { day, dir: it.direction, before: it.before, after: it.after });
    case "service_first": return t("transform.diff.first", { day, dir: it.direction, before: v(it.before), after: v(it.after) });
    case "service_last": return t("transform.diff.last", { day, dir: it.direction, before: v(it.before), after: v(it.after) });
    case "service_headway": return t("transform.diff.headway", { day, period: tf(t, `transform.period.${it.period}`, null, it.period), dir: it.direction, before: v(it.before), after: v(it.after) });
    case "service_running": return t("transform.diff.running", { day, dir: it.direction, before: it.before, after: it.after });
    case "service_retimed": return t("transform.diff.retimed", { day });
    // The calls: stops on demand (booking), stops without pickup or drop-off, on that day's trips (set_fields).
    case "service_on_demand":
      return [it.on?.length ? t("transform.diff.onDemand", { day, dir: it.direction, stops: it.on.join(", ") }) : "", it.off?.length ? t("transform.diff.onDemandOff", { day, dir: it.direction, stops: it.off.join(", ") }) : ""].filter(Boolean).join(" ; ");
    case "service_boarding":
      return [it.no_pickup?.length ? t("transform.diff.noPickup", { day, dir: it.direction, stops: it.no_pickup.join(", ") }) : "", it.no_drop_off?.length ? t("transform.diff.noDropOff", { day, dir: it.direction, stops: it.no_drop_off.join(", ") }) : "", it.restored?.length ? t("transform.diff.boardingRestored", { day, dir: it.direction, stops: it.restored.join(", ") }) : ""].filter(Boolean).join(" ; ");
    case "vehicles_peak": return t("transform.diff.vehicles", { day, before: it.before, after: it.after });
    case "stop_added": return t("transform.diff.stopAdded", { name: it.name });
    case "stop_removed": return t("transform.diff.stopRemoved", { name: it.name });
    case "stop_renamed": return t("transform.diff.stopRenamed", { before: it.before, after: it.after });
    case "stop_moved": return t("transform.diff.stopMoved", { name: it.name, meters: it.meters });
    case "validity": return t("transform.diff.validity", { before: it.before ? `${ymd(it.before.start)}–${ymd(it.before.end)}` : t("transform.diff.none"), after: it.after ? `${ymd(it.after.start)}–${ymd(it.after.end)}` : t("transform.diff.none") });
    case "services_changed": return countWords(t, "transform.diff.services", Number(it.count) || 0);
    default: return it.code;
  }
};

const fmtNum = (n, lang) => (n == null ? "—" : Math.round(n).toLocaleString(lang || undefined));
const signed = (n, lang) => `${n > 0 ? "+" : n < 0 ? "−" : "±"}${fmtNum(Math.abs(n), lang)}`;

/**
 * The plan's cost in three figures — kilometres, operating cost, vehicles at the peak, each the change over the
 * reference — where it is written (③) and where it is applied (⑤): the same numbers, said before deciding.
 */
export function ImpactStrip({ impact, testid = "change-apply-impact" }) {
  const { t, language } = useLanguage();
  const theme = useTheme();
  if (!impact || impact.error || !impact.totals) return null;
  return (
    <Box sx={theme.studio ? { display: "grid", gridTemplateColumns: "repeat(3, minmax(0, 1fr))", gap: 1 } : { display: "flex", flexWrap: "wrap", gap: 0.75 }} data-testid={testid}>
      {[
        ["km", impact.totals.km?.delta, "km"],
        ["cost", impact.totals.cost?.delta, impact.currency],
        ["fleet", impact.totals.fleet?.delta, ""],
      ]
        .filter(([, d]) => d != null)
        .map(([k, d, unit]) => (
          <Box key={k} data-impact={k} sx={theme.studio ? { px: 1.25, py: 1, borderRadius: "9px", border: `1px solid ${theme.studio.lineSoft}`, display: "flex", flexDirection: "column-reverse", gap: 0.25, minWidth: 0 } : { px: 1, py: 0.6, borderRadius: "10px", background: soft(theme) }}>
            <Typography sx={theme.studio ? { fontSize: "0.7rem", color: "text.secondary", lineHeight: 1.3 } : { fontSize: "0.62rem", color: "text.secondary", fontWeight: 600 }}>{t(`transform.applyDialog.impact.${k}`)}</Typography>
            {/* A figure wider than its third of the column (« −2 657 830 EUR » in a narrow panel) wraps before its unit. */}
            <Typography sx={{ fontSize: theme.studio ? "0.95rem" : "0.84rem", fontWeight: theme.studio ? 600 : 800, fontVariantNumeric: "tabular-nums", whiteSpace: theme.studio ? "normal" : "nowrap", overflowWrap: "anywhere", lineHeight: 1.25 }}>
              {signed(d, language)}
              {unit ? ` ${unit}` : ""}
            </Typography>
          </Box>
        ))}
    </Box>
  );
}

/** What the plan costs to run and who it affects (an amendment's figures). */
export function ImpactCard({ impact }) {
  const { t, language } = useLanguage();
  const theme = useTheme();
  if (!impact || impact.error) return null;
  const rows = [
    ["km", impact.totals.km],
    ["hours", impact.totals.hours],
    ["cost", impact.totals.cost, impact.currency],
    ["fleet", impact.totals.fleet],
    ...(impact.totals.fleet_interlined ? [["fleetInterlined", impact.totals.fleet_interlined]] : []),
    ["frequentStops", impact.totals.frequent_stops],
  ];
  const lost = impact.stops?.lost || [];
  const lostDays = impact.stops?.lost_days || [];
  const lostFrequent = impact.stops?.lost_frequent || [];
  const flags = (impact.flags || []).filter((f) => f.code !== "stop_unserved");
  return (
    <Box data-testid="change-impact" sx={{ p: 1.25, borderRadius: "12px", background: theme.palette.background.paper, boxShadow: `0 0 0 1px ${theme.palette.divider}` }}>
      <Typography sx={{ fontSize: "0.82rem", fontWeight: 800 }}>{t("transform.impact.title")}</Typography>
      <Typography sx={{ fontSize: "0.68rem", color: "text.secondary", mb: 0.75 }}>{t("transform.impact.window", { from: impact.window.from, to: impact.window.to, days: impact.window.days })}</Typography>
      <Box sx={{ display: "grid", gridTemplateColumns: "repeat(auto-fill, minmax(150px, 1fr))", gap: 0.75 }}>
        {rows.map(([k, x, unit]) => (
          <Box key={k} sx={{ px: 1, py: 0.75, borderRadius: "10px", background: soft(theme) }}>
            <Typography sx={{ fontSize: "0.64rem", color: "text.secondary", fontWeight: 600 }}>{t(`transform.impact.${k}`)}</Typography>
            <Typography sx={{ fontSize: "0.84rem", fontWeight: 800 }}>
              {fmtNum(x.after, language)}
              {unit ? ` ${unit}` : ""}
            </Typography>
            <Typography sx={{ fontSize: "0.66rem", fontWeight: 700, color: x.delta > 0 ? "warning.main" : x.delta < 0 ? "info.main" : "text.secondary" }}>
              {signed(x.delta, language)}
              {x.pct != null && x.delta ? ` (${x.pct > 0 ? "+" : ""}${x.pct} %)` : ""}
            </Typography>
          </Box>
        ))}
      </Box>
      {flags.length > 0 && (
        <Box sx={{ mt: 1, display: "flex", flexWrap: "wrap", gap: 0.5 }} data-testid="change-impact-flags">
          {flags.map((f, i) => (
            <Chip key={i} size="small" color="warning" variant="outlined" label={t(`transform.impact.flag.${f.code}`, { line: f.label || "" })} sx={{ height: 22, fontSize: "0.66rem", fontWeight: 700 }} />
          ))}
        </Box>
      )}
      {lost.length > 0 && (
        <Alert severity="warning" sx={{ mt: 1, py: 0, fontSize: "0.74rem" }} data-testid="change-impact-lost">
          {t("transform.impact.lost", { count: lost.length, stops: lost.slice(0, 8).map((s) => s.name).join(", ") })}
        </Alert>
      )}
      {lostDays.length > 0 && <Typography sx={{ mt: 0.75, fontSize: "0.72rem", color: "text.secondary" }}>{t("transform.impact.lostDays", { count: lostDays.length, stops: [...new Set(lostDays.map((s) => s.name))].slice(0, 6).join(", ") })}</Typography>}
      {lostFrequent.length > 0 && <Typography sx={{ mt: 0.5, fontSize: "0.72rem", color: "text.secondary" }}>{t("transform.impact.lostFrequent", { count: lostFrequent.length })}</Typography>}
      <Typography sx={{ mt: 0.75, fontSize: "0.64rem", color: "text.disabled" }}>{t("transform.impact.costBasis", { perKm: impact.assumptions.cost_per_km, currency: impact.currency })}</Typography>
    </Box>
  );
}

export function ChangesPanel({ preview, plan = null }) {
  const { t, language } = useLanguage();
  const theme = useTheme();
  if (!preview) return <Typography sx={{ fontSize: "0.8rem", color: "text.secondary", p: 2 }}>{t("transform.noPreview")}</Typography>;
  const items = preview.diff?.items || [];
  if (!items.length) return <Typography sx={{ fontSize: "0.8rem", color: "text.secondary", p: 2 }} data-testid="change-diff-empty">{t("transform.noChanges")}</Typography>;
  const byLine = new Map();
  const other = [];
  for (const it of items) {
    if (it.label) {
      if (!byLine.has(it.label)) byLine.set(it.label, []);
      byLine.get(it.label).push(it);
    } else other.push(it);
  }
  const totals = preview.diff?.totals;
  return (
    <Box data-testid="change-diff" sx={{ display: "flex", flexDirection: "column", gap: 1.25 }}>
      <ImpactCard impact={preview.impact} />
      <PublishPanel preview={preview} plan={plan} />
      {totals && (
        <Box sx={{ display: "flex", gap: 1, flexWrap: "wrap" }}>
          {[["trips", totals.trips_weekday], ["vehicles", totals.vehicles_peak_weekday], ["routes", totals.routes], ["stops", totals.stops]].map(([k, x]) => (
            <Box key={k} sx={{ px: 1.25, py: 0.75, borderRadius: "10px", background: soft(theme) }}>
              <Typography sx={{ fontSize: "0.66rem", color: "text.secondary", fontWeight: 600 }}>{t(`transform.totals.${k}`)}</Typography>
              <Typography sx={{ fontSize: "0.9rem", fontWeight: 800 }}>
                {x.before} → {x.after}
              </Typography>
            </Box>
          ))}
        </Box>
      )}
      {[...byLine.entries()].map(([label, list]) => (
        <Box key={label} sx={{ p: 1.25, borderRadius: "12px", background: theme.palette.background.paper, boxShadow: `0 0 0 1px ${theme.palette.divider}` }}>
          <Typography sx={{ fontSize: "0.82rem", fontWeight: 800, mb: 0.5 }}>{t("transform.line", { line: label })}</Typography>
          {list.map((it, i) => (
            <Typography key={i} sx={{ fontSize: "0.76rem", lineHeight: 1.5 }} data-testid="change-diff-line">
              {describeItem(t, it, language)}
            </Typography>
          ))}
        </Box>
      ))}
      {other.length > 0 && (
        <Box sx={{ p: 1.25, borderRadius: "12px", background: theme.palette.background.paper, boxShadow: `0 0 0 1px ${theme.palette.divider}` }}>
          {other.map((it, i) => (
            <Typography key={i} sx={{ fontSize: "0.76rem", lineHeight: 1.5 }} data-testid="change-diff-line">
              {describeItem(t, it, language)}
            </Typography>
          ))}
        </Box>
      )}
    </Box>
  );
}

/**
 * Publishing the change: what riders must be told (the notice and the
 * GTFS-RT service alerts, from what the plan really changes) and the
 * change itself as a GTFS Diff for other tools.
 */
export function PublishPanel({ preview, plan = null }) {
  const { t, language } = useLanguage();
  const theme = useTheme();
  const [notice, setNotice] = useState(null);
  const [error, setError] = useState(null);
  const [copied, setCopied] = useState(false);
  const [writing, setWriting] = useState(false);
  const id = preview?.id || null;
  const count = (preview?.passenger || []).length;
  const lang = String(language || "en").slice(0, 2) === "fr" ? "fr" : "en";
  useEffect(() => {
    setNotice(null);
    setError(null);
    if (!id || !count) return undefined;
    let live = true;
    fetchAlerts(id, { language: lang })
      .then((d) => live && setNotice(d.notice))
      .catch((err) => live && setError(err.message));
    return () => {
      live = false;
    };
  }, [id, count, lang]);
  if (!id) return null;
  const download = (kind) => downloadPreviewExport(id, kind, { language: lang }).catch((err) => setError(err.message));
  // The steering-committee note: the plan, the brief's requirements, the impact and — when the server estimates it — the ridership today and with the plan.
  const writeNote = async () => {
    setWriting(true);
    try {
      const [today, withPlan] = await Promise.allSettled([fetchDemand({}), fetchDemand({ previewId: id })]);
      const demand = { before: today.status === "fulfilled" ? today.value : null, after: withPlan.status === "fulfilled" ? withPlan.value : null };
      downloadSynthesis({ plan, preview, demand, t, language });
    } finally {
      setWriting(false);
    }
  };
  const copy = () => {
    if (!notice?.text || !navigator.clipboard) return;
    navigator.clipboard.writeText(notice.text).then(() => setCopied(true), () => {});
  };
  return (
    <Box data-testid="change-publish" sx={{ p: 1.25, borderRadius: "12px", background: theme.palette.background.paper, boxShadow: `0 0 0 1px ${theme.palette.divider}` }}>
      <Typography sx={{ fontSize: "0.82rem", fontWeight: 800 }}>{t("transform.publish.title")}</Typography>
      <Typography sx={{ fontSize: "0.68rem", color: "text.secondary", mb: 0.75 }}>{t("transform.publish.subtitle", { count })}</Typography>
      {error && <Alert severity="warning" sx={{ py: 0, mb: 0.75, fontSize: "0.72rem" }}>{error}</Alert>}
      {notice?.text && (
        <Box component="pre" data-testid="change-publish-notice" sx={{ m: 0, mb: 0.75, p: 1, borderRadius: "10px", background: soft(theme), fontFamily: "inherit", fontSize: "0.74rem", lineHeight: 1.5, whiteSpace: "pre-wrap", maxHeight: 220, overflowY: "auto" }}>
          {notice.text}
        </Box>
      )}
      <Box sx={{ display: "flex", flexWrap: "wrap", gap: 0.5 }}>
        {notice?.text && <Chip size="small" variant="outlined" label={copied ? t("transform.publish.copied") : t("transform.publish.copy")} onClick={copy} data-testid="change-publish-copy" />}
        {count > 0 && <Chip size="small" variant="outlined" label={t("transform.publish.alertsPb")} onClick={() => download("alerts-pb")} data-testid="change-publish-alerts" />}
        {count > 0 && <Chip size="small" variant="outlined" label={t("transform.publish.alertsJson")} onClick={() => download("alerts-json")} />}
        <Chip size="small" color="primary" variant="outlined" label={writing ? t("transform.synthesis.writing") : t("transform.synthesis.download")} onClick={writing ? undefined : writeNote} data-testid="change-publish-note" />
        <Chip size="small" variant="outlined" label={t("transform.publish.diffCsv")} onClick={() => download("diff-csv")} data-testid="change-publish-diff" />
        <Chip size="small" variant="outlined" label={t("transform.publish.diffJson")} onClick={() => download("diff-json")} />
      </Box>
    </Box>
  );
}

/** The network's quality on the planners' scale, before → after the plan. */
export function QualityCard({ quality }) {
  const { t } = useLanguage();
  const theme = useTheme();
  if (!quality || quality.error) return null;
  const tone = (a, b) => (b > a ? "success.main" : b < a ? "error.main" : "text.secondary");
  const params = (f) => {
    const p = { ...(f.params || {}) };
    if (p.tier) p.tier = tf(t, `transform.quality.tier.${p.tier}`, null, p.tier);
    for (const k of ["main_share", "same_path", "share", "target"]) if (typeof p[k] === "number" && p[k] <= 1) p[k] = `${Math.round(p[k] * 100)} %`;
    if (Array.isArray(p.lines)) p.lines = p.lines.join(", ");
    return p;
  };
  const phrase = (f) => `${f.label ? `${t("transform.line", { line: f.label })} — ` : ""}${tf(t, `transform.quality.finding.${f.code}`, params(f), f.code)}`;
  return (
    <Box data-testid="change-quality" sx={{ p: 1.25, borderRadius: "12px", background: theme.palette.background.paper, boxShadow: `0 0 0 1px ${theme.palette.divider}` }}>
      <Box sx={{ display: "flex", alignItems: "baseline", gap: 1 }}>
        <Typography sx={{ fontSize: "0.82rem", fontWeight: 800, flex: 1 }}>{t("transform.quality.title")}</Typography>
        <Typography sx={{ fontSize: "0.9rem", fontWeight: 800, color: tone(quality.score.before, quality.score.after) }} data-testid="change-quality-score">
          {quality.score.grade_before} {quality.score.before} → {quality.score.grade_after} {quality.score.after}
        </Typography>
      </Box>
      <Box sx={{ display: "grid", gridTemplateColumns: "repeat(auto-fill, minmax(120px, 1fr))", gap: 0.5, mt: 0.75 }}>
        {quality.dimensions.map((d) => (
          <Box key={d.id} sx={{ px: 1, py: 0.5, borderRadius: "8px", background: soft(theme) }}>
            <Typography sx={{ fontSize: "0.64rem", color: "text.secondary", fontWeight: 600 }}>{t(`transform.quality.dim.${d.id}`)}</Typography>
            <Typography sx={{ fontSize: "0.8rem", fontWeight: 800, color: tone(d.before, d.after) }}>
              {d.before} → {d.after}
            </Typography>
          </Box>
        ))}
      </Box>
      {quality.resolved.length > 0 && (
        <Box sx={{ mt: 0.75 }}>
          <Typography sx={{ fontSize: "0.7rem", fontWeight: 700, color: "success.main" }}>{t("transform.quality.resolved", { count: quality.resolved.length })}</Typography>
          {quality.resolved.slice(0, 6).map((f, i) => (
            <Typography key={i} sx={{ fontSize: "0.7rem", color: "text.secondary", lineHeight: 1.45 }}>
              ✓ {phrase(f)}
            </Typography>
          ))}
        </Box>
      )}
      {quality.added.length > 0 && (
        <Box sx={{ mt: 0.75 }}>
          <Typography sx={{ fontSize: "0.7rem", fontWeight: 700, color: "warning.main" }}>{t("transform.quality.added", { count: quality.added.length })}</Typography>
          {quality.added.slice(0, 6).map((f, i) => (
            <Typography key={i} sx={{ fontSize: "0.7rem", color: "text.secondary", lineHeight: 1.45 }}>
              ! {phrase(f)}
            </Typography>
          ))}
        </Box>
      )}
    </Box>
  );
}

/**
 * What stands between the plan and "Apply", one line per item of the gate in the server's order: what blocks
 * ("error": fixed, never accepted), then what a named person accepts at the application ("warning"). The apply panel
 * reads the same gate, so the box says « Rien ne bloque » only when both lists are empty — never above the apply
 * panel's « Impossible d'appliquer » while a step, the integrity or a server without the validator holds the plan.
 *   gateLinesOf(t, gate, preview) → [[tone, text]]
 */
export const gateLinesOf = (t, gate, preview = null) => {
  if (!gate) return [];
  const lines = [];
  for (const b of gate.blocking || []) {
    const code = b?.code;
    if (code === "blocked_steps") lines.push(["error", t("transform.gate.steps", { count: blockedSteps(preview).length || (Array.isArray(b.steps) ? b.steps.length : 0) || 1 })]);
    else if (code === "integrity") lines.push(["error", t("transform.gate.integrity")]);
    else if (code === "validator_unavailable") lines.push(["error", t("gtfsCheck.unavailable")]);
    // New errors of the validator block (gateOf moves them there whatever an older server said): fixed, never accepted.
    else if (code === "validation_new_errors") lines.push(["error", t("gtfsCheck.newErrors", { count: Array.isArray(b.new_errors) ? b.new_errors.length : 1 })]);
    // A kind this screen does not know yet still blocks: never « Rien ne bloque » over it.
    else lines.push(["error", t("transform.applyDialog.cannot")]);
  }
  for (const a of gate.acknowledgeable || []) {
    const code = a?.code;
    const count = (list) => (Array.isArray(list) ? list.length : 0);
    if (code === "clauses_failing") lines.push(["warning", t("transform.gate.clauses", { count: count(a.clauses) })]);
    else if (code === "clauses_unknown") lines.push(["warning", t("transform.clausesUnknown", { count: count(a.clauses) })]);
    else if (code === "sources_unverified") lines.push(["warning", t("transform.gate.sources", { count: count(a.operations) })]);
    else if (code === "baseline_errors") lines.push(["warning", t("transform.status.baselineErrors", { count: Number(a.errors) || 0 })]);
    else if (code === "changes_not_asked") {
      const changes = Array.isArray(a.changes) ? a.changes : [];
      const tables = changes.filter((c) => c?.table).length;
      if (changes.length - tables || !tables) lines.push(["warning", t("transform.gate.changesNotAsked", { count: changes.length - tables })]);
      if (tables) lines.push(["warning", t("transform.gate.rowsNotAsked", { count: tables })]);
    }
    else if (code) lines.push(["warning", t("ack.title")]);
  }
  return lines;
};

// `frozen`: the scenario was applied — its operations are never simulated again, so the validator's re-run,
// which simulates them, is closed.
export function ChecksPanel({ preview, validating, onValidate, frozen = false }) {
  const { t } = useLanguage();
  const theme = useTheme();
  const seconds = useElapsed(Boolean(validating));
  // Nothing simulated yet: the verdict still heads the checks, and says "not measured yet" (never nothing).
  if (!preview)
    return (
      <Box data-testid="change-checks-empty" sx={{ display: "flex", flexDirection: "column", gap: 1.25 }}>
        <VerdictCard payload={null} variant="pinned" />
        <Typography sx={{ fontSize: "0.8rem", color: "text.secondary", px: 0.5 }}>{t("transform.noPreview")}</Typography>
      </Box>
    );
  const before = new Map((preview.conformance?.before?.results || []).map((r) => [r.id, r]));
  const after = preview.conformance?.after?.results || [];
  const statusChip = (s) => <Chip size="small" label={tf(t, `transform.clause.${s}`, null, s)} color={s === "pass" ? "success" : s === "fail" ? "error" : "default"} variant="outlined" sx={{ height: 20, fontSize: "0.64rem", fontWeight: 700 }} />;
  const v = preview.validation;
  const gate = gateOf(preview);
  const gateLines = gateLinesOf(t, gate, preview);
  const validatorOff = gate?.validation === "unavailable" && !v;
  const ran = v && !v.error;
  return (
    <Box data-testid="change-checks" sx={{ display: "flex", flexDirection: "column", gap: 1.25 }}>
      {/* The engine's verdict, pinned: the first thing the checks say. */}
      <VerdictCard payload={{ verdict: preview.verdict ?? null, gate: preview.gate || null, validation: preview.validation || null }} variant="pinned" measured steps={preview.steps || null} integrity={preview.integrity || null} />
      {preview.id && (
        <Box data-testid="change-gate" data-state={gateLines.some(([tone]) => tone === "error") ? "blocked" : gateLines.length ? "to-accept" : "clear"} sx={{ p: 1.25, borderRadius: "12px", background: alpha(gateLines.some(([tone]) => tone === "error") ? theme.palette.error.main : gateLines.length ? theme.palette.warning.main : theme.palette.success.main, 0.07) }}>
          <Typography sx={{ fontSize: "0.82rem", fontWeight: 800, mb: 0.25 }}>{t("transform.gate.title")}</Typography>
          {!gateLines.length && <Typography sx={{ fontSize: "0.76rem", color: "success.main" }}>{t("transform.gate.clear")}</Typography>}
          {gateLines.map(([tone, text], i) => (
            <Typography key={i} sx={{ fontSize: "0.76rem", lineHeight: 1.5, color: `${tone}.main` }}>
              • {text}
            </Typography>
          ))}
          {gateLines.some(([tone]) => tone === "warning") && !gateLines.some(([tone]) => tone === "error") && <Typography sx={{ fontSize: "0.7rem", color: "text.secondary", mt: 0.25 }}>{t("transform.gate.ackHint")}</Typography>}
        </Box>
      )}
      <QualityCard quality={preview.quality} />
      <Box sx={{ p: 1.25, borderRadius: "12px", background: theme.palette.background.paper, boxShadow: `0 0 0 1px ${theme.palette.divider}` }}>
        <Typography sx={{ fontSize: "0.82rem", fontWeight: 800, mb: 0.75 }}>{t("transform.checks.clauses")}</Typography>
        {!after.length && <Typography sx={{ fontSize: "0.76rem", color: "text.secondary" }}>{t("transform.checks.noClauses")}</Typography>}
        {after.map((r) => {
          // The clause in its own words, its status in the chips (the person's words); the engine's note when it has
          // words for it. What the engine measured, in its own terms, is the row's tooltip — never its text (an
          // English « measured 24 on … (expected exactly 10) » would show in the French interface).
          const note = r.status === "unknown" && r.note ? engineNote(r.note, t) : null;
          const said = note && note !== r.note ? note : null;
          const tip = [r.status !== "pass" && r.measured != null ? t("transform.checks.measured", { expected: r.expected ?? "?", measured: r.measured }) : null, r.status === "unknown" && r.note && !said ? r.note : null].filter(Boolean).join(" — ");
          return (
            <Box key={r.id} data-testid="change-clause" data-status={r.status} title={tip || undefined} sx={{ display: "flex", alignItems: "center", gap: 1, py: 0.4 }}>
              <Typography sx={{ fontSize: "0.76rem", flex: 1, minWidth: 0 }}>
                {r.level === "must" && <Box component="span" sx={{ fontWeight: 700 }}>{t("transform.checks.must")} </Box>}
                {r.text || r.kind || r.id}
                {said ? ` — ${said}` : ""}
              </Typography>
              {before.get(r.id) && statusChip(before.get(r.id).status)}
              <Typography sx={{ fontSize: "0.7rem", color: "text.secondary" }}>→</Typography>
              {statusChip(r.status)}
            </Box>
          );
        })}
      </Box>
      <Box sx={{ p: 1.25, borderRadius: "12px", background: theme.palette.background.paper, boxShadow: `0 0 0 1px ${theme.palette.divider}` }}>
        <Typography sx={{ fontSize: "0.82rem", fontWeight: 800, mb: 0.75 }}>{t("transform.checks.integrity")}</Typography>
        {(preview.integrity || []).length ? (
          preview.integrity.map((i) => (
            <Typography key={i.code} sx={{ fontSize: "0.76rem", color: "error.main" }}>
              {tf(t, `transform.integrity.${i.code}`, { count: i.count }, `${i.code} ×${i.count}`)}
            </Typography>
          ))
        ) : (
          <Typography sx={{ fontSize: "0.76rem", color: "success.main" }} data-testid="change-integrity-ok">
            {t("transform.checks.integrityOk")}
          </Typography>
        )}
      </Box>
      <Box sx={{ p: 1.25, borderRadius: "12px", background: theme.palette.background.paper, boxShadow: `0 0 0 1px ${theme.palette.divider}` }} data-testid="change-consumer-checks">
        <Typography sx={{ fontSize: "0.82rem", fontWeight: 800, mb: 0.5 }}>{t("transform.checks.consumers")}</Typography>
        {(preview.checks || []).length ? (
          preview.checks.map((c) => (
            <Typography key={c.code} sx={{ fontSize: "0.76rem", color: "warning.main", lineHeight: 1.5 }}>
              {tf(t, `transform.checks.consumer.${c.code}`, { before: c.before, after: c.count }, `${c.code}: ${c.before} → ${c.count}`)}
            </Typography>
          ))
        ) : (
          <Typography sx={{ fontSize: "0.76rem", color: "success.main" }}>{t("transform.checks.consumersOk")}</Typography>
        )}
      </Box>
      <Box sx={{ p: 1.25, borderRadius: "12px", background: theme.palette.background.paper, boxShadow: `0 0 0 1px ${theme.palette.divider}` }}>
        <Box sx={{ display: "flex", alignItems: "center", gap: 1, mb: 0.75 }}>
          <Typography sx={{ fontSize: "0.82rem", fontWeight: 800, flex: 1 }}>{t("gtfsCheck.title")}</Typography>
          {/* It runs by itself on a stable simulation; the button re-runs it. */}
          <Button size="small" variant="outlined" disabled={frozen || validating || !preview.id || validatorOff} onClick={frozen ? undefined : onValidate} data-testid="change-validate" sx={{ textTransform: "none" }}>
            {validating ? t("transform.checks.validating") : v ? t("gtfsCheck.rerun") : t("transform.checks.runValidator")}
          </Button>
        </Box>
        {validating && (
          <Typography data-testid="change-validator-running" sx={{ fontSize: "0.76rem", color: "text.secondary" }}>
            {t("gtfsCheck.running", { seconds })}
          </Typography>
        )}
        {!v && !validating && (
          <Typography sx={{ fontSize: "0.76rem", color: validatorOff ? "error.main" : "text.secondary" }} data-testid={validatorOff ? "change-validator-unavailable" : undefined}>
            {validatorOff ? t("gtfsCheck.unavailable") : t("gtfsCheck.auto")}
          </Typography>
        )}
        {v?.error && (
          <Alert severity="error" sx={{ py: 0, fontSize: "0.76rem" }} data-testid="change-validator-failed">
            {t("gtfsCheck.failed")}
            <Box component="details" sx={{ mt: 0.25, fontSize: "0.7rem", color: "text.secondary" }}>
              <summary>{t("error.human.details")}</summary>
              <Box component="span" lang="en" sx={{ overflowWrap: "anywhere" }}>{String(v.error)}</Box>
            </Box>
          </Alert>
        )}
        {ran && (
          <Box sx={{ fontSize: "0.76rem", color: v.new_errors?.length ? "error.main" : "success.main" }} data-testid="change-validator-result" data-new-errors={(v.new_errors || []).length}>
            {v.new_errors?.length ? (
              <>
                <Typography sx={{ fontSize: "0.76rem", fontWeight: 700, color: "inherit" }}>{t("gtfsCheck.newErrors", { count: v.new_errors.length })}</Typography>
                <Box component="ul" sx={{ m: 0, pl: 2 }}>
                  {v.new_errors.map((e) => (
                    <li key={e.code}>{t("gtfsCheck.rule", { code: e.code, before: e.before, after: e.after })}</li>
                  ))}
                </Box>
              </>
            ) : (
              <Typography sx={{ fontSize: "0.76rem", color: "inherit" }}>{t("gtfsCheck.okNewPlain", { before: v.before?.errors ?? "—", after: v.after?.errors ?? "—" })}</Typography>
            )}
          </Box>
        )}
      </Box>
    </Box>
  );
}
