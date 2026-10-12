/**
 * ObjectivesList — « Vos objectifs » at ② of a modify project, said simply
 * (Lot H, 2026-10-05): the contract as the list of what the change must
 * achieve, one sentence each, grouped by where it comes from, with only the
 * acts a person needs there. The whole contract (ContractPanel: Essentiel /
 * Expert, the assumptions, the waivers' reasons) stays one click away,
 * « Vue détaillée » (`onDetailed`).
 *
 *   objectives-pending-all  how many objectives are proposed and not decided:
 *                        the step's way on keeps them all under the person's
 *                        name (2026-10-05: one act) — set aside or correct the
 *                        ones that do not fit first; « Tout retenir maintenant »
 *                        (objectives-retain-everything) keeps them at once
 *                        without leaving the page
 *   objectives-group     one per source: a document of the brief (its name:
 *                        the clauses it states, extracted or read from its
 *                        cells), the measured suggestions, the person's own;
 *                        « Tout retenir » when several of its objectives wait;
 *                        past GROUP_FOLD rows, its first ones and « Voir les N »
 *   objective            one per clause (the two « inchangé » clauses kept by
 *                        default are the guarantees line below): its words
 *                        (clauseLabel), its quote, the engine's measure once a
 *                        simulation ran;
 *     to decide          « Retenir » / « Écarter » (decideClause)
 *     kept               « Modifier » (ClauseForm, a correction) and « Retirer »
 *                        (a suggestion: all its clauses; the person's own:
 *                        removed; what a document states: written off, as a
 *                        waiver)
 *     written off        struck, with « Rétablir » (undecideClause)
 *   objectives-reading   the assistant reading the documents of the brief
 *                        (started by itself once they are all there,
 *                        ChangeStudio), said while it runs
 *   objectives-disputes  a spreadsheet's objective the assistant reads
 *                        otherwise than the cell reader (the reading checks
 *                        them against their cells, or states the same point
 *                        with another value: utils/contract openDisputes) —
 *                        one question each, both readings side by side,
 *                        « Retenir la lecture de l'assistant » or « Garder la
 *                        lecture sans assistant » under the person's
 *                        name; neither is in its group nor kept by any « Tout
 *                        retenir » while it is open (the step's way on waits)
 *   objectives-left-out  the documents a reading was given and could not
 *                        read (too long together for one message, or gone
 *                        from the server), named — « Lire ces documents »
 *                        reads them on their own (`extract.onReadLeftOut`)
 *   objectives-read-brief  a brief joined (a prose document, or a text handed
 *                        over) and not read yet: « Lire le cahier des charges »
 *                        (the assistant's extraction — 1 message, said); the
 *                        assistant closed on this account (`assistantLock`):
 *                        the same, locked, with its reason and its way
 *                        (LockedAction: « Se connecter », the offer)
 *   objectives-sheets    a spreadsheet joined that was not read cell by cell
 *                        (joined before this reading existed, or in another
 *                        browser): « Lire le tableur » asks for the file again
 *                        (`onReadSheet`; the server never keeps its bytes)
 *   objectives-uncovered the requirement sentences of the brief no objective
 *                        answers (G5, the server's detector): the step's way on
 *                        keeps them « à vérifier à la main » under the person's
 *                        name, said in one line; the sentences themselves are
 *                        folded past UNCOVERED_PEEK (objectives-uncovered-toggle)
 *                        — each in plain words, a table row as its cells — with
 *                        « Proposer les objectifs avec l'assistant »
 *                        (`onPropose`), « À vérifier à la main », « Écarter »
 *                        (dismissed by name) and « Écrire moi-même » (ClauseForm
 *                        in its simple mode, quoting it); a document nobody
 *                        could read is acknowledged in the detailed view
 *   objectives-reading-sheets  a spreadsheet of the brief being read cell by cell
 *   objectives-guarantees  « Par défaut, le reste du réseau et le reste de la
 *                        journée restent inchangés » (B2)
 *
 * Nothing is decided anonymously, and nothing waits greyed out for a name:
 * every act goes through `withName(act)`, which runs it under the decider's
 * name — asking it once, at that moment, when the person has not given it.
 */

