/**
 * NetworkStudio — create a transit network from scratch, as the steps of a
 * project (target design §4, D4, D45): no longer a full-screen dialog, the
 * studio is the flow of the create job and renders the page of the step the
 * route names —
 *
 *   ① StepNetwork   the workbench (studio/Workspace on a desktop screen): the
 *                   map in the middle on the whole height; on its left a tool
 *                   rail and the panel of the tool open — the starting point
 *                   (the name, the territory, the brief and its annexes, the
 *                   deliverables), the conversation with the planner (the
 *                   assistant designs the Network Spec through server tools:
 *                   geocoding, validation, road routing, questions) or the
 *                   work by hand, the lines, the stops, the raw JSON in
 *                   expert mode, the settings; on its right the inspector —
 *                   what is still to do before the contract, the engine's
 *                   verdict, the points to check, what it needs — every edit
 *                   re-validated live. The step's actions sit in the
 *                   studio's bar (StudioTopBar). On a phone, the older
 *                   two-pane workbench with its tabs;
 *   ② StepContract  the contract (WP5, mission step 3): the brief's clauses as
 *                   the extraction proposes them or as written by hand
 *                   (ClauseForm), decided by a named person, « à vérifier à
 *                   la main », the requirement sentences without a clause
 *                   (G5); decided, assumed or recorded empty before the
 *                   assistant designs anything — the first message is the
 *                   extraction (phase "extract"), and ③'s composer is locked
 *                   until the contract is ready (D45: by hand, ①'s workbench
 *                   and `network-build` stay free);
 *   ③ StepDesign    the same workbench; "Vérifier la conception" → ④;
 *   ④ StepChecks    the engine's verdict pinned, the design's quality, and
 *                   the canonical validator on the build checked without
 *                   being built (the dry run), all run on arrival;
 *   ⑤ StepDelivery  the named acknowledgement, the build (a version of the
 *                   project: v1, v2…), its result (`network-result`, "Voir
 *                   le réseau" `network-open`), the deliverables — the GTFS
 *                   downloaded without edit mode (`network-download`, D8) —
 *                   and the versions.
 *
 * `network-build` stays in the foot of steps ①–④ with ONE rule (D45): it
 * goes to ⑤, where the checks run by themselves, an undecided contract is
 * recorded "empty" ("0 clause — contrat vide", D15), and the build follows
 * directly when nothing is left to accept — else the form of section 1
 * comes first, with what the engine lists. Every build records a contract
 * still undecided the same way, whichever way ⑤ was reached (the rail, "Passer
 * à la livraison"): no version exists with ② still a draft. There is no "④
 * before ⑤" gate and nothing is built unasked (no "build automatically"
 * option any more, no "ready" strips, no confirmation dialog, no second
 * "your network is built" dialog: a build creates a version, it closes
 * nothing).
 *
 * A build freezes the design (D37): the scenario is "built in vN", the
 * workbench of ① and ③ reads it without changing it (the editors, the map,
 * the assistant and "Start over" are closed on it, `network-build` says
 * why), and ③'s primary action is "Nouveau scénario sur vN" — a draft copy
 * of the design, whose build makes vN+1. ⑤ keeps the build's deliverables:
 * when the build's answer is gone (a visit of the explorer, a reload) its
 * report is read back from the server, so the note stays downloadable and
 * the acknowledgement stays said; the GTFS is named after its version, and
 * a network retouched since its build (409 BUILD_EDITED) is delivered from
 * edit mode, in place ("Livrer…").
 *
 * Without the assistant (the server's chat off, no Studio access, or no
 * message left: D14, D30) the studio still works and says so: at ① the
 * composer stays (a text pasted is kept as a document of the project, and
 * documents are attached all the same, D44); at ③ the column where the
 * conversation would be is the work by hand (ManualSidebar: the design's
 * sub-tasks with their states — the settings' three required fields, the
 * stops, the lines, the points to fix — the contract, the verdict measured
 * again on each edit, « Ouvrir l'éditeur de lignes », what we need from you
 * and the territory); the network's settings are folded behind what is
 * left to fill (NetworkSettings). The user draws the network by hand,
 * geocodes stops one by one and builds. A request to
 * MODIFY a running network is handed over to the real feed (HandoffCard →
 * a project that modifies it); a plan started from a simplified import is
 * labelled as such, and the server's refusal to build it (409
 * SIMPLIFIED_BASELINE) offers the real network or a study build. Failures
 * read in plain words. The acts that lose work ("Start over", replacing the
 * design by a proposal) ask first, in place. The focus moves by refs.
 *
 * The coherence report (WP6, §6.2) is the built network's while the design
 * is the one built, else the design's dry run's — which the server returns
 * even when the canonical validator refuses it (the report never needs the
 * validator, M-5), so the dry run runs at ④ whether or not a validator
 * answers here. It cross-checks the contract's clauses only once ② is
 * decided. A built network whose working copy is gone ("resume" on the
 * report's refusal) is read again from the design that produced it.
 *
 * The flow reports what it knows to the rail (`onFacts`: StepNav's
 * stepStates) and writes the project through `onUpdateProject`
 * (utils/projectStore): the design, the contract's status, the versions.
 * The design is written into the project's active scenario as it changes
 * (debounced, like the autosave), not only at the build: the server keeps
 * it (§2.4), and a browser that holds no draft of the project (another
 * device, another browser of the account, a cleared cache) opens on it —
 * the draft in this browser (the conversation, the territory, the
 * documents) is only its cache (§9).
 */

