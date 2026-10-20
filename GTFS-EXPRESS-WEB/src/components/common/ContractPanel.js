/**
 * ContractPanel — ② Contrat: what the brief imposes, decided by a named
 * person before any design:
 *
 *   contract-extract   « Extraire les clauses des documents » (assistant ·
 *                      1 message, said before): the planners' first turn is
 *                      the extraction, nothing is designed; the brief's text
 *                      (`contract-brief`) and the project's documents are read
 *   contract-add       a clause by hand (ClauseForm: the six basic French
 *                      templates and the other kinds)
 *   contract-import-sheet  « Importer un tableur d'offre » (SpreadsheetImport):
 *                      the operator's offer sheet read by
 *                      the server cell by cell, what was read and what was not
 *                      shown, the clauses it states added under the decider's
 *                      name (each citing its cell), and what it states that
 *                      no clause covers (values not converted, cells not
 *                      read, clauses left unticked) recorded with them as
 *                      wishes « à vérifier à la main » (document = the file,
 *                      cell = its address: G5, never lost with the dialog)
 *   contract-clause    one per clause, impératives (must) then souhaitées
 *                      (should): its words, the brief's quote and page (a
 *                      clause from a row of the coherence report says that
 *                      instead, `contract-clause-origin`: « d'après le rapport
 *                      de cohérence de v1 du … », never as a quote), what
 *                      the engine measured, the decision and who took it —
 *                      « Retenir » (`contract-clause-validate`), « Corriger »
 *                      (`contract-clause-correct`, ClauseForm on the clause;
 *                      `contract-clause-level`, impérative ↔ souhaitée, a
 *                      named correction),
 *                      « Écarter » (`contract-clause-waive`, named:
 *                      `contract-waive-name`); what the person changed since
 *                      the extraction (`contract-clause-change`)
 *   contract-not-measurable  « À vérifier à la main »: the wishes the engine
 *                      cannot measure, each ticked by a named person
 *                      (`contract-checked-by-hand`), persisted with the project
 *   contract-assumption      the contract's assumptions, each confirmed or
 *                      corrected by a named person (`contract-assumption-
 *                      confirm`, `-correct`); one nobody confirmed is
 *                      accepted by name at delivery
 *   contract-uncovered « Exigences sans clause » (G5): the requirement
 *                      sentences of the brief no clause quotes, each to answer
 *                      — add a clause quoting it, mark it « à vérifier à la
 *                      main » (under the decider's name: the wish carries
 *                      `by`, and one nobody checked by hand
 *                      is accepted by name at the build or the application),
 *                      or dismiss it under a name (the G4 shape; the
 *                      server refuses an unnamed one) — reported by the
 *                      server's detector, never computed here
 *                      — a document the detector could not read is one entry
 *                      of its own (`data-unread`: missing, no_text,
 *                      truncated), acknowledged only under a name; a clause
 *                      whose quote spans several sentences is named on each
 *                      (« scindez-la »)
 *   contract-record-empty  « Enregistrer un contrat vide » (no clause, some
 *                      requirements listed): every listed entry dismissed under
 *                      the person's name — an empty contract is an explicit,
 *                      named choice, never the primary action's default,
 *                      recorded under the decider's name (nothing leaves
 *                      unnamed)
 *   contract-undecided « Reste à décider : N clause(s) impérative(s) »
 *
 * Keyboard (RGAA 10.7 / 12): focus is managed by ref, never left
 * on <body> when the control it was on goes away — « Retenir » moves it to
 * the row's « Annuler la décision », « Annuler la décision » back to
 * « Retenir », « Écarter » to its name field (and confirm or cancel back to
 * the row), a change of level follows the clause to its section, an answered
 * requirement sentence to the next one (else to the list's heading).
 *
 * No « Expert » view: the clauses are read in words, never as the engine's
 * kinds and params. The name of the person who decides (`contract-decider-name`,
 * the account's or the one remembered) signs every decision: nothing is
 * decided anonymously. The primary action (« Concevoir / Rédiger avec ce
 * contrat », `contract-proceed` on the step's primary) and « … avec le
 * contrat supposé » (`contract-proceed-assumed`) are the step's (StepContract).
 */

import React, { useEffect, useRef, useState } from "react";
import { Alert, Box, Button, Checkbox, Chip, CircularProgress, FormControlLabel, InputBase, TextField, Typography, alpha, useTheme } from "@mui/material";
import AutoAwesomeOutlinedIcon from "@mui/icons-material/AutoAwesomeOutlined";
import AddIcon from "@mui/icons-material/Add";
import { useLanguage } from "../../contexts/LanguageContext";
import { formatDateTime, formatYmd } from "../../utils/formatDate";
import { changesSinceExtraction, confirmAssumption, decideClause, decisionOf, dismissAllForEmpty, dismissSentence, isDecided, markNotMeasurable, nameOk, tickWish, undecideClause, undecidedMust } from "../../utils/contract";
import { clauseLabel } from "../network/BriefChecklist";
import ClauseForm from "./ClauseForm";
import SpreadsheetImport from "./SpreadsheetImport";
import TableChartOutlinedIcon from "@mui/icons-material/TableChartOutlined";
import ErrorNotice from "./ErrorNotice";

