/**
 * ReadingDrafts — the brief read twice and the two readings differing on the network (transform/planAgreement, the
 * planner's `readings` event): the two readings shown as two drafts, what each DOES (owner's UX lot 2, 2026-10-11:
 * « on demande de choisir entre deux textes alors que le produit a deux résultats »). Reading A is the plan as it
 * stands (its simulation's semantic diff, the preview's), reading B the alternative plan (its diff handed over by
 * the event, `alternativeDiff`); the lines where they diverge are listed per reading, in tabs, each change in the
 * reader's words (ChangePlanParts.describeItem, the sentences ④ reads), and each divergence is said once per
 * reading (`items`, the server's sentences). « Garder la lecture A | B » answers the first reading question still
 * open — the same act as the question's chips, made on what is seen.
 *
 *   reading-drafts             the block (`data-answered`: the letter kept, once chosen)
 *   reading-drafts-tab         « Lecture A » | « Lecture B » (`data-letter`, aria-selected)
 *   reading-drafts-lines       the lines of the reading shown (`data-letter`)
 *   reading-drafts-line        one line (`data-route`), its changes (`reading-drafts-item`) or « ne change rien »
 *   reading-drafts-divergence  one divergence: the line, what A does, what B does
 *   reading-drafts-choose      « Garder la lecture A » | « … B » (`data-letter`)
 */

import React, { useState } from "react";
import { Box, Button, Typography, alpha, useTheme } from "@mui/material";
import { useLanguage } from "../../contexts/LanguageContext";
import { describeItem } from "./ChangePlanParts";
import { reviewOf } from "./ChangeReview";

// As many lines, and changes per line, as a draft shows here (the reader shows the rest).
const MAX_LINES = 12;
const MAX_ITEMS = 8;

/** The lines of a diff restricted to the ones the divergences name (all of them when none is named), bounded. */
export const draftLinesOf = (diff, named) => {
  const { lines } = reviewOf({ diff: diff || { items: [] } });
  const wanted = new Set((named || []).filter(Boolean).map(String));
  const kept = wanted.size ? lines.filter((l) => wanted.has(String(l.label)) || (l.route && wanted.has(String(l.route)))) : lines;
  return kept.slice(0, MAX_LINES).map((l) => ({ ...l, items: l.items.slice(0, MAX_ITEMS), more: Math.max(0, l.items.length - MAX_ITEMS) }));
};

