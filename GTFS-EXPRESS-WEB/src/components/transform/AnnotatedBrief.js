/**
 * AnnotatedBrief — the brief as the map of the change: the person's own text with, marked in it, each objective's
 * quote — the sentence the extraction verified in the document, coloured by the verdict the engine measured on the
 * change — and each sentence nothing answers (the coverage detector's `uncovered`, in the warning tone). The
 * traceability the engine already holds (verified citations, the coverage detector), shown where the person thinks:
 * in their text.
 *
 * Clicking a marked objective hands it to the host (`onClause(clause)`: the line in focus at ③, the reader on
 * « Après »); an uncovered sentence leads to the objectives (`onUncovered(sentence)`).
 *
 *   brief-annotations        the block: one entry per prose document (`brief-annotations-document`, `data-id`), its
 *                            « Lire annoté » (`brief-annotate`) that fetches the text once
 *   brief-annotated          one document's text, marked (`data-document`)
 *   brief-mark               a mark (`data-kind`: clause | uncovered; `data-clause`; `data-status`: pass | fail |
 *                            unknown | none)
 *   brief-annotated-legend   what the marks mean
 *   brief-annotated-empty    the server reads no text in it (a PDF without a text layer)
 *   brief-annotated-counts   how many objectives and uncovered sentences were found in the text
 */

import React, { useState } from "react";
import { Box, Button, CircularProgress, Typography, alpha, useTheme } from "@mui/material";
import { useLanguage } from "../../contexts/LanguageContext";
import { fetchBriefDocumentText } from "../../utils/networkStudioApi";

// A mark's quote shorter than this is too common a string to be found safely in the text.
const MIN_QUOTE = 12;

/** The text normalised for the search (whitespace collapsed, lower case) with the index of each normalised character in the original. */
const normalised = (text) => {
  const chars = [];
  const map = [];
  let space = true;
  for (let i = 0; i < text.length; i += 1) {
    const c = text[i];
    if (/\s/.test(c)) {
      if (!space) {
        chars.push(" ");
        map.push(i);
        space = true;
      }
    } else {
      chars.push(c.toLowerCase());
      map.push(i);
      space = false;
    }
  }
  return { norm: chars.join(""), map };
};

/** Where a quote stands in the text: its original start and end, or null (the search is whitespace- and case-blind). */
export const findQuote = (text, quote) => {
  if (!text || !quote) return null;
  const q = String(quote).replace(/\s+/g, " ").trim().toLowerCase();
  if (q.length < MIN_QUOTE) return null;
  const { norm, map } = normalised(String(text));
  const at = norm.indexOf(q);
  if (at < 0) return null;
  return { start: map[at], end: map[at + q.length - 1] + 1 };
};

/**
 * The marks of a text, sorted, never overlapping (the first one found keeps its place): the clauses' quotes, each
 * with its measured status (`statusOf(clause)`), then the uncovered sentences.
 */
export const marksOf = (text, { clauses = [], uncovered = [], statusOf = () => "none" } = {}) => {
  const out = [];
  const free = (m) => !out.some((o) => m.start < o.end && o.start < m.end);
  for (const c of clauses) {
    const at = findQuote(text, c?.quote);
    if (at && free(at)) out.push({ ...at, kind: "clause", clause: c, status: statusOf(c) || "none" });
  }
  for (const s of uncovered) {
    const at = findQuote(text, s?.text);
    if (at && free(at)) out.push({ ...at, kind: "uncovered", sentence: s, status: "none" });
  }
  return out.sort((a, b) => a.start - b.start);
};

const TONE = { pass: "success", fail: "error", unknown: "warning" };

