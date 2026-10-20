/**
 * ManualSidebar — the Network Studio's left column of ③ without the assistant.
 *
 * Without the assistant (the server's chat off, or no Studio access on this
 * account) the journey is the same five steps — the same verdict, the same
 * acknowledgement, the same validator, the same delivery — and only the
 * engine of ③ changes: the person draws by hand what the assistant would
 * have proposed. The column where the conversation would be says so once
 * — with, when the account lacks the Studio, the lock in place (`locked`:
 * LockedAction, its reason and its action) — then holds what the work
 * by hand needs, never a disabled composer:
 *
 *   the verdict      the engine's, re-measured on each edit or simulation
 *                    (the host passes its VerdictCard: never computed here)
 *   the contract     its state in words (decided · assumed · empty · not yet
 *                    decided) and its clauses' count, with the way to ②
 *   the tasks        the design's sub-tasks, a vertical list in the order a
 *                    network is drawn — the network's settings (the three
 *                    fields GTFS requires), the stops (placed or not), the
 *                    lines, the points to fix — each with its state in text
 *                    (à faire · en cours · fait, never a colour alone) and one
 *                    click to where it is done; « Ouvrir l'éditeur de lignes »
 *                    (`plan-manual-start`); the list « Ce qu'il nous faut de
 *                    vous » and the territory as the host gives them
 *
 * `designTasksOf` is pure, exported for tests and for the host.
 */

import React, { useId } from "react";
import { Box, Button, ButtonBase, Typography, alpha, useTheme } from "@mui/material";
import CheckCircleOutlineIcon from "@mui/icons-material/CheckCircleOutline";
import RadioButtonUncheckedIcon from "@mui/icons-material/RadioButtonUnchecked";
import TimelapseIcon from "@mui/icons-material/Timelapse";
import DrawOutlinedIcon from "@mui/icons-material/DrawOutlined";
import GavelOutlinedIcon from "@mui/icons-material/GavelOutlined";
import { useLanguage } from "../../contexts/LanguageContext";
import { soft } from "../network/StudioUI";

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

export default function ManualSidebar({ locked = null, verdict = null, contract = null, tasks = null, action = null, documents = null, children = null }) {
  const { t } = useLanguage();
  const theme = useTheme();
  const titleId = useId();
  return (
    <Box component="aside" aria-labelledby={titleId} data-testid="manual-sidebar" sx={{ flex: 1, minHeight: 0, overflowY: "auto", p: 1.5, display: "flex", flexDirection: "column", gap: 1.5, "& > *": { flexShrink: 0 } }}>
      <Box sx={{ p: 1.25, borderRadius: "12px", background: alpha(theme.palette.primary.main, theme.palette.mode === "dark" ? 0.12 : 0.06), display: "flex", flexDirection: "column", gap: 0.5 }}>
        <Box sx={{ display: "flex", alignItems: "center", gap: 0.75 }}>
          <DrawOutlinedIcon aria-hidden sx={{ fontSize: 18, color: "primary.main" }} />
          <Typography id={titleId} component="h2" sx={{ fontSize: "0.9rem", fontWeight: 800 }}>
            {t("manual.sidebar.title")}
          </Typography>
        </Box>
        <Typography sx={{ fontSize: "0.74rem", color: "text.secondary", lineHeight: 1.5 }}>{t("manual.sidebar.intro.create")}</Typography>
        {action && (
          <Button size="small" variant="contained" disableElevation onClick={action.onClick} disabled={Boolean(action.disabled)} data-testid={action.testid} sx={{ alignSelf: "flex-start", textTransform: "none", fontWeight: 700, borderRadius: 99, px: 1.75, mt: 0.25 }}>
            {action.label}
          </Button>
        )}
      </Box>
      {locked}
      {verdict}
      {contract && <ContractSummary contract={contract} />}
      {tasks && tasks.length > 0 && <TaskList tasks={tasks} />}
      {documents}
      {children}
    </Box>
  );
}