import React, { useRef, useState } from "react";
import { Box, Button, CircularProgress, IconButton, Menu, MenuItem, Tooltip, Typography } from "@mui/material";
import { useTheme } from "@mui/material/styles";
import AddRoundedIcon from "@mui/icons-material/AddRounded";
import CheckCircleRoundedIcon from "@mui/icons-material/CheckCircleRounded";
import RadioButtonUncheckedRoundedIcon from "@mui/icons-material/RadioButtonUncheckedRounded";
import RemoveCircleOutlineRoundedIcon from "@mui/icons-material/RemoveCircleOutlineRounded";
import MoreHorizRoundedIcon from "@mui/icons-material/MoreHorizRounded";
import AutoAwesomeOutlinedIcon from "@mui/icons-material/AutoAwesomeOutlined";
import ShieldOutlinedIcon from "@mui/icons-material/ShieldOutlined";
import TableChartOutlinedIcon from "@mui/icons-material/TableChartOutlined";
import DescriptionOutlinedIcon from "@mui/icons-material/DescriptionOutlined";
import AutoGraphRoundedIcon from "@mui/icons-material/AutoGraphRounded";
import EditNoteRoundedIcon from "@mui/icons-material/EditNoteRounded";
import HelpOutlineRoundedIcon from "@mui/icons-material/HelpOutlineRounded";
import CompareArrowsRoundedIcon from "@mui/icons-material/CompareArrowsRounded";
import ReportGmailerrorredRoundedIcon from "@mui/icons-material/ReportGmailerrorredRounded";
import { useLanguage } from "../../contexts/LanguageContext";
import { decideClause, decisionOf, dismissSentence, fromSheet, isDecided, markNotMeasurable, openDisputes, settleDispute, undecideClause } from "../../utils/contract";
import { withoutRecommendation } from "../../utils/recommendationsApi";
import { OFFER_ACCEPT } from "../../utils/spreadsheetApi";
import { clauseLabel } from "../network/BriefChecklist";
import ClauseForm from "../common/ClauseForm";
import ErrorNotice from "../common/ErrorNotice";
import LockedAction from "../common/LockedAction";
import { tokensOf } from "../studio/studioTheme";

/**
 * Where an objective comes from, in the reader's words: a measured suggestion, a row of a coherence report (mission
 * step 7), an offer sheet's cells, the brief (its quote), or the person.
 */
const sourceOf = (c) => (c?.source?.kind === "recommendation" ? "suggestion" : c?.origin?.kind === "coherence_row" ? "report" : fromSheet(c) ? "sheet" : c?.quote ? "brief" : String(c?.id || "").startsWith("u") ? "own" : "brief");
// What « Retirer » does: the person's own (written, or taken from a report) goes; what a document states is set aside by name.
const stated = (source) => source === "brief" || source === "sheet";
// The document a clause comes from, when it names one (a sheet's file, an extraction's document).
const documentOf = (c) => c?.document || c?.source?.document || null;
const SPREADSHEET_RE = /\.(xlsx|xlsm|xls|ods|csv)$/i;
// A group past this many objectives shows its first ones and « Voir les N »: a sheet states dozens.
const GROUP_FOLD = 5;
const GROUP_PEEK = 3;
// The sentences no objective answers: the first ones, the rest under « Voir les N » (the way on keeps them all).
const UNCOVERED_PEEK = 2;

/** A sentence of the brief as the reader reads it: a table row (« a | b | c ») as its cells, prose as it is. */
export const cellsOf = (text) => {
  const s = String(text || "");
  if (!/\s\|\s|^\|/.test(s)) return null;
  return s
    .split("|")
    .map((x) => x.trim())
    .filter(Boolean);
};

function SentenceText({ text, k }) {
  const cells = cellsOf(text);
  if (!cells) return <Typography sx={{ fontSize: "0.82rem", color: k.ink, lineHeight: 1.45, overflowWrap: "anywhere" }}>{text}</Typography>;
  return (
    <Box data-testid="objectives-uncovered-cells" sx={{ display: "flex", flexWrap: "wrap", gap: 0.5 }}>
      {cells.map((c, i) => (
        <Box key={`${i}-${c}`} component="span" sx={{ px: 0.75, py: "1px", borderRadius: "6px", backgroundColor: k.subtle, border: `1px solid ${k.lineSoft}`, fontSize: "0.76rem", color: k.ink, fontVariantNumeric: "tabular-nums" }}>
          {c}
        </Box>
      ))}
    </Box>
  );
}

