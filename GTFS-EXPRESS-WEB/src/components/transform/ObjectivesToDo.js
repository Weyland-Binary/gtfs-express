/**
 * ObjectivesToDo — at ③ of a project improving its network, the objectives
 * retained at ② (`context.objectives`, the recommendations' snapshots) as
 * the work to do by hand: each one with the catalogue operation that
 * carries it out, opened filled in (the person checks it and saves it; the
 * engine simulates and measures it like any other).
 *
 *   frequency     set_headway on the line, the window and the target headway
 *   span          set_span on the line, the first or the last departure
 *   weekend       copy_day_service from the weekday to that day, added
 *   reallocation  the optimiser's operations, loaded at once into the plan
 *   coverage, connection   no single operation does it (a route to draw, a
 *                 timetable to align): said, with the operations to look at
 *
 * `onOpen(draft)` opens the operation form; `onLoad(operations)` adds the
 * optimiser's operations to the plan. An objective whose clauses the plan's
 * simulation already meets is shown done (`met`).
 */

import React from "react";
import { Box, Button, Typography } from "@mui/material";
import { useTheme } from "@mui/material/styles";
import CheckCircleRoundedIcon from "@mui/icons-material/CheckCircleRounded";
import RadioButtonUncheckedIcon from "@mui/icons-material/RadioButtonUnchecked";
import { useLanguage } from "../../contexts/LanguageContext";
import { tokensOf } from "../studio/studioTheme";
import { recommendationTitle } from "../steps/StepObjectives";

const windowOf = (w) => {
  const m = /^(\d{2}:\d{2})\s*[-–]\s*(\d{2}:\d{2})$/.exec(String(w || ""));
  return m ? { from: m[1], to: m[2] } : { from: "07:00", to: "09:00" };
};

/**
 * The catalogue operation that carries out an objective, or null when none does it alone. The line is named as
 * its clause names it (the server picked a reference the feed resolves to that line alone: a short name shared
 * by two lines falls back on the id), else by its label.
 */
export const draftOf = (o) => {
  const route = o.clauses?.find((c) => c?.params?.line)?.params.line || o.line?.label || o.line?.id || null;
  const f = o.facts || {};
  if (o.kind === "frequency" && route && Number.isFinite(Number(f.headway_target))) return { type: "set_headway", params: { route, days: "weekday", ...windowOf(f.window), headway_min: Number(f.headway_target) } };
  if (o.kind === "span" && route && (f.last_target || f.first_target)) return { type: "set_span", params: { route, days: "weekday", ...(f.first_target ? { first: f.first_target } : {}), ...(f.last_target ? { last: f.last_target } : {}) } };
  if (o.kind === "weekend" && route && f.day) return { type: "copy_day_service", params: { routes: [route], from_day: "weekday", to_days: f.day, mode: "add" } };
  return null;
};

export default function ObjectivesToDo({ objectives = [], met = [], onOpen = null, onLoad = null, disabled = false }) {
  const { t, language } = useLanguage();
  const theme = useTheme();
  const k = tokensOf(theme);
  if (!objectives.length) return null;
  return (
    <Box component="section" aria-label={t("objectives.todo.title")} data-testid="objectives-todo" sx={{ display: "flex", flexDirection: "column", gap: 0.75 }}>
      <Typography component="h2" sx={{ fontSize: "0.7rem", fontWeight: 600, letterSpacing: "0.04em", textTransform: "uppercase", color: k.ink3 }}>
        {t("objectives.todo.title")}
      </Typography>
      <Box component="ol" sx={{ listStyle: "none", m: 0, p: 0, display: "flex", flexDirection: "column", gap: 0.75 }}>
        {objectives.map((o) => {
          const done = met.includes(o.id);
          const draft = draftOf(o);
          const ops = o.kind === "reallocation" && Array.isArray(o.operations) ? o.operations : [];
          return (
            <Box component="li" key={o.id} data-testid="objective-todo" data-kind={o.kind} data-done={done ? "true" : "false"} sx={{ display: "flex", gap: 1, p: 1, borderRadius: "10px", border: `1px solid ${k.line}`, backgroundColor: done ? k.successSoft : k.surface }}>
              {done ? <CheckCircleRoundedIcon aria-hidden sx={{ fontSize: 18, color: k.success, mt: 0.1 }} /> : <RadioButtonUncheckedIcon aria-hidden sx={{ fontSize: 18, color: k.ink3, mt: 0.1 }} />}
              <Box sx={{ flex: 1, minWidth: 0, display: "flex", flexDirection: "column", gap: 0.5 }}>
                <Typography sx={{ fontSize: "0.8rem", fontWeight: 600, color: k.ink, lineHeight: 1.35 }}>{recommendationTitle(o, t, language)}</Typography>
                {!done && draft && onOpen && (
                  <Button size="small" variant="outlined" onClick={() => onOpen(draft)} disabled={disabled} data-testid="objective-todo-open" sx={{ alignSelf: "flex-start" }}>
                    {t("objectives.todo.open")}
                  </Button>
                )}
                {!done && o.kind === "weekend" && draft && onOpen && <Typography sx={{ fontSize: "0.72rem", color: k.ink2, lineHeight: 1.45 }}>{t("objectives.todo.note.weekend", { op: `« ${t("transform.op.set_headway")} »` })}</Typography>}
                {!done && ops.length > 0 && onLoad && (
                  <Button size="small" variant="outlined" onClick={() => onLoad(ops)} disabled={disabled} data-testid="objective-todo-load" sx={{ alignSelf: "flex-start" }}>
                    {t("objectives.todo.load", { count: ops.length })}
                  </Button>
                )}
                {!done && !draft && !ops.length && <Typography sx={{ fontSize: "0.72rem", color: k.ink2, lineHeight: 1.45 }}>{o.kind === "connection" ? t("objectives.todo.hint.connection", { ops: `« ${t("transform.op.align_connections")} »` }) : t("objectives.todo.hint.coverage", { ops: ["extend_route", "reroute", "add_stop"].map((op) => `« ${t(`transform.op.${op}`)} »`).join(", ") })}</Typography>}
              </Box>
            </Box>
          );
        })}
      </Box>
    </Box>
  );
}
