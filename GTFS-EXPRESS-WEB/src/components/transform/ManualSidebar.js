/**
 * ManualSidebar — the left column of ③ without the assistant.
 *
 * Without the assistant (the server's chat off, or no Studio access on this
 * account) the journey is the same five steps — the same verdict, the same
 * acknowledgement, the same validator, the same delivery — and only the
 * engine of ③ changes: the person does by hand what the assistant would
 * have proposed. The column where the conversation would be says so once
 * — with, when the account lacks the Studio, the lock in place (`locked`:
 * LockedAction, its reason and its action) — then holds what the work
 * by hand needs, never a disabled composer:
 *
 *   the verdict      the engine's, re-measured on each edit or simulation
 *                    (the host passes its VerdictCard: never computed here)
 *   the contract     its state in words (decided · assumed · empty · not yet
 *                    decided) and its clauses' count, with the way to ②
 *   create           the design's sub-tasks, a vertical list in the order a
 *                    network is drawn — the network's settings (the three
 *                    fields GTFS requires), the stops (placed or not), the
 *                    lines, the points to fix — each with its state in text
 *                    (à faire · en cours · fait, never a colour alone) and one
 *                    click to where it is done; « Ouvrir l'éditeur de lignes »
 *                    (`plan-manual-start`); the list « Ce qu'il nous faut de
 *                    vous » and the territory as the host gives them
 *   modify           the network's lines first (LinePicker: a line picked
 *                    narrows the catalogue to the operations of one line, and
 *                    the host fills the form with it), then the catalogue of
 *                    operations as the column itself (OperationCatalog:
 *                    searched, by family, each operation with what it does in
 *                    plain words): a click opens the operation's form with
 *                    that operation chosen; the documents to cite, as the
 *                    host gives them
 *
 * Modifying with a brief the column reads as a guide, in
 * this order: the brief's timetables to add in one act (`offer`,
 * OfferOperations), the objectives' progress in words (`progress`,
 * ObjectivesProgress, in place of the engine's raw verdict), the suggestions
 * to carry out (`objectives`), then « Ajouter une modification à la main »
 * (`manual-add-toggle`) which unfolds the lines and the catalogue — folded
 * while the guide has work to show, open otherwise. Where the journey builds
 * its change by itself (`autopilot`: transform/AutopilotPanel) that panel
 * leads the column in place of the « Sans assistant » words: what was
 * built, what the engine settled by itself, what waits for the person; the
 * assistant's lock, when there is one, is then the column's last word — said
 * by what the assistant would do there, with its reason and its way.
 *
 * OperationCatalog is also the operation form's first screen (OperationDialog:
 * the catalogue instead of an empty field). The items are plain
 * buttons, never listbox options: the form's field keeps the only listbox.
 * `designTasksOf` is pure, exported for tests and for the host.
 */

import React, { useId, useMemo, useState } from "react";
import { Box, Button, ButtonBase, TextField, Typography, alpha, useTheme } from "@mui/material";
import CheckCircleOutlineIcon from "@mui/icons-material/CheckCircleOutline";
import RadioButtonUncheckedIcon from "@mui/icons-material/RadioButtonUnchecked";
import TimelapseIcon from "@mui/icons-material/Timelapse";
import DrawOutlinedIcon from "@mui/icons-material/DrawOutlined";
import GavelOutlinedIcon from "@mui/icons-material/GavelOutlined";
import { useLanguage } from "../../contexts/LanguageContext";
import { soft } from "../network/StudioUI";
import { catalogueFamilies, opHelp, opTitle, searchCatalogue } from "./catalogueText";

// The three fields GTFS requires of the operator (NetworkSettings says the same).
export const REQUIRED_SETTINGS = Object.freeze(["name", "url", "timezone"]);
const STATE_ICON = { done: CheckCircleOutlineIcon, partial: TimelapseIcon, todo: RadioButtonUncheckedIcon };
const hasCoords = (s) => Number.isFinite(s?.lat) && Number.isFinite(s?.lon);

/**
 * The design's sub-tasks and their states, from the spec and the number of
 * blocking issues the live validation reports: settings (the required
 * fields missing), stops (placed or not), lines (each with two stops at
 * least), issues (what blocks the build). `measured`: whether a validation
 * has come back — until then (the first debounce, a validation that
 * failed) the issues are « à mesurer », never « fait »: nothing is said
 * done that was not measured.
 */