function ObjectiveRow({ clause, verdict, readOnly, onKeep, onWaive, onEdit, onRemove, onRestore, k, t }) {
  const [menu, setMenu] = useState(null);
  const decision = decisionOf(clause);
  const waived = decision === "waive";
  const pending = !isDecided(clause);
  const source = sourceOf(clause);
  const measure = verdict && !waived ? verdict.status : null;
  const Icon = waived ? RemoveCircleOutlineRoundedIcon : pending ? RadioButtonUncheckedRoundedIcon : CheckCircleRoundedIcon;
  const iconColor = waived || pending ? k.ink3 : k.success;
  return (
    <Box component="li" data-testid="objective" data-clause={clause.id} data-source={source} data-state={waived ? "waived" : pending ? "pending" : "kept"} sx={{ display: "flex", gap: 1.25, alignItems: "flex-start", py: 1, borderTop: `1px solid ${k.lineSoft}`, "&:first-of-type": { borderTop: "none" } }}>
      <Icon aria-hidden sx={{ fontSize: 19, mt: "1px", color: iconColor, flexShrink: 0 }} />
      <Box sx={{ flex: 1, minWidth: 0, display: "flex", flexDirection: "column", gap: 0.25 }}>
        <Typography sx={{ fontSize: "0.86rem", fontWeight: 600, color: waived ? k.ink3 : k.ink, lineHeight: 1.4, textDecoration: waived ? "line-through" : "none", overflowWrap: "anywhere" }}>{clauseLabel(clause, t)}</Typography>
        <Typography component="div" sx={{ fontSize: "0.74rem", color: k.ink2, lineHeight: 1.45, display: "flex", flexWrap: "wrap", columnGap: 0.75 }}>
          <span data-testid="objective-source">{t(`objectives.source.${source}`)}</span>
          {stated(source) && clause.quote && (
            <Box component="span" title={clause.quote} sx={{ fontStyle: "italic", minWidth: 0, maxWidth: "100%", overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
              « {clause.quote} »{clause.page ? ` ${t("contract.page", { page: clause.page })}` : ""}
            </Box>
          )}
          {measure && (
            <Box component="span" data-testid="objective-measure" data-status={measure} sx={{ color: measure === "pass" ? k.success : measure === "fail" ? k.error : k.ink3, fontWeight: 500 }}>
              {t(`objectives.measure.${measure === "pass" || measure === "fail" ? measure : "unknown"}`)}
            </Box>
          )}
        </Typography>
      </Box>
      {!readOnly && (
        <Box sx={{ display: "flex", alignItems: "center", gap: 0.5, flexShrink: 0 }}>
          {pending && (
            <>
              <Button size="small" variant="outlined" onClick={onKeep} data-testid="objective-keep" sx={{ minWidth: 0, px: 1.25 }}>
                {t("objectives.keep")}
              </Button>
              <Button size="small" onClick={onWaive} data-testid="objective-waive" sx={{ minWidth: 0, px: 1, color: k.ink2 }}>
                {t("objectives.waive")}
              </Button>
            </>
          )}
          {waived && (
            <Button size="small" onClick={onRestore} data-testid="objective-restore" sx={{ minWidth: 0, px: 1, color: k.ink2 }}>
              {t("objectives.restore")}
            </Button>
          )}
          {!pending && !waived && (
            <>
              <Tooltip title={t("objectives.more")}>
                <IconButton size="small" onClick={(e) => setMenu(e.currentTarget)} aria-label={t("objectives.more")} data-testid="objective-menu" sx={{ color: k.ink2 }}>
                  <MoreHorizRoundedIcon sx={{ fontSize: 18 }} />
                </IconButton>
              </Tooltip>
              <Menu anchorEl={menu} open={Boolean(menu)} onClose={() => setMenu(null)}>
                {source !== "suggestion" && (
                  <MenuItem dense onClick={() => { setMenu(null); onEdit(); }} data-testid="objective-edit">
                    {t("objectives.edit")}
                  </MenuItem>
                )}
                <MenuItem dense onClick={() => { setMenu(null); onRemove(); }} data-testid="objective-remove">
                  {t(source === "suggestion" ? "objectives.removeSuggestion" : stated(source) ? "objectives.waive" : "objectives.remove")}
                </MenuItem>
              </Menu>
            </>
          )}
        </Box>
      )}
    </Box>
  );
}

/** The objectives of one source, under its name, with « Tout retenir » when several wait. */
function Group({ id, icon: Icon, title, clauses, verdicts, readOnly, onRetainAll, row, k, t }) {
  const pending = clauses.filter((c) => !isDecided(c));
  const [open, setOpen] = useState(clauses.length <= GROUP_FOLD);
  const shown = open ? clauses : clauses.slice(0, GROUP_PEEK);
  return (
    <Box component="section" data-testid="objectives-group" data-group={id} aria-label={title} sx={{ display: "flex", flexDirection: "column" }}>
      <Box sx={{ display: "flex", alignItems: "center", gap: 1, py: 0.5 }}>
        <Icon aria-hidden sx={{ fontSize: 17, color: k.ink3 }} />
        <Typography component="h3" title={title} sx={{ flex: 1, minWidth: 0, fontSize: "0.78rem", fontWeight: 600, color: k.ink2, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
          {title}
          <Box component="span" sx={{ fontWeight: 500, color: k.ink3 }}>{` · ${clauses.length}`}</Box>
        </Typography>
        {pending.length > 1 && !readOnly && onRetainAll && (
          <Button size="small" onClick={() => onRetainAll(pending)} data-testid="objectives-retain-all" sx={{ flexShrink: 0 }}>
            {t("objectives.retainAll", { count: pending.length })}
          </Button>
        )}
      </Box>
      <Box component="ol" sx={{ listStyle: "none", m: 0, p: 0, pl: 0.25 }}>
        {shown.map((c) => row(c, verdicts.get(c.id)))}
      </Box>
      {clauses.length > GROUP_FOLD && (
        <Button size="small" onClick={() => setOpen((v) => !v)} aria-expanded={open} data-testid="objectives-group-toggle" sx={{ alignSelf: "flex-start", color: k.ink2, mt: 0.25 }}>
          {open ? t("objectives.group.less") : t("objectives.group.more", { count: clauses.length })}
        </Button>
      )}
    </Box>
  );
}

export default function ObjectivesList({ contract, onChange = null, withName = (act) => act(""), readOnly = false, conformance = null, coverage = null, extract = null, assistantLock = null, onPropose = null, brief = "", hasDocuments = false, sheets = [], readingSheets = [], onReadSheet = null, onDetailed = null }) {
  const { t } = useLanguage();
  const k = tokensOf(useTheme());
  const [form, setForm] = useState(null); // { initial } — a correction —, { sentence, quote } — an objective quoting it —, or {} — a new one
  const [reading, setReading] = useState(null); // the sheet being read again: { name, error? }
  const [uncoveredOpen, setUncoveredOpen] = useState(false);
  const sheetInput = useRef(null);
  const locked = readOnly || !onChange;
  const clauses = contract?.clauses || [];
  // The two default guarantees (« le reste du réseau / de la journée reste inchangé »), known by what they are
  // (params.derive) — kept by default or recorded kept by the one act, they are no objective of a document; one the
  // person set aside or corrected is listed, as their decision.
  const isGuarantee = (c) => Boolean(c?.params?.derive) && (!c.decision || decisionOf(c) === "keep");
  const defaults = clauses.filter(isGuarantee);
  // Two readings of a spreadsheet's cells that disagree: one question each, above the groups — neither listed in its
  // group nor kept by a « Tout retenir » while it is open.
  const disputes = openDisputes(contract);
  const disputed = new Set(disputes.flatMap((d) => [d.assistant.id, d.sheet.id]));
  const shown = clauses.filter((c) => !isGuarantee(c) && !disputed.has(c.id));
  // The documents a reading could not read, still in the brief (ChangeStudio: `extract.leftOut`).
  const leftOut = (extract?.leftOut || []).filter((d) => d && d.id);
  const leftReadable = leftOut.filter((d) => !d.unreadable);
  const leftGone = leftOut.filter((d) => d.unreadable);
  const verdicts = new Map((conformance?.results || []).map((r) => [r.id, r]));
  const uncovered = coverage?.uncovered || [];
  const sentences = uncovered.filter((s) => !s.unread);
  // A workbook read cell by cell whose text version was cut is no document « nobody could read » (its row says it).
  const longSheets = uncovered.filter((s) => s.unread === "truncated" && (sheets || []).some((x) => x.read && x.name === s.source));
  const unreadDocs = uncovered.length - sentences.length - longSheets.length;
  const wishes = (contract?.wishes || []).filter((w) => !w.checked && !w.by).length;
  const assumptions = (contract?.assumptions || []).filter((a) => !a.confirmed).length;
  const extracted = Boolean(contract?.extracted);
  const waivedDefault = clauses.some((c) => c.params?.derive && decisionOf(c) === "waive");
  // (One being read right now is neither read nor to choose again: its own line says the reading runs.)
  const unreadSheets = (sheets || []).filter((s) => !s.read && SPREADSHEET_RE.test(s.name || "") && !(readingSheets || []).includes(s.name));

  // Applied to the contract as it is when the act lands (a sheet's reading may land while the name is asked).
  const change = (fn) => onChange?.((c) => fn(c || contract));
  const replace = (id, next) => change((x) => ({ ...x, clauses: (x.clauses || []).map((c) => (c.id === id ? next : c)) }));
  const decide = (c, action, extra = {}) => withName((who) => replace(c.id, decideClause(c, action, { name: who, ...extra })));
  const remove = (c) => {
    if (c?.source?.kind === "recommendation") onChange?.(withoutRecommendation(contract, c.source.id));
    else if (!stated(sourceOf(c))) change((x) => ({ ...x, clauses: (x.clauses || []).filter((y) => y.id !== c.id) }));
    else decide(c, "waive");
  };
  const retainAll = (list) => {
    const ids = new Set(list.map((c) => c.id));
    withName((who) => change((x) => ({ ...x, clauses: (x.clauses || []).map((c) => (ids.has(c.id) && !isDecided(c) ? decideClause(c, "keep", { name: who }) : c)) })));
  };
  // A dispute settled under the person's name: the reading kept, the other set aside with why (utils/contract).
  const settle = (dispute, choice) => withName((who) => change((x) => settleDispute(x, dispute, choice, { name: who, reasons: { assistant: t("objectives.dispute.reason.assistant"), sheet: t("objectives.dispute.reason.sheet") } })));
  const save = (clause) => {
    const { template: _t, ...rest } = clause; // eslint-disable-line no-unused-vars
    const current = form;
    setForm(null);
    withName((who) => {
      if (current?.initial) {
        replace(current.initial.id, decideClause(current.initial, "correct", { name: who, patch: rest }));
        return;
      }
      const ids = new Set(clauses.map((c) => c.id));
      let n = clauses.length + 1;
      while (ids.has(`u${n}`)) n += 1;
      const quote = current?.sentence && !rest.quote ? { quote: current.quote } : {};
      const own = decideClause({ status: "stated", level: "must", ...rest, ...quote, id: `u${n}` }, "keep", { name: who });
      change((x) => ({ ...x, clauses: [...(x.clauses || []), own] }));
    });
  };
  const readSheet = async (file) => {
    if (!file || !onReadSheet) return;
    setReading({ name: file.name });
    try {
      await onReadSheet(file);
      setReading(null);
    } catch (err) {
      setReading({ name: file.name, error: err });
    }
  };

  // The groups: each document of the brief, the measured suggestions, the person's own (and a report's rows).
  const groups = [];
  const byDoc = new Map();
  const suggestions = [];
  const own = [];
  for (const c of shown) {
    const source = sourceOf(c);
    if (source === "suggestion") suggestions.push(c);
    else if (source === "own" || source === "report") own.push(c);
    else {
      const doc = documentOf(c) || t("objectives.source.brief");
      if (!byDoc.has(doc)) byDoc.set(doc, []);
      byDoc.get(doc).push(c);
    }
  }
  for (const [doc, list] of byDoc) groups.push({ id: `doc:${doc}`, icon: SPREADSHEET_RE.test(doc) ? TableChartOutlinedIcon : DescriptionOutlinedIcon, title: doc, clauses: list });
  if (suggestions.length) groups.push({ id: "suggestions", icon: AutoGraphRoundedIcon, title: t("objectives.group.suggestions"), clauses: suggestions });
  if (own.length) groups.push({ id: "own", icon: EditNoteRoundedIcon, title: t("objectives.group.own"), clauses: own });

  const row = (c, verdict) => <ObjectiveRow key={c.id} clause={c} verdict={verdict} readOnly={locked} onKeep={() => decide(c, "keep")} onWaive={() => decide(c, "waive")} onEdit={() => setForm({ initial: c })} onRemove={() => remove(c)} onRestore={() => replace(c.id, undecideClause(c))} k={k} t={t} />;
  const toRead = (hasDocuments || Boolean(String(brief || "").trim())) && !extracted && !locked;
  const canRead = Boolean(extract) && toRead && !extract.running;
  const pendingAll = shown.filter((c) => !isDecided(c));
  const openItems = [unreadDocs ? t("objectives.open.unread", { count: unreadDocs }) : null, wishes ? t("objectives.open.wishes", { count: wishes }) : null, assumptions ? t("objectives.open.assumptions", { count: assumptions }) : null].filter(Boolean);

  return (
    <Box data-testid="objectives-list" sx={{ display: "flex", flexDirection: "column", gap: 1.5 }}>
      {extract?.running && (
        <Box data-testid="objectives-reading" role="status" sx={{ display: "flex", alignItems: "center", gap: 1.25, p: 1.5, borderRadius: "12px", backgroundColor: k.accentSoft, border: `1px solid ${k.accentLine}` }}>
          <CircularProgress size={18} />
          <Box sx={{ minWidth: 0 }}>
            <Typography sx={{ fontSize: "0.84rem", fontWeight: 600, color: k.ink }}>{t("objectives.reading.title")}</Typography>
            <Typography sx={{ fontSize: "0.74rem", color: k.ink2 }}>{t("objectives.reading.body")}</Typography>
          </Box>
        </Box>
      )}
      {/* A workbook read cell by cell, too long for the sentence search: named before the one act acknowledges it. */}
      {longSheets.length > 0 && !locked && (
        <Box data-testid="objectives-long-sheets" sx={{ p: 1.5, borderRadius: "12px", backgroundColor: k.subtle, border: `1px solid ${k.line}` }}>
          <Typography sx={{ fontSize: "0.8rem", color: k.ink, lineHeight: 1.5, overflowWrap: "anywhere" }}>{t("objectives.longSheet.body", { names: longSheets.map((s) => `« ${s.source || s.text} »`).join(", ") })}</Typography>
        </Box>
      )}
      {(readingSheets || []).length > 0 && (
        <Box data-testid="objectives-reading-sheets" role="status" sx={{ display: "flex", alignItems: "center", gap: 1.25, p: 1.5, borderRadius: "12px", backgroundColor: k.accentSoft, border: `1px solid ${k.accentLine}` }}>
          <CircularProgress size={18} />
          <Typography sx={{ minWidth: 0, fontSize: "0.84rem", fontWeight: 600, color: k.ink, overflowWrap: "anywhere" }}>{t("objectives.readingSheets", { names: readingSheets.join(", ") })}</Typography>
        </Box>
      )}
      {toRead && !extract && assistantLock && (
        <Box data-testid="objectives-read-locked" sx={{ display: "flex", alignItems: "flex-start", flexWrap: "wrap", gap: 1.25, p: 1.5, borderRadius: "12px", border: `1px solid ${k.line}` }}>
          <AutoAwesomeOutlinedIcon aria-hidden sx={{ fontSize: 20, color: k.ink3, mt: "2px" }} />
          <Box sx={{ flex: 1, minWidth: 220, display: "flex", flexDirection: "column", gap: 0.75 }}>
            <Box>
              <Typography sx={{ fontSize: "0.84rem", fontWeight: 600, color: k.ink }}>{t("objectives.locked.title")}</Typography>
              <Typography sx={{ fontSize: "0.74rem", color: k.ink2 }}>{t("objectives.locked.body")}</Typography>
            </Box>
            <LockedAction lock={assistantLock} testid="objectives-read-lock">{t("objectives.read.action")}</LockedAction>
          </Box>
        </Box>
      )}
      {disputes.length > 0 && (
        <Box component="section" data-testid="objectives-disputes" data-count={disputes.length} aria-labelledby="objectives-disputes-title" sx={{ display: "flex", flexDirection: "column", gap: 0.75, p: 1.5, borderRadius: "12px", backgroundColor: k.subtle, border: `1px solid ${k.line}` }}>
          <Box sx={{ display: "flex", alignItems: "center", gap: 0.75 }}>
            <CompareArrowsRoundedIcon aria-hidden sx={{ fontSize: 18, color: k.warning }} />
            <Typography id="objectives-disputes-title" component="h3" sx={{ flex: 1, minWidth: 0, fontSize: "0.84rem", fontWeight: 600, color: k.ink }}>
              {t("objectives.dispute.title", { count: disputes.length })}
            </Typography>
          </Box>
          <Typography sx={{ fontSize: "0.74rem", color: k.ink2, lineHeight: 1.5 }}>{t("objectives.dispute.body")}</Typography>
          <Box component="ol" sx={{ listStyle: "none", m: 0, p: 0, display: "flex", flexDirection: "column", gap: 0.75 }}>
            {disputes.map((d) => (
              <Box component="li" key={d.assistant.id} data-testid="objectives-dispute" data-sheet={d.sheet.id} data-assistant={d.assistant.id} sx={{ p: 1.25, borderRadius: "10px", backgroundColor: k.surface, border: `1px solid ${k.lineSoft}`, display: "flex", flexDirection: "column", gap: 0.5 }}>
                {/* Where both readings come from: the spreadsheet and its cells. */}
                <Typography sx={{ fontSize: "0.72rem", color: k.ink3, overflowWrap: "anywhere" }}>{[documentOf(d.sheet), typeof d.sheet.source === "string" ? d.sheet.source : Array.isArray(d.sheet.source?.cells) ? d.sheet.source.cells.join(", ") : null].filter(Boolean).filter((x, i, all) => all.indexOf(x) === i).join(" · ")}</Typography>
                <Typography data-testid="objectives-dispute-sheet" sx={{ fontSize: "0.8rem", color: k.ink, lineHeight: 1.45, overflowWrap: "anywhere" }}>
                  <Box component="span" sx={{ fontWeight: 600 }}>{`${t("objectives.dispute.sheet")} `}</Box>
                  {clauseLabel(d.sheet, t)}
                </Typography>
                <Typography data-testid="objectives-dispute-assistant" sx={{ fontSize: "0.8rem", color: k.ink, lineHeight: 1.45, overflowWrap: "anywhere" }}>
                  <Box component="span" sx={{ fontWeight: 600 }}>{`${t("objectives.dispute.assistant")} `}</Box>
                  {clauseLabel(d.assistant, t)}
                  {d.assistant.quote ? <Box component="span" sx={{ color: k.ink2, fontStyle: "italic" }}>{` « ${d.assistant.quote} »`}</Box> : null}
                </Typography>
                {!locked && (
                  <Box sx={{ display: "flex", flexWrap: "wrap", gap: 0.5, pt: 0.25 }}>
                    <Button size="small" variant="outlined" onClick={() => settle(d, "assistant")} data-testid="objectives-dispute-assistant-keep">
                      {t("objectives.dispute.keepAssistant")}
                    </Button>
                    <Button size="small" onClick={() => settle(d, "sheet")} data-testid="objectives-dispute-sheet-keep" sx={{ color: k.ink2 }}>
                      {t("objectives.dispute.keepSheet")}
                    </Button>
                  </Box>
                )}
              </Box>
            ))}
          </Box>
        </Box>
      )}
      {pendingAll.length > 1 && !locked && (
        <Box data-testid="objectives-pending-all" sx={{ display: "flex", alignItems: "center", flexWrap: "wrap", gap: 1.25, p: 1.5, borderRadius: "12px", backgroundColor: k.subtle, border: `1px solid ${k.line}` }}>
          <Box sx={{ flex: 1, minWidth: 220 }}>
            <Typography sx={{ fontSize: "0.84rem", fontWeight: 600, color: k.ink }}>{t("objectives.pendingAll.title", { count: pendingAll.length })}</Typography>
            <Typography sx={{ fontSize: "0.74rem", color: k.ink2 }}>{t("objectives.pendingAll.body")}</Typography>
          </Box>
          {/* The step's way on keeps them all (one act): here, the same without leaving the page. */}
          <Button variant="outlined" onClick={() => retainAll(pendingAll)} data-testid="objectives-retain-everything" sx={{ fontWeight: 600 }}>
            {t("objectives.pendingAll.action", { count: pendingAll.length })}
          </Button>
        </Box>
      )}
      {canRead && (
        <Box data-testid="objectives-read-brief" sx={{ display: "flex", alignItems: "center", flexWrap: "wrap", gap: 1.25, p: 1.5, borderRadius: "12px", backgroundColor: k.accentSoft, border: `1px solid ${k.accentLine}` }}>
          <AutoAwesomeOutlinedIcon aria-hidden sx={{ fontSize: 20, color: k.accent }} />
          <Box sx={{ flex: 1, minWidth: 220 }}>
            <Typography sx={{ fontSize: "0.84rem", fontWeight: 600, color: k.ink }}>{t("objectives.read.title")}</Typography>
            <Typography sx={{ fontSize: "0.74rem", color: k.ink2 }}>{t("objectives.read.body")}</Typography>
          </Box>
          <Button variant="contained" disableElevation disabled={extract.running} onClick={() => extract.onExtract?.(brief)} startIcon={extract.running ? <CircularProgress size={14} color="inherit" /> : null} data-testid="contract-extract" sx={{ textTransform: "none", fontWeight: 600 }}>
            {extract.running ? t("objectives.read.running") : t("objectives.read.action")}
          </Button>
        </Box>
      )}
      {extract?.error && <ErrorNotice error={extract.error} onRetry={() => extract.onExtract?.(brief)} testid="contract-extract-error" />}
      {/* What a reading of the brief was given and could not read: named, read on their own — never dropped unsaid. */}
      {leftOut.length > 0 && !locked && (
        <Box data-testid="objectives-left-out" data-count={leftOut.length} sx={{ display: "flex", alignItems: "flex-start", flexWrap: "wrap", gap: 1.25, p: 1.5, borderRadius: "12px", backgroundColor: k.subtle, border: `1px solid ${k.line}` }}>
          <ReportGmailerrorredRoundedIcon aria-hidden sx={{ fontSize: 20, color: k.warning, mt: "1px" }} />
          <Box sx={{ flex: 1, minWidth: 220, display: "flex", flexDirection: "column", gap: 0.25 }}>
            {leftReadable.length > 0 && (
              <>
                <Typography sx={{ fontSize: "0.84rem", fontWeight: 600, color: k.ink, overflowWrap: "anywhere" }}>{t("objectives.leftOut.title", { names: leftReadable.map((d) => `« ${d.name || d.id} »`).join(", ") })}</Typography>
                <Typography sx={{ fontSize: "0.74rem", color: k.ink2, lineHeight: 1.5 }}>{t("objectives.leftOut.body")}</Typography>
              </>
            )}
            {leftGone.length > 0 && (
              <Typography data-testid="objectives-left-out-gone" sx={{ fontSize: "0.78rem", color: k.ink, lineHeight: 1.5, overflowWrap: "anywhere" }}>
                {t("objectives.leftOut.gone", { names: leftGone.map((d) => `« ${d.name || d.id} »`).join(", ") })}
              </Typography>
            )}
          </Box>
          {leftReadable.length > 0 && extract?.onReadLeftOut && (
            <Button variant="outlined" disabled={Boolean(extract.running)} onClick={extract.onReadLeftOut} data-testid="objectives-left-out-read" sx={{ fontWeight: 600 }}>
              {t("objectives.leftOut.action")}
            </Button>
          )}
        </Box>
      )}

      {unreadSheets.length > 0 && onReadSheet && !locked && (
        <Box data-testid="objectives-sheets" sx={{ display: "flex", alignItems: "center", flexWrap: "wrap", gap: 1.25, p: 1.5, borderRadius: "12px", border: `1px dashed ${k.lineStrong}` }}>
          <TableChartOutlinedIcon aria-hidden sx={{ fontSize: 20, color: k.ink2 }} />
          <Box sx={{ flex: 1, minWidth: 220 }}>
            <Typography sx={{ fontSize: "0.84rem", fontWeight: 600, color: k.ink }}>{t("objectives.sheets.title", { names: unreadSheets.map((s) => s.name).join(", ") })}</Typography>
            <Typography sx={{ fontSize: "0.74rem", color: k.ink2 }}>{t("objectives.sheets.body")}</Typography>
          </Box>
          <Button variant="outlined" disabled={Boolean(reading && !reading.error)} onClick={() => sheetInput.current?.click()} startIcon={reading && !reading.error ? <CircularProgress size={14} /> : null} data-testid="objectives-sheets-read">
            {t("objectives.sheets.action")}
          </Button>
          <input ref={sheetInput} type="file" hidden accept={OFFER_ACCEPT} data-testid="objectives-sheets-input" onChange={(e) => { const file = e.target.files?.[0] || null; e.target.value = ""; readSheet(file); }} />
          {reading?.error && (
            <Box sx={{ flexBasis: "100%" }}>
              <ErrorNotice error={reading.error} onRetry={() => sheetInput.current?.click()} testid="objectives-sheets-error" />
            </Box>
          )}
        </Box>
      )}

      {groups.length ? (
        // One group only: its « Tout retenir » would say what the block above (and the way on) already offers.
        groups.map((g) => <Group key={g.id} {...g} verdicts={verdicts} readOnly={locked} onRetainAll={groups.length > 1 ? retainAll : null} row={row} k={k} t={t} />)
      ) : (
        <Box data-testid="objectives-empty" sx={{ py: 1.5, px: 2, borderRadius: "12px", border: `1px dashed ${k.lineStrong}`, textAlign: "center" }}>
          <Typography sx={{ fontSize: "0.84rem", fontWeight: 600, color: k.ink }}>{t("objectives.empty.title")}</Typography>
          <Typography sx={{ fontSize: "0.76rem", color: k.ink2, lineHeight: 1.5 }}>{t(canRead ? "objectives.empty.brief" : "objectives.empty.body")}</Typography>
        </Box>
      )}

      {!locked && (
        <Box>
          <Button size="small" startIcon={<AddRoundedIcon />} onClick={() => setForm({})} data-testid="contract-add" sx={{ px: 1, color: k.ink2 }}>
            {t("objectives.add")}
          </Button>
        </Box>
      )}

      {sentences.length > 0 && (
        <Box component="section" data-testid="objectives-uncovered" data-count={sentences.length} aria-labelledby="objectives-uncovered-title" sx={{ display: "flex", flexDirection: "column", gap: 0.5, p: 1.5, borderRadius: "12px", backgroundColor: k.subtle, border: `1px solid ${k.line}` }}>
          <Box sx={{ display: "flex", alignItems: "center", flexWrap: "wrap", gap: 0.75 }}>
            <HelpOutlineRoundedIcon aria-hidden sx={{ fontSize: 18, color: k.ink3 }} />
            <Typography id="objectives-uncovered-title" component="h3" sx={{ flex: 1, minWidth: 200, fontSize: "0.84rem", fontWeight: 600, color: k.ink }}>
              {t("objectives.uncovered.title", { count: sentences.length })}
            </Typography>
            {onPropose && !locked && (
              <Button size="small" variant="contained" disableElevation disabled={Boolean(extract?.running)} startIcon={<AutoAwesomeOutlinedIcon sx={{ fontSize: "16px !important" }} />} onClick={() => onPropose(sentences)} data-testid="objectives-uncovered-propose">
                {t("objectives.uncovered.propose")}
              </Button>
            )}
          </Box>
          <Typography sx={{ fontSize: "0.74rem", color: k.ink2, lineHeight: 1.5, mb: 0.5 }}>{t("objectives.uncovered.body")}</Typography>
          <Box component="ol" sx={{ listStyle: "none", m: 0, p: 0, display: "flex", flexDirection: "column", gap: 0.75 }}>
            {(uncoveredOpen ? sentences : sentences.slice(0, UNCOVERED_PEEK)).map((s) => (
              <Box component="li" key={s.id} data-testid="objectives-uncovered-item" data-sentence={s.id} sx={{ p: 1.25, borderRadius: "10px", backgroundColor: k.surface, border: `1px solid ${k.lineSoft}`, display: "flex", flexDirection: "column", gap: 0.75 }}>
                <SentenceText text={s.text} k={k} />
                <Box sx={{ display: "flex", alignItems: "center", flexWrap: "wrap", gap: 0.5 }}>
                  <Typography sx={{ flex: 1, minWidth: 140, fontSize: "0.72rem", color: k.ink3 }}>
                    {s.source || ""}
                    {s.page ? ` · ${t("contract.page", { page: s.page })}` : ""}
                  </Typography>
                  {!locked && (
                    <>
                      <Button size="small" onClick={() => withName((who) => onChange?.(markNotMeasurable(contract, s, { name: who })))} data-testid="objectives-uncovered-hand" sx={{ px: 1, color: k.ink2 }}>
                        {t("objectives.uncovered.hand")}
                      </Button>
                      <Button size="small" onClick={() => withName((who) => onChange?.(dismissSentence(contract, s, { name: who })))} data-testid="objectives-uncovered-dismiss" sx={{ px: 1, color: k.ink2 }}>
                        {t("objectives.waive")}
                      </Button>
                      <Button size="small" onClick={() => setForm({ sentence: s, quote: String(s.text || "").replace(/\s*[.;!?]\s*$/, "").trim() })} data-testid="objectives-uncovered-add" sx={{ px: 1, color: k.ink3 }}>
                        {t("objectives.uncovered.add")}
                      </Button>
                    </>
                  )}
                </Box>
              </Box>
            ))}
          </Box>
          {sentences.length > UNCOVERED_PEEK && (
            <Button size="small" onClick={() => setUncoveredOpen((v) => !v)} aria-expanded={uncoveredOpen} data-testid="objectives-uncovered-toggle" sx={{ alignSelf: "flex-start", color: k.ink2 }}>
              {uncoveredOpen ? t("objectives.group.less") : t("objectives.group.more", { count: sentences.length })}
            </Button>
          )}
        </Box>
      )}

      {openItems.length > 0 && onDetailed && (
        <Box data-testid="objectives-open-items" sx={{ display: "flex", alignItems: "center", gap: 1, flexWrap: "wrap" }}>
          <Typography sx={{ flex: 1, minWidth: 200, fontSize: "0.76rem", color: k.ink2 }}>{openItems.join(" · ")}</Typography>
          <Button size="small" onClick={onDetailed} data-testid="objectives-open-items-settle">
            {t("objectives.open.settle")}
          </Button>
        </Box>
      )}

      {(defaults.length > 0 || waivedDefault) && (
        <Box data-testid="objectives-guarantees" sx={{ display: "flex", alignItems: "flex-start", gap: 1, pt: 1.25, borderTop: `1px solid ${k.lineSoft}` }}>
          <ShieldOutlinedIcon aria-hidden sx={{ fontSize: 17, color: k.success, mt: "1px" }} />
          <Typography sx={{ flex: 1, fontSize: "0.76rem", color: k.ink2, lineHeight: 1.5 }}>{t(waivedDefault ? "objectives.guarantees.changed" : "objectives.guarantees")}</Typography>
          {onDetailed && !locked && (
            <Button size="small" onClick={onDetailed} data-testid="objectives-guarantees-edit" sx={{ flexShrink: 0, color: k.ink2 }}>
              {t("objectives.guarantees.edit")}
            </Button>
          )}
        </Box>
      )}

      <ClauseForm simple open={Boolean(form)} initial={form?.initial || null} quote={form?.quote || null} onClose={() => setForm(null)} onSave={save} />
    </Box>
  );
}
