/**
 * ChangeStudio — change a network the way a brief asks, as the steps of a
 * project that modifies it: the studio is the flow of the modify job and
 * renders the page of the step the route names —
 *
 *   ① StepNetwork   the network chosen (its card) and the brief, optional
 *                   (nothing else is asked: its name is the bar's, renamed
 *                   in place; the dates are ②'s; the deliverables are
 *                   chosen at the delivery); the Diagnostic (what works,
 *                   what is weak, its estimated ridership and the optimizer)
 *                   folded under them (`change-asis`, opened on demand). No
 *                   map at ①: the network is looked at in the reader, at ③.
 *                   With a brief the way on is ② (its objectives); without
 *                   one, the change itself (③) — a punctual change needs no
 *                   objective first, ② stays one click away and the
 *                   delivery records « sans objectif » under the person's
 *                   name (`delivery-no-objective`);
 *   ② StepObjectives « Objectifs »: the contract — « Vos objectifs » — beside
 *                   the suggestions measured on the network
 *                   (transform/recommendations), first when no brief was
 *                   dropped, folded after the brief's requirements when one
 *                   was; and « Mise en service » (`context.from_date`,
 *                   `to_date`: the defaults of ③'s operations). The contract
 *                   holds the brief's clauses as the extraction proposes
 *                   them or as written by hand (ClauseForm), with the two
 *                   « inchangé » clauses a modification starts with (the
 *                   other lines, the rest of the day: kept by default,
 *                   derived from the operations at every measure), decided
 *                   by a named person, « à vérifier à la main », the
 *                   requirement sentences without a clause (G5); ③'s
 *                   assistant drafts nothing before the contract is decided,
 *                   assumed or recorded empty — its first turn is the
 *                   extraction, asked at ② (the catalogue by hand stays
 *                   open meanwhile); an operator's offer sheet imported
 *                   there adds the clauses it states and keeps its
 *                   timetables with the project for ③;
 *   ③ StepChange    the brief (typed, handed over, or documents: a service
 *                   notice, a contract amendment…) and the conversation with
 *                   the change planner, which reads the feed and writes a
 *                   CHANGE PLAN of typed operations, each citing the brief;
 *                   the operations with the engine's verdict (simulated,
 *                   blocked with its questions, failed) beside the reader of
 *                   the draft (ChangeReview: the lines the draft touches,
 *                   the line in focus read in its timetable « Avant |
 *                   Après » through the API's lens, or on the map of the
 *                   change); the app's own reader, full width, stays one
 *                   click away on « Après » (`onOpenReader`), its lens
 *                   reading the draft this flow publishes (`onDraft`). On a
 *                   desktop screen (studio/Workspace): the catalogue or the
 *                   conversation on the left, the reader in the middle, the
 *                   plan of change on the right with its scenario, its
 *                   impact and, at its foot, its status and « Appliquer »
 *                   (`change-plan`); narrower, the changes beside the
 *                   operations (`change-atelier`) or a tab; by hand, the
 *                   network's lines first (LinePicker: a line picked, its
 *                   operations, the form filled with it) and what the plan
 *                   costs under the operations (ImpactStrip); the timetables
 *                   of the offer sheet imported at ②, one build_timetable
 *                   operation each, added by the person (OfferOperations:
 *                   the engine then asks what the sheet does not say); the
 *                   scenarios (ScenarioSwitcher); the status line
 *                   `change-status` — the compact verdict, then the next
 *                   thing to do; "Simuler et vérifier" → ④ Livraison;
 *   ④ StepDelivery  « Livraison », step 5 inside (StepNav.MODIFY_STEPS): first
 *                   the checks (`delivery-checks`: the coherence report, the
 *                   clauses before → after, integrity, the canonical
 *                   validator, the changes as a passenger or an operator
 *                   reads them), then the apply section (ApplyDialog's body,
 *                   in place: the named acknowledgement and the act), then
 *                   its result — the scenario frozen "applied in vN"
 *                   (`change-applied`), "Nouveau scénario sur vN"
 *                   (`scenario-new-from-version`), "Annuler l'application" —
 *                   the deliverables and the versions. Once applied, the
 *                   note (downloaded, or packed with vN) is the version's
 *                   own (synthesis.appliedNoteOf: applied in vN, the
 *                   validator's answer recorded with it), and the commit's
 *                   run of the validator is said to the status bar at once
 *                   (utils/vouchedValidation).
 *
 * `change-apply` stays in ③'s foot, the modify job's counterpart of
 * `network-build`: it goes to the delivery, where the apply section simulates
 * again on the working copy and the validator runs at the commit. Nothing
 * touches the feed until "Apply", which follows the preview's gate and writes
 * the whole plan as ONE edit, undone in one click. After it, the scenario is
 * frozen: its operations are read only, "Simuler et vérifier" is gone for it,
 * a new scenario on vN or the undo are offered.
 *
 * The working plan is kept in the browser for this feed, with named
 * scenarios to switch between, compare and exchange as files
 * (ScenarioSwitcher, ScenarioCompare, utils/changeScenarios) — a cache only:
 * the plan of the project's active scenario is written into the project as it
 * changes (debounced, like the autosave: `scenarios[active].plan`), so the
 * server keeps it, and a browser that holds nothing for this network (another
 * device, another browser of the account, a cleared cache) opens on the
 * project's plan. Without the assistant (the server's chat off, or no Studio
 * access) the studio still works and says so where the conversation would
 * be: ③'s left column is the work by hand (ManualSidebar — the catalogue of
 * operations by family, searched, each said in plain words; the engine's
 * verdict on the simulated plan; the contract; the documents to cite, kept
 * with the project), a click on an operation opens its form with it chosen,
 * and the operations are previewed and applied the same way; a new operation
 * takes the period of ②'s « Mise en service » as its default
 * (framingDefaults). A frozen scenario is read back from the project (the
 * plan it was applied with), never from the feed's workspace — the
 * application changed the feed, and emptied its draft — and it is never
 * simulated again: its operations stay listed, read only, after any visit of
 * the explorer or a reload; "Nouveau scénario sur vN" starts from the
 * project's copy of them. A plan or a brief handed over (the chat, the
 * Network Studio) is taken once (`onHandoverTaken`); a plan handed to the
 * project that already works on the network (`initialPlanMode` "append",
 * « Ajouter au changement ») joins its operations instead of replacing them.
 *
 * Which network the person is looking at is said by the reader's lens
 * (components/reader/ReaderLens, utils/changeStates): the network the change
 * starts from (« Avant »), the draft simulated on a copy (« Après », read
 * through the API's lens, read only), or the change applied in vN — and, at
 * ③, by the review's own words; a plausible line is said to be no proof that
 * the brief is met, with the way to the objectives. The line the person was
 * reading when they chose « Modifier ce réseau » (`initialFocus`, handed over
 * once) is the line in focus here, picked in the lines of the work by hand;
 * an operation or an objective that names one line puts it in focus too (its
 * changes marked in the review, in view), and a frozen scenario's operations
 * say the version they were applied in, never « non simulée ».
 *
 * The checks are "done" only for the plan the validator ran on and that the
 * person reached the delivery with; a plan changed after that makes the
 * delivery "to redo", never "to do" again.
 *
 * The verdict comes first (G3): each assistant turn opens with the engine's
 * verdict (common/VerdictCard, from the SSE `verdict` event as emitted:
 * `{ verdict, gate, prose }`), then the model's prose with the sentences the
 * verdict contradicts struck (common/ProseWithStrikes); by hand, the same
 * card reads the `verdict` of POST /transform/preview. A preview answered
 * after a newer one was asked is dropped.
 *
 * The coherence report is the simulation's, before → after, cross-checked
 * with the contract's clauses once ② is decided; it is read again before the
 * application (`beforeCommit`: the simulation is consumed by it) and kept with
 * the frozen scenario (`scenarios[].coherence`), so ④, the note and ⑤'s CSV
 * of an applied change still compare before and after — the network as it now
 * is only when no comparison was kept, said so. A refusal of the report offers
 * to simulate again or to resume (`onRecover`: the project page's
 * « Reprendre », or ① to choose the network again).
 *
 * The flow reports what it knows to the rail (`onFacts`) and writes the
 * project through `onUpdateProject` (utils/projectStore): the plan, the
 * versions, the frozen scenario.
 */