const STATUS_TONE = { pass: "success", fail: "error", unknown: "warning", waived: "text" };

function SectionTitle({ children, testid = null, count = null }) {
  return (
    <Typography component="h3" data-testid={testid} sx={{ fontSize: "0.72rem", fontWeight: 800, letterSpacing: 0.4, textTransform: "uppercase", color: "text.secondary", mt: 1 }}>
      {children}
      {count != null ? ` — ${count}` : ""}
    </Typography>
  );
}

/**
 * One clause of the contract. `focus` is the panel's focus request ({ current: { clause, target } | null }): after an
 * act the row puts the focus on the control that stays (the request survives a move to the other section, where
 * the row mounts again), never on <body>.
 */
function ClauseRow({ clause, verdict, change, expert, name, readOnly, onDecide, onCorrect, onUndo, focus }) {
  const { t, language } = useLanguage();
  const theme = useTheme();
  const [waiving, setWaiving] = useState(false);
  const refs = { keep: useRef(null), undo: useRef(null), waive: useRef(null), level: useRef(null), correct: useRef(null) };
  const ask = (target) => {
    if (focus) focus.current = { clause: clause.id, target };
  };
  useEffect(() => {
    const want = focus?.current;
    if (!want || want.clause !== clause.id) return;
    const el = [want.target, "undo", "keep", "correct"].map((k) => refs[k]?.current).find((x) => x && !x.disabled);
    if (el) {
      el.focus();
      focus.current = null;
    }
  });
  const [waiveName, setWaiveName] = useState(name || "");
  const [reason, setReason] = useState("");
  const decision = decisionOf(clause);
  const status = clause.status === "waived" ? "waived" : verdict?.status || null;
  const tone = STATUS_TONE[status] || "text";
  const who = clause.decision?.by?.name;
  const when = clause.decision?.at ? formatDateTime(clause.decision.at, language) : "";
  const decidedText = decision === "waive" ? t("contract.waived", { name: who, date: when }) : decision === "correct" ? t("contract.corrected", { name: who, date: when }) : decision === "keep" ? t("contract.decided", { name: who, date: when }) : null;
  return (
    <Box component="li" data-testid="contract-clause" data-clause={clause.id} data-status={status || "unknown"} data-level={clause.level || "must"} data-decision={decision || "none"} sx={{ py: 0.9, borderTop: `1px solid ${alpha(theme.palette.divider, 0.6)}`, "&:first-of-type": { borderTop: "none" } }}>
      <Box sx={{ display: "flex", flexDirection: "column", gap: 0.35 }}>
        <Box sx={{ display: "flex", alignItems: "baseline", gap: 0.75, flexWrap: "wrap" }}>
          {/* The clause's id is the engine's key (English): the expert view says it, the essential one reads the words. */}
          {expert && (
            <Typography component="span" data-testid="contract-clause-id" sx={{ fontSize: "0.72rem", fontWeight: 800, fontFamily: "monospace", color: "text.secondary" }} lang="en">
              {clause.id}
            </Typography>
          )}
          <Typography component="span" sx={{ fontSize: "0.84rem", fontWeight: 700, textDecoration: status === "waived" ? "line-through" : "none", overflowWrap: "anywhere" }}>
            {clauseLabel(clause, t)}
          </Typography>
          {change && change !== "kept" && <Chip size="small" data-testid="contract-clause-change" data-change={change} label={t(`contract.change.${change}`)} sx={{ height: 20, fontSize: "0.66rem", fontWeight: 700 }} />}
        </Box>
        {clause.origin?.kind === "coherence_row" && (
          // Not the brief's words: where the clause comes from — a row of a version's coherence report — and the
          // figures that row showed, said as such (never between « », never as a quote).
          <Typography data-testid="contract-clause-origin" data-origin="coherence_row" sx={{ fontSize: "0.76rem", color: "text.secondary", overflowWrap: "anywhere" }}>
            {t("contract.origin.coherence", { version: clause.origin.version || "—", date: clause.origin.date ? formatYmd(clause.origin.date.replace(/-/g, ""), language) : "—" })}
            {clause.origin.figures ? ` — ${clause.origin.figures}` : ""}
          </Typography>
        )}
        {clause.quote && clause.origin?.kind !== "coherence_row" && (
          <Typography data-testid="contract-clause-quote" sx={{ fontSize: "0.76rem", color: "text.secondary", fontStyle: "italic", overflowWrap: "anywhere" }}>
            « {clause.quote} »{clause.page ? ` ${t("contract.page", { page: clause.page })}` : ""}
            {clause.quote_verified === false ? ` — ${t("contract.quoteNotFound")}` : ""}
          </Typography>
        )}
        {expert && (
          <Typography lang="en" data-testid="contract-clause-params" sx={{ fontSize: "0.7rem", fontFamily: "monospace", color: "text.secondary", overflowWrap: "anywhere" }}>
            {clause.kind} {JSON.stringify(clause.params || {})}
          </Typography>
        )}
        <Typography sx={{ fontSize: "0.72rem", color: `${tone === "text" ? "text.secondary" : `${tone}.main`}` }}>
          {verdict && status !== "waived" ? (verdict.status === "pass" ? t("network.contract.status.pass") : verdict.status === "fail" ? `${t("network.contract.status.fail")}${verdict.measured ? ` · ${t("network.contract.measured")} ${verdict.measured}` : ""}` : t("network.contract.status.unknown")) : t("contract.measurable")}
          {decidedText ? ` · ${decidedText}` : ""}
        </Typography>
        {!readOnly &&
          (waiving ? (
            <Box sx={{ display: "flex", gap: 0.75, flexWrap: "wrap", alignItems: "center", mt: 0.25 }}>
              <TextField size="small" autoFocus label={t("contract.waive.name")} value={waiveName} onChange={(e) => setWaiveName(e.target.value)} error={Boolean(waiveName) && !nameOk(waiveName)} inputProps={{ "data-testid": "contract-waive-name" }} sx={{ minWidth: 200 }} />
              <InputBase value={reason} onChange={(e) => setReason(e.target.value)} placeholder={t("network.contract.waiveReason")} inputProps={{ "aria-label": t("network.contract.waiveReason"), "data-testid": "contract-waive-reason" }} sx={{ flex: 1, minWidth: 160, fontSize: "0.76rem", px: 1, py: 0.5, borderRadius: "8px", background: alpha(theme.palette.text.primary, 0.05) }} />
              <Button size="small" variant="outlined" disabled={!nameOk(waiveName)} onClick={() => { ask("undo"); onDecide("waive", { name: waiveName, reason: reason.trim() || null }); setWaiving(false); }} data-testid="contract-waive-confirm" sx={{ textTransform: "none", fontWeight: 700 }}>
                {t("contract.decide.waive")}
              </Button>
              <Button size="small" onClick={() => { ask("waive"); setWaiving(false); }} sx={{ textTransform: "none" }}>
                {t("app.cancel")}
              </Button>
            </Box>
          ) : (
            <Box sx={{ display: "flex", gap: 0.5, flexWrap: "wrap", mt: 0.25 }}>
              {decision !== "keep" && decision !== "correct" && (
                <Button ref={refs.keep} size="small" variant="outlined" disabled={!nameOk(name)} onClick={() => { ask("undo"); onDecide("keep", { name }); }} data-testid="contract-clause-validate" sx={{ textTransform: "none", fontWeight: 700, py: 0 }}>
                  {t("contract.decide.keep")}
                </Button>
              )}
              <Button ref={refs.correct} size="small" onClick={onCorrect} disabled={!nameOk(name)} data-testid="contract-clause-correct" sx={{ textTransform: "none", py: 0 }}>
                {t("contract.decide.correct")}
              </Button>
              {decision !== "waive" && (
                // The level is the person's too: impérative ↔ souhaitée is a correction, under their name.
                <Button ref={refs.level} size="small" disabled={!nameOk(name)} onClick={() => { ask("level"); onDecide("correct", { name, patch: { level: clause.level === "should" ? "must" : "should" } }); }} data-testid="contract-clause-level" sx={{ textTransform: "none", py: 0 }}>
                  {t(clause.level === "should" ? "network.contract.makeMust" : "network.contract.makeShould")}
                </Button>
              )}
              {decision !== "waive" && (
                <Button ref={refs.waive} size="small" color="warning" onClick={() => { setWaiveName(name || ""); setWaiving(true); }} data-testid="contract-clause-waive" sx={{ textTransform: "none", py: 0 }}>
                  {t("contract.decide.waive")}
                </Button>
              )}
              {decision && (
                <Button ref={refs.undo} size="small" onClick={() => { ask("keep"); onUndo(); }} data-testid="contract-clause-undo" sx={{ textTransform: "none", py: 0 }}>
                  {t("contract.decide.undo")}
                </Button>
              )}
            </Box>
          ))}
      </Box>
    </Box>
  );
}