export const designTasksOf = (spec, { blockers = 0, measured = false } = {}) => {
  const agency = spec?.agency || {};
  const missing = REQUIRED_SETTINGS.filter((k) => !String(agency[k] || "").trim()).length;
  const stops = spec?.stops || [];
  const unplaced = stops.filter((s) => !hasCoords(s)).length;
  const lines = spec?.lines || [];
  const drawn = lines.filter((l) => (l?.directions?.[0]?.stops || []).length >= 2).length;
  return [
    { id: "settings", state: !missing ? "done" : missing < REQUIRED_SETTINGS.length ? "partial" : "todo", count: missing },
    { id: "stops", state: !stops.length ? "todo" : unplaced ? "partial" : "done", count: stops.length, unplaced },
    { id: "lines", state: !lines.length ? "todo" : drawn < lines.length ? "partial" : "done", count: lines.length },
    { id: "issues", state: !lines.length || !measured ? "todo" : blockers ? "partial" : "done", count: blockers, measured: lines.length > 0 && Boolean(measured), hasLines: lines.length > 0 },
  ];
};

/** A sub-task's detail, in words. */
const taskDetail = (t, task) => {
  switch (task.id) {
    case "settings":
      return task.count ? t("manual.task.settings.missing", { count: task.count }) : t("manual.task.settings.done");
    case "stops":
      if (!task.count) return t("manual.task.stops.none");
      return [t("manual.task.stops.count", { count: task.count }), task.unplaced ? t("manual.task.stops.unplaced", { count: task.unplaced }) : null].filter(Boolean).join(" · ");
    case "lines":
      return task.count ? t("manual.task.lines.count", { count: task.count }) : t("manual.task.lines.none");
    default:
      // No line yet: measured from the first one; lines but no validation back yet: « à mesurer ».
      if (task.measured === false) return t(task.hasLines ? "manual.task.issues.pending" : "manual.task.issues.later");
      return task.count ? t("manual.task.issues.count", { count: task.count }) : t("manual.task.issues.none");
  }
};

function SectionTitle({ id, children }) {
  return (
    <Typography id={id} component="h3" sx={{ fontSize: "0.7rem", fontWeight: 800, letterSpacing: 0.4, textTransform: "uppercase", color: "text.secondary" }}>
      {children}
    </Typography>
  );
}

/** The contract in words, and the way to ②. */
function ContractSummary({ contract }) {
  const { t } = useLanguage();
  const status = ["decided", "assumed", "empty"].includes(contract.status) ? contract.status : "draft";
  return (
    <Box data-testid="manual-contract" data-status={status} sx={{ display: "flex", alignItems: "center", gap: 1 }}>
      <GavelOutlinedIcon aria-hidden sx={{ fontSize: 18, color: "text.secondary" }} />
      <Typography sx={{ flex: 1, minWidth: 0, fontSize: "0.78rem" }}>{t(`manual.contract.${status}`, { count: contract.count ?? 0 })}</Typography>
      {contract.onOpen && (
        <Button size="small" onClick={contract.onOpen} data-testid="manual-contract-open" sx={{ textTransform: "none", fontWeight: 700, flexShrink: 0 }}>
          {t("manual.contract.open")}
        </Button>
      )}
    </Box>
  );
}

/** The design's sub-tasks: a vertical list, each state said in text, each a click to where it is done. */
function TaskList({ tasks }) {
  const { t } = useLanguage();
  const theme = useTheme();
  const titleId = useId();
  return (
    <Box component="section" aria-labelledby={titleId} sx={{ display: "flex", flexDirection: "column", gap: 0.5 }}>
      <SectionTitle id={titleId}>{t("manual.tasks.title")}</SectionTitle>
      <Box component="ol" data-testid="manual-tasks" sx={{ listStyle: "none", m: 0, p: 0, display: "flex", flexDirection: "column", gap: 0.25 }}>
        {tasks.map((task) => {
          const Icon = STATE_ICON[task.state] || RadioButtonUncheckedIcon;
          const color = task.state === "done" ? theme.palette.success.main : task.state === "partial" ? theme.palette.warning.dark : theme.palette.text.secondary;
          return (
            <li key={task.id}>
              <ButtonBase
                onClick={task.onClick || undefined}
                disabled={!task.onClick}
                data-testid={`manual-task-${task.id}`}
                data-state={task.state}
                sx={{ width: "100%", justifyContent: "flex-start", textAlign: "left", gap: 1, px: 1, py: 0.75, borderRadius: "10px", "&:hover": { background: soft(theme) }, "&.Mui-focusVisible": { outline: `2px solid ${theme.palette.primary.main}`, outlineOffset: 1 } }}
              >
                <Icon aria-hidden sx={{ fontSize: 18, color, flexShrink: 0 }} />
                <Box sx={{ minWidth: 0, flex: 1 }}>
                  <Typography sx={{ fontSize: "0.8rem", fontWeight: 700, lineHeight: 1.3 }}>
                    {t(`manual.task.${task.id}`)}
                    <Box component="span" sx={{ ml: 0.75, fontSize: "0.66rem", fontWeight: 700, color }}>
                      ({t(`step.state.${task.state}`)})
                    </Box>
                  </Typography>
                  <Typography sx={{ fontSize: "0.72rem", color: "text.secondary", lineHeight: 1.4 }}>{taskDetail(t, task)}</Typography>
                </Box>
              </ButtonBase>
            </li>
          );
        })}
      </Box>
    </Box>
  );
}