import React, { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { Alert, Box, Button, Chip, CircularProgress, Collapse, FormControlLabel, IconButton, LinearProgress, Popover, Snackbar, Switch, Tab, Tabs, TextField, Tooltip, Typography, alpha, useMediaQuery, useTheme } from "@mui/material";
import RestartAltIcon from "@mui/icons-material/RestartAlt";
import BuildCircleOutlinedIcon from "@mui/icons-material/BuildCircleOutlined";
import MapOutlinedIcon from "@mui/icons-material/MapOutlined";
import RouteOutlinedIcon from "@mui/icons-material/RouteOutlined";
import PlaceOutlinedIcon from "@mui/icons-material/PlaceOutlined";
import DataObjectOutlinedIcon from "@mui/icons-material/DataObjectOutlined";
import ErrorOutlineIcon from "@mui/icons-material/ErrorOutline";
import WarningAmberIcon from "@mui/icons-material/WarningAmber";
import CheckCircleOutlineIcon from "@mui/icons-material/CheckCircleOutline";
import ExpandMoreIcon from "@mui/icons-material/ExpandMore";
import RefreshIcon from "@mui/icons-material/Refresh";
import LockOutlinedIcon from "@mui/icons-material/LockOutlined";
import DirectionsBusFilledOutlinedIcon from "@mui/icons-material/DirectionsBusFilledOutlined";
import AddLocationAltOutlinedIcon from "@mui/icons-material/AddLocationAltOutlined";
import TuneRoundedIcon from "@mui/icons-material/TuneRounded";
import ContentCopyIcon from "@mui/icons-material/ContentCopy";
import FileDownloadOutlinedIcon from "@mui/icons-material/FileDownloadOutlined";
import DescriptionOutlinedIcon from "@mui/icons-material/DescriptionOutlined";
import FlagOutlinedIcon from "@mui/icons-material/FlagOutlined";
import AutoAwesomeOutlinedIcon from "@mui/icons-material/AutoAwesomeOutlined";
import ChecklistRoundedIcon from "@mui/icons-material/ChecklistRounded";
import OpenInFullRoundedIcon from "@mui/icons-material/OpenInFullRounded";
import CloseFullscreenRoundedIcon from "@mui/icons-material/CloseFullscreenRounded";
import { useLanguage } from "../../contexts/LanguageContext";
import { useFeatures } from "../../utils/featuresApi";
import { validateSpec, estimateSpec, compileSpec, checkSpec, streamPlan, loadDraft, saveDraft, draftKeyOf, fetchCoverage, evaluateSpec, refineSpec, uploadBriefDocument, deleteBriefDocument, fetchNeeds, openCatalogFeed, rememberBuild, builtSessionOf, downloadBuiltNetwork, fetchNetworkReport } from "../../utils/networkStudioApi";
import { getSessionId } from "../../utils/sessionManager";
import { deleteDemandData, uploadDemandData } from "../../utils/transformApi";
import { humanError } from "../../utils/humanError";
import { activeScenarioOf, announceDocument, withJournal, withScenario, withScenarioFromVersion, withVersion, nextVersionNumber } from "../../utils/projectStore";
import { formatDateTime, formatNumber } from "../../utils/formatDate";
import ErrorNotice from "../common/ErrorNotice";
import useElapsed from "../common/useElapsed";
import { SimplifiedBaselineDialog } from "./SimplifiedBaseline";
import NeedsPanel, { NeedsChip } from "./NeedsPanel";
import TerritoryPanel from "./TerritoryPanel";
import MapLayers from "./MapLayers";
import { InlineConfirm, soft } from "./StudioUI";
import { QualityBadge, QualityCard, fmtMoney } from "./PlanCards";
import { BriefBadge } from "./BriefChecklist";
import NetworkMap from "./NetworkMap";
import { geometryFromEstimate, routedForServer } from "./networkGeometry";
import PlanChat from "./PlanChat";
import { groupIssues } from "./issueText";
import { LinesEditor, StopsEditor, JsonEditor, withStopIds } from "./SpecEditors";
import NetworkSettings, { prefillFromTerritory } from "./NetworkSettings";
import ManualSidebar, { designTasksOf } from "../transform/ManualSidebar";
import VerdictCard from "../common/VerdictCard";
import { buildNetworkSynthesisHtml, downloadNetworkSynthesis } from "./networkSynthesis";
import { approvalOf, approvalRequired } from "../../utils/deliverablesApi";
import { PRICING_EVENT } from "../PricingDialog";
import { useAccount } from "../../contexts/AccountContext";
import AcknowledgementForm, { NAME_OK, allTicked, bodyOf, itemsFromRefusal, mergeItems, missingKeys, rememberName, rememberedName } from "../common/AcknowledgementForm";
import RefusalNotice from "../common/RefusalNotice";
import LockedAction from "../common/LockedAction";
import { refusalOf } from "../../utils/refusalToAction";
import StepNetwork, { DeliverablesWanted, RetentionPanel, retentionDaysOf } from "../steps/StepNetwork";
import { useStepActionsSlot } from "../AppShell";
import { Inspector, Panel, Section, ToolRail, Workspace, floatSx } from "../studio/Workspace";
import { useFillLayout } from "../steps/StepFrame";
import DocumentDrop from "../common/DocumentDrop";
import StepContract from "../steps/StepContract";
import StepDesign from "../steps/StepDesign";
import StepChecks, { ValidatorSection, validatorTile } from "../steps/StepChecks";
import CoherenceReport, { CoherenceDownloadNotice, CoherenceFileButtons, CoherenceRunning, coherenceContractAdd, useCoherenceDownloads } from "../common/CoherenceReport";
import { contractClauses, downloadCoherenceCsv, forgetCoherence, noteCoherence } from "../../utils/coherenceApi";
import StepDelivery from "../steps/StepDelivery";
import useContract from "../common/useContract";
import { proceedState } from "../common/ContractPanel";
import { isReady as contractReady, nameOk } from "../../utils/contract";

const EMPTY_SPEC = { agency: { name: "", url: "", timezone: "" }, stops: [], lines: [] };
const EXPERT_KEY = "gtfs:network-expert";
// ⑤'s item for a contract nobody decided at ②: ticked under a name, the build records it empty under that name.
const CONTRACT_EMPTY_ITEM = Object.freeze({ key: "contract:empty", kind: "contract_empty" });
// How long the design stays unchanged before it is written into the project (the autosave's own debounce follows).
const PROJECT_DESIGN_MS = 800;
/** The design as the project keeps it: the spec once it holds a line or a stop, else nothing. */
const designOf = (spec) => ((spec?.lines || []).length || (spec?.stops || []).length ? spec : null);
const MAX_DOCUMENTS = 5;
// The workbench's tabs and their URL slugs (/p/:id/:step/:tab).
const TAB_SLUG = Object.freeze({ map: "carte", lines: "lignes", stops: "arrets", json: "detail" });
const SLUG_TAB = Object.freeze({ carte: "map", lignes: "lines", arrets: "stops", detail: "json" });
// The desktop workbench's tool for a tab of the route (the map is always shown there).
const TOOL_OF_TAB = Object.freeze({ lines: "lines", stops: "stops", json: "json" });
// A cheap, stable fingerprint of the design and its brief: the checks (④) and the build (⑤) say which design they judged.
const designKeyOf = (spec, requirements) => {
  const text = JSON.stringify({ spec, clauses: requirements?.clauses || [] });
  let h = 0;
  for (let i = 0; i < text.length; i += 1) h = (Math.imul(31, h) + text.charCodeAt(i)) | 0;
  return `${text.length}:${(h >>> 0).toString(16)}`;
};
// Move the focus to an element held by a ref (never a query on a testid), scrolled into view.
const focusEl = (el) => {
  if (!el) return;
  el.scrollIntoView?.({ block: "nearest", behavior: "smooth" });
  el.focus?.();
};
const haversineM = (a, b, c, d) => {
  const R = 6371000;
  const dLat = ((c - a) * Math.PI) / 180;
  const dLon = ((d - b) * Math.PI) / 180;
  const x = Math.sin(dLat / 2) ** 2 + Math.cos((a * Math.PI) / 180) * Math.cos((c * Math.PI) / 180) * Math.sin(dLon / 2) ** 2;
  return 2 * R * Math.asin(Math.sqrt(x));
};
const newId = () => `${Date.now().toString(36)}${Math.random().toString(36).slice(2, 7)}`;
/** A part of the workbench read without being changed (a frozen design, D37): no pointer, no focus, said to assistive tech. */
const ReadOnly = ({ on, children }) =>
  on ? (
    <Box aria-disabled="true" inert="" data-readonly="true" sx={{ pointerEvents: "none", opacity: 0.85 }}>
      {children}
    </Box>
  ) : (
    children
  );
const readFlag = (key) => {
  try {
    return localStorage.getItem(key) === "1";
  } catch {
    return false;
  }
};
const writeFlag = (key, on) => {
  try {
    localStorage.setItem(key, on ? "1" : "0");
  } catch {
    /* storage disabled */
  }
};
/**
 * The report credits only the data sources that answered: Overpass is
 * dropped when no OpenStreetMap data came back (the dossier's warnings
 * ride along for the report dialog).
 */
export const creditAnsweredSources = (report, d) => {
  if (!report?.territory || !d || report.territory.query !== d.place?.query) return report;
  const osm = (d.existing_stops || []).length || (d.existing_lines || []).length || (d.pois?.items || []).length || (d.population_grid?.cells || []).length || (d.works?.items || []).length;
  const sources = (report.territory.sources || []).filter((s) => s.id !== "overpass" || osm);
  return { ...report, territory: { ...report.territory, sources, warnings: d.warnings || [] } };
};

const centroid = (stops) => {
  const pts = (stops || []).filter((s) => Number.isFinite(s.lat) && Number.isFinite(s.lon));
  if (!pts.length) return null;
  return { lat: pts.reduce((a, s) => a + s.lat, 0) / pts.length, lon: pts.reduce((a, s) => a + s.lon, 0) / pts.length };
};

// Turn a normalised spec (server) back into the editable shape (services
// keep `calendar` names; stops keep coordinates).
const editableFromNormalized = (spec) => ({
  ...spec,
  lines: (spec.lines || []).map((l) => ({ ...l, services: (l.services || []).map((s) => ({ ...s, calendar: s.calendar ?? s.calendar_id })) })),
});

export default function NetworkStudio({ project = null, step = 1, tab: routeTab = null, onTab = null, onStep = () => {}, onUpdateProject = null, onOpenBuilt = () => {}, onOpenFeed = null, onFacts = null }) {
  const { t, language } = useLanguage();
  const theme = useTheme();
  const isMobile = useMediaQuery(theme.breakpoints.down("md"));
  // On a desktop screen the workbench fills the step's height and its panes scroll (StepFrame's fill layout).
  const fill = useFillLayout();
  // In the studio's frame (its bar holds the step's actions) the workbench runs edge to edge.
  const inStudio = Boolean(useStepActionsSlot());
  const { features } = useFeatures();
  const chatEnabled = Boolean(features?.chat?.enabled);
  // The assistant's lock from the server's access object (D30): said next to the assistant, never a snackbar.
  const { studioLock, me } = useAccount();

  const [spec, setSpec] = useState(EMPTY_SPEC);
  const [validation, setValidation] = useState(null); // { ok, spec, issues, blockers, estimate, plan }
  const [geometry, setGeometry] = useState([]);
  const [geometryStale, setGeometryStale] = useState(false);
  const [routing, setRouting] = useState(false);
  const [turns, setTurns] = useState([]);
  const [streaming, setStreaming] = useState(false);
  const [pendingTool, setPendingTool] = useState(null);
  // The workbench's tab: the route's when there is one (/p/:id/1/lignes), else the last one chosen.
  const [ownTab, setOwnTab] = useState("map");
  const tab = (routeTab && SLUG_TAB[routeTab]) || ownTab;
  // On a desktop screen, the tool whose panel is open beside the map: the person's choice at this step ({ step, key },
  // key null: the panel folded), else the route's, else the step's own (① the starting point, ③ the assistant or the
  // work by hand).
  const [toolChoice, setToolChoice] = useState(null);
  const routeTool = (routeTab && TOOL_OF_TAB[SLUG_TAB[routeTab]]) || null;
  const tool = toolChoice && toolChoice.step === step ? toolChoice.key : routeTool || (step === 3 ? "assistant" : "start");
  const setTab = useCallback(
    (next) => {
      setOwnTab(next);
      onTab?.(TAB_SLUG[next] || null);
      if (TOOL_OF_TAB[next]) setToolChoice({ step, key: TOOL_OF_TAB[next] });
    },
    [onTab, step],
  );
  const [selectedStopId, setSelectedStopId] = useState(null);
  const [placingStopId, setPlacingStopId] = useState(null);
  const [issuesOpen, setIssuesOpen] = useState(false);
  const [issuesFolded, setIssuesFolded] = useState(false); // the inspector's list of points to check (desktop)
  const [compile, setCompile] = useState({ state: "idle" });
  const [fitEpoch, setFitEpoch] = useState(0);
  const [restored, setRestored] = useState(false);
  const [shared, setShared] = useState(false);
  const [territory, setTerritory] = useState(null);
  const [layers, setLayers] = useState({ stops: true, pois: true, population: true, works: true });
  const [documents, setDocuments] = useState([]); // specification documents: { id, name, kind, pages, size, status: uploading|ready|error|expired }
  const [coverage, setCoverage] = useState(null);
  const [requirements, setRequirements] = useState(null);
  const [quality, setQuality] = useState(null);
  const [prefilled, setPrefilled] = useState([]); // settings filled from the territory
  const [addingStops, setAddingStops] = useState(false); // click the map to add stops
  const [needs, setNeeds] = useState(null); // what the system still needs from the user
  const [levers, setLevers] = useState(null); // what the service choices cost
  const [needsOpen, setNeedsOpen] = useState(false);
  // The network's settings: folded or not (kept across the tabs), and a request to open them on what is left to fill.
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [settingsSignal, setSettingsSignal] = useState(0);
  // A sub-task of ③'s sidebar takes the focus where it is done, by ref (§11), once that place is rendered:
  // the points to fix (network-issues-toggle, shown once a validation is back), the stops list, the lines editor.
  const issuesToggleRef = useRef(null);
  const stopsPaneRef = useRef(null);
  const linesPaneRef = useRef(null);
  const pendingFocus = useRef(null);
  const [focusSignal, setFocusSignal] = useState(0);
  const needsTimer = useRef(null);
  const [corridors, setCorridors] = useState([]);
  const [expert, setExpert] = useState(() => readFlag(EXPERT_KEY)); // raw JSON and technical paths
  const [optionsAnchor, setOptionsAnchor] = useState(null);
  const [confirm, setConfirm] = useState(null); // "reset" | "scenario": an act that loses work asks first, in place
  const [pendingScenario, setPendingScenario] = useState(null); // the scenario to take as the plan, once confirmed
  // The user's own demand data (counts, OD surveys, places): the planner's estimates are calibrated on it.
  const [demandData, setDemandData] = useState([]); // [{ key, id?, name, kind?, rows?, status: uploading|ready|error, error? }]
  const [baselineGuard, setBaselineGuard] = useState(null); // { losses }: the server refused to build a simplified baseline
  // The named acknowledgement of a build (scope compile, ⑤ section 1): { items, value, highlight, refusal, nameInvalid } —
  // from the planner's readiness before any request, or a 409 CLAUSES_FAILING / CLAUSES_UNKNOWN; the same AcknowledgementForm
  // as the Change Studio's "Apply".
  const [ackGuard, setAckGuard] = useState(null);
  const ackFormRef = useRef(null);
  const [openingReal, setOpeningReal] = useState(null); // "open" while the real network opens
  const [openRealError, setOpenRealError] = useState(null);
  // The planner's verdict on its last turn: clean (nothing major left) and the reasons why not.
  const [readiness, setReadiness] = useState({ clean: false, reasons: [] });
  const [refining, setRefining] = useState(false);
  const [notice, setNotice] = useState(null);
  const coverageTimer = useRef(null);
  const qualityTimer = useRef(null);
  const abortRef = useRef(null);
  const validateTimer = useRef(null);
  // What the checks (④) judged and what was built (⑤): the design's key at that moment (designKeyOf).
  const [checkedKey, setCheckedKey] = useState(null);
  const [dryRun, setDryRun] = useState({ state: "idle" }); // the build checked without being built: idle | running | done | error
  const [builtLost, setBuiltLost] = useState(null); // the built network's session the coherence report found gone (read from the design instead)
  const coherenceDownloads = useCoherenceDownloads();
  const [download, setDownload] = useState({ state: "idle" }); // the built network's zip: idle | running | error
  // network-build (D45): go to ⑤, and build there once the checks ran and nothing is left to accept.
  const buildIntentRef = useRef(false);
  const draftKey = draftKeyOf(project?.id || null);
  // The project's contract (mission step 3): nothing is designed by the assistant before it is decided, assumed or
  // recorded empty; it travels with every turn and every measure (the server merges it: a decided clause is the person's).
  const firstBrief = (turns.find((x) => x.role === "user") || {}).content || "";
  const readyDocumentIds = documents.filter((d) => d.status === "ready" && d.id).map((d) => d.id);
  const contractState = useContract({ project, onUpdateProject, job: "create", active: step === 2, documents: readyDocumentIds });
  const contract = contractState.contract;
  // The brief typed at ② is the contract's (contract.brief: kept with the project, read by the server on every
  // measure); until something is typed there, the field shows the brief the extraction read, or the first message.
  const contractBrief = typeof contract.brief === "string" ? contract.brief : contract.extracted?.note || firstBrief || "";
  // What a measure sends of the contract: the contract once ready — an empty one too, so the verdict says how many
  // requirement sentences no clause answers (D15) — with the documents; a draft measures nothing yet.
  const contractDocumentsKey = JSON.stringify([...new Set([...readyDocumentIds, ...contractState.documentIds])]);
  const contractDocuments = useMemo(() => JSON.parse(contractDocumentsKey), [contractDocumentsKey]);
  const contractArgsKey = contractReady(contract) ? JSON.stringify({ contract, documents: contractDocuments }) : "{}";
  const contractArgs = useMemo(() => JSON.parse(contractArgsKey), [contractArgsKey]);
  // The design frozen by a build (D37): the project's active scenario says "built in vN".
  const projectScenario = activeScenarioOf(project);
  const frozenVersion = projectScenario?.applied_version_id ? (project?.versions || []).find((v) => v.id === projectScenario.applied_version_id) || null : null;
  const frozen = Boolean(frozenVersion);
  const frozenRef = useRef(frozen);
  frozenRef.current = frozen;
  // Whether the assistant may read what is attached now (set once canPlan is known, below): a document
  // attached without it is kept for the project only, never sent to the model provider later (① says so).
  const canPlanRef = useRef(false);
  // The build's report read back from the server when the build's answer is gone (a visit of the explorer, a
  // reload): { id, report } once read, { id, missing: true } when the server no longer holds it.
  const [storedReport, setStoredReport] = useState(null);
  const briefControl = useRef(null); // PlanChat's focus and file picker
  const territoryInput = useRef(null);

  const projectRef = useRef(project);
  projectRef.current = project;
  // Draft persistence: the plan survives a reload — and, with nothing kept in this browser, the project's design.
  useEffect(() => {
    if (restored) return;
    const draft = loadDraft(draftKey);
    if (draft && draft.spec) {
      setSpec(draft.spec);
      setTurns(Array.isArray(draft.turns) ? draft.turns.filter((x) => x.status !== "streaming") : []);
      setGeometryStale(true);
    } else if (designOf(activeScenarioOf(projectRef.current)?.design)) {
      // Another device, another browser, a cleared cache: the design the server keeps with the project.
      setSpec(activeScenarioOf(projectRef.current).design);
      setGeometryStale(true);
    }
    if (draft && draft.territory) setTerritory(draft.territory);
    if (draft && draft.requirements) setRequirements(draft.requirements);
    if (draft && Array.isArray(draft.documents)) setDocuments(draft.documents.filter((d) => d && d.id && d.status === "ready"));
    setRestored(true);
  }, [restored, draftKey]);
  useEffect(() => {
    if (!restored) return;
    const readyDocs = documents.filter((d) => d.status === "ready");
    const hasContent = (spec.lines || []).length > 0 || (spec.stops || []).length > 0 || turns.length > 0 || territory || readyDocs.length > 0;
    saveDraft(hasContent ? { spec, turns: turns.slice(-12).map((x) => ({ ...x, quality: undefined })), requirements, documents: readyDocs, territory: territory ? { ...territory, existing_stops: territory.existing_stops.slice(0, 300), pois: { ...territory.pois, items: territory.pois.items.slice(0, 200) }, population_grid: territory.population_grid ? { ...territory.population_grid, cells: territory.population_grid.cells.slice(0, 600) } : null } : null } : null, draftKey);
  }, [spec, turns, restored, territory, requirements, documents, draftKey]);

  // The design into the project, which the server keeps (§2.4 scenarios[active].design): never over a frozen one
  // (its design is the record of vN), never before this browser's draft or the project's design was read. A write
  // still waiting when the studio closes is made at once, never dropped.
  const closing = useRef(false);
  useEffect(() => {
    closing.current = false;
    // Declared before the write below: on unmount this runs first, so the write's cleanup knows the studio closes.
    return () => {
      closing.current = true;
    };
  }, []);
  useEffect(() => {
    if (!restored || !projectRef.current || !onUpdateProject || frozenRef.current) return undefined;
    const own = activeScenarioOf(projectRef.current);
    if (!own || own.applied_version_id) return undefined;
    const next = designOf(spec);
    if (JSON.stringify(own.design ?? null) === JSON.stringify(next)) return undefined;
    const write = () =>
      onUpdateProject((p) => {
        const active = activeScenarioOf(p);
        if (!active || active.applied_version_id || JSON.stringify(active.design ?? null) === JSON.stringify(next)) return p;
        return withScenario(p, { design: next });
      });
    const timer = setTimeout(write, PROJECT_DESIGN_MS);
    return () => {
      clearTimeout(timer);
      if (closing.current) write();
    };
    // The project is read through its ref: only a new design is a write.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [spec, restored]);

  // Specification documents: uploaded once, referenced by id in every planner turn.
  const attachDocuments = useCallback(
    (files) => {
      const room = Math.max(0, MAX_DOCUMENTS - documents.filter((d) => d.status !== "error").length);
      if (!room) {
        setNotice(t("network.docs.max", { max: MAX_DOCUMENTS }));
        return;
      }
      for (const file of files.slice(0, room)) {
        const tempId = `tmp-${newId()}`;
        setDocuments((prev) => [...prev, { tempId, name: file.name, size: file.size, status: "uploading" }]);
        uploadBriefDocument(file, { sentToAssistant: canPlanRef.current })
          .then((d) => {
            setDocuments((prev) => prev.map((x) => (x.tempId === tempId ? { ...d, status: "ready" } : x)));
            // Kept with the project (① lists it; the server keeps it as long as the project, WP7).
            announceDocument("added", d);
          })
          .catch((err) => {
            const message = err.code === "DOCUMENT_TOO_LARGE" ? t("network.docs.tooLarge") : err.code === "DOCUMENT_TOO_LONG" ? err.message : err.code === "UNSUPPORTED_DOCUMENT" ? t("network.docs.unsupported") : humanError(err, t).message;
            setDocuments((prev) => prev.map((x) => (x.tempId === tempId ? { ...x, status: "error", error: message } : x)));
          });
      }
    },
    [documents, t],
  );
  const removeDocument = useCallback((doc) => {
    setDocuments((prev) => prev.filter((x) => (doc.id ? x.id !== doc.id : x.tempId !== doc.tempId)));
    if (doc.id) deleteBriefDocument(doc.id);
    announceDocument("removed", doc);
  }, []);

  // The option is remembered only once the user changes it.
  const chooseExpert = (on) => {
    setExpert(on);
    writeFlag(EXPERT_KEY, on);
  };
  // The raw JSON is an expert's tool: leaving expert mode leaves its tab.
  useEffect(() => {
    if (!expert && tab === "json") setTab("map");
  }, [expert, tab, setTab]);

  // A territory fills the network's empty settings (timezone, language, local
  // weekend, holidays): a network built by hand needs no JSON. Never overwrites.
  const territoryKey = territory?.place?.query || null;
  useEffect(() => {
    if (!territory || frozenRef.current) return;
    setSpec((prev) => {
      const r = prefillFromTerritory(prev, territory);
      if (r.filled.length) setPrefilled(r.filled);
      return r.spec;
    });
  }, [territoryKey]); // eslint-disable-line react-hooks/exhaustive-deps

  // What the system still needs from the user, and the levers' figures (debounced).
  useEffect(() => {
    if (streaming) return undefined;
    clearTimeout(needsTimer.current);
    needsTimer.current = setTimeout(() => {
      // The routed geometry rides along: the levers cost the plan like the footer does.
      const routed = routedForServer(geometry);
      fetchNeeds(spec, { requirements, place: territory?.place?.query || null, quality, geometry: routed })
        .then((r) => {
          setNeeds({ needs: r.needs || [], counts: r.counts || {} });
          setLevers(r.levers || null);
        })
        .catch(() => {});
    }, 900);
    return () => clearTimeout(needsTimer.current);
  }, [streaming, spec, requirements, territory, quality, geometry]);

  // Coverage of the plan against the territory (debounced, after validation).
  useEffect(() => {
    if (!territory || !validation || !(validation.spec?.lines || []).length) {
      setCoverage(null);
      return undefined;
    }
    clearTimeout(coverageTimer.current);
    coverageTimer.current = setTimeout(() => {
      fetchCoverage(spec, territory.place.query)
        .then(setCoverage)
        .catch(() => {});
    }, 500);
    return () => clearTimeout(coverageTimer.current);
  }, [validation, territory, spec]);

  // Design quality of the plan (debounced; the planner emits its own while it runs).
  useEffect(() => {
    if (streaming || !validation || !(validation.spec?.lines || []).length) return undefined;
    clearTimeout(qualityTimer.current);
    qualityTimer.current = setTimeout(() => {
      // The brief rides along: every manual edit is measured against what was asked.
      evaluateSpec(spec, territory?.place?.query || null, routedForServer(geometry), requirements, contractArgs)
        .then((q) => setQuality(q))
        .catch(() => {});
    }, 700);
    return () => clearTimeout(qualityTimer.current);
    // The contract's key: a decision at ② re-measures the design.
  }, [validation, territory, spec, geometry, streaming, requirements, contractArgs]);
  useEffect(() => {
    if (!(spec.lines || []).length) setQuality(null);
  }, [spec.lines]);

  // Live validation (debounced) on every change.
  useEffect(() => {
    const empty = !(spec.lines || []).length && !(spec.stops || []).length && !spec.agency?.name;
    if (empty) {
      setValidation(null);
      return undefined;
    }
    clearTimeout(validateTimer.current);
    validateTimer.current = setTimeout(() => {
      validateSpec(spec, territory?.place?.query || null)
        .then(setValidation)
        .catch(() => {});
    }, 350);
    return () => clearTimeout(validateTimer.current);
  }, [spec, territory]);

  const refreshRoutes = useCallback(async () => {
    if (routing) return;
    setRouting(true);
    try {
      const r = await estimateSpec(spec);
      setGeometry(geometryFromEstimate(r));
      setGeometryStale(false);
      setFitEpoch((e) => e + 1);
    } catch {
      /* keep the previous geometry */
    } finally {
      setRouting(false);
    }
  }, [spec, routing]);

  // Route automatically once every stop has coordinates and the plan changed.
  useEffect(() => {
    if (!validation || !geometryStale || routing) return undefined;
    if (validation.estimate?.stops_without_coordinates > 0 || !(validation.spec?.lines || []).length) return undefined;
    const id = setTimeout(refreshRoutes, 600);
    return () => clearTimeout(id);
  }, [validation, geometryStale, routing, refreshRoutes]);

  // A click on the map in "add stops" mode: the stop takes the name and the
  // exact place of an existing stop or a named place within 40 m, else a new name.
  const addStopAt = useCallback(
    (lat, lon) => {
      const near = (p) => Number.isFinite(p?.lat) && Math.abs(p.lat - lat) < 0.001 && Math.abs(p.lon - lon) < 0.0015 && haversineM(lat, lon, p.lat, p.lon) <= 40;
      const existing = (territory?.existing_stops || []).find((s) => s.name && near(s));
      const poi = existing ? null : (territory?.pois?.items || []).find((p) => p.name && near(p));
      const stops = spec.stops || [];
      if (existing && stops.some((s) => s.id === existing.id)) return;
      const stop = existing ? { id: existing.id, name: existing.name, lat: existing.lat, lon: existing.lon, source: "osm" } : { name: poi ? poi.name : t("network.newStop", { n: stops.length + 1 }), lat: poi ? poi.lat : lat, lon: poi ? poi.lon : lon };
      const [added] = withStopIds(stops, [stop]);
      updateSpec({ ...spec, stops: [...stops, added] });
      setSelectedStopId(added.id);
    },
    [spec, territory, t], // eslint-disable-line react-hooks/exhaustive-deps
  );

  const updateSpec = useCallback((next) => {
    // A frozen design is read, never changed: "Nouveau scénario sur vN" first.
    if (frozenRef.current) return;
    setSpec(next);
    setGeometryStale(true);
    // The planner's verdict described its own plan, not the user's edit.
    setReadiness({ clean: false, reasons: [] });
  }, []);

  // A scenario the planner generated becomes the plan (the current one is replaced: asked first).
  const takeScenario = useCallback((sc) => updateSpec(editableFromNormalized(sc.spec)), [updateSpec]);
  const attachDemandData = useCallback(async (files) => {
    for (const file of Array.from(files || []).slice(0, 5)) {
      const key = `${file.name}-${file.size}-${file.lastModified}`;
      setDemandData((ds) => [...ds.filter((x) => x.key !== key), { key, name: file.name, status: "uploading" }]);
      try {
        const d = await uploadDemandData(file);
        setDemandData((ds) => ds.map((x) => (x.key === key ? { ...x, id: d.id, kind: d.kind, rows: d.rows, warnings: d.warnings || [], status: "ready" } : x)));
      } catch (err) {
        setDemandData((ds) => ds.map((x) => (x.key === key ? { ...x, status: "error", error: err.message } : x)));
      }
    }
  }, []);
  const removeDemandData = useCallback((d) => {
    if (d.id) deleteDemandData(d.id);
    setDemandData((ds) => ds.filter((x) => x.key !== d.key));
  }, []);
  const adoptScenario = useCallback(
    (sc) => {
      if (!sc?.spec) return;
      if ((spec.lines || []).length) {
        setPendingScenario(sc);
        setConfirm("scenario");
      } else takeScenario(sc);
    },
    [spec, takeScenario],
  );

  // A territory analysed: the map goes there, and a project still named by default takes its name (« Nouveau réseau —
  // Vendôme »); a name the person typed stays theirs.
  const onTerritory = (d) => {
    setTerritory(d);
    setFitEpoch((e) => e + 1);
    const place = d?.place?.name;
    const named = String(project?.name ?? "").trim();
    if (place && onUpdateProject && (!named || named === t("step.defaultName.create"))) onUpdateProject({ name: t("step.defaultName.createPlace", { place }) });
  };

  const useExistingStops = useCallback(
    (d) => {
      // The named existing stops become plan stops (capped; the planner can add more).
      const have = new Set((spec.stops || []).map((s) => s.id));
      const named = d.existing_stops.filter((s) => s.name && !have.has(s.id));
      const candidates = named.slice(0, 80).map((s) => ({ id: s.id, name: s.name, lat: s.lat, lon: s.lon, source: "osm" }));
      if (!candidates.length) return;
      updateSpec({ ...spec, stops: [...(spec.stops || []), ...candidates] });
      setTab("stops");
      setFitEpoch((e) => e + 1);
      // Said, never silent: how many came in, and that the others stay offered in a line's « Ajouter un arrêt ».
      setNotice(t(named.length > candidates.length ? "territory.usedStopsCapped" : "territory.usedStops", { count: candidates.length, total: named.length }));
    },
    [spec, updateSpec, setTab, t],
  );

  const near = useMemo(() => centroid(spec.stops) || (territory ? { lat: territory.place.lat, lon: territory.place.lon } : null), [spec.stops, territory]);

  // ── Planner turn ─────────────────────────────────────────────────────────
  const runPlan = useCallback(
    async (message, { answersFor = null, extract = false } = {}) => {
      if (streaming) return;
      const userTurn = { id: newId(), role: "user", content: message };
      const assistantTurn = { id: newId(), role: "assistant", content: "", steps: [], questions: [], status: "streaming" };
      setTurns((prev) => [...prev.map((x) => (answersFor && x.id === answersFor ? { ...x, answered: true } : x)), userTurn, assistantTurn]);
      setStreaming(true);
      setPendingTool(null);
      const abort = new AbortController();
      abortRef.current = abort;
      const patch = (fn) => setTurns((prev) => prev.map((x) => (x.id === assistantTurn.id ? { ...x, ...fn(x) } : x)));
      const history = turns.filter((x) => x.content).map((x) => ({ role: x.role, content: x.content }));
      const hasSpec = (spec.lines || []).length > 0;
      setReadiness({ clean: false, reasons: [] });
      setCorridors([]);
      try {
        await streamPlan({
          brief: message,
          spec: hasSpec ? spec : null,
          messages: history,
          language,
          near,
          territory: territory ? { place: territory.place.query } : null,
          documents: documents.filter((d) => d.status === "ready").map((d) => d.id),
          dataIds: demandData.filter((d) => d.status === "ready" && d.id).map((d) => d.id),
          requirements,
          // A draft (or « Extraire » at ②) makes this turn the extraction: the server designs nothing then.
          contract: extract ? { ...contract, status: "draft" } : contract,
          signal: abort.signal,
          onEvent: (event, data) => {
            switch (event) {
              // The extraction's answer: the draft contract ② decides (the person's decisions kept), nothing designed.
              case "contract":
                if (data?.contract) contractState.fromExtraction(data.contract);
                patch(() => ({ extracted: { clauses: (data?.contract?.clauses || []).length, wishes: (data?.contract?.wishes || []).length, uncovered: (data?.coverage?.uncovered || []).length } }));
                break;
              case "meta":
                // A free-trial turn runs on a lighter model: its plan is indicative.
                if (data?.trial) patch(() => ({ trial: true }));
                break;
              // What the demand tools found: estimates, the optimiser's changes, contrasted scenarios.
              case "demand":
                patch(() => ({ demand: { estimate: data.estimate || null, kpis: data.kpis || null } }));
                break;
              case "optimization":
                patch(() => ({ optimization: { objective: data.objective, changes: data.changes || [], before: data.kpis_before || null, after: data.kpis_after || null } }));
                break;
              case "scenarios":
                patch(() => ({ scenarios: { list: data.scenarios || [], rows: data.comparison?.rows || [], warnings: data.warnings || [] } }));
                break;
              case "requirements":
                setRequirements(data);
                patch(() => ({ requirements: data }));
                break;
              case "corridors":
                setCorridors(data.corridors || []);
                break;
              case "feeds":
                break;
              case "handoff":
                // A request to modify a running network: the card opens the real feed with the brief.
                patch(() => ({ handoff: data }));
                break;
              case "quality":
                setQuality(data);
                patch(() => ({ quality: data }));
                break;
              // The engine's verdict on this turn, as emitted ({ verdict, readiness, prose }): the turn opens with it.
              case "verdict":
                patch(() => ({ verdict: data }));
                break;
              case "token":
                patch((x) => ({ content: x.content + (data.text || "") }));
                break;
              // The engine refused what the turn proposed (llm/selfCorrection): the words streamed so far are superseded
              // (kept, muted, under their own label) and the turn says the correction; escalated, the engine's own
              // questions follow in a `questions` event. The verdict's prose spans judge only the text after it.
              case "correction":
                patch((x) => ({
                  superseded: data?.phase === "retry" && x.content ? [...(x.superseded || []), x.content] : x.superseded || [],
                  content: data?.phase === "retry" ? "" : x.content,
                  steps: [...x.steps, { kind: data?.phase === "escalated" ? "correctionEscalated" : "correction", attempt: data?.attempt ?? 0, max: data?.max ?? 0, reasons: (data?.reasons || []).length }],
                }));
                break;
              case "tool_pending":
                setPendingTool(data.name || null);
                break;
              // The model's answer was cut in its stream and is sent again (llm/streamRound): the words so far were not
              // the answer, the chip says the new attempt.
              case "retry":
                setPendingTool(null);
                patch((x) => ({ content: "", steps: [...x.steps, { kind: "retry", attempt: data?.attempt ?? 1, max: data?.max ?? 0 }] }));
                break;
              // The turn's budget is spent (llm/turnBudget): the model closes with what it has, the turn ends incomplete.
              case "budget":
                patch((x) => ({ steps: [...x.steps, { kind: "budget" }] }));
                break;
              case "step":
                patch((x) => ({ steps: [...x.steps, data] }));
                // Documents the server no longer holds (two hours): the user re-attaches them.
                if (data.kind === "documents" && data.missing?.length) setDocuments((prev) => prev.map((d) => (data.missing.includes(d.id) ? { ...d, status: "expired" } : d)));
                break;
              case "spec":
                setSpec(editableFromNormalized(data.spec));
                setValidation({ ok: data.ok, spec: data.spec, issues: data.issues, blockers: data.blockers, estimate: data.estimate, plan: validation?.plan || null });
                setGeometryStale(true);
                patch((x) => ({ steps: [...x.steps, { kind: "spec", ok: data.ok, blockers: (data.blockers || []).length }] }));
                break;
              case "geometry": {
                setGeometry(geometryFromEstimate(data));
                setGeometryStale(false);
                setFitEpoch((e) => e + 1);
                patch((x) => ({ steps: [...x.steps, { kind: "geometry" }] }));
                break;
              }
              case "questions":
                patch(() => ({ questions: data.questions || [] }));
                break;
              case "territory":
                setTerritory(data);
                setFitEpoch((e) => e + 1);
                patch((x) => ({ steps: [...x.steps, { kind: "territory", place: data.place?.name }] }));
                break;
              case "coverage":
                setCoverage(data);
                break;
              case "levers":
                setLevers(data);
                break;
              case "error":
                patch(() => ({ error: { code: data.code || null, status: data.status || null, message: data.message || "", retryAfterSec: data.retryAfterSec || null }, status: "error" }));
                break;
              case "done":
                patch((x) => ({ status: x.status === "error" ? "error" : "complete", ...(data.reason === "empty" && !x.error ? { error: { plain: true, message: t("network.plan.empty") } } : {}) }));
                // `acknowledgeable` / `ready_once_acknowledged`: what a named person may accept to build, and whether nothing else holds it.
                setReadiness({ clean: Boolean(data.clean), reasons: data.not_ready_reasons || [], acknowledgeable: data.acknowledgeable || [], onceAcknowledged: Boolean(data.ready_once_acknowledged) });
                // The record of the brief after this turn (clauses merged, the user's decisions kept).
                if (data.requirements) setRequirements(data.requirements);
                if (data.needs) setNeeds(data.needs);
                // A turn the engine's refusals sent back and that settled them: said once, with how many checks it took.
                if (data.corrections?.resolved && data.corrections.attempts > 0) patch((x) => ({ steps: [...x.steps, { kind: "correctionResolved", attempts: data.corrections.attempts }] }));
                // Nothing is built unasked: a ready plan is said by the rail and the verdict, the build is ⑤'s.
                break;
              default:
            }
          },
        });
      } catch (err) {
        patch(() => (err.code === "ABORTED" ? { status: "stopped", stopped: true } : { status: "error", error: { code: err.code || null, status: err.status || null, message: err.message || "", retryAfterSec: err.retryAfterSec || null } }));
      } finally {
        abortRef.current = null;
        setStreaming(false);
        setPendingTool(null);
      }
    },
    [streaming, turns, spec, language, near, territory, requirements, documents, demandData, t, validation, contract, contractState],
  );

  const stopPlan = useCallback(() => abortRef.current?.abort(), []);

  // ── Build (⑤) ─────────────────────────────────────────────────────────────
  // The build creates a version of the project (v1, v2…); it closes nothing
  // and opens nothing: "Voir le réseau" opens the built network afterwards.
  // `acknowledge`: the user chose to build a simplified baseline anyway, as a study.
  // `ack`: the named acknowledgement of the must clauses the build does not meet ({ by: { name }, clauses, note? }).
  const designKey = useMemo(() => designKeyOf(spec, requirements), [spec, requirements]);
  const contractStatus = contract.status || "draft";
  // The report calls a clause decided only once ② is: the contract's own clauses then, none for a draft or an empty one.
  const coherenceClauses = useMemo(() => contractClauses(project?.contract), [project?.contract]);
  const coherenceClausesKey = JSON.stringify(coherenceClauses);
  // The contract a build is measured against (the owner's rule of 2026-10-05, the server's 409 CONTRACT_REQUIRED):
  // decided, assumed, or recorded empty under a person's name — never an unnamed one. A draft without any clause is
  // recorded empty under the name the person gives at the build (the acknowledgement form's, else ②'s, else the
  // one this browser keeps); a draft holding clauses is decided at ② first. → the compile's contract args, or null.
  const contractForBuild = useCallback(
    (ack, recorder = null) => {
      if (contractReady(contract)) return { contract, documents: contractDocuments };
      if ((contract.clauses || []).length) return null;
      const who = [ack?.by?.name, recorder, contractState.name, rememberedName(), me?.display_name].find((n) => nameOk(n));
      const recorded = who ? contractState.recordEmpty(who) : null;
      return recorded ? { contract: recorded, documents: contractDocuments } : null;
    },
    [contract, contractDocuments, contractState, me],
  );
  const build = useCallback(
    async ({ acknowledge = false, ack = null, recorder = null } = {}) => {
      if (compile.state === "running") return;
      const key = designKey;
      const contractBuildArgs = contractForBuild(ack, recorder);
      if (!contractBuildArgs && !(contract.clauses || []).length) {
        // No contract and nobody named yet: section 1 asks, in place, who records it empty — nothing is sent first.
        setCompile({ state: "idle" });
        setAckGuard((g) => ({
          items: mergeItems(g?.items || [], [CONTRACT_EMPTY_ITEM]),
          value: g?.value || { checked: [], name: rememberedName() || me?.display_name || "", note: "" },
          highlight: [CONTRACT_EMPTY_ITEM.key],
          refusal: { code: "CONTRACT_REQUIRED", status: 409, message: "", details: { reason: "unnamed" } },
          nameInvalid: false,
        }));
        setTimeout(() => ackFormRef.current?.focusItems([CONTRACT_EMPTY_ITEM.key]), 0);
        return;
      }
      if (!contractBuildArgs) {
        // Clauses nobody decided: ② decides them (« Ouvrir le contrat »); nothing is sent the server would refuse.
        setCompile({ state: "error", code: "CONTRACT_REQUIRED", error: { code: "CONTRACT_REQUIRED", status: 409, message: "", details: { reason: "draft" } } });
        return;
      }
      setCompile({ state: "running" });
      setDownload({ state: "idle" });
      try {
        const compiled = await compileSpec(spec, { shapes: true, place: territory?.place?.query || null, requirements }, { acknowledgeSimplification: acknowledge, acknowledge: ack, ...contractBuildArgs });
        if (ack || recorder) rememberName(ack?.by?.name || recorder);
        setAckGuard(null);
        const report = creditAnsweredSources(compiled.report, territory);
        const result = report === compiled.report ? compiled : { ...compiled, report };
        rememberBuild(result.buildId, result.sessionId);
        // The network the reports were read on is now another one.
        forgetCoherence();
        setCompile({ state: "done", result, key });
        setCheckedKey(key);
        // A version of the project: who built it, the engine's verdict, the validator's answer, the acknowledgement.
        const gate = result.report?.gate || {};
        onUpdateProject?.((p) => ({
          ...withVersion(withScenario(p, { design: spec, verdict: gate.conformance || null, validation: gate.validation || null }), { kind: "built", by: gate.acknowledgement?.by?.name || ack?.by?.name || null, verdict: gate.conformance || null, validation: gate.validation || null, acknowledgement: gate.acknowledgement || null, build_id: result.buildId || null, counts: result.counts || null, data_version: key }),
          network: { ...(p.network || {}), name: spec.agency?.name || p.name || "", source: "designed", validity: spec.feed ? { from: spec.feed.start_date || null, to: spec.feed.end_date || null } : null },
        }));
      } catch (err) {
        if (err.code === "SIMPLIFIED_BASELINE") {
          // Not the real network: say what it lacks, offer the real one or a study build.
          setCompile({ state: "idle" });
          setOpenRealError(null);
          setBaselineGuard({ losses: err.body?.losses || spec.origin?.losses || null });
          return;
        }
        if (err.code === "CLAUSES_FAILING" || err.code === "CLAUSES_UNKNOWN" || err.code === "ASSUMPTIONS_UNVALIDATED" || (err.code === "ACKNOWLEDGEMENT_UNNAMED" && ack)) {
          // Not met, not measurable, or a contract assumed rather than decided: a named person accepts it, here, before the build (G4).
          const refusal = refusalOf(err);
          const keys = err.code === "ACKNOWLEDGEMENT_UNNAMED" ? [] : missingKeys(err.code, refusal.details);
          setCompile({ state: "idle" });
          setAckGuard((g) => ({
            items: mergeItems(g?.items || [], itemsFromRefusal(err.code, refusal.details)),
            value: g?.value ? { ...g.value, checked: g.value.checked.filter((k) => !keys.includes(k)) } : { checked: [], name: rememberedName() || me?.display_name || "", note: "" },
            highlight: keys,
            refusal,
            nameInvalid: err.code === "ACKNOWLEDGEMENT_UNNAMED",
          }));
          return;
        }
        if (err.code === "SPEC_INVALID") setIssuesOpen(true);
        setCompile({ state: "error", error: err, code: err.code, issues: err.body?.issues || null });
      }
    },
    [compile.state, spec, territory, requirements, me, designKey, onUpdateProject, contract, contractForBuild],
  );
  // The refusal's focus: the name (400), else the first clause still to accept (409).
  useEffect(() => {
    if (!ackGuard?.refusal) return;
    setTimeout(() => (ackGuard.nameInvalid ? ackFormRef.current?.focusName() : ackFormRef.current?.focusItems(ackGuard.highlight)), 0);
  }, [ackGuard?.refusal]); // eslint-disable-line react-hooks/exhaustive-deps
  // A plan held only by must clauses (not met, not measurable): the form, before any request — the clauses the
  // planner's readiness names are the ones the compile gate will ask for. Returns whether there was anything to accept.
  const reviewAcknowledgement = useCallback(() => {
    const clauses = (readiness.acknowledgeable || []).map((r) => r.clause).filter(Boolean);
    const items = itemsFromRefusal("CLAUSES_FAILING", { clauses });
    if (!items.length) return false;
    setAckGuard((g) => g || { items, value: { checked: [], name: rememberedName() || me?.display_name || "", note: "" }, highlight: [], refusal: null, nameInvalid: false });
    setTimeout(() => ackFormRef.current?.focusItems([]), 0);
    return true;
  }, [readiness.acknowledgeable, me]);
  // "Build under my name": nothing is accepted anonymously — the server's rule, said before sending. The empty
  // contract ticked here is recorded under the same name; it is the project's, never an item the server accepts.
  const buildAcknowledged = () => {
    if (!ackGuard) return build();
    const recordsEmpty = (ackGuard.value?.checked || []).includes(CONTRACT_EMPTY_ITEM.key);
    const body = bodyOf(ackGuard.items.filter((i) => i.kind !== CONTRACT_EMPTY_ITEM.kind), ackGuard.value);
    const name = body ? body.by.name : recordsEmpty ? String(ackGuard.value?.name || "").trim() : null;
    if (name != null && !NAME_OK(name)) {
      setAckGuard((g) => ({ ...g, refusal: { code: "ACKNOWLEDGEMENT_UNNAMED", status: 400, message: "", details: { required: ["by.name"] } }, nameInvalid: true }));
      return undefined;
    }
    return build({ ack: body, recorder: recordsEmpty ? name : null });
  };

  const refineStops = useCallback(async () => {
    if (!territory || refining) return;
    setRefining(true);
    try {
      const r = await refineSpec(spec, territory.place.query);
      if (r.changes?.length) {
        updateSpec(editableFromNormalized(r.spec));
        setNotice(t("network.refineDone", { snapped: r.snapped, inserted: r.inserted }));
        setFitEpoch((e) => e + 1);
      } else setNotice(t("network.refineNone"));
    } catch (err) {
      setNotice(humanError(err, t).message);
    } finally {
      setRefining(false);
    }
  }, [territory, refining, spec, updateSpec, t]);

  // The existing network, reverse-compiled from a public feed, becomes the plan (its score is the baseline).
  const importedFeed = useCallback(
    (r, feed) => {
      updateSpec(editableFromNormalized(r.spec));
      if (r.report) setQuality(r.report);
      setTab("map");
      setFitEpoch((e) => e + 1);
      setNotice(t("feeds.imported", { lines: r.stats?.lines ?? 0, stops: r.stats?.stops ?? 0, score: r.report?.score ?? "–", provider: feed?.provider || "" }));
    },
    [updateSpec, t, setTab],
  );

  // A published feed opened as it is: the app switches to it and a project that modifies it
  // takes over (its ③) — with the brief handed over by the planner, if any.
  const openedFeed = useCallback(
    (r, feed, brief = null) => {
      onOpenFeed?.({ ...r, openedFeed: { name: feed?.name || feed?.provider || "" }, ...(brief ? { brief } : {}) });
    },
    [onOpenFeed],
  );

  // The plan came from a simplified import: open the real network it was taken from.
  const openRealNetwork = useCallback(async () => {
    const origin = spec.origin;
    if (!origin?.url || openingReal) return;
    setOpeningReal("open");
    setOpenRealError(null);
    try {
      const r = await openCatalogFeed(origin.url, { name: origin.name || null, place: territory?.place?.query || null });
      setBaselineGuard(null);
      openedFeed(r, { name: origin.name || "" });
    } catch (err) {
      setOpenRealError(err);
    } finally {
      setOpeningReal(null);
    }
  }, [spec.origin, openingReal, territory, openedFeed]);

  const reset = useCallback(() => {
    abortRef.current?.abort();
    setSpec(EMPTY_SPEC);
    setValidation(null);
    setGeometry([]);
    setTurns([]);
    setCompile({ state: "idle" });
    setSelectedStopId(null);
    setPlacingStopId(null);
    setTerritory(null);
    setCoverage(null);
    setRequirements(null);
    setQuality(null);
    setCorridors([]);
    setBaselineGuard(null);
    setAckGuard(null);
    setCheckedKey(null);
    setDryRun({ state: "idle" });
    setDocuments((prev) => {
      for (const d of prev) if (d.id) deleteBriefDocument(d.id);
      return [];
    });
    saveDraft(null, draftKey);
  }, [draftKey]);


  const issues = validation?.issues || [];
  const blockers = validation?.blockers || [];
  const warnings = issues.filter((i) => i.level === "warning");
  // In the reader's words, the stops no line serves said once (issueText).
  const shownIssues = groupIssues([...blockers, ...warnings], t);
  const shownWarnings = shownIssues.filter((i) => i.level === "warning").length;
  const estimate = validation?.estimate || null;
  const plan = validation?.plan || null;
  const canBuild = Boolean(validation && validation.ok && !plan?.over_limit) && compile.state !== "running";
  // A lock the server states (no Studio access on this account) is said by LockedAction, next to the assistant. The
  // beta access codes are retired (2026-10-08): the server's access alone says whether the assistant answers here (under
  // the paid offer the project page shows the offer in place of a studio its person does not hold).
  const lockShown = Boolean(studioLock && features?.access?.studio === "entitlement_required");
  const canPlan = chatEnabled && !lockShown;
  canPlanRef.current = canPlan;
  const disabledReason = lockShown ? null : !chatEnabled ? t("network.assistantOff") : null;
  // Without the assistant (off, locked, or no message left), ③ is the work by hand (ManualSidebar).
  const manual = !canPlan;
  // ③'s assistant designs nothing before the contract is decided, assumed or recorded empty (M-1, D45: by hand, free).
  const contractLocksAssistant = step === 3 && !contractReady(contract);

  const validationSummary = (report) => {
    // A validator that did not run is not a pass.
    if (!report || report.unverified) return { unverified: true, errors: 0, warnings: 0 };
    const counts = report.counts || {};
    const errors = counts.errors ?? (report.valid === false ? 1 : 0);
    return { errors, warnings: counts.warnings ?? 0 };
  };

  const hasLines = (spec.lines || []).length > 0;
  // Without the assistant, the design is drawn in the lines editor.
  const goManual = () => setTab("lines");
  const openSettings = () => {
    setTab("lines");
    setToolChoice({ step, key: "settings" });
    setSettingsOpen(true);
    setSettingsSignal((n) => n + 1);
  };
  const settingsOpened = useCallback(() => setSettingsSignal(0), []);
  // A sub-task: where it is done, and the focus there (the settings move it themselves: openSignal).
  const goTask = (id) => {
    if (id === "settings") {
      openSettings();
      return;
    }
    if (id === "stops") setTab("stops");
    else if (id === "lines") setTab("lines");
    else setIssuesOpen(true);
    pendingFocus.current = id;
    setFocusSignal((n) => n + 1);
  };
  // The focus moves once the place is rendered: the tab switched, the issues' toggle shown (a validation back).
  const measuredIssues = Boolean(estimate);
  useEffect(() => {
    const id = pendingFocus.current;
    if (!id) return;
    const el = (id === "issues" ? issuesToggleRef : id === "stops" ? stopsPaneRef : linesPaneRef).current;
    if (!el) return;
    pendingFocus.current = null;
    focusEl(el);
  }, [focusSignal, tab, tool, measuredIssues]);
  // What "Start over" would erase, said before it happens.
  const userTurns = turns.filter((x) => x.role === "user").length;
  const eraseItems = [
    hasLines || (spec.stops || []).length ? t("network.reset.plan", { lines: (spec.lines || []).length, stops: (spec.stops || []).length }) : null,
    userTurns ? t("network.reset.conversation", { count: userTurns }) : null,
    documents.length ? t("network.reset.documents", { count: documents.length }) : null,
    territory ? t("network.reset.territory", { place: territory.place?.name || territory.place?.query || "" }) : null,
    (requirements?.clauses || []).length ? t("network.reset.clauses", { count: requirements.clauses.length }) : null,
  ].filter(Boolean);
  const isBaseline = spec.origin?.kind === "simplified_import";
  // A need's action takes the user where it is given (the brief's clauses: the contract, ②).
  const onNeedAction = (n) => {
    setNeedsOpen(false);
    if (n.action === "territory") {
      setTab("map");
      setToolChoice({ step, key: "start" });
      setTimeout(() => focusEl(territoryInput.current), 0);
    } else if (n.action === "settings") openSettings();
    else if (n.action === "map") {
      setTab("map");
      const first = (spec.stops || []).find((s) => !(Number.isFinite(s.lat) && Number.isFinite(s.lon)));
      if (first) setPlacingStopId(first.id);
    } else if (n.action === "plan") window.dispatchEvent(new CustomEvent(PRICING_EVENT, { detail: { reason: "network_limit" } }));
    else if (n.action === "brief") {
      if ((requirements?.clauses || []).length && n.id !== "brief" && n.id !== "questions") onStep(2);
      else briefControl.current?.focusBrief();
    }
  };
  const mapEmpty = !(spec.stops || []).some((s) => Number.isFinite(s.lat));

  // ── The flow: what the steps know, and what they do on arrival ────────────
  const validatorOff = features?.access?.validator === "unavailable";
  const clauses = useMemo(() => requirements?.clauses || [], [requirements]);
  const builtVersion = (project?.versions || []).filter((v) => v.kind === "built").reduce((best, v) => (!best || v.n > best.n ? v : best), null);
  const builtNow = compile.state === "done" ? compile.key === designKey : Boolean(builtVersion && builtVersion.data_version === designKey);
  const nextN = builtNow && builtVersion ? builtVersion.n : project ? nextVersionNumber(project) : 1;
  const buildSeconds = useElapsed(compile.state === "running");
  const checkSeconds = useElapsed(dryRun.state === "running");
  const named = Boolean(String(project?.name ?? "").trim()) || !project;
  const started = hasLines || (spec.stops || []).length > 0 || turns.length > 0 || documents.length > 0 || Boolean(territory);

  // The contract as ② leaves it: decided by a named person (②'s primary action), assumed, or recorded "empty" with no
  // clause (D15). A build records a draft without any clause as "empty" under the name the person gives (never unnamed).
  const contractClausesCount = (contract.clauses || []).length;
  const proceed = proceedState(contract, contractState.name, contractState.coverage);

  // The build checked without being built (④): the canonical validator on a temporary copy, and the engine's verdict.
  // The coherence report it carries cross-checks the contract's clauses only (the brief's other requirements are kept).
  const runDryRun = useCallback(async () => {
    const key = designKey;
    const clausesKey = coherenceClausesKey;
    setDryRun({ state: "running", key, clausesKey });
    try {
      const result = await checkSpec(spec, { shapes: true, place: territory?.place?.query || null, requirements: { ...(requirements || {}), clauses: coherenceClauses } }, contractArgs);
      setDryRun({ state: "done", key, clausesKey, result, at: new Date() });
    } catch (err) {
      setDryRun({ state: "error", key, clausesKey, error: err });
    }
  }, [designKey, spec, territory, requirements, coherenceClauses, coherenceClausesKey, contractArgs]);

  // ④ on arrival: the design as judged now, and the dry run when the design can be built (D13: once per design).
  useEffect(() => {
    if (step !== 4) return;
    setCheckedKey(designKey);
    // The report does not need the validator: without one here the dry run still runs, its refusal carrying the report.
    const settled = dryRun.key === designKey && dryRun.clausesKey === coherenceClausesKey && (dryRun.state === "done" || Boolean(dryRun.error?.body?.coherence));
    if (!hasLines || !validation?.ok || dryRun.state === "running" || settled) return;
    runDryRun();
    // On arrival only; the design's later changes make the checks "to redo".
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [step, validation?.ok]);

  // network-build (D45): ⑤ on arrival — the checks run (the validator at the build), an undecided contract is
  // recorded, and the build follows when nothing is left to accept; else section 1's form comes first.
  const goBuild = () => {
    buildIntentRef.current = true;
    onStep(5);
  };
  useEffect(() => {
    if (step !== 5 || !buildIntentRef.current) return;
    buildIntentRef.current = false;
    setCheckedKey(designKey);
    if (compile.state === "running" || !canBuild || validatorOff || frozen) return;
    // Only what a named person may accept for the plan to be deliverable is asked first; anything else, the server decides.
    if (readiness.onceAcknowledged && reviewAcknowledgement()) return;
    build();
    // On the jump only.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [step]);

  // What the rail shows (StepNav.stepStates): reported to the project page on every change.
  const checks = checkedKey ? (checkedKey === designKey ? "fresh" : "stale") : "none";
  const facts = useMemo(
    () => ({
      job: "create",
      named,
      started,
      contract: contractStatus,
      clauses: contractClausesCount,
      design: !hasLines ? "none" : validation?.ok ? "ready" : "partial",
      checks,
      delivered: builtNow,
      locks: { 4: validatorOff ? "step.locked.validator" : null, 5: validatorOff ? "step.locked.validator" : plan?.over_limit ? "step.locked.offer" : null },
      verdict: quality && "verdict" in quality ? quality.verdict || null : null,
    }),
    [named, started, contractStatus, contractClausesCount, hasLines, validation?.ok, checks, builtNow, validatorOff, plan?.over_limit, quality],
  );
  const factsSignature = JSON.stringify(facts);
  useEffect(() => {
    onFacts?.(facts);
    // The signature says when the facts changed.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [factsSignature]);

  // The built network: this build's answer, else the project's last built version (its session kept in this tab).
  const builtId = builtVersion?.build_id || null;
  const builtSession = compile.state !== "done" && builtId ? builtSessionOf(builtId) : null;
  useEffect(() => {
    if (compile.state === "done" || !builtId || storedReport?.id === builtId) return undefined;
    if (!builtSession) {
      setStoredReport({ id: builtId, missing: true });
      return undefined;
    }
    let live = true;
    fetchNetworkReport({ sessionId: builtSession })
      .then((r) => live && setStoredReport(r && r.build_id === builtId ? { id: builtId, report: r } : { id: builtId, missing: true }))
      .catch(() => live && setStoredReport({ id: builtId, missing: true }));
    return () => {
      live = false;
    };
  }, [compile.state, builtId, builtSession, storedReport?.id]);
  const readBack = storedReport?.id === builtId ? storedReport.report || null : null;
  const reportMissing = compile.state !== "done" && Boolean(builtId) && storedReport?.id === builtId && Boolean(storedReport.missing);
  const built = compile.state === "done" ? { ...compile.result, n: builtVersion?.n ?? nextN } : builtVersion ? { buildId: builtVersion.build_id, sessionId: builtSession, counts: builtVersion.counts || {}, report: readBack, validationReport: null, gateValidation: builtVersion.validation, n: builtVersion.n, by: builtVersion.by, at: builtVersion.at } : null;
  // The coherence report (④, the note, ⑤): the built network's own session while the design is the one built and its
  // working copy answers, else the design's dry run (read from the compiled tables, §6.2) — its refusal by the
  // validator carries the report too.
  const dryCoherence = dryRun.key === designKey ? (dryRun.state === "done" ? dryRun.result?.coherence : dryRun.state === "error" ? dryRun.error?.body?.coherence : null) || null : null;
  const builtReadable = Boolean(builtNow && built?.sessionId && builtLost !== built.sessionId);
  const coherenceSource = builtReadable ? { kind: "network", sessionId: built.sessionId, clauses: coherenceClauses } : dryCoherence ? { kind: "static", report: dryCoherence } : null;
  const coherenceNote = builtNow && built?.sessionId && builtLost === built.sessionId ? t("coherence.fromDesign") : null;
  // What makes the report appear, when there is none yet: the design to complete, the check running, or why it failed.
  const dryCode = String(dryRun.error?.code || "");
  const coherencePending = !hasLines
    ? t("step.reason.noLines")
    : dryRun.state === "running" && dryRun.key === designKey
      ? t("coherence.loading", { seconds: checkSeconds })
      : !validation?.ok
        ? t("coherence.waiting.create")
        : dryRun.state === "error" && dryRun.key === designKey
          ? dryCode.startsWith("VALIDATOR_")
            ? t("coherence.waiting.validator")
            : t("coherence.waiting.checkFailed")
          : t("coherence.waiting.create");
  // "Resume" on the report's refusal (the built network's working copy is gone): read from the design that built it.
  const resumeCoherence = () => {
    if (!built?.sessionId) return;
    setBuiltLost(built.sessionId);
    if (!(dryRun.key === designKey && dryRun.clausesKey === coherenceClausesKey && dryCoherence) && dryRun.state !== "running") runDryRun();
  };
  const deliverNote = () => coherenceDownloads.run("note", coherenceSource, (got) => downloadNetworkSynthesis({ report, t, language, coherence: noteCoherence(got, t) }), { required: false });
  const deliverCsv = () => coherenceDownloads.run("csv", coherenceSource, (got) => got.report && downloadCoherenceCsv(got.report, t, language));
  // The service-méthode files (mission step 7): the server's, from the built network it reads again (a design's dry
  // run has no version yet: the buttons say so); and « chaque ligne cochée devient une clause » on that version.
  const fileSource = coherenceSource?.kind === "network" ? coherenceSource : null;
  const fileVersion = built ? { n: built.n, at: built.at || builtVersion?.at || null } : null;
  const fileLabels = { network: project?.network?.name || project?.name || null, version: fileVersion ? `v${fileVersion.n}` : null, versionAt: fileVersion?.at ? String(fileVersion.at).slice(0, 10) : null };
  // A network designed here: its next build measures the design, with no feed before it — no « garder telle quelle ».
  const contractAdd = coherenceContractAdd({ contractState, version: fileVersion, onOpenContract: () => onStep(2), journey: "create" });
  const downloadGtfs = async () => {
    if (!built?.buildId || !built.sessionId || download.state === "running") return;
    setDownload({ state: "running" });
    try {
      const name = await downloadBuiltNetwork(built.buildId, built.sessionId, { version: built.n });
      setDownload({ state: "idle" });
      setNotice(t("delivery.done"));
      // The project records the delivery — but a shared project's version is delivered only approved (D19, ⑤).
      onUpdateProject?.((p) => (approvalRequired(p) && approvalOf(p, builtVersion?.id) !== "approved" ? p : withJournal({ ...p, delivery: { at: new Date().toISOString(), by: rememberedName() || me?.display_name || null, version_id: builtVersion?.id || null, files: [name] } }, { actor: rememberedName() || null, action: "delivered", object: `v${built.n}` })));
    } catch (err) {
      setDownload({ state: "error", error: err });
    }
  };
  const openBuilt = (edit = false, { deliver = false } = {}) => {
    if (!built?.sessionId) return;
    onOpenBuilt({ sessionId: built.sessionId, validationReport: built.validationReport || null, report: built.report || null, counts: built.counts || null }, { edit, ...(deliver ? { deliver: true } : {}) });
  };
  // 409 BUILD_EDITED: the network was retouched since its build — delivered from edit mode, through the export
  // preflight, like any modified network: here when it is the network open in this tab, else once it is opened.
  const deliverEdited = () => {
    if (built?.sessionId && built.sessionId === getSessionId()) window.dispatchEvent(new CustomEvent("gtfs:deliver"));
    else openBuilt(true, { deliver: true });
  };
  // "Nouveau scénario sur vN": a draft copy of the frozen design, whose build makes vN+1.
  const newScenarioFromVersion = () => {
    onUpdateProject?.((p) => withScenarioFromVersion(p));
    onStep(3);
  };

  // ── The workbench (① and ③): the conversation, the design, the estimate ──
  const tabRow = (
    <Box sx={{ display: "flex", alignItems: "center", flexWrap: "wrap", px: isMobile ? 0.5 : 1.5, borderBottom: `1px solid ${theme.palette.divider}`, background: theme.palette.background.paper }}>
      <Tabs value={tab} onChange={(_, v) => setTab(v)} variant={isMobile ? "scrollable" : "standard"} scrollButtons={false} sx={{ minHeight: 40, minWidth: 0, "& .MuiTab-root": { minHeight: 40, textTransform: "none", fontWeight: 600, fontSize: "0.8rem" } }}>
        <Tab value="map" icon={<MapOutlinedIcon sx={{ fontSize: 16 }} />} iconPosition="start" label={t("network.tab.map")} data-testid="network-tab-map" />
        <Tab value="lines" icon={<RouteOutlinedIcon sx={{ fontSize: 16 }} />} iconPosition="start" label={`${t("network.tab.lines")}${spec.lines?.length ? ` (${spec.lines.length})` : ""}`} data-testid="network-tab-lines" />
        <Tab value="stops" icon={<PlaceOutlinedIcon sx={{ fontSize: 16 }} />} iconPosition="start" label={`${t("network.tab.stops")}${spec.stops?.length ? ` (${spec.stops.length})` : ""}`} data-testid="network-tab-stops" />
        {expert && <Tab value="json" icon={<DataObjectOutlinedIcon sx={{ fontSize: 16 }} />} iconPosition="start" label="JSON" data-testid="network-tab-json" />}
      </Tabs>
      <Box sx={{ flex: 1 }} />
      <Box sx={{ display: "flex", alignItems: "center", gap: 0.5, flexWrap: "wrap", "&:empty": { display: "none" } }}>
        {/* At ③ by hand the needs are listed in the sidebar itself. */}
        {!(step === 3 && manual) && <NeedsChip needs={needs} onClick={() => setNeedsOpen((v) => !v)} />}
        {plan && plan.max_lines != null && plan.name === "free" && (
          <Tooltip title={t("network.plan.freeHint", { max: plan.max_lines })}>
            <Chip size="small" icon={<LockOutlinedIcon sx={{ fontSize: 13 }} />} label={t("network.plan.free", { max: plan.max_lines })} color={plan.over_limit ? "warning" : "default"} onClick={() => window.dispatchEvent(new CustomEvent(PRICING_EVENT, { detail: { reason: plan.over_limit ? "network_limit" : null } }))} data-testid="network-plan-chip" sx={{ height: 22, fontSize: "0.66rem", fontWeight: 700 }} />
          </Tooltip>
        )}
      </Box>
      <Tooltip title={t("network.refreshRoutes")}>
        <span>
          <IconButton size="small" onClick={refreshRoutes} disabled={routing || !validation || validation.estimate?.stops_without_coordinates > 0} aria-label={t("network.refreshRoutes")}>
            {routing ? <CircularProgress size={16} /> : <RefreshIcon sx={{ fontSize: 18, color: geometryStale ? "warning.main" : "inherit" }} />}
          </IconButton>
        </span>
      </Tooltip>
      <Tooltip title={t("network.options")}>
        <IconButton size="small" onClick={(e) => setOptionsAnchor(e.currentTarget)} aria-label={t("network.options")} data-testid="network-options-open">
          <TuneRoundedIcon />
        </IconButton>
      </Tooltip>
      <Tooltip title={t("network.startOver")}>
        <span>
          <IconButton size="small" onClick={() => (eraseItems.length ? setConfirm("reset") : reset())} disabled={streaming || frozen || !eraseItems.length} aria-label={t("network.startOver")} data-testid="network-reset">
            <RestartAltIcon />
          </IconButton>
        </span>
      </Tooltip>
    </Box>
  );

  const confirms = (
    <>
      {/* Start over: what it erases, before it does — in place */}
      <InlineConfirm
        open={confirm === "reset"}
        title={t("network.reset.title")}
        body={t("network.reset.body")}
        items={eraseItems}
        note={t("network.reset.note")}
        confirmLabel={t("network.reset.confirm")}
        cancelLabel={t("network.confirm.cancel")}
        danger
        onConfirm={() => {
          setConfirm(null);
          reset();
        }}
        onClose={() => setConfirm(null)}
        testid="network-reset-confirm"
      />
      {/* A generated scenario replaces the current design: said first, in place */}
      <InlineConfirm
        open={confirm === "scenario" && Boolean(pendingScenario)}
        title={t("network.scenarios.replaceTitle")}
        body={t("network.scenarios.replaceBody", { name: pendingScenario ? t(`network.scenarios.strategy.${pendingScenario.strategy || pendingScenario.id}`) : "" })}
        confirmLabel={t("network.scenarios.adopt")}
        cancelLabel={t("network.confirm.cancel")}
        onConfirm={() => {
          setConfirm(null);
          if (pendingScenario) takeScenario(pendingScenario);
          setPendingScenario(null);
        }}
        onClose={() => {
          setConfirm(null);
          setPendingScenario(null);
        }}
        testid="network-scenario-confirm"
      />
    </>
  );

  const estimateRow = (
    <Box data-testid="network-footer" sx={{ borderTop: `1px solid ${theme.palette.divider}`, background: theme.palette.background.paper, flexShrink: 0 }}>
      {isBaseline && (
        <Box data-testid="network-baseline-strip" sx={{ display: "flex", alignItems: "center", flexWrap: "wrap", gap: 1, px: 2, py: 0.6, background: alpha(theme.palette.warning.main, theme.palette.mode === "dark" ? 0.14 : 0.1) }}>
          <WarningAmberIcon sx={{ fontSize: 16, color: "warning.dark" }} />
          <Typography sx={{ flex: 1, minWidth: 200, fontSize: "0.74rem", fontWeight: 700 }}>{t("network.baseline.strip")}</Typography>
          {spec.origin?.url && (
            <Button size="small" onClick={openRealNetwork} disabled={Boolean(openingReal)} startIcon={openingReal ? <CircularProgress size={12} color="inherit" /> : null} data-testid="network-baseline-open-real" sx={{ textTransform: "none", fontWeight: 700, fontSize: "0.72rem" }}>
              {t("network.baseline.openReal")}
            </Button>
          )}
        </Box>
      )}
      {isBaseline && openRealError && !baselineGuard && <ErrorNotice error={openRealError} onRetry={openRealNetwork} testid="network-open-real-error" sx={{ mx: 2, my: 0.5 }} />}
      <Collapse in={issuesOpen && issues.length > 0}>
        <Box sx={{ maxHeight: 180, overflowY: "auto", px: 2, py: 1, display: "flex", flexDirection: "column", gap: 0.3 }} data-testid="network-issues">
          {shownIssues.slice(0, 60).map((i, k) => (
            <Box key={k} sx={{ display: "flex", alignItems: "flex-start", gap: 0.6, fontSize: "0.74rem", color: i.level === "error" ? "error.main" : "text.secondary" }}>
              {i.level === "error" ? <ErrorOutlineIcon sx={{ fontSize: 14, mt: 0.2 }} /> : <WarningAmberIcon sx={{ fontSize: 14, mt: 0.2 }} />}
              <span>
                {i.text} {expert && i.path && <Box component="span" sx={{ fontFamily: "monospace", color: "text.disabled" }}>{i.path}</Box>}
              </span>
            </Box>
          ))}
        </Box>
      </Collapse>
      <Box sx={{ display: "flex", alignItems: "center", gap: 1.5, px: 2, py: 0.75, flexWrap: "wrap" }}>
        {estimate ? (
          <>
            <Box data-testid="network-estimate" sx={{ display: "flex", alignItems: "center", flexWrap: "wrap", columnGap: 1, rowGap: 0.25, fontSize: "0.76rem", fontWeight: 600, color: "text.primary", "& > .sep": { color: "text.disabled", fontWeight: 400 } }}>
              <span>{t("network.estimate.lines", { count: estimate.lines })}</span>
              <span className="sep">·</span>
              <Box component="span" sx={{ color: estimate.stops_without_coordinates ? "warning.main" : "inherit" }}>
                {t("network.estimate.stops", { count: estimate.stops })}
              </Box>
              <span className="sep">·</span>
              <span>{t("network.estimate.trips", { count: estimate.trips })}</span>
              {geometry.length > 0 && (
                <>
                  <span className="sep">·</span>
                  <span>{t("network.estimate.km", { km: Math.round(geometry.reduce((a, g) => a + (g.distance_km || 0), 0)) })}</span>
                </>
              )}
            </Box>
            {/* The brief's clauses are the contract's (②); the quality is read at the checks (④). */}
            <BriefBadge conformance={quality?.conformance} onClick={() => onStep(2)} />
            <QualityBadge quality={quality} onClick={() => onStep(4)} />
            {quality?.operations && quality.operations.fleet_total > 0 && (
              <Tooltip title={t("network.ops.hint", { km: quality.operations.veh_km_year.toLocaleString(language), hours: quality.operations.veh_h_year.toLocaleString(language) })}>
                <Chip size="small" icon={<DirectionsBusFilledOutlinedIcon sx={{ fontSize: 14 }} />} label={`${t("network.ops.fleet", { count: quality.operations.fleet_total })} · ${t("network.ops.cost", { cost: fmtMoney(quality.operations.cost_year, quality.operations.currency) })}`} onClick={() => onStep(4)} data-testid="network-ops" sx={{ height: 24, fontSize: "0.7rem", fontWeight: 700, background: soft(theme, 1.3), "&:hover": { background: soft(theme, 2.2) } }} />
              </Tooltip>
            )}
            <Box component="button" type="button" ref={issuesToggleRef} id="network-issues-toggle" onClick={() => setIssuesOpen((v) => !v)} data-testid="network-issues-toggle" aria-expanded={issuesOpen} sx={{ all: "unset", cursor: issues.length ? "pointer" : "default", display: "flex", alignItems: "center", gap: 0.5, fontSize: "0.74rem", fontWeight: 700, color: blockers.length ? "error.main" : warnings.length ? "warning.dark" : "success.main", "&:focus-visible": { outline: `2px solid ${theme.palette.primary.main}`, outlineOffset: 2 } }}>
              {blockers.length ? <ErrorOutlineIcon sx={{ fontSize: 15 }} /> : warnings.length ? <WarningAmberIcon sx={{ fontSize: 15 }} /> : <CheckCircleOutlineIcon sx={{ fontSize: 15 }} />}
              {blockers.length ? t("network.issues.blockers", { count: blockers.length }) : shownWarnings ? t("network.issues.warnings", { count: shownWarnings }) : t("network.issues.none")}
              {issues.length > 0 && <ExpandMoreIcon sx={{ fontSize: 15, transform: issuesOpen ? "rotate(180deg)" : "none", transition: "transform 160ms" }} />}
            </Box>
          </>
        ) : (
          <Typography sx={{ fontSize: "0.76rem", color: "text.disabled" }}>{t("network.estimate.empty")}</Typography>
        )}
      </Box>
    </Box>
  );

  // The project's documents in the column, from ① to ③: the brief and its annexes, dropped or picked, with what the
  // project keeps of them (DocumentDrop). The composer's paperclip and a file dropped on the conversation add to it.
  const studioDocuments = (
    <DocumentDrop pending={documents} records={project?.documents || []} retentionDays={retentionDaysOf(features?.workspace, Boolean(me))} retentionUntil={project?.retention_until || null} onAttach={attachDocuments} onRemove={removeDocument} testid="studio-documents" itemTestid="plan-document" />
  );
  const tokensOfTheme = theme.studio || { float: theme.shadows[3] };
  // The left column: the conversation with the planner — or, at ③ without the assistant, the work by hand.
  const planChat = (
    <PlanChat
      controlRef={briefControl}
      turns={turns}
      streaming={streaming}
      pendingTool={pendingTool}
      onSend={runPlan}
      onStop={stopPlan}
      canPlan={canPlan && !frozen && !contractLocksAssistant}
      disabledReason={frozen ? t("step.reason.frozen", { n: frozenVersion.n }) : contractLocksAssistant ? t("step.locked.contract") : disabledReason}
      onOpenContract={() => onStep(2)}
      contractLocked={contractLocksAssistant && !frozen}
      composerHint={canPlan && !frozen && step !== 3 && !contractReady(contract) ? t("contract.firstSendExtracts") : null}
      documents={documents}
      showDocuments={false}
      onAttach={attachDocuments}
      onRemoveDocument={removeDocument}
      propose={territory && !hasLines ? { place: territory.place.name } : null}
      onManual={goManual}
      onOpenFeed={openedFeed}
      place={territory?.place?.query || null}
      onAdoptScenario={adoptScenario}
      demandData={demandData}
      onAttachData={attachDemandData}
      onRemoveData={removeDemandData}
      designVerdict={quality && "verdict" in quality ? { verdict: quality.verdict } : null}
      showVerdict={isMobile}
      header={
        !isMobile ? (
          lockShown ? (
            <LockedAction lock={studioLock} sx={{ px: 1.5, pt: 1 }}>
              {t("network.plan")}
            </LockedAction>
          ) : null
        ) : (
        <>
          {/* What we need from you: a side list next to the work, never a modal */}
          <Collapse in={needsOpen} unmountOnExit>
            <Box data-testid="network-needs-panel" sx={{ p: 1.5, borderBottom: `1px solid ${theme.palette.divider}` }}>
              <NeedsPanel needs={needs} levers={levers} onAction={onNeedAction} clauses={clauses} expert={expert} />
            </Box>
          </Collapse>
          {lockShown && (
            <LockedAction lock={studioLock} sx={{ px: 1.5, pt: 1 }}>
              {t("network.plan")}
            </LockedAction>
          )}
          <ReadOnly on={frozen}>
          <TerritoryPanel queryRef={territoryInput} territory={territory} onTerritory={onTerritory} coverage={coverage} onUseExistingStops={useExistingStops} onRefineStops={refineStops} canRefine={Boolean(validation && (validation.spec?.lines || []).length) && !streaming} refining={refining} onImportedFeed={importedFeed} onOpenedFeed={openedFeed} busy={streaming || frozen} />
          </ReadOnly>
          <Box sx={{ px: 2, pt: 1.25, pb: 1.5, borderTop: `1px solid ${theme.palette.divider}` }}>{studioDocuments}</Box>
        </>
        )
      }
    />
  );
  const manualSidebar = (
    <ManualSidebar
      job="create"
      locked={lockShown ? <LockedAction lock={studioLock}>{t("network.plan")}</LockedAction> : null}
      verdict={isMobile ? <VerdictCard payload={quality && "verdict" in quality ? { verdict: quality.verdict } : null} design measured={Boolean(quality && "verdict" in quality)} /> : null}
      contract={{ status: contractStatus, count: contractClausesCount, onOpen: () => onStep(2) }}
      tasks={designTasksOf(spec, { blockers: blockers.length, measured: Boolean(validation) }).map((task) => ({ ...task, onClick: frozen ? null : () => goTask(task.id) }))}
      action={{ label: t("manual.openLinesEditor"), onClick: goManual, testid: "plan-manual-start", disabled: frozen }}
      documents={isMobile ? studioDocuments : null}
    >
      {isMobile && needs && (
        <Box data-testid="manual-needs" sx={{ pt: 1, borderTop: `1px solid ${theme.palette.divider}` }}>
          <NeedsPanel needs={needs} levers={levers} onAction={onNeedAction} clauses={clauses} expert={expert} />
        </Box>
      )}
      {isMobile && (
      <ReadOnly on={frozen}>
        <Box sx={{ mx: -1.5 }}>
          <TerritoryPanel queryRef={territoryInput} territory={territory} onTerritory={onTerritory} coverage={coverage} onUseExistingStops={useExistingStops} onRefineStops={refineStops} canRefine={Boolean(validation && (validation.spec?.lines || []).length)} refining={refining} onImportedFeed={importedFeed} onOpenedFeed={openedFeed} busy={frozen} />
        </Box>
      </ReadOnly>
      )}
    </ManualSidebar>
  );

  const mobileBench = (
    <Box data-testid="network-studio" sx={{ flex: 1, minHeight: isMobile ? "auto" : fill ? 0 : 540, display: "flex", flexDirection: "column", border: `1px solid ${theme.palette.divider}`, borderRadius: "12px", overflow: "hidden", background: theme.palette.background.default }}>
      <Box sx={{ flex: 1, minHeight: 0, display: "flex", flexDirection: isMobile ? "column" : "row" }} data-testid="network-body">
        <Box sx={{ width: isMobile ? "100%" : { md: 330, lg: 360, xl: 400 }, flexShrink: 0, borderRight: isMobile ? "none" : `1px solid ${theme.palette.divider}`, borderBottom: isMobile ? `1px solid ${theme.palette.divider}` : "none", background: theme.palette.background.paper, height: isMobile ? "min(70vh, 640px)" : "auto", minHeight: isMobile ? 360 : 0, display: "flex", flexDirection: "column" }}>
          {step === 3 && manual ? manualSidebar : planChat}
        </Box>
        <Box sx={{ flex: isMobile ? "none" : 1, minWidth: 0, minHeight: isMobile ? "auto" : 0, display: "flex", flexDirection: "column" }}>
          {tabRow}
          {confirms}
          <Box sx={{ flex: isMobile ? "none" : 1, minHeight: isMobile ? "50vh" : fill ? 0 : 360, height: isMobile && tab === "map" ? "60vh" : undefined, position: "relative", overflow: tab === "map" ? "hidden" : isMobile ? "visible" : "auto", p: tab === "map" ? 0 : 1.5 }} data-testid="network-content">
            {tab === "map" && (
              <>
                <NetworkMap stops={spec.stops || []} lines={validation?.spec?.lines || spec.lines || []} geometry={geometry} corridors={corridors} population={territory && layers.population ? territory.population_grid : null} focusBbox={territory ? territory.place.bbox : null} works={territory && layers.works ? territory.works?.items || [] : []} existingStops={territory && layers.stops ? territory.existing_stops : []} pois={territory && layers.pois ? territory.pois.items : []} onPickExistingStop={frozen ? null : (s) => { if (!(spec.stops || []).some((x) => x.id === s.id)) updateSpec({ ...spec, stops: [...(spec.stops || []), { id: s.id, name: s.name || s.kind, lat: s.lat, lon: s.lon, source: "osm" }] }); }} selectedStopId={selectedStopId} placingStopId={frozen ? null : placingStopId} onSelectStop={setSelectedStopId} onMoveStop={frozen ? null : (id, lat, lon) => updateSpec({ ...spec, stops: spec.stops.map((s) => (s.id === id ? { ...s, lat, lon } : s)) })} onPlaceStop={frozen ? null : (id, lat, lon) => { updateSpec({ ...spec, stops: spec.stops.map((s) => (s.id === id ? { ...s, lat, lon } : s)) }); setPlacingStopId(null); }} addingStops={addingStops && !frozen} onAddStopAt={frozen ? null : addStopAt} fitEpoch={fitEpoch} />
                {!frozen && ((spec.stops || []).length > 0 || territory) ? (
                  <Box sx={{ position: "absolute", top: 12, left: 12, zIndex: 1000 }}>
                    <Chip size="small" icon={<AddLocationAltOutlinedIcon sx={{ fontSize: 15 }} />} label={addingStops ? t("network.map.addingStops") : t("network.map.addStops")} color={addingStops ? "primary" : "default"} onClick={() => setAddingStops((v) => !v)} data-testid="map-add-stops" sx={{ fontWeight: 700, boxShadow: 2, background: addingStops ? undefined : theme.palette.background.paper }} />
                  </Box>
                ) : null}
                <MapLayers territory={territory} layers={layers} onToggle={(k) => setLayers((l) => ({ ...l, [k]: !l[k] }))} />
                {placingStopId && (
                  <Box sx={{ position: "absolute", top: 12, left: "50%", transform: "translateX(-50%)", zIndex: 1000, px: 1.5, py: 0.6, borderRadius: 99, background: theme.palette.warning.main, color: theme.palette.warning.contrastText, fontSize: "0.76rem", fontWeight: 700, boxShadow: 3 }}>
                    {t("network.placingHint", { name: (spec.stops || []).find((s) => s.id === placingStopId)?.name || "" })}
                  </Box>
                )}
                {/* The empty map says where to start; it is never covered (① does the welcome). */}
                {mapEmpty && !territory && (
                  <Box sx={{ position: "absolute", inset: 0, display: "flex", alignItems: "center", justifyContent: "center", pointerEvents: "none", zIndex: 900 }}>
                    <Typography sx={{ px: 2, py: 1, borderRadius: 2, background: alpha(theme.palette.background.paper, 0.9), fontSize: "0.82rem", color: "text.secondary", maxWidth: 360, textAlign: "center" }}>{t("network.map.empty")}</Typography>
                  </Box>
                )}
              </>
            )}
            <ReadOnly on={frozen && tab !== "map"}>
              {tab === "lines" && (
                <Box sx={{ display: "flex", flexDirection: "column", gap: 1.25, maxWidth: 1120, mx: "auto" }}>
                  <NetworkSettings spec={spec} onChange={updateSpec} territory={territory} prefilled={prefilled} open={settingsOpen} onOpenChange={setSettingsOpen} openSignal={settingsSignal} onOpened={settingsOpened} />
                  <Box ref={linesPaneRef} role="region" aria-label={t("manual.task.lines")} tabIndex={-1}>
                    <LinesEditor spec={spec} onChange={updateSpec} existingStops={territory ? territory.existing_stops : []} />
                  </Box>
                </Box>
              )}
              {tab === "stops" && (
                <Box ref={stopsPaneRef} role="region" aria-label={t("manual.task.stops")} tabIndex={-1}>
                  <StopsEditor spec={spec} onChange={updateSpec} selectedStopId={selectedStopId} onSelectStop={setSelectedStopId} placingStopId={placingStopId} onPlaceRequest={(id) => { setPlacingStopId(id); if (id) setTab("map"); }} near={near} existingStops={territory ? territory.existing_stops : []} />
                </Box>
              )}
              {tab === "json" && expert && <JsonEditor key={turns.length} spec={spec} onChange={updateSpec} />}
            </ReadOnly>
          </Box>
          {estimateRow}
        </Box>
      </Box>
    </Box>
  );

  // ── The workbench on a desktop screen (studio/Workspace): the map in the middle, on the whole height; on its left
  // the tools — the starting point (name, territory, documents, deliverables), the conversation or the work by hand,
  // the lines, the stops, the raw JSON (expert), the network's settings — each panel kept mounted, one shown or none;
  // on its right what the engine measured. ──
  const handWork = step === 3 && manual;
  const defaultTool = step === 3 ? "assistant" : "start";
  const chooseTool = (key) => {
    const next = key === tool ? null : key;
    setToolChoice({ step, key: next });
    onTab?.(TAB_SLUG[next] || null);
    if (next === "settings") setSettingsOpen(true);
  };
  const tools = [
    { key: "start", label: t("studio.tool.start"), icon: <FlagOutlinedIcon />, testid: "network-tab-start" },
    { key: "assistant", label: t(handWork ? "studio.tool.todo" : "studio.tool.assistant"), icon: handWork ? <ChecklistRoundedIcon /> : <AutoAwesomeOutlinedIcon />, testid: "network-tab-assistant" },
    { key: "lines", label: t("network.tab.lines"), icon: <RouteOutlinedIcon />, testid: "network-tab-lines", count: (spec.lines || []).length },
    { key: "stops", label: t("network.tab.stops"), icon: <PlaceOutlinedIcon />, testid: "network-tab-stops", count: (spec.stops || []).length },
    { key: "json", label: "JSON", icon: <DataObjectOutlinedIcon />, testid: "network-tab-json", hidden: !expert },
    { key: "settings", label: t("studio.tool.settings"), icon: <TuneRoundedIcon />, testid: "network-tab-settings", bottom: true },
  ];
  const readyDocs = documents.filter((d) => d.status === "ready").length + (project?.documents || []).filter((r) => !documents.some((d) => d.id === r.id)).length;
  const startPanel = (
    <Panel tool="start" idBase="network" title={t("studio.start.title")} subtitle={t("studio.start.subtitle")} hidden={tool !== "start"} testid="network-panel-start">
      {project && (
        <Section first>
          <TextField size="small" fullWidth label={t("network.project.name")} value={project.name || ""} onChange={(e) => onUpdateProject?.({ name: e.target.value.slice(0, 200) })} inputProps={{ "data-testid": "project-name", maxLength: 200 }} />
        </Section>
      )}
      <Box sx={{ borderTop: project ? `1px solid ${theme.palette.divider}` : "none" }}>
        <ReadOnly on={frozen}>
          <TerritoryPanel queryRef={territoryInput} territory={territory} onTerritory={onTerritory} coverage={coverage} onUseExistingStops={useExistingStops} onRefineStops={refineStops} canRefine={Boolean(validation && (validation.spec?.lines || []).length) && !streaming} refining={refining} onImportedFeed={importedFeed} onOpenedFeed={openedFeed} busy={streaming || frozen} />
        </ReadOnly>
      </Box>
      <Section>{studioDocuments}</Section>
      {project && (
        <Section title={t("deliverables.wanted")}>
          <DeliverablesWanted project={project} job="create" onChange={onUpdateProject ? (list) => onUpdateProject({ deliverables_wanted: list }) : null} bare />
        </Section>
      )}
    </Panel>
  );
  const benchPanels = (
    <>
      {startPanel}
      <Panel tool="assistant" idBase="network" hidden={tool !== "assistant"} testid="network-panel-assistant" flush>
        <Box sx={{ flex: 1, minHeight: 0, display: "flex", flexDirection: "column" }}>{handWork ? manualSidebar : planChat}</Box>
      </Panel>
      <Panel tool="lines" idBase="network" title={t("network.tab.lines")} subtitle={t("studio.lines.subtitle", { lines: (spec.lines || []).length, stops: (spec.stops || []).length })} hidden={tool !== "lines"} width={560} testid="network-panel-lines">
        <ReadOnly on={frozen}>
          <Box ref={linesPaneRef} role="region" aria-label={t("manual.task.lines")} tabIndex={-1} sx={{ px: 2, outline: "none" }}>
            {!(spec.lines || []).length && (
              <Box sx={{ mb: 1.5, p: 2, borderRadius: "10px", border: `1px dashed ${theme.palette.divider}`, textAlign: "center" }}>
                <RouteOutlinedIcon sx={{ fontSize: 26, color: "text.disabled" }} />
                <Typography sx={{ fontSize: "0.82rem", fontWeight: 600, mt: 0.5 }}>{t("studio.lines.emptyTitle")}</Typography>
                <Typography sx={{ fontSize: "0.76rem", color: "text.secondary", mt: 0.25, lineHeight: 1.5 }}>{t("studio.lines.emptyHint")}</Typography>
              </Box>
            )}
            <LinesEditor spec={spec} onChange={updateSpec} existingStops={territory ? territory.existing_stops : []} />
          </Box>
        </ReadOnly>
      </Panel>
      <Panel tool="stops" idBase="network" title={t("network.tab.stops")} subtitle={t("studio.stops.subtitle", { stops: (spec.stops || []).length })} hidden={tool !== "stops"} width={460} testid="network-panel-stops">
        <ReadOnly on={frozen}>
          <Box ref={stopsPaneRef} role="region" aria-label={t("manual.task.stops")} tabIndex={-1} sx={{ px: 2, outline: "none" }}>
            <StopsEditor spec={spec} onChange={updateSpec} selectedStopId={selectedStopId} onSelectStop={setSelectedStopId} placingStopId={placingStopId} onPlaceRequest={(id) => setPlacingStopId(id)} near={near} existingStops={territory ? territory.existing_stops : []} />
          </Box>
        </ReadOnly>
      </Panel>
      {expert && (
        <Panel tool="json" idBase="network" title="JSON" subtitle={t("network.expertHint")} hidden={tool !== "json"} width={520} testid="network-panel-json">
          <ReadOnly on={frozen}>
            <Box sx={{ px: 2 }}>
              <JsonEditor key={turns.length} spec={spec} onChange={updateSpec} />
            </Box>
          </ReadOnly>
        </Panel>
      )}
      <Panel tool="settings" idBase="network" title={t("studio.settings.title")} subtitle={t("studio.settings.subtitle")} hidden={tool !== "settings"} width={440} testid="network-panel-settings">
        <ReadOnly on={frozen}>
          <Box sx={{ px: 2 }}>
            <NetworkSettings spec={spec} onChange={updateSpec} territory={territory} prefilled={prefilled} open={settingsOpen} onOpenChange={setSettingsOpen} openSignal={settingsSignal} onOpened={settingsOpened} />
          </Box>
        </ReadOnly>
      </Panel>
    </>
  );
  const mapButton = { ...floatSx(theme), width: 36, height: 36, color: "text.secondary", "&:hover": { backgroundColor: "action.hover", color: "text.primary" } };
  const mapStage = (
    <>
      <Box sx={{ position: "absolute", inset: 0 }}>
        <NetworkMap stops={spec.stops || []} lines={validation?.spec?.lines || spec.lines || []} geometry={geometry} corridors={corridors} population={territory && layers.population ? territory.population_grid : null} focusBbox={territory ? territory.place.bbox : null} works={territory && layers.works ? territory.works?.items || [] : []} existingStops={territory && layers.stops ? territory.existing_stops : []} pois={territory && layers.pois ? territory.pois.items : []} onPickExistingStop={frozen ? null : (s) => { if (!(spec.stops || []).some((x) => x.id === s.id)) updateSpec({ ...spec, stops: [...(spec.stops || []), { id: s.id, name: s.name || s.kind, lat: s.lat, lon: s.lon, source: "osm" }] }); }} selectedStopId={selectedStopId} placingStopId={frozen ? null : placingStopId} onSelectStop={setSelectedStopId} onMoveStop={frozen ? null : (id, lat, lon) => updateSpec({ ...spec, stops: spec.stops.map((x) => (x.id === id ? { ...x, lat, lon } : x)) })} onPlaceStop={frozen ? null : (id, lat, lon) => { updateSpec({ ...spec, stops: spec.stops.map((x) => (x.id === id ? { ...x, lat, lon } : x)) }); setPlacingStopId(null); }} addingStops={addingStops && !frozen} onAddStopAt={frozen ? null : addStopAt} fitEpoch={fitEpoch} />
      </Box>
      {/* Top left: the map on its own (the panel folded) or the panel back; adding stops by clicking the map. */}
      <Box sx={{ position: "absolute", top: 12, left: 12, zIndex: 1000, display: "flex", alignItems: "center", gap: 1 }}>
        <Tooltip title={t(tool ? "studio.map.expand" : "studio.map.restore")}>
          <IconButton onClick={() => setToolChoice({ step, key: tool ? null : defaultTool })} aria-label={t(tool ? "studio.map.expand" : "studio.map.restore")} aria-pressed={!tool} data-testid="network-tab-map" sx={mapButton}>
            {tool ? <OpenInFullRoundedIcon sx={{ fontSize: 17 }} /> : <CloseFullscreenRoundedIcon sx={{ fontSize: 17 }} />}
          </IconButton>
        </Tooltip>
        {!frozen && ((spec.stops || []).length > 0 || territory) ? (
          <Chip icon={<AddLocationAltOutlinedIcon sx={{ fontSize: 16 }} />} label={addingStops ? t("network.map.addingStops") : t("network.map.addStops")} color={addingStops ? "primary" : "default"} onClick={() => setAddingStops((v) => !v)} data-testid="map-add-stops" sx={{ height: 36, borderRadius: "10px", fontWeight: 600, ...(addingStops ? { boxShadow: tokensOfTheme.float } : floatSx(theme)) }} />
        ) : null}
      </Box>
      {/* Top right: the offer's limit, the routes drawn again, the options, start over — the territory's layers under them. */}
      <Box sx={{ position: "absolute", top: 12, right: 12, zIndex: 1000, display: "flex", flexDirection: "column", alignItems: "flex-end", gap: 1 }}>
        <Box sx={{ ...floatSx(theme), display: "flex", alignItems: "center", gap: 0.25, p: 0.5 }}>
          {plan && plan.max_lines != null && plan.name === "free" && (
            <Tooltip title={t("network.plan.freeHint", { max: plan.max_lines })}>
              <Chip size="small" icon={<LockOutlinedIcon sx={{ fontSize: 13 }} />} label={t("network.plan.free", { max: plan.max_lines })} color={plan.over_limit ? "warning" : "default"} onClick={() => window.dispatchEvent(new CustomEvent(PRICING_EVENT, { detail: { reason: plan.over_limit ? "network_limit" : null } }))} data-testid="network-plan-chip" sx={{ height: 24, fontSize: "0.68rem", fontWeight: 600, mx: 0.5 }} />
            </Tooltip>
          )}
          <Tooltip title={t("network.refreshRoutes")}>
            <span>
              <IconButton size="small" onClick={refreshRoutes} disabled={routing || !validation || validation.estimate?.stops_without_coordinates > 0} aria-label={t("network.refreshRoutes")}>
                {routing ? <CircularProgress size={16} /> : <RefreshIcon sx={{ fontSize: 18, color: geometryStale ? "warning.main" : "inherit" }} />}
              </IconButton>
            </span>
          </Tooltip>
          <Tooltip title={t("network.options")}>
            <IconButton size="small" onClick={(e) => setOptionsAnchor(e.currentTarget)} aria-label={t("network.options")} data-testid="network-options-open">
              <TuneRoundedIcon sx={{ fontSize: 18 }} />
            </IconButton>
          </Tooltip>
          <Tooltip title={t("network.startOver")}>
            <span>
              <IconButton size="small" onClick={() => (eraseItems.length ? setConfirm("reset") : reset())} disabled={streaming || frozen || !eraseItems.length} aria-label={t("network.startOver")} data-testid="network-reset">
                <RestartAltIcon sx={{ fontSize: 18 }} />
              </IconButton>
            </span>
          </Tooltip>
        </Box>
        <MapLayers territory={territory} layers={layers} onToggle={(key) => setLayers((l) => ({ ...l, [key]: !l[key] }))} sx={{ position: "static" }} />
      </Box>
      {/* What asks for a decision, and the simplified import's warning: over the map, at its top, never a modal. */}
      {(confirm || isBaseline) && (
        <Box sx={{ position: "absolute", top: 60, left: "50%", transform: "translateX(-50%)", zIndex: 1001, width: "min(480px, calc(100% - 24px))", display: "flex", flexDirection: "column", gap: 1 }}>
          {confirm && <Box sx={{ ...floatSx(theme), overflow: "hidden" }}>{confirms}</Box>}
          {isBaseline && (
            <Box data-testid="network-baseline-strip" sx={{ ...floatSx(theme), display: "flex", alignItems: "center", flexWrap: "wrap", gap: 1, px: 1.5, py: 1, borderColor: alpha(theme.palette.warning.main, 0.4) }}>
              <WarningAmberIcon sx={{ fontSize: 18, color: "warning.main" }} />
              <Typography sx={{ flex: 1, minWidth: 180, fontSize: "0.78rem", fontWeight: 600 }}>{t("network.baseline.strip")}</Typography>
              {spec.origin?.url && (
                <Button size="small" onClick={openRealNetwork} disabled={Boolean(openingReal)} startIcon={openingReal ? <CircularProgress size={12} color="inherit" /> : null} data-testid="network-baseline-open-real">
                  {t("network.baseline.openReal")}
                </Button>
              )}
              {openRealError && !baselineGuard && <ErrorNotice error={openRealError} onRetry={openRealNetwork} testid="network-open-real-error" sx={{ width: "100%" }} />}
            </Box>
          )}
        </Box>
      )}
      {placingStopId && (
        <Box sx={{ position: "absolute", top: 60, left: "50%", transform: "translateX(-50%)", zIndex: 1000, px: 1.5, py: 0.75, borderRadius: 99, background: theme.palette.warning.main, color: theme.palette.warning.contrastText, fontSize: "0.78rem", fontWeight: 600, boxShadow: 3 }}>
          {t("network.placingHint", { name: (spec.stops || []).find((x) => x.id === placingStopId)?.name || "" })}
        </Box>
      )}
      {/* The empty map says where to start; it is never covered (① does the welcome). */}
      {mapEmpty && !territory && (
        <Box sx={{ position: "absolute", inset: 0, display: "flex", alignItems: "center", justifyContent: "center", pointerEvents: "none", zIndex: 900 }}>
          <Typography sx={{ ...floatSx(theme), px: 2, py: 1.25, fontSize: "0.82rem", color: "text.secondary", maxWidth: 360, textAlign: "center" }}>{t("network.map.empty")}</Typography>
        </Box>
      )}
      {/* At the foot of the map: what the design holds, measured at each change. */}
      <Box sx={{ position: "absolute", left: 12, bottom: 14, zIndex: 1000, ...floatSx(theme), display: "flex", alignItems: "center", flexWrap: "wrap", gap: 1, px: 1.5, py: 0.5, minHeight: 40, maxWidth: "calc(100% - 76px)" }}>
        {estimate ? (
          <>
            <Box data-testid="network-estimate" sx={{ display: "flex", alignItems: "center", flexWrap: "wrap", columnGap: 1, rowGap: 0.25, fontSize: "0.8rem", fontWeight: 500, fontVariantNumeric: "tabular-nums", whiteSpace: "nowrap", "& > .sep": { color: "text.disabled" } }}>
              <span>{t("network.estimate.lines", { count: estimate.lines })}</span>
              <span className="sep">·</span>
              <Box component="span" sx={{ color: estimate.stops_without_coordinates ? "warning.main" : "inherit" }}>
                {t("network.estimate.stops", { count: estimate.stops })}
              </Box>
              <span className="sep">·</span>
              <span>{t("network.estimate.trips", { count: estimate.trips })}</span>
              {geometry.length > 0 && (
                <>
                  <span className="sep">·</span>
                  <span>{t("network.estimate.km", { km: Math.round(geometry.reduce((a, g) => a + (g.distance_km || 0), 0)) })}</span>
                </>
              )}
            </Box>
            <BriefBadge conformance={quality?.conformance} onClick={() => onStep(2)} />
            <QualityBadge quality={quality} onClick={() => onStep(4)} />
          </>
        ) : (
          <Typography sx={{ fontSize: "0.8rem", color: "text.secondary" }}>{t("network.estimate.empty")}</Typography>
        )}
      </Box>
    </>
  );
  const issueTone = blockers.length ? "error.main" : warnings.length ? "warning.main" : "success.main";
  const issuesList = (
    <Box component="ul" data-testid="network-issues" sx={{ m: 0, p: 0, listStyle: "none", display: "flex", flexDirection: "column", gap: 0.75 }}>
      {shownIssues.slice(0, 60).map((i, n) => (
        <Box component="li" key={n} sx={{ display: "flex", alignItems: "flex-start", gap: 0.75, fontSize: "0.78rem", lineHeight: 1.45 }}>
          {i.level === "error" ? <ErrorOutlineIcon sx={{ fontSize: 15, mt: 0.25, color: "error.main" }} /> : <WarningAmberIcon sx={{ fontSize: 15, mt: 0.25, color: "warning.main" }} />}
          <span>
            {i.text} {expert && i.path && <Box component="span" sx={{ fontFamily: "monospace", color: "text.disabled" }}>{i.path}</Box>}
          </span>
        </Box>
      ))}
    </Box>
  );
  const beforeItems = [
    { key: "named", ok: Boolean(project && named), title: t(project && named ? "studio.before.named" : "studio.before.unnamed"), text: project && named ? project.name : t("studio.before.unnamedHint") },
    { key: "territory", ok: Boolean(territory), title: t(territory ? "studio.before.territory" : "studio.before.territoryTodo"), text: territory ? territory.place?.name || territory.place?.query || "" : t("studio.before.territoryHint") },
    { key: "documents", ok: readyDocs > 0, title: t(readyDocs > 0 ? "studio.before.documents" : "studio.before.documentsTodo"), text: readyDocs > 0 ? t("studio.before.documentsCount", { count: readyDocs }) : t("studio.before.documentsHint") },
  ];
  const inspectorBench = (
    <Inspector title={t(step === 3 ? "studio.check.title" : "studio.before.title")} subtitle={t(step === 3 ? "studio.check.subtitle" : "studio.before.subtitle")} testid="network-inspector">
      {step !== 3 && (
        <Section first testid="network-before">
          <Box component="ul" sx={{ m: 0, p: 0, listStyle: "none", display: "flex", flexDirection: "column", gap: 1.5 }}>
            {beforeItems.map((it) => (
              <Box component="li" key={it.key} data-testid={`network-before-${it.key}`} data-ok={it.ok ? "true" : "false"} sx={{ display: "flex", alignItems: "flex-start", gap: 1.25 }}>
                <Box aria-hidden sx={{ width: 20, height: 20, mt: "1px", borderRadius: "50%", flexShrink: 0, display: "flex", alignItems: "center", justifyContent: "center", color: it.ok ? "success.main" : "text.disabled", backgroundColor: it.ok ? alpha(theme.palette.success.main, 0.12) : "action.hover" }}>
                  {it.ok ? <CheckCircleOutlineIcon sx={{ fontSize: 15 }} /> : <Box sx={{ width: 6, height: 6, borderRadius: "50%", backgroundColor: "currentColor" }} />}
                </Box>
                <Box sx={{ minWidth: 0 }}>
                  <Typography sx={{ fontSize: "0.8rem", fontWeight: 500 }}>{it.title}</Typography>
                  <Typography sx={{ fontSize: "0.74rem", color: "text.secondary", overflow: "hidden", textOverflow: "ellipsis" }}>{it.text}</Typography>
                </Box>
              </Box>
            ))}
          </Box>
        </Section>
      )}
      {/* The verdict card and the needs carry their own titles. */}
      <Section first={step === 3}>
        <VerdictCard payload={quality && "verdict" in quality ? { verdict: quality.verdict } : null} design measured={Boolean(quality && "verdict" in quality)} />
        {quality?.operations && quality.operations.fleet_total > 0 && (
          <Tooltip title={t("network.ops.hint", { km: quality.operations.veh_km_year.toLocaleString(language), hours: quality.operations.veh_h_year.toLocaleString(language) })}>
            <Chip size="small" icon={<DirectionsBusFilledOutlinedIcon sx={{ fontSize: 14 }} />} label={`${t("network.ops.fleet", { count: quality.operations.fleet_total })} · ${t("network.ops.cost", { cost: fmtMoney(quality.operations.cost_year, quality.operations.currency) })}`} onClick={() => onStep(4)} data-testid="network-ops" sx={{ alignSelf: "flex-start", fontWeight: 600 }} />
          </Tooltip>
        )}
      </Section>
      {estimate && (
        <Section
          title={t("studio.issues")}
          action={
            <Box component="button" type="button" ref={issuesToggleRef} id="network-issues-toggle" onClick={() => setIssuesFolded((v) => !v)} data-testid="network-issues-toggle" aria-expanded={!issuesFolded && issues.length > 0} sx={{ all: "unset", cursor: issues.length ? "pointer" : "default", display: "flex", alignItems: "center", gap: 0.5, fontSize: "0.75rem", fontWeight: 600, color: issueTone, borderRadius: "6px", "&:focus-visible": { outline: `2px solid ${theme.palette.primary.main}`, outlineOffset: 2 } }}>
              {blockers.length ? <ErrorOutlineIcon sx={{ fontSize: 15 }} /> : warnings.length ? <WarningAmberIcon sx={{ fontSize: 15 }} /> : <CheckCircleOutlineIcon sx={{ fontSize: 15 }} />}
              {blockers.length ? t("network.issues.blockers", { count: blockers.length }) : shownWarnings ? t("network.issues.warnings", { count: shownWarnings }) : t("network.issues.none")}
              {issues.length > 0 && <ExpandMoreIcon sx={{ fontSize: 15, transform: issuesFolded ? "none" : "rotate(180deg)", transition: "transform 160ms" }} />}
            </Box>
          }
        >
          {issues.length > 0 && !issuesFolded ? issuesList : null}
        </Section>
      )}
      {needs && (
        <Section testid="network-needs-panel">
          <NeedsPanel needs={needs} levers={levers} onAction={onNeedAction} clauses={clauses} expert={expert} />
        </Section>
      )}
      {step !== 3 && project && (
        <Section title={t("retention.title")}>
          <RetentionPanel project={project} workspace={features?.workspace || null} bare />
        </Section>
      )}
    </Inspector>
  );
  const studioBench = (
    <Workspace
      testid="network-studio"
      flush={inStudio && fill}
      sx={{ minHeight: fill ? 0 : 560 }}
      rail={<ToolRail label={t("studio.tools")} idBase="network" items={tools} value={tool} onSelect={chooseTool} />}
      panel={benchPanels}
      center={mapStage}
      inspector={inspectorBench}
    />
  );
  const workbench = isMobile ? mobileBench : studioBench;

  // network-build, in the foot of ①–④: the one rule (D45) — to ⑤, where the checks run and the build follows.
  const buildReason = frozen ? t("step.reason.frozen", { n: frozenVersion.n }) : validatorOff ? t("step.locked.validator") : plan?.over_limit ? t("step.locked.offer") : !hasLines ? t("step.reason.noLines") : null;
  const buildButton = (
    <Tooltip title={(!canBuild || frozen) && buildReason ? buildReason : ""}>
      <span>
        <Button variant="outlined" disabled={!canBuild || validatorOff || frozen} onClick={goBuild} startIcon={compile.state === "running" ? <CircularProgress size={14} color="inherit" /> : <BuildCircleOutlinedIcon />} aria-describedby={blockers.length ? "network-issues-toggle" : undefined} data-testid="network-build" sx={{ textTransform: "none", fontWeight: 700, borderRadius: 99 }}>
          {t("step.build.go", { n: nextN })}
        </Button>
      </span>
    </Tooltip>
  );
  const back = step > 1 ? { onClick: () => onStep(step - 1) } : null;
  const designReason = !hasLines ? t("step.reason.noLines") : blockers.length ? t("step.reason.designIssues", { count: blockers.length }) : null;

  // ── ⑤ The delivery's sections ────────────────────────────────────────────
  const validationOf = (b) => {
    if (b?.validationReport) return validationSummary(b.validationReport);
    const g = b?.report?.gate?.validation || b?.gateValidation;
    return g ? { errors: g.errors ?? 0, warnings: g.warnings ?? 0 } : null;
  };
  const acceptSection = ackGuard ? (
    <Box data-testid="network-ack" sx={{ display: "flex", flexDirection: "column", gap: 1 }}>
      {ackGuard.refusal && <RefusalNotice refusal={ackGuard.refusal} onAction={(id) => (id === "focusName" ? ackFormRef.current?.focusName() : ackFormRef.current?.focusItems(ackGuard.highlight))} supported={["focusName", "focusItems"]} manageFocus={false} />}
      <AcknowledgementForm
        ref={ackFormRef}
        items={ackGuard.items}
        value={ackGuard.value}
        onChange={(value) => setAckGuard((g) => ({ ...g, value, nameInvalid: g.nameInvalid && !NAME_OK(value.name) }))}
        highlight={ackGuard.highlight}
        nameInvalid={ackGuard.nameInvalid}
        disabled={compile.state === "running"}
        onBack={() => {
          setAckGuard(null);
          onStep(3);
        }}
        backLabel={t("ack.backToDesign")}
      />
    </Box>
  ) : null;
  const builtValidation = validationOf(built);
  const gateAck = built?.report?.gate?.acknowledgement || null;
  const actSection = (
    <Box sx={{ display: "flex", flexDirection: "column", gap: 1 }}>
      {compile.state === "running" && (
        <Box data-testid="network-building" role="status">
          <LinearProgress sx={{ borderRadius: 99, mb: 0.75 }} />
          <Typography sx={{ fontSize: "0.8rem", color: "text.secondary" }}>{t("delivery.building", { seconds: buildSeconds })}</Typography>
        </Box>
      )}
      {compile.state === "error" &&
        (compile.code === "PLAN_LIMIT" ? (
          <Alert severity="error" onClose={() => setCompile({ state: "idle" })} action={<Button color="inherit" size="small" onClick={() => window.dispatchEvent(new CustomEvent(PRICING_EVENT, { detail: { reason: "network_limit" } }))} sx={{ textTransform: "none", fontWeight: 700 }}>{t("access.seeOffers")}</Button>} sx={{ fontSize: "0.78rem" }}>
            {t("network.plan.limitReached")}
          </Alert>
        ) : (
          compile.code === "REQUIREMENTS_UNCOVERED" || compile.code === "CONTRACT_REQUIRED" ? (
            // G5: requirements of the brief answered by no clause — back to ② (a clause, « à vérifier à la main », a named dismissal).
            <RefusalNotice refusal={refusalOf(compile.error)} onAction={(id) => id === "openContract" && onStep(2)} supported={["openContract"]} testid={compile.code === "CONTRACT_REQUIRED" ? "network-build-contract" : "network-build-uncovered"} />
          ) : (
            <ErrorNotice error={compile.error} onRetry={() => buildAcknowledged()} testid="network-build-error" />
          )
        ))}
      {built && compile.state !== "running" ? (
        <Box data-testid="network-result" data-version={built.n} data-current={builtNow ? "true" : "false"} sx={{ p: 1.5, borderRadius: "12px", background: alpha(theme.palette.success.main, theme.palette.mode === "dark" ? 0.12 : 0.06), display: "flex", flexDirection: "column", gap: 0.75 }}>
          <Box sx={{ display: "flex", alignItems: "flex-start", gap: 1 }}>
            <CheckCircleOutlineIcon sx={{ fontSize: 22, color: "success.main", mt: 0.1 }} />
            <Typography sx={{ fontSize: "0.84rem", lineHeight: 1.5 }}>{t("delivery.built", { n: built.n, routes: built.counts?.routes ?? 0, stops: built.counts?.stops ?? 0, trips: built.counts?.trips ?? 0, stopTimes: built.counts?.stop_times ?? 0, errors: builtValidation?.errors ?? 0, warnings: builtValidation?.warnings ?? 0 })}</Typography>
          </Box>
          {builtValidation && (
            <Chip size="small" icon={builtValidation.errors ? <ErrorOutlineIcon sx={{ fontSize: 14 }} /> : <CheckCircleOutlineIcon sx={{ fontSize: 14 }} />} color={builtValidation.errors ? "error" : "success"} variant="outlined" label={builtValidation.errors ? t("network.result.validationErrors", { errors: builtValidation.errors, warnings: builtValidation.warnings }) : t("network.result.validationOk", { warnings: builtValidation.warnings })} data-testid="network-validation" sx={{ alignSelf: "flex-start", height: 24, fontSize: "0.7rem", fontWeight: 700 }} />
          )}
          {gateAck && <Typography data-testid="network-result-ack" sx={{ fontSize: "0.76rem" }}>{t("ack.by", { what: (gateAck.items || []).map((i) => i.id).join(", "), name: gateAck.by?.name || "", date: formatDateTime(gateAck.at, language) })}</Typography>}
          {!builtNow && <Typography sx={{ fontSize: "0.76rem", color: "warning.dark" }}>{t("step.delivery.designChanged", { n: built.n, next: nextVersionNumber(project || { versions: [] }) })}</Typography>}
          {built.stats?.routing_fallback_legs > 0 && <Typography sx={{ fontSize: "0.74rem", color: "warning.dark" }}>{t("network.result.fallback", { count: built.stats.routing_fallback_legs })}</Typography>}
          <Box sx={{ display: "flex", gap: 1, flexWrap: "wrap", alignItems: "center" }}>
            <Button size="small" variant="contained" disableElevation onClick={() => openBuilt(false)} disabled={!built.sessionId} data-testid="network-open" sx={{ textTransform: "none", fontWeight: 800 }}>
              {t("delivery.viewNetwork")}
            </Button>
            <Button size="small" onClick={() => openBuilt(true)} disabled={!built.sessionId} data-testid="network-adjust" sx={{ textTransform: "none", fontWeight: 700 }}>
              {t("delivery.adjustByHand", { n: built.n + 1 })}
            </Button>
            <Button
              size="small"
              startIcon={shared ? <CheckCircleOutlineIcon /> : <ContentCopyIcon />}
              onClick={async () => {
                const c = built.counts || {};
                try {
                  await navigator.clipboard.writeText(t("network.result.shareText", { routes: c.routes ?? 0, stops: c.stops ?? 0, trips: c.trips ?? 0 }));
                  setShared(true);
                } catch {
                  /* clipboard unavailable */
                }
              }}
              data-testid="network-share"
              sx={{ textTransform: "none", ml: "auto" }}
            >
              {shared ? t("network.result.shared") : t("network.result.share")}
            </Button>
          </Box>
        </Box>
      ) : (
        compile.state === "idle" && <Typography sx={{ fontSize: "0.8rem", color: "text.secondary" }}>{t("step.delivery.buildHint", { n: nextN })}</Typography>
      )}
    </Box>
  );
  const report = built?.report || null;
  const deliverablesSection = (
    <Box sx={{ display: "flex", flexDirection: "column", gap: 0.75 }}>
      <Typography sx={{ fontSize: "0.76rem", color: "text.secondary" }}>{t("delivery.list", { n: built?.n ?? nextN })}</Typography>
      <Box component="ul" data-testid="delivery-list" sx={{ m: 0, p: 0, listStyle: "none", display: "flex", flexDirection: "column", gap: 0.75 }}>
        <Box component="li" data-testid="delivery-gtfs" sx={{ display: "flex", alignItems: "center", flexWrap: "wrap", gap: 1 }}>
          <Typography sx={{ flex: 1, minWidth: 200, fontSize: "0.82rem", fontWeight: 700 }}>{t("delivery.gtfs")}</Typography>
          {!built && <Typography sx={{ fontSize: "0.74rem", color: "text.secondary" }}>{t("step.delivery.afterBuild")}</Typography>}
          <Button size="small" variant="outlined" startIcon={download.state === "running" ? <CircularProgress size={12} color="inherit" /> : <FileDownloadOutlinedIcon />} onClick={downloadGtfs} disabled={!built?.buildId || !built?.sessionId || download.state === "running"} data-testid="network-download" sx={{ textTransform: "none", fontWeight: 700 }}>
            {t("delivery.download")}
          </Button>
        </Box>
        <Box component="li" data-testid="delivery-note" sx={{ display: "flex", alignItems: "center", flexWrap: "wrap", gap: 1 }}>
          <Typography sx={{ flex: 1, minWidth: 200, fontSize: "0.82rem", fontWeight: 700 }}>{t("delivery.note")}</Typography>
          {!built && <Typography sx={{ fontSize: "0.74rem", color: "text.secondary" }}>{t("step.delivery.afterBuild")}</Typography>}
          {/* The note is written from the build's report: when it cannot be read back any more, the reason is said. */}
          {built && !report && reportMissing && <Typography data-testid="delivery-note-reason" sx={{ fontSize: "0.74rem", color: "text.secondary" }}>{t("step.delivery.noteUnavailable")}</Typography>}
          <CoherenceRunning downloads={coherenceDownloads} id="note" />
          <Button size="small" variant="outlined" startIcon={coherenceDownloads.running === "note" ? <CircularProgress size={12} color="inherit" /> : <DescriptionOutlinedIcon />} onClick={deliverNote} disabled={!report || Boolean(coherenceDownloads.running)} data-testid="delivery-note-download" sx={{ textTransform: "none", fontWeight: 700 }}>
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
      {download.state === "error" && <RefusalNotice refusal={download.error} onAction={(id) => (id === "retry" ? downloadGtfs() : id === "deliver" ? deliverEdited() : null)} supported={["retry", "deliver"]} testid="network-download-refusal" />}
    </Box>
  );

  const deliveryPrimary = builtNow
    ? { label: t("delivery.download"), onClick: downloadGtfs, disabled: !built?.sessionId, reason: t("step.reason.buildSessionGone"), busy: download.state === "running", arrow: false }
    : {
        label: ackGuard ? t("ack.build") : t("step.primary.5.create", { n: nextN }),
        onClick: () => buildAcknowledged(),
        disabled: !canBuild || validatorOff || frozen || Boolean(ackGuard && !allTicked(ackGuard.items, ackGuard.value)),
        reason: frozen ? t("step.reason.frozen", { n: frozenVersion.n }) : validatorOff ? t("step.locked.validator") : plan?.over_limit ? t("step.locked.offer") : designReason || (ackGuard ? t("step.reason.accept") : null),
        busy: compile.state === "running",
        arrow: false,
      };

  // ── The validator's section of ④ ─────────────────────────────────────────
  const dryFresh = dryRun.key === designKey;
  const dryResult = dryFresh && dryRun.state === "done" ? dryRun.result : null;
  const validatorState = validatorOff ? "unavailable" : dryRun.state === "running" && dryFresh ? "running" : dryResult ? (dryResult.validation.errors ? "errors" : "ok") : dryRun.state === "error" && dryFresh ? "unavailable" : "atBuild";
  // ④'s indicators beside the verdict: the validator, the design's quality, the network's size — as measured.
  const checksTiles = [
    validatorTile(validatorState, t, dryResult ? t("checks.kpi.validatorCounts", { errors: formatNumber(dryResult.validation.errors || 0, language), warnings: formatNumber(dryResult.validation.warnings || 0, language) }) : null),
    { id: "quality", label: t("checks.kpi.quality"), value: quality && Number.isFinite(quality.score) ? `${quality.score}/100` : "—", tone: !quality || !Number.isFinite(quality.score) ? "neutral" : quality.score >= 80 ? "ok" : quality.score >= 60 ? "warn" : "error", hint: quality?.grade ? t(`network.quality.grade.${quality.grade}`) : null },
    { id: "network", label: t("checks.kpi.network"), value: t("network.estimate.lines", { count: (spec.lines || []).length }), tone: hasLines ? "accent" : "neutral", hint: [estimate?.stops != null ? t("network.estimate.stops", { count: estimate.stops }) : t("network.estimate.stops", { count: (spec.stops || []).length }), estimate?.trips != null ? t("network.estimate.trips", { count: estimate.trips }) : null].filter(Boolean).join(" · ") },
  ];
  const validatorSection = (
    <ValidatorSection
      state={validatorState}
      text={
        validatorOff
          ? t("gtfsCheck.unavailable")
          : dryRun.state === "running" && dryFresh
            ? t("gtfsCheck.running", { seconds: checkSeconds })
            : dryResult
              ? dryResult.validation.errors
                ? t("gtfsCheck.errors", { count: dryResult.validation.errors })
                : t("gtfsCheck.ok", { errors: formatNumber(0, language), warnings: formatNumber(dryResult.validation.warnings, language), time: formatDateTime(dryRun.at, language), engine: dryResult.validation.engine || "—" })
              : dryRun.state === "error" && dryFresh
                ? null
                : t("gtfsCheck.atBuild")
      }
    >
      {dryResult && dryResult.validation.errors > 0 && (
        <Box component="ul" data-testid="checks-validator-rules" sx={{ m: 0, pl: 2.25 }}>
          {Object.entries(dryResult.validation.by_rule || {}).slice(0, 12).map(([code, count]) => (
            <Typography component="li" key={code} lang="en" sx={{ fontSize: "0.74rem", fontFamily: "monospace" }}>
              {code} ×{count}
            </Typography>
          ))}
        </Box>
      )}
      {/* A validator known to be missing here is said above; its refusal of the dry run adds nothing to it. */}
      {dryRun.state === "error" && dryFresh && !(validatorOff && dryCode.startsWith("VALIDATOR_")) && <RefusalNotice refusal={dryRun.error} onAction={(id) => id === "retry" && runDryRun()} supported={["retry", "notifyAdmin"]} testid="checks-validator-refusal" />}
    </ValidatorSection>
  );

  // The frozen design, said where the workbench is (① and ③): built in vN, read only, a new scenario to change it.
  const frozenNotice = frozen ? <Alert severity="info" data-testid="design-built" data-version={frozenVersion.n} sx={{ fontSize: "0.8rem" }}>{t("step.design.built", { n: frozenVersion.n, next: project ? nextVersionNumber(project) : frozenVersion.n + 1 })}</Alert> : null;

  let page;
  if (step === 2) {
    page = (
      <StepContract
        job="create"
        contract={contract}
        conformance={quality?.conformance}
        coverage={contractState.coverage}
        coverageState={contractState.coverageState}
        onChange={
          streaming || frozen
            ? null
            : (next) => {
                contractState.setContract(next);
                // A decision on the brief changes what "ready" means.
                setReadiness({ clean: false, reasons: [] });
              }
        }
        extract={canPlan && !frozen ? { running: streaming, error: null, onExtract: (text) => runPlan(String(text || "").trim() || t("contract.extract.default"), { extract: true }) } : null}
        brief={contractBrief}
        onBrief={contractState.setBrief}
        name={contractState.name}
        onName={contractState.setName}
        readOnly={frozen}
        onOffer={frozen ? null : contractState.setOffer}
        primary={{
          label: t("step.primary.2.create"),
          onClick: () => {
            // A frozen scenario's contract is its record: ② is read, never decided again.
            if (!frozen) contractState.proceed(contractClausesCount ? "decided" : "empty");
            onStep(3);
          },
          disabled: !frozen && !proceed.ok,
          reason: proceed.reason ? t(proceed.reason, { count: proceed.count ?? 0 }) : null,
        }}
        assumed={contractClausesCount && !frozen ? { disabled: !nameOk(contractState.name), onClick: () => { contractState.proceed("assumed"); onStep(3); } } : null}
        back={back}
        footer={buildButton}
      />
    );
  } else if (step === 3) {
    page = <StepDesign workbench={workbench} manual={manual} primary={frozen ? { label: t("scenario.newFromVersion", { n: frozenVersion.n }), onClick: newScenarioFromVersion, arrow: false } : { label: t("step.primary.3.create"), onClick: () => onStep(4), disabled: Boolean(designReason), reason: designReason }} back={back} footer={buildButton} notice={frozenNotice} />;
  } else if (step === 4) {
    page = (
      <StepChecks
        job="create"
        verdict={{ payload: quality && "verdict" in quality ? { verdict: quality.verdict } : null, measured: Boolean(quality), design: true }}
        coherence={<CoherenceReport source={coherenceSource} pending={coherencePending} note={coherenceNote} onResume={builtReadable ? resumeCoherence : null} exportSource={fileSource} labels={fileLabels} contractAdd={contractAdd} />}
        validator={validatorSection} tiles={checksTiles} primary={{ label: t("step.primary.4"), onClick: () => onStep(5), disabled: validatorOff, reason: t("step.locked.validator") }} back={back} footer={buildButton}>
        {quality ? <QualityCard quality={quality} /> : <Typography sx={{ fontSize: "0.8rem", color: "text.secondary" }}>{hasLines ? t("verdict.none") : t("step.reason.noLines")}</Typography>}
      </StepChecks>
    );
  } else if (step === 5) {
    page = <StepDelivery job="create" accept={acceptSection} act={actSection} deliverables={deliverablesSection} versions={project?.versions || []} nextVersion={nextN} primary={deliveryPrimary} back={back} note={report && builtVersion ? { versionId: builtVersion.id, build: () => ({ content: buildNetworkSynthesisHtml({ report, t, language }) }) } : null} />;
  } else {
    page = <StepNetwork job="create" name={project ? project.name : ""} onRename={project ? (name) => onUpdateProject?.({ name }) : null} workbench={workbench} documents={false} notice={frozenNotice} primary={{ label: t("step.primary.1"), onClick: () => onStep(2), disabled: !named, reason: t("step.reason.name") }} footer={buildButton} />;
  }

  return (
    <>
      {page}
      <Popover open={Boolean(optionsAnchor)} anchorEl={optionsAnchor} onClose={() => setOptionsAnchor(null)} anchorOrigin={{ vertical: "bottom", horizontal: "right" }} transformOrigin={{ vertical: "top", horizontal: "right" }} slotProps={{ paper: { sx: { p: 1.5, maxWidth: 360, borderRadius: 2 } } }}>
        <Box data-testid="network-options" sx={{ display: "flex", flexDirection: "column", gap: 1 }}>
          <Box>
            <FormControlLabel control={<Switch size="small" checked={expert} onChange={(e) => chooseExpert(e.target.checked)} inputProps={{ "data-testid": "network-expert" }} />} label={t("network.expert")} sx={{ m: 0, gap: 0.75, "& .MuiFormControlLabel-label": { fontSize: "0.8rem", fontWeight: 700 } }} />
            <Typography sx={{ fontSize: "0.72rem", color: "text.secondary", lineHeight: 1.45, pl: 5.25 }}>{t("network.expertHint")}</Typography>
          </Box>
        </Box>
      </Popover>
      {/* 409 SIMPLIFIED_BASELINE: the real network, or a study build */}
      <SimplifiedBaselineDialog
        open={Boolean(baselineGuard)}
        mode="build"
        losses={baselineGuard?.losses || null}
        feedName={spec.origin?.name || ""}
        busy={openingReal}
        error={baselineGuard ? openRealError : null}
        onConfirm={() => {
          setBaselineGuard(null);
          // A simplified baseline is built only under a person's name (2026-10-05: the server answers 400
          // ACKNOWLEDGEMENT_UNNAMED to a bare acknowledgeSimplification): the builder's, as the contract's.
          const who = [contractState.name, rememberedName(), me?.display_name].find((n) => nameOk(n));
          build({ acknowledge: true, ack: who ? { by: { name: who.trim() } } : null });
        }}
        onOpenReal={spec.origin?.url ? openRealNetwork : null}
        onClose={() => setBaselineGuard(null)}
      />
      <Snackbar open={Boolean(notice)} autoHideDuration={4000} onClose={() => setNotice(null)} message={notice || ""} anchorOrigin={{ vertical: "bottom", horizontal: "center" }} />
    </>
  );
}