export default function ReadingDrafts({ preview = null, readings = null, answered = null, disabled = false, onChoose = null }) {
  const { t, language } = useLanguage();
  const theme = useTheme();
  const [letter, setLetter] = useState("A");
  const items = Array.isArray(readings?.items) ? readings.items : [];
  const named = items.map((d) => d.line).filter(Boolean);
  const drafts = { A: draftLinesOf(preview?.diff || null, named), B: draftLinesOf(readings?.alternativeDiff || null, named) };
  // The lines named by the divergences that a reading leaves untouched: said as such, never a blank.
  const untouched = named.filter((line) => !drafts[letter].some((l) => String(l.label) === String(line) || String(l.route) === String(line)));
  const tab = (x) => (
    <Button key={x} role="tab" aria-selected={letter === x} size="small" variant={letter === x ? "contained" : "outlined"} disableElevation onClick={() => setLetter(x)} data-testid="reading-drafts-tab" data-letter={x} sx={{ textTransform: "none", fontWeight: 700, borderRadius: 99, px: 1.5, minWidth: 0 }}>
      {t("planner.reading.tab", { letter: x })}
    </Button>
  );
  return (
    <Box component="section" aria-label={t("planner.reading.drafts.title")} data-testid="reading-drafts" data-answered={answered || undefined} sx={{ p: 1, borderRadius: "10px", border: `1px solid ${alpha(theme.palette.warning.main, 0.5)}`, background: alpha(theme.palette.warning.main, 0.05), display: "flex", flexDirection: "column", gap: 0.75 }}>
      <Typography component="h3" sx={{ fontSize: "0.8rem", fontWeight: 700, lineHeight: 1.4 }}>
        {t("planner.reading.drafts.title")}
      </Typography>
      <Typography sx={{ fontSize: "0.72rem", color: "text.secondary", lineHeight: 1.5 }}>{t("planner.reading.drafts.hint")}</Typography>
      <Box role="tablist" sx={{ display: "flex", gap: 0.5 }}>
        {tab("A")}
        {tab("B")}
      </Box>
      <Box component="ul" role="tabpanel" data-testid="reading-drafts-lines" data-letter={letter} sx={{ listStyle: "none", m: 0, p: 0, display: "flex", flexDirection: "column", gap: 0.5 }}>
        {drafts[letter].map((l) => (
          <Box component="li" key={l.route || l.label} data-testid="reading-drafts-line" data-route={l.route || l.label} sx={{ p: 0.75, borderRadius: "8px", background: theme.palette.background.paper, boxShadow: `0 0 0 1px ${theme.palette.divider}` }}>
            <Typography sx={{ fontSize: "0.76rem", fontWeight: 700 }}>{t("planner.reading.line", { line: l.label })}</Typography>
            <Box component="ul" sx={{ m: 0, pl: 2, display: "flex", flexDirection: "column", gap: 0.15 }}>
              {l.items.map((it, k) => (
                <Typography component="li" key={k} data-testid="reading-drafts-item" sx={{ fontSize: "0.74rem", lineHeight: 1.45 }}>
                  {describeItem(t, it, language)}
                </Typography>
              ))}
              {l.more > 0 && <Typography component="li" sx={{ fontSize: "0.72rem", color: "text.secondary" }}>{t("planner.reading.more", { count: l.more })}</Typography>}
            </Box>
          </Box>
        ))}
        {untouched.map((line) => (
          <Box component="li" key={`untouched:${line}`} data-testid="reading-drafts-line" data-route={line} data-untouched="true" sx={{ p: 0.75, borderRadius: "8px", background: theme.palette.background.paper, boxShadow: `0 0 0 1px ${theme.palette.divider}` }}>
            <Typography sx={{ fontSize: "0.76rem", fontWeight: 700 }}>{t("planner.reading.line", { line })}</Typography>
            <Typography sx={{ fontSize: "0.74rem", color: "text.secondary" }}>{t("planner.reading.untouched")}</Typography>
          </Box>
        ))}
        {!drafts[letter].length && !untouched.length && (
          <Typography component="li" sx={{ fontSize: "0.74rem", color: "text.secondary" }}>
            {t("planner.reading.untouched")}
          </Typography>
        )}
      </Box>
      {items.length > 0 && (
        <Box component="ul" sx={{ listStyle: "none", m: 0, p: 0, display: "flex", flexDirection: "column", gap: 0.25 }}>
          {items.map((d) => (
            <Typography component="li" key={d.key} data-testid="reading-drafts-divergence" sx={{ fontSize: "0.72rem", color: "text.secondary", lineHeight: 1.45 }}>
              {t("planner.reading.divergence", { line: d.line || "—", a: d.a || t("planner.reading.none"), b: d.b || t("planner.reading.none") })}
            </Typography>
          ))}
        </Box>
      )}
      {answered ? (
        <Typography data-testid="reading-drafts-kept" sx={{ fontSize: "0.74rem", fontWeight: 600, color: "success.main" }}>
          {t("planner.reading.kept", { letter: answered })}
        </Typography>
      ) : (
        <Box sx={{ display: "flex", gap: 0.75, flexWrap: "wrap" }}>
          {["A", "B"].map((x) => (
            <Button key={x} size="small" variant={letter === x ? "contained" : "outlined"} disableElevation disabled={disabled || !onChoose} onClick={() => onChoose?.(x)} data-testid="reading-drafts-choose" data-letter={x} sx={{ textTransform: "none", fontWeight: 700 }}>
              {t("planner.reading.choose", { letter: x })}
            </Button>
          ))}
        </Box>
      )}
    </Box>
  );
}