/**
 * The catalogue of operations as a list: a search in the reader's words,
 * the operations by family, each with what it does. `query` makes the
 * search the host's (the operation form's own field); without it the list
 * has its own field.
 */
export function OperationCatalog({ catalogue = [], onPick, disabled = false, query = null, loading = false, maxHeight = null, testid = "operation-catalog", sx = {} }) {
  const { t, language } = useLanguage();
  const theme = useTheme();
  const titleId = useId();
  const [own, setOwn] = useState("");
  const q = query ?? own;
  const list = useMemo(() => searchCatalogue(t, catalogue, q, language), [t, catalogue, q, language]);
  const families = useMemo(() => catalogueFamilies(t, list), [t, list]);
  return (
    <Box component="section" aria-labelledby={titleId} data-testid={testid} sx={{ display: "flex", flexDirection: "column", gap: 0.75, minHeight: 0, ...sx }}>
      <Box sx={{ display: "flex", alignItems: "baseline", gap: 1 }}>
        <SectionTitle id={titleId}>{t("catalog.title")}</SectionTitle>
        <Typography data-testid="catalog-count" sx={{ fontSize: "0.7rem", color: "text.secondary" }}>
          {t("catalog.count", { count: list.length })}
        </Typography>
      </Box>
      {query === null && (
        <TextField size="small" type="search" label={t("catalog.search")} value={own} onChange={(e) => setOwn(e.target.value)} inputProps={{ "data-testid": "catalog-search" }} fullWidth />
      )}
      <Box sx={{ overflowY: "auto", minHeight: 0, ...(maxHeight ? { maxHeight } : {}) }}>
        {loading && !catalogue.length ? (
          <Typography sx={{ fontSize: "0.76rem", color: "text.secondary" }}>{t("catalog.loading")}</Typography>
        ) : !list.length ? (
          <Typography data-testid="catalog-none" sx={{ fontSize: "0.76rem", color: "text.secondary" }}>
            {t("catalog.none", { query: q })}
          </Typography>
        ) : (
          families.map((f) => (
            <Box key={f.category || "other"} data-testid="catalog-family" data-category={f.category} sx={{ mb: 1 }}>
              <Typography component="h4" sx={{ fontSize: "0.74rem", fontWeight: 800, color: "text.primary", mb: 0.25 }}>
                {f.label}
              </Typography>
              <Box component="ul" sx={{ listStyle: "none", m: 0, p: 0 }}>
                {f.operations.map((o) => {
                  const help = opHelp(t, o.type, o);
                  return (
                    <li key={o.type}>
                      <ButtonBase
                        onClick={() => onPick?.(o.type)}
                        disabled={disabled || !onPick}
                        data-testid="catalog-item"
                        data-type={o.type}
                        sx={{ width: "100%", display: "block", textAlign: "left", px: 1, py: 0.6, borderRadius: "8px", "&:hover": { background: soft(theme) }, "&.Mui-focusVisible": { outline: `2px solid ${theme.palette.primary.main}`, outlineOffset: 1 }, "&.Mui-disabled": { opacity: 0.6 } }}
                      >
                        <Typography component="span" sx={{ display: "block", fontSize: "0.8rem", fontWeight: 700, lineHeight: 1.3 }}>
                          {opTitle(t, o.type, o)}
                        </Typography>
                        {help && (
                          <Typography component="span" sx={{ display: "-webkit-box", WebkitLineClamp: 3, WebkitBoxOrient: "vertical", overflow: "hidden", fontSize: "0.72rem", color: "text.secondary", lineHeight: 1.4 }}>
                            {help}
                          </Typography>
                        )}
                      </ButtonBase>
                    </li>
                  );
                })}
              </Box>
            </Box>
          ))
        )}
      </Box>
    </Box>
  );
}