/**
 * One assumption of the contract (`contract-assumption`): « Confirmer » under the decider's name, or « Corriger »
 * its words (confirmed under that name too); one nobody confirmed is accepted by name at delivery.
 */
function AssumptionRow({ assumption, name, readOnly, onConfirm }) {
  const { t, language } = useLanguage();
  const theme = useTheme();
  const [editing, setEditing] = useState(null);
  const confirmed = assumption.confirmed;
  return (
    <Box data-testid="contract-assumption" data-assumption={assumption.id} data-confirmed={confirmed ? "true" : "false"} sx={{ py: 0.4 }}>
      <Typography sx={{ fontSize: "0.8rem", overflowWrap: "anywhere" }}>
        {assumption.id} — {assumption.text}
        <Box component="span" sx={{ color: "text.secondary" }}>
          {" · "}
          {confirmed ? t("contract.assumption.confirmed", { name: confirmed.by?.name || "", date: confirmed.at ? formatDateTime(confirmed.at, language) : "" }) : t("contract.assumption.pending")}
        </Box>
      </Typography>
      {!readOnly &&
        (editing != null ? (
          <Box sx={{ display: "flex", gap: 0.75, flexWrap: "wrap", alignItems: "center", mt: 0.25 }}>
            <InputBase value={editing} onChange={(e) => setEditing(e.target.value)} inputProps={{ "aria-label": t("contract.assumption.correct"), "data-testid": "contract-assumption-text" }} sx={{ flex: 1, minWidth: 200, fontSize: "0.78rem", px: 1, py: 0.5, borderRadius: "8px", background: alpha(theme.palette.text.primary, 0.05) }} />
            <Button size="small" variant="outlined" disabled={!nameOk(name) || !editing.trim()} onClick={() => { onConfirm(editing); setEditing(null); }} data-testid="contract-assumption-save" sx={{ textTransform: "none", fontWeight: 700 }}>
              {t("contract.form.save")}
            </Button>
            <Button size="small" onClick={() => setEditing(null)} sx={{ textTransform: "none" }}>
              {t("app.cancel")}
            </Button>
          </Box>
        ) : (
          <Box sx={{ display: "flex", gap: 0.5, flexWrap: "wrap" }}>
            {!confirmed && (
              <Button size="small" variant="outlined" disabled={!nameOk(name)} onClick={() => onConfirm()} data-testid="contract-assumption-confirm" sx={{ textTransform: "none", fontWeight: 700, py: 0 }}>
                {t("contract.assumption.confirm")}
              </Button>
            )}
            <Button size="small" disabled={!nameOk(name)} onClick={() => setEditing(assumption.text)} data-testid="contract-assumption-correct" sx={{ textTransform: "none", py: 0 }}>
              {t("contract.assumption.correct")}
            </Button>
          </Box>
        ))}
    </Box>
  );
}

