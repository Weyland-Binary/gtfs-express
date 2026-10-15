/**
 * ObjectivesProgress — at ③ Changement without the assistant, where the
 * change stands against the objectives decided at ②, said in plain words: how many the simulation meets, misses, or cannot
 * measure yet, the ones it misses first (what to work on), the ones it
 * cannot measure folded. The engine's own explanation of a clause it could
 * not measure is its tooltip, never the text: it is the engine's, in its
 * terms.
 *
 *   objectives-progress          the block (`data-pass`, `data-fail`, `data-unknown`: the objectives')
 *   objectives-progress-fail     one per objective the simulation misses: its words and what was measured
 *   objectives-progress-unknown  the ones not measurable yet, folded under their count
 *   objectives-progress-desired / objectives-progress-guarantees
 *                                the desired clauses and the two default guarantees, one line each
 *   objectives-progress-focus    on a row whose objective names one line (`lineOf`: utils/changeStates
 *                                .routeOfClause), « Voir sur la carte »: that line in focus on the change's map
 *                                (`onFocusLine`) — what the objective asks, beside what the change draws
 *
 * Before any simulation it says that each objective will be measured there.
 * The results are the server's (preview.conformance.after.results): nothing
 * is computed here. The objectives are the person's mandatory clauses,
 * counted as the autopilot's panel, the recap and the verdict count them
 * (utils/objectiveCounts: « 55 objectifs » there, never 57 here); their
 * desired clauses and the two default guarantees are said apart — never
 * among the objectives, not even when the contract holds nothing else (one
 * count everywhere).
 */

import React, { useState } from "react";
import { Box, Button, Typography } from "@mui/material";
import { useTheme } from "@mui/material/styles";
import CheckCircleRoundedIcon from "@mui/icons-material/CheckCircleRounded";
import CancelRoundedIcon from "@mui/icons-material/CancelRounded";
import HelpOutlineRoundedIcon from "@mui/icons-material/HelpOutlineRounded";
import { useLanguage } from "../../contexts/LanguageContext";
import { tokensOf } from "../studio/studioTheme";
import { guaranteesSaid, objectiveCounts, objectiveResults } from "../../utils/objectiveCounts";