/** Whether an operation of the catalogue works on one line (a `route` or `routes` parameter): what a line picked offers. */
export const isLineOperation = (o) => (o?.params || []).some((p) => p && (p.type === "route" || p.type === "routes"));

/**
 * The network's lines, first in the column (modify): a person who comes to change line B picks line B, then what
 * changes on it — the catalogue then lists the operations of one line only, and the form opens with the line
 * filled in (ChangeStudio). « Toutes les lignes » gives the whole catalogue back.
 */
export function LinePicker({ routes = [], selected = null, onSelect, disabled = false }) {
  const { t } = useLanguage();
  const theme = useTheme();
  const titleId = useId();
  if (!routes.length || !onSelect) return null;
  const current = routes.find((r) => r.id === selected) || null;
  // Its weekday service as the overview measures it (routeStats: per direction): trips, first and last departure, peak vehicles.
  const serviceOf = (r) => {
    const s = r?.service?.weekday || null;
    if (!s) return null;
    const dirs = Object.values(s.directions || {});
    // HH:MM, as a timetable reads (the overview gives HH:MM:SS).
    const hm = (v) => String(v).slice(0, 5);
    const first = dirs.map((d) => d.first).filter(Boolean).sort().map(hm)[0] || null;
    const last = dirs.map((d) => d.last).filter(Boolean).sort().map(hm).pop() || null;
    return { trips: s.trips ?? null, first, last, vehicles: s.vehicles_peak ?? null };
  };
  return (
    <Box component="section" aria-labelledby={titleId} data-testid="line-picker" data-selected={current ? current.id : ""} sx={{ display: "flex", flexDirection: "column", gap: 0.75 }}>
      <Box sx={{ display: "flex", alignItems: "baseline", gap: 1 }}>
        <SectionTitle id={titleId}>{t("manual.lines.title")}</SectionTitle>
        <Typography sx={{ fontSize: "0.7rem", color: "text.secondary" }}>{t("manual.lines.count", { count: routes.length })}</Typography>
      </Box>
      <Box role="group" aria-label={t("manual.lines.title")} sx={{ display: "flex", flexWrap: "wrap", gap: 0.5 }}>
        {routes.map((r) => {
          const on = r.id === selected;
          const name = r.short_name || r.id;
          return (
            <ButtonBase
              key={r.id}
              onClick={() => onSelect(on ? null : r.id)}
              disabled={disabled}
              aria-pressed={on}
              title={[name, r.long_name, Array.isArray(r.termini) ? r.termini.filter(Boolean).join(" ↔ ") : null].filter(Boolean).join(" — ")}
              data-testid="line-picker-line"
              data-route={r.id}
              sx={{ minWidth: 36, px: 1, py: 0.4, borderRadius: "8px", fontSize: "0.78rem", fontWeight: 800, border: `1px solid ${on ? theme.palette.primary.main : theme.palette.divider}`, color: on ? theme.palette.primary.contrastText : "text.primary", background: on ? theme.palette.primary.main : theme.palette.background.paper, "&:hover": { borderColor: theme.palette.primary.main }, "&.Mui-focusVisible": { outline: `2px solid ${theme.palette.primary.main}`, outlineOffset: 1 } }}
            >
              {name}
            </ButtonBase>
          );
        })}
      </Box>
      {current && (
        <Box data-testid="line-picker-current" sx={{ p: 1, borderRadius: "10px", background: soft(theme), display: "flex", flexDirection: "column", gap: 0.25 }}>
          <Typography sx={{ fontSize: "0.8rem", fontWeight: 800 }}>
            {t("manual.lines.current", { line: current.short_name || current.id, name: current.long_name || (Array.isArray(current.termini) ? current.termini.filter(Boolean).join(" ↔ ") : "") })}
          </Typography>
          {serviceOf(current) && (
            <Typography sx={{ fontSize: "0.72rem", color: "text.secondary" }}>
              {t("manual.lines.service", { trips: serviceOf(current).trips ?? "—", first: serviceOf(current).first || "—", last: serviceOf(current).last || "—", vehicles: serviceOf(current).vehicles ?? "—" })}
            </Typography>
          )}
          <Box sx={{ display: "flex", alignItems: "center", gap: 1 }}>
            <Typography sx={{ flex: 1, fontSize: "0.72rem", color: "text.secondary" }}>{t("manual.lines.pick")}</Typography>
            <Button size="small" onClick={() => onSelect(null)} data-testid="line-picker-all" sx={{ textTransform: "none", fontWeight: 700, py: 0 }}>
              {t("manual.lines.all")}
            </Button>
          </Box>
        </Box>
      )}
    </Box>
  );
}