export function AnnotatedText({ text, clauses = [], uncovered = [], statusOf = () => "none", documentName = "", onClause = null, onUncovered = null }) {
  const { t } = useLanguage();
  const theme = useTheme();
  const marks = marksOf(text, { clauses, uncovered, statusOf });
  const parts = [];
  let cursor = 0;
  marks.forEach((m, i) => {
    if (m.start > cursor) parts.push(<React.Fragment key={`t${i}`}>{text.slice(cursor, m.start)}</React.Fragment>);
    const tone = m.kind === "uncovered" ? theme.palette.warning : theme.palette[TONE[m.status] || "info"];
    const click = m.kind === "clause" ? () => onClause?.(m.clause) : () => onUncovered?.(m.sentence);
    parts.push(
      <Box
        component="mark"
        key={`m${i}`}
        role={onClause || onUncovered ? "button" : undefined}
        tabIndex={onClause || onUncovered ? 0 : undefined}
        onClick={click}
        onKeyDown={(e) => {
          if (e.key === "Enter" || e.key === " ") {
            e.preventDefault();
            click();
          }
        }}
        title={m.kind === "clause" ? `${m.clause.text || ""}${m.status !== "none" ? ` — ${t(`brief.annotated.status.${m.status}`)}` : ""}` : t("brief.annotated.uncovered.title")}
        data-testid="brief-mark"
        data-kind={m.kind}
        data-clause={m.kind === "clause" ? m.clause.id : undefined}
        data-status={m.status}
        sx={{ backgroundColor: alpha(tone.main, m.kind === "uncovered" ? 0.28 : 0.18), color: "inherit", borderBottom: `2px solid ${tone.main}`, borderRadius: "3px", px: "1px", cursor: onClause || onUncovered ? "pointer" : "default", "&:hover": { backgroundColor: alpha(tone.main, 0.35) }, "&:focus-visible": { outline: `2px solid ${theme.palette.primary.main}`, outlineOffset: 1 } }}
      >
        {text.slice(m.start, m.end)}
      </Box>,
    );
    cursor = m.end;
  });
  if (cursor < text.length) parts.push(<React.Fragment key="tail">{text.slice(cursor)}</React.Fragment>);
  const counts = { clauses: marks.filter((m) => m.kind === "clause").length, uncovered: marks.filter((m) => m.kind === "uncovered").length };
  return (
    <Box data-testid="brief-annotated" data-document={documentName} sx={{ display: "flex", flexDirection: "column", gap: 0.75 }}>
      <Typography data-testid="brief-annotated-counts" sx={{ fontSize: "0.74rem", color: "text.secondary" }}>
        {t("brief.annotated.counts", { clauses: counts.clauses, uncovered: counts.uncovered })}
      </Typography>
      <Typography component="pre" data-testid="brief-annotated-text" sx={{ m: 0, p: 1.25, borderRadius: "10px", border: `1px solid ${theme.palette.divider}`, background: theme.palette.background.paper, fontFamily: "inherit", fontSize: "0.8rem", lineHeight: 1.6, whiteSpace: "pre-wrap", overflowWrap: "anywhere", maxHeight: 420, overflowY: "auto" }}>
        {parts}
      </Typography>
      <Typography data-testid="brief-annotated-legend" sx={{ fontSize: "0.7rem", color: "text.secondary", lineHeight: 1.5 }}>
        {t("brief.annotated.legend")}
      </Typography>
    </Box>
  );
}

/** The prose documents of the brief, each with its « Lire annoté » that fetches its text once and marks it. */
export default function AnnotatedBrief({ documents = [], clauses = [], uncovered = [], statusOf = () => "none", onClause = null, onUncovered = null }) {
  const { t } = useLanguage();
  const [texts, setTexts] = useState({}); // id → { state: loading | done | error, text, error }
  if (!documents.length) return null;
  const read = async (d) => {
    setTexts((x) => ({ ...x, [d.id]: { state: "loading" } }));
    try {
      const out = await fetchBriefDocumentText(d.id);
      setTexts((x) => ({ ...x, [d.id]: { state: "done", text: out?.text || "" } }));
    } catch (err) {
      setTexts((x) => ({ ...x, [d.id]: { state: "error", error: err?.message || String(err) } }));
    }
  };
  // A clause of this document (named by the extraction), or of no document in particular (an older record).
  const own = (d) => clauses.filter((c) => !c?.document || c.document === d.name);
  const ownUncovered = (d) => uncovered.filter((s) => !s?.document || s.document === d.name);
  return (
    <Box data-testid="brief-annotations" sx={{ display: "flex", flexDirection: "column", gap: 1 }}>
      {documents.map((d) => {
        const held = texts[d.id] || null;
        return (
          <Box key={d.id} data-testid="brief-annotations-document" data-id={d.id} data-state={held?.state || "idle"} sx={{ display: "flex", flexDirection: "column", gap: 0.5 }}>
            <Box sx={{ display: "flex", alignItems: "center", gap: 1 }}>
              <Typography sx={{ flex: 1, minWidth: 0, fontSize: "0.78rem", fontWeight: 700 }} noWrap>
                {d.name}
              </Typography>
              {held?.state !== "done" && (
                <Button size="small" onClick={() => read(d)} disabled={held?.state === "loading"} startIcon={held?.state === "loading" ? <CircularProgress size={12} /> : null} data-testid="brief-annotate" sx={{ textTransform: "none", fontWeight: 700 }}>
                  {t("brief.annotated.read")}
                </Button>
              )}
            </Box>
            {held?.state === "error" && (
              <Typography data-testid="brief-annotated-error" sx={{ fontSize: "0.74rem", color: "error.main" }}>
                {held.error}
              </Typography>
            )}
            {held?.state === "done" && !held.text && (
              <Typography data-testid="brief-annotated-empty" sx={{ fontSize: "0.74rem", color: "text.secondary" }}>
                {t("brief.annotated.empty")}
              </Typography>
            )}
            {held?.state === "done" && held.text && <AnnotatedText text={held.text} clauses={own(d)} uncovered={ownUncovered(d)} statusOf={statusOf} documentName={d.name} onClause={onClause} onUncovered={onUncovered} />}
          </Box>
        );
      })}
    </Box>
  );
}