/**
 * @param {object} props
 *   contract, onChange(contract), conformance (the engine's results, per clause),
 *   coverage ({ sentences, covered, not_measurable, dismissed, uncovered, gated } from the server) and coverageState
 *   ("loading" | "error" | null), extract ({ running, error, onExtract(brief) } — null without the assistant),
 *   brief / onBrief (the brief's text the extraction reads), name / onName (who decides), readOnly
 */
export default function ContractPanel({ contract, onChange, conformance = null, coverage = null, coverageState = null, extract = null, brief = "", onBrief = null, name = "", onName = null, readOnly = false }) {
  const { t, language } = useLanguage();
  const theme = useTheme();
  const [form, setForm] = useState(null); // { initial?, quote?, sentence? }
  const [sheetOpen, setSheetOpen] = useState(false);
  const [sheetAdded, setSheetAdded] = useState(null);
  const [dismissing, setDismissing] = useState(null); // { sentence, reason }
  // Focus by ref: the clause rows' requests, the requirement sentences' own controls, the list's heading.
  const focusRequest = useRef(null);
  const itemRefs = useRef(new Map());
  const coverageLine = useRef(null);
  const [focusItem, setFocusItem] = useState(null); // the requirement sentence to focus next (its id), or "summary"
  const clauses = contract?.clauses || [];
  const verdicts = new Map((conformance?.results || []).map((r) => [r.id, r]));
  const changes = contract?.extracted ? changesSinceExtraction(contract) : {};
  const must = clauses.filter((c) => c.level !== "should");
  const should = clauses.filter((c) => c.level === "should");
  const undecided = undecidedMust(contract);
  const wishes = contract?.wishes || [];
  const assumptions = contract?.assumptions || [];
  const uncovered = coverage?.uncovered || [];
  const spannedBy = new Map((coverage?.detail || []).filter((d) => Array.isArray(d.spanned_by) && d.spanned_by.length).map((d) => [d.id, d.spanned_by]));
  // After an answer, the next sentence of the list (else the one before, else the coverage line, which stays while
  // the list empties): never <body>.
  const answered = (id) => {
    const i = uncovered.findIndex((u) => u.id === id);
    const next = uncovered[i + 1] || uncovered[i - 1] || null;
    setFocusItem(next ? next.id : "summary");
  };
  useEffect(() => {
    if (!focusItem) return;
    const el = focusItem === "summary" ? coverageLine.current : itemRefs.current.get(focusItem);
    if (el) el.focus();
    setFocusItem(null);
  }, [focusItem]);
  // No « Expert » view: the clauses are read in words, never as the engine's keys.
  const expert = false;
  const change = (fn) => onChange?.(fn(contract));
  const replaceClause = (id, next) => change((k) => ({ ...k, clauses: (k.clauses || []).map((c) => (c.id === id ? next : c)) }));
  const decide = (clause) => (action, { name: who, reason = null, patch = null } = {}) => replaceClause(clause.id, decideClause(clause, action, { name: who, reason, patch }));

  const saveForm = (clause) => {
    const sentence = form?.sentence || null;
    setForm(null);
    if (form?.initial) {
      // « Corriger »: the person's clause replaces the proposal, under their name.
      const { template: _t, ...patch } = clause; // eslint-disable-line no-unused-vars
      replaceClause(form.initial.id, decideClause(form.initial, "correct", { name, patch }));
      return;
    }
    const ids = new Set(clauses.map((c) => c.id));
    let n = clauses.length + 1;
    while (ids.has(`u${n}`)) n += 1;
    const { template: _t, ...rest } = clause; // eslint-disable-line no-unused-vars
    const own = decideClause({ ...rest, id: `u${n}`, ...(sentence && !rest.quote ? { quote: sentence.text } : {}) }, "keep", { name });
    change((k) => ({ ...k, clauses: [...(k.clauses || []), own] }));
  };

  // The clauses an offer sheet states, retained under the decider's name: each keeps the server's content id (the
  // same promise imported twice is one clause), its cell as source and the cell's text as quote. What the sheet states
  // that no clause covers comes with them as wishes « à vérifier à la main » (G5: covered, to check by hand, or
  // dismissed by name — never forgotten when the dialog closes).
  const addSheetClauses = (picked, _result, toCheck = []) => {
    const ids = new Set(clauses.map((c) => c.id));
    const own = picked.filter((c) => !ids.has(c.id)).map((c) => decideClause({ ...c }, "keep", { name }));
    if (own.length || toCheck.length) {
      change((k) => {
        const list = k.wishes || [];
        const used = new Set(list.map((w) => w.id));
        let n = list.length + 1;
        const added = toCheck.map((w) => {
          while (used.has(`w${n}`)) n += 1;
          used.add(`w${n}`);
          return { id: `w${n}`, ...w };
        });
        return { ...k, clauses: [...(k.clauses || []), ...own], wishes: [...list, ...added] };
      });
    }
    setSheetAdded({ clauses: own.length, wishes: toCheck.length });
    setSheetOpen(false);
  };

  const extractedSummary = contract?.extracted
    ? t("contract.extracted.summary", {
        date: formatDateTime(contract.extracted.at, language),
        sources: [...(contract.extracted.documents || []).map((d) => `« ${d.name} »`), ...(String(contract.extracted.note || "").trim() ? [t("contract.extracted.note")] : [])].join(", ") || "—",
        clauses: (contract.extracted.objectives || []).length,
        wishes: (contract.extracted.not_measurable || []).length,
        changed: Object.values(changes).filter((x) => x !== "kept").length,
      })
    : null;

  return (
    <Box data-testid="contract-panel" data-status={contract?.status || "draft"} sx={{ display: "flex", flexDirection: "column", gap: 1, maxWidth: 980 }}>
      <Box sx={{ display: "flex", alignItems: "center", gap: 1, flexWrap: "wrap" }}>
        <Typography sx={{ fontSize: "0.8rem", fontWeight: 700, color: "text.secondary", flex: 1, minWidth: 200 }} data-testid="contract-status">
          {contract?.status === "empty" ? (nameOk(contract.decided_by) ? t("contract.status.emptyBy", { date: contract.decided_at ? formatDateTime(contract.decided_at, language) : "—", name: contract.decided_by }) : t("contract.status.emptyUnnamed")) : contract?.status === "assumed" ? t("contract.status.assumed") : contract?.status === "decided" ? t("contract.status.decided", { date: contract.decided_at ? formatDateTime(contract.decided_at, language) : "—", name: contract.decided_by || "—" }) : t("contract.status.draft")}
        </Typography>
      </Box>

      {/* Who decides: every decision, tick and dismissal carries this name (never anonymous). */}
      {!readOnly && (
        <TextField size="small" label={t("contract.decider")} value={name} onChange={(e) => onName?.(e.target.value)} error={Boolean(name) && !nameOk(name)} helperText={t("contract.deciderHint")} inputProps={{ "data-testid": "contract-decider-name", autoComplete: "name" }} sx={{ maxWidth: 360 }} />
      )}

      {!readOnly && (
        <Box sx={{ display: "flex", flexDirection: "column", gap: 0.75, p: 1.25, borderRadius: "12px", background: alpha(theme.palette.primary.main, 0.05) }}>
          {onBrief && <TextField size="small" multiline minRows={2} maxRows={8} label={t("contract.brief")} value={brief} onChange={(e) => onBrief(e.target.value)} inputProps={{ "data-testid": "contract-brief" }} />}
          <Box sx={{ display: "flex", alignItems: "center", gap: 1, flexWrap: "wrap" }}>
            {extract && (
              <>
                <Button variant="outlined" size="small" startIcon={extract.running ? <CircularProgress size={14} /> : <AutoAwesomeOutlinedIcon />} disabled={extract.running} onClick={() => extract.onExtract?.(brief)} data-testid="contract-extract" sx={{ textTransform: "none", fontWeight: 700 }}>
                  {t("contract.extract")}
                </Button>
                <Typography sx={{ fontSize: "0.72rem", color: "text.secondary" }}>{t("contract.extract.cost")}</Typography>
                <Typography sx={{ fontSize: "0.72rem", color: "text.disabled" }}>{t("contract.or")}</Typography>
              </>
            )}
            <Button size="small" variant={extract ? "text" : "outlined"} startIcon={<AddIcon />} disabled={!nameOk(name)} onClick={() => setForm({})} data-testid="contract-add" sx={{ textTransform: "none", fontWeight: 700 }}>
              {t("contract.add")}
            </Button>
            <Button size="small" variant="text" startIcon={<TableChartOutlinedIcon />} onClick={() => setSheetOpen(true)} data-testid="contract-import-sheet" sx={{ textTransform: "none", fontWeight: 700 }}>
              {t("sheet.import")}
            </Button>
            {!nameOk(name) && <Typography sx={{ fontSize: "0.72rem", color: "text.secondary" }}>{t("contract.nameFirst")}</Typography>}
          </Box>
          {sheetAdded != null && (
            <Typography role="status" data-testid="contract-sheet-added" sx={{ fontSize: "0.74rem" }}>
              {t("sheet.added", { count: sheetAdded.clauses })}
              {sheetAdded.wishes ? ` ${t("sheet.addedWishes", { count: sheetAdded.wishes })}` : ""}
            </Typography>
          )}
          {extract && <Typography sx={{ fontSize: "0.72rem", color: "text.secondary" }}>{t("contract.intro")}</Typography>}
          {extract?.running && <Typography role="status" data-testid="contract-extracting" sx={{ fontSize: "0.76rem" }}>{t("contract.extracting")}</Typography>}
          {extract?.error && <ErrorNotice error={extract.error} onRetry={() => extract.onExtract?.(brief)} testid="contract-extract-error" />}
        </Box>
      )}
      {extractedSummary && (
        <Typography data-testid="contract-extracted" sx={{ fontSize: "0.76rem", color: "text.secondary" }}>
          {extractedSummary}
        </Typography>
      )}

      {!clauses.length ? (
        <Typography data-testid="contract-empty" sx={{ fontSize: "0.84rem", color: "text.secondary", lineHeight: 1.55 }}>
          {t("contract.empty")} — {t("step.contract.emptyCreate")}
        </Typography>
      ) : (
        <Box data-testid="contract-table">
          <SectionTitle testid="contract-must" count={must.length}>{t("contract.must")}</SectionTitle>
          <Box component="ul" sx={{ listStyle: "none", m: 0, p: 0 }}>
            {must.map((c) => (
              <ClauseRow key={c.id} clause={c} verdict={verdicts.get(c.id)} change={changes[c.id]} expert={expert} name={name} readOnly={readOnly} onDecide={decide(c)} onCorrect={() => setForm({ initial: c })} onUndo={() => replaceClause(c.id, undecideClause(c))} focus={focusRequest} />
            ))}
          </Box>
          {should.length > 0 && (
            <>
              <SectionTitle testid="contract-should" count={should.length}>{t("contract.should")}</SectionTitle>
              <Box component="ul" sx={{ listStyle: "none", m: 0, p: 0 }}>
                {should.map((c) => (
                  <ClauseRow key={c.id} clause={c} verdict={verdicts.get(c.id)} change={changes[c.id]} expert={expert} name={name} readOnly={readOnly} onDecide={decide(c)} onCorrect={() => setForm({ initial: c })} onUndo={() => replaceClause(c.id, undecideClause(c))} focus={focusRequest} />
                ))}
              </Box>
            </>
          )}
        </Box>
      )}

      {wishes.length > 0 && (
        <Box component="section" data-testid="contract-not-measurable">
          <SectionTitle count={wishes.length}>{t("contract.notMeasurable")}</SectionTitle>
          <Box component="ul" sx={{ listStyle: "none", m: 0, p: 0 }}>
            {wishes.map((w) => (
              <Box component="li" key={w.id} data-testid="contract-wish" data-wish={w.id} data-checked={w.checked ? "true" : "false"} sx={{ py: 0.4 }}>
                <FormControlLabel
                  control={<Checkbox size="small" checked={Boolean(w.checked)} disabled={readOnly || (!w.checked && !nameOk(name))} onChange={(e) => change((k) => ({ ...k, wishes: (k.wishes || []).map((x) => (x.id === w.id ? tickWish(x, e.target.checked ? name : null) : x)) }))} inputProps={{ "data-testid": "contract-checked-by-hand" }} />}
                  label={
                    <Typography component="span" sx={{ fontSize: "0.8rem" }}>
                      « {w.quote} »{w.why ? ` — ${w.why}` : ""}
                      {w.document || w.cell ? <Box component="span" sx={{ color: "text.secondary" }}>{` (${[w.document, w.cell].filter(Boolean).join(" · ")})`}</Box> : null}
                      {w.checked ? <Box component="span" sx={{ color: "text.secondary" }}>{` · ${t("contract.checkedByHand", { name: w.checked.by?.name || "", date: w.checked.at ? formatDateTime(w.checked.at, language) : "" })}`}</Box> : null}
                      {/* Who declared it not measurable; one nobody checked is accepted by name at the build or the application. */}
                      {!w.checked && w.by?.name ? <Box component="span" data-testid="contract-wish-marked" sx={{ color: "text.secondary" }}>{` · ${t("contract.wish.markedBy", { name: w.by.name })}`}</Box> : null}
                    </Typography>
                  }
                />
              </Box>
            ))}
          </Box>
        </Box>
      )}

      {assumptions.length > 0 && (
        <Box component="section">
          <SectionTitle count={assumptions.length}>{t("contract.assumptions")}</SectionTitle>
          {assumptions.map((a) => (
            <AssumptionRow key={a.id} assumption={a} name={name} readOnly={readOnly} onConfirm={(text = null) => onChange?.(confirmAssumption(contract, a.id, { name, text }))} />
          ))}
        </Box>
      )}

      {/* G5: the requirement sentences of the brief no clause quotes, as the server's detector reports them. */}
      {coverage && (coverage.sentences > 0 || uncovered.length > 0) && (
        <Typography ref={coverageLine} tabIndex={-1} data-testid="contract-coverage" data-uncovered={uncovered.length} sx={{ fontSize: "0.76rem", color: uncovered.length ? "warning.dark" : "text.secondary", "&:focus-visible": { outline: `2px solid ${theme.palette.primary.main}`, outlineOffset: 2 } }}>
          {t("contract.coverage.summary", { covered: coverage.covered, sentences: coverage.sentences, notMeasurable: coverage.not_measurable, dismissed: coverage.dismissed })}
        </Typography>
      )}
      {coverageState === "error" && <Typography sx={{ fontSize: "0.74rem", color: "text.secondary" }}>{t("contract.coverage.unavailable")}</Typography>}
      {coverage?.incomplete && (
        <Typography data-testid="contract-coverage-incomplete" sx={{ fontSize: "0.74rem", color: "warning.dark" }}>
          {t("contract.coverage.incomplete")}
        </Typography>
      )}
      {uncovered.length > 0 && (
        <Box component="section" data-testid="contract-uncovered" aria-labelledby="contract-uncovered-title" sx={{ p: 1.25, borderRadius: "12px", border: `1px solid ${alpha(theme.palette.warning.main, 0.5)}` }}>
          <Typography id="contract-uncovered-title" component="h3" sx={{ fontSize: "0.84rem", fontWeight: 800 }}>
            {t("contract.uncovered.title", { count: uncovered.length })}
          </Typography>
          <Typography sx={{ fontSize: "0.74rem", color: "text.secondary", mb: 0.5 }}>{t(coverage?.gated ? "contract.uncovered.gated" : "contract.uncovered.hint")}</Typography>
          <Box component="ul" sx={{ listStyle: "none", m: 0, p: 0 }}>
            {uncovered.map((s) => {
              // A document nobody could read: one entry, acknowledged only under a name (never « mark » nor « add a clause »).
              const unreadDoc = Boolean(s.unread);
              const spans = spannedBy.get(s.id) || [];
              return (
                <Box component="li" key={s.id} data-testid="contract-uncovered-item" data-sentence={s.id} data-unread={s.unread || undefined} sx={{ py: 0.6, borderTop: `1px solid ${alpha(theme.palette.divider, 0.6)}`, "&:first-of-type": { borderTop: "none" } }}>
                  <Typography sx={{ fontSize: "0.8rem" }}>
                    {unreadDoc ? (
                      t("contract.unread.item", { name: s.source || t("contract.unread.unnamed"), reason: t(`contract.unread.reason.${s.unread}`) })
                    ) : (
                      <>
                        « {s.text} »
                        <Box component="span" sx={{ color: "text.secondary" }}>
                          {s.source && s.source !== "brief" ? ` — ${s.source}` : ""}
                          {s.page ? ` ${t("contract.page", { page: s.page })}` : ""}
                        </Box>
                      </>
                    )}
                  </Typography>
                  {spans.length > 0 && (
                    <Typography data-testid="contract-uncovered-spanned" sx={{ fontSize: "0.72rem", color: "text.secondary" }}>
                      {t("contract.uncovered.spanned", { clauses: spans.join(", ") })}
                    </Typography>
                  )}
                  {s.reason === "kind_mismatch" && (
                    // Quoted by a clause whose kind measures none of what the sentence states (the server's detector):
                    // which clause, and what stays unmeasured — a clause that measures it answers the requirement.
                    <Typography data-testid="contract-uncovered-mismatch" sx={{ fontSize: "0.72rem", color: "warning.dark" }}>
                      {t("contract.uncovered.kindMismatch", {
                        clauses: (s.mismatched || []).map((id) => (contract?.clauses || []).find((c) => c.id === id)?.text || id).join(", "),
                        measures: (s.measures || []).map((m) => t(`contract.measure.${m}`)).join(", ") || "—",
                      })}
                    </Typography>
                  )}
                  {!readOnly &&
                    (dismissing?.sentence.id === s.id ? (
                      <Box sx={{ display: "flex", gap: 0.75, flexWrap: "wrap", alignItems: "center", mt: 0.5 }}>
                        <InputBase autoFocus value={dismissing.reason} onChange={(e) => setDismissing((d) => ({ ...d, reason: e.target.value }))} placeholder={t("contract.uncovered.reason")} inputProps={{ "aria-label": t("contract.uncovered.reason"), "data-testid": "contract-uncovered-reason" }} sx={{ flex: 1, minWidth: 180, fontSize: "0.76rem", px: 1, py: 0.5, borderRadius: "8px", background: alpha(theme.palette.text.primary, 0.05) }} />
                        <Button size="small" variant="outlined" color="warning" disabled={!nameOk(name)} onClick={() => { onChange?.(dismissSentence(contract, s, { name, reason: dismissing.reason.trim() || null })); setDismissing(null); answered(s.id); }} data-testid="contract-uncovered-dismiss-confirm" sx={{ textTransform: "none", fontWeight: 700 }}>
                          {t("contract.uncovered.dismissAs", { name: nameOk(name) ? name.trim() : "…" })}
                        </Button>
                        <Button size="small" onClick={() => { setDismissing(null); setFocusItem(s.id); }} sx={{ textTransform: "none" }}>
                          {t("app.cancel")}
                        </Button>
                      </Box>
                    ) : (
                      <Box sx={{ display: "flex", gap: 0.5, flexWrap: "wrap", mt: 0.25 }}>
                        {!unreadDoc && (
                          <>
                            <Button size="small" disabled={!nameOk(name)} onClick={() => setForm({ quote: s.text.replace(/\s*[.;!?]\s*$/, "").trim(), sentence: s })} data-testid="contract-uncovered-add" sx={{ textTransform: "none", py: 0 }}>
                              {t("contract.uncovered.add")}
                            </Button>
                            <Button
                              size="small"
                              ref={(el) => (el ? itemRefs.current.set(s.id, el) : itemRefs.current.delete(s.id))}
                              // « Non mesurable » is the decider's act, under their name: never anonymous.
                              disabled={!nameOk(name)}
                              onClick={() => {
                                onChange?.(markNotMeasurable(contract, s, { name }));
                                answered(s.id);
                              }}
                              data-testid="contract-uncovered-not-measurable"
                              sx={{ textTransform: "none", py: 0 }}
                            >
                              {t("contract.uncovered.notMeasurable")}
                            </Button>
                          </>
                        )}
                        <Button size="small" color="warning" ref={unreadDoc ? (el) => (el ? itemRefs.current.set(s.id, el) : itemRefs.current.delete(s.id)) : undefined} disabled={!nameOk(name)} onClick={() => setDismissing({ sentence: s, reason: "" })} data-testid="contract-uncovered-dismiss" sx={{ textTransform: "none", py: 0 }}>
                          {t(unreadDoc ? "contract.unread.acknowledge" : "contract.uncovered.dismiss")}
                        </Button>
                      </Box>
                    ))}
                </Box>
              );
            })}
          </Box>
          {/* No clause at all: an empty contract is an explicit, named choice over the requirements listed. */}
          {!readOnly && !clauses.length && (
            <Box sx={{ display: "flex", alignItems: "center", gap: 1, flexWrap: "wrap", mt: 1 }}>
              <Button size="small" variant="outlined" color="warning" disabled={!nameOk(name)} onClick={() => { onChange?.(dismissAllForEmpty(contract, uncovered, { name, reason: t("contract.recordEmpty.reason") })); setFocusItem("summary"); }} data-testid="contract-record-empty" sx={{ textTransform: "none", fontWeight: 700 }}>
                {t("contract.recordEmpty")}
              </Button>
              <Typography sx={{ fontSize: "0.72rem", color: "text.secondary" }}>{t("contract.recordEmpty.hint", { count: uncovered.length })}</Typography>
            </Box>
          )}
        </Box>
      )}
      {(contract?.dismissed || []).length > 0 && (
        <Typography data-testid="contract-dismissed" sx={{ fontSize: "0.74rem", color: "text.secondary" }}>
          {t("contract.uncovered.dismissed", { count: contract.dismissed.length, names: [...new Set(contract.dismissed.map((d) => d.by?.name).filter(Boolean))].join(", ") })}
        </Typography>
      )}

      {undecided.length > 0 && (
        <Alert severity="info" data-testid="contract-undecided" sx={{ fontSize: "0.8rem" }}>
          {t("contract.undecided", { count: undecided.length })}
        </Alert>
      )}
      <ClauseForm open={Boolean(form)} initial={form?.initial || null} quote={form?.quote || null} onClose={() => setForm(null)} onSave={saveForm} />
      {sheetOpen && <SpreadsheetImport open={sheetOpen} onClose={() => setSheetOpen(false)} name={name} nameOk={nameOk} existing={clauses.map((c) => c.id)} wishes={wishes} onAddClauses={addSheetClauses} />}
    </Box>
  );
}

/**
 * Whether the contract can be decided now: every must clause decided, a named decider. With no clause the contract
 * is recorded empty — by a named person too (the server refuses an unnamed empty contract, CONTRACT_REQUIRED) —
 * and never over requirements the server's detector lists
 * (`coverage.uncovered`): those are answered first, or dismissed under a name by « Enregistrer un contrat vide »
 * (an explicit, named choice).
 */
export const proceedState = (contract, name, coverage = null) => {
  const clauses = contract?.clauses || [];
  if (!clauses.length) {
    const open = (coverage?.uncovered || []).length;
    if (open) return { ok: false, empty: true, reason: "contract.emptyUncovered", count: open };
    return nameOk(name) ? { ok: true, empty: true, reason: null } : { ok: false, empty: true, reason: "contract.nameRequired" };
  }
  if (!nameOk(name)) return { ok: false, empty: false, reason: "contract.nameRequired" };
  const undecided = undecidedMust(contract);
  if (undecided.length) return { ok: false, empty: false, reason: "contract.undecided", count: undecided.length };
  return { ok: true, empty: false, reason: null };
};
export { isDecided };