// `lineOf(id)` → { id, label } | null: the line an objective names; `onFocusLine(routeId)`, `focus`: the map's focus.
export default function ObjectivesProgress({ results = null, count = 0, previewing = false, onOpen = null, lineOf = null, onFocusLine = null, focus = null }) {
  const { t } = useLanguage();
  const k = tokensOf(useTheme());
  const [unknownOpen, setUnknownOpen] = useState(false);
  // An objective the person set aside (waived) is no objective of the change any more: neither met nor missed. The
  // desired clauses and the default guarantees are said apart, as the panel says them (objectiveCounts).
  const lists = objectiveResults(results);
  const counts = objectiveCounts(results);
  const items = lists ? lists.objectives : null;
  const pass = items ? items.filter((r) => r.status === "pass") : [];
  const fail = items ? items.filter((r) => r.status === "fail") : [];
  const unknown = items ? items.filter((r) => r.status !== "pass" && r.status !== "fail") : [];
  const total = items ? items.length : count;
  const pct = (n) => (total ? `${(n / total) * 100}%` : "0%");
  const d = counts?.desired || null;
  const g = counts?.guarantees || null;
  const held = guaranteesSaid(g);
  // « Voir sur la carte » on a row whose objective names one line.
  const focusButton = (r) => {
    const line = lineOf && onFocusLine ? lineOf(r.id) : null;
    if (!line) return null;
    const on = focus !== null && String(focus) === String(line.id);
    return (
      <Button size="small" onClick={() => onFocusLine(line.id)} aria-pressed={on ? "true" : "false"} data-testid="objectives-progress-focus" data-route={line.id} sx={{ ml: "auto", flexShrink: 0, px: 0.75, minWidth: 0, fontSize: "0.68rem", color: on ? k.accent : k.ink2, textTransform: "none" }}>
        {t("change.objective.focus", { line: line.label })}
      </Button>
    );
  };
  return (
    <Box component="section" aria-labelledby="objectives-progress-title" data-testid="objectives-progress" data-pass={pass.length} data-fail={fail.length} data-unknown={unknown.length} sx={{ display: "flex", flexDirection: "column", gap: 0.75, p: 1.25, borderRadius: "12px", border: `1px solid ${k.line}`, backgroundColor: k.surface }}>
      <Box sx={{ display: "flex", alignItems: "center", gap: 1 }}>
        <Typography id="objectives-progress-title" component="h2" sx={{ flex: 1, fontSize: "0.86rem", fontWeight: 600, color: k.ink }}>
          {t("progress.title", { count: total })}
        </Typography>
        {onOpen && (
          <Button size="small" onClick={onOpen} data-testid="objectives-progress-open" sx={{ fontSize: "0.72rem", color: k.ink2, minWidth: 0 }}>
            {t("progress.open")}
          </Button>
        )}
      </Box>
      {!items ? (
        // No objective of the person's own (the contract holds the guarantees, or desired clauses only): its clauses
        // are measured all the same, never « 0 objectifs » to measure.
        <Typography sx={{ fontSize: "0.76rem", color: k.ink2, lineHeight: 1.5 }}>{t(previewing ? "progress.measuring" : total ? "progress.notYet" : "progress.notYet.clauses", { count: total })}</Typography>
      ) : (
        <>
          {/* No objective of the person's own: no bar of nothing — the lines below say what was measured. */}
          {total > 0 && (
            <Box aria-hidden sx={{ display: "flex", height: 6, borderRadius: 99, overflow: "hidden", backgroundColor: k.hover }}>
              <Box sx={{ width: pct(pass.length), backgroundColor: k.success }} />
              <Box sx={{ width: pct(fail.length), backgroundColor: k.error }} />
            </Box>
          )}
          {total > 0 && (
            <Typography data-testid="objectives-progress-counts" sx={{ fontSize: "0.76rem", color: k.ink2 }}>
              {t("progress.counts", { pass: pass.length, fail: fail.length, unknown: unknown.length })}
            </Typography>
          )}
          {fail.length > 0 && (
            <Box component="ul" sx={{ listStyle: "none", m: 0, p: 0, display: "flex", flexDirection: "column", gap: 0.5 }}>
              {fail.map((r) => (
                // What the engine measured is its own sentence (its terms, its language): the row's tooltip, not its text.
                <Box component="li" key={r.id} data-testid="objectives-progress-fail" data-clause={r.id} title={r.measured != null && r.measured !== "" ? t("progress.measured", { value: r.measured }) : undefined} sx={{ display: "flex", gap: 0.75, alignItems: "flex-start" }}>
                  <CancelRoundedIcon aria-hidden sx={{ fontSize: 16, color: k.error, mt: "2px", flexShrink: 0 }} />
                  <Typography sx={{ minWidth: 0, fontSize: "0.78rem", color: k.ink, lineHeight: 1.4 }}>{r.text || r.id}</Typography>
                  {focusButton(r)}
                </Box>
              ))}
            </Box>
          )}
          {pass.length > 0 && fail.length === 0 && unknown.length === 0 && (
            <Typography sx={{ display: "flex", alignItems: "center", gap: 0.5, fontSize: "0.76rem", color: k.success }}>
              <CheckCircleRoundedIcon aria-hidden sx={{ fontSize: 16 }} />
              {t("progress.allMet")}
            </Typography>
          )}
          {unknown.length > 0 && (
            <Box>
              <Button size="small" onClick={() => setUnknownOpen((v) => !v)} aria-expanded={unknownOpen} data-testid="objectives-progress-unknown-toggle" sx={{ ml: -0.75, px: 0.75, minWidth: 0, fontSize: "0.72rem", color: k.ink2 }}>
                {t(unknownOpen ? "progress.unknown.hide" : "progress.unknown.show", { count: unknown.length })}
              </Button>
              {unknownOpen && (
                <Box component="ul" sx={{ listStyle: "none", m: 0, p: 0, display: "flex", flexDirection: "column", gap: 0.5 }}>
                  {unknown.map((r) => (
                    <Box component="li" key={r.id} data-testid="objectives-progress-unknown" data-clause={r.id} title={r.note || undefined} sx={{ display: "flex", gap: 0.75, alignItems: "flex-start" }}>
                      <HelpOutlineRoundedIcon aria-hidden sx={{ fontSize: 16, color: k.ink3, mt: "2px", flexShrink: 0 }} />
                      <Typography sx={{ fontSize: "0.76rem", color: k.ink2, lineHeight: 1.4 }}>{r.text || r.id}</Typography>
                      {focusButton(r)}
                    </Box>
                  ))}
                </Box>
              )}
            </Box>
          )}
          {/* The desired clauses and the default guarantees, apart — the panel's own lines (held, only the guarantees
              measured are named). */}
          {d && (
            <Typography data-testid="objectives-progress-desired" sx={{ fontSize: "0.76rem", color: k.ink2, lineHeight: 1.45 }}>
              {t("autopilot.line.desired", { pass: d.pass, total: d.total })}
              {d.fail > 0 ? ` · ${t("autopilot.line.desired.fail", { count: d.fail })}` : ""}
              {d.unknown > 0 ? ` · ${t("autopilot.line.objectives.unknown", { count: d.unknown })}` : ""}
            </Typography>
          )}
          {g && (
            <Typography data-testid="objectives-progress-guarantees" sx={{ fontSize: "0.76rem", color: g.fail ? k.error : k.ink2, lineHeight: 1.45 }}>
              {t(held.key, held.params)}
            </Typography>
          )}
        </>
      )}
    </Box>
  );
}