export default function ManualSidebar({ job = "create", locked = null, verdict = null, contract = null, offer = null, progress = null, objectives = null, autopilot = null, autopilotIdle = false, tasks = null, action = null, catalogue = null, onPick = null, catalogueLoading = false, disabled = false, documents = null, routes = null, selectedRoute = null, onSelectRoute = null, children = null }) {
  const { t } = useLanguage();
  const theme = useTheme();
  const titleId = useId();
  const modify = job === "modify";
  // The catalogue by hand: folded while the guide shows work (a brief's timetables, the objectives), open otherwise.
  // Read at every render: the guide may fill after the first one (the « inchangé » clauses come with an effect).
  // The autopilot guides once it has work to show; before (the objectives not decided, nothing to build from) the
  // catalogue stays open: by hand, the person starts where they want.
  const guided = Boolean((autopilot && !autopilotIdle) || offer || progress || objectives);
  const [handChoice, setHandChoice] = useState(null); // the person's own choice, once made
  const handOpen = handChoice ?? !guided;
  const setHandOpen = (fn) => setHandChoice((v) => fn(v ?? !guided));
  // A line picked: the operations of one line only (the form opens with it filled in).
  const shown = useMemo(() => (modify && selectedRoute ? (catalogue || []).filter(isLineOperation) : catalogue || []), [modify, selectedRoute, catalogue]);
  return (
    <Box component="aside" aria-labelledby={autopilot ? "autopilot-title" : titleId} data-testid="manual-sidebar" data-job={modify ? "modify" : "create"} sx={{ flex: 1, minHeight: 0, overflowY: "auto", p: 1.5, display: "flex", flexDirection: "column", gap: 1.5, "& > *": { flexShrink: 0 } }}>
      {/* The change built by the journey itself leads the column: what it did, what it decided, what it
          needs; the way to add by hand follows, quietly. */}
      {autopilot ? (
        autopilot
      ) : (
        <Box sx={{ p: 1.25, borderRadius: "12px", background: alpha(theme.palette.primary.main, theme.palette.mode === "dark" ? 0.12 : 0.06), display: "flex", flexDirection: "column", gap: 0.5 }}>
          <Box sx={{ display: "flex", alignItems: "center", gap: 0.75 }}>
            <DrawOutlinedIcon aria-hidden sx={{ fontSize: 18, color: "primary.main" }} />
            <Typography id={titleId} component="h2" sx={{ fontSize: "0.9rem", fontWeight: 800 }}>
              {t("manual.sidebar.title")}
            </Typography>
          </Box>
          <Typography sx={{ fontSize: "0.74rem", color: "text.secondary", lineHeight: 1.5 }}>{t(modify ? "manual.sidebar.intro.modify" : "manual.sidebar.intro.create")}</Typography>
          {action && (
            <Button size="small" variant="contained" disableElevation onClick={action.onClick} disabled={Boolean(action.disabled)} data-testid={action.testid} sx={{ alignSelf: "flex-start", textTransform: "none", fontWeight: 700, borderRadius: 99, px: 1.75, mt: 0.25 }}>
              {action.label}
            </Button>
          )}
        </Box>
      )}
      {!autopilot && locked}
      {offer}
      {progress}
      {verdict}
      {contract && <ContractSummary contract={contract} />}
      {/* The objectives retained at ② (improving a network): the work to do, above the catalogue that does it. */}
      {objectives}
      {tasks && tasks.length > 0 && <TaskList tasks={tasks} />}
      {modify && guided && (
        <Button size="small" variant={handOpen ? "text" : "outlined"} onClick={() => setHandOpen((v) => !v)} aria-expanded={handOpen} data-testid="manual-add-toggle" sx={{ alignSelf: "flex-start", textTransform: "none", fontWeight: 600 }}>
          {handOpen ? t("manual.hand.hide") : t("manual.hand.show")}
        </Button>
      )}
      {modify && handOpen && <LinePicker routes={routes || []} selected={selectedRoute} onSelect={onSelectRoute} disabled={disabled} />}
      {/* Its own scroll: the documents and what follows stay within reach under the catalogue. */}
      {modify && handOpen && <OperationCatalog catalogue={shown} onPick={onPick} disabled={disabled} loading={catalogueLoading} maxHeight="min(380px, 42vh)" />}
      {documents}
      {/* With the journey's own work above, the assistant's lock (said in place, with its reason and its way) is
          the column's last word: what the assistant would add. */}
      {autopilot && locked}
      {children}
    </Box>
  );
}