import React, { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { Accordion, AccordionDetails, AccordionSummary, Alert, Box, Button, ButtonBase, Chip, CircularProgress, Dialog, Drawer, IconButton, InputBase, LinearProgress, Menu, MenuItem, Snackbar, Tab, Tabs, TextField, Tooltip, Typography, alpha, useMediaQuery, useTheme } from "@mui/material";
import ExpandMoreIcon from "@mui/icons-material/ExpandMore";
import ArrowUpwardRoundedIcon from "@mui/icons-material/ArrowUpwardRounded";
import StopRoundedIcon from "@mui/icons-material/StopRounded";
import AttachFileRoundedIcon from "@mui/icons-material/AttachFileRounded";
import AddIcon from "@mui/icons-material/Add";
import RefreshIcon from "@mui/icons-material/Refresh";
import RestartAltIcon from "@mui/icons-material/RestartAlt";
import PlaylistAddCheckIcon from "@mui/icons-material/PlaylistAddCheck";
import CheckRoundedIcon from "@mui/icons-material/CheckRounded";
import CompareArrowsIcon from "@mui/icons-material/CompareArrows";
import FactCheckOutlinedIcon from "@mui/icons-material/FactCheckOutlined";
import DescriptionOutlinedIcon from "@mui/icons-material/DescriptionOutlined";
import TrainOutlinedIcon from "@mui/icons-material/TrainOutlined";
import MonitorHeartOutlinedIcon from "@mui/icons-material/MonitorHeartOutlined";
import MapOutlinedIcon from "@mui/icons-material/MapOutlined";
import AutoAwesomeOutlinedIcon from "@mui/icons-material/AutoAwesomeOutlined";
import FileDownloadOutlinedIcon from "@mui/icons-material/FileDownloadOutlined";
import { useLanguage } from "../../contexts/LanguageContext";
import { useEditMode } from "../../contexts/EditModeContext";
import { DRAFT_OP_EVENT, DRAFT_UNDO_EVENT, DRAFT_REDO_EVENT } from "../../utils/draftEvents";
import { retouchWordsOf } from "./DraftRetouches";
import { useExpertMode } from "../../utils/expertMode";
import { useFeatures } from "../../utils/featuresApi";
import { BRIEF_ACCEPT, uploadBriefDocument, deleteBriefDocument } from "../../utils/networkStudioApi";
import DraftRetouches from "./DraftRetouches";
import { parseOfferSheet, sheetWishes } from "../../utils/spreadsheetApi";
import { operationText, wishWords } from "../common/SpreadsheetImport";
import { fetchOperations, fetchOverview, fetchHealth, fetchStops, previewChangePlan, streamChangePlan, withParam, nextOpId } from "../../utils/transformApi";
import { EMPTY_PLAN, activate, activePlan, activeScenario, addScenario, deleteScenario, duplicateScenario, exportScenario, feedFingerprint, isPlanEmpty, loadWorkspace, workspaceKey, markApplied, parseScenarioFile, renameScenario, replaceDraft, saveDraftAs, saveWorkspace, scenarioFileName, withActivePlan } from "../../utils/changeScenarios";
import { activeScenarioOf, announceDocument, latestVersionOf, nextVersionNumber, withScenario, withScenarioFromVersion, withVersion, withoutAppliedVersion } from "../../utils/projectStore";
import { formatDateTime, formatNumber, formatYmd } from "../../utils/formatDate";
import { OperationCard, OperationDialog, ChangesPanel, ChecksPanel, ImpactStrip, SHARED_QUESTIONS, describeItem, sharedKey } from "./ChangePlanParts";
import CheckCircleRoundedIcon from "@mui/icons-material/CheckCircleRounded";
import TrackChangesRoundedIcon from "@mui/icons-material/TrackChangesRounded";
import StraightenRoundedIcon from "@mui/icons-material/StraightenRounded";
import EuroRoundedIcon from "@mui/icons-material/EuroRounded";
import DirectionsBusFilledOutlinedIcon from "@mui/icons-material/DirectionsBusFilledOutlined";
import VerifiedRoundedIcon from "@mui/icons-material/VerifiedRounded";
import DrawOutlinedIcon from "@mui/icons-material/DrawOutlined";
import SwapHorizRoundedIcon from "@mui/icons-material/SwapHorizRounded";
import CancelRoundedIcon from "@mui/icons-material/CancelRounded";
import ErrorRoundedIcon from "@mui/icons-material/ErrorRounded";
import RadioButtonUncheckedRoundedIcon from "@mui/icons-material/RadioButtonUncheckedRounded";
import { soft } from "../network/StudioUI";
import ReferencesDialog from "./ReferencesDialog";
import DiagnosticPanel from "./DiagnosticPanel";
import ChangeReview from "./ChangeReview";
import ScenarioSwitcher from "../steps/ScenarioSwitcher";
import ScenarioCompare from "./ScenarioCompare";
import ApplyDialog from "./ApplyDialog";
import { buildExampleBriefs } from "./exampleBriefs";
import { gateClauses, gateIntegrity, gateNewErrors, gateOf, gateUncovered, planStatus } from "./gate";
import { appliedNoteOf, buildSynthesisHtml, downloadSynthesis, noteSummaryOf } from "./synthesis";
import { announceValidated } from "../../utils/vouchedValidation";
import { assumptionSaid, assumptionWords } from "../../utils/assumptionWords";
import VerdictCard from "../common/VerdictCard";
import ProseWithStrikes from "../common/ProseWithStrikes";
import { useAccount } from "../../contexts/AccountContext";
import LockedAction from "../common/LockedAction";
import { coveredSentence, rememberedName } from "../common/AcknowledgementForm";
import useContract from "../common/useContract";
import { acceptAll, withEffectiveDate, hasKeptByDefault, isDecided as isClauseDecided, isReady as contractReady, MAX_CONTRACT_CLAUSES, extractionOutcome, nameOk, openDisputes, OVERFLOW_WISH, OVERFLOW_WISHES, undecidedPremises, undecidedReadings, withUnrecordedWishes, withWishIds, setAsideReasonOf } from "../../utils/contract";
import { GRID_WISH, autoAssumptionsOf, autopilotView, dayTitleQuestions, gridWishes, isGuarantee, offerToAdd, questionsOf, sourcesKeyOf, suggestionsToAdd, withAutoAnswers, withDates, withDayTitle, withDecision, withSheetOffer, withoutSheetOffer } from "../../utils/autopilot";
import { conversationBudget, keptConversation, restoredTurns } from "../../utils/conversation";
import { leftOutOf, pendingReading, sheetCheckOf } from "../../utils/briefReading";
import { estimatedTrips } from "../../utils/ridership";
import { formatDate as localDate } from "./localDates";
import { humanError } from "../../utils/humanError";
import AutopilotPanel from "./AutopilotPanel";
import AnnotatedBrief from "./AnnotatedBrief";
import useReviewKeys from "./useReviewKeys";
import { reviewOf } from "./ChangeReview";
import ChangeRecap from "./ChangeRecap";
import StepNetwork, { ProjectDocuments, retentionDaysOf } from "../steps/StepNetwork";
import { VersionList } from "../steps/StepDelivery";
import { useStepActionsSlot } from "../AppShell";
import { Workspace } from "../studio/Workspace";
import { tokensOf } from "../studio/studioTheme";
import { StepFrameInDialog, useFillLayout } from "../steps/StepFrame";
import { kindToneOf } from "./draftKinds";
import { lineColorsOf } from "./lineColors";
import TurnWork from "./TurnWork";
import { draftKindOf, routeLabelOf, routeOfClause, routeOfOperation, touchedLinesOf } from "../../utils/changeStates";
import EditOutlinedIcon from "@mui/icons-material/EditOutlined";
import ArrowBackRoundedIcon from "@mui/icons-material/ArrowBackRounded";
import MoreHorizRoundedIcon from "@mui/icons-material/MoreHorizRounded";
import DocumentDrop from "../common/DocumentDrop";
import StepObjectives, { recommendationTitle, statedFromDate } from "../steps/StepObjectives";
import ObjectivesToDo from "./ObjectivesToDo";
import { retainedIds } from "../../utils/recommendationsApi";
import StepChange, { AppliedBanner } from "../steps/StepChange";
import ManualSidebar from "./ManualSidebar";
import OfferOperations, { offerOperation } from "./OfferOperations";
import ObjectivesProgress from "./ObjectivesProgress";
import { countsAgree, objectiveCounts, objectiveResults } from "../../utils/objectiveCounts";
import { coverageOfItem, sheetCoverage } from "../../utils/sheetCoverage";
import { opTitle } from "./catalogueText";
import { framingDefaults } from "./ChangeFraming";
import { validatorTile, verdictTile } from "../steps/StepChecks";
import CoherenceReport, { CoherenceDownloadNotice, CoherenceFileButtons, CoherenceRunning, coherenceContractAdd, useCoherenceDownloads } from "../common/CoherenceReport";
import useElapsed from "../common/useElapsed";
import { coherenceForNote, contractClauses, downloadCoherenceCsv, forgetCoherence, frozenCoherence, noteCoherence } from "../../utils/coherenceApi";
import StepDelivery from "../steps/StepDelivery";

const MAX_DOCUMENTS = 5;

/** The documents a project keeps and that can still be read (not gone, kept or still in memory), as the composer holds them. */
const keptDocumentsOf = (project, now = Date.now()) =>
  (project?.documents || [])
    .filter((d) => d?.id && !d.gone && (d.kept || !(Date.parse(d.expires_at || "") <= now)))
    .slice(0, MAX_DOCUMENTS)
    .map((d) => ({ key: d.id, id: d.id, name: d.name, kind: d.kind || null, pages: d.pages ?? null, sent_to_assistant: d.sent_to_assistant !== false, status: "ready" }));
// How long the application waits for the simulation's coherence report it keeps (read at ④ or ⑤ already, most often).
const COHERENCE_CAPTURE_MS = 15000;
// The right pane's tabs and their URL slugs (/p/:id/3/operations, /p/:id/4/changements).
const TAB_SLUG = Object.freeze({ plan: "operations", map: "carte", changes: "changements", checks: "validateur" });
// A spreadsheet of the brief: read cell by cell, without the model (spreadsheet/parse) — and by the assistant too,
// where it answers: its objectives checked against its cells at ② (utils/briefReading), its timetables at ③.
const SHEET_RE = /\.(xlsx|xlsm|xls|ods|csv)$/i;
// The tone of a prose document's note at ① by the assistant's reading state (ChangeStudio's briefState): read is a
// success, being read a spinner, a question or a failure something to do; the other states are information.
const PROSE_TONE = { read: "success", reading: "running", asked: "warning", failed: "warning", locked: "warning" };
// The allowance a turn's `meta` event says (the limiter's windows, { used, limit } each, the limit null when there is
// none): the window the person reads — the day's first (the trial's cap), else the hour's; nothing without a limit.
const allowanceOf = (allowance) => {
  for (const window of ["daily", "hourly"]) {
    const w = allowance?.[window];
    if (w && Number.isFinite(w.limit) && w.limit > 0) return { window, used: Number(w.used) || 0, limit: w.limit };
  }
  return null;
};
// How long the brief stays as it is (no document sent nor read cell by cell) before the assistant reads it by itself:
// files dropped a few seconds apart are one brief, read once.
const READING_QUIET_MS = 2000;
// A turn's message as the planner reads it at most (transformPlannerService MAX_BRIEF_CHARS).
const MAX_TURN_MESSAGE = 60000;
const SLUG_TAB = Object.freeze({ operations: "plan", carte: "map", changements: "changes", validateur: "checks" });
// How long a simulation stays unchanged before the canonical validator runs on it by itself.
const AUTO_VALIDATE_MS = 1500;
// How long the plan stays unchanged before it is written into the project (the autosave's own debounce follows).
const PROJECT_PLAN_MS = 800;

/**
 * The next thing to do after the compact verdict: the status line's key in
 * the verdict's words where there is one (answer the questions, fix the
 * errors, fix or accept the objectives not met — counted, never by their
 * ids — go to delivery), else its own sentence.
 * "Go to delivery" only once the validator passed on this simulation: before
 * that the validator still has to pass, and a run that failed says so.
 */
const nextStep = (status, preview, t) => {
  switch (status.key) {
    case "transform.blocked": {
      // The questions to answer, each counted once however many operations ask it (sharedKey).
      const keys = new Set();
      // A step waiting for an earlier step of its line asks nothing yet (waiting_for).
      for (const s of preview?.steps || []) if (!(Array.isArray(s.waiting_for) && s.waiting_for.length)) (s.ambiguities || []).forEach((a, i) => keys.add(sharedKey(a) || `${s.id}|${i}`));
      return t("verdict.next.answer", { count: keys.size || status.params?.count || 1 });
    }
    case "transform.status.validatorErrors":
      return t("verdict.next.fixErrors");
    case "transform.clausesFailing": {
      // The person's objectives counted as the panel and the recap count them; the default guarantees by their name.
      const failing = gateClauses(gateOf(preview)).filter((c) => c.status === "fail");
      const own = failing.filter((c) => !isGuarantee(c)).length;
      return own ? t("verdict.next.fixClauses", { count: own }) : failing.length ? t("verdict.next.fixGuarantees", { count: failing.length }) : t(status.key, status.params);
    }
    case "transform.clausesUnknown": {
      const unknown = gateClauses(gateOf(preview)).filter((c) => c.status !== "fail");
      const own = unknown.filter((c) => !isGuarantee(c)).length;
      return own ? t(status.key, { ...status.params, count: own }) : unknown.length ? t("autopilot.line.guarantees.unknown", { count: unknown.length }) : t(status.key, status.params);
    }
    case "transform.ready": {
      if (gateOf(preview)?.validation === "passed") return t("verdict.next.ready");
      return preview?.validation?.error ? t("gtfsCheck.failed") : t("verdict.next.validate");
    }
    default:
      return t(status.key, status.params);
  }
};
const TOOL_LABEL = { lookup: "lookup", route_timetable: "timetable", reference_timetable: "timetable", set_plan: "plan", patch_plan: "plan", ask_user: "questions", estimate_ridership: "ridership", propose_optimization: "optimize", propose_clause_corrections: "corrections" };

const routeIdsKey = (overview) => (overview?.routes || []).map((r) => String(r.id)).sort().slice(0, 5).join("|");
const stamp = (iso, lang) => {
  const d = iso ? new Date(iso) : new Date();
  if (Number.isNaN(d.getTime())) return "";
  try {
    return new Intl.DateTimeFormat(`${String(lang || "en").slice(0, 2)}-u-nu-latn`, { day: "numeric", month: "long", hour: "2-digit", minute: "2-digit" }).format(d);
  } catch {
    return d.toISOString().slice(0, 16).replace("T", " ");
  }
};
const downloadText = (name, text) => {
  const blob = new Blob([text], { type: "application/json" });
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = name;
  document.body.appendChild(a);
  a.click();
  document.body.removeChild(a);
  setTimeout(() => URL.revokeObjectURL(url), 1000);
};
const readFileText = (file) =>
  typeof file.text === "function"
    ? file.text()
    : new Promise((resolve, reject) => {
        const r = new FileReader();
        r.onload = () => resolve(String(r.result || ""));
        r.onerror = () => reject(r.error || new Error("read failed"));
        r.readAsText(file);
      });

/** A cheap, stable fingerprint of a plan and its clauses: the checks (④) say which plan they judged. */
const planKeyOf = (plan) => {
  const text = JSON.stringify({ operations: plan?.operations || [], clauses: plan?.requirements?.clauses || [] });
  let h = 0;
  for (let i = 0; i < text.length; i += 1) h = (Math.imul(31, h) + text.charCodeAt(i)) | 0;
  return `${text.length}:${(h >>> 0).toString(16)}`;
};

// The rows of a kept turn's verdict that the project's copy left out (utils/conversation): counted under its card.
const rowsMoreOf = (turn) => (Number(turn?.verdict?.verdict?.failing_more) || 0) + (Number(turn?.verdict?.verdict?.unknown_more) || 0);
/**
 * Whether the assistant turn at `i` was measured exactly as the assistant turn before it (the same verdict, the same
 * gate, the same rows — the model's prose apart): a thread of questions on one plan repeats one verdict, said once as
 * a card, then in one line. A turn without a verdict yet, or the first measured one, keeps its card.
 */
export const sameVerdictAsBefore = (turns, i) => {
  const turn = turns[i];
  if (!turn?.verdict) return false;
  let k = i - 1;
  while (k >= 0 && !(turns[k].role === "assistant" && turns[k].verdict)) k -= 1;
  if (k < 0) return false;
  const key = (v) => JSON.stringify({ verdict: v.verdict ?? null, gate: v.gate ?? null, rows: v.rows ?? null, failing: v.failing ?? null, unknown: v.unknown ?? null });
  return key(turns[k].verdict) === key(turn.verdict);
};

/** An operation of the person's hand: a retouche made on the draft in the reader (captured, `row_changes`). */
export const isHand = (op) => op?.source?.kind === "hand";

export default function ChangeStudio({ project = null, step: stepProp = 3, tab: routeTab = null, onTab = null, onStep: onStepProp = () => {}, layout = "steps", view = null, onView = null, barHost = null, headerHost = null, initialKind = null, panelOpen = null, onPanelOpened = null, onLeave = null, onUpdateProject = null, onFacts = null, initialPlan = null, initialPlanMode = "replace", initialBrief = null, initialFocus = null, onHandoverTaken = null, network = null, onChooseNetwork = null, onRecover = null, onOpenReader = null, onDraft = null }) {
  const { t, language } = useLanguage();
  const theme = useTheme();
  // « draft »: the draft's one screen, of one kind (utils/changeStates draftKindOf). By hand, the screen is the reader
  // full page (GTFSApp holds it), each retouche an operation of the draft. With a brief, two columns: what is asked
  // (the documents, the objectives with their verdict, the assistant docked at the foot) beside what changes (the
  // changed lines, « Avant | Après »), the reader one click away, read only. Before the kind is chosen, the choice.
  // The bar is this studio's, drawn in the screen's head (`barHost`): the kind, the draft's ONE state, the one act it
  // calls for, « Quitter »; the decision opens in a dialog. One thing in one place.
  const panel = layout === "draft";
  const shownView = view || (panel && draftKindOf(project) === "hand" ? "network" : "change");
  // One draft per network: its other scenarios (A/B, compare, import) are the specialist's, with « Expert » on.
  const [expert] = useExpertMode();
  const scenarios = !panel || expert;
  const [panelDialog, setPanelDialog] = useState(() => (panel && panelOpen === "apply" ? panelOpen : null)); // null | "apply"
  // The assistant's thread, docked at the foot of what is asked: folded to its composer, unfolded over the column.
  const [threadOpen, setThreadOpen] = useState(false);
  // The objectives' place in the column, brought into view where a step ① or ② is asked for.
  const showObjectives = useCallback(() => {
    setThreadOpen(false);
    onView?.("change");
    setTimeout(() => document.getElementById("draft-objectives")?.scrollIntoView({ behavior: "smooth", block: "start" }), 60);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);
  useEffect(() => {
    if (!panel || !panelOpen) return;
    if (panelOpen === "apply") setPanelDialog(panelOpen);
    else showObjectives();
    onPanelOpened?.();
    // The address asks once (the reader's « Modifier » with ?ouvrir=…).
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [panel, panelOpen]);
  const step = panel ? 3 : stepProp;
  // In the draft a step is a place: ① and ② what is asked, ③ the change's view, ⑤ the decision's dialog.
  const onStep = useCallback((n) => {
    if (!panel) return onStepProp(n);
    if (n <= 2) return showObjectives();
    setPanelDialog(n >= 4 ? "apply" : null);
    if (n === 3) onView?.("change");
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [panel, onStepProp]);
  const isMobile = useMediaQuery(theme.breakpoints.down("md"));
  // A wide screen holds the operations and the map side by side (the network always in sight); narrower, two tabs.
  const wide = useMediaQuery(theme.breakpoints.up("lg"));
  const fill = useFillLayout();
  // On a desktop screen that the step fills, ① and ③ are the studio's workbench (the map in the middle); in the
  // studio's frame (its bar holds the step's actions) it runs edge to edge.
  const desk = (wide && fill) || panel;
  const inStudio = Boolean(useStepActionsSlot());
  // The supporting pane of the desk's ③: the thread (the guide by hand) first; the plan on the person's
  // own acts (an operation saved, a plan handed over), the thread again when the journey asks.
  const [supportTab, setSupportTab] = useState("assistant");
  const { editing, enterEditMode, recordEdit, undoLast, jumpToHistory, dataVersion } = useEditMode();
  // The draft's retouches (DraftRetouches) undo and jump with the edit mode's own acts.
  const retouchEdit = { editing, dataVersion, undoLast, jumpToHistory };
  // `loaded`: the server's answer landed (the defaults say « no assistant » until then: nothing is launched on them).
  const { features, loaded: featuresLoaded = true } = useFeatures();
  // The assistant's lock the server states (no Studio access on this account): said next to the composer by
  // LockedAction, the send disabled; the catalogue, the simulation and "Apply" stay open (the journey by hand).
  const { studioLock, signedIn } = useAccount();
  const assistantLock = features?.access?.studio === "entitlement_required" ? studioLock : null;
  // A tier the server would refuse (no access code and no free message: "paid", or the assistant not served) is no
  // assistant here either: a turn launched by the journey itself must never end on a refusal the person did not ask for.
  const aiEnabled = Boolean(features?.chat?.enabled) && !assistantLock && !["paid", "unavailable"].includes(features?.access?.studio);
  // Without the assistant, ③ is the work by hand (ManualSidebar): read by the plan's panel as well as the sidebar.
  const manual = !aiEnabled;
  // ③'s plan aside on a desktop screen, folded by default where the assistant builds the change, open on demand for
  // the expert hand: the assistant's column and the lines changed are what the person reads; the operations open on demand (`change-plan-toggle`), and by themselves
  // when the person writes one by hand. By hand the plan is the person's work: open from the start.
  // Under the free trial every turn spends one of the person's few messages: the journey launches none by itself
  // there (the reading of the brief, its proposals, the change's own turn are each one explicit act).
  const autonomous = aiEnabled && !(features?.access?.studio && typeof features.access.studio === "object" && features.access.studio.trial_left != null);

  const [catalogue, setCatalogue] = useState([]);
  const [catalogueLoaded, setCatalogueLoaded] = useState(false);
  const [overview, setOverview] = useState(null);
  const [health, setHealth] = useState(null);
  const [stops, setStops] = useState(null);
  const [plan, setPlan] = useState(EMPTY_PLAN);
  const [preview, setPreview] = useState(null);
  const [previewing, setPreviewing] = useState(false);
  const [validating, setValidating] = useState(false);
  // The validator's own request failed (no answer came back): said by the panel, with a way to run it again — never a
  // spinner for ever.
  const [validateFailed, setValidateFailed] = useState(false);
  // The journey's own planner turn, as it ended (plannedRef: written where the autopilot's state lives, below).
  const plannedRef = useRef(null);
  const validateSeconds = useElapsed(validating);
  // The conversation with the planner, as the project kept it (context.conversation, utils/conversation): what the
  // assistant said, asked and was answered comes back when the project is opened again. `conversationSync`: the copy
  // this studio last restored or wrote (its JSON) and how many of the turns held here it covers — a newer copy written
  // elsewhere (another device, read from the server after this one opened on its cache) is taken, never written over.
  const [openedConversation] = useState(() => ({ turns: restoredTurns(project?.context?.conversation), key: JSON.stringify(project?.context?.conversation ?? null) }));
  const [turns, setTurns] = useState(openedConversation.turns);
  const conversationSync = useRef({ key: openedConversation.key, seen: openedConversation.key, count: openedConversation.turns.length });
  // The conversation could not be kept with the project (it is at its size limit): said here while it lasts.
  const [conversationNotKept, setConversationNotKept] = useState(false);
  // Only the last answer of the assistant takes an answer to its questions, once each: an older turn's question (kept
  // with the project, its operation renumbered since) or one already answered is shown as it was, never sent again.
  const answeringTurn = turns.map((x) => x.role).lastIndexOf("assistant");
  const [input, setInput] = useState("");
  const [streaming, setStreaming] = useState(false);
  // The brief's documents: those the project keeps (uploaded at ①, or in an earlier visit) are cited like the new ones.
  const [documents, setDocuments] = useState(() => keptDocumentsOf(project));
  // The draft's first view, until the person picks one: « Changement » where there is a brief, a conversation or the
  // planner's work to read; else the reader (« Modifier » from it: the retouches by hand). A turn launched shows its work.
  // The draft's kind, and the view it shows: by hand the reader, with a brief (or to choose) the change.
  const kind = panel ? draftKindOf(project) : null;
  useEffect(() => {
    if (!panel) return;
    onView?.(kind === "hand" ? "network" : "change");
    // The kind leads the view; « Pleine largeur » and the header's tabs show the reader in between.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [panel, kind]);
  useEffect(() => {
    if (panel && streaming) onView?.("change");
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [panel, streaming]);
  const [demandDataIds, setDemandDataIds] = useState([]); // the ridership data uploaded on the Diagnostic tab: the planner calibrates on it too
  // The right pane's tab: ③ Operations · Map, ④ Checks · Changes — the route's when it names one (/p/:id/3/carte).
  const [paneTab, setPaneTab] = useState("plan");
  const [checksTab, setChecksTab] = useState("checks");
  const routed = routeTab ? SLUG_TAB[routeTab] || null : null;
  const tab = step >= 4 ? (routed === "changes" || routed === "checks" ? routed : checksTab) : routed === "map" || routed === "plan" ? routed : paneTab;
  const setTab = useCallback(
    (next) => {
      if (next === "checks" || next === "changes") setChecksTab(next);
      else setPaneTab(next === "map" ? "map" : "plan");
      onTab?.(TAB_SLUG[next] || null);
    },
    [onTab],
  );
  const [dialog, setDialog] = useState(null); // { initial } for add/edit
  // The line in focus (a route id): picked first by hand (ManualSidebar's LinePicker), carried from the reader
  // (`initialFocus`), or put in focus by an operation or an objective — drawn in front on the maps.
  const [lineFocus, setLineFocus] = useState(() => (initialFocus ? String(initialFocus) : null));
  const [refsOpen, setRefsOpen] = useState(false);
  const [applyState, setApplyState] = useState({ canApply: false, busy: false, blocking: false, toAccept: false });
  const applyRef = useRef(null);
  const [undoing, setUndoing] = useState(false);
  // What was applied here: { editId, n } (the project's version, else this page's own record).
  const [appliedLocal, setAppliedLocal] = useState(null);
  const frozenRef = useRef(false);
  // The simulation's coherence report read just before the application (frozenCoherence), kept with the frozen scenario.
  const appliedCoherenceRef = useRef(null);
  const coherenceDownloads = useCoherenceDownloads();
  const [compareOpen, setCompareOpen] = useState(false);
  const [error, setError] = useState(null);
  const [ws, setWs] = useState(null); // the plans kept for this feed (utils/changeScenarios)
  const [notice, setNotice] = useState(null); // { kind, severity, params }
  const [briefBanner, setBriefBanner] = useState(false);
  // A reading of the brief by the assistant that failed: said at ②, where the brief is read (never only in ③'s conversation).
  const [extractError, setExtractError] = useState(null);
  // The spreadsheets being read cell by cell right now (their names): ② and ③ say so while it lasts.
  const [readingSheets, setReadingSheets] = useState([]);
  // When a document of the brief was last sent or read cell by cell in this visit (the reading waits a moment after).
  const briefArrivedAt = useRef(0);
  const abortRef = useRef(null);
  const fileRef = useRef(null);
  const scrollRef = useRef(null);
  const wsRef = useRef(null);
  const planRef = useRef(plan);
  const previewSeq = useRef(0); // the latest preview asked: an older answer never replaces a newer one
  const autoValidated = useRef(null); // the preview the validator already ran on by itself
  const hydrated = useRef({ fp: null, ids: null });
  const handedOver = useRef(null);
  // Operations handed to join the plan (« Ajouter au changement ») before the plans kept for this feed were read.
  const handedToAppend = useRef(null);
  const withAppended = (base, ops) => {
    let next = base && Array.isArray(base.operations) ? base : EMPTY_PLAN;
    for (const op of ops) next = { ...next, operations: [...next.operations, { ...op, id: nextOpId(next) }] };
    return next;
  };
  const storageWarned = useRef(false);
  planRef.current = plan;
  // The project's active scenario, read by the effects below (a frozen one carries the plan it was applied with).
  const projectScenarioRef = useRef(null);
  projectScenarioRef.current = activeScenarioOf(project);
  // The plan the canonical validator ran on, and the plan the person reached ④ with (planKeyOf): the rail's ④.
  const [validatedKey, setValidatedKey] = useState(null);
  const [checksKey, setChecksKey] = useState(null);
  // The project's contract, with the two « inchangé » clauses a modification starts with: nothing
  // is drafted by the assistant before it is decided, assumed or recorded empty; it travels with every turn and every
  // simulation once ready (the server merges it into the plan's requirements: a decided clause is the person's).
  const readyDocumentIds = documents.filter((d) => d.status === "ready" && d.id).map((d) => d.id);
  // The prose documents of the brief (PDF, Word, text): what the assistant reads first; the spreadsheets are read cell
  // by cell without it, and by it as said below. One the person kept from the assistant (joined while it was closed:
  // « non envoyé ») is never handed to it.
  const proseDocumentIds = documents.filter((d) => d.status === "ready" && d.id && !SHEET_RE.test(d.name || "") && d.sent_to_assistant !== false).map((d) => d.id);
  // A spreadsheet the reader understood less than half of (a layout it does not know: a transposed timetable, a
  // free-form list), or nothing of: the assistant reads it too, where it answers — its cells turned into operations,
  // each citing them, checked by the engine like any other. A sheet read well keeps its unread cells as points to
  // check by hand (and, with the assistant, as remarks its turn reads); the turn at ③ reads it too (sheetsToCheck). A
  // table the reader set aside as unsure (a grid it could read either way: `unsure`, never read the wrong way round)
  // hands its sheet to the assistant whatever the rest reads.
  const sheetsForAssistant = documents.filter((d) => {
    const x = d.status === "ready" && d.id && SHEET_RE.test(d.name || "") && d.sent_to_assistant !== false ? project?.context?.sheets?.[d.name] : null;
    return Boolean(x && ((x.unread > 0 && (!x.read || x.unread >= x.read || !(x.operations || x.clauses))) || x.unsure > 0));
  });
  // What the assistant reads of the brief: the prose documents and those spreadsheets.
  const assistantDocumentIds = [...proseDocumentIds, ...sheetsForAssistant.map((d) => d.id)];
  // What the reading of the brief at ② sends: every document the assistant may read, prose and spreadsheets alike,
  // read cell by cell or not (the cell reader can take a grid the wrong way: the assistant checks the objectives it
  // read against their cells, utils/briefReading). The prose first, then the sheets the reader understood least
  // (under half, none read here), then the others: the server carries the first ones when they are too long together
  // for one message and names none it leaves out — the reading's record does (`left_out`, read again on their own).
  const forReading = documents.filter((d) => d.status === "ready" && d.id && d.sent_to_assistant !== false);
  const readingDocumentIds = [...new Set([...assistantDocumentIds, ...forReading.filter((d) => !project?.context?.sheets?.[d.name]).map((d) => d.id), ...forReading.map((d) => d.id)])];
  // The spreadsheets the reader did read: the journey's own turn at ③ checks its pinned timetables against them
  // (each names the cells it was read from) and builds what they do not cover — every sheet of the brief is the
  // assistant's to read there, where it answers, as at ② (where it checks the objectives read from them). Without the
  // assistant, or under the free trial (no turn launched by itself), they wait for nothing: read cell by cell, they
  // never hold the journey as a brief left unread.
  const sheetsToCheck = autonomous ? documents.filter((d) => d.status === "ready" && d.id && SHEET_RE.test(d.name || "") && d.sent_to_assistant !== false && project?.context?.sheets?.[d.name] && !sheetsForAssistant.includes(d)) : [];
  const turnDocumentIds = [...assistantDocumentIds, ...sheetsToCheck.map((d) => d.id)];
  // The contract's coverage is measured where the objectives are read: ① (which embeds them) and ②.
  const contractState = useContract({ project, onUpdateProject, job: "modify", active: step === 1 || step === 2, documents: readyDocumentIds });
  // ②'s act, run by ①'s one primary action when the objectives' body is embedded there (StepObjectives `embedded`).
  const objectivesRef = useRef(null);
  const contract = contractState.contract;
  // The brief typed at ② is the contract's (contract.brief: kept with the project, read by the server on every
  // simulation and at the commit); until something is typed there, the field shows the extraction's, or the message.
  const contractBrief = typeof contract.brief === "string" ? contract.brief : contract.extracted?.note || input || "";
  // What a simulation sends of the contract: the contract once ready (an empty one too: the verdict says how many
  // requirement sentences no clause answers) — and, from the draft on, the two « inchangé » clauses ② shows kept
  // by default: a plan written by hand is measured against them from its first simulation, never applied unsaid.
  const contractArgsKey = contractReady(contract) || hasKeptByDefault(contract) ? JSON.stringify({ contract, documents: [...new Set([...readyDocumentIds, ...contractState.documentIds])], ...(demandDataIds.length ? { dataIds: demandDataIds } : {}) }) : "{}";
  const contractArgsRef = useRef({});
  contractArgsRef.current = JSON.parse(contractArgsKey);

  const routes = overview?.routes || [];
  const fp = useMemo(() => feedFingerprint(overview), [overview]);
  // The browser's draft is this project's own on this network (two projects on one network never share it).
  const wsKey = workspaceKey(fp, project?.id || null);
  const networkOpen = Boolean(overview && !overview.failed);
  // A brief given (a document, typed words, an extraction, an objective of the person's): ② reads it; without one the
  // change can start at once (a punctual change: ② stays offered, its objectives measured on the network).
  const briefGiven = documents.length > 0 || (project?.documents || []).length > 0 || Boolean(contractState.offer) || Boolean(String(contract.brief || "").trim()) || Boolean(contract.extracted) || (contract.clauses || []).some((c) => c?.source?.kind !== "recommendation" && !c?.keep_by_default);
  const lang = String(language || "en").slice(0, 2);
  useEffect(() => {
    // Unreadable overview: no fingerprint (plans kept in memory only), generic examples.
    fetchOverview()
      .then(setOverview)
      .catch(() => setOverview({ counts: null, range: null, routes: [], failed: true }));
    // The feed as it is now, on the yardstick every preview compares against.
    fetchHealth()
      .then(setHealth)
      .catch(() => setHealth(null));
    setStops(null);
  }, []);
  useEffect(() => {
    fetchOperations({ lang })
      .then((d) => setCatalogue(d.operations || []))
      .catch(() => setCatalogue([]))
      .finally(() => setCatalogueLoaded(true));
  }, [lang]);
  useEffect(() => {
    scrollRef.current?.scrollTo?.({ top: scrollRef.current.scrollHeight, behavior: "smooth" });
  }, [turns]);

  const refresh = useCallback(
    async (next, { validate = false } = {}) => {
      if (!next?.operations?.length) {
        // Nothing to simulate: an answer still in flight for an older plan is dropped.
        previewSeq.current += 1;
        setPreviewing(false);
        setValidating(false);
        setPreview(null);
        return null;
      }
      setError(null);
      setValidateFailed(false);
      const seq = ++previewSeq.current;
      setValidating(validate);
      setPreviewing(!validate);
      try {
        // `auto`: the engine settles by itself the questions that carry their own answer (the line's own running
        // times, a stop whose name reads as one stop of the line, a few days without service left as they are…),
        // writes each in its operation and records it as an assumption the person validates at the delivery — the
        // plan held here becomes the one the simulation describes (utils/autopilot.withAutoAnswers). Only while this
        // simulation is still the latest: every other write of the plan bumps the sequence (dropSimulations).
        const p = await previewChangePlan(next, { validate, language: lang, auto: true, ...contractArgsRef.current });
        // (A scenario applied meanwhile is frozen: an answer computed on the network it changed is never its own.)
        if (seq === previewSeq.current && !frozenRef.current) {
          const settled = withAutoAnswers(next, p?.auto);
          if (settled !== next) setPlan(settled);
          setPreview(p);
          if (p?.validation && !p.validation.error) setValidatedKey(planKeyOf(settled));
        }
        return p;
      } catch (err) {
        if (seq === previewSeq.current) {
          setError(err.message);
          if (validate) setValidateFailed(true);
        }
        return null;
      } finally {
        if (seq === previewSeq.current) {
          setPreviewing(false);
          setValidating(false);
        }
      }
    },
    [lang],
  );

  // The plan written without a simulation of its own (emptied, replaced by the planner's, read back frozen): an answer
  // still in flight describes another plan, and is dropped — its simulation and the answers the engine wrote in it.
  const dropSimulations = useCallback(() => {
    previewSeq.current += 1;
    setPreviewing(false);
    setValidating(false);
  }, []);

  // ── The plans kept for this feed ──
  const commitWs = useCallback(
    (next, { save = true } = {}) => {
      wsRef.current = next;
      setWs(next);
      if (!save || !fp) return;
      const out = saveWorkspace(wsKey, next);
      if (!out.ok && out.error !== "NO_STORAGE" && !storageWarned.current) {
        storageWarned.current = true;
        setNotice({ kind: "storage", severity: "warning" });
      }
    },
    [fp, wsKey],
  );
  const showPlan = useCallback(
    (next, { keepPreview = false } = {}) => {
      setPlan(next);
      if (!keepPreview) {
        setPreview(null);
        refresh(next);
      }
      // The plan read back at the mount, or shown by a scenario's act (made on the plan's own tab): the narrow pane
      // shows it; on the desk the pane stays where the person is.
      if (!desk) setTab("plan");
    },
    [refresh, setTab, desk],
  );

  // On opening (or when the feed changed): the plans kept for it.
  useEffect(() => {
    if (!fp || hydrated.current.fp === fp) return;
    const ids = routeIdsKey(overview);
    const sameNetwork = hydrated.current.ids === ids;
    const first = hydrated.current.fp === null;
    hydrated.current = { fp, ids };
    let next = loadWorkspace(wsKey);
    const current = planRef.current;
    const keepAs = t("transform.scenario.previousDraft", { date: stamp(null, lang) });
    const own = projectScenarioRef.current;
    if (own?.applied_version_id && !isPlanEmpty(own.plan)) {
      // Frozen "applied in vN": the plan it was applied with, from the project, read only — never simulated
      // again (a second simulation of the same operations on vN would apply them twice).
      commitWs(next, { save: false });
      dropSimulations();
      setPlan(own.plan);
      setPreview(null);
      return;
    }
    if (handedToAppend.current) {
      // Operations handed to join the plan while it was not read yet: the plan kept (else the project's), then them.
      const stored0 = activePlan(next);
      const base = !isPlanEmpty(stored0) ? stored0 : !isPlanEmpty(own?.plan) ? own.plan : current;
      const merged = withAppended(base, handedToAppend.current);
      handedToAppend.current = null;
      commitWs(withActivePlan(next, merged));
      showPlan(merged);
      return;
    }
    if (handedOver.current) {
      // A plan handed over (the chat) becomes the draft; a previous draft is kept as a scenario.
      next = replaceDraft(next, handedOver.current, { keepAs });
      handedOver.current = null;
      commitWs(next);
      return;
    }
    const stored = activePlan(next);
    if (!isPlanEmpty(current) && (first || sameNetwork)) {
      // The same network changed while a plan was open (or a plan was started before the feed was read): it stays.
      next = replaceDraft(activate(next, null), current, { keepAs });
      commitWs(next);
      if (!first) setNotice({ kind: "carried", severity: "info" });
      return;
    }
    commitWs(next, { save: false });
    if (!isPlanEmpty(stored)) {
      showPlan(stored);
      const s = activeScenario(next);
      setNotice({ kind: "restored", severity: "info", params: { name: s ? s.name : t("transform.scenario.draft"), date: stamp(s ? s.updated_at : next.draft.updated_at, lang) } });
    } else if (!isPlanEmpty(own?.plan)) {
      // Nothing kept for this feed (an application changed it): the project's scenario — a new scenario on vN
      // copied from the frozen one — is the plan, simulated on the network as it is now.
      showPlan(own.plan);
    } else if (!isPlanEmpty(current)) {
      dropSimulations();
      setPlan(EMPTY_PLAN);
      setPreview(null);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [fp]);

  // A frozen scenario opens on the plan it was applied with, from the project, even when the feed cannot be read
  // (no fingerprint, no workspace): its operations stay listed, read only, and are never simulated again.
  useEffect(() => {
    const own = projectScenarioRef.current;
    if (own?.applied_version_id && !isPlanEmpty(own.plan) && isPlanEmpty(planRef.current)) {
      setPlan(own.plan);
      setPreview(null);
    }
  }, []);

  // A plan handed over (e.g. by the chat assistant) replaces the current one — or, handed to the project that already
  // works on the network (« Ajouter au changement »), joins its operations, each under an id of its own.
  useEffect(() => {
    if (!initialPlan || !Array.isArray(initialPlan.operations)) return;
    if (initialPlanMode === "append" && !frozenRef.current) {
      // The plans kept for this feed not read yet (the step just mounted): they are read first, then joined.
      if (!(fp && hydrated.current.fp === fp && wsRef.current)) handedToAppend.current = initialPlan.operations;
      else {
        const next = withAppended(planRef.current, initialPlan.operations);
        setPlan(next);
        setTab("plan");
        setSupportTab("plan");
        refresh(next);
      }
      onHandoverTaken?.();
      return;
    }
    if (fp && hydrated.current.fp === fp && wsRef.current) commitWs(replaceDraft(wsRef.current, initialPlan, { keepAs: t("transform.scenario.previousDraft", { date: stamp(null, lang) }) }));
    else handedOver.current = initialPlan;
    setPlan(initialPlan);
    setTab("plan");
    setSupportTab("plan");
    refresh(initialPlan);
    onHandoverTaken?.();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [initialPlan]);

  // The line the reader was showing, handed over with « Modifier ce réseau »: in focus, taken once.
  useEffect(() => {
    if (!initialFocus) return;
    setLineFocus(String(initialFocus));
    if (!initialPlan && !initialBrief) onHandoverTaken?.();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [initialFocus]);

  // A request handed over by the Network Studio: in the composer, never sent on its own.
  useEffect(() => {
    if (typeof initialBrief !== "string" || !initialBrief.trim()) return;
    setInput(initialBrief);
    setBriefBanner(true);
    onHandoverTaken?.();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [initialBrief]);

  // The working plan is saved as it changes.
  useEffect(() => {
    if (!fp || hydrated.current.fp !== fp || !wsRef.current) return;
    // A frozen plan is the project's record, not a draft of this feed.
    if (frozenRef.current) return;
    if (activePlan(wsRef.current) === plan) return;
    commitWs(withActivePlan(wsRef.current, plan));
  }, [plan, fp, commitWs]);

  // …and into the project, which the server keeps (scenarios[active].plan): the step's work survives another
  // device or a cleared cache before any application. Never over a frozen scenario (its plan is the record of vN),
  // never before the plans of this network were read (the project's plan is what an empty browser opens on). A write
  // still waiting when the studio closes (an explorer round trip, another page) is made at once, never dropped.
  const closing = useRef(false);
  useEffect(() => {
    closing.current = false;
    // Declared before the write below: on unmount this runs first, so the write's cleanup knows the studio closes.
    return () => {
      closing.current = true;
    };
  }, []);
  useEffect(() => {
    if (!project || !onUpdateProject || frozenRef.current) return undefined;
    if (!hydrated.current.fp && isPlanEmpty(plan)) return undefined;
    const own = projectScenarioRef.current;
    if (!own || own.applied_version_id) return undefined;
    const next = isPlanEmpty(plan) ? null : plan;
    if (JSON.stringify(own.plan ?? null) === JSON.stringify(next)) return undefined;
    const write = () =>
      onUpdateProject((p) => {
        const active = activeScenarioOf(p);
        if (!active || active.applied_version_id || JSON.stringify(active.plan ?? null) === JSON.stringify(next)) return p;
        return withScenario(p, { plan: next });
      });
    const timer = setTimeout(write, PROJECT_PLAN_MS);
    return () => {
      clearTimeout(timer);
      if (closing.current) write();
    };
    // The project is read through its ref: only a new plan is a write.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [plan]);

  // A decision at ② changes what the simulation measures: the plan is simulated again with the contract as it now is.
  const contractSeen = useRef(contractArgsKey);
  useEffect(() => {
    if (contractSeen.current === contractArgsKey) return;
    contractSeen.current = contractArgsKey;
    if (!frozenRef.current && planRef.current?.operations?.length) refresh(planRef.current);
  }, [contractArgsKey, refresh]);

  const updatePlan = useCallback(
    (next) => {
      // A plan filled by the journey itself shows in the narrow pane's tab; on the desk the thread stays forward
      // (the supporting pane switches on the person's own acts only).
      if (!desk && isPlanEmpty(planRef.current) && !isPlanEmpty(next)) setTab("plan");
      setPlan(next);
      refresh(next);
    },
    [refresh, setTab, desk],
  );

  // ── The hand's retouches on the draft (the reader's editors, captured by the API: transform/draftCapture) ──
  // Each one arrives as a `row_changes` operation (DRAFT_OP_EVENT): appended to the plan with its words (the journal
  // line its endpoint wrote: « Modifié · stop BRY »), marked as the hand's (`source.kind: "hand"`), and the draft
  // simulated again — the reader then shows it through the lens. Undo takes the last one back (kept to be put back by
  // redo, until another retouche arrives); removing any of them from the list is removing an operation.
  const handRedo = useRef([]);
  useEffect(() => {
    if (!panel) return undefined;
    const onOp = (e) => {
      const { op, entry } = e?.detail || {};
      if (!op || frozenRef.current) return;
      const current = planRef.current;
      const label = entry ? retouchWordsOf(entry, t) : t("panel.hand.default");
      handRedo.current = [];
      updatePlan({ ...current, operations: [...current.operations, { id: nextOpId(current), type: op.type, label, params: { ...(op.params || {}), label: "" }, source: { kind: "hand", entity: entry?.entity || null, action: entry?.action || null } }] });
      setSupportTab("plan");
    };
    const onUndo = () => {
      const current = planRef.current;
      const last = [...current.operations].reverse().find(isHand);
      if (!last || frozenRef.current) return;
      handRedo.current.push(last);
      updatePlan({ ...current, operations: current.operations.filter((o) => o.id !== last.id) });
    };
    const onRedo = () => {
      const back = handRedo.current.pop();
      if (!back || frozenRef.current) return;
      const current = planRef.current;
      updatePlan({ ...current, operations: [...current.operations, { ...back, id: nextOpId(current) }] });
    };
    window.addEventListener(DRAFT_OP_EVENT, onOp);
    window.addEventListener(DRAFT_UNDO_EVENT, onUndo);
    window.addEventListener(DRAFT_REDO_EVENT, onRedo);
    return () => {
      window.removeEventListener(DRAFT_OP_EVENT, onOp);
      window.removeEventListener(DRAFT_UNDO_EVENT, onUndo);
      window.removeEventListener(DRAFT_REDO_EVENT, onRedo);
    };
  }, [panel, updatePlan, t]);

  // ── The planner ──
  const runPlanner = useCallback(
    // `documentIds`: the documents this turn reads, in place of every ready one (a reading of the brief: the documents
    // the assistant may read, in the reading's order — or, `only`, those a reading before could not carry). `check`:
    // what the reading's message adds for the assistant alone (utils/briefReading sheetCheckOf: the spreadsheets'
    // objectives to check against their cells) — the conversation shows, and the contract keeps as the reading's note,
    // the words without it. `autopilot`: the turn the journey launches by itself at ③ (no message typed: said as such
    // in the conversation, and the engine settles its own questions).
    // `plan`: the plan this turn is sent with instead of the current one.
    async (text, { extract = false, documentIds = null, autopilot = false, check = null, only = false, plan: planOverride = null } = {}) => {
      const brief = String(text || "").trim();
      if (!brief || streaming) return;
      // The message as the assistant reads it (the server reads 60 000 characters of it at most: past that, no check).
      const told = check?.text && brief.length + check.text.length + 2 <= MAX_TURN_MESSAGE ? `${brief}\n\n${check.text}` : brief;
      if (!autopilot) setInput("");
      setBriefBanner(false);
      setError(null);
      if (extract) setExtractError(null);
      const history = turns.filter((x) => x.text).map((x) => ({ role: x.role, content: x.text }));
      setTurns((ts) => [...ts, { role: "user", text: brief, ...(autopilot ? { auto: true } : {}) }, { role: "assistant", text: "", steps: [], questions: [], pending: null, ...(autopilot ? { auto: true } : {}) }]);
      const patchLast = (fn) => setTurns((ts) => ts.map((x, i) => (i === ts.length - 1 ? fn(x) : x)));
      const abort = new AbortController();
      abortRef.current = abort;
      setStreaming(true);
      // The plan the planner's simulation describes: its last `plan` event, else the plan it was sent. The hand's
      // retouches are not sent (their rows are the person's, nothing for the planner to reason on): its plan gets them
      // back after its own operations, and the draft is simulated again with them once the turn ends.
      const handOps = (planOverride || plan).operations.filter(isHand);
      const sentPlan = handOps.length ? { ...(planOverride || plan), operations: (planOverride || plan).operations.filter((o) => !isHand(o)) } : planOverride || plan;
      let turnPlan = sentPlan;
      const withHand = (p) => (handOps.length && p?.operations ? { ...p, operations: [...p.operations.filter((o) => !isHand(o)), ...handOps.map((o, i) => ({ ...o, id: nextOpId({ operations: [...p.operations, ...handOps.slice(0, i)] }) }))] } : p);
      let failed = false;
      const sent = Array.isArray(documentIds) ? documentIds : documents.filter((d) => d.status === "ready").map((d) => d.id);
      try {
        await streamChangePlan({
          brief: told,
          plan: sentPlan.operations.length ? sentPlan : null,
          messages: history,
          language,
          documents: sent,
          dataIds: demandDataIds,
          // A draft (or « Extraire » at ②) makes this turn the extraction: the server drafts no operation then.
          contract: extract ? { ...contract, status: "draft" } : contract,
          autopilot: Boolean(autopilot) && !extract,
          // Every planning turn of this journey settles like its simulations (the engine's own answers, each recorded).
          auto: !extract,
          signal: abort.signal,
          onEvent: (event, data) => {
            if (event === "token") patchLast((x) => ({ ...x, text: x.text + (data.text || "") }));
            // The extraction's answer: the draft contract ② decides (the person's decisions kept), nothing drafted.
            // Its record keeps the person's words as its note (never the check the message added) and the documents
            // it was given and could not read (`left_out`: past one message's length, or gone from the server — which
            // its record may name: `too_long`, `missing`): ② says them; read again on their own by themselves only when
            // the server left them out for their length, else by the person's act (pendingReading). What it states
            // again of the spreadsheets' objectives goes, what it reads otherwise is a dispute (withExtraction).
            else if (event === "contract") {
              const draft = data?.contract || null;
              const names = Object.fromEntries(documents.filter((d) => d.id).map((d) => [d.id, d.name]));
              const left = draft?.extracted ? leftOutOf(sent, draft.extracted.documents || [], { names, only, missing: draft.extracted.missing, tooLong: draft.extracted.too_long }) : [];
              // (A reading of left-out documents alone keeps the earlier proposals of the others, and their note: `partial`.)
              const note = only && typeof contract.extracted?.note === "string" ? contract.extracted.note : brief;
              const merged = draft?.extracted ? { ...draft, extracted: { ...draft.extracted, note, left_out: left, ...(only ? { partial: true } : {}) } } : draft;
              if (draft) contractState.fromExtraction(merged);
              // The turn's card says what the reading found: its objectives (the ones it stated again of an objective
              // held left out), the sheets' objectives it checked and read otherwise, the documents it could not read.
              // The sentences of the check itself (the server measured them in the message) are no sentence of the brief.
              const checked = extractionOutcome(contract, merged);
              const ofCheck = (s) => Boolean(check?.text) && s?.source === "brief" && check.text.includes(String(s?.text || "").trim().slice(0, 80));
              patchLast((x) => ({ ...x, extracted: { clauses: checked.clauses.length, wishes: (draft?.wishes || []).length, uncovered: (data?.coverage?.uncovered || []).filter((s) => !ofCheck(s)).length, ...(check?.count && told !== brief ? { checked: check.count } : {}), ...(checked.disputes ? { disputed: checked.disputes } : {}), ...(left.length ? { left: left.map((d) => d.name || d.id) } : {}) } }));
            }
            else if (event === "tool_pending") patchLast((x) => ({ ...x, pending: data.name }));
            // What it just read or wrote, in one line each (the wait screen): the last twenty kept on the turn.
            else if (event === "tool") patchLast((x) => ({ ...x, tools: [...(x.tools || []).slice(-19), { ...data, at: Date.now() }] }));
            // The model's answer was cut in its stream and is sent again (llm/streamRound): the words so far were
            // not the answer, the chip says the new attempt.
            else if (event === "retry") patchLast((x) => ({ ...x, text: "", pending: null, steps: [...x.steps, { kind: "retry", attempt: data?.attempt ?? 1, max: data?.max ?? 0 }] }));
            // The turn's budget is spent (llm/turnBudget): the model closes with what it has, the turn ends incomplete.
            else if (event === "budget") patchLast((x) => ({ ...x, steps: [...x.steps, { kind: "budget" }] }));
            // The independent audit of the plan (transform/planAudit): what it found, or that it could not run.
            else if (event === "audit") patchLast((x) => ({ ...x, steps: [...x.steps, { kind: "audit", skipped: Boolean(data?.skipped), ...(data?.counts || {}), findings: (Array.isArray(data?.findings) ? data.findings : []).filter((f) => f && f.status !== "met").slice(0, 8).map((f) => ({ status: f.status, quote: String(f.quote || ""), why: String(f.why || "") })) }] }));
            // The engine refused the plan the turn proposed (llm/selfCorrection): the words so far are superseded (kept,
            // muted), the correction said; escalated, the engine's own questions follow (`questions`).
            else if (event === "correction") {
              patchLast((x) => ({
                ...x,
                superseded: data?.phase === "retry" && x.text ? [...(x.superseded || []), x.text] : x.superseded || [],
                text: data?.phase === "retry" ? "" : x.text,
                steps: [...x.steps, { kind: data?.phase === "escalated" ? "correctionEscalated" : "correction", attempt: data?.attempt ?? 0, max: data?.max ?? 0 }],
              }));
            }
            else if (event === "plan") {
              // The network's own answers (its school zone, its country) are the plan's, whatever the planner rewrote.
              const kept = { ...(plan.region && !data?.region ? { region: plan.region } : {}), ...(plan.country && !data?.country ? { country: plan.country } : {}) };
              const written = withHand(Object.keys(kept).length ? { ...data, ...kept } : data);
              turnPlan = written;
              // The planner's plan replaces the one a simulation may still be describing; its own simulation follows.
              dropSimulations();
              setPlan(written);
              patchLast((x) => ({ ...x, pending: null, steps: [...x.steps, { kind: "plan", count: written.operations?.length || 0 }] }));
            } else if (event === "preview") {
              // Without the hand's retouches, the planner's simulation is not the draft's: simulated again at the end.
              if (handOps.length) return;
              // The planner's simulation supersedes any preview still in flight (and its spinner).
              previewSeq.current += 1;
              setPreviewing(false);
              setValidating(false);
              setPreview(data);
              if (data?.validation && !data.validation.error) setValidatedKey(planKeyOf(turnPlan));
              if (!desk) setTab("plan");
            }
            // The engine's verdict on this turn, as emitted ({ verdict, gate, prose }): the turn opens with it, and the
            // planner's preview (which the event describes) carries it for the status line and the checks.
            else if (event === "verdict") {
              patchLast((x) => ({ ...x, verdict: data }));
              setPreview((p) => (p && p.verdict === undefined ? { ...p, verdict: data?.verdict ?? null } : p));
            } else if (event === "questions") patchLast((x) => ({ ...x, questions: data.questions || [] }));
            // A free-trial turn runs on a lighter model: its plan is a first sketch.
            // …and what the turn costs the person: the assistant's allowance for their key (the limiter's windows, this
            // turn counted), said on the turn's card where a finite limit stands.
            else if (event === "meta") {
              patchLast((x) => ({ ...x, ...(data?.trial ? { trial: true } : {}), ...(data?.allowance ? { allowance: data.allowance } : {}) }));
            }
            // The ridership estimate and the optimiser's proposal the planner worked from (estimates, never counts);
            // an estimate of no trip at all is none: said unavailable, never « ≈ 0 voyages » (utils/ridership).
            else if (event === "demand") {
              const trips = estimatedTrips(data?.estimate);
              if (data?.estimate) patchLast((x) => ({ ...x, pending: null, steps: [...x.steps, trips != null ? { kind: "demand", trips, calibrated: Boolean(data.estimate.calibrated), uncertainty: data.estimate.uncertainty || null } : { kind: "demandUnavailable" }] }));
            } else if (event === "optimization") patchLast((x) => ({ ...x, pending: null, steps: [...x.steps, { kind: "optimization", count: (data?.plan?.operations || []).length }] }));
            else if (event === "error") {
              failed = true;
              patchLast((x) => ({ ...x, error: data.message || data.code }));
              // A reading of the brief that failed is said where the brief is read (②), with a way to ask again.
              if (extract) setExtractError({ code: data.code || null, message: data.message || data.code || "" });
            } else if (event === "done") patchLast((x) => ({ ...x, pending: null, done: data, steps: data?.corrections?.resolved && data.corrections.attempts > 0 ? [...x.steps, { kind: "correctionResolved", attempts: data.corrections.attempts }] : x.steps }));
          },
        });
        // The journey's own turn read the brief to its end: kept with the project (the panel says « lu » tomorrow too).
        if (autopilot && !extract && !failed && !abort.signal.aborted) plannedRef.current?.();
      } catch (err) {
        if (err.code !== "ABORTED") {
          patchLast((x) => ({ ...x, error: err.message }));
          if (extract) setExtractError({ code: err.code || null, message: err.message || "" });
        }
      } finally {
        setStreaming(false);
        abortRef.current = null;
        // The planner's plan with the hand's retouches back: the draft is simulated again with them.
        if (handOps.length && turnPlan !== sentPlan) refresh(turnPlan);
      }
    },
    [streaming, turns, plan, language, documents, demandDataIds, setTab, contract, contractState, dropSimulations, desk, refresh],
  );
  const stopPlanner = () => abortRef.current?.abort();

  // The conversation kept with the project (context.conversation, bounded: utils/conversation) — the assistant's
  // explanations and questions, the person's answers, the engine's verdict on each turn: written once a turn has
  // ended (never word by word) and when a question is answered, emptied with the conversation (« Reconstruire »,
  // « Recommencer »), within the room the project has (conversationBudget: none left, it is not kept, and said so).
  // Opened again, the project shows them as they were: reopening writes nothing. A copy written elsewhere since this
  // studio last read or wrote one (another device; the server's, read after this studio opened on the browser's
  // cache) is taken as it comes — with the turns of this studio not written yet after it — never written over.
  const incomingConversation = project?.context?.conversation ?? null;
  const incomingConversationKey = JSON.stringify(incomingConversation);
  useEffect(() => {
    if (!project || streaming) return;
    const synced = conversationSync.current;
    // Written elsewhere: neither the copy this studio holds nor the one the project had when this studio last wrote.
    if (incomingConversationKey !== synced.key && incomingConversationKey !== synced.seen) {
      const restored = restoredTurns(incomingConversation);
      const unwritten = turns.slice(synced.count);
      conversationSync.current = { key: incomingConversationKey, seen: incomingConversationKey, count: restored.length };
      setTurns([...restored, ...unwritten]);
      return;
    }
    const kept = keptConversation(turns, { maxBytes: conversationBudget(project) });
    setConversationNotKept(turns.length > 0 && !kept);
    const keptKey = JSON.stringify(kept);
    if (keptKey === synced.key) {
      conversationSync.current = { ...synced, count: turns.length };
      return;
    }
    if (!onUpdateProject) return;
    const written = onUpdateProject((p) => {
      const { conversation: _gone, ...context } = p.context || {}; // eslint-disable-line no-unused-vars
      return { ...p, context: kept ? { ...context, conversation: kept } : context };
    });
    // A write the browser's storage refused (null) is tried again with the next turn; the copy held stays the last read.
    if (written !== null) conversationSync.current = { key: keptKey, seen: incomingConversationKey, count: turns.length };
    // A turn ended, a question answered, the conversation emptied, a copy read from elsewhere: the project is read
    // for its own copy only.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [turns, streaming, incomingConversationKey]);

  // A spreadsheet of the brief read cell by cell (spreadsheet/parse, no model): the clauses it states proposed at ②
  // (to keep or set aside, each citing its cells), the values that give none recorded « à vérifier à la main », its
  // timetables kept for ③ (build_timetable operations). The file's bytes are never kept: read now, or given again.
  // A grid of the brief the change does not take, as the contract keeps it (id `grid-…`: utils/autopilot.gridWishes).
  const gridWishesOf = (held, skipped, name) => {
    const seen = new Set((held || []).filter((w) => GRID_WISH.test(String(w?.id || ""))).map((w) => `${w.document || ""}|${w.cell || ""}|${w.quote}`));
    const used = new Set((held || []).map((w) => w?.id).filter(Boolean));
    let n = 1;
    const out = [];
    for (const s of skipped || []) {
      const wish = { quote: String(s?.label || s?.title || name).slice(0, 400), document: s?.document || name, cell: s?.sheet ? `${s.sheet}${s.cell ? `!${s.cell}` : ""}`.slice(0, 200) : "", why: t("sheet.wish.grid", { reason: operationText(t, s?.reason) }).slice(0, 300) };
      const key = `${wish.document}|${wish.cell}|${wish.quote}`;
      if (seen.has(key)) continue;
      seen.add(key);
      while (used.has(`grid-${n}`)) n += 1;
      used.add(`grid-${n}`);
      out.push({ id: `grid-${n}`, ...wish });
    }
    return out;
  };
  const readSheet = async (file) => {
    setReadingSheets((names) => [...names, file.name]);
    let result;
    try {
      result = await parseOfferSheet(file, { lang });
    } finally {
      briefArrivedAt.current = Date.now();
      setReadingSheets((names) => {
        const i = names.indexOf(file.name);
        return i < 0 ? names : [...names.slice(0, i), ...names.slice(i + 1)];
      });
    }
    const name = result?.model?.file?.name || file.name;
    const at = new Date().toISOString();
    const again = Boolean(project?.context?.sheets?.[name]);
    contractState.setContract((c) => {
      const ids = new Set((c.clauses || []).map((x) => x.id));
      // Marked as read from a sheet (`origin`): an extraction of the prose documents never takes them for its own.
      const stated = (result.clauses || []).filter((x) => !ids.has(x.id)).map((x) => ({ ...x, document: x.document || name, origin: { kind: "sheet", document: name } }));
      // Read again, a sheet whose clauses did not all fit the first time adds only what now fits: the ones left out
      // were counted then (the contract's reserved wish), never counted twice.
      const fresh = again ? stated.slice(0, Math.max(0, MAX_CONTRACT_CLAUSES - (c.clauses || []).length)) : stated;
      // What the sheet states and no clause carries (each value its own point to check), and the cells the reader did
      // not understand (one point per reason, its cells listed): nothing of the sheet is left unsaid.
      const toCheck = sheetWishes(result, { existing: c.wishes || [], words: wishWords(t, name), gather: ["unread"] });
      // Each under an id of its own: ticked « vérifié à la main » one by one.
      const values = withWishIds(c.wishes || [], toCheck.wishes);
      // …and the grids the reading could not take (a direction no destination names, a line the network does not
      // know): kept « à vérifier à la main » too, said again at the delivery — never a timetable of the order left
      // out unsaid. A grid waiting for its days (a title to read) is a question, not a grid set aside.
      const wishes = [...values, ...gridWishesOf([...(c.wishes || []), ...values], (result.operations_skipped || []).filter((x) => !(x?.pending && x.title)), name)];
      // New clauses are nobody's decision yet: a contract already decided is reopened (② decides it again in one
      // act) — never a clause measured as agreed that no one saw.
      const reopened = fresh.length > 0 && c.status && c.status !== "draft" ? { status: "draft", decided_by: null, decided_at: null } : {};
      const next = { ...c, ...reopened, clauses: [...(c.clauses || []), ...fresh], wishes: [...(c.wishes || []), ...wishes] };
      // No room left in the contract for them: counted by its reserved wish, accepted by name at the delivery — never
      // dropped unsaid.
      return toCheck.full ? withUnrecordedWishes(next, toCheck.items, (count, max) => t("contract.overflowWishes", { count, max })) : next;
    });
    // Each sheet's timetables beside the others' (several sheets read at once: each update reads the latest offer).
    if ((result.operations || []).length || (result.operations_skipped || []).length) {
      contractState.setOffer((prev) => withSheetOffer(prev, name, { at, aggregates: result.aggregates, operations: result.operations, skipped: result.operations_skipped }));
    }
    // Kept with the project's context (the server keeps it: ② never asks to read again a sheet already read).
    onUpdateProject?.((p) => ({ ...p, context: { ...(p.context || {}), sheets: { ...(p.context?.sheets || {}), [name]: { at, clauses: (result.clauses || []).length, operations: (result.operations || []).length, cells: result.aggregates?.cells ?? null, read: result.aggregates?.read ?? null, unread: result.aggregates?.unread ?? (result.model?.unread || []).length, unsure: result.aggregates?.timetables_unsure ?? 0 } } } }));
    return result;
  };
  const attach = async (files) => {
    for (const file of Array.from(files || []).slice(0, MAX_DOCUMENTS - documents.length)) {
      const key = `${file.name}-${file.size}-${file.lastModified}`;
      setDocuments((ds) => [...ds, { key, name: file.name, size: file.size, status: "uploading" }]);
      try {
        // Without the assistant the document is kept for the project only, never read by the model later (① says « non envoyé »).
        const d = await uploadBriefDocument(file, { sentToAssistant: aiEnabled });
        briefArrivedAt.current = Date.now();
        setDocuments((ds) => ds.map((x) => (x.key === key ? { ...x, ...d, status: "ready" } : x)));
        // Kept with the project (① lists it; the server keeps it as long as the project).
        announceDocument("added", d);
        // A spreadsheet is also read cell by cell, at once: ② proposes what it states (a failure leaves « Lire le tableur »).
        // …unless the scenario is applied (frozen): its contract is the record of what was applied, never rewritten.
        if (SHEET_RE.test(file.name || "") && !frozenRef.current) readSheet(file).catch(() => {});
      } catch (err) {
        // The reader's words, as ① of the create journey says them (never a code or the server's English).
        const message = err?.code === "DOCUMENT_TOO_LARGE" ? t("network.docs.tooLarge") : err?.code === "UNSUPPORTED_DOCUMENT" ? t("network.docs.unsupported") : humanError(err, t)?.message || err?.message || t("network.docs.unsupported");
        setDocuments((ds) => ds.map((x) => (x.key === key ? { ...x, status: "error", error: message } : x)));
      }
    }
  };
  const removeDocument = (doc) => {
    if (doc.id) deleteBriefDocument(doc.id);
    announceDocument("removed", doc);
    setDocuments((ds) => ds.filter((x) => (doc.id ? x.id !== doc.id : x.key !== doc.key)));
    // A spreadsheet read cell by cell takes back what its reading wrote (the wrong file dropped, a file replaced):
    // its timetables, its objectives, its points to check by hand, its « read » mark — and its operations in the
    // change. Said in one notice; a scenario applied keeps its record as it is.
    const name = doc?.name || "";
    if (!name || !SHEET_RE.test(name) || frozenRef.current || !project?.context?.sheets?.[name]) return;
    const mine = (c) => c?.origin?.kind === "sheet" && c.origin.document === name;
    const clauses = (contractState.contract.clauses || []).filter(mine).length;
    const operations = plan.operations.filter((o) => o?.source?.offer && o.source.document === name).length;
    contractState.setContract((c) => ({ ...c, clauses: (c.clauses || []).filter((x) => !mine(x)), wishes: (c.wishes || []).filter((w) => !(w?.document === name && !w.checked && !w.by)) }));
    contractState.setOffer((prev) => withoutSheetOffer(prev, name));
    onUpdateProject?.((p) => {
      const { [name]: _gone, ...sheets } = p.context?.sheets || {}; // eslint-disable-line no-unused-vars
      return { ...p, context: { ...(p.context || {}), sheets } };
    });
    if (operations) updatePlan({ ...plan, operations: plan.operations.filter((o) => !(o?.source?.offer && o.source.document === name)) });
    if (clauses || operations) setNotice({ kind: "sheetRemoved", severity: "info", params: { name, clauses, operations } });
  };

  // ── Editing the plan by hand ──
  // An answer sets the parameter asked — except a grid's stop the network does not know (timetable_stop): the stop is
  // replaced in that grid, and in every other grid of the plan that names it the same way (the brief's timetables of
  // one line name their stops alike: answered once, for all).
  const answer = (opId, param, value, ambiguity = null) => {
    // A change that starts after the feed's end: the person's answer is the date the feed's validity is extended to —
    // the operation « Prolonger la validité » placed first (one for the plan), never the brief's own date rewritten.
    if (ambiguity?.code === "after_validity" && ambiguity.extend) {
      const held = plan.operations.find((o) => o.type === "extend_validity");
      const operations = held ? plan.operations.map((o) => (o === held ? { ...o, params: { ...(o.params || {}), end_date: value } } : o)) : [{ id: nextOpId(plan), type: "extend_validity", params: { end_date: value }, source: { author: "user" } }, ...plan.operations];
      updatePlan({ ...plan, operations });
      return;
    }
    // The school zone (or the country) the calendars need is the network's, not an operation's: one answer for the
    // whole plan (the engine reads plan.region / plan.country) — never written as the name of a period.
    if (ambiguity && ["calendar_region_missing", "calendar_region_unknown"].includes(ambiguity.code)) {
      updatePlan({ ...plan, region: value });
      return;
    }
    if (ambiguity?.code === "calendar_country_missing") {
      // A two-letter code (the choices the engine offers), kept as the server keeps countries; never words cut short.
      const code = String(value || "").trim().toLowerCase();
      if (/^[a-z]{2}$/.test(code)) updatePlan({ ...plan, country: code });
      else setNotice({ kind: "countryCode", severity: "warning" });
      return;
    }
    // A question several operations ask alike (the days a line does not run): one answer for every operation asking
    // it, and for those of its kind that have not said it yet (a grid asks it only once its stops are known).
    if (ambiguity && SHARED_QUESTIONS.has(ambiguity.code)) {
      const key = sharedKey(ambiguity);
      const asking = (preview?.steps || []).filter((s) => (s.ambiguities || []).some((a) => sharedKey(a) === key)).map((s) => s.id);
      const type = plan.operations.find((o) => o.id === opId)?.type;
      const unsaid = plan.operations.filter((o) => o.type === type && (o.params || {})[param] == null).map((o) => o.id);
      let next = plan;
      for (const id of new Set([opId, ...asking, ...unsaid])) if (next.operations.some((o) => o.id === id)) next = withParam(next, id, param, value);
      updatePlan(next);
      return;
    }
    // A departure time no trip runs at: the time chosen replaces that one in the operation's list, the others stay
    // (never the whole list overwritten by one answer).
    if (ambiguity?.code === "time_no_trip" && ambiguity.time != null) {
      const held = plan.operations.find((o) => o.id === opId)?.params?.[param];
      const list = Array.isArray(held) ? held : held == null || held === "" ? [] : String(held).split(/[,;]/).map((x) => x.trim()).filter(Boolean);
      const asked = String(ambiguity.time);
      updatePlan(withParam(plan, opId, param, list.some((x) => String(x) === asked) ? list.map((x) => (String(x) === asked ? value : x)) : [...list, value]));
      return;
    }
    if (ambiguity?.code === "timetable_stop" && ambiguity.stop) {
      const from = String(ambiguity.stop);
      const operations = plan.operations.map((o) => {
        const stops = o?.params?.timetable?.stops;
        if (!Array.isArray(stops) || !stops.some((x) => String(x) === from)) return o;
        return { ...o, params: { ...o.params, timetable: { ...o.params.timetable, stops: stops.map((x) => (String(x) === from ? value : x)) } } };
      });
      updatePlan({ ...plan, operations });
      return;
    }
    updatePlan(withParam(plan, opId, param, value));
  };
  // A question answered in the conversation: the engine's own question for that operation and parameter is found in
  // the simulation, so that the answer goes through the same hands as on the card (a grid's stop replaced in the
  // grid, a time replaced in the list — never the whole parameter overwritten by one word). Without it, a structured
  // parameter is never written blind: the assistant takes the answer as a message.
  const STRUCTURED = new Set(["timetable", "times", "bands", "stops", "period", "dates", "routes"]);
  const answerFromConversation = (q, value) => {
    const op = q.operation && q.param ? plan.operations.find((x) => x.id === q.operation) : null;
    if (!op) return runPlanner(`${q.text} → ${value}`);
    const ambiguity = (stepOf(op.id)?.ambiguities || []).find((a) => a.param === q.param) || null;
    if (!ambiguity && STRUCTURED.has(q.param)) return runPlanner(`${q.text} → ${value}`);
    return answer(op.id, q.param, value, ambiguity);
  };
  // …and kept on its question (`answer`): the conversation the project keeps says what the person answered.
  const answerInConversation = (at, k, q, value) => {
    setTurns((ts) => ts.map((x, i) => (i === at ? { ...x, questions: (x.questions || []).map((y, j) => (j === k ? { ...y, answer: value } : y)) } : x)));
    answerFromConversation(q, value);
  };
  const removeOp = (id) => {
    const index = plan.operations.findIndex((o) => o.id === id);
    if (index < 0) return;
    setRemoved({ op: plan.operations[index], index });
    updatePlan({ ...plan, operations: plan.operations.filter((o) => o.id !== id) });
  };
  // The operation removed, back at its place (or at the end when the plan got shorter since).
  const undoRemove = () => {
    if (!removed) return;
    const ops = plan.operations.filter((o) => o.id !== removed.op.id);
    ops.splice(Math.min(removed.index, ops.length), 0, removed.op);
    setRemoved(null);
    updatePlan({ ...plan, operations: ops });
  };
  const moveOp = (id, dir) => {
    const ops = [...plan.operations];
    const i = ops.findIndex((o) => o.id === id);
    const j = i + dir;
    if (i < 0 || j < 0 || j >= ops.length) return;
    [ops[i], ops[j]] = [ops[j], ops[i]];
    updatePlan({ ...plan, operations: ops });
  };
  // Several operations added at once (the brief's timetables, the optimiser's plan), each with its own id.
  const loadOperations = (ops) => {
    let next = plan;
    for (const op of ops) next = { ...next, operations: [...next.operations, { ...op, id: nextOpId(next) }] };
    updatePlan(next);
  };
  const saveOp = (op) => {
    // An operation written by hand: the plan is in sight for it.
    const exists = op.id && plan.operations.some((o) => o.id === op.id);
    const next = exists ? { ...plan, operations: plan.operations.map((o) => (o.id === op.id ? op : o)) } : { ...plan, operations: [...plan.operations, { ...op, id: nextOpId(plan) }] };
    setDialog(null);
    updatePlan(next);
    // The person's own act: the plan comes forward (from the guide's catalogue too).
    setTab("plan");
    setSupportTab("plan");
  };
  const needStops = useCallback(() => {
    fetchStops()
      .then(setStops)
      .catch(() => setStops([]));
  }, []);
  const clearPlan = () => {
    stopPlanner();
    // Started over: a turn the journey was about to launch for the plan just emptied is not the person's wish any more.
    setPlannerDue(false);
    dropSimulations();
    setPlan(EMPTY_PLAN);
    setPreview(null);
    setTurns([]);
    setError(null);
  };
  /** Start over: an empty draft (named scenarios stay). */
  const reset = () => {
    if (wsRef.current) commitWs({ ...activate(wsRef.current, null), draft: { plan: EMPTY_PLAN, updated_at: null } });
    clearPlan();
    setNotice(null);
    setTab("plan");
  };

  // ── Scenarios ──
  const guard = (fn) => {
    try {
      return fn();
    } catch (err) {
      if (err?.code === "TOO_MANY") setNotice({ kind: "tooMany", severity: "warning" });
      else setError(err.message);
      return null;
    }
  };
  const switchTo = (id) => {
    if (!wsRef.current) return;
    const next = activate(wsRef.current, id);
    commitWs(next);
    setNotice(null);
    showPlan(activePlan(next));
  };
  const saveAs = (name) => guard(() => commitWs(saveDraftAs(wsRef.current, name).ws));
  const duplicate = (name) =>
    guard(() => {
      const { ws: next } = duplicateScenario(wsRef.current, activeScenario(wsRef.current)?.id, name);
      commitWs(next);
      setPlan(activePlan(next));
    });
  const rename = (id, name) => commitWs(renameScenario(wsRef.current, id, name));
  const remove = (id) => {
    const next = deleteScenario(wsRef.current, id);
    commitWs(next);
    showPlan(activePlan(next));
  };
  const exportActive = () => {
    const cur = wsRef.current;
    if (!cur) return;
    const s = activeScenario(cur) || { name: plan.title || t("transform.scenario.draft"), plan: cur.draft.plan, created_at: cur.draft.updated_at, updated_at: cur.draft.updated_at };
    downloadText(scenarioFileName(s.name), exportScenario(s, { fingerprint: fp, routes: overview?.counts?.routes ?? null, trips: overview?.counts?.trips ?? null, range: overview?.range || null }));
  };
  const importFile = async (file) => {
    try {
      const parsed = parseScenarioFile(await readFileText(file), fp, file.name);
      if (!wsRef.current) {
        showPlan(parsed.plan);
        return;
      }
      const out = guard(() => addScenario(wsRef.current, { name: parsed.name || t("transform.scenario.imported"), plan: parsed.plan, origin: parsed.origin, created_at: parsed.created_at, updated_at: parsed.updated_at }));
      if (!out) return;
      commitWs(out.ws);
      showPlan(out.scenario.plan);
      setNotice(parsed.otherFeed ? { kind: "importedOther", severity: "warning", params: { name: out.scenario.name } } : { kind: "imported", severity: "success", params: { name: out.scenario.name } });
    } catch (err) {
      setNotice({ kind: err?.code === "FILE_TOO_LARGE" ? "importTooLarge" : "importError", severity: "error" });
    }
  };
  /** The optimizer's plan: a new scenario named after the objective, its steps shown as the engine's proposals. */
  const onOptimized = (result, name, meta = {}) => {
    const proposal = { ...result.plan, title: result.plan.title || name, operations: result.plan.operations.map((op) => ({ ...op, source: { ...(op.source || {}), generated_by: "optimizer", objective: op.source?.objective || meta.objective } })) };
    const origin = { kind: "optimizer", objective: meta.objective || null, label: meta.label || null, kpis_before: result.kpis_before || null, kpis_after: result.kpis_after || null, warnings: (result.warnings || []).slice(0, 10) };
    if (wsRef.current) {
      const out = guard(() => addScenario(wsRef.current, { name, plan: proposal, origin }));
      if (!out) return;
      commitWs(out.ws);
      showPlan(out.scenario.plan);
      setNotice({ kind: "optimized", severity: "success", params: { name: out.scenario.name } });
    } else showPlan(proposal);
  };

  // ── Apply (⑤) ──
  // The plan is written as ONE edit of the working copy: a version of the project (vN, applied, with who accepted
  // what), and the scenario frozen "applied in vN" — its operations stay on screen, read only; applying them
  // again on vN would apply them twice.
  const onApplied = (out, committed = null) => {
    // The simulation the commit replayed (the apply section simulates again on the working copy before it): the one
    // the scenario keeps, never an earlier one this page still held.
    const simulated = committed || preview;
    // A commit only succeeds once the canonical validator passed (the delivery gate); what a named person accepted is its record.
    const how = out?.acknowledgement ? "acknowledged" : "verified";
    // The plan's own words: the server's description is the edit log's (English, with the acknowledgement's record).
    const title = plan.title || t("transform.applied.operations", { count: (plan.operations || []).length });
    recordEdit(t(`transform.applied.${how}`, { title }), null, { entity: "transform", entityId: (out?.tables || []).join(",") });
    // The commit validated the very network it leaves: the status bar says what the validator answered (never « à
    // refaire » over the run that just passed), said once the edit is recorded.
    const validator = out?.proof?.validator || out?.validation?.after || null;
    if (validator) announceValidated({ errors: validator.errors, warnings: validator.warnings });
    // A simulation still in flight was computed before the application (or on the network it just changed): dropped.
    dropSimulations();
    if (wsRef.current) commitWs(markApplied(wsRef.current));
    setNotice(null);
    const by = out?.acknowledgement?.by?.name || rememberedName() || null;
    const next = project ? nextVersionNumber(project) : 1;
    // The comparison ④ read is kept with the scenario: the network the reports were read on has just changed.
    const coherence = appliedCoherenceRef.current;
    appliedCoherenceRef.current = null;
    forgetCoherence();
    // Without a project, this page's own record of the version: what its note says of it (appliedNoteOf).
    setAppliedLocal({ editId: out?.editId ?? null, n: next, by, at: new Date().toISOString(), title: out?.description || plan.title || "", coherence, validation: validator ? { errors: validator.errors ?? null, warnings: validator.warnings ?? null } : null, acknowledgement_id: out?.acknowledgement?.id || null, acknowledgement: out?.acknowledgement || null });
    // The contract was decided before the apply (409 CONTRACT_REQUIRED otherwise): kept as it is. The version
    // records the validator as the server's proof says it (its errors, warnings, rules, engine), never a figure written here.
    // What the note reads of the simulation is kept with the scenario too: the note of vN is written again after a reload.
    onUpdateProject?.((p) => withVersion(withScenario(p, { plan, verdict: simulated?.verdict ?? null, validation: out?.validation || null, applied_edit_id: out?.editId ?? null, coherence, coherence_id: coherence ? coherence.preview_id || coherence.computed_at || null : null, note_preview: noteSummaryOf(simulated) }), { kind: "applied", by, name: plan.title || p.name, verdict: simulated?.verdict ?? null, validation: out?.proof?.validator ? { ...out.proof.validator, status: out.validation?.status ?? out.proof.validator.status ?? null } : out?.validation ? { errors: out.validation.after?.errors ?? null, warnings: out.validation.after?.warnings ?? null, engine: out.validation.engine || null, status: out.validation.status } : null, acknowledgement: out?.acknowledgement || null }));
  };
  // "Annuler l'application": the one edit undone (only while it is the latest), the scenario thawed, back to vN-1.
  const undoApplication = async (editId) => {
    if (undoing) return;
    setUndoing(true);
    try {
      const ok = await undoLast(editId ?? null);
      if (!ok) return;
      setAppliedLocal(null);
      // The scenario thawed is simulated again: the comparison kept at its application goes with the version.
      onUpdateProject?.((p) => withScenario(withoutAppliedVersion(p, { by: rememberedName() || null }), { coherence: null, coherence_id: null }));
      forgetCoherence();
      autoValidated.current = null;
      refresh(planRef.current);
    } finally {
      setUndoing(false);
    }
  };
  // "Nouveau scénario sur vN": the operations copied into a new draft whose reference is vN, simulated on it. The copy
  // is the project's (the frozen scenario's plan), not what this page holds — the feed's draft was emptied by the
  // application, and a page opened since shows the frozen plan read back from the project.
  const newScenarioFromVersion = () => {
    const frozenPlan = projectScenarioRef.current?.plan || null;
    setAppliedLocal(null);
    const kept = onUpdateProject?.((p) => withScenarioFromVersion(p));
    const copied = activeScenarioOf(kept)?.plan || frozenPlan || planRef.current;
    autoValidated.current = null;
    setPlan(copied);
    refresh(copied);
    onStep(3);
  };

  const setKind = (k) => onUpdateProject?.((p) => ({ ...p, context: { ...(p.context || {}), draft_kind: k } }));
  const startDraft = (k) => {
    if (frozen) {
      setAppliedLocal(null);
      onUpdateProject?.((p) => {
        const next = withScenarioFromVersion(p, Date.now(), { empty: true });
        return { ...next, context: { ...(next.context || {}), draft_kind: k } };
      });
      autoValidated.current = null;
      reset();
    } else setKind(k);
  };
  const kindAsked = useRef(null);
  useEffect(() => {
    if (!panel || !initialKind) {
      kindAsked.current = null;
      return;
    }
    if (kindAsked.current === initialKind) return;
    kindAsked.current = initialKind;
    if (frozen || !plan.operations.length || kind === initialKind || !kind) startDraft(initialKind);
    // Asked once per hand-over.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [panel, initialKind]);
  // « Abandonner le brouillon »: its operations go, the network stays as it is, the way is chosen again.
  const [abandoning, setAbandoning] = useState(false);
  // The network's versions (reopen one as the working copy, its coherence): the specialist's, out of the decision.
  const [versionsOpen, setVersionsOpen] = useState(false);
  const abandon = () => {
    setAbandoning(false);
    reset();
    setKind("");
  };

  // The canonical validator on a stable simulation, by itself: once per preview, never on a blocked one or where no
  // validator answers, nor while the application itself runs (the commit validates); the delivery included — a plan
  // restored there (a reload, another device) is checked as on ③, never left « pas encore lancé ». The preview it
  // returns carries the validation, so it does not run again.
  useEffect(() => {
    if (streaming || previewing || validating || (step === 5 && applyState.busy) || frozenRef.current) return undefined;
    const id = preview?.id;
    if (!id || preview.validation || autoValidated.current === id) return undefined;
    const g = gateOf(preview);
    if (!g || g.validation === "unavailable" || g.blocking.some((b) => b.code === "blocked_steps" || b.code === "integrity" || b.code === "validator_unavailable")) return undefined;
    const timer = setTimeout(() => {
      autoValidated.current = id;
      refresh(planRef.current, { validate: true });
    }, AUTO_VALIDATE_MS);
    return () => clearTimeout(timer);
  }, [streaming, previewing, validating, step, preview, refresh, applyState.busy]);

  const stepOf = (id) => (preview?.steps || []).find((s) => s.id === id) || null;
  // The questions several operations ask alike: the first card asking each, and how many ask it.
  const shared = { first: new Map(), count: new Map() };
  for (const o of plan.operations) {
    const asking = stepOf(o.id);
    if (Array.isArray(asking?.waiting_for) && asking.waiting_for.length) continue;
    for (const k of new Set((asking?.ambiguities || []).map(sharedKey).filter(Boolean))) {
      if (!shared.first.has(k)) shared.first.set(k, o.id);
      shared.count.set(k, (shared.count.get(k) || 0) + 1);
    }
  }
  // A shared answer also reaches the operations of its kind that have not said it yet (answer): counted with them.
  for (const [k, id] of shared.first) {
    const [code, param] = k.split("|");
    if (!SHARED_QUESTIONS.has(code)) continue;
    const type = plan.operations.find((o) => o.id === id)?.type;
    const unsaid = plan.operations.filter((o) => o.type === type && (o.params || {})[param] == null).length;
    shared.count.set(k, Math.max(shared.count.get(k) || 0, unsaid));
  }
  const status = planStatus({ plan, preview, previewing });
  const examples = useMemo(() => (overview ? buildExampleBriefs(overview, { t, language: lang }) : []), [overview, t, lang]);
  const scenario = activeScenario(ws);
  const optimizerOrigin = scenario?.origin?.kind === "optimizer" ? scenario.origin : null;
  const busy = streaming || previewing;
  // How long the assistant has been reading, and a simulation running (useElapsed: 0 once over): the autopilot's
  // line says it beside how long each usually takes — a wait is never a bare spinner.
  const planSeconds = useElapsed(streaming);
  const previewSeconds = useElapsed(previewing);
  // « Recommencer » empties the draft and the conversation: asked first, in words (`change-reset-confirm`).
  const [resetting, setResetting] = useState(false);
  // An operation removed from the plan stays within reach for a moment: « Annuler » puts it back where it was.
  const [removed, setRemoved] = useState(null); // { op, index }
  const tabSx = { minHeight: 40, textTransform: "none", fontWeight: 600, fontSize: "0.8rem", px: 1.25 };


  // ── The flow: what the steps know ─────────────────────────────────────────
  const validatorOff = features?.access?.validator === "unavailable";
  const editLocked = !editing && features?.access?.edit && features.access.edit !== "ok";
  const projectScenario = activeScenarioOf(project);
  const appliedVersion = projectScenario?.applied_version_id ? (project?.versions || []).find((v) => v.id === projectScenario.applied_version_id) || null : null;
  // The note of the applied version: from this simulation, else from what the scenario kept of it (a reload, a member).
  const notePreview = preview || projectScenario?.note_preview || null;
  // Frozen "applied in vN": the project's scenario says it; without a project, this page's own record.
  const appliedEditId = projectScenario?.applied_edit_id ?? null;
  const frozen = useMemo(() => (appliedVersion ? { n: appliedVersion.n, editId: appliedEditId, by: appliedVersion.by, at: appliedVersion.at } : appliedLocal), [appliedVersion, appliedEditId, appliedLocal]);
  // The draft the reader's lens shows (GTFSApp's « Avant | Après », components/reader/ReaderLens): this simulation, the
  // lines it touches named as the network names them, whether it is being simulated — or the version it was applied as.
  const touchedNow = touchedLinesOf(preview).map((l) => ({ ...l, label: routes.some((r) => String(r.id) === l.route) ? routeLabelOf(l.route, routes) : l.label }));
  const draftSignature = JSON.stringify([!frozen && preview?.id && !preview.empty ? preview.id : null, plan.operations.length, previewing, frozen ? frozen.n : null, touchedNow]);
  useEffect(() => {
    if (!onDraft) return;
    const [previewId, operations, simulating, applied, touched] = JSON.parse(draftSignature);
    onDraft({ previewId, operations, touched, simulating, applied });
    // The signature says when the draft changed.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [draftSignature]);
  // The reader lost the draft it looked at (expired, or the working copy changed since): the change is simulated again.
  useEffect(() => {
    const handler = () => {
      if (frozenRef.current || !planRef.current?.operations?.length) return;
      refresh(planRef.current);
    };
    window.addEventListener("gtfs:resimulate", handler);
    return () => window.removeEventListener("gtfs:resimulate", handler);
  }, [refresh]);
  // What the note of the applied version says of it: the version's own record (vN, when, by whom, the validator's
  // answer at its application, who accepted what stayed open) — never the gate of a simulation.
  const noteApplied = appliedVersion ? appliedNoteOf(appliedVersion, project?.acknowledgements || []) : appliedLocal ? appliedNoteOf(appliedLocal, appliedLocal.acknowledgement ? [appliedLocal.acknowledgement] : []) : null;
  frozenRef.current = Boolean(frozen);
  const contractStatus = contract.status || "draft";
  const contractClausesCount = (contract.clauses || []).length;
  // The person's objectives, their desired clauses and the two default guarantees apart (utils/objectiveCounts, as ②,
  // the panel and the recap count them) — before any measure from the contract, then from the simulation's results.
  const contractObjectivesCount = objectiveResults(contract.clauses || []).objectives.length;
  const pageCounts = objectiveCounts(preview?.conformance?.after?.results);
  // What ②'s way on settles by itself (the objectives proposed and not decided), and what holds it: a document of the
  // brief nobody could read, the brief's first measure still running.
  const pendingObjectives = (contract.clauses || []).filter((c) => !isClauseDecided(c)).length;
  // Two readings of the same cells that disagree (the reading of the brief checked a spreadsheet's objectives against
  // its cells): the person's question at ② — the one act never keeps both, nor picks one (utils/contract openDisputes).
  const disputes = openDisputes(contract);
  // A statement of the brief about today's network that the feed contradicts, not answered yet: the person's question at ①.
  const premisesOpen = undecidedPremises(contract);
  // A point the two readings of the brief differ on, not chosen yet: the person's choice at ① (READING_UNDECIDED).
  const readingsOpen = undecidedReadings(contract);
  // A workbook the journey read cell by cell, whose text version the document store cut at its bound (a network-scale
  // timetable workbook): every cell was read — it is no document « nobody could read ». The one act records, under the
  // person's name, that its sentences were not searched one by one (acceptAll: `documents`).
  const longSheets = (contractState.coverage?.uncovered || []).filter((s) => s?.unread === "truncated" && Boolean(project?.context?.sheets?.[s.source]));
  const unreadDocuments = (contractState.coverage?.uncovered || []).filter((s) => s?.unread && !longSheets.includes(s)).length;
  const coverageDue = contractState.coverageState === "loading" && !contractState.coverage;
  const uploadingDocuments = documents.some((d) => d.status === "uploading");
  // ③'s assistant drafts nothing before the contract is decided, assumed or recorded empty (the work by hand stays open).
  const contractLocksAssistant = aiEnabled && !contractReady(contract);
  // The report calls a clause decided only once ② is: the contract's own clauses then, none for a draft or an empty one.
  const coherenceClauses = useMemo(() => contractClauses(project?.contract), [project?.contract]);
  const previewCoherence = useCallback((p) => ({ kind: "preview", previewId: p.id, clauses: coherenceClauses, framing: project?.context || null }), [coherenceClauses, project?.context]);
  // Before the application consumes the simulation: its comparison, whole, to keep with the frozen scenario (never a
  // reason to hold the application back — past COHERENCE_CAPTURE_MS or on a refusal, nothing is kept and ④ says so).
  const captureCoherence = async (p) => {
    appliedCoherenceRef.current = null;
    if (!p?.id || p.empty) return;
    const got = await coherenceForNote(previewCoherence(p), { timeoutMs: COHERENCE_CAPTURE_MS });
    appliedCoherenceRef.current = frozenCoherence(got.report);
  };
  // ⑤ reads the comparison on arrival (computed at ④ or ⑤), so the application rarely waits for it.
  useEffect(() => {
    if (step !== 5 || frozen || !preview?.id || preview.empty) return;
    coherenceForNote(previewCoherence(preview));
  }, [step, frozen, preview, previewCoherence]);
  const stuck = status.key === "transform.blocked" || (preview?.steps || []).some((s) => s.status === "blocked" || s.status === "failed");
  // Every operation was already true of the network: nothing to verify, nothing to apply — said, never a delivery
  // that answers « simulez d'abord ».
  const nothingToApply = Boolean(preview?.empty) && plan.operations.length > 0 && !previewing;
  // ④ from the plan's fingerprint: "done" for the plan the validator ran on, once the person reached ④ with it;
  // "to redo" when the plan changed since; "to do" before (an automatic run at ③ alone does not tick ④).
  const planKey = useMemo(() => planKeyOf(plan), [plan]);
  useEffect(() => {
    if (step >= 4 && !frozen && plan.operations.length) setChecksKey(planKey);
  }, [step, planKey, frozen, plan.operations.length]);
  const checks = !checksKey ? "none" : checksKey !== planKey ? "stale" : validatedKey === planKey ? "fresh" : "none";
  const facts = useMemo(
    () => ({
      job: "modify",
      named: Boolean(String(project?.name ?? "").trim()) || !project,
      started: Boolean(overview && !overview.failed),
      contract: contractStatus,
      clauses: contractClausesCount,
      design: !plan.operations.length ? "none" : stuck || !preview ? "partial" : "ready",
      checks,
      delivered: Boolean(frozen),
      locks: { 4: validatorOff ? "step.locked.validator" : null, 5: validatorOff ? "step.locked.validator" : editLocked ? "step.locked.edit" : null },
      verdict: preview?.verdict ?? null,
    }),
    [project, overview, contractStatus, contractClausesCount, plan.operations.length, stuck, preview, checks, frozen, validatorOff, editLocked],
  );
  const factsSignature = JSON.stringify(facts);
  useEffect(() => {
    onFacts?.(facts);
    // The signature says when the facts changed.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [factsSignature]);
  // ③ → the delivery: simulate again with the validator, then read the checks there, above the act.
  // The brief read by the assistant once it is all there (while ② is ahead): the person agrees to its objectives at
  // ②, never has to ask for the reading. Only where the assistant answers by itself (not under the free trial).
  // ONE reading of the whole brief: it waits until every document dropped is sent and every spreadsheet read cell by
  // cell, and a moment more (READING_QUIET_MS: files dropped a few seconds apart are one brief), then reads them all
  // together (readingDocumentIds), the objectives read from the spreadsheets listed for it to check — never one
  // reading per file as they arrive. Left to read (utils/briefReading pendingReading): a document no reading was given
  // (a second batch: every document read again together — an extraction replaces its own earlier proposals of the
  // documents it reads, never the person's decisions nor what a sheet states), or the documents a reading could not
  // carry (too long together for one message, as the server's record says: read on their own, once each — never again
  // by itself once a reading of them alone found none; one it left out without saying why may be gone from the server:
  // the person's act at ②, never a paid reading by itself); a document removed is no reason to read again. A reading
  // recorded without `left_out` counts every document there then as given: only one joined after it is read
  // (`arrivedAfter`, by the project's journal) — a project opened again is never read again at a model's cost.
  const autoRead = useRef(new Set());
  const briefArriving = uploadingDocuments || readingSheets.length > 0;
  const extractedAt = Date.parse(contract.extracted?.at || "");
  const arrivedAfter = (id) => {
    const name = documents.find((d) => d.id === id)?.name;
    return Number.isFinite(extractedAt) && Boolean(name) && (project?.journal || []).some((j) => j?.action === "document" && j.object === name && Date.parse(j.at || "") > extractedAt);
  };
  const pending = pendingReading(readingDocumentIds, contract.extracted, { arrivedAfter });
  const pendingKey = pending ? `${pending.mode}:${[...pending.ids].sort().join(",")}` : "";
  // The documents a reading was given and could not read, still in the brief: said at ② (read on their own: `only`).
  const leftOut = (contract.extracted?.left_out || []).filter((d) => d?.id && readingDocumentIds.includes(d.id));
  const leftOutReadable = leftOut.filter((d) => !d.unreadable);
  // One reading of the brief by the assistant — by itself, « Lire le cahier des charges », « Proposer », the documents
  // a reading could not carry: the documents in the reading's order, and the objectives read cell by cell from the
  // spreadsheets among them, listed for it to check against their cells (never stated a second time beside them).
  const readBrief = (text, ids, { only = false } = {}) => {
    const names = ids.map((id) => documents.find((d) => d.id === id)?.name).filter(Boolean);
    return runPlanner(text, { extract: true, documentIds: ids, check: sheetCheckOf(contract, names), only });
  };
  const readLeftOut = () => readBrief(t("contract.extract.leftOut", { names: leftOutReadable.map((d) => `« ${d.name || d.id} »`).join(", ") }), leftOutReadable.map((d) => d.id), { only: true });
  const [quietTick, setQuietTick] = useState(0);
  const contractIsDecided = contractReady(contract);
  // A reading the assistant is about to start by itself (the moment after a document arrived): ②'s way on waits for it.
  const readingDue = autonomous && !frozen && !contractIsDecided && step <= 2 && Boolean(pending) && !autoRead.current.has(`${project?.id || "local"}:${pendingKey}`);
  useEffect(() => {
    // Never behind a contract already decided (it would reopen it as a draft): « Lire le cahier des charges » is
    // the person's act then. Nor by itself under the free trial.
    if (!autonomous || frozen || streaming || briefArriving || !pending || step > 2 || contractIsDecided) return undefined;
    // A document just sent or read cell by cell: a moment more, for the files dropped with it.
    const wait = briefArrivedAt.current + READING_QUIET_MS - Date.now();
    if (wait > 0) {
      const timer = setTimeout(() => setQuietTick((n) => n + 1), wait + 10);
      return () => clearTimeout(timer);
    }
    const key = `${project?.id || "local"}:${pendingKey}`;
    if (autoRead.current.has(key)) return undefined;
    autoRead.current.add(key);
    if (pending.mode === "left") readLeftOut();
    else readBrief(t("contract.extract.default"), pending.ids);
    return undefined;
    // Once per set of documents: the planner's own state is not a reason to read again.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [autonomous, frozen, streaming, briefArriving, pendingKey, step, contractIsDecided, quietTick]);
  // What the brief states and no objective answers: the assistant drafts them (one turn), the person agrees at ②. A
  // sentence of a document the person kept from the assistant is never handed to it, not even quoted in a message.
  const keptFromAssistant = new Set([...documents, ...(project?.documents || [])].filter((d) => d?.sent_to_assistant === false).map((d) => d.name));
  const proposable = (sentences) => (sentences || []).filter((s) => s && !keptFromAssistant.has(s.source));
  const proposeObjectives = (sentences) => {
    const open = proposable(sentences);
    if (open.length) readBrief(`${t("objectives.propose.intro")}\n${open.map((x) => `- ${String(x.text || "").replace(/\s*\|\s*/g, " · ").replace(/^[·\s]+|[·\s]+$/g, "")}`).join("\n")}`, readingDocumentIds);
  };
  // …by itself, once per visit of the project, where the assistant answers, for a brief it has no document of to read
  // (a request typed at ②): that turn is its one reading. Behind the reading of the documents, never: what it leaves
  // without an objective stays listed at ②, to propose with the assistant (one act of the person's), keep « à
  // vérifier à la main » or write by hand — never a second reading of the whole brief by itself.
  const autoProposed = useRef(new Set());
  // The brief's sentences no objective answers: the coverage measured here, and those the simulation's gate holds the
  // change on (G5) — the gate measured them on the documents as the server reads them, which a coverage read earlier may
  // not list yet: what holds the act is always shown where it is settled, and the objectives' act settles it too.
  const coverageOpen = (contractState.coverage?.uncovered || []).filter((s) => s && !s.unread && String(s.text || "").trim());
  const gateOpen = frozen ? [] : gateUncovered(gateOf(preview)).filter((s) => s && String(s.text || "").trim() && !coverageOpen.some((c) => c.id === s.id || String(c.text).trim() === String(s.text).trim()));
  const openSentences = [...coverageOpen, ...gateOpen];
  const coverageShown = gateOpen.length ? { ...(contractState.coverage || {}), uncovered: [...(contractState.coverage?.uncovered || []), ...gateOpen] } : contractState.coverage;
  // The ones that ask something (not set aside by the reading as a title, context or today's service): what the
  // assistant is asked for objectives and what the bar counts; the act that keeps the objectives settles all of them.
  const askingSentences = openSentences.filter((s) => !s.set_aside);
  const openSentencesKey = proposable(askingSentences).map((s) => s.id).join(",");
  useEffect(() => {
    if (!autonomous || frozen || streaming || step !== 2 || !openSentencesKey || contractIsDecided) return;
    if (readingDocumentIds.length || briefArriving) return;
    const key = project?.id || "local";
    if (autoProposed.current.has(key)) return;
    autoProposed.current.add(key);
    proposeObjectives(askingSentences);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [autonomous, frozen, streaming, step, openSentencesKey, readingDocumentIds.length > 0, briefArriving]);
  const simulateAndCheck = () => {
    // The validator already answered for this very plan (it runs by itself on a stable simulation): the delivery
    // reads that simulation — no second run of tens of seconds; a simulation gone stale is simulated again there.
    const validated = Boolean(preview?.id && preview.validation && !preview.validation.error && validatedKey === planKey && !previewing);
    if (!validated) {
      autoValidated.current = preview?.id || null;
      refresh(plan, { validate: true });
    }
    onStep(5);
  };
  // The delivery (5 inside) comes back to ③: the modify job has no ④ of its own.
  const back = step > 1 ? { onClick: () => onStep(step >= 4 ? 3 : step - 1) } : null;

  // ── ③ The conversation (left) and the operations (right) ─────────────────
  // A turn's steps as chips: what the assistant and the engine did (the plan simulated, a correction, the audit…).
  const stepChipsOf = (steps) =>
    steps.map((s, j) => (
      <Chip
        key={j}
        size="small"
        icon={<PlaylistAddCheckIcon sx={{ fontSize: 14 }} />}
        data-testid={`change-step-${s.kind}`}
        // The audit's findings, readable on the chip (the person's information: what it did not find met, could not establish, or saw changed unasked).
        title={s.kind === "audit" && s.findings?.length ? s.findings.map((f) => `${t(`transform.step.auditFinding.${f.status}`)} : ${f.quote}${f.why ? ` — ${f.why}` : ""}`).join("\n") : undefined}
        color={s.kind === "correctionResolved" || (s.kind === "audit" && !s.skipped && !s.not_met && !s.unclear && !s.collateral) ? "success" : s.kind === "correctionEscalated" || s.kind === "budget" || (s.kind === "audit" && !s.skipped) ? "warning" : "default"}
        label={
          s.kind === "demand"
            ? t(s.calibrated ? "transform.step.demandCalibrated" : "transform.step.demand", { trips: Math.round(s.trips).toLocaleString(language), uncertainty: s.uncertainty || "±50 %" })
            : s.kind === "demandUnavailable"
              ? t("transform.step.demandUnavailable")
              : s.kind === "optimization"
                ? t("transform.step.optimization", { count: s.count })
                : s.kind === "correction"
                  ? t("transform.step.correction", { attempt: s.attempt, max: s.max })
                  : s.kind === "correctionResolved"
                    ? t("transform.step.correctionResolved", { attempts: s.attempts })
                    : s.kind === "correctionEscalated"
                      ? t("transform.step.correctionEscalated", { max: s.max })
                      : s.kind === "retry"
                        ? t("transform.step.retry", { attempt: s.attempt, max: s.max })
                        : s.kind === "budget"
                          ? t("transform.step.budget")
                          : s.kind === "audit"
                            ? s.skipped
                              ? t("transform.step.auditSkipped")
                              : !s.not_met && !s.unclear && !s.collateral
                                ? t("transform.step.auditClean")
                                : t("transform.step.audit", { not_met: s.not_met || 0, unclear: s.unclear || 0, collateral: s.collateral || 0 })
                            : t("transform.step.plan", { count: s.count })
        }
        sx={{ alignSelf: "flex-start", height: 22, fontSize: "0.68rem" }}
      />
    ));
  const conversationWith = (status = null, { hidden = false } = {}) => (
    <>
      <Box ref={scrollRef} data-testid="change-thread" sx={{ flex: 1, minHeight: 0, overflowY: "auto", p: 1.5, display: hidden ? "none" : "flex", flexDirection: "column", gap: 1.25 }}>
        {!turns.length && (
          <Box sx={{ p: 1.5, borderRadius: "12px", background: soft(theme) }} data-testid="change-welcome">
            <Typography sx={{ fontSize: "0.86rem", fontWeight: 800, mb: 0.5 }}>{t("transform.welcome.title")}</Typography>
            <Typography sx={{ fontSize: "0.76rem", color: "text.secondary", lineHeight: 1.55 }}>{aiEnabled ? t("transform.welcome.hint") : t("transform.welcome.manual")}</Typography>
            {aiEnabled && examples.length > 0 && (
              <Box sx={{ display: "flex", flexDirection: "column", gap: 0.5, mt: 1 }} data-testid="change-examples">
                {examples.map((ex) => (
                  <Chip key={ex.key} size="small" variant="outlined" label={ex.text} onClick={() => setInput(ex.text)} data-testid="change-example" sx={{ justifyContent: "flex-start", height: "auto", py: 0.5, "& .MuiChip-label": { whiteSpace: "normal", fontSize: "0.72rem" } }} />
                ))}
              </Box>
            )}
          </Box>
        )}
        {/* The older turns the project could not keep (utils/conversation): counted where the conversation starts. */}
        {turns[0]?.earlier > 0 && (
          <Typography data-testid="change-turns-earlier" sx={{ alignSelf: "center", fontSize: "0.72rem", color: "text.secondary", textAlign: "center" }}>
            {t("transform.conversation.earlier", { count: turns[0].earlier })}
          </Typography>
        )}
        {turns.map((turn, i) =>
          turn.role === "user" ? (
            turn.auto ? (
              // The turn the journey launched by itself: no message of the person, said in one quiet line.
              <Typography key={i} data-testid="change-auto-turn" sx={{ alignSelf: "center", fontSize: "0.72rem", color: "text.secondary", textAlign: "center" }}>
                {t("autopilot.turn")}
              </Typography>
            ) : (
              <Box key={i} sx={{ alignSelf: "flex-end", maxWidth: "88%", px: 1.25, py: 0.75, borderRadius: "12px 12px 4px 12px", background: alpha(theme.palette.primary.main, 0.1) }}>
                <Typography sx={{ fontSize: "0.8rem", whiteSpace: "pre-wrap" }}>{turn.text}</Typography>
              </Box>
            )
          ) : (
            <Box key={i} data-testid="change-assistant-turn" data-contradicts={turn.verdict?.prose?.contradicts ? "true" : "false"} sx={{ display: "flex", flexDirection: "column", gap: 0.75 }}>
              {/* The engine's verdict first, never the model's words: "not measured yet" until the event arrives —
                  counted as ③ counts (objectives, guarantees apart) when it measured what the page measured. A turn
                  the engine measured exactly as the turn before says so in one line: a thread of questions on one
                  plan never repeats the same card at every turn. */}
              {panel ? null : sameVerdictAsBefore(turns, i) ? (
                <Typography data-testid="change-turn-verdict-same" sx={{ fontSize: "0.72rem", color: "text.secondary" }}>
                  {t("transform.conversation.sameVerdict")}
                </Typography>
              ) : (
                <VerdictCard payload={turn.verdict || null} variant="turn" split counts={countsAgree(pageCounts, turn.verdict?.verdict) ? pageCounts : null} />
              )}
              {/* A turn kept with the project lists its verdict's first rows: the others are counted (utils/conversation). */}
              {rowsMoreOf(turn) > 0 && (
                <Typography data-testid="change-turn-verdict-more" sx={{ fontSize: "0.7rem", color: "text.secondary", lineHeight: 1.45 }}>
                  {t("transform.conversation.rowsMore", { count: rowsMoreOf(turn) })}
                </Typography>
              )}
              {/* Until the verdict arrives (streaming, or a turn that ended without it) the words are the model's unchecked claim: muted, said so. */}
              {(turn.superseded || []).length > 0 && (
                <Box component="details" data-testid="change-turn-superseded" sx={{ fontSize: "0.72rem", color: "text.secondary", "& summary": { cursor: "pointer", fontWeight: 600 } }}>
                  <summary>{t("planner.correction.superseded")}</summary>
                  {turn.superseded.map((text, k) => (
                    <Box key={k} sx={{ mt: 0.5, pl: 1, borderLeft: `2px solid ${theme.palette.divider}`, opacity: 0.75, whiteSpace: "pre-wrap" }}>
                      {text}
                    </Box>
                  ))}
                </Box>
              )}
              {turn.text && (turn.verdict ? <ProseWithStrikes text={turn.text} prose={turn.verdict.prose || null} /> : <ProseWithStrikes text={turn.text} unchecked />)}
              {turn.pending && (
                <Box sx={{ display: "flex", alignItems: "center", gap: 0.75, color: "text.secondary" }}>
                  <CircularProgress size={12} />
                  <Typography sx={{ fontSize: "0.72rem" }}>{t(`transform.tool.${TOOL_LABEL[turn.pending] || "work"}`)}</Typography>
                </Box>
              )}
              {/* In a draft, the turn's work under the hood is one quiet line (TurnWork), its steps behind it; a colour only
                  where the person has something to look at. */}
              {panel ? (
                <TurnWork steps={turn.steps} detail={<Box sx={{ display: "flex", flexDirection: "column", gap: 0.5 }}>{stepChipsOf(turn.steps)}</Box>} />
              ) : (
                stepChipsOf(turn.steps)
              )}
              {/* What the turn cost the person: the assistant's allowance (the trial's daily cap first), where a limit stands. */}
              {allowanceOf(turn.allowance) && (
                <Typography data-testid="change-turn-allowance" data-window={allowanceOf(turn.allowance).window} sx={{ fontSize: "0.68rem", color: "text.secondary" }}>
                  {t(`transform.turn.allowance.${allowanceOf(turn.allowance).window}`, { used: allowanceOf(turn.allowance).used, limit: allowanceOf(turn.allowance).limit })}
                </Typography>
              )}
              {(turn.questions || []).length > 0 && (
                <Box sx={{ p: 1, borderRadius: "10px", background: alpha(theme.palette.warning.main, 0.08), display: "flex", flexDirection: "column", gap: 0.75 }} data-testid="change-planner-questions">
                  {turn.questions.map((q, k) => (
                    <Box key={k} data-origin={q.origin || undefined} data-answer={q.answer ?? undefined}>
                      {q.origin === "engine" && (
                        <Typography component="span" data-testid="change-question-engine" sx={{ display: "inline-block", fontSize: "0.62rem", fontWeight: 700, letterSpacing: 0.3, textTransform: "uppercase", color: "warning.main" }}>
                          {t("planner.question.engine")}
                        </Typography>
                      )}
                      <Typography sx={{ fontSize: "0.76rem", fontWeight: 600 }}>{q.text}</Typography>
                      <Box sx={{ display: "flex", flexWrap: "wrap", gap: 0.5, mt: 0.5 }}>
                        {/* The answer given is marked (a tick, not a colour alone). The option the assistant recommends is said below, never pre-selected: a default that withdraws service or settles a reading is the person's to take, not the page's. */}
                        {(q.options || []).map((o) => (
                          <Chip key={o} size="small" label={o} icon={q.answer === o ? <CheckRoundedIcon sx={{ fontSize: 14 }} /> : undefined} color={q.answer === o ? "primary" : "default"} variant={q.answer === o ? "filled" : "outlined"} aria-pressed={q.answer != null ? q.answer === o : undefined} disabled={streaming || Boolean(frozen) || q.answer != null || i !== answeringTurn} onClick={() => answerInConversation(i, k, q, o)} sx={{ fontSize: "0.7rem" }} />
                        ))}
                      </Box>
                      {q.default != null && String(q.default).trim() && q.answer == null && (
                        <Typography data-testid="change-question-recommended" sx={{ fontSize: "0.7rem", color: "text.secondary", mt: 0.25 }}>{t("planner.question.recommended", { option: String(q.default) })}</Typography>
                      )}
                    </Box>
                  ))}
                </Box>
              )}
              {/* The first turn is the extraction: the contract it proposes, decided at ②, nothing drafted. */}
              {turn.extracted && (
                <Box data-testid="plan-contract-extracted" sx={{ p: 1.25, borderRadius: "12px", background: alpha(theme.palette.primary.main, 0.06), display: "flex", flexDirection: "column", gap: 0.5 }}>
                  <Typography sx={{ fontSize: "0.8rem", fontWeight: 700 }}>{t("contract.extracted.turn", { clauses: turn.extracted.clauses, wishes: turn.extracted.wishes, uncovered: turn.extracted.uncovered })}</Typography>
                  {/* The spreadsheets' objectives it checked against their cells, and those it reads otherwise (② asks). */}
                  {turn.extracted.checked > 0 && (
                    <Typography data-testid="plan-contract-checked" sx={{ fontSize: "0.74rem", lineHeight: 1.45, color: "text.secondary" }}>
                      {t("contract.extracted.checked", { count: turn.extracted.checked })}
                    </Typography>
                  )}
                  {turn.extracted.disputed > 0 && (
                    <Typography data-testid="plan-contract-disputed" sx={{ fontSize: "0.74rem", lineHeight: 1.45, fontWeight: 600 }}>
                      {t("contract.extracted.disputed", { count: turn.extracted.disputed })}
                    </Typography>
                  )}
                  {/* The documents it was given and could not read: named, read on their own (never dropped unsaid). */}
                  {(turn.extracted.left || []).length > 0 && (
                    <Typography data-testid="plan-contract-left-out" sx={{ fontSize: "0.74rem", lineHeight: 1.45, fontWeight: 600, overflowWrap: "anywhere" }}>
                      {t("contract.extracted.leftOut", { names: turn.extracted.left.map((n) => `« ${n} »`).join(", ") })}
                    </Typography>
                  )}
                  <Button size="small" variant="outlined" onClick={() => onStep(2)} data-testid="plan-contract-open" sx={{ alignSelf: "flex-start", textTransform: "none", fontWeight: 700 }}>
                    {t("contract.open")}
                  </Button>
                </Box>
              )}
              {turn.error && <Alert severity="error" sx={{ py: 0, fontSize: "0.74rem" }}>{turn.error}</Alert>}
              {turn.trial && turn.done && (
                <Typography data-testid="change-turn-trial" sx={{ fontSize: "0.72rem", color: "text.secondary", fontStyle: "italic" }}>
                  {t("network.plan.trialModel")}
                </Typography>
              )}
            </Box>
          ),
        )}
        {/* The project has no room left for the conversation (utils/conversation): said while it is on screen. */}
        {conversationNotKept && (
          <Typography data-testid="change-conversation-not-kept" sx={{ alignSelf: "center", fontSize: "0.72rem", fontWeight: 600, color: "text.secondary", textAlign: "center" }}>
            {t("transform.conversation.notKept")}
          </Typography>
        )}
      </Box>
      {status}
      {/* Composer */}
      <Box sx={{ p: 1.25, borderTop: `1px solid ${theme.palette.divider}` }}>
        {briefBanner && (
          <Alert severity="info" icon={<AutoAwesomeOutlinedIcon fontSize="small" />} onClose={() => setBriefBanner(false)} data-testid="change-brief-banner" sx={{ mb: 0.75, py: 0, fontSize: "0.74rem", alignItems: "center" }}>
            {t("transform.briefHandedOver")}
            {!aiEnabled ? ` ${t("transform.briefHandedOverNoAi")}` : ""}
          </Alert>
        )}
        {/* In the draft the documents are listed once, in what is asked. */}
        {documents.length > 0 && !panel && (
          <Box sx={{ display: "flex", flexWrap: "wrap", gap: 0.5, mb: 0.75 }}>
            {documents.map((d) => (
              <Chip key={d.key} size="small" icon={d.status === "uploading" ? <CircularProgress size={10} /> : <DescriptionOutlinedIcon sx={{ fontSize: 14 }} />} label={d.name} color={d.status === "error" ? "error" : "default"} onDelete={() => removeDocument(d)} title={d.error || d.name} sx={{ maxWidth: 220, fontSize: "0.7rem" }} data-testid="change-document" />
            ))}
          </Box>
        )}
        {assistantLock && (
          <LockedAction lock={assistantLock} sx={{ mb: 0.75 }}>
            {t("composer.send")}
          </LockedAction>
        )}
        {contractLocksAssistant && !frozen && !panel && (
          <Alert severity="info" data-testid="change-contract-lock" action={<Button color="inherit" size="small" onClick={() => onStep(2)} data-testid="change-contract-open" sx={{ textTransform: "none", fontWeight: 700 }}>{t("autopilot.objectives")}</Button>} sx={{ mb: 0.75, py: 0, fontSize: "0.74rem", alignItems: "center" }}>
            {t("step.locked.objectives")}
          </Alert>
        )}
        <Box sx={{ display: "flex", alignItems: "flex-end", gap: 0.75, p: 0.75, borderRadius: "14px", boxShadow: `0 0 0 1px ${theme.palette.divider}`, background: theme.palette.background.default }}>
          <input ref={fileRef} type="file" hidden multiple accept={BRIEF_ACCEPT} onChange={(e) => { attach(e.target.files); e.target.value = ""; }} data-testid="change-file" />
          <Tooltip title={t("transform.attach")}>
            <span>
              <IconButton size="small" disabled={!aiEnabled || streaming || documents.length >= MAX_DOCUMENTS} onClick={() => fileRef.current?.click()} aria-label={t("transform.attach")}>
                <AttachFileRoundedIcon sx={{ fontSize: 18 }} />
              </IconButton>
            </span>
          </Tooltip>
          <InputBase
            multiline
            maxRows={8}
            value={input}
            onChange={(e) => setInput(e.target.value)}
            onKeyDown={(e) => {
              // Ctrl+Enter (Cmd+Enter) sends; Enter alone is a new line, so a pasted brief is never sent by accident.
              if (e.key === "Enter" && (e.ctrlKey || e.metaKey)) {
                e.preventDefault();
                if (!contractLocksAssistant) runPlanner(input);
              }
            }}
            disabled={!aiEnabled || Boolean(frozen) || contractLocksAssistant}
            placeholder={aiEnabled ? t("composer.placeholder") : t("transform.aiDisabled")}
            inputProps={{ "data-testid": "change-brief" }}
            sx={{ flex: 1, fontSize: "0.82rem", px: 0.5 }}
          />
          {streaming ? (
            <IconButton size="small" onClick={stopPlanner} aria-label={t("transform.stop")} data-testid="change-stop">
              <StopRoundedIcon />
            </IconButton>
          ) : (
            <IconButton size="small" color="primary" disabled={!aiEnabled || !input.trim() || Boolean(frozen) || contractLocksAssistant} onClick={() => runPlanner(input)} aria-label={t("composer.send")} data-testid="change-send">
              <ArrowUpwardRoundedIcon />
            </IconButton>
          )}
        </Box>
      </Box>
    </>
  );

  const notices = (
    <>
      {/* « Recommencer » empties the draft and the conversation (named scenarios stay): said in words, confirmed first. */}
      {resetting && (
        <Box role="alertdialog" aria-labelledby="change-reset-text" data-testid="change-reset-confirm" sx={{ mb: 1, p: 1, borderRadius: "8px", background: alpha(theme.palette.warning.main, 0.1), display: "flex", flexDirection: "column", gap: 0.75 }}>
          <Typography id="change-reset-text" sx={{ fontSize: "0.76rem", lineHeight: 1.45 }}>{t("transform.reset.confirm")}</Typography>
          <Box sx={{ display: "flex", gap: 0.75 }}>
            <Button size="small" variant="contained" disableElevation color="warning" onClick={() => { setResetting(false); reset(); }} data-testid="change-reset-yes" sx={{ fontWeight: 600 }}>
              {t("transform.startOver")}
            </Button>
            <Button size="small" onClick={() => setResetting(false)} data-testid="change-reset-no" sx={{ color: "text.secondary" }}>
              {t("app.cancel")}
            </Button>
          </Box>
        </Box>
      )}
      {notice && (
        <Alert severity={notice.severity || "info"} sx={{ mb: 1, fontSize: "0.76rem" }} onClose={() => setNotice(null)} data-testid={`change-notice-${notice.kind}`}>
          {t(`transform.notice.${notice.kind}`, notice.params)}
        </Alert>
      )}
      {error && (
        <Alert severity="error" sx={{ mb: 1 }} onClose={() => setError(null)}>
          {error}
        </Alert>
      )}
    </>
  );

  // ── ③ Without the assistant: the work by hand where the conversation would be (ManualSidebar) ──
  const manualDocuments = (
    <Box data-testid="manual-documents" sx={{ display: "flex", flexDirection: "column", gap: 0.5 }}>
      {/* A request handed over (the chat, the Network Studio) stays readable here, to be written as operations by hand. */}
      {briefBanner && input.trim() && (
        <Alert severity="info" onClose={() => setBriefBanner(false)} data-testid="manual-handed-over" sx={{ fontSize: "0.74rem", mb: 0.5 }}>
          {t("manual.handedOver")}
          <Box component="blockquote" sx={{ m: 0, mt: 0.5, pl: 1, borderLeft: `3px solid ${theme.palette.divider}`, whiteSpace: "pre-wrap", fontStyle: "italic" }}>
            {input.trim()}
          </Box>
        </Alert>
      )}
      <DocumentDrop pending={documents} records={project?.documents || []} retentionDays={retentionDaysOf(features?.workspace, signedIn)} retentionUntil={project?.retention_until || null} onAttach={attach} onRemove={removeDocument} disabled={documents.length >= MAX_DOCUMENTS} hint={t("manual.documents.hint")} testid="manual-drop" itemTestid="change-document" />
    </Box>
  );
  // The line an operation or an objective names, put in focus on the map (again: out of focus); a narrow screen shows
  // the map's tab, where the line is drawn.
  const focusLine = (id) => {
    const next = id && String(id) !== String(lineFocus) ? String(id) : null;
    setLineFocus(next);
    if (next && !wide && step === 3) setTab("map");
  };
  const lineOfOperation = (op) => {
    const id = routeOfOperation(op, routes);
    return id ? { line: routeLabelOf(id, routes), onFocusLine: () => focusLine(id), focused: String(id) === String(lineFocus) } : {};
  };
  const lineOfObjective = (clauseId) => {
    const id = routeOfClause((contract.clauses || []).find((c) => c?.id === clauseId), routes);
    return id ? { id, label: routeLabelOf(id, routes) } : null;
  };
  // A line picked first (LinePicker): the form opens with it filled in, as the operation takes it (`route` or `routes`).
  const pickOperation = (type) => {
    const def = catalogue.find((c) => c.type === type);
    const r = lineFocus ? routes.find((x) => x.id === lineFocus) : null;
    const one = r ? (def?.params || []).find((p) => p.type === "route") : null;
    const many = r && !one ? (def?.params || []).find((p) => p.type === "routes") : null;
    const name = r ? r.short_name || r.id : null;
    const params = one ? { [one.name]: name } : many ? { [many.name]: [name] } : null;
    setDialog({ initial: params ? { type, params } : { type } });
  };
  // ③ by hand: the suggestions added at ② as the work to do, each with its operation filled in.
  const retainedNow = retainedIds(contract);
  const objectives = (project?.context?.objectives || []).filter((o) => retainedNow.includes(o.id));
  const metObjectives = useMemo(() => {
    const results = preview?.conformance?.after?.results || [];
    const pass = new Set(results.filter((r) => r && r.status === "pass").map((r) => r.id));
    return objectives.filter((o) => {
      const ids = (contract.clauses || []).filter((c) => c?.source?.id === o.id).map((c) => c.id);
      return ids.length > 0 && ids.every((id) => pass.has(id));
    }).map((o) => o.id);
    // The objectives and the contract are read from the project; the simulation's results decide.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [preview, project?.context?.objectives, contract]);
  const openDraft = (draft) => {
    const def = catalogue.find((c) => c.type === draft.type);
    const names = new Set((def?.params || []).map((p) => p.name));
    const params = Object.fromEntries(Object.entries(draft.params || {}).filter(([name]) => names.has(name)));
    setDialog({ initial: def ? { type: draft.type, params } : null });
  };
  // What the journey read of each spreadsheet of the brief (cell by cell, without the assistant), said on its row at ①.
  // The cells it did not understand are said too, in the warning tone: kept to check by hand, read by the assistant
  // where it answers.
  const sheetNotes = Object.fromEntries([
    ...Object.entries(project?.context?.sheets || {}).map(([name, x]) => [name, x?.unread > 0 ? { tone: "warning", text: t(aiEnabled ? "documents.sheet.read.unread.assistant" : "documents.sheet.read.unread", { operations: x?.operations || 0, clauses: x?.clauses || 0, unread: x.unread }) } : t("documents.sheet.read", { operations: x?.operations || 0, clauses: x?.clauses || 0 })]),
    ...readingSheets.map((name) => [name, t("documents.sheet.reading")]),
  ]);

  // ── The autopilot: ③ builds the change by itself ──────────────
  // On arrival with the objectives decided and nothing written yet, the change is built without a click: the
  // timetables the brief's sheets state and the operations of the suggestions retained (read without a model), then
  // — where the assistant answers and the brief is prose — one planner turn the journey launches itself. Every
  // simulation settles the questions that carry their own answer (refresh: `auto`); the canonical validator runs on
  // the stable result (the effect above). Once per visit of a network: a plan the person emptied stays empty until
  // « Reconstruire » (`rebuild`). Never over a plan already written (kept for this network, handed over: what the
  // brief still holds is then offered, `offerPanel`), never on a frozen scenario.
  const autoKey = `${project?.id || "local"}:${fp || ""}`;
  // « Ran for this network »: kept with the project (context.autopilot) — a remount (an explorer round trip, another
  // device) never builds again a plan the person emptied, nor launches the planner a second time —, held here for a
  // studio without a project.
  // …and of the sources it built from (`sources`): a specification joined later builds on an empty change again.
  const [autoRanHere, setAutoRan] = useState(null);
  const ranFor = (mark) => (mark && mark.key === autoKey && (mark.sources ?? null) === sourcesKeyRef.current ? autoKey : null);
  const sourcesKeyRef = useRef(null);
  const markAutoRan = (key) => {
    setAutoRan(key ? { key, sources: sourcesKeyRef.current } : null);
    setAutoPlanned(null);
    if (project) onUpdateProject?.((p) => {
      const { autopilot: _gone, ...rest } = p.context || {}; // eslint-disable-line no-unused-vars
      return { ...p, context: key ? { ...rest, autopilot: { key, sources: sourcesKeyRef.current, at: new Date().toISOString() } } : rest };
    });
  };
  // « The assistant read the brief »: the journey's own turn ended without an error — kept with the project too.
  const [autoPlannedHere, setAutoPlanned] = useState(null);
  const autoPlanned = autoPlannedHere === autoKey || (Boolean(ranFor(project?.context?.autopilot)) && project.context.autopilot.planned === true);
  plannedRef.current = () => {
    setAutoPlanned(autoKey);
    if (project) onUpdateProject?.((p) => (p.context?.autopilot?.key === autoKey ? { ...p, context: { ...p.context, autopilot: { ...p.context.autopilot, planned: true } } } : p));
  };
  // ②'s « Mise en service », written in the operations the journey builds where the brief gives no date.
  const framing = framingDefaults(project?.context);
  const dated = (ops) => withDates(ops, framing, catalogue);
  const datesText = (from, to) => t(from && to ? "autopilot.dates.both" : from ? "autopilot.dates.from" : "autopilot.dates.to", { from: from || "", to: to || "" });
  const datesUsed = (framing.from_date || framing.to_date) && plan.operations.some((o) => (framing.from_date && o.params?.from_date === framing.from_date) || (framing.to_date && o.params?.to_date === framing.to_date));
  const [plannerDue, setPlannerDue] = useState(false);
  const offerMissing = offerToAdd(contractState.offer, plan);
  const suggestionOps = suggestionsToAdd(objectives, plan);
  const typedBrief = String(contract.brief || "").trim();
  // What only the assistant can turn into operations: a prose brief, a request typed at ②, a suggestion no single
  // operation carries out (a route to draw, a connection to align).
  const forAssistant = objectives.filter((o) => !suggestionsToAdd([o], null).length);
  // What the brief states that no objective measures and no operation carries out (a remark written in a cell, a
  // sentence kept « à vérifier à la main » at ②): never hidden behind « ready » — and, where the assistant answers,
  // read by its turn, which carries out the ones that ask for a change of service.
  // (A grid the change does not take is said by its own line, and is nothing the assistant can read: not a remark.)
  const remarks = (contract.wishes || []).filter((w) => w && !w.checked && w.id !== OVERFLOW_WISH && w.id !== OVERFLOW_WISHES && !GRID_WISH.test(String(w.id || "")) && String(w.quote || "").trim());
  // What the cell reader could not take and an operation of the change copied from its cells (the assistant's
  // read_grid: utils/sheetCoverage, a set-aside grid by its own trips' cells) is never said missing nor « à vérifier à
  // la main »: said covered, by that operation and the cells it cites — at ③, in the recap, in what ④ accepts and in
  // the delivered note; part of it still the person's when the operation copied only some of its cells.
  const coveredBy = sheetCoverage(plan.operations, preview?.steps, contractState.offer?.skipped);
  const opTitleOf = (o) => o.label || opTitle(t, o.type, catalogue.find((c) => c.type === o.type));
  const coveredText = (what, c) => ({ text: `${t("autopilot.line.covered.item", { what, ops: c.operations.map((o) => `${o.n} (${opTitleOf(o)})`).join(", "), cells: [...new Set(c.operations.flatMap((o) => o.cells))].join(", ") })}${c.whole ? "" : ` — ${t("ack.covered.partly")}`}`, whole: c.whole });
  const coveredOf = (item) => {
    const c = coverageOfItem(item, contract.wishes, coveredBy);
    return c ? { ...c, operations: c.operations.map((o) => ({ ...o, title: opTitleOf(o) })) } : null;
  };
  const plannerNeeded = aiEnabled && (turnDocumentIds.length > 0 || Boolean(typedBrief) || forAssistant.length > 0 || remarks.length > 0);
  const contractIsReady = contractReady(contract);
  // The one act of a change without objective: once recorded, simulated again (the gate reads the contract), then applied.
  const [oneAct, setOneAct] = useState(null); // null | "recording" | "simulating"
  const oneActBusy = useRef(false);
  useEffect(() => {
    if (oneAct !== "recording" || !contractIsReady) return;
    setOneAct("simulating");
    oneActBusy.current = false;
    autoValidated.current = null;
    refresh(planRef.current, { validate: true });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [oneAct, contractIsReady]);
  useEffect(() => {
    if (oneAct !== "simulating") return;
    if (previewing || validating) {
      oneActBusy.current = true;
      return;
    }
    if (!oneActBusy.current) return;
    setOneAct(null);
    if (applyState.canApply) applyRef.current?.apply();
    // The simulation's end leads; the act's state is read then.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [oneAct, previewing, validating]);
  // « Finaliser » asked: once the objectives are decided (the name given), the decision opens; a name not given leaves
  // the draft as it was (the next act of the person clears it).
  const [finalizing, setFinalizing] = useState(false);
  useEffect(() => {
    if (!finalizing || !contractIsReady || streaming) return;
    setFinalizing(false);
    // Simulated again whatever the validator said of this plan: the objectives just decided change the gate (a sentence
    // kept « à vérifier à la main » is no longer uncovered), and a simulation measured before them would refuse.
    autoValidated.current = null;
    refresh(planRef.current, { validate: true });
    onStep(5);
    // The decision opens once, on the objectives decided.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [finalizing, contractIsReady, streaming]);
  useEffect(() => {
    if (panelDialog || view === "network") setFinalizing(false);
  }, [panelDialog, view]);
  useEffect(() => {
    if (panel && streaming) setThreadOpen(true);
  }, [panel, streaming]);
  // A turn ended with sentences to settle: the thread folds, what is asked (with them at its head) shows again.
  const wasStreaming = useRef(false);
  useEffect(() => {
    if (wasStreaming.current && !streaming && panel && (contractState.coverage?.uncovered || []).some((x) => x && !x.unread)) setThreadOpen(false);
    wasStreaming.current = streaming;
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [streaming]);
  // The sheets read cell by cell are in the key by their operations (the offer): checking them too never launches
  // again a turn a person already settled.
  const sourcesKey = sourcesKeyOf({ offer: contractState.offer, objectives, documents: aiEnabled ? assistantDocumentIds : [], brief: aiEnabled ? typedBrief : "" });
  sourcesKeyRef.current = sourcesKey;
  const autoRan = ranFor(project?.context?.autopilot) || ranFor(autoRanHere);
  useEffect(() => {
    // (Never while a document of the brief is still being sent or read: its timetables would be missed.)
    if (step !== 3 || frozen || !networkOpen || !ws || !featuresLoaded || !contractIsReady || streaming || previewing || readingSheets.length || uploadingDocuments) return;
    if (autoRan === autoKey) return;
    markAutoRan(autoKey);
    if (!isPlanEmpty(plan)) return;
    const ops = dated([...offerMissing, ...suggestionOps]);
    if (ops.length) loadOperations(ops);
    // Under the free trial the turn is the person's act (the panel offers it): never a message spent by itself.
    if (plannerNeeded && autonomous) setPlannerDue(true);
    // The sources are read when the conditions are met: a plan being written is never a reason to run again.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [step, frozen, networkOpen, ws, featuresLoaded, contractIsReady, streaming, previewing, readingSheets.length, uploadingDocuments, plan, autoKey, autoRan, sourcesKey]);
  // The journey's own planner turn, once the operations read without a model are simulated: it starts from them.
  useEffect(() => {
    // Never before the contract is decided (the person went back to ② and reopened it: the turn waits for them).
    if (!plannerDue || step !== 3 || frozen || streaming || previewing || !contractIsReady) return;
    setPlannerDue(false);
    const lines = [t("autopilot.brief.intro")];
    if (typedBrief) lines.push(typedBrief);
    if (sheetsForAssistant.length) lines.push(t("autopilot.brief.sheets", { names: sheetsForAssistant.map((d) => d.name).join(", ") }));
    if (sheetsToCheck.length) lines.push(t("autopilot.brief.sheetsCheck", { names: sheetsToCheck.map((d) => d.name).join(", ") }));
    if (framing.from_date || framing.to_date) lines.push(t("autopilot.brief.dates", { dates: datesText(framing.from_date, framing.to_date) }));
    const fromSheets = plan.operations.filter((o) => o?.source?.offer).length;
    const fromSuggestions = plan.operations.filter((o) => o?.source?.objective).length;
    if (plan.operations.length) lines.push(t(fromSheets && !fromSuggestions ? "autopilot.brief.pinned" : fromSuggestions && !fromSheets ? "autopilot.brief.pinned.suggestions" : "autopilot.brief.pinned.mixed", { count: plan.operations.length, sheets: fromSheets, suggestions: fromSuggestions }));
    if (forAssistant.length) lines.push(`${t("autopilot.brief.suggestions")}\n${forAssistant.map((o) => `- ${recommendationTitle(o, t, language)}`).join("\n")}`);
    if (remarks.length) lines.push(`${t("autopilot.brief.remarks")}\n${remarks.slice(0, 40).map((w) => `- ${String(w.quote).replace(/\s+/g, " ").trim().slice(0, 400)}`).join("\n")}`);
    runPlanner(lines.join("\n\n"), { autopilot: true, documentIds: turnDocumentIds });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [plannerDue, step, frozen, streaming, previewing, contractIsReady]);
  // « Reconstruire »: the plan emptied and built again from the brief and the objectives as they now are.
  const rebuild = () => {
    stopPlanner();
    markAutoRan(null);
    setPlannerDue(false);
    setTurns([]);
    setError(null);
    dropSimulations();
    setPreview(null);
    // The change is built again from the brief; the person's own retouches stay (they are no reading of the brief).
    const kept = planRef.current.operations.filter(isHand);
    setPlan(kept.length ? { ...EMPTY_PLAN, operations: kept } : EMPTY_PLAN);
  };
  // The journey's own question: grids of the brief under a title the sheet reader could not read as a day type.
  const dayTitles = dayTitleQuestions(contractState.offer);
  const answerDayTitle = (title, value) => {
    const mine = (contractState.offer?.skipped || []).filter((s) => s?.pending && !s.answer && String(s.title || "").trim() === String(title || "").trim());
    const { offer: next, operations: built } = withDayTitle(contractState.offer, title, value);
    contractState.setOffer(next);
    // Said by the person: their timetables join the change like the others (each marked with its place in the offer).
    if (built.length) loadOperations(dated(built.map(({ op, index }) => offerOperation(next, op, index))));
    // « Ne pas les reprendre »: grids of the order set aside — kept « à vérifier à la main », said at the delivery.
    else if (mine.length) contractState.setContract((c) => ({ ...c, wishes: [...(c.wishes || []), ...gridWishesOf(c.wishes || [], mine, mine[0]?.document || "")] }));
  };
  // The prose brief's line follows what really happened to the journey's own turn (never « lu » after a failure,
  // never « à lire » on a change already built from it).
  const autoTurn = [...turns].reverse().find((x) => x.auto && x.role === "assistant") || null;
  // (A question answered in the conversation — kept on it, `answer` — waits for nothing any more.)
  const autoAsked = Boolean(autoTurn && !streaming && !autoTurn.error && (autoTurn.questions || []).some((q) => q?.answer == null) && !(autoTurn.steps || []).some((s) => s.kind === "plan"));
  const pilot = autopilotView({ plan, preview, previewing, validating, streaming, reading: readingSheets.length > 0, contractReady: contractIsReady || !briefGiven, frozen: Boolean(frozen), asked: dayTitles.length, validationFailed: validateFailed, simulationFailed: Boolean(error) && !preview && plan.operations.length > 0 });
  // The journey asks a question: its thread comes forward in the supporting pane (the person may be on the plan).
  // A standing hold (« blocked »: the objectives to decide, the validator's errors) is said by the tab's dot, never by
  // pulling the person off the plan they are writing.
  useEffect(() => {
    if (pilot.stage === "questions") setSupportTab("assistant");
  }, [pilot.stage]);
  const decisions = autoAssumptionsOf(plan);
  // The prose documents the assistant may read; one the person kept from it (sent_to_assistant false) is said so.
  const proseWaiting = turnDocumentIds.length;
  const proseKept = documents.filter((d) => d.status === "ready" && !SHEET_RE.test(d.name || "") && d.sent_to_assistant === false).length;
  const briefState = !proseWaiting ? (proseKept ? "kept" : null) : !aiEnabled ? "locked" : streaming && autoTurn && !autoTurn.done ? "reading" : autoTurn?.error ? "failed" : autoAsked ? "asked" : autoTurn?.done || autoPlanned ? "read" : plannerDue || autoRan !== autoKey ? "waiting" : "unread";
  // What the assistant did with each prose document of the brief, on its row at ① (the reading is seen where the
  // document was dropped, not only on ③'s line): the same state as ③'s brief line,
  // never a sheet (the cell reader's note says those). One the person kept from the assistant is said so.
  const proseNotes = Object.fromEntries(
    documents
      .filter((d) => d.status === "ready" && !SHEET_RE.test(d.name || ""))
      .map((d) => {
        const state = d.sent_to_assistant === false ? "kept" : briefState;
        return state ? [d.name, { tone: PROSE_TONE[state] || "info", text: t(`documents.prose.${state}`) }] : null;
      })
      .filter(Boolean),
  );
  const documentNotes = { ...sheetNotes, ...proseNotes };
  // The blocks the cell reader set aside and the points it kept to check, apart from what an operation covers.
  const blocksAside = (contractState.offer?.skipped || []).filter((x) => !(x?.pending && x.title && !x.answer));
  const pointText = (w) => `${String(w.quote)}${w.cell ? ` (${w.cell})` : ""}`;
  const autopilotPanel =
    step === 3 && !frozen ? (
      <AutopilotPanel
        view={pilot}
        seconds={validating ? validateSeconds : streaming ? planSeconds : previewSeconds}
        onStop={streaming ? stopPlanner : null}
        feed={streaming ? turns[turns.length - 1]?.tools || [] : []}
        impact={preview?.impact && !preview.impact.error && plan.operations.length > 0 ? preview.impact : null}
        sources={{ grids: (contractState.offer?.operations || []).length, gridsMissing: offerMissing.length, skipped: blocksAside.filter((x) => !coveredBy(x)), covered: [...blocksAside.filter(coveredBy).map((x) => coveredText(x.label || "?", coveredBy(x))), ...remarks.filter(coveredBy).map((w) => coveredText(pointText(w), coveredBy(w)))], suggestions: objectives.length, remarks: remarks.filter((w) => !coveredBy(w)).map(pointText), assistant: aiEnabled, briefState, asked: autoAsked, dates: datesUsed ? datesText(framing.from_date ? localDate(framing.from_date, lang) : null, framing.to_date ? localDate(framing.to_date, lang) : null) : null }}
        rebuildNote={plannerNeeded ? t("autopilot.rebuild.assistant") : null}
        onErrors={() => onStep(5)}
        onRevalidate={() => {
          autoValidated.current = preview?.id || null;
          refresh(plan, { validate: true });
        }}
        onRetryBrief={contractIsReady && aiEnabled ? () => setPlannerDue(true) : null}
        onResimulate={() => refresh(plan)}
        questions={questionsOf(plan, preview)}
        dayTitles={dayTitles}
        onDayTitle={answerDayTitle}
        decisions={decisions}
        catalogue={catalogue}
        disabled={busy}
        lock={!aiEnabled && proseWaiting > 0 ? assistantLock : null}
        onAnswer={answer}
        onDecision={(item, value) => updatePlan(withDecision(plan, item, value))}
        onObjectives={() => onStep(2)}
        onRebuild={contractIsReady && (offerMissing.length || (contractState.offer?.operations || []).length || objectives.length || plannerNeeded) ? rebuild : null}
        onDelivery={!stuck && plan.operations.length && !busy ? simulateAndCheck : null}
      />
    ) : null;
  // The brief's timetables the plan does not hold (the person removed one, a sheet joined later): offered again.
  const offerPanel = !frozen && offerMissing.length && (autoRan === autoKey || !contractIsReady) ? <OfferOperations offer={contractState.offer} plan={plan} disabled={busy} onAdd={(op) => saveOp(dated([op])[0])} onAddAll={(ops) => loadOperations(dated(ops))} /> : null;
  const operations = (
    <Box sx={{ display: "flex", flexDirection: "column", gap: 1 }}>
      {/* The offer sheet imported at ②: its timetables, one operation each, added by the person. */}
      {/* By hand, the brief's timetables are the guide's (the left column); with the assistant, they stay here. */}
      {!manual && offerPanel}
      {!plan.operations.length && <Typography sx={{ fontSize: "0.8rem", color: "text.secondary", p: 1 }}>{t(aiEnabled ? "transform.emptyPlanHint" : "transform.emptyPlanHint.manual")}</Typography>}
      {/* What the simulated plan costs, in sight while it is written (the same figures ⑤ shows before applying) —
          once the change is ready, the autopilot's panel says them in its own place, not twice on one screen. */}
      {preview?.impact && !preview.impact.error && plan.operations.length > 0 && !(autopilotPanel && pilot.stage === "ready") && <ImpactStrip impact={preview.impact} testid="change-plan-impact" />}
      {optimizerOrigin && (
        <Box data-testid="change-optimizer-origin" sx={{ p: 1.25, borderRadius: "12px", background: alpha(theme.palette.secondary.main, 0.08) }}>
          <Typography sx={{ fontSize: "0.78rem", fontWeight: 800 }}>{t("transform.optimize.originTitle", { objective: optimizerOrigin.label || optimizerOrigin.objective || "" })}</Typography>
          <Typography sx={{ fontSize: "0.72rem", color: "text.secondary", lineHeight: 1.5 }}>{t("transform.optimize.originHint")}</Typography>
          {optimizerOrigin.kpis_before && optimizerOrigin.kpis_after && (
            <Typography sx={{ fontSize: "0.72rem", mt: 0.5, fontVariantNumeric: "tabular-nums" }} data-testid="change-optimizer-kpis">
              {[
                // An estimate of no trip at all is none (utils/ridership): no « 0 → 0 » line.
                estimatedTrips(null, optimizerOrigin.kpis_after) != null && estimatedTrips(null, optimizerOrigin.kpis_before) != null ? t("transform.optimize.kpi.trips", { before: Math.round(optimizerOrigin.kpis_before.trips_day).toLocaleString(lang), after: Math.round(optimizerOrigin.kpis_after.trips_day).toLocaleString(lang) }) : null,
                optimizerOrigin.kpis_after.fleet_peak != null && optimizerOrigin.kpis_before.fleet_peak != null ? t("transform.optimize.kpi.fleet", { before: optimizerOrigin.kpis_before.fleet_peak, after: optimizerOrigin.kpis_after.fleet_peak }) : null,
                optimizerOrigin.kpis_after.cost_year != null && optimizerOrigin.kpis_before.cost_year != null ? t("transform.optimize.kpi.cost", { before: Math.round(optimizerOrigin.kpis_before.cost_year).toLocaleString(lang), after: Math.round(optimizerOrigin.kpis_after.cost_year).toLocaleString(lang), currency: optimizerOrigin.kpis_after.currency || "EUR" }) : null,
              ]
                .filter(Boolean)
                .join(" · ")}
            </Typography>
          )}
        </Box>
      )}
      {/* A frozen scenario's operations are read only: no answer, no edit, no move, no removal. */}
      <Box data-testid="change-operations" data-frozen={frozen ? "true" : "false"} sx={{ display: "flex", flexDirection: "column", gap: 1, ...(frozen ? { pointerEvents: "none", opacity: 0.85 } : {}) }} aria-disabled={frozen ? "true" : undefined}>
        {plan.operations.map((op, i) => (
          <OperationCard key={op.id} op={op} step={frozen ? null : stepOf(op.id)} def={catalogue.find((c) => c.type === op.type)} index={i} count={plan.operations.length} busy={busy || Boolean(frozen)} shared={shared} onAnswer={answer} onRemove={removeOp} onMove={moveOp} onEdit={(o) => setDialog({ initial: o })} appliedIn={frozen ? frozen.n : null} {...lineOfOperation(op)} />
        ))}
      </Box>
      {(plan.assumptions || []).some((a) => !a?.auto) && (
        <Box sx={{ p: 1.25, borderRadius: "12px", background: soft(theme) }} data-testid="change-assumptions">
          <Typography sx={{ fontSize: "0.78rem", fontWeight: 800, mb: 0.5 }}>{t("transform.assumptions")}</Typography>
          {plan.assumptions.filter((a) => !a?.auto).map((a, i) => {
            // A point of the brief's sheets an operation builds from its cells is said covered by that operation, as ④
            // and the note say it (coveredOf) — never « à vérifier à la main » beside the operation that carries it out.
            const said = assumptionSaid(a);
            const covered = said.said === "wish" ? coveredOf({ kind: "assumption", wish: true, quote: said.quote, ...(said.why ? { why: said.why } : {}) }) : null;
            return (
              <Typography key={i} data-testid="change-assumption" data-covered={covered ? (covered.whole ? "whole" : "partly") : undefined} sx={{ fontSize: "0.74rem", lineHeight: 1.5 }}>
                {/* The server's own sentences (a requirement nobody can measure…) in the reader's words, never in English. */}
                • {covered ? coveredSentence(t, said.quote, covered) : assumptionWords(a, t)}
                {a.confidence ? ` (${t(`transform.confidence.${a.confidence}`)})` : ""}
              </Typography>
            );
          })}
        </Box>
      )}
    </Box>
  );

  const sidebar = manual ? (
    <ManualSidebar
      autopilot={autopilotPanel}
      autopilotIdle={pilot.stage === "locked" || pilot.stage === "empty"}
      objectives={objectives.length && (suggestionOps.length > 0 || forAssistant.length > 0) ? <ObjectivesToDo objectives={objectives} met={metObjectives} onOpen={openDraft} onLoad={loadOperations} disabled={streaming || Boolean(frozen)} /> : null}
      job="modify"
      // Said once: where a prose brief waits for the assistant, the journey's panel already shows the lock.
      locked={assistantLock && !(proseWaiting > 0) ? <LockedAction lock={assistantLock}>{t("manual.locked.describe")}</LockedAction> : null}
      offer={offerPanel}
      progress={contractClausesCount ? <ObjectivesProgress results={preview?.conformance?.after?.results || null} count={contractObjectivesCount} previewing={previewing} onOpen={() => onStep(2)} lineOf={lineOfObjective} onFocusLine={focusLine} focus={lineFocus} /> : null}
      verdict={plan.operations.length > 0 && !contractClausesCount ? <VerdictCard payload={preview ? { verdict: preview.verdict ?? null, gate: preview.gate, validation: preview.validation } : null} variant="turn" /> : null}
      contract={contractClausesCount ? null : { status: contractStatus, count: contractClausesCount, onOpen: () => onStep(2) }}
      routes={routes}
      selectedRoute={lineFocus}
      onSelectRoute={setLineFocus}
      catalogue={catalogue}
      catalogueLoading={!catalogueLoaded}
      onPick={pickOperation}
      disabled={streaming || Boolean(frozen)}
      documents={manualDocuments}
    />
  ) : null;

  // With the assistant: one thread — the turns above, the
  // journey's own card (what it reads and asks, its choices, « prêt ») pinned under them, above the composer: a
  // question is never under the fold while a turn streams and scrolls the thread.
  const assistantColumn = conversationWith(
    autopilotPanel ? (
      <Box data-testid="change-thread-status" sx={{ flexShrink: 0, maxHeight: pilot.stage === "questions" || pilot.stage === "blocked" ? "70%" : "50%", overflowY: "auto", px: 1.5, pt: 1, pb: 0.5, borderTop: `1px solid ${theme.palette.divider}` }}>
        {autopilotPanel}
      </Box>
    ) : null,
  );

  // In the draft's screen the reader is the other view: shown first, then led to the line.
  const openReader = onOpenReader ? (line) => {
    if (panel) onView?.("network");
    onOpenReader(line);
  } : null;
  // The reader of the draft at the centre (ChangeReview):
  // the lines the draft touches as chips, the line in focus read in its timetable « Avant | Après » through the
  // API's lens or on the map of the change; the full-width reader one click away (`onOpenReader`). In a box of its
  // own height where the page scrolls (a smaller screen).
  const review = (
    <ChangeReview
      preview={frozen ? null : preview}
      previewing={previewing}
      operations={plan.operations.length}
      frozen={frozen ? frozen.n : null}
      focus={lineFocus}
      onFocus={(id) => setLineFocus(id ? String(id) : null)}
      routes={routes}
      defaultDate={project?.context?.from_date || (overview?.range?.start ? String(overview.range.start).replace(/^(\d{4})-?(\d{2})-?(\d{2})$/, "$1-$2-$3") : null)}
      onOpenReader={openReader}
      onOpenObjectives={() => onStep(2)}
      hint={panel ? null : t("transform.review.keys")}
      edit={retouchEdit}
    />
  );
  const reviewBox = (height) => (
    <Box data-testid="change-review-box" sx={{ position: "relative", height, minHeight: 360, border: `1px solid ${theme.palette.divider}`, borderRadius: "12px", overflow: "hidden" }}>
      {review}
    </Box>
  );
  const pane = (
    <>
      <Box sx={{ display: "flex", alignItems: "center", gap: 1, px: 1.5, py: 0.5, borderBottom: `1px solid ${theme.palette.divider}`, background: theme.palette.background.paper }}>
        <Box sx={{ flex: 1, minWidth: 0 }}>
          <ScenarioSwitcher ws={ws} disabled={busy} onSwitch={switchTo} onSaveAs={saveAs} onDuplicate={duplicate} onRename={rename} onDelete={remove} onExport={exportActive} onImport={importFile} onCompare={() => setCompareOpen(true)} suggestedName={plan.title || t("transform.scenario.defaultName", { n: (ws?.scenarios.length || 0) + 1 })} appliedIn={frozen ? frozen.n : null} />
        </Box>
        <Tooltip title={t("transform.references.title")}>
          <IconButton size="small" onClick={() => setRefsOpen(true)} aria-label={t("transform.references.title")} data-testid="change-references-open">
            <TrainOutlinedIcon />
          </IconButton>
        </Tooltip>
        <Tooltip title={t("transform.startOver")}>
          <span>
            <IconButton size="small" onClick={() => setResetting(true)} disabled={streaming || Boolean(frozen)} aria-label={t("transform.startOver")} data-testid="change-reset">
              <RestartAltIcon />
            </IconButton>
          </span>
        </Tooltip>
      </Box>
      <Box sx={{ display: "flex", alignItems: "center", pl: 0.5, pr: 1, borderBottom: `1px solid ${theme.palette.divider}`, background: theme.palette.background.paper }}>
        {wide ? (
          // Side by side (below): no tab to switch, the two titles say what each half holds.
          <Typography component="h2" data-testid="change-pane-title" sx={{ flex: 1, minWidth: 0, display: "flex", alignItems: "center", gap: 0.75, minHeight: 40, px: 1, fontSize: "0.82rem", fontWeight: 700 }}>
            <PlaylistAddCheckIcon sx={{ fontSize: 16, color: "primary.main" }} />
            {`${t("step.3.tab.operations")}${plan.operations.length ? ` (${plan.operations.length})` : ""}`}
            <Box component="span" sx={{ color: "text.disabled", fontWeight: 400 }}>·</Box>
            <MapOutlinedIcon sx={{ fontSize: 16, color: "text.secondary" }} />
            <Box component="span" sx={{ fontWeight: 600, color: "text.secondary" }}>{t("transform.tab.changes")}</Box>
          </Typography>
        ) : (
          <Tabs value={tab === "plan" ? "plan" : "map"} onChange={(_, v) => setTab(v)} variant="scrollable" scrollButtons="auto" allowScrollButtonsMobile sx={{ flex: 1, minWidth: 0, minHeight: 40, "& .MuiTab-root": tabSx }}>
            <Tab value="plan" icon={<PlaylistAddCheckIcon sx={{ fontSize: 16 }} />} iconPosition="start" label={`${t("step.3.tab.operations")}${plan.operations.length ? ` (${plan.operations.length})` : ""}`} data-testid="change-tab-plan" />
            <Tab value="map" icon={<MapOutlinedIcon sx={{ fontSize: 16 }} />} iconPosition="start" label={t("transform.tab.changes")} data-testid="change-tab-map" />
          </Tabs>
        )}
        {isMobile ? (
          <Tooltip title={t("transform.addOperation")}>
            <span>
              <IconButton size="small" color="primary" onClick={() => setDialog({ initial: null })} disabled={streaming || Boolean(frozen)} aria-label={t("transform.addOperation")} data-testid="change-add">
                <AddIcon />
              </IconButton>
            </span>
          </Tooltip>
        ) : (
          <Button size="small" startIcon={<AddIcon />} onClick={() => setDialog({ initial: null })} disabled={streaming || Boolean(frozen)} data-testid="change-add" sx={{ textTransform: "none", fontWeight: 700, flexShrink: 0 }}>
            {t("transform.addOperation")}
          </Button>
        )}
      </Box>
      {wide && fill ? (
        // Filling the window: the operations scroll on their own, the map takes the column's whole height.
        <Box data-testid="change-atelier" data-fill="true" sx={{ flex: 1, minHeight: 0, display: "grid", gridTemplateColumns: "minmax(0, 1fr) minmax(0, 1.15fr)", gridTemplateRows: "minmax(0, 1fr)", gap: 1.5, p: 1.5 }}>
          <Box sx={{ minWidth: 0, minHeight: 0, overflowY: "auto", pr: 0.5 }}>
            {notices}
            {operations}
          </Box>
          <Box sx={{ minWidth: 0, minHeight: 0 }}>{reviewBox("100%")}</Box>
        </Box>
      ) : (
      <Box sx={{ flex: 1, minHeight: 0, overflowY: "auto", p: 1.5 }}>
        {notices}
        {wide ? (
          <Box data-testid="change-atelier" sx={{ display: "grid", gridTemplateColumns: "minmax(0, 1fr) minmax(0, 1.15fr)", gap: 1.5, alignItems: "start" }}>
            <Box sx={{ minWidth: 0 }}>{operations}</Box>
            <Box sx={{ minWidth: 0, position: "sticky", top: 0 }}>{reviewBox(640)}</Box>
          </Box>
        ) : tab === "map" ? (
          reviewBox(isMobile ? 560 : 680)
        ) : (
          operations
        )}
      </Box>
      )}
    </>
  );

  // The status line: the compact verdict, then the next thing to do; before a simulation, what is happening.
  const statusLine = (
    <Typography component="div" data-testid="change-status" data-status={status.key.replace("transform.", "")} sx={{ flex: "1 1 280px", minWidth: 0, fontSize: "0.78rem", fontWeight: 600, color: `${status.tone}.main`, display: "flex", flexWrap: "wrap", alignItems: "center", columnGap: 0.75 }}>
      {frozen ? (
        t("scenario.state.applied", { n: frozen.n })
      ) : preview && !previewing && plan.operations.length > 0 ? (
        <>
          <VerdictCard payload={{ verdict: preview.verdict ?? null, gate: preview.gate, validation: preview.validation }} variant="compact" measured counts={pageCounts} />
          <span>{nextStep(status, preview, t)}</span>
        </>
      ) : (
        t(status.key, status.params)
      )}
    </Typography>
  );
  const changeFooter = (
    <>
      {statusLine}
      <Tooltip title={t("transform.previewAgain")}>
        <span>
          <IconButton size="small" onClick={() => refresh(plan)} disabled={!plan.operations.length || previewing || streaming || Boolean(frozen)} aria-label={t("transform.previewAgain")} data-testid="change-refresh">
            {previewing ? <CircularProgress size={16} /> : <RefreshIcon />}
          </IconButton>
        </span>
      </Tooltip>
      {/* The way to the delivery is the step's one primary action (StepFrame's « Voir la livraison »), never a second
          button here. */}
    </>
  );

  // ── ① The network chosen, and the network as it is ───────────────────────
  const networkCard = overview && !overview.failed ? (
    <Box data-testid="network-card" sx={{ p: 1.25, mb: 1.25, borderRadius: "12px", border: `1px solid ${theme.palette.divider}`, background: theme.palette.background.paper }}>
      <Typography sx={{ fontSize: "0.9rem", fontWeight: 800 }}>{network?.name || project?.network?.name || ""}</Typography>
      <Typography sx={{ fontSize: "0.78rem", color: "text.secondary" }}>
        {t("step.network.summary", { routes: formatNumber(overview.counts?.routes ?? 0, language), trips: formatNumber(overview.counts?.trips ?? 0, language), from: formatYmd(overview.range?.start || overview.range?.from, language) || "—", to: formatYmd(overview.range?.end || overview.range?.to, language) || "—" })}
      </Typography>
      {network?.validation && <Typography data-testid="network-reference-validation" sx={{ fontSize: "0.76rem", mt: 0.5 }}>{t("network.reference.validation", { errors: formatNumber(network.validation.errors ?? 0, language), warnings: formatNumber(network.validation.warnings ?? 0, language), time: network.validation.time || "" })}</Typography>}
    </Box>
  ) : (
    <Alert severity="info" data-testid="network-choose-notice" action={onChooseNetwork ? <Button color="inherit" size="small" onClick={onChooseNetwork} data-testid="network-choose" sx={{ textTransform: "none", fontWeight: 700 }}>{t("step.network.choose")}</Button> : null} sx={{ mb: 1.25, fontSize: "0.8rem" }}>
      {t("step.network.none")}
    </Alert>
  );
  // The Diagnostic stays mounted while the project is open (its estimate is not re-run at each visit of ①, and the
  // demand data uploaded there keep calibrating the planner at ③): rendered once into a host element that ① hosts.
  const diagHost = useMemo(() => (typeof document !== "undefined" ? document.createElement("div") : null), []);
  const diagSlot = useCallback(
    (el) => {
      if (el && diagHost && diagHost.parentNode !== el) el.appendChild(diagHost);
    },
    [diagHost],
  );
  const diagnostic = overview && !overview.failed ? (
    <Box data-testid="change-diagnostic">
      <DiagnosticPanel health={health} feedKey={overview ? fp || "unidentified" : null} busy={busy} onOptimized={(result, name, meta) => { onOptimized(result, name, meta); onStep(3); }} onDataChange={setDemandDataIds} />
    </Box>
  ) : null;
  // ① shows the network chosen and the brief; the network as it is — its measured diagnosis, the ridership data, the
  // optimiser — is folded under them, opened on demand (no map at ①: the reader is where the network is looked at).
  const diagnosticFold = networkOpen ? (
    <Accordion disableGutters elevation={0} data-testid="change-asis" sx={{ borderRadius: "12px !important", border: `1px solid ${theme.palette.divider}`, "&:before": { display: "none" }, backgroundColor: "background.paper" }}>
      <AccordionSummary expandIcon={<ExpandMoreIcon />} aria-controls="change-asis-body" id="change-asis-head" data-testid="change-asis-toggle">
        <Box sx={{ display: "flex", alignItems: "center", gap: 1, minWidth: 0 }}>
          <MonitorHeartOutlinedIcon aria-hidden sx={{ fontSize: 18, color: "text.secondary" }} />
          <Box sx={{ minWidth: 0 }}>
            <Typography component="h2" sx={{ fontSize: "0.88rem", fontWeight: 700 }}>{t("network.diagnostic")}</Typography>
            <Typography sx={{ fontSize: "0.74rem", color: "text.secondary", lineHeight: 1.4 }}>{t("network.diagnostic.fold")}</Typography>
          </Box>
        </Box>
      </AccordionSummary>
      <AccordionDetails id="change-asis-body" sx={{ pt: 0 }}>
        <div ref={diagSlot} data-testid="diagnostic-slot" />
      </AccordionDetails>
    </Accordion>
  ) : null;
  // ── ⑤ The apply section, then its result ─────────────────────────────────
  const appliedResult = frozen ? (
    <Box data-testid="change-apply-result" sx={{ display: "flex", flexDirection: "column", gap: 1 }}>
      <AppliedBanner n={frozen.n} onUndo={() => undoApplication(frozen.editId)} undoing={undoing} />
      <Typography sx={{ fontSize: "0.8rem" }} data-testid="change-applied-by">
        {t("step.delivery.appliedBy", { n: frozen.n, name: frozen.by || "—" })}
      </Typography>
      <Box sx={{ display: "flex", gap: 1, flexWrap: "wrap" }}>
        <Button size="small" variant="outlined" onClick={newScenarioFromVersion} data-testid="scenario-new-from-version" sx={{ textTransform: "none", fontWeight: 700 }}>
          {t("scenario.newFromVersion", { n: frozen.n })}
        </Button>
      </Box>
    </Box>
  ) : null;
  const applySection = frozen ? (
    appliedResult
  ) : (
    <ApplyDialog open compact={panel} controlRef={applyRef} onState={setApplyState} onClose={() => onStep(3)} preview={preview} plan={plan} catalogue={catalogue} editing={editing} enterEditMode={enterEditMode} refresh={refresh} onApplied={onApplied} beforeCommit={captureCoherence} onNavigate={(where) => {
        // In the draft, a sentence to settle is shown where it is settled (the head of what is asked), the dialog closed.
        if (panel && where === "contract") {
          setPanelDialog(null);
          showUncovered();
          return;
        }
        onStep(where === "contract" ? 2 : 3);
      }} coveredOf={coveredOf} />
  );
  // The coherence report (④, the note, ⑤): the simulation before → after, framed by ①'s change; once applied,
  // the comparison kept with the frozen scenario — the network as it now is only when none was kept, said so.
  const frozenReport = frozen ? (projectScenario?.applied_version_id ? projectScenario.coherence || null : appliedLocal?.coherence || null) : null;
  const coherenceSource = frozen ? (frozenReport ? { kind: "static", report: frozenReport } : { kind: "network", clauses: coherenceClauses }) : preview?.id && !preview.empty ? { kind: "preview", previewId: preview.id, clauses: coherenceClauses, framing: project?.context || null } : null;
  const coherenceNote = frozen ? (frozenReport ? t("coherence.frozen.kept", { n: frozen.n }) : t("coherence.frozen.fallback", { n: frozen.n })) : null;
  // The note: of the simulation while nothing is applied; once applied, of the version (what the scenario kept of its
  // simulation, read again after a reload, and the version's own record).
  const noteSimulation = frozen ? notePreview : preview;
  const deliverNote = () => coherenceDownloads.run("note", coherenceSource, (got) => downloadSynthesis({ plan, preview: noteSimulation, applied: frozen ? noteApplied : null, t, language, coherence: noteCoherence(got, t), coveredOf }), { required: false });
  const deliverCsv = () => coherenceDownloads.run("csv", coherenceSource, (got) => got.report && downloadCoherenceCsv(got.report, t, language));
  // The service-méthode files: the server's, from the simulation it reads again, or — once applied —
  // from the network as it now is (the version), whose header names it; the project's labels printed as they are.
  const reportVersion = latestVersionOf(project);
  const fileSource = coherenceSource?.kind === "static" ? { kind: "network", clauses: coherenceClauses } : coherenceSource;
  const fileLabels = { network: project?.network?.name || project?.name || null, version: reportVersion ? `v${reportVersion.n}` : null, versionAt: reportVersion?.at ? String(reportVersion.at).slice(0, 10) : null };
  // « Chaque ligne cochée devient une clause »: on the version the rows describe (the simulation's « avant »).
  const contractAdd = coherenceContractAdd({ contractState, version: reportVersion, onOpenContract: () => onStep(2), journey: "modify" });
  const deliverables = (
    <Box sx={{ display: "flex", flexDirection: "column", gap: 0.75 }}>
      <Box component="ul" data-testid="delivery-list" sx={{ m: 0, p: 0, listStyle: "none", display: "flex", flexDirection: "column", gap: 0.75 }}>
        {/* In the draft's decision the GTFS is its own first button: no row repeating it. */}
        {!panel && (
          <Box component="li" data-testid="delivery-gtfs" sx={{ display: "flex", alignItems: "center", flexWrap: "wrap", gap: 1 }}>
            <Typography sx={{ flex: 1, minWidth: 200, fontSize: "0.82rem", fontWeight: 700 }}>{t("delivery.gtfs")}</Typography>
            {/* Downloaded by the step's one primary action (« Livrer », once applied): no second button on the row. */}
            <Typography data-testid="delivery-gtfs-note" sx={{ fontSize: "0.74rem", color: "text.secondary" }}>{t(frozen ? "step.delivery.gtfs.primary" : "step.delivery.afterApply")}</Typography>
          </Box>
        )}
        <Box component="li" data-testid="delivery-note" sx={{ display: "flex", alignItems: "center", flexWrap: "wrap", gap: 1 }}>
          <Typography sx={{ flex: 1, minWidth: 200, fontSize: "0.82rem", fontWeight: 700 }}>{t("delivery.note")}</Typography>
          <CoherenceRunning downloads={coherenceDownloads} id="note" />
          <Button size="small" variant="outlined" startIcon={coherenceDownloads.running === "note" ? <CircularProgress size={12} color="inherit" /> : <DescriptionOutlinedIcon />} onClick={deliverNote} disabled={!noteSimulation || Boolean(coherenceDownloads.running)} data-testid="delivery-note-download" sx={{ textTransform: "none", fontWeight: 700 }}>
            {t("delivery.download")}
          </Button>
        </Box>
        <Box component="li" data-testid="delivery-coherence" sx={{ display: "flex", alignItems: "center", flexWrap: "wrap", gap: 1 }}>
          <Typography sx={{ flex: 1, minWidth: 200, fontSize: "0.82rem", fontWeight: 700 }}>{t("delivery.coherence")}</Typography>
          <CoherenceRunning downloads={coherenceDownloads} id="csv" />
          <Button size="small" variant="outlined" startIcon={coherenceDownloads.running === "csv" ? <CircularProgress size={12} color="inherit" /> : <FileDownloadOutlinedIcon />} onClick={deliverCsv} disabled={!coherenceSource || Boolean(coherenceDownloads.running)} data-testid="delivery-coherence-csv" sx={{ textTransform: "none", fontWeight: 700 }}>
            {t("coherence.csv")}
          </Button>
          <CoherenceFileButtons source={fileSource} labels={fileLabels} />
        </Box>
      </Box>
      <CoherenceDownloadNotice downloads={coherenceDownloads} />
    </Box>
  );

  // ── The workbenches on a desktop screen (studio/Workspace) ──
  // ① the change being framed (the network, its kind, dates and days, the documents, the deliverables) beside the
  // network as it is, on the map and measured (the Diagnostic, in the inspector);
  // ③ the catalogue or the conversation, the change on the map, the plan of change with its impact and its verdict.
  const k = tokensOf(theme);
  // ── ③ in two panes (a « supporting pane » layout): the changed lines in the
  // middle (ChangeReview), one pane beside them holding the assistant's thread (the guide, by hand) or the plan of
  // change — one at a time, both kept mounted (their scroll, the composer's draft, the plan's counts). The pane is
  // switched by hand, by an operation written (the plan shows it) and by a question the journey asks (the thread).
  const supportTabButton = (key, label, testid, attention = false) => {
    const on = supportTab === key;
    return (
      <ButtonBase
        role="tab"
        id={`change-support-tab-${key}`}
        aria-selected={on ? "true" : "false"}
        aria-controls={`change-support-panel-${key}`}
        onClick={() => setSupportTab(key)}
        data-testid={testid}
        data-attention={attention ? "true" : undefined}
        sx={{ flex: 1, height: 34, px: 1.25, borderRadius: "8px", display: "inline-flex", alignItems: "center", justifyContent: "center", gap: 0.75, fontSize: "0.8rem", fontWeight: on ? 700 : 600, color: on ? "text.primary" : "text.secondary", backgroundColor: on ? alpha(theme.palette.text.primary, theme.palette.mode === "dark" ? 0.12 : 0.06) : "transparent", "&:hover": { backgroundColor: alpha(theme.palette.text.primary, 0.08) } }}
      >
        {label}
        {attention && <Box component="span" aria-hidden sx={{ width: 8, height: 8, borderRadius: "50%", backgroundColor: theme.palette.warning.main }} />}
      </ButtonBase>
    );
  };
  const planPanel = (
    <Box component="section" role="tabpanel" id="change-support-panel-plan" aria-labelledby="change-support-tab-plan" data-testid="change-plan" sx={{ display: supportTab === "plan" ? "flex" : "none", flexDirection: "column", flex: 1, minHeight: 0 }}>
      <Box sx={{ display: "flex", alignItems: "center", gap: 0.25, pl: 1, pr: 1, py: 0.5, borderBottom: `1px solid ${theme.palette.divider}`, ...(scenarios ? {} : { justifyContent: "flex-end" }) }}>
        <Box sx={{ flex: 1, minWidth: 0, display: scenarios ? "block" : "none" }}>
          <ScenarioSwitcher compact ws={ws} disabled={busy} onSwitch={switchTo} onSaveAs={saveAs} onDuplicate={duplicate} onRename={rename} onDelete={remove} onExport={exportActive} onImport={importFile} onCompare={() => setCompareOpen(true)} suggestedName={plan.title || t("transform.scenario.defaultName", { n: (ws?.scenarios.length || 0) + 1 })} appliedIn={frozen ? frozen.n : null} />
        </Box>
        <Tooltip title={t("transform.references.title")}>
          <IconButton size="small" onClick={() => setRefsOpen(true)} aria-label={t("transform.references.title")} data-testid="change-references-open">
            <TrainOutlinedIcon sx={{ fontSize: 18 }} />
          </IconButton>
        </Tooltip>
        <Tooltip title={t("transform.startOver")}>
          <span>
            <IconButton size="small" onClick={() => setResetting(true)} disabled={streaming || Boolean(frozen)} aria-label={t("transform.startOver")} data-testid="change-reset">
              <RestartAltIcon sx={{ fontSize: 18 }} />
            </IconButton>
          </span>
        </Tooltip>
      </Box>
      <Box sx={{ display: "flex", alignItems: "center", gap: 1, px: 2, pt: 1.5, pb: 1 }}>
        <Typography id="change-plan-title" component="h2" sx={{ flex: 1, minWidth: 0, fontSize: "0.94rem", fontWeight: 600, letterSpacing: "-0.01em" }}>
          {t("studio.plan.title")}
          {plan.operations.length ? <Box component="span" sx={{ color: "text.secondary", fontWeight: 500 }}>{` · ${plan.operations.length}`}</Box> : null}
        </Typography>
        <Button size="small" variant="outlined" startIcon={<AddIcon sx={{ fontSize: "16px !important" }} />} onClick={() => setDialog({ initial: null })} disabled={streaming || Boolean(frozen)} data-testid="change-add" sx={{ textTransform: "none", fontWeight: 700, whiteSpace: "nowrap" }}>
          {t("transform.addOperation")}
        </Button>
      </Box>
      <Box sx={{ flex: 1, minHeight: 0, overflowY: "auto", overflowX: "hidden", px: 2, pb: 2 }}>
        {notices}
        {operations}
        {panel && <DraftRetouches testid="panel-retouches" edit={retouchEdit} />}
      </Box>
      {!panel && (
        <Box data-testid="change-plan-foot" sx={{ flexShrink: 0, borderTop: `1px solid ${theme.palette.divider}`, px: 2, py: 1.25, backgroundColor: k.subtle, display: "flex", alignItems: "center", flexWrap: "wrap", gap: 1 }}>
          {changeFooter}
        </Box>
      )}
    </Box>
  );
  const threadPanel = (
    <Box component="section" role="tabpanel" id="change-support-panel-assistant" aria-labelledby="change-support-tab-assistant" data-testid="change-support-thread" data-manual={sidebar ? "true" : "false"} sx={{ display: supportTab === "assistant" ? "flex" : "none", flexDirection: "column", flex: 1, minHeight: 0 }}>
      {sidebar || assistantColumn}
    </Box>
  );
  const asks = pilot.stage === "questions" || pilot.stage === "blocked";
  const supportPane = (
    <Box component="aside" aria-label={t("transform.support.label")} data-testid="change-support" data-tab={supportTab} sx={{ flex: "0 0 400px", width: 400, minWidth: 320, minHeight: 0, borderLeft: `1px solid ${theme.palette.divider}`, backgroundColor: theme.palette.background.paper, display: "flex", flexDirection: "column" }}>
      <Box role="tablist" aria-label={t("transform.support.label")} sx={{ display: "flex", gap: 0.5, p: 0.75, borderBottom: `1px solid ${theme.palette.divider}` }}>
        {supportTabButton("assistant", t(manual ? "transform.support.guide" : "transform.support.assistant"), "change-support-assistant", asks && supportTab !== "assistant")}
        {supportTabButton("plan", `${t("transform.support.plan")}${plan.operations.length ? ` · ${plan.operations.length}` : ""}`, "change-support-plan")}
      </Box>
      {threadPanel}
      {planPanel}
    </Box>
  );
  const atelierBench = <Workspace testid="change-studio" flush={inStudio} center={review} inspector={supportPane} />;

  // ── The panel « Modifications » (layout "panel") ──
  // Its head: the brief (opens ① and ② in a dialog) and the way out; its two tabs, the assistant's thread and the
  // change's list (the operations, then the retouches); its foot: the state of the draft and its one act — « Appliquer
  // en vN » before (the decision, ⑤, in a dialog), « Livrer » after.
  const nextN = frozen ? frozen.n : project ? nextVersionNumber(project) : 1;
  const deliverNow = async () => {
    // Delivering exports the working copy: edit mode is the export's own prerequisite, entered quietly here.
    if (!editing) await enterEditMode({ quiet: true, overrideHold: true });
    window.dispatchEvent(new CustomEvent("gtfs:open-export-preflight"));
  };
  const [moreAnchor, setMoreAnchor] = useState(null);
  // The brief annotated by the verdict: one click away under the objectives.
  const [annotatedOpen, setAnnotatedOpen] = useState(false);
  const [handOpen, setHandOpen] = useState(false);
  const handOps = plan.operations.filter(isHand);
  // The draft's ONE state, said by the bar alone, and the one act it calls for: the objectives to decide (a brief not
  // decided, a sentence of it without an objective), the assistant's question, else « Appliquer en vN ».
  const questionsWaiting = kind === "brief" && pilot.stage === "questions";
  // The brief's sentences no objective answers yet: each is settled at the head of what is asked (bar: « Voir la phrase »).
  const uncoveredCount = kind === "brief" && !frozen ? askingSentences.length : 0;
  const showUncovered = () => {
    showObjectives();
    setTimeout(() => {
      const card = document.getElementById("draft-uncovered");
      card?.scrollIntoView({ behavior: "smooth", block: "start" });
      card?.focus({ preventScroll: true });
    }, 120);
  };
  // The change already built by the assistant: deciding the objectives is no « Construire », it finalises — the
  // objectives kept under the person's name, then the decision's dialog (the simulation measured again, the validator).
  const built = plan.operations.some((o) => !isHand(o));
  const toDecide = kind === "brief" && !frozen && !streaming && (uncoveredCount > 0 || contractLocksAssistant || (briefGiven && !contractIsReady) || status.key === "transform.status.contractRequired" || status.key === "transform.status.uncovered");
  const draftState = finalizing
    ? { tone: "info", busy: true, text: t("draft.state.finalizing") }
    : !kind
    ? { tone: "info", text: t("draft.choose.state") }
    : frozen
    ? { tone: "success", text: t("scenario.state.applied", { n: frozen.n }) }
    : kind === "hand" && !handOps.length
      ? { tone: "info", text: t("draft.state.handNone") }
      : kind === "hand" && (previewing || !preview || status.key === "transform.status.contractRequired")
        ? { tone: "info", busy: previewing, text: t("draft.state.hand", { count: handOps.length }) }
    : streaming
      ? { tone: "info", busy: true, text: t("draft.state.building", { seconds: planSeconds }) }
      : questionsWaiting
        ? { tone: "warning", text: t("draft.state.questions") }
        : toDecide
          ? { tone: "warning", text: uncoveredCount ? t("draft.state.uncovered", { count: uncoveredCount }) : briefGiven ? t("draft.state.decide") : t("draft.state.noBrief") }
          : previewing
            ? { tone: "info", busy: true, text: t("transform.previewing") }
            : status.tone === "success" && preview
              ? { tone: "success", verdict: true }
              : { tone: status.tone === "error" ? "error" : status.tone === "warning" ? "warning" : "info", text: t(status.key, status.params) };
  // The draft's bar (a function: the objectives' act is built further down): the kind (with a brief, the way back
  // from the reader), the one state, the one act, « ⋯ », « Quitter ».
  const kindLabel = kind ? (
    <Box data-testid="draft-kind" data-kind={kind} sx={{ display: "inline-flex", alignItems: "center", gap: 0.75, height: 32, px: 1.25, borderRadius: "8px", flexShrink: 0, fontSize: "0.85rem", fontWeight: 700, color: kindToneOf(theme, kind), backgroundColor: alpha(kindToneOf(theme, kind), theme.palette.mode === "dark" ? 0.18 : 0.1) }}>
      {kind === "hand" ? <EditOutlinedIcon sx={{ fontSize: 18 }} /> : <DescriptionOutlinedIcon sx={{ fontSize: 18 }} />}
      {t(`draft.kind.${kind}.short`)}
    </Box>
  ) : null;
  const renderDraftBar = () => (
    <Box component="nav" aria-label={t("panel.title")} data-testid="draft-bar" data-view={shownView} data-kind={kind || ""} sx={{ display: "flex", alignItems: "center", gap: 1.5, px: 2, py: 1, minHeight: 52, borderBottom: `1px solid ${theme.palette.divider}`, backgroundColor: theme.palette.background.paper }}>
      {kind === "brief" && shownView === "network" ? (
        <Button size="small" startIcon={<ArrowBackRoundedIcon />} onClick={() => onView?.("change")} data-testid="draft-back-to-change" sx={{ textTransform: "none", fontWeight: 700, borderRadius: "10px", flexShrink: 0 }}>
          {t("draft.backToChange")}
        </Button>
      ) : (
        kindLabel
      )}
      <Box sx={{ flex: 1, minWidth: 0, display: "flex" }}>
      <Typography component="div" role="status" data-testid="change-status" data-tone={draftState.tone} data-status={status.key.replace("transform.", "")} sx={{ minWidth: 0, maxWidth: "100%", fontSize: "0.82rem", fontWeight: 650, color: draftState.verdict ? "text.primary" : `${draftState.tone}.dark`, display: "inline-flex", alignItems: "center", gap: 0.75, overflow: "hidden", whiteSpace: "nowrap", textOverflow: "ellipsis", ...(draftState.verdict ? {} : { px: 1.25, py: 0.5, borderRadius: 99, backgroundColor: alpha(theme.palette[draftState.tone]?.main || theme.palette.info.main, theme.palette.mode === "dark" ? 0.18 : 0.1), border: `1px solid ${alpha(theme.palette[draftState.tone]?.main || theme.palette.info.main, 0.28)}` }) }}>
        {!draftState.verdict && !draftState.busy && <Box component="span" aria-hidden sx={{ width: 7, height: 7, borderRadius: "50%", flexShrink: 0, backgroundColor: theme.palette[draftState.tone]?.main || theme.palette.info.main }} />}
        {draftState.busy && <CircularProgress size={14} sx={{ flexShrink: 0 }} />}
        {draftState.verdict ? (
          <VerdictCard payload={{ verdict: preview.verdict ?? null, gate: preview.gate, validation: preview.validation }} variant="compact" measured counts={pageCounts} />
        ) : (
          <Box component="span" sx={{ overflow: "hidden", textOverflow: "ellipsis" }}>{draftState.text}</Box>
        )}
        {streaming && (
          <Button size="small" onClick={stopPlanner} data-testid="draft-stop" sx={{ textTransform: "none", fontWeight: 650, flexShrink: 0, minWidth: 0 }}>
            {t("autopilot.stop")}
          </Button>
        )}
      </Typography>
      </Box>
      {!kind ? null : frozen ? (
        <>
          <Button size="small" variant="outlined" onClick={() => setPanelDialog("apply")} data-testid="panel-applied" sx={{ textTransform: "none", fontWeight: 650, borderRadius: "10px", whiteSpace: "nowrap", flexShrink: 0 }}>
            {t("panel.applied", { n: frozen.n })}
          </Button>
          <Button size="small" variant="contained" disableElevation onClick={deliverNow} data-testid="panel-deliver" sx={{ textTransform: "none", fontWeight: 700, borderRadius: "10px", whiteSpace: "nowrap", flexShrink: 0, px: 2 }}>
            {t("delivery.deliver")}
          </Button>
        </>
      ) : questionsWaiting ? (
        <Button size="small" variant="contained" disableElevation onClick={() => { onView?.("change"); setThreadOpen(true); }} data-testid="panel-answer" sx={{ textTransform: "none", fontWeight: 700, borderRadius: "10px", whiteSpace: "nowrap", flexShrink: 0, px: 2 }}>
          {t("draft.act.answer")}
        </Button>
      ) : toDecide && uncoveredCount > 0 ? (
        <Button size="small" variant="contained" disableElevation onClick={showUncovered} data-testid="panel-uncovered" sx={{ textTransform: "none", fontWeight: 700, borderRadius: "10px", whiteSpace: "nowrap", flexShrink: 0, px: 2 }}>
          {t(uncoveredCount === 1 ? "draft.act.seeSentence" : "draft.act.seeSentences")}
        </Button>
      ) : toDecide && built ? (
        <Tooltip title={objectivesPrimary.disabled ? objectivesPrimary.reason || "" : t("draft.act.finalize.hint")}>
          <span>
            <Button size="small" variant="contained" disableElevation disabled={objectivesPrimary.disabled || finalizing} onClick={() => { setFinalizing(true); objectivesRef.current?.proceed(); }} data-testid="panel-finalize" sx={{ textTransform: "none", fontWeight: 700, borderRadius: "10px", whiteSpace: "nowrap", flexShrink: 0, px: 2 }}>
              {t("draft.act.finalize")}
            </Button>
          </span>
        </Tooltip>
      ) : toDecide ? (
        <Tooltip title={objectivesPrimary.disabled ? objectivesPrimary.reason || "" : ""}>
          <span>
            <Button size="small" variant="contained" disableElevation disabled={objectivesPrimary.disabled} onClick={() => { showObjectives(); objectivesRef.current?.proceed(); }} data-testid="panel-decide" sx={{ textTransform: "none", fontWeight: 700, borderRadius: "10px", whiteSpace: "nowrap", flexShrink: 0, px: 2 }}>
              {/* The objectives' own act, in its words: « Construire le changement », « Tout retenir… », « Continuer sans objectif ». */}
              {objectivesPrimary.label}
            </Button>
          </span>
        </Tooltip>
      ) : (
        <Button size="small" variant="contained" disableElevation onClick={simulateAndCheck} disabled={!plan.operations.length || stuck || previewing || streaming || nothingToApply} data-testid="panel-apply" sx={{ textTransform: "none", fontWeight: 700, borderRadius: "10px", whiteSpace: "nowrap", flexShrink: 0, px: 2 }}>
          {t("panel.apply", { n: nextN })}
        </Button>
      )}
      {kind && (
        <Tooltip title={t("draft.more")}>
          <IconButton size="small" onClick={(e) => setMoreAnchor(e.currentTarget)} aria-label={t("draft.more")} aria-haspopup="menu" data-testid="draft-more" sx={{ flexShrink: 0 }}>
            <MoreHorizRoundedIcon />
          </IconButton>
        </Tooltip>
      )}
      {onLeave && (
        <Tooltip title={t("panel.leave.hint")}>
          <Button size="small" onClick={onLeave} data-testid="panel-leave" sx={{ textTransform: "none", fontWeight: 650, color: "text.secondary", minWidth: 0, flexShrink: 0 }}>
            {t("panel.leave")}
          </Button>
        </Tooltip>
      )}
    </Box>
  );
  const abandonDialog = (
    <>
      <Menu anchorEl={moreAnchor} open={Boolean(moreAnchor)} onClose={() => setMoreAnchor(null)} anchorOrigin={{ vertical: "bottom", horizontal: "right" }} transformOrigin={{ vertical: "top", horizontal: "right" }}>
        <MenuItem onClick={() => { setMoreAnchor(null); setVersionsOpen(true); }} data-testid="draft-versions" sx={{ fontSize: "0.88rem" }}>
          {t("decision.versions")}
        </MenuItem>
        <MenuItem onClick={() => { setMoreAnchor(null); setAbandoning(true); }} disabled={streaming || Boolean(frozen)} data-testid="draft-abandon" sx={{ color: "error.main", fontSize: "0.88rem" }}>
          {t("draft.abandon")}
        </MenuItem>
      </Menu>
      <Dialog open={versionsOpen} onClose={() => setVersionsOpen(false)} fullWidth maxWidth="sm" data-testid="draft-versions-dialog" PaperProps={{ sx: { borderRadius: "16px" } }}>
        <Box sx={{ display: "flex", alignItems: "center", gap: 1, px: 2.5, py: 1.5, borderBottom: `1px solid ${theme.palette.divider}` }}>
          <Typography component="h2" sx={{ flex: 1, fontSize: "1rem", fontWeight: 700 }}>{t("decision.versions")}</Typography>
          <Button onClick={() => setVersionsOpen(false)} data-testid="draft-versions-close" sx={{ textTransform: "none", fontWeight: 650 }}>
            {t("app.close")}
          </Button>
        </Box>
        <Box sx={{ px: 2.5, py: 2 }}>
          <VersionList versions={project?.versions || []} />
        </Box>
      </Dialog>
      <Dialog open={abandoning} onClose={() => setAbandoning(false)} maxWidth="xs" fullWidth data-testid="draft-abandon-dialog" PaperProps={{ sx: { borderRadius: "14px", p: 2.5, display: "flex", flexDirection: "column", gap: 2 } }}>
        <Typography sx={{ fontSize: "0.92rem", lineHeight: 1.5 }}>{t("draft.abandon.confirm")}</Typography>
        <Box sx={{ display: "flex", justifyContent: "flex-end", gap: 1 }}>
          <Button onClick={() => setAbandoning(false)} data-testid="draft-abandon-no" sx={{ textTransform: "none", fontWeight: 650 }}>
            {t("app.cancel")}
          </Button>
          <Button variant="contained" color="error" disableElevation onClick={abandon} data-testid="draft-abandon-yes" sx={{ textTransform: "none", fontWeight: 700, borderRadius: "10px" }}>
            {t("draft.abandon")}
          </Button>
        </Box>
      </Dialog>
    </>
  );
  // By hand, the screen is the reader: no bar over it. The draft is one button in the header (its kind in its colour,
  // its count of retouches) that opens its panel beside the reader: the state, the retouches (each removable), the act
  // (« Appliquer en vN », then « Livrer »), « Abandonner le brouillon », « Quitter ».
  const handTone = kindToneOf(theme, "hand");
  const renderHand = () => (
    <>
      <Tooltip title={t("draft.hand.open")}>
        <ButtonBase onClick={() => setHandOpen(true)} aria-haspopup="dialog" aria-expanded={handOpen ? "true" : "false"} data-testid="draft-hand-button" data-kind="hand" sx={{ height: 36, px: 1.5, gap: 0.75, borderRadius: "10px", fontSize: "0.86rem", fontWeight: 700, color: handTone, backgroundColor: alpha(handTone, theme.palette.mode === "dark" ? 0.18 : 0.1), border: `1px solid ${alpha(handTone, 0.35)}`, whiteSpace: "nowrap", "&:hover": { backgroundColor: alpha(handTone, 0.18) } }}>
          <EditOutlinedIcon sx={{ fontSize: 18 }} />
          {frozen ? t("panel.applied", { n: frozen.n }) : t("draft.kind.hand.short")}
          {!frozen && handOps.length > 0 && (
            <Box component="span" data-testid="draft-hand-count" sx={{ minWidth: 20, height: 20, px: 0.5, borderRadius: 99, display: "inline-flex", alignItems: "center", justifyContent: "center", fontSize: "0.72rem", color: theme.palette.getContrastText(handTone), backgroundColor: handTone }}>
              {handOps.length}
            </Box>
          )}
        </ButtonBase>
      </Tooltip>
      <Drawer anchor="right" open={handOpen} onClose={() => setHandOpen(false)} PaperProps={{ sx: { width: 440, maxWidth: "100vw", display: "flex", flexDirection: "column" } }} data-testid="draft-hand-panel">
        <Box sx={{ display: "flex", alignItems: "center", gap: 1, px: 2.25, py: 1.5, borderBottom: `1px solid ${theme.palette.divider}` }}>
          <Box aria-hidden sx={{ width: 32, height: 32, borderRadius: "9px", display: "flex", alignItems: "center", justifyContent: "center", color: handTone, backgroundColor: alpha(handTone, 0.12) }}>
            <EditOutlinedIcon sx={{ fontSize: 18 }} />
          </Box>
          <Typography component="h2" sx={{ flex: 1, fontSize: "1rem", fontWeight: 700 }}>
            {t("draft.hand.panel")}
          </Typography>
          <Button size="small" onClick={() => setHandOpen(false)} data-testid="draft-hand-close" sx={{ textTransform: "none", fontWeight: 650 }}>
            {t("panel.dialog.back")}
          </Button>
        </Box>
        <Box sx={{ px: 2.25, py: 1.5, borderBottom: `1px solid ${theme.palette.divider}` }}>
          <Typography component="div" role="status" data-testid="change-status" data-tone={draftState.tone} sx={{ fontSize: "0.84rem", fontWeight: 650, color: `${draftState.tone}.main`, display: "flex", alignItems: "center", gap: 0.75 }}>
            {draftState.busy && <CircularProgress size={14} />}
            {draftState.verdict ? <VerdictCard payload={{ verdict: preview.verdict ?? null, gate: preview.gate, validation: preview.validation }} variant="compact" measured counts={pageCounts} /> : draftState.text}
          </Typography>
        </Box>
        <Box sx={{ flex: 1, minHeight: 0, overflowY: "auto", px: 2.25, py: 1.5, display: "flex", flexDirection: "column", gap: 1 }}>
          <Typography component="h3" sx={{ fontSize: "0.88rem", fontWeight: 700 }}>
            {t("draft.hand.title")}
            {handOps.length ? <Box component="span" sx={{ color: "text.secondary", fontWeight: 500 }}>{` · ${handOps.length}`}</Box> : null}
          </Typography>
          {!handOps.length && <Typography sx={{ fontSize: "0.82rem", color: "text.secondary", lineHeight: 1.5 }}>{t("draft.hand.empty")}</Typography>}
          {handOps.map((op) => (
            <OperationCard key={op.id} op={op} step={frozen ? null : stepOf(op.id)} def={catalogue.find((c) => c.type === op.type)} index={plan.operations.indexOf(op)} count={plan.operations.length} busy={busy || Boolean(frozen)} shared={shared} onAnswer={answer} onRemove={removeOp} onMove={moveOp} onEdit={() => {}} appliedIn={frozen ? frozen.n : null} {...lineOfOperation(op)} />
          ))}
        </Box>
        <Box sx={{ flexShrink: 0, borderTop: `1px solid ${theme.palette.divider}`, px: 2.25, py: 1.5, display: "flex", flexDirection: "column", gap: 1, backgroundColor: k.subtle }}>
          {frozen ? (
            <Box sx={{ display: "flex", gap: 1 }}>
              <Button variant="contained" disableElevation fullWidth onClick={() => { setHandOpen(false); deliverNow(); }} data-testid="panel-deliver" sx={{ textTransform: "none", fontWeight: 700, borderRadius: "10px" }}>
                {t("delivery.deliver")}
              </Button>
              <Button variant="outlined" onClick={() => { setHandOpen(false); setPanelDialog("apply"); }} data-testid="panel-applied" sx={{ textTransform: "none", fontWeight: 650, borderRadius: "10px", whiteSpace: "nowrap" }}>
                {t("panel.applied", { n: frozen.n })}
              </Button>
            </Box>
          ) : (
            <Button variant="contained" disableElevation fullWidth onClick={() => { setHandOpen(false); simulateAndCheck(); }} disabled={!plan.operations.length || stuck || previewing || streaming || nothingToApply} data-testid="panel-apply" sx={{ textTransform: "none", fontWeight: 700, borderRadius: "10px" }}>
              {t("panel.apply", { n: nextN })}
            </Button>
          )}
          <Box sx={{ display: "flex", justifyContent: "space-between" }}>
            {!frozen ? (
              <Button size="small" color="error" onClick={() => { setHandOpen(false); setAbandoning(true); }} data-testid="draft-abandon" sx={{ textTransform: "none", fontWeight: 650 }}>
                {t("draft.abandon")}
              </Button>
            ) : <span />}
            <Box sx={{ display: "flex", gap: 0.5 }}>
              <Button size="small" onClick={() => { setHandOpen(false); setVersionsOpen(true); }} data-testid="draft-hand-versions" sx={{ textTransform: "none", fontWeight: 650, color: "text.secondary" }}>
                {t("decision.versions")}
              </Button>
              {onLeave && (
                <Button size="small" onClick={onLeave} data-testid="panel-leave" sx={{ textTransform: "none", fontWeight: 650, color: "text.secondary" }}>
                  {t("panel.leave")}
                </Button>
              )}
            </Box>
          </Box>
        </Box>
      </Drawer>
    </>
  );
  const panelDialogPaper = { sx: { maxHeight: "92vh", borderRadius: "18px", overflow: "hidden", display: "flex", flexDirection: "column" } };
  const panelDialogBody = (node) => (
    <StepFrameInDialog.Provider value>
      <Box sx={{ flex: 1, minHeight: 0, display: "flex", flexDirection: "column", overflowY: "auto", px: 2.5, pb: 1 }}>
        {node}
      </Box>
    </StepFrameInDialog.Provider>
  );
  const panelDialogHead = (title, testid) => (
    <Box sx={{ display: "flex", alignItems: "center", gap: 1, px: 2.5, py: 1.25, borderBottom: `1px solid ${theme.palette.divider}` }}>
      <Typography component="h2" sx={{ flex: 1, fontSize: "1rem", fontWeight: 700 }}>{title}</Typography>
      <Button onClick={() => setPanelDialog(null)} data-testid={`${testid}-close`} sx={{ textTransform: "none", fontWeight: 650 }}>
        {t("panel.dialog.back")}
      </Button>
    </Box>
  );
  // « Changement »'s left column, what is asked, in the order the person works: the brief dropped, the objectives the
  // assistant understood from it (each with its verdict, the brief annotated one click away), the operations for the
  // specialist (« Expert ») — and the assistant docked at its foot (its composer always, its thread unfolded over the
  // column by the person, a turn running or a question waiting). Validating is the bar's one act. Nothing else: the
  // suggestions measured on the network and its figures are not a brief's question.
  // The journey's card in the dock: a question, or a hold the bar cannot settle by itself (never the objectives', said once
  // by the bar and at the head of what is asked).
  const pilotDocked = !frozen && (pilot.stage === "questions" || (pilot.stage === "blocked" && !toDecide)) ? autopilotPanel : null;
  const sectionTitle = (text, count, testid) => (
    <Typography component="h3" data-testid={testid} sx={{ fontSize: "0.92rem", fontWeight: 700, letterSpacing: "-0.01em" }}>
      {text}
      {count ? <Box component="span" sx={{ color: "text.secondary", fontWeight: 500 }}>{` · ${count}`}</Box> : null}
    </Typography>
  );
  // The column's two tabs: what is asked (its objectives' count, a dot where a sentence waits) and the assistant (its
  // messages, a dot where it asks); the composer stays at the column's foot on both.
  const objectivesBadge = pageCounts?.objectives?.total ? `${pageCounts.objectives.pass}/${pageCounts.objectives.total}` : null;
  const objectivesAttention = (uncoveredCount > 0 || toDecide) && threadOpen;
  const assistantAttention = (pilot.stage === "questions" || streaming) && !threadOpen;
  const askTab = (key, icon, label, badge, testid, attention, tone) => {
    const on = (key === "assistant") === threadOpen;
    const color = tone || theme.palette.primary.main;
    return (
      <ButtonBase
        role="tab"
        aria-selected={on ? "true" : "false"}
        aria-expanded={key === "assistant" ? (threadOpen ? "true" : "false") : undefined}
        onClick={() => setThreadOpen(key === "assistant")}
        data-testid={testid}
        data-on={on ? "true" : "false"}
        sx={{ flex: 1, height: 36, borderRadius: "9px", display: "inline-flex", alignItems: "center", justifyContent: "center", gap: 0.75, fontSize: "0.84rem", fontWeight: on ? 750 : 600, color: on ? color : "text.secondary", backgroundColor: on ? theme.palette.background.paper : "transparent", boxShadow: on ? `0 1px 3px ${alpha(theme.palette.common.black, 0.12)}` : "none", transition: "background-color .15s, color .15s", "&:hover": on ? {} : { color: "text.primary" } }}
      >
        {icon}
        {label}
        {badge && <Box component="span" sx={{ px: 0.75, minWidth: 20, height: 20, borderRadius: 99, display: "inline-flex", alignItems: "center", justifyContent: "center", fontSize: "0.7rem", fontWeight: 800, color: on ? theme.palette.getContrastText(color) : "text.secondary", backgroundColor: on ? color : alpha(theme.palette.text.primary, 0.08) }}>{badge}</Box>}
        {attention && <Box component="span" aria-hidden data-testid={`${testid}-attention`} sx={{ width: 8, height: 8, borderRadius: "50%", backgroundColor: theme.palette.warning.main }} />}
      </ButtonBase>
    );
  };
  const renderAsk = () => (
    <Box component="section" aria-label={t("draft.ask.title")} data-testid="draft-ask" data-thread={threadOpen ? "open" : "folded"} sx={{ width: "clamp(420px, 38%, 640px)", flexShrink: 0, minHeight: 0, display: "flex", flexDirection: "column", borderRight: `1px solid ${theme.palette.divider}`, backgroundColor: k.subtle }}>
      <Box role="tablist" aria-label={t("draft.ask.title")} sx={{ flexShrink: 0, display: "flex", gap: 0.5, p: 0.5, mx: 2, mt: 1.5, mb: 0.5, borderRadius: "12px", backgroundColor: alpha(theme.palette.text.primary, theme.palette.mode === "dark" ? 0.08 : 0.05) }}>
        {askTab("objectives", <TrackChangesRoundedIcon sx={{ fontSize: 18 }} />, t("draft.tab.objectives"), objectivesBadge, "draft-tab-objectives", objectivesAttention, null)}
        {askTab("assistant", <AutoAwesomeOutlinedIcon sx={{ fontSize: 18 }} />, t(manual ? "transform.support.guide" : "transform.support.assistant"), turns.length ? String(turns.length) : null, "draft-thread-toggle", assistantAttention, theme.palette.ai?.main || theme.palette.secondary.main)}
      </Box>
      <Box data-testid="draft-ask-body" role="tabpanel" sx={{ flex: 1, minHeight: 0, overflowY: "auto", px: 2, py: 1.5, display: threadOpen ? "none" : "flex", flexDirection: "column", gap: 2, "& > *": { flexShrink: 0 } }}>
        {project && <ProjectDocuments project={project} job="modify" heading={t("draft.ask.brief")} hint={t("draft.ask.briefHint")} retentionDays={retentionDaysOf(features?.workspace || null, signedIn)} sentToAssistant={Boolean(features?.chat?.enabled)} flow={{ pending: documents, onAttach: attach, onRemove: removeDocument, disabled: documents.length >= MAX_DOCUMENTS, notes: documentNotes }} />}
        {/* The objectives once there is something to understand: a brief, or objectives already written — their progress first. */}
        <Box id="draft-objectives" sx={{ scrollMarginTop: 16, display: networkOpen && (briefGiven || (contract.clauses || []).some((c) => !isGuarantee(c))) ? "flex" : "none", flexDirection: "column", gap: 1.25 }}>
          {pageCounts?.objectives?.total > 0 && (
            <Box data-testid="draft-objectives-progress" sx={{ display: "flex", flexDirection: "column", gap: 0.75, px: 0.5 }}>
              <Box sx={{ display: "flex", alignItems: "baseline", gap: 1 }}>
                <Typography component="h3" sx={{ flex: 1, fontSize: "0.7rem", fontWeight: 800, letterSpacing: "0.08em", textTransform: "uppercase", color: "text.secondary" }}>
                  {t("draft.tab.objectives")}
                </Typography>
                <Typography sx={{ fontSize: "0.8rem", fontWeight: 750, color: pageCounts.objectives.pass === pageCounts.objectives.total ? "success.main" : "warning.dark", fontVariantNumeric: "tabular-nums" }}>
                  {t("draft.objectives.met", { pass: pageCounts.objectives.pass, total: pageCounts.objectives.total })}
                </Typography>
              </Box>
              <LinearProgress variant="determinate" aria-label={t("draft.objectives.met", { pass: pageCounts.objectives.pass, total: pageCounts.objectives.total })} value={(100 * pageCounts.objectives.pass) / pageCounts.objectives.total} color={pageCounts.objectives.pass === pageCounts.objectives.total ? "success" : "warning"} sx={{ height: 6, borderRadius: 99, backgroundColor: alpha(theme.palette.text.primary, 0.08) }} />
            </Box>
          )}
          {networkOpen && objectivesPage({ controlRef: objectivesRef, simple: true })}
          {networkOpen && briefGiven && (
            <>
              <Button size="small" onClick={() => setAnnotatedOpen((v) => !v)} aria-expanded={annotatedOpen ? "true" : "false"} endIcon={<ExpandMoreIcon sx={{ transform: annotatedOpen ? "rotate(180deg)" : "none", transition: "transform .2s" }} />} data-testid="draft-annotated-toggle" sx={{ alignSelf: "flex-start", textTransform: "none", fontWeight: 650 }}>
                {t("draft.ask.annotated")}
              </Button>
              {annotatedOpen && annotatedBrief}
            </>
          )}
        </Box>
        {handOps.length > 0 && (
          <Box data-testid="draft-hand" sx={{ display: "flex", flexDirection: "column", gap: 1 }}>
            {sectionTitle(t("draft.hand.title"), handOps.length, "draft-hand-title")}
            {handOps.map((op) => (
              <OperationCard key={op.id} op={op} step={frozen ? null : stepOf(op.id)} def={catalogue.find((c) => c.type === op.type)} index={plan.operations.indexOf(op)} count={plan.operations.length} busy={busy || Boolean(frozen)} shared={shared} onAnswer={answer} onRemove={removeOp} onMove={moveOp} onEdit={() => {}} appliedIn={frozen ? frozen.n : null} {...lineOfOperation(op)} />
            ))}
          </Box>
        )}
        {expert && (
          <Box data-testid="draft-operations" sx={{ display: "flex", flexDirection: "column", gap: 1 }}>
            <Box sx={{ display: "flex", alignItems: "center", gap: 1 }}>
              <Box sx={{ flex: 1, minWidth: 0 }}>{sectionTitle(t("studio.plan.title"), plan.operations.length, "draft-operations-title")}</Box>
              <Button size="small" variant="outlined" startIcon={<AddIcon sx={{ fontSize: "16px !important" }} />} onClick={() => setDialog({ initial: null })} disabled={streaming || Boolean(frozen)} data-testid="change-add" sx={{ textTransform: "none", fontWeight: 700, whiteSpace: "nowrap" }}>
                {t("transform.addOperation")}
              </Button>
            </Box>
            {notices}
            {operations}
          </Box>
        )}
      </Box>
      <Box data-testid="draft-assistant" role="tabpanel" sx={{ flex: threadOpen ? 1 : "0 0 auto", minHeight: 0, display: "flex", flexDirection: "column", borderTop: threadOpen ? "none" : `1px solid ${theme.palette.divider}`, backgroundColor: threadOpen ? theme.palette.background.paper : k.subtle }}>
        {pilotDocked && (
          <Box data-testid="change-thread-status" sx={{ flexShrink: 0, maxHeight: threadOpen ? "45%" : 320, overflowY: "auto", px: 1.5, pb: 1 }}>
            {pilotDocked}
          </Box>
        )}
        {manual ? (
          <Box sx={{ px: 2.25, pb: 1.5 }}>
            <Button size="small" variant="outlined" startIcon={<AddIcon sx={{ fontSize: "16px !important" }} />} onClick={() => setDialog({ initial: null })} disabled={Boolean(frozen)} data-testid="draft-add-manual" sx={{ textTransform: "none", fontWeight: 700 }}>
              {t("transform.addOperation")}
            </Button>
          </Box>
        ) : (
          conversationWith(null, { hidden: !threadOpen })
        )}
      </Box>
    </Box>
  );
  // A function: its parts and its dialog host pages built further down (objectivesPage, annotatedBrief, renderDelivery).
  const wayCard = (k, Icon) => (
    <ButtonBase key={k} onClick={() => startDraft(k)} data-testid={`draft-choose-${k}`} sx={{ flex: "1 1 280px", maxWidth: 360, p: 2.5, borderRadius: "16px", border: `1px solid ${alpha(kindToneOf(theme, k), 0.35)}`, borderTop: `4px solid ${kindToneOf(theme, k)}`, backgroundColor: theme.palette.background.paper, display: "flex", flexDirection: "column", alignItems: "flex-start", gap: 1, textAlign: "left", transition: "border-color .15s, box-shadow .15s, background-color .15s", "&:hover": { borderColor: kindToneOf(theme, k), backgroundColor: alpha(kindToneOf(theme, k), 0.04), boxShadow: `0 8px 24px ${alpha(theme.palette.common.black, 0.08)}` } }}>
      <Box aria-hidden sx={{ width: 44, height: 44, borderRadius: "12px", display: "flex", alignItems: "center", justifyContent: "center", color: kindToneOf(theme, k), backgroundColor: alpha(kindToneOf(theme, k), 0.12) }}>
        <Icon />
      </Box>
      <Typography sx={{ fontSize: "1rem", fontWeight: 700 }}>{t(`draft.kind.${k}`)}</Typography>
      <Typography sx={{ fontSize: "0.84rem", color: "text.secondary", lineHeight: 1.5 }}>{t(`draft.kind.${k}.hint`)}</Typography>
    </ButtonBase>
  );
  const renderPanel = () => (
    <>
      {kind === "hand" ? (headerHost ? createPortal(renderHand(), headerHost) : renderHand()) : barHost ? createPortal(renderDraftBar(), barHost) : renderDraftBar()}
      {abandonDialog}
      <Box data-testid="change-panel" data-view={shownView} data-kind={kind || ""} sx={{ flex: 1, minWidth: 0, minHeight: 0, height: "100%", display: "flex" }}>
        {!kind ? (
          <Box data-testid="draft-choose" sx={{ flex: 1, display: "flex", flexDirection: "column", alignItems: "center", justifyContent: "center", gap: 3, p: 3 }}>
            <Typography component="h2" sx={{ fontSize: "1.35rem", fontWeight: 800, letterSpacing: "-0.02em", textAlign: "center" }}>
              {t("draft.choose.title")}
            </Typography>
            <Box sx={{ display: "flex", gap: 2, flexWrap: "wrap", justifyContent: "center", width: "100%" }}>
              {wayCard("hand", EditOutlinedIcon)}
              {wayCard("brief", DescriptionOutlinedIcon)}
            </Box>
          </Box>
        ) : kind === "brief" ? (
          <>
            {renderAsk()}
            <Box data-testid="draft-result" sx={{ position: "relative", flex: 1, minWidth: 0, minHeight: 0, display: "flex", flexDirection: "column", overflow: "hidden" }}>
              {review}
            </Box>
          </>
        ) : null}
      </Box>
      <Dialog open={panelDialog === "apply"} onClose={() => setPanelDialog(null)} fullWidth maxWidth="md" PaperProps={panelDialogPaper} data-testid="panel-apply-dialog">
        {panelDialogHead(frozen ? t("decision.applied.head", { n: frozen.n }) : t("panel.dialog.apply", { n: nextN }), "panel-apply-dialog")}
        {panelDialogBody(panelDialog === "apply" ? renderDelivery() : null)}
      </Dialog>
    </>
  );

  // ② Objectifs — one element for the two places it shows: its own page (/p/:id/2, the links that name it) and,
  // embedded, ①'s brief column (① and ② as one « Cahier des charges » screen), where ①'s primary action runs its act
  // through `objectivesRef`.
  // ②'s one act as the bar offers it — and ①'s, where the objectives' body is embedded.
  const objectivesPrimary = {
    // Nothing proposed, nothing kept, no brief: the way on says what it is (« Continuer sans objectif »).
    label: t(pendingObjectives + openSentences.length + longSheets.length > 0 ? "step.primary.2.modify.all" : (contract.clauses || []).every((c) => c?.params?.derive) && !readyDocumentIds.length && !String(contractBrief || "").trim() ? "step.primary.2.modify.none" : "step.primary.2.modify"),
    // …nor the reading the assistant is about to start by itself, nor two readings of a sheet's cells that disagree.
    // …nor a statement of the brief about today's network that the feed contradicts, until the person answers it
    // (utils/contract undecidedPremises: the server refuses PREMISE_UNDECIDED anyway).
    disabled: !frozen && (uploadingDocuments || streaming || readingDue || readingSheets.length > 0 || unreadDocuments > 0 || coverageDue || disputes.length > 0 || premisesOpen.length > 0 || readingsOpen.length > 0),
    reason: uploadingDocuments ? t("objectives.reason.uploading") : streaming || readingDue ? t("objectives.reason.reading") : readingSheets.length ? t("objectives.reason.readingSheets") : unreadDocuments ? t("objectives.reason.unread", { count: unreadDocuments }) : coverageDue ? t("objectives.reason.measuring") : disputes.length ? t("objectives.reason.disputes", { count: disputes.length }) : premisesOpen.length ? t("step.reason.premiseUndecided") : readingsOpen.length ? t("step.reason.readingUndecided") : null,
  };
  const objectivesPage = (embedded) => (
    <StepObjectives
      embedded={embedded}
        projectId={project?.id || null}
        cacheKey={`${project?.id || "none"}:${fp || "network"}`}
        contract={contract}
        conformance={preview?.conformance?.after || null}
        coverage={coverageShown}
        coverageState={contractState.coverageState}
        onChange={streaming || frozen ? null : (next) => contractState.setContract(next)}
        // « Lire le cahier des charges » reads what the reading by itself reads: the whole brief, spreadsheets included;
        // the documents a reading could not carry are said there, read on their own by one act (or by itself).
        extract={aiEnabled && !frozen ? { running: streaming, error: extractError, onExtract: (text) => readBrief(String(text || "").trim() || t("contract.extract.default"), readingDocumentIds), leftOut, onReadLeftOut: leftOutReadable.length ? readLeftOut : null } : null}
        assistantLock={assistantLock}
        onPropose={aiEnabled && !frozen && proposable(openSentences).length ? proposeObjectives : null}
        proseDocuments={readingDocumentIds.length > 0}
        brief={contractBrief}
        onBrief={contractState.setBrief}
        // The detailed import's reading of one sheet joins the brief's other sheets (never replaces them).
        onOffer={frozen ? null : (o) => contractState.setOffer((prev) => withSheetOffer(prev, o?.name || "", { at: o?.at, aggregates: o?.aggregates, operations: o?.operations, skipped: (prev?.skipped || []).filter((s) => s?.document === (o?.name || "")) }))}
        name={contractState.name}
        onName={contractState.setName}
        readOnly={Boolean(frozen)}
        dataIds={demandDataIds}
        context={project?.context || {}}
        onContext={onUpdateProject && !frozen ? (context) => onUpdateProject({ context }) : null}
        hasBrief={readyDocumentIds.length > 0 || Boolean(String(contractBrief || "").trim()) || Boolean(contract.extracted) || (contract.clauses || []).some((c) => c?.source?.kind !== "recommendation" && !c?.keep_by_default)}
        // ②'s one act: the way on keeps, under the person's name (asked then, once), every objective
        // proposed and not decided, and records « à vérifier à la main » every sentence of the brief no objective
        // answers — nothing is left to sort by hand before the change is built. Only a reading still running holds it,
        // and a document nobody could read (acknowledged in the detailed view: never swallowed).
        primary={objectivesPrimary}
        assumed={contractClausesCount && !frozen ? { disabled: !nameOk(contractState.name) || disputes.length > 0, onClick: () => { contractState.proceed("assumed"); onStep(3); } } : null}
        sheets={(project?.documents || []).filter((d) => SHEET_RE.test(d.name || "")).map((d) => ({ name: d.name, read: Boolean(project?.context?.sheets?.[d.name] || project?.sheets?.[d.name] || (contract.clauses || []).some((c) => c?.origin?.kind === "sheet" && c.origin.document === d.name)) }))}
        readingSheets={readingSheets}
        onReadSheet={frozen ? null : readSheet}
        onProceed={(retained, who) => {
          // `retained` null: the suggestions were not measured yet (or their measure failed) — the ones kept with the
          // project before stay as they are, never wiped by an act made while they load.
          if (!frozen) {
            // The change's « mise en service »: the date typed at ②, else the one the brief states (statedFromDate) —
            // said on the decision card before the act, kept by it — on the operations (framingDefaults) and on the
            // objectives a spreadsheet gave without a date of their own (else a CSV of Sunday trips under titles naming no
            // date would be built and measured from the feed's first Sunday).
            const typed = project?.context?.from_date || null;
            const stated = typed ? null : statedFromDate(contract);
            if (stated) onUpdateProject?.((p) => ({ ...p, context: { ...(p.context || {}), from_date: stated } }));
            const longDate = (d) => new Date(`${d}T12:00:00`).toLocaleDateString(language || undefined, { day: "numeric", month: "long", year: "numeric" });
            const withDateWords = (text, d) => t("objectives.dates.suffix", { text: String(text).replace(/[.\s]+$/, ""), date: longDate(d) });
            // Everything proposed is kept, what no objective answers is kept « à vérifier à la main », then the contract
            // is decided — in one write. Nothing asked of the change: recorded empty under the person's name.
            contractState.proceed((c) => ((c.clauses || []).length ? "decided" : "empty"), who, { prepare: (c) => acceptAll(withEffectiveDate(c, typed || stated, withDateWords), { name: who, sentences: openSentences, documents: longSheets, documentReason: t("objectives.longSheet.reason"), setAsideReason: (s) => setAsideReasonOf(s, t) }) });
            // What ③ needs of them, kept with the project (a reload, another browser): never re-measured silently.
            if (Array.isArray(retained)) onUpdateProject?.((p) => ({ ...p, context: { ...(p.context || {}), objectives: retained.map((r) => ({ id: r.id, kind: r.kind, line: r.line || null, zone: r.zone || null, facts: r.facts || {}, clauses: (r.clauses || []).map((c) => ({ kind: c.kind, params: c.params || {} })), ...(Array.isArray(r.operations) ? { operations: r.operations } : {}) })) } }));
          }
          onStep(3);
        }}
        back={back}
    />
  );
  // ── The brief annotated, and the review at the keyboard ──
  // The prose documents of the brief with, marked in their text, the objectives read from them (coloured by the verdict
  // the change measured) and the sentences nothing answers; a marked objective puts its line in focus at ③.
  const statusById = Object.fromEntries((preview?.conformance?.after?.results || []).map((r) => [r.id, ["pass", "fail", "unknown"].includes(r.status) ? r.status : "none"]));
  const annotatedBrief = (
    <AnnotatedBrief
      documents={documents.filter((d) => d.status === "ready" && d.id && !SHEET_RE.test(d.name || ""))}
      clauses={(contract.clauses || []).filter((c) => c?.quote && c.status !== "waived")}
      uncovered={contractState.coverage?.uncovered || []}
      statusOf={(c) => statusById[c.id] || "none"}
      onClause={(c) => {
        if (c?.params?.line) setLineFocus(String(c.params.line));
        onStep(3);
      }}
      onUncovered={() => onStep(2)}
    />
  );
  // J / K along the lines the draft changes, Enter opens the focused one in the reader, ? goes to the question waiting;
  // at ⑤, Enter applies once everything is accepted. Off while a form is open or the person types.
  const reviewLines = useMemo(() => reviewOf(frozen ? null : preview).lines, [preview, frozen]);
  useReviewKeys({
    enabled: step === 3 && (!panel || (shownView === "change" && !panelDialog)) && !frozen && !dialog && !resetting && !compareOpen && !refsOpen,
    lines: reviewLines,
    focus: lineFocus,
    onFocus: (l) => setLineFocus(String(l.route || l.label)),
    onOpen: openReader ? (l) => openReader({ route: l.route, date: l.date }) : null,
    onQuestion: () => document.querySelector('[data-testid="autopilot-answer-option"], [data-testid="autopilot-answer-input"], [data-testid="autopilot-daytitle-option"], [data-testid="change-answer-option"]')?.focus?.(),
  });
  useReviewKeys({ enabled: (panel ? panelDialog === "apply" : step === 5) && !frozen, lines: [], onApply: () => applyRef.current?.apply(), canApply: Boolean(applyState.canApply) });
  const renderBrief = () => {
    // ①'s way on waits for the network alone: the objectives are measured on it.
    // With a brief, its objectives come first (②); without one, the change starts at once — ② stays one click away
    // (objectives measured on the network), and the delivery records « sans objectif » under the person's name.
    return (
      <StepNetwork
        headless={panel}
        job="modify"
        name={project ? project.name : ""}
        onRename={project ? (name) => onUpdateProject?.({ name }) : null}
        network={networkCard}
        after={diagnosticFold}
        documents={{ pending: documents, onAttach: attach, onRemove: removeDocument, disabled: documents.length >= MAX_DOCUMENTS, notes: documentNotes }}
        // The brief's column holds the objectives read from it (②'s body, embedded): with a brief, ①'s one
        // act is ②'s (every objective proposed kept under a name, then the change); without one, the change itself —
        // the suggestions stay one tick away in the column, and the delivery records « sans objectif ».
        brief={
          networkOpen ? (
            <>
              {objectivesPage({ controlRef: objectivesRef })}
              {annotatedBrief}
            </>
          ) : null
        }
        primary={
          !networkOpen
            ? { label: t(briefGiven ? "step.primary.1.modify" : "step.primary.1.modify.direct"), onClick: () => {}, disabled: true, reason: t("step.reason.network") }
            : // The objectives' act when there is something to decide — a brief, an objective not kept by default —
              // or when the person signed the embedded objectives already (a name given records « sans objectif »
              // under it, ⑤'s act brought forward); else the change directly, the objectives one click away.
              briefGiven || (!contractIsReady && (nameOk(contractState.name) || (contract.clauses || []).some((c) => !c?.keep_by_default)))
              ? { ...objectivesPrimary, onClick: () => objectivesRef.current?.proceed(), alias: "contract-proceed" }
              : { label: t("step.primary.1.modify.direct"), onClick: () => onStep(3), disabled: false }
        }
      />
    );
  };
  // ── The draft's decision (its dialog) ──
  // One short screen in two times. Before: what the change does (its lines, its impact), four checks the person reads at
  // a glance (the objectives, the default guarantees, the validator, the data's integrity), what they accept under their
  // name and the act (ApplyDialog, compact); the whole report one click away. After: the version applied, the GTFS to
  // download first, the other documents under it, the way back (one undo reverts the whole change).
  const [checksDetail, setChecksDetail] = useState(false);
  const recordWithoutObjective = () => contractState.proceed((c) => ((c.clauses || []).length ? "decided" : "empty"), contractState.name, { prepare: (c) => acceptAll(c, { name: contractState.name, sentences: [], documents: [] }) });
  const renderDecision = ({ checksNode, beforeAct }) => {
    const card = { p: 2, borderRadius: "14px", border: `1px solid ${theme.palette.divider}`, backgroundColor: theme.palette.background.paper };
    if (frozen) {
      const by = frozen.by?.name || (typeof frozen.by === "string" ? frozen.by : "");
      return (
        <Box data-testid="decision-applied" sx={{ display: "flex", flexDirection: "column", gap: 2.5, py: 2.5 }}>
          <Box sx={{ display: "flex", alignItems: "center", gap: 1.75, p: 2.25, borderRadius: "16px", backgroundColor: alpha(theme.palette.success.main, theme.palette.mode === "dark" ? 0.16 : 0.08), border: `1px solid ${alpha(theme.palette.success.main, 0.3)}` }}>
            <CheckCircleRoundedIcon aria-hidden sx={{ fontSize: 36, color: "success.main" }} />
            <Box sx={{ flex: 1, minWidth: 0 }}>
              <Typography component="h3" sx={{ fontSize: "1.1rem", fontWeight: 800, letterSpacing: "-0.01em" }}>
                {t("decision.applied.title", { n: frozen.n })}
              </Typography>
              <Typography sx={{ fontSize: "0.84rem", color: "text.secondary", lineHeight: 1.5 }}>
                {by && frozen.at ? t("decision.applied.by", { name: by, date: formatDateTime(frozen.at, language) }) : t("decision.applied.body")}
              </Typography>
            </Box>
            <Button onClick={() => undoApplication(frozen.editId)} disabled={undoing} data-testid="decision-undo" sx={{ textTransform: "none", fontWeight: 650, color: "text.secondary", flexShrink: 0 }}>
              {undoing ? <CircularProgress size={16} /> : t("decision.applied.undo")}
            </Button>
          </Box>
          <Button
            variant="contained"
            disableElevation
            size="large"
            startIcon={<FileDownloadOutlinedIcon />}
            onClick={() => {
              setPanelDialog(null);
              deliverNow();
            }}
            data-testid="decision-download"
            sx={{ alignSelf: "flex-start", textTransform: "none", fontWeight: 800, borderRadius: "12px", px: 3, py: 1.25, fontSize: "0.95rem" }}
          >
            {t("decision.applied.download", { n: frozen.n })}
          </Button>
          <Box component="section" aria-labelledby="decision-documents" sx={card}>
            <Typography id="decision-documents" component="h3" sx={{ fontSize: "0.92rem", fontWeight: 700, mb: 1.25 }}>
              {t("decision.applied.documents")}
            </Typography>
            {deliverables}
          </Box>
        </Box>
      );
    }
    const gateNow = gateOf(preview);
    const counts = pageCounts;
    const integrityNow = gateIntegrity(gateNow, preview);
    const newErrors = gateNewErrors(gateNow);
    const validation = gateNow?.validation || "not_run";
    // One check: its state (ok | warn | fail | busy | none) and its sentence.
    const checks = [
      counts?.objectives?.total
        ? { id: "objectives", state: counts.objectives.pass === counts.objectives.total ? "ok" : counts.objectives.fail ? "warn" : "warn", text: t("decision.check.objectives", { pass: counts.objectives.pass, total: counts.objectives.total }) }
        : { id: "objectives", state: "none", text: t("decision.check.noObjectives") },
      counts?.guarantees?.total
        ? counts.guarantees.pass === counts.guarantees.total
          ? { id: "guarantees", state: "ok", text: t("decision.check.guarantees") }
          : counts.guarantees.fail
            ? { id: "guarantees", state: "warn", text: t("decision.check.guaranteesNot") }
            : contractIsReady
              ? { id: "guarantees", state: "warn", text: t("decision.check.guaranteesUnknown") }
              : { id: "guarantees", state: "none", text: t("decision.check.guaranteesLater") }
        : null,
      validating || previewing
        ? { id: "validator", state: "busy", text: t("decision.check.validating", { seconds: validateSeconds }) }
        : validation === "passed"
          ? { id: "validator", state: "ok", text: t("decision.check.validator") }
          : newErrors.length
            ? { id: "validator", state: "fail", text: t("decision.check.validatorErrors", { count: newErrors.length }) }
            : { id: "validator", state: "none", text: t("decision.check.validatorNotRun") },
      preview ? { id: "integrity", state: integrityNow.length ? "fail" : "ok", text: t(integrityNow.length ? "decision.check.integrityBroken" : "decision.check.integrity") } : null,
    ].filter(Boolean);
    const tone = { ok: theme.palette.success.main, warn: theme.palette.warning.main, fail: theme.palette.error.main, none: theme.palette.text.disabled, busy: theme.palette.primary.main };
    const icon = (state) =>
      state === "busy" ? <CircularProgress size={18} /> : state === "ok" ? <CheckCircleRoundedIcon sx={{ fontSize: 20, color: tone.ok }} /> : state === "fail" ? <CancelRoundedIcon sx={{ fontSize: 20, color: tone.fail }} /> : state === "warn" ? <ErrorRoundedIcon sx={{ fontSize: 20, color: tone.warn }} /> : <RadioButtonUncheckedRoundedIcon sx={{ fontSize: 20, color: tone.none }} />;
    const lines = reviewLines.slice(0, 4);
    // By hand, nothing to decide but the name: the change recorded without objective and applied in one act.
    const byHandAct = kind === "hand" && !contractIsReady && !briefGiven;
    // Times said as the reader says them (« 21:40 », never « 21:40:00 »).
    const said = (text) => String(text || "").replace(/\b(\d{1,2}:\d{2}):00\b/g, "$1");
    const allOk = checks.every((c) => c.state === "ok");
    const impact = preview?.impact && !preview.impact.error ? preview.impact : null;
    const signed = (n, opts = {}) => (Number(n) > 0 ? "+" : Number(n) < 0 ? "−" : "±") + formatNumber(Math.abs(Number(n) || 0), language, { maximumFractionDigits: 0, ...opts });
    const money = (n) => `${signed(n)} ${impact?.currency === "EUR" || !impact?.currency ? "€" : impact.currency}`;
    const figures = impact && ["km", "cost", "fleet"].some((key) => Number(impact.totals?.[key]?.delta))
      ? [
          impact.totals.km ? { id: "km", icon: <StraightenRoundedIcon sx={{ fontSize: 18 }} />, value: `${signed(impact.totals.km.delta)} km`, label: t("decision.impact.km"), of: impact.totals.km.before ? t("decision.impact.of", { pct: formatNumber(impact.totals.km.pct ?? (100 * impact.totals.km.delta) / impact.totals.km.before, language, { maximumFractionDigits: 1, signDisplay: "always" }) }) : null } : null,
          impact.totals.cost ? { id: "cost", icon: <EuroRoundedIcon sx={{ fontSize: 18 }} />, value: money(impact.totals.cost.delta), label: t("decision.impact.cost"), of: null } : null,
          impact.totals.fleet ? { id: "fleet", icon: <DirectionsBusFilledOutlinedIcon sx={{ fontSize: 18 }} />, value: signed(impact.totals.fleet.delta), label: t("decision.impact.fleet"), of: null } : null,
        ].filter(Boolean)
      : [];
    // A section: a quiet overline with its icon, then its content — no card around it.
    const sectionHead = (icon, text, extra = null) => (
      <Box sx={{ display: "flex", alignItems: "center", gap: 1, mb: 1.25 }}>
        <Box aria-hidden sx={{ display: "inline-flex", color: "text.secondary" }}>{icon}</Box>
        <Typography component="h3" sx={{ flex: 1, fontSize: "0.72rem", fontWeight: 800, letterSpacing: "0.08em", textTransform: "uppercase", color: "text.secondary" }}>
          {text}
        </Typography>
        {extra}
      </Box>
    );
    return (
      <Box data-testid="decision" sx={{ display: "flex", flexDirection: "column", gap: 3, py: 2.5 }}>
        <Box component="section" aria-label={t("decision.what")} data-testid="decision-what">
          {sectionHead(<SwapHorizRoundedIcon sx={{ fontSize: 18 }} />, t("decision.what"))}
          {plan.title && <Typography sx={{ fontSize: "1.15rem", fontWeight: 800, letterSpacing: "-0.015em", lineHeight: 1.3, mb: 1.25 }}>{plan.title}</Typography>}
          {lines.length > 0 ? (
            <Box component="ul" sx={{ m: 0, p: 0, listStyle: "none", display: "flex", flexDirection: "column", gap: 1 }}>
              {lines.map((line) => {
                const colors = lineColorsOf(routes, line.route || line.label, theme);
                return (
                  <Box component="li" key={line.route || line.label} sx={{ display: "flex", alignItems: "flex-start", gap: 1.25 }}>
                    <Box component="span" sx={{ flexShrink: 0, minWidth: 36, px: 0.75, py: "2px", mt: "1px", borderRadius: "7px", textAlign: "center", fontSize: "0.82rem", fontWeight: 800, ...(colors ? { color: colors.fg, backgroundColor: colors.bg } : { color: "text.primary", backgroundColor: alpha(theme.palette.text.primary, 0.08) }) }}>
                      {line.label}
                    </Box>
                    <Box component="ul" sx={{ m: 0, p: 0, listStyle: "none", display: "flex", flexDirection: "column", gap: 0.25 }}>
                      {line.items.map((it, i) => (
                        <Typography component="li" key={i} sx={{ fontSize: "0.88rem", lineHeight: 1.5 }}>
                          {said(describeItem(t, it, language))}
                        </Typography>
                      ))}
                    </Box>
                  </Box>
                );
              })}
              {reviewLines.length > lines.length && <Typography sx={{ fontSize: "0.8rem", color: "text.secondary" }}>{t("decision.moreLines", { count: reviewLines.length - lines.length })}</Typography>}
            </Box>
          ) : (
            <Typography sx={{ fontSize: "0.88rem", color: "text.secondary" }}>{t("decision.noLine", { count: plan.operations.length })}</Typography>
          )}
          {figures.length > 0 && (
            <Box data-testid="decision-impact" sx={{ mt: 2 }}>
              <Box sx={{ display: "grid", gridTemplateColumns: `repeat(${figures.length}, minmax(0, 1fr))`, gap: 1.25 }}>
                {figures.map((f) => (
                  <Box key={f.id} data-impact={f.id} sx={{ p: 1.5, borderRadius: "12px", backgroundColor: alpha(theme.palette.primary.main, theme.palette.mode === "dark" ? 0.12 : 0.05), display: "flex", flexDirection: "column", gap: 0.25 }}>
                    <Box sx={{ display: "flex", alignItems: "center", gap: 0.75, color: "primary.main" }}>
                      {f.icon}
                      <Typography sx={{ fontSize: "1.15rem", fontWeight: 800, color: "text.primary", fontVariantNumeric: "tabular-nums", letterSpacing: "-0.01em" }}>{f.value}</Typography>
                    </Box>
                    <Typography sx={{ fontSize: "0.76rem", color: "text.secondary", lineHeight: 1.35 }}>{f.label}</Typography>
                    {f.of && <Typography sx={{ fontSize: "0.7rem", color: "text.secondary" }}>{f.of}</Typography>}
                  </Box>
                ))}
              </Box>
              <Typography sx={{ mt: 0.75, fontSize: "0.72rem", color: "text.secondary" }}>{t("decision.impact.note")}</Typography>
            </Box>
          )}
        </Box>
        <Box component="section" aria-label={t("decision.checks")}>
          {sectionHead(
            <VerifiedRoundedIcon sx={{ fontSize: 18 }} />,
            t("decision.checks"),
            allOk ? <Box component="span" data-testid="decision-checks-ok" sx={{ px: 1, py: 0.25, borderRadius: 99, fontSize: "0.72rem", fontWeight: 750, color: "success.dark", backgroundColor: alpha(theme.palette.success.main, 0.12) }}>{t("decision.checks.ok")}</Box> : null,
          )}
          <Box component="ul" data-testid="decision-checks" sx={{ m: 0, p: 0.5, listStyle: "none", borderRadius: "12px", backgroundColor: allOk ? alpha(theme.palette.success.main, theme.palette.mode === "dark" ? 0.1 : 0.05) : alpha(theme.palette.text.primary, 0.03), display: "grid", gridTemplateColumns: "repeat(2, minmax(0, 1fr))" }}>
            {checks.map((c) => (
              <Box component="li" key={c.id} data-testid={`decision-check-${c.id}`} data-state={c.state} sx={{ display: "flex", alignItems: "flex-start", gap: 1, px: 1.25, py: 1 }}>
                <Box sx={{ width: 20, mt: "1px", display: "flex", justifyContent: "center", flexShrink: 0 }}>{icon(c.state)}</Box>
                <Typography sx={{ fontSize: "0.84rem", lineHeight: 1.45, fontWeight: c.state === "fail" ? 700 : 500, color: c.state === "fail" ? "error.main" : "text.primary" }}>{c.text}</Typography>
              </Box>
            ))}
          </Box>
          <ButtonBase onClick={() => setChecksDetail((v) => !v)} aria-expanded={checksDetail ? "true" : "false"} data-testid="decision-detail-toggle" sx={{ display: "inline-flex", alignItems: "center", gap: 0.5, mt: 0.75, px: 0.75, py: 0.5, borderRadius: "8px", fontSize: "0.8rem", fontWeight: 650, color: "primary.main", "&:hover": { backgroundColor: alpha(theme.palette.primary.main, 0.06) } }}>
            {t(checksDetail ? "decision.detail.hide" : "decision.detail.show")}
            <ExpandMoreIcon sx={{ fontSize: 18, transform: checksDetail ? "rotate(180deg)" : "none", transition: "transform .2s" }} />
          </ButtonBase>
          {checksDetail && (
            <Box data-testid="decision-detail" sx={{ mt: 1.25, p: 2, borderRadius: "12px", border: `1px solid ${theme.palette.divider}` }}>
              {checksNode}
            </Box>
          )}
        </Box>
        <Box component="section" aria-label={t("decision.act")}>
          {sectionHead(<DrawOutlinedIcon sx={{ fontSize: 18 }} />, t("decision.yours"))}
          {byHandAct ? (
            <Box component="section" aria-labelledby="decision-hand-act-title" data-testid="decision-hand-act" sx={{ display: "flex", flexDirection: "column", gap: 1.5 }}>
              <Box>
                <Typography id="decision-hand-act-title" component="h3" sx={{ fontSize: "0.95rem", fontWeight: 750 }}>
                  {t("decision.hand.title")}
                </Typography>
                <Typography sx={{ fontSize: "0.82rem", color: "text.secondary", lineHeight: 1.5, mt: 0.25 }}>{t("decision.hand.body", { n: nextN })}</Typography>
              </Box>
              <Box sx={{ display: "flex", alignItems: "center", gap: 1.25, flexWrap: "wrap" }}>
                <TextField size="small" label={t("delivery.noObjective.name")} value={contractState.name || ""} onChange={(e) => contractState.setName(e.target.value.slice(0, 120))} disabled={Boolean(oneAct)} inputProps={{ "data-testid": "decision-hand-name", maxLength: 120 }} sx={{ flex: "1 1 240px", maxWidth: 340 }} />
                <Box sx={{ flex: 1 }} />
                <Button onClick={() => setPanelDialog(null)} disabled={Boolean(oneAct)} data-testid="decision-hand-back" sx={{ textTransform: "none", fontWeight: 650 }}>
                  {t("ack.backToChange")}
                </Button>
                <Button
                  variant="contained"
                  disableElevation
                  disabled={!nameOk(contractState.name) || Boolean(oneAct) || streaming || previewing || validating}
                  onClick={() => {
                    setOneAct("recording");
                    recordWithoutObjective();
                  }}
                  startIcon={oneAct ? <CircularProgress size={14} color="inherit" /> : null}
                  data-testid="decision-hand-apply"
                  sx={{ textTransform: "none", fontWeight: 800, borderRadius: "10px", px: 2.5 }}
                >
                  {oneAct ? t("decision.hand.applying") : t("panel.apply", { n: nextN })}
                </Button>
              </Box>
              {/* The act's machinery stays mounted (its state and its apply), out of sight while this one act stands. */}
              <Box sx={{ display: "none" }}>{applySection}</Box>
            </Box>
          ) : (
            <>
              {beforeAct}
              <Box component="section" aria-label={t("decision.act")} data-testid="decision-act">
                {applySection}
              </Box>
            </>
          )}
  
        </Box>
      </Box>
    );
  };
  const renderDelivery = () => {
    // The delivery's checks first: the verdict of the simulation, the canonical validator's run on it, the changes it
    // makes, the coherence report — then the act and the deliverables (a modify ④ address opens it too).
    const v = preview?.validation || null;
    const checksTiles = [
      preview ? verdictTile({ payload: { verdict: preview.verdict ?? null, gate: preview.gate || null, validation: v }, measured: true, counts: pageCounts }, t) : null,
      validatorTile(validatorOff ? "unavailable" : validating ? "running" : v?.error ? "unavailable" : v ? (v.new_errors?.length ? "errors" : "ok") : "none", t, v?.new_errors?.length ? t("gtfsCheck.newErrors", { count: v.new_errors.length }) : null),
      { id: "changes", label: t("checks.kpi.changes"), value: String(preview?.diff?.items?.length ?? 0), tone: preview?.diff?.items?.length ? "accent" : "neutral", hint: t("checks.kpi.operations", { count: plan.operations.length }) },
      // The third fact of the decision: what the person accepts under their name — the engine's own
      // choices, an objective not met or not measurable — counted by the apply section; none once applied.
      frozen ? null : { id: "accept", label: t("checks.kpi.accept"), value: String(applyState.items ?? 0), tone: applyState.items ? "warn" : "ok", hint: t(applyState.items ? "checks.kpi.accept.hint" : "checks.kpi.accept.none") },
    ];
    // The checks unfold by themselves while something holds the act (nothing simulated, a blocked step, the validator
    // not passed): the person reads why where it is measured; ready, the decision stands alone and the checks wait folded.
    const checksOpen = !frozen && (!preview?.id || stuck || validateFailed || Boolean(preview?.validation?.new_errors?.length) || Boolean(applyState.blocking));
    // What must be settled before the act (a change without objective recorded under a name): with the checks on the
    // step's page, above the act in the draft's decision.
    const beforeAct = (
      <>
    {!frozen && !contractIsReady && !briefGiven && (
      // The server applies nothing without a contract decided or recorded empty by a named person: a
      // change made without a brief records it here, by the same act as ②'s « Continuer sans objectif » — the
      // guarantees kept by default decided with it, under that name.
      <Box data-testid="delivery-no-objective" sx={{ p: 1.5, borderRadius: "12px", border: `1px solid ${alpha(theme.palette.info.main, 0.4)}`, backgroundColor: alpha(theme.palette.info.main, theme.palette.mode === "dark" ? 0.12 : 0.05), display: "flex", flexDirection: "column", gap: 1 }}>
        <Typography component="h3" sx={{ fontSize: "0.88rem", fontWeight: 700 }}>{t("delivery.noObjective.title")}</Typography>
        <Typography sx={{ fontSize: "0.78rem", color: "text.secondary", lineHeight: 1.5 }}>{t("delivery.noObjective.body")}</Typography>
        <Box sx={{ display: "flex", flexWrap: "wrap", alignItems: "center", gap: 1 }}>
          <TextField size="small" label={t("delivery.noObjective.name")} value={contractState.name || ""} onChange={(e) => contractState.setName(e.target.value.slice(0, 120))} inputProps={{ "data-testid": "delivery-no-objective-name", maxLength: 120 }} sx={{ flex: "1 1 220px", maxWidth: 320 }} />
          <Button variant="contained" disableElevation disabled={!nameOk(contractState.name) || streaming || previewing || validating} onClick={() => contractState.proceed((c) => ((c.clauses || []).length ? "decided" : "empty"), contractState.name, { prepare: (c) => acceptAll(c, { name: contractState.name, sentences: [], documents: [] }) })} data-testid="delivery-no-objective-record" sx={{ textTransform: "none", fontWeight: 700 }}>
            {t("delivery.noObjective.record")}
          </Button>
          <Button size="small" onClick={() => onStep(2)} data-testid="delivery-no-objective-objectives" sx={{ textTransform: "none", fontWeight: 600 }}>
            {t("delivery.noObjective.objectives")}
          </Button>
        </Box>
      </Box>
    )}
      </>
    );
    const checksNode = (
      <Box data-testid="delivery-checks-body" sx={{ display: "flex", flexDirection: "column", gap: 1.25 }}>
        {/* The applied scenario is said once, by the act's result below (change-applied). */}
        {notices}
        <ChangeRecap plan={plan} preview={frozen ? notePreview : preview} catalogue={catalogue} validating={validating} seconds={validateSeconds} applied={frozen ? frozen.n : null} skipped={gridWishes(contract).filter((w) => !coveredBy(w)).map((w) => String(w.quote))} covered={gridWishes(contract).filter(coveredBy).map((w) => coveredText(String(w.quote), coveredBy(w)))} />
        <CoherenceReport source={coherenceSource} pending={t("coherence.waiting.modify")} note={coherenceNote} onResimulate={frozen ? null : () => refresh(planRef.current)} onResume={onRecover} exportSource={fileSource} labels={fileLabels} contractAdd={streaming ? null : contractAdd} />
        <Tabs value={tab} onChange={(_, value) => setTab(value)} sx={{ minHeight: 40, borderBottom: `1px solid ${theme.palette.divider}`, "& .MuiTab-root": tabSx }}>
          <Tab value="checks" icon={<FactCheckOutlinedIcon sx={{ fontSize: 16 }} />} iconPosition="start" label={t("step.4.tab.validator")} data-testid="change-tab-checks" />
          <Tab value="changes" icon={<CompareArrowsIcon sx={{ fontSize: 16 }} />} iconPosition="start" label={`${t("transform.tab.changes")}${preview?.diff?.items?.length ? ` (${preview.diff.items.length})` : ""}`} data-testid="change-tab-changes" />
        </Tabs>
        {/* A frozen scenario is never simulated again: the validator's re-run is closed on it. */}
        {tab === "changes" ? (
          <>
            <ChangesPanel preview={preview} plan={plan} />
            <DraftRetouches testid="delivery-retouches" edit={retouchEdit} />
          </>
        ) : (
          <Box data-testid="validation-panel">
            {validating && (
              <Typography data-testid="validation-running" sx={{ fontSize: "0.8rem", color: "text.secondary", mb: 0.5 }}>
                {t("gtfsCheck.running", { seconds: validateSeconds })}
              </Typography>
            )}
            <ChecksPanel preview={preview} validating={validating} frozen={Boolean(frozen)} onValidate={() => (frozen ? null : refresh(plan, { validate: true }))} />
          </Box>
        )}
        {beforeAct}
      </Box>
    );
    if (panel) return renderDecision({ checksNode, beforeAct });
    const prerequisite = editing ? t("delivery.prereq.ok") : editLocked ? t("step.locked.edit") : t("step.delivery.enterEdit");
    return (
      <StepDelivery
        job="modify"
        tiles={checksTiles}
        checks={checksNode}
        checksOpen={checksOpen}
        prerequisite={prerequisite}
        accept={false}
        act={applySection}
        deliverables={deliverables}
        versions={project?.versions || []}
        nextVersion={frozen ? frozen.n : project ? nextVersionNumber(project) : 1}
        note={notePreview && appliedVersion ? { versionId: appliedVersion.id, build: () => ({ content: buildSynthesisHtml({ plan, preview: notePreview, applied: noteApplied, t, language, coveredOf }) }) } : null}
        // Before the application the decision section holds the one act (« Appliquer sous mon nom », beside what is
        // accepted and the name): the bar carries no second button for it; once applied, « Livrer ».
        primary={frozen ? { label: t("delivery.deliver"), onClick: panel ? deliverNow : () => window.dispatchEvent(new CustomEvent("gtfs:open-export-preflight")), disabled: panel ? false : !editing, reason: t("step.delivery.enterEdit"), arrow: false } : null}
        back={panel ? null : back}
      />
    );
  };
  let page;
  if (panel) {
    page = renderPanel();
  } else if (step === 1) {
    page = renderBrief();
  } else if (step === 2) {
    page = objectivesPage(null);
  } else if (step >= 4) {
    page = renderDelivery();
  } else {
    page = (
      <StepChange
        conversation={assistantColumn}
        sidebar={sidebar}
        pane={pane}
        frozen={frozen ? { n: frozen.n, onUndo: () => undoApplication(frozen.editId), undoing } : null}
        primary={
          frozen
            ? { label: t("scenario.newFromVersion", { n: frozen.n }), onClick: newScenarioFromVersion, arrow: false }
            : { label: t("step.primary.3.modify"), onClick: simulateAndCheck, disabled: !plan.operations.length || stuck || previewing || streaming || nothingToApply, reason: !plan.operations.length ? t(pilot.busy ? "step.reason.building" : "step.reason.noOperation") : stuck ? t("step.reason.planBlocked") : nothingToApply ? t("step.reason.nothingToApply") : t("step.reason.building") }
        }
        back={back}
        footer={desk ? null : changeFooter}
        bench={desk ? atelierBench : null}
      />
    );
  }

  return (
    <>
      {page}
      {diagHost && diagnostic ? createPortal(diagnostic, diagHost) : null}
      <OperationDialog open={Boolean(dialog)} catalogue={catalogue} routes={routes} stops={stops} onNeedStops={needStops} initial={dialog?.initial || null} defaults={framingDefaults(project?.context)} onClose={() => setDialog(null)} onSave={saveOp} />
      <ReferencesDialog open={refsOpen} onClose={() => setRefsOpen(false)} />
      <ScenarioCompare open={compareOpen} onClose={() => setCompareOpen(false)} ws={ws} onLoad={switchTo} />
      {/* An operation removed stays within reach for a moment: « Annuler » puts it back. */}
      <Snackbar
        open={Boolean(removed)}
        autoHideDuration={8000}
        onClose={(_, reason) => reason !== "clickaway" && setRemoved(null)}
        message={t("transform.removed")}
        action={
          <Button size="small" color="inherit" onClick={undoRemove} data-testid="change-undo-remove" sx={{ fontWeight: 700 }}>
            {t("app.undo")}
          </Button>
        }
        data-testid="change-removed"
      />
    </>
  );
}
