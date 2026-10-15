import React, {
  useState,
  useEffect,
  useRef,
  useCallback,
  useMemo,
  Suspense,
  lazy,
} from "react";
import "./GTFSApp.css";
import LineSelector from "./LineSelector";
import StopSearchAutocomplete from "./StopSearchAutocomplete";
import Header from "./Header/Header";
import AppShell from "./AppShell";
import StatusBar, { undeliveredEditsOf, validationCaseOf } from "./common/StatusBar";
import EditModeToggle, { DeliverButton } from "./edit/EditModeToggle";
import useElapsed from "./common/useElapsed";
import DetailPanel from "./DetailPanel";
import {
  Typography,
  Box,
  Tabs,
  Tab,
  Alert,
  TextField,
  InputAdornment,
  IconButton,
  Chip,
  Button,
} from "@mui/material";
import ScheduleIcon from "@mui/icons-material/Schedule";
import AccessibleIcon from "@mui/icons-material/Accessible";
import CircularProgress from "@mui/material/CircularProgress";
import MapIcon from "@mui/icons-material/Map";
import SearchIcon from "@mui/icons-material/Search";
import InfoOutlinedIcon from "@mui/icons-material/InfoOutlined";
import ClearIcon from "@mui/icons-material/Clear";
import DirectionsBusIcon from "@mui/icons-material/DirectionsBus";
import LinearProgress from "@mui/material/LinearProgress";
import Footer from "./Footer/Footer";
import StudioScope from "./studio/StudioScope";
import StudioTopBar from "./studio/StudioTopBar";
import Home from "./home/Home";
// The explorer's overview (its map, Leaflet) loads when a network opens: never in the app's first chunk.
const HomeDashboard = lazy(() => import("./HomeDashboard"));
import CommandPalette from "./CommandPalette";
import ShortcutsHelpDialog from "./ShortcutsHelpDialog";
import ChatAssistantFAB from "./chat/ChatAssistantFAB";
import ReaderLens from "./reader/ReaderLens";
import StepNav, { stepFor, stepHeading } from "./steps/StepNav";
import { Rail } from "./AppShell";
import { builtSessionOf, fetchNetworkReport } from "../utils/networkStudioApi";
import { latestRequest } from "../utils/latestRequest";
import { useLocation, useRoute, useNavigate, resolveRoute, explorerPath, getNetworkId, newNetworkId, documentTitle, projectPath, projectExplorerPath, modifyPath, CREATE_PATH, MODIFY_PATH, HOME_PATH } from "../utils/routes";
import { workStateOf } from "../utils/workState";
import { createProject, getProject, listProjects, updateProject, useProject, useProjectSync, withJournal, withReference, configureRemote, remoteEnabled, refreshProject, refreshProjects, deliveryOf, withDelivery, setDeliveryResolver } from "../utils/projectStore";
import { draftInProgressOf, draftKindOf, modifyProjectsOf } from "../utils/changeStates";
import { listWorkspaceProjects, getWorkspaceProject, createWorkspaceProject, patchWorkspaceProject, deleteWorkspaceProject, freezeWorkspaceVersion, deleteWorkspaceVersion, restoreWorkspaceVersion, bindWorkspaceSession } from "../utils/projectApi";
import { licenceLockOf, networkStudioOn, openPaywall, useFeatures } from "../utils/featuresApi";
import PricingDialog, { PRICING_EVENT } from "./PricingDialog";
import WorksDialog from "./home/WorksDialog";
import { useAccount } from "../contexts/AccountContext";
// Import of the advanced analysis component

import Accessibility from "./Accessibility";
// The screens a reader may never open load on demand, so Home draws without reading the whole bundle: the SQL
// console, the shape studio, a project's steps (both studios), the legal pages and the rules. Each waits behind a
// loader (Deferred). The comparison and the accessibility statement stay in the bundle: StepDelivery and the footer
// import parts of them. What the first screen never needs travels apart too: the timetable grid (PrimeReact and the
// edit dialogs), the line map (Leaflet), the diff, the share landing, the rejection page.
const ScheduleGrid = lazy(() => import("./ScheduleGrid"));
const LineMap = lazy(() => import("./LineMap"));
const FeedDiffPage = lazy(() => import("./diff/FeedDiffPage"));
const SharedFeedLanding = lazy(() => import("./share/SharedFeedLanding"));
const ValidationErrorsPage = lazy(() => import("./ValidationErrorsPage"));
const SqlConsole = lazy(() => import("./SqlConsole/SqlConsole"));
const ShapeStudio = lazy(() => import("./shapeStudio/ShapeStudio"));
const ProjectPage = lazy(() => import("./steps/ProjectPage"));
const LegalPage = lazy(() => import("./legal/LegalPage"));
const ValidationRulesPage = lazy(() => import("./rules/ValidationRulesPage"));
/** A screen loaded on demand: a thin progress bar (named by the theme's default) while its code arrives. */
const Deferred = ({ children }) => <Suspense fallback={<LinearProgress sx={{ flexShrink: 0 }} />}>{children}</Suspense>;
import API_BASE_URL from "../config";
import {
  getSessionId,
  fetchWithSession,
  newSessionId,
  setSessionId,
  PAYWALL_EVENT,
  setReaderLens,
  setDraftCapture,
  LENS_LOST_EVENT,
} from "../utils/sessionManager";
import { rememberedName } from "./common/AcknowledgementForm";
import { approvalOf, approvalRequired } from "../utils/deliverablesApi";
import { sortRoutesByPublisherOrder } from "../utils/routeSort";
import { classifyFetchError } from "../utils/scheduleErrors";
import { summarizeReport } from "../utils/validationSummary";
import { useVouchedValidation } from "../utils/vouchedValidation";
import { humanError } from "../utils/humanError";
import { formatDate, formatTime } from "../utils/formatDate";
import { useLanguage } from "../contexts/LanguageContext";
import { useEditMode } from "../contexts/EditModeContext";
import { useDetailPanel } from "../contexts/DetailPanelContext";
import { useDestructiveGuard } from "../contexts/DestructiveGuardContext";

// The explorer's tab views: route slug ↔ the index the views were built on.
const TAB_INDEX = Object.freeze({ apercu: 0, horaires: 1, traces: 3, comparer: 4 });
const TAB_SLUG = Object.freeze({ 0: "apercu", 1: "horaires", 3: "traces", 4: "comparer" });
/** Whether the address bar is on the validation page (read live: navigations can precede the render). */
const onValidationPage = () => {
  const current = resolveRoute(window.location.pathname);
  return (current.name === "explorer" || current.name === "projectExplorer") && current.params.tab === "validation";
};
// The title index.html ships (the indexed landing's, also its og preview):
// Home keeps it, only the other screens write their own.
const STATIC_TITLE = typeof document !== "undefined" && document.title ? document.title : documentTitle();
// Where the network open in this tab came from, and when it opened, kept next to its handle in the tab's
// sessionStorage (it survives a reload of the same tab, like the handle): { id, source, at }.
const NETWORK_SOURCE_KEY = "gtfs_network_source";
const NETWORK_SOURCES = Object.freeze(["catalogue", "upload", "sample", "designed", "version"]);
const rememberNetworkSource = (id, source) => {
  try {
    sessionStorage.setItem(NETWORK_SOURCE_KEY, JSON.stringify({ id, source: NETWORK_SOURCES.includes(source) ? source : null, at: new Date().toISOString() }));
  } catch {
    /* storage disabled: the origin is unknown after a reload */
  }
};
/** The origin of the network `id` ({ source, at }), or nulls when this tab does not know it. */
const networkSourceOf = (id) => {
  try {
    const kept = JSON.parse(sessionStorage.getItem(NETWORK_SOURCE_KEY) || "null");
    return kept && kept.id === id ? { source: kept.source || null, at: kept.at || null } : { source: null, at: null };
  } catch {
    return { source: null, at: null };
  }
};

function GTFSApp() {
  const baseUrl = API_BASE_URL;
  const { t, language } = useLanguage();
  const {
    dataVersion,
    editing,
    statusReady,
    exitEditMode,
    resetEditStateLocal,
    refreshStatus,
    showToast,
    touchedEntities,
    clearTouchedEntities,
    pendingEdits,
    holdEditing,
    releaseEditing,
    enterEditMode,
    editHold,
  } = useEditMode();
  const { openPanel, entity, sqlConsoleVisible, showSqlConsole, hideSqlConsole } = useDetailPanel();
  const { guard } = useDestructiveGuard();
  const LOADING_MESSAGES = [
    t("app.loadingStep1"),
    t("app.loadingStep2"),
    t("app.loadingStep3"),
  ];
  const [loading, setLoading] = useState(false);
  const [feedEpoch, setFeedEpoch] = useState(0);
  // A new network is open in this tab: a new epoch for the feed-bound views
  // and a new handle for its URLs (/r/:id/…).
  // `source` is where the network came from (catalogue | upload | sample | designed | version, null when none of
  // them — a shared copy): a project that modifies it records it as its reference's origin, with the moment it opened.
  const openedNewNetwork = (source = null) => {
    networkIdRef.current = newNetworkId();
    rememberNetworkSource(networkIdRef.current, source);
    setFeedEpoch((e) => e + 1);
  };
  const [agencies, setAgencies] = useState([]);
  const [routes, setRoutes] = useState([]);
  const [selectedRoute, setSelectedRoute] = useState(null);
  const [selectedDirection, setSelectedDirection] = useState("");
  const selectedDirectionRef = useRef("");
  // Marks the route|date combination whose directions have been resolved and
  // are now authoritative. The stops effect refuses to fetch until this key
  // matches the current selectedRoute|selectedDate, which suppresses the
  // stale-closure fetch that would fire in the same commit as a route/date
  // change (before the directions effect's setSelectedDirection settles) and
  // load the schedule grid / map twice on every filter change.
  const directionsLoadedKeyRef = useRef("");
  const [directions, setDirections] = useState([]);
  // Bumped each time directions are (re)loaded for a new route|date so the
  // stops effect refetches even when the resolved direction value is unchanged
  // — blanking selectedDirection to force a re-fire would unmount the grid+map
  // block (Leaflet re-init) and load it twice.
  const [scheduleRefetchToken, setScheduleRefetchToken] = useState(0);
  const [selectedDate, setSelectedDate] = useState("");
  const [stopsAndTimes, setStopsAndTimes] = useState({
    stops: [],
    stop_times: [],
    has_frequencies: false,
    has_normal_times: true,
    frequency_info: [],
  });
  const [shapes, setShapes] = useState({});
  const [allRouteShapes, setAllRouteShapes] = useState({});
  // (no eager /stops/all fetch: InsertStopDialog pulls the list on demand
  // when it opens, so the 6-15 MB JSON is not paid on every dataVersion bump.)
  // ── Routes (utils/routes.js) ─────────────────────────────────────────────
  // The explorer's views are routes: /r/:id/apercu (0: overview), /horaires
  // (1: schedules & map), /traces (3: shapes, edit mode only), /comparer
  // (4: compare), /sql (the SQL console) and /validation (the validation
  // page). The URL leads: a tab click, the browser's back button, a reload
  // or a sent link all land on the same view. `:id` is this tab's handle of
  // the open network (never the session id); a new network gets a new one.
  const route = useRoute();
  const navigate = useNavigate();
  const routeRef = useRef(route);
  routeRef.current = route;
  // The explorer's view: out of a project (/r/:id/…) or inside one (/p/:id/voir/…).
  const inExplorer = route.name === "explorer" || route.name === "projectExplorer";
  const view = inExplorer ? route.params.tab : null;
  // The project on screen (a step, or its explorer), and its record.
  const projectId = route.name === "project" || route.name === "projectExplorer" ? route.params.id : null;
  const [project, updateOpenProject] = useProject(projectId);
  const networkIdRef = useRef(getNetworkId());
  // ── The reader's lens: « Avant | Après » (components/reader/ReaderLens) ──
  // `draftView`: the draft of the modify project on screen, as its Change Studio publishes it (`onDraft`): { projectId,
  // previewId, operations, touched: [{ route, label, date }], simulating, applied }. « Après » (`lensSide`) makes the
  // reader read that draft through the API's lens (sessionManager.setReaderLens): every view is read again (`lensKey`)
  // and edit mode is held — a simulated draft is changed by its operations, never edited.
  const [draftView, setDraftView] = useState(null);
  const [lensSide, setLensSide] = useState("before");
  const [lensKey, setLensKey] = useState(0);
  // A plan handed over to the project already open (« Ajouter au changement »): the page reads the hand-over again.
  const [, setHandoverTick] = useState(0);
  // selectedMainTab keeps the last of the four tab views, so the SQL console
  // (shown over it, the tab content staying mounted) and the validation
  // page know where "back" is.
  const [selectedMainTab, setSelectedMainTabState] = useState(() => TAB_INDEX[view] ?? 0);
  const selectedMainTabRef = useRef(selectedMainTab);
  selectedMainTabRef.current = selectedMainTab;
  // Follows the route in the same render (not in an effect): the new view is
  // on screen when the shell moves the focus to its heading.
  const [followedView, setFollowedView] = useState(view);
  if (followedView !== view) {
    setFollowedView(view);
    if (view in TAB_INDEX) setSelectedMainTabState(TAB_INDEX[view]);
  }
  /**
   * Go to one view of the open network. Between two views of the same
   * network the entry is pushed (back returns to the previous view) and the
   * detail panel's query is kept; arriving from Home or a share landing
   * replaces the entry, so back never bounces into a screen that redirects.
   */
  const goToView = useCallback(
    (slug, { replace = false } = {}) => {
      if (!networkIdRef.current) networkIdRef.current = newNetworkId();
      const id = networkIdRef.current;
      // The address bar, not the last render: several navigations can follow
      // each other before React renders (a load, then the validation page).
      const current = resolveRoute(window.location.pathname);
      // Inside a project (a step, or its explorer), the views are the project's explorer.
      const inProject = current.name === "projectExplorer" || current.name === "project";
      if (inProject) {
        // From a step into the explorer, or between two of its views: pushed (back returns), the panel's query kept.
        const same = current.name === "projectExplorer";
        let search = "";
        if (same) {
          const params = new URLSearchParams(window.location.search);
          ["tab", "sql", "share"].forEach((name) => params.delete(name));
          search = params.toString() ? `?${params}` : "";
        }
        const state = !replace && slug === "validation" && same ? { from: current.params.tab } : undefined;
        navigate(`${projectExplorerPath(current.params.id, slug)}${search}`, { replace, state });
        return;
      }
      const sameNetwork = current.name === "explorer" && current.params.id === id;
      let search = "";
      if (sameNetwork) {
        const params = new URLSearchParams(window.location.search);
        ["tab", "sql", "share"].forEach((name) => params.delete(name));
        search = params.toString() ? `?${params}` : "";
      }
      const push = sameNetwork && !replace;
      // A pushed validation page remembers the view it was opened over: its
      // Back button then returns to that very entry (see closeValidationPage).
      const state = push && slug === "validation" ? { from: current.params.tab } : undefined;
      navigate(`${explorerPath(id, slug)}${search}`, { replace: !push, state });
    },
    [navigate],
  );
  const setSelectedMainTab = useCallback(
    (value, options) => {
      setSelectedMainTabState(value);
      goToView(TAB_SLUG[value] || "apercu", options);
    },
    [goToView],
  );
  const showValidationReport = view === "validation";
  // Opening the validation page is a navigation; closing it returns to the
  // tab it was opened over, replacing its entry (the page is gone, nothing to
  // come back to).
  const setShowValidationReport = useCallback(
    (show) => {
      if (show) {
        goToView("validation");
        return;
      }
      if (onValidationPage()) goToView(TAB_SLUG[selectedMainTabRef.current] || "apercu", { replace: true });
    },
    [goToView],
  );
  // The page's own Back button: when the entry under it is the tab it goes
  // back to (it was pushed from there, history.state.from says so), the
  // browser goes back one entry, so the history does not end up holding that
  // tab twice and the next browser Back still leads somewhere; otherwise (a
  // reload, a link, a page reached by replace) the entry is replaced.
  const closeValidationPage = useCallback(() => {
    if (!onValidationPage()) return;
    const target = TAB_SLUG[selectedMainTabRef.current] || "apercu";
    if (window.history.state?.from === target) navigate(-1);
    else goToView(target, { replace: true });
  }, [goToView, navigate]);
  const [selectedSecondaryTab, setSelectedSecondaryTab] = useState(0);
  const [selectedAgency, setSelectedAgency] = useState("");
  const [selectedRouteDetails, setSelectedRouteDetails] = useState(null);
  const [error, setError] = useState("");
  const [uploadSuccess, setUploadSuccess] = useState(false);
  const [calendar, setCalendar] = useState([]);
  const [calendarDates, setCalendarDates] = useState([]);
  const [validationReport, setValidationReport] = useState(null);
  // Every fresh report goes through here so the "modified since report"
  // markers are cleared in the same breath (the report now reflects those
  // edits).
  //
  // `startedAt` is when the validation request was issued: only edits made
  // BEFORE it are vouched for by the report, later ones stay flagged. A
  // report older than the one already adopted (two runs overlapping) is
  // ignored so a slow, outdated result can never overwrite a fresh one.
  const lastReportStartedAtRef = useRef(0);
  const adoptReport = useCallback(
    (report, startedAt = Date.now()) => {
      if (startedAt < lastReportStartedAtRef.current) return;
      lastReportStartedAtRef.current = startedAt;
      setValidationReport(report);
      clearTouchedEntities(startedAt);
    },
    [clearTouchedEntities],
  );
  const validationStale =
    Boolean(validationReport?.errors) && Object.keys(touchedEntities || {}).length > 0;
  // Counts captured when the feed was loaded — the repair-station banner
  // measures fixing progress against this baseline (never updated by
  // re-validation, only by a new feed load).
  const [validationBaseline, setValidationBaseline] = useState(null);
  // Rescue-import adjustments ({table: droppedCount}) from the last upload.
  // Fed to the AI session context so the model knows duplicate-PK findings
  // from the upload report were already resolved by the tolerant loader.
  const [importAdjustments, setImportAdjustments] = useState(null);
  const [stopFilter, setStopFilter] = useState("");
  const [focusedStopId, setFocusedStopId] = useState(null);
  // The projects: "Concevoir un réseau" (the landing
  // tile, the command palette, "gtfs:open-network-studio") goes to /creer, a
  // new project that designs a network; "Modifier ce réseau" (the overview's
  // next-step card, the palette, the chat's plan cards,
  // "gtfs:open-change-studio") to /modifier, a new project that modifies the
  // network open here — its ③, with the plan or brief handed over — or, with
  // no network open, its ① where the network is chosen. The studios are the
  // projects' steps, never a full-screen dialog; the assistant's gate is said
  // next to the assistant.
  const [networkReport, setNetworkReport] = useState(null); // the report of a network just built here (the overview's card)
  // The shared landing (/partage/:token; `?share=` redirects there).
  const shareToken = route.name === "share" ? route.params.token : null;
  const { enabled: accountEnabled, me, openAccountDialog } = useAccount();
  const { features, loaded: featuresLoaded } = useFeatures();
  // The projects are kept on the server's workspace once it says so: the browser store becomes its
  // cache, and a version is frozen from the working copy that holds it — the build's session for a network built
  // here, else this tab's when the project's network is the one open here (never another network's).
  const workspaceOn = Boolean(features?.workspace?.enabled);
  // Signed in or not, read by the store when the server does not list a project of this browser's token (kept
  // here until attached, never forgotten because the person signed in).
  const signedInRef = useRef(false);
  signedInRef.current = Boolean(me);
  useEffect(() => {
    if (!workspaceOn) return undefined;
    configureRemote({
      signedIn: () => signedInRef.current,
      list: listWorkspaceProjects,
      get: getWorkspaceProject,
      create: createWorkspaceProject,
      patch: patchWorkspaceProject,
      remove: deleteWorkspaceProject,
      freeze: freezeWorkspaceVersion,
      deleteVersion: deleteWorkspaceVersion,
      sessionOf: (p, version) => (version?.build_id ? builtSessionOf(version.build_id) : p?.network?.network_id && p.network.network_id === networkIdRef.current ? getSessionId() : null),
    });
    return () => configureRemote(null);
  }, [workspaceOn]);
  // Signing in or out changes whose projects the server lists: the works are read again.
  const signedIn = Boolean(me);
  const signedInSeen = useRef(signedIn);
  useEffect(() => {
    if (signedInSeen.current === signedIn) return;
    signedInSeen.current = signedIn;
    if (remoteEnabled()) refreshProjects();
  }, [signedIn]);
  // What a new modify project receives: { plan, brief } handed over by the chat or the Network Studio (by project id).
  const handoverRef = useRef({});
  // The Network Studio is opened only where the server offers it (NETWORK_STUDIO_ENABLED).
  const studioOffered = networkStudioOn(features);
  const openNetworkStudio = useCallback(() => {
    if (studioOffered) navigate(CREATE_PATH);
  }, [navigate, studioOffered]);
  useEffect(() => {
    const handler = () => openNetworkStudio();
    window.addEventListener("gtfs:open-network-studio", handler);
    return () => window.removeEventListener("gtfs:open-network-studio", handler);
  }, [openNetworkStudio]);
  // "Modify an existing network" without one open: a modify project, its ① chooses the network
  // (FindNetworkPanel: the published feed of the territory, or the person's own file).
  useEffect(() => {
    const handler = () => navigate(MODIFY_PATH);
    window.addEventListener("gtfs:find-network", handler);
    return () => window.removeEventListener("gtfs:find-network", handler);
  }, [navigate]);
  const feedLoadedRef = useRef(false);
  const pendingHandoverRef = useRef(null);
  // The line the person chose in the reader (the timetables' line picker, a line's detail panel) — never the line the
  // explorer picks by itself when a network opens: carried into the change as the line in focus of its maps
  // (utils/changeStates), with « Modifier ce réseau », « Reprendre » or « Retour au changement » (the reader is the
  // change's context).
  const chosenRouteRef = useRef(null); // { network: the handle it was chosen on, route: its route_id }
  const readerFocusRef = useRef(null);
  readerFocusRef.current = entity?.type === "route" && entity.id ? String(entity.id) : chosenRouteRef.current && chosenRouteRef.current.network === networkIdRef.current ? chosenRouteRef.current.route : null;
  // Back to a modify project's change (or the step it was left at: `step` null), the reader's line in focus there.
  const toChange = useCallback(
    (pid, step = 3) => {
      const focus = readerFocusRef.current;
      if (focus) handoverRef.current[pid] = { plan: null, brief: null, ...(handoverRef.current[pid] || {}), focus };
      navigate(projectPath(pid, step));
    },
    [navigate],
  );
  useEffect(() => {
    const handler = (e) => {
      const plan = e?.detail?.plan || null;
      const brief = typeof e?.detail?.brief === "string" && e.detail.brief.trim() ? e.detail.brief : null;
      // The way chosen at « Modifier » (« hand » | « brief »): the draft takes it unless it holds work of the other way.
      const kind = e?.detail?.kind === "hand" || e?.detail?.kind === "brief" ? e.detail.kind : null;
      // Every change of the network open here happens in ONE project: the one on
      // screen, else the modify project of this browser that already works on it. « Modifier ce réseau » (the status
      // bar's, the palette's) goes back to its change; a plan of the assistant joins its operations (« Ajouter au
      // changement »), a request waits in its composer — never a second project bound to the same working copy.
      const current = routeRef.current;
      const handle = networkIdRef.current;
      const onScreen = current.name === "projectExplorer" || current.name === "project" ? getProject(current.params.id) : null;
      // (« Nouveau projet », the next-step card's own choice beside « Reprendre », asks for a new one: `fresh`.)
      const fresh = Boolean(e?.detail?.fresh);
      const own = !feedLoadedRef.current ? null : onScreen?.job === "modify" && onScreen.network?.network_id === handle ? onScreen : fresh ? null : modifyProjectsOf(listProjects(), handle)[0] || null;
      if (own) {
        if (plan || brief || kind) handoverRef.current[own.id] = { plan, brief, append: Boolean(plan), focus: readerFocusRef.current, kind };
        toChange(own.id);
        if (plan) showToast(t("change.append.toast", { count: Array.isArray(plan.operations) ? plan.operations.length : 0, name: own.name }), "success");
        setHandoverTick((n) => n + 1);
        return;
      }
      const focus = feedLoadedRef.current ? readerFocusRef.current : null;
      pendingHandoverRef.current = plan || brief || focus || kind ? { plan, brief, focus, kind } : null;
      navigate(feedLoadedRef.current ? modifyPath(networkIdRef.current) : MODIFY_PATH);
    };
    window.addEventListener("gtfs:open-change-studio", handler);
    return () => window.removeEventListener("gtfs:open-change-studio", handler);
  }, [navigate, toChange, showToast, t]);
  useEffect(() => {
    feedLoadedRef.current = agencies.length > 0;
  }, [agencies]);
  // The network report on demand (the chat, the dashboard): the brief
  // re-measured on the feed as it is now, after the edits.
  useEffect(() => {
    const handler = async () => {
      const report = await fetchNetworkReport({ live: true }).catch(() => null);
      if (report) setNetworkReport(report);
      else showToast(t("network.report.none"), "info");
    };
    window.addEventListener("gtfs:open-network-report", handler);
    return () => window.removeEventListener("gtfs:open-network-report", handler);
  }, []); // eslint-disable-line react-hooks/exhaustive-deps
  // Plans & pricing, opened at the moment a limit is met (detail.reason).
  const [pricing, setPricing] = useState(null); // null | { reason }
  // The act asked without the licence, carried out by itself once the licence runs (below), forgotten when the
  // offer is closed without it.
  const pendingModifyRef = useRef(null);
  const pricingClosedAtRef = useRef(0);
  useEffect(() => {
    const handler = (e) => setPricing({ reason: e?.detail?.reason || null });
    // The paid offer (sessionManager.PAYWALL_EVENT): a locked journey, « Éditer », or the server's 402 — the same
    // offer, saying what was asked. The server's refusal coming back just after the person closed it (an autosave
    // retrying) does not reopen it; an action of the person always does.
    const paywall = (e) => {
      if (!e?.detail?.explicit && Date.now() - pricingClosedAtRef.current < 60000) return;
      if (typeof e?.detail?.resume === "function") pendingModifyRef.current = e.detail.resume;
      const entitlement = e?.detail?.entitlement;
      setPricing({ reason: entitlement === "edit" || entitlement === "deliver" ? entitlement : "studio" });
    };
    window.addEventListener(PRICING_EVENT, handler);
    window.addEventListener(PAYWALL_EVENT, paywall);
    return () => {
      window.removeEventListener(PRICING_EVENT, handler);
      window.removeEventListener(PAYWALL_EVENT, paywall);
    };
  }, []);
  // "Livrer…" asked from a step ("gtfs:deliver": a network built here and retouched since its build, 409
  // BUILD_EDITED): the export preflight of the network open here — at once in edit mode, else once it is entered.
  const deliverAfterEditRef = useRef(false);
  useEffect(() => {
    const handler = () => {
      if (editing) {
        window.dispatchEvent(new CustomEvent("gtfs:open-export-preflight"));
        return;
      }
      deliverAfterEditRef.current = true;
      window.dispatchEvent(new CustomEvent("gtfs:enter-edit-mode"));
    };
    window.addEventListener("gtfs:deliver", handler);
    return () => window.removeEventListener("gtfs:deliver", handler);
  }, [editing]);
  useEffect(() => {
    if (!editing || !deliverAfterEditRef.current) return;
    deliverAfterEditRef.current = false;
    // After the delivery button's own listener (registered when edit mode starts).
    setTimeout(() => window.dispatchEvent(new CustomEvent("gtfs:open-export-preflight")), 0);
  }, [editing]);
  // Which version a download from edit mode delivers (the version the project marks delivered is the file
  // delivered): asked by the export before it runs, so the file is named after it (`?version=N`). The
  // project that owns the network open here: with retouches standing since its last frozen version (the
  // server's count, read now), a new "delivered" version frozen from the working copy; untouched, the version
  // the working copy is (the server's binding: the one reopened, or last frozen), else its last version. A
  // shared project's version is delivered only approved: `blocked` says why the preflight cannot deliver.
  useEffect(() => {
    setDeliveryResolver(async () => {
      const current = resolveRoute(window.location.pathname);
      const pid = current.name === "project" || current.name === "projectExplorer" ? current.params.id : null;
      const record = pid ? getProject(pid) : null;
      if (!record || record.network?.network_id !== networkIdRef.current) return null;
      let edits = null;
      let base = null;
      try {
        const res = await fetchWithSession(`${baseUrl}/session/status`, { cache: "no-store" });
        if (res.ok) {
          const snapshot = (await res.json())?.snapshot || null;
          edits = snapshot?.edits_since_version ?? null;
          base = snapshot?.version_id || null;
        }
      } catch {
        edits = null;
      }
      const delivery = deliveryOf(record, edits, base);
      if (!delivery) return null;
      const status = delivery.fresh ? "none" : approvalOf(record, delivery.version_id);
      const blocked = approvalRequired(record) && status !== "approved" ? { code: "NOT_APPROVED", n: delivery.n, status } : null;
      return { ...delivery, project_id: pid, blocked };
    });
    return () => setDeliveryResolver(null);
  }, [baseUrl]);
  // A delivery downloaded (the export preflight, from edit mode) in a project that owns the network open here:
  // the version it delivers is marked delivered — a new one frozen from the working copy when retouches stood
  // after the last (the resolver above), kept as long as the project, never purged over the caps — and
  // the project records the delivery (delivery { at, by, version_id, files }). Nothing is recorded for a
  // version a shared project has not approved (the export refused it already), nor when the resolver said
  // the download delivers no version of this project.
  useEffect(() => {
    const handler = (e) => {
      const current = resolveRoute(window.location.pathname);
      const pid = current.name === "project" || current.name === "projectExplorer" ? current.params.id : null;
      const record = pid ? getProject(pid) : null;
      if (!record || record.network?.network_id !== networkIdRef.current) return;
      const said = e?.detail && "delivery" in e.detail;
      const resolved = said ? (e.detail.delivery && e.detail.delivery.project_id === pid ? e.detail.delivery : null) : deliveryOf(record, null);
      if (!resolved || resolved.blocked) return;
      if (approvalRequired(record) && (resolved.fresh || approvalOf(record, resolved.version_id) !== "approved")) return;
      const by = rememberedName() || null;
      const files = [e?.detail?.filename].filter(Boolean);
      updateProject(pid, (p) => withDelivery(p, { ...resolved, by, files }));
    };
    window.addEventListener("gtfs:delivered", handler);
    return () => window.removeEventListener("gtfs:delivered", handler);
  }, []);
  const [dataLoading, setDataLoading] = useState(false);
  const [loadingStep, setLoadingStep] = useState(0);
  const [showSelectorGuide, setShowSelectorGuide] = useState(false);

  // Listen for the custom event dispatched by ExportPreflightDialog → "Review errors"
  useEffect(() => {
    const handler = () => setShowValidationReport(true);
    window.addEventListener("gtfs:review-errors", handler);
    return () => window.removeEventListener("gtfs:review-errors", handler);
  }, [setShowValidationReport]);

  // Shape Studio (tab 3) is edit-mode-only. If the user leaves edit mode while
  // on it, drop back to Schedules & Map — the tab also disappears from Header.
  // Waits for the server's edit status: a reload on /traces in edit mode
  // must not be sent away before the status says it is still editing.
  useEffect(() => {
    if (!statusReady || editing) return;
    if (view === "traces") setSelectedMainTab(1, { replace: true });
    else if (selectedMainTab === 3) setSelectedMainTabState(1);
  }, [statusReady, editing, selectedMainTab, view, setSelectedMainTab]);

  // A guided chat repair (RepairFlow) revalidates the feed after applying a
  // fix and broadcasts the fresh report — adopt it so the header badge, the
  // validation page and the chat session context all stay in sync.
  useEffect(() => {
    const handler = (e) => {
      const report = e?.detail?.report;
      if (report && typeof report === "object") {
        adoptReport(report, e.detail.startedAt || Date.now());
      }
    };
    window.addEventListener("gtfs:validation-refreshed", handler);
    return () =>
      window.removeEventListener("gtfs:validation-refreshed", handler);
  }, [adoptReport]);

  // The SQL console and the validation page are two routes: showing one leaves the other.

  // Close the validation report when a fix navigates the user elsewhere
  // (e.g. FixInSqlConsoleButton → SQL Console). Every sender opens the SQL
  // console right after, and the console's route is pushed over the
  // validation page: that navigation leaves the page by itself and keeps it
  // in the history, so browser Back from the console returns to the report
  // (replacing the report by its tab first would leave that tab twice in
  // the history, the next Back doing nothing visible). Once the follow-up
  // had its chance, a page still showing is closed, so a sender that
  // navigates nowhere never leaves the person stuck on the report.
  useEffect(() => {
    const handler = () => setTimeout(() => setShowValidationReport(false), 0);
    window.addEventListener("gtfs:close-validation-report", handler);
    return () =>
      window.removeEventListener("gtfs:close-validation-report", handler);
  }, [setShowValidationReport]);

  useEffect(() => {
    if (!dataLoading) {
      setLoadingStep(0);
      return;
    }
    const interval = setInterval(() => {
      setLoadingStep((prev) => (prev + 1) % LOADING_MESSAGES.length);
    }, 2500);
    return () => clearInterval(interval);
  }, [dataLoading]);

  // Auto-hydration at boot: if the backend signals an active edit session
  // (via /edit/status, disk truth) and no agency is yet loaded on the frontend,
  // we auto-hydrate the agency list to exit the landing screen.
  // Without this, the user would be stuck on the uploader despite
  // their data still being present on the server.
  const hydratedFromEditRef = useRef(false);
  // True while a boot hydration runs: the route guard below waits for it
  // before deciding that an explorer URL has no network behind it.
  const hydratingRef = useRef(false);
  useEffect(() => {
    if (!statusReady) return;
    if (hydratedFromEditRef.current) return;
    if (editing && !agencies.length) {
      hydratedFromEditRef.current = true;
      hydratingRef.current = true;
      if (!networkIdRef.current) networkIdRef.current = newNetworkId();
      setDataLoading(true);
      // Reloaded on an explorer URL: stay on its view.
      fetchAgencies({ keepView: ["explorer", "project", "projectExplorer"].includes(routeRef.current.name) }).finally(() => {
        hydratingRef.current = false;
        setDataLoading(false);
        setShowSelectorGuide(false);
      });
    }
  }, [statusReady, editing]);

  // Reading hydration: a reload (or back) on /r/:id/… of the network open in
  // this tab brings it back while the server still holds its session — the
  // edit status above only covers edit mode. The heartbeat answers 404 once
  // the server swept the session; then, and for a handle that is not this
  // tab's (a link opened in another tab), the page says the network is not
  // open here and returns Home. The boot route is the one the URL leads to:
  // a short or legacy form (/r/:id, /r/:id/, /r/:id/schedules) is a redirect
  // the guard below replaces before the status is known, and the network
  // must come back on the page it lands on, not be sent Home for want of a
  // name on the first render.
  const bootRef = useRef({ route: route.redirect ? resolveRoute(route.redirect) : route, networkId: networkIdRef.current, tried: false });
  useEffect(() => {
    const boot = bootRef.current;
    if (!statusReady || boot.tried) return;
    boot.tried = true;
    if (editing) return;
    // A project names its network by the handle of the tab it was opened in: the same tab brings it back.
    const inProjectBoot = boot.route.name === "project" || boot.route.name === "projectExplorer";
    if (boot.route.name !== "explorer" && !inProjectBoot) return;
    const wanted = inProjectBoot ? getProject(boot.route.params.id)?.network?.network_id || null : boot.route.params.id;
    if (!boot.networkId || wanted !== boot.networkId) {
      if (!inProjectBoot) setError(t("explorer.notOpen"));
      return;
    }
    hydratingRef.current = true;
    setDataLoading(true);
    (async () => {
      try {
        const res = await fetchWithSession(`${baseUrl}/session/heartbeat`, { method: "POST" });
        if (!res.ok) {
          // Inside a project, the working copy that expired is said by the project's own notice, with « Reprendre ».
          if (inProjectBoot && res.status === 404) setSessionLost(true);
          else setError(t("explorer.notOpen"));
          return;
        }
        await fetchAgencies({ keepView: true });
        await refreshStatus();
      } catch {
        setError(t("explorer.notOpen"));
      } finally {
        hydratingRef.current = false;
        setDataLoading(false);
      }
    })();
    // Runs once, when the edit status is known; the rest are stable.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [statusReady, editing]);

  // ── New projects (/creer, /modifier) ────────────────────────────────────
  // Created once per visit of the address, then replaced by the project's own
  // address: back never lands on a creation. The guard only absorbs the
  // effect's second run within one visit: the route guard forgets it as soon
  // as the route is anything else, so the same address visited again in this
  // tab (Home → "Concevoir un réseau" twice, or "Modifier ce réseau" after
  // Back) starts a new project instead of rendering nothing.
  const startedRef = useRef(null);
  // A modify project whose reference is the network open here (its name, origin, opening and validation).
  const createModifyForOpenNetwork = () => {
    const handle = networkIdRef.current;
    const name = agencies[0]?.agency_name || agencies[0]?.agency_id || "";
    const summary = summarizeReport(validationReport);
    const origin = networkSourceOf(handle);
    return createProject({ job: "modify", name: t("step.defaultName.modify", { name }), network: { name, source: origin.source, opened_at: origin.at, network_id: handle, baseline_validation: summary.validated ? { errors: summary.errors, warnings: summary.warnings } : null } });
  };
  const createModifyRef = useRef(createModifyForOpenNetwork);
  createModifyRef.current = createModifyForOpenNetwork;
  const startProject = useCallback(
    (kind) => {
      const href = window.location.href;
      if (startedRef.current === href) return;
      startedRef.current = href;
      const handle = new URLSearchParams(window.location.search).get("network");
      const loaded = agencies.length > 0;
      // /creer on a server without the Network Studio: Home.
      if (kind === "create" && !networkStudioOn(features)) {
        navigate(HOME_PATH, { replace: true });
        return;
      }
      // The paid offer: a project is the subscription's work — without it, the offer instead of a project the
      // server would refuse to keep (Home stays where the person was).
      const lock = licenceLockOf(features?.access);
      if (lock === "sign_in_required" || lock === "subscription_required") {
        const asked = window.location.pathname + window.location.search;
        navigate(HOME_PATH, { replace: true });
        openPaywall("studio", lock, () => navigate(asked));
        return;
      }
      if (kind === "create") {
        const created = createProject({ job: "create", name: t("step.defaultName.create") });
        if (created) navigate(projectPath(created.id, 1), { replace: true });
        return;
      }
      // The network open here, handed over by the explorer: the project's reference, and the work starts at ③.
      if (handle && loaded && handle === networkIdRef.current) {
        const created = createModifyRef.current();
        if (created) {
          if (pendingHandoverRef.current) handoverRef.current[created.id] = pendingHandoverRef.current;
          pendingHandoverRef.current = null;
          navigate(projectPath(created.id, 3), { replace: true });
        }
        return;
      }
      const created = createProject({ job: "modify", name: t("step.defaultName.modifyNone") });
      if (created) navigate(projectPath(created.id, 1), { replace: true });
    },
    [agencies, navigate, t, features],
  );

  // ── Route guard ─────────────────────────────────────────────────────────
  // Short and unknown URLs are replaced by their full form; an explorer URL
  // with no network behind it (after the boot hydrations had their chance)
  // returns Home; a share landing with a network open shows the network
  // (Home stays « Mes travaux », the network open here listed on it); a
  // handle that is not the open network's is corrected; the validation page
  // without a report falls back to its tab.
  useEffect(() => {
    // Off /creer and /modifier, the next visit of either starts a project again.
    if (route.name !== "create" && route.name !== "modify") startedRef.current = null;
    if (route.redirect) {
      navigate(route.redirect, { replace: true });
      return;
    }
    const loaded = agencies.length > 0;
    // A new project: created, then its first step (the modify job at its ③ when the network open here is handed over).
    if (route.name === "create" || route.name === "modify") {
      // The server's access first (one light GET): under the paid offer a project is the subscription's work, and a
      // draft made before the answer would be one the server then refuses to keep.
      if (featuresLoaded) startProject(route.name);
      return;
    }
    if (route.name === "projectExplorer") {
      if (loaded) {
        if (route.params.tab === "validation" && !validationReport) goToView(TAB_SLUG[selectedMainTabRef.current] || "apercu", { replace: true });
        return;
      }
      if (!statusReady || !bootRef.current.tried || hydratingRef.current || dataLoading || editing) return;
      navigate(projectPath(route.params.id), { replace: true });
      return;
    }
    if (route.name === "explorer") {
      if (loaded) {
        const id = networkIdRef.current;
        if (id && route.params.id !== id) navigate(explorerPath(id, route.params.tab), { replace: true });
        else if (route.params.tab === "validation" && !validationReport) goToView(TAB_SLUG[selectedMainTabRef.current] || "apercu", { replace: true });
        return;
      }
      if (!statusReady || !bootRef.current.tried || hydratingRef.current || dataLoading || editing) return;
      navigate("/", { replace: true });
      return;
    }
    // Home stays Home with a network open (« Mes réseaux sans projet »); a share landing shows the network.
    if (route.name === "share" && loaded && !dataLoading) goToView(TAB_SLUG[selectedMainTabRef.current] || "apercu", { replace: true });
  }, [route, agencies.length, statusReady, dataLoading, editing, validationReport, navigate, goToView, startProject, featuresLoaded]);

  // ── The SQL console follows its route ───────────────────────────────────
  // /r/:id/sql shows it; the console can also be asked for by the assistant
  // or a validation fix (showSqlConsole), and then the route follows. Only
  // what changed since the last run leads, so the two never chase each other.
  const lastSqlSyncRef = useRef({ view, sql: sqlConsoleVisible });
  useEffect(() => {
    const last = lastSqlSyncRef.current;
    lastSqlSyncRef.current = { view, sql: sqlConsoleVisible };
    if (!inExplorer || !agencies.length) return;
    const sqlChanged = last.sql !== sqlConsoleVisible;
    if (sqlChanged && sqlConsoleVisible && view !== "sql") {
      goToView("sql");
      return;
    }
    if (last.view !== view) {
      if (view === "sql" && !sqlConsoleVisible) showSqlConsole();
      else if (view !== "sql" && sqlConsoleVisible) hideSqlConsole();
      return;
    }
    if (sqlChanged && !sqlConsoleVisible && view === "sql") goToView(TAB_SLUG[selectedMainTabRef.current] || "apercu", { replace: true });
  }, [view, sqlConsoleVisible, inExplorer, agencies.length, goToView, showSqlConsole, hideSqlConsole]);
  // A reload on /r/:id/sql: the console opens once the network is back.
  useEffect(() => {
    if (agencies.length && view === "sql" && !sqlConsoleVisible) showSqlConsole();
    // Only when the network arrives.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [agencies.length]);

  // ── Auto-pick first agency + first route on fresh data load ────────────
  // Honors the GTFS spec ordering: route_sort_order ASC NULLS LAST, then
  // route_short_name (numeric-aware) and route_id as deterministic fallbacks.
  // The downstream chain (calendar → date, directions → direction) fills the
  // rest. Armed by armAutopick() at every entry point that reloads data so
  // the user lands on a populated Schedule & Map view instead of empty
  // selectors. Once a pick is made, the ref is consumed and won't override
  // any subsequent user choice.
  const autopickAgencyRef = useRef(false);
  const autopickRouteRef = useRef(false);
  const armAutopick = () => {
    autopickAgencyRef.current = true;
    autopickRouteRef.current = true;
  };

  // Re-fetch agencies silently when dataVersion changes (e.g. after editing an agency name).
  // Only updates the list — does NOT reset selectedAgency or any downstream selection.
  // …and when the reader's lens changes (« Avant | Après »: the same list, read from the draft or the working copy).
  const dataVersionAgenciesRef = useRef(`${dataVersion}|${lensKey}`);
  useEffect(() => {
    if (`${dataVersion}|${lensKey}` === dataVersionAgenciesRef.current) return;
    dataVersionAgenciesRef.current = `${dataVersion}|${lensKey}`;
    if (!agencies.length) return; // not yet initially loaded
    const controller = new AbortController();
    fetchWithSession(`${baseUrl}/agencies`, {
      signal: controller.signal,
      cache: "no-store",
    })
      .then((r) => (r.ok ? r.json() : null))
      .then((data) => {
        if (Array.isArray(data)) setAgencies(data);
      })
      .catch((err) => {
        if (err.name !== "AbortError") {
          console.warn("Silent agencies refetch after edit failed:", err);
        }
      });
    return () => controller.abort();
  }, [dataVersion, lensKey, baseUrl]);

  // Re-fetch routes silently when dataVersion changes (undo / edit mutation).
  // Skip initial mount (dataVersion === 0) and skip when no agency is selected.
  const dataVersionRef = useRef(`${dataVersion}|${lensKey}`);
  useEffect(() => {
    if (`${dataVersion}|${lensKey}` === dataVersionRef.current) return;
    dataVersionRef.current = `${dataVersion}|${lensKey}`;
    if (!selectedAgency) return;
    const controller = new AbortController();
    // Silent re-fetch: don't reset selection, just update the list
    fetchWithSession(
      `${baseUrl}/routes/${encodeURIComponent(selectedAgency)}`,
      { signal: controller.signal, cache: "no-store" },
    )
      .then((r) => r.ok && r.json())
      .then((data) => {
        if (data) setRoutes(data);
      })
      .catch((err) => {
        if (err.name !== "AbortError") {
          console.warn("Silent route refetch after edit failed:", err);
        }
      });
    return () => controller.abort();
  }, [dataVersion, lensKey, selectedAgency, baseUrl]);

  // The full list of stops is never fetched here on a dataVersion change:
  // on large feeds (~30k stops + parent stations = 6-15 MB JSON) that would
  // cost bandwidth and parse time on every edit. Its one consumer,
  // InsertStopDialog, fetches it when it opens. allStops stays as state only
  // so ScheduleGrid still receives an array (it tolerates an empty one and
  // falls back to the route's stops).

  // Compact live-session snapshot for the AI companion: validation summary
  // (counts + top rules) and the current view. Sent with every chat turn so
  // the assistant can help repair THIS feed without copy-pasting. The
  // backend re-sanitizes everything — this is best-effort context, not API.
  const chatSessionContext = useMemo(() => {
    const tab = showValidationReport
      ? "validation"
      : ["home", "schedules", "sql", "studio", "compare"][selectedMainTab] ||
        "home";
    // Real identifiers ground the generated SQL in THIS feed (the backend
    // re-sanitizes and caps the list). Defensive Array.isArray: a backend
    // error envelope that reaches the agencies state (a failed upload-time
    // migration) must not crash the whole app.
    const agencyList = Array.isArray(agencies) ? agencies : [];
    const agencyIds = agencyList
      .map((a) => a.agency_id)
      .filter(Boolean)
      .slice(0, 10);
    const feed = agencyIds.length > 0 ? { agencyIds } : null;

    const adjustments =
      importAdjustments && Object.keys(importAdjustments).length > 0
        ? importAdjustments
        : null;

    // What is on screen: "this route" / "this stop" in a question resolves
    // to it (Ctrl+K → ask the assistant).
    const routeId =
      typeof selectedRoute === "string" ? selectedRoute : selectedRoute?.route_id || null;
    const focusParts = {
      ...(routeId ? { routeId: String(routeId) } : {}),
      ...(selectedRouteDetails?.route_short_name ? { routeName: String(selectedRouteDetails.route_short_name) } : {}),
      ...(selectedDirection !== "" && selectedDirection != null ? { directionId: String(selectedDirection) } : {}),
      ...(selectedDate ? { date: String(selectedDate).replace(/-/g, "") } : {}),
      ...(entity && entity.type && entity.id != null ? { panel: { type: String(entity.type), id: String(entity.id) } } : {}),
    };
    const focus = Object.keys(focusParts).length > 0 ? focusParts : null;

    const summary = summarizeReport(validationReport);
    if (!summary.validated) {
      if (!feed && !adjustments && !focus) return null;
      return {
        ...(feed ? { feed } : {}),
        ...(adjustments ? { importAdjustments: adjustments } : {}),
        ...(focus ? { focus } : {}),
        tab,
      };
    }
    // Import-resolved findings are excluded by summarizeReport, so the model
    // never drafts repairs for rows the tolerant loader already dropped.
    return {
      validation: {
        errors: summary.errors,
        warnings: summary.warnings,
        infos: summary.infos,
        topRules: summary.byRule.slice(0, 5),
      },
      feed,
      ...(adjustments ? { importAdjustments: adjustments } : {}),
      ...(focus ? { focus } : {}),
      tab,
    };
  }, [
    validationReport,
    showValidationReport,
    selectedMainTab,
    agencies,
    importAdjustments,
    selectedRoute,
    selectedRouteDetails,
    selectedDirection,
    selectedDate,
    entity,
  ]);

  // ── The working copy's clock ────────────────────────────────────────────
  // The server sweeps a working copy after an idle hour or two (no write, no
  // heartbeat). While a network is open this tab reads, every minute, when
  // that will be (GET /session/status: never a touch) and prolongs it by a
  // heartbeat only when the person was active since the last one — so a tab
  // forgotten overnight lets the copy go (the project's retouches frozen
  // first) and, from T-10 min, the status bar says "expire dans N min —
  // Prolonger" (a heartbeat at once). Coming back to the tab is activity. A
  // copy that is gone (404 SESSION_NOT_FOUND) is said once, in place: in a
  // project, « Reprendre » brings its frozen version back; out of one,
  // the network is said to be no longer on the server, with the ways back.
  const [sessionClock, setSessionClock] = useState(null); // { remainingMs, edits, at }
  const [sessionLost, setSessionLost] = useState(false);
  const activityRef = useRef(0);
  const lastTouchRef = useRef(Date.now());
  useEffect(() => {
    const mark = () => {
      activityRef.current = Date.now();
    };
    const events = ["pointerdown", "keydown", "wheel", "touchstart"];
    events.forEach((name) => window.addEventListener(name, mark, { passive: true }));
    return () => events.forEach((name) => window.removeEventListener(name, mark));
  }, []);
  const editsSeenRef = useRef(null);
  const pollSession = useCallback(
    async ({ touch = false } = {}) => {
      try {
        if (touch) {
          const beat = await fetchWithSession(`${baseUrl}/session/heartbeat`, { method: "POST" });
          if (beat.status === 404) {
            setSessionLost(true);
            setSessionClock(null);
            return;
          }
          lastTouchRef.current = Date.now();
        }
        const res = await fetchWithSession(`${baseUrl}/session/status`, { cache: "no-store" });
        if (res.status === 404) {
          setSessionLost(true);
          setSessionClock(null);
          return;
        }
        if (!res.ok) return;
        const body = await res.json();
        setSessionLost(false);
        const edits = body.snapshot ? body.snapshot.edits_since_version : null;
        // The retouches were frozen in a version (a snapshot): closing the tab loses nothing.
        if (edits === 0 && editsSeenRef.current > 0) window.dispatchEvent(new CustomEvent("gtfs:work-frozen"));
        editsSeenRef.current = edits;
        // `base`: the version the working copy was restored from or last frozen as (the reader in a project says it).
        setSessionClock({ remainingMs: Number(body.remaining_ms) || 0, edits, base: body.snapshot?.version_id || null, at: Date.now() });
      } catch {
        /* offline: the next minute tries again */
      }
    },
    [baseUrl],
  );
  useEffect(() => {
    if (!agencies.length) {
      setSessionClock(null);
      return undefined;
    }
    setSessionLost(false);
    let cancelled = false;
    const tick = () => {
      if (cancelled || document.hidden) return;
      pollSession({ touch: activityRef.current > lastTouchRef.current });
    };
    lastTouchRef.current = Date.now();
    tick();
    const interval = setInterval(tick, 60 * 1000);
    const onVisible = () => {
      if (!document.hidden) pollSession({ touch: true });
    };
    document.addEventListener("visibilitychange", onVisible);
    return () => {
      cancelled = true;
      clearInterval(interval);
      document.removeEventListener("visibilitychange", onVisible);
    };
  }, [agencies.length, feedEpoch, pollSession]);
  // The project's snapshots arrive with the project: read it again once its working copy's edits were frozen,
  // and the count of retouches not frozen with it (« Figer en version » is offered only while there are some).
  useEffect(() => {
    const handler = () => {
      const current = resolveRoute(window.location.pathname);
      const pid = current.name === "project" || current.name === "projectExplorer" ? current.params.id : null;
      if (pid && remoteEnabled()) refreshProject(pid);
      if (agencies.length) pollSession();
    };
    window.addEventListener("gtfs:work-frozen", handler);
    return () => window.removeEventListener("gtfs:work-frozen", handler);
  }, [agencies.length, pollSession]);

  // ── Background re-validation ───────────────────────────────────────────
  // Once a report exists and something was edited, re-run the canonical
  // validator ~25 s after the last change: findings disappear from the
  // validation page / header badge without pressing "Re-validate", and the
  // export preflight starts from a fresh report. Runs in read mode too
  // (leaving edit mode right after an edit must not freeze an old report).
  // One run at a time; a 429 / 5xx keeps the report flagged stale and
  // retries a minute later.
  const [backgroundValidating, setBackgroundValidating] = useState(false);
  const validatingSeconds = useElapsed(backgroundValidating);
  // When the report on screen arrived: the status bar's "(14:20)".
  // Derived with the report, not set by an effect after it: the render that
  // shows a new report already carries its time, so the status bar says (and
  // announces) its sentence once, with the right time.
  const reportAt = useMemo(() => (validationReport ? new Date() : null), [validationReport]);
  // When the work was last written, for the status bar's "Enregistré 14:32":
  // in edit mode every edit (and every undo) is saved on the server as it is
  // made, so the time moves with the undelivered count and the data version.
  const savedAt = useMemo(() => (editing ? new Date() : null), [editing, pendingEdits, dataVersion]); // eslint-disable-line react-hooks/exhaustive-deps
  const [revalidateRetryTick, setRevalidateRetryTick] = useState(0);
  const autoRevalidateInFlightRef = useRef(false);
  const runBackgroundValidation = useCallback(async () => {
    if (autoRevalidateInFlightRef.current) return;
    autoRevalidateInFlightRef.current = true;
    setBackgroundValidating(true);
    const startedAt = Date.now();
    let ok = false;
    try {
      const res = await fetchWithSession(`${baseUrl}/edit/validate`, {
        method: "POST",
      });
      if (res.ok) {
        const fresh = await res.json();
        if (fresh && typeof fresh === "object") {
          adoptReport(fresh, startedAt);
          ok = true;
        }
      }
    } catch (err) {
      console.warn("Background re-validation failed:", err);
    } finally {
      autoRevalidateInFlightRef.current = false;
      setBackgroundValidating(false);
      if (!ok) setTimeout(() => setRevalidateRetryTick((n) => n + 1), 60_000);
    }
  }, [baseUrl, adoptReport]);
  // A network open without a report (a project opened again, a version restored, a page reloaded): the validator runs
  // at once in the background, once per network — the overview says « validation en cours », then its verdict,
  // never « pas encore passé au validateur » beside a Diagnostic that read the same feed. Only a server
  // without the validator leaves the network unvalidated, and says so.
  const autoValidatedEpochRef = useRef(null);
  useEffect(() => {
    if (!agencies.length || validationReport || sessionLost || !featuresLoaded) return;
    if (features?.access?.validator === "unavailable" || autoValidatedEpochRef.current === feedEpoch) return;
    autoValidatedEpochRef.current = feedEpoch;
    runBackgroundValidation();
  }, [agencies.length, validationReport, sessionLost, featuresLoaded, features, feedEpoch, runBackgroundValidation]);
  useEffect(() => {
    if (!validationStale) return undefined;
    const timer = setTimeout(runBackgroundValidation, 25_000);
    return () => clearTimeout(timer);
    // dataVersion in deps: every further edit restarts the debounce window;
    // revalidateRetryTick re-arms after a failed run.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [validationStale, dataVersion, revalidateRetryTick]);
  // What an act's own run of the canonical validator said of the network as it now is (a change plan applied: the
  // commit validates the very feed it leaves): the status bar says it at once — never « à refaire » over it — and the
  // report the validation page lists, when there is one, is read again right behind it (utils/vouchedValidation).
  // Bound to the network as it is: its data version, and which network is open (another one drops it).
  const { vouched: vouchedValidation } = useVouchedValidation(`${feedEpoch}:${dataVersion}`, { onAnnounced: validationReport ? runBackgroundValidation : null });

  const handleUploadSuccess = async (data, validationReport, meta = {}) => {
    // The backend already cleaned up the edit session atomically
    // (see uploadService.js). We purely reset local state without calling
    // /edit/exit again (idempotence + avoids the upload→exit race).
    if (meta.editSessionDropped || editing) {
      resetEditStateLocal();
      if (meta.pendingEditsLost > 0) {
        showToast(
          t("upload.editSessionDropped", { count: meta.pendingEditsLost }),
          "warning",
        );
      }
    }
    if (meta.migrationFailed) {
      // The feed was accepted but gtfs.db could not be built — every read
      // fails (404). Say it once and stop here: no « importés avec succès »
      // beside it and no agencies fetched only to fail again.
      console.error("Upload migration failed:", meta.migrationError);
      showToast(t("upload.migrationFailed2"), "error");
      setDataLoading(false);
      return;
    }
    // Rescue tolerance: exact-key duplicate rows were skipped at import
    // (first occurrence kept) so the broken feed could load at all.
    const droppedTotal = Object.values(meta.importAdjustments || {}).reduce(
      (acc, n) => acc + n,
      0,
    );
    if (droppedTotal > 0) {
      showToast(
        t("upload.duplicatesDropped", { count: droppedTotal }),
        "warning",
      );
    }
    setImportAdjustments(droppedTotal > 0 ? meta.importAdjustments : null);
    setUploadSuccess(true);
    setTimeout(() => setUploadSuccess(false), 3000);
    openedNewNetwork("upload");
    setValidationReport(validationReport);
    // Baseline for the repair-progress banner — same weighted tally as every
    // other screen (see utils/validationSummary.js), not the engine's raw
    // counts, otherwise "X of Y fixed" drifts from what the page shows.
    setValidationBaseline(
      validationReport?.errors ? summarizeReport(validationReport) : null,
    );
    // Structural rejections (corrupt rows, REQUIRED_FIELDS_MISSING) have no
    // backend session — the full-screen report with "re-upload" is all we
    // can offer. Everything else, INCLUDING a feed with canonical errors,
    // has a live session (rescue flow): load the app around it.
    // `meta.projectId`: the file was chosen at ① of a modify project — it becomes the project's reference and
    // the person stays on the step (no overview, no repair station forced over it).
    const projectId = meta.projectId || null;
    if (!validationReport?.structural) {
      setDataLoading(true);
      fetchAgencies({ keepView: Boolean(projectId) })
        .then((loaded) => {
          if (projectId && loaded) adoptForProject(projectId, { name: loaded[0]?.agency_name || loaded[0]?.agency_id || meta.fileName || "", source: "upload", report: validationReport });
        })
        .finally(() => {
          setDataLoading(false);
          setShowSelectorGuide(false);
          if (projectId) return;
          setSelectedMainTab(0);
          // Rescue landing: open the repair station on top of the loaded app.
          // Set AFTER the tab reset — selecting a tab closes the report page.
          if (validationReport?.valid === false) setShowValidationReport(true);
        });
      // SQL-first: backend builds gtfs.db at upload. Pull the row counts so
      // the SQL Console "Browse files" chips light up immediately in read mode.
      refreshStatus();
    }
  };

  // ① of a modify project, "…or drop your GTFS file" (FindNetworkPanel's find-network-upload): the person's own
  // file, uploaded from the step and adopted as the project's reference (source "upload") — the uploader's drop
  // zone lives on Home only. A file the server cannot load at all, or refuses, is said in place of the step.
  const projectUploadRef = useRef(null);
  const uploadTargetRef = useRef(null);
  const uploadForProject = async (file, projectId) => {
    setDataLoading(true);
    setError("");
    let adopted = false;
    try {
      const form = new FormData();
      form.append("gtfsZip", file);
      // The project's network is uploaded under a session of its own, adopted once the server holds it: the working
      // copy open in this tab (another project's, often) is never replaced by it.
      const fresh = newSessionId();
      const res = await fetchWithSession(`${baseUrl}/upload`, { method: "POST", body: form, headers: { "X-Session-ID": fresh } });
      const body = await res.json().catch(() => null);
      if (!res.ok || !body || body.validationReport?.structural) {
        const rows = Array.isArray(body?.errors) ? body.errors : null;
        if (rows && (body.type === "REQUIRED_FIELDS_MISSING" || !body.error)) showToast(t("upload.rejectedTitle", { count: body.summary?.totalErrors ?? rows.length }), "error");
        else showToast(humanError(Object.assign(new Error(body?.message || `HTTP ${res.status}`), { code: body?.error || null, status: res.status, body: body || {} }), t).message, "error");
        return;
      }
      adopted = true;
      setSessionId(fresh);
      await handleUploadSuccess(null, body.validationReport, { editSessionDropped: Boolean(body.editSessionDropped), pendingEditsLost: body.pendingEditsLost || 0, migrationFailed: Boolean(body.migrationFailed), migrationError: body.migrationError || null, importAdjustments: body.importAdjustments || {}, projectId, fileName: String(file.name || "").replace(/\.zip$/i, "") });
    } catch (err) {
      showToast(err?.isRateLimit ? err.message : humanError(err, t).message, "error");
    } finally {
      // Once adopted, the load that follows ends the wait (handleUploadSuccess).
      if (!adopted) setDataLoading(false);
    }
  };
  const pickFileForProject = (projectId) => {
    uploadTargetRef.current = projectId;
    projectUploadRef.current?.click();
  };
  // The licence, read through a ref: an act resumed after the offer (below) runs a closure of an earlier render, and
  // must see the licence the server grants now, not the one of that render.
  const accessRef = useRef(null);
  accessRef.current = features?.access || null;
  const studioLockedNow = () => {
    const lock = licenceLockOf(accessRef.current);
    return lock === "sign_in_required" || lock === "subscription_required" ? lock : null;
  };
  // « Modifier » asked without the licence (the paid offer): the offer at once, before any network is loaded or
  // file sent (loading first, then refusing, would make no sense). The act asked is
  // kept and carried out by itself once the licence runs — a trial started or a licence bought in the offer —, the
  // offer then closing; it is forgotten when the offer is closed without the licence. `resume` null: nothing to
  // carry out (choosing a file needs the person's own click).
  const gateModify = (resume = null) => {
    const lock = studioLockedNow();
    if (!lock) return true;
    pendingModifyRef.current = resume;
    openPaywall("studio", lock, resume);
    return false;
  };
  useEffect(() => {
    if (!pendingModifyRef.current || studioLockedNow()) return;
    const resume = pendingModifyRef.current;
    pendingModifyRef.current = null;
    setPricing(null);
    resume();
  }, [features?.access]);
  const newModifyProject = () => {
    const created = createProject({ job: "modify", name: t("step.defaultName.modifyNone") });
    if (created) navigate(projectPath(created.id, 1));
    return created;
  };
  // Home's « Modifier », on a network found or on the person's file: a new modify project whose reference it becomes,
  // behind the licence's gate (`resume` carries the act out once the licence runs); the brief is asked at its ①.
  const openFromHome = (result) => {
    if (!result?.sessionId) return;
    if (!gateModify(() => openFromHome(result))) return;
    const created = newModifyProject();
    if (created) handleNetworkOpened(result, { projectId: created.id, stay: true });
  };
  const dropFromHome = (file) => {
    if (!gateModify(() => dropFromHome(file))) return;
    const created = newModifyProject();
    if (created) guard(() => uploadForProject(file, created.id), { reason: "upload" });
  };

  const handleLoadSample = async () => {
    try {
      setDataLoading(true);
      setError("");
      // Sample creates a brand-new backend session (different UUID v4).
      // If we are editing on the current session, we must explicitly
      // release its edit DB BEFORE the switch — otherwise the file stays orphaned
      // until TTL cleanup, and the frontend keeps `editing=true` incorrectly
      // on the new empty session.
      if (editing) {
        await exitEditMode();
      }
      const response = await fetchWithSession(`${baseUrl}/load-sample`);
      if (!response.ok) {
        // The server's words never reach the page as they are: a full server, the demo's own limit, else the generic sentence.
        await response.json().catch(() => null);
        setError(response.status === 503 ? t("error.human.busy") : response.status === 429 ? t("app.rateLimitSample") : t("app.errorAgencies"));
        return;
      }
      const result = await response.json();
      if (!result.sessionId) {
        setError(t("app.errorAgencies"));
        return;
      }
      setSessionId(result.sessionId);
      openedNewNetwork("sample");
      // The sample feed is trusted but may contain deliberate validator
      // findings (e.g. block-overlap trips in the NYC demo fixture). Surface
      // the baseline report to the user so there's no surprise at export time.
      if (result.validationReport) {
        setValidationReport(result.validationReport);
        setValidationBaseline(summarizeReport(result.validationReport));
      }
      await fetchAgencies();
      // SQL-first: pull row counts for the new session so SQL Console chips
      // are usable immediately in read mode.
      await refreshStatus();
    } catch (err) {
      console.error("Failed to load sample:", err);
      setError(
        err.isRateLimit ? t("app.rateLimitSample") : t("app.errorAgencies"),
      );
    } finally {
      setDataLoading(false);
    }
  };

  // A share link opened: the server built the visitor's own session from
  // the snapshot; adopt it like the sample (the explorer's URL then replaces
  // the landing's).
  const handleShareOpened = (result) => {
    if (!result?.sessionId) return;
    guard(() => adoptShare(result), { reason: "openShare" });
  };
  const adoptShare = async (result) => {
    try {
      setDataLoading(true);
      setError("");
      if (editing) await exitEditMode();
      setSessionId(result.sessionId);
      openedNewNetwork(null);
      // An "unverified" report (the validator did not run) is no verdict: none is shown.
      if (result.validationReport && !result.validationReport.unverified) {
        setValidationReport(result.validationReport);
        setValidationBaseline(summarizeReport(result.validationReport));
      } else {
        setValidationReport(null);
        setValidationBaseline(null);
      }
      setShowValidationReport(false);
      await fetchAgencies();
      await refreshStatus();
      setSelectedMainTab(0);
      showToast(t("share.opened", { title: result.share?.title || "" }), "success");
    } catch (err) {
      console.error("Failed to open the shared feed:", err);
      setError(t("app.errorAgencies"));
    } finally {
      setDataLoading(false);
    }
  };

  // A network opened for a project — built here ("Voir le réseau" at ⑤),
  // chosen from the catalogue (① of a modify project), or handed over by the
  // Network Studio (a request to modify a running network): the server
  // created a brand-new session (validated, migrated), adopted like the
  // sample. `target`:
  //   { projectId, edit }        built: the project's explorer
  //                              (/p/:id/voir/apercu) with the network report
  //                              on its overview, edit mode entered when asked
  //                              ("Retoucher à la main")
  //   { projectId, stay: true }  chosen at ①: the network is the project's
  //                              reference, the project keeps its step
  //   {}                         handed over: a new project that modifies it,
  //                              at its ③, with the brief (prefilled, not sent)
  // and `deliver: true` with `edit`: the export preflight opens once edit mode is entered (a 409 BUILD_EDITED).
  // The network open here becomes the reference of the modify project `projectId` (① "Choisir le réseau": the
  // catalogue, or the person's own GTFS file): its name, its origin, the moment it opened and its validation.
  const adoptForProject = (projectId, { name = "", source = null, report = null } = {}) => {
    const handle = networkIdRef.current;
    const summary = report && !report.unverified ? summarizeReport(report) : null;
    const origin = networkSourceOf(handle);
    // A project still named by default is named after the network chosen (« Modification — libéA Urbain »); a name
    // the person typed is theirs and stays.
    const unnamed = (p) => !String(p.name ?? "").trim() || p.name === t("step.defaultName.modifyNone");
    updateProject(projectId, (p) => withJournal({ ...withReference(p, { name: name || p.network?.name || "", source, network_id: handle, opened_at: origin.at, baseline_validation: summary?.validated ? { errors: summary.errors, warnings: summary.warnings } : null }), ...(name && p.job === "modify" && unnamed(p) ? { name: t("step.defaultName.modify", { name }) } : {}) }, { action: "network", object: source }));
  };
  const handleNetworkOpened = (result, target = {}) => {
    if (!result?.sessionId) return;
    // The network replaces the one on screen: unsaved edits go through the guard first (its own words: a build
    // makes a version of the project, it does not replace anything of it — only the copy open in this tab).
    guard(() => adoptNetwork(result, target));
  };
  const adoptNetwork = async (result, target = {}) => {
    try {
      setDataLoading(true);
      setError("");
      if (editing) await exitEditMode();
      setSessionId(result.sessionId);
      // Built here ("Voir le réseau"), else a published network (the catalogue, at ① or handed over).
      openedNewNetwork(target.projectId && !target.stay ? "designed" : "catalogue");
      // An "unverified" report (the validator did not run) is no verdict: none is shown.
      if (result.validationReport && !result.validationReport.unverified) {
        setValidationReport(result.validationReport);
        setValidationBaseline(summarizeReport(result.validationReport));
      } else {
        setValidationReport(null);
        setValidationBaseline(null);
      }
      setShowValidationReport(false);
      // The project's route leads: the overview is not forced over it.
      await fetchAgencies({ keepView: true });
      await refreshStatus();
      setSelectedMainTabState(0);
      const handle = networkIdRef.current;
      const name = result.openedFeed?.name || "";
      if (target.projectId) {
        if (target.stay) adoptForProject(target.projectId, { name, source: "catalogue", report: result.validationReport });
        else updateProject(target.projectId, (p) => ({ ...p, network: { ...(p.network || {}), network_id: handle } }));
        if (target.stay) {
          if (name) showToast(t("status.message.networkOpened", { name, routes: (result.counts?.routes ?? 0).toLocaleString(language), trips: (result.counts?.trips ?? 0).toLocaleString(language) }), "success");
          return;
        }
        // The report of the build greets the network on its overview (the stored one when the build's answer is gone).
        if (result.report) setNetworkReport(result.report);
        else fetchNetworkReport().then((r) => r && setNetworkReport(r)).catch(() => {});
        navigate(projectExplorerPath(target.projectId, "apercu"));
        // "Livrer…" after a 409 BUILD_EDITED: the export preflight opens once edit mode is entered.
        if (target.deliver) deliverAfterEditRef.current = true;
        if (target.edit) window.dispatchEvent(new CustomEvent("gtfs:enter-edit-mode"));
        return;
      }
      // Opened to be read (Home, without the studio's offer): the reader, its overview first.
      if (target.explore) {
        if (name) showToast(t("status.message.networkOpened", { name, routes: (result.counts?.routes ?? 0).toLocaleString(language), trips: (result.counts?.trips ?? 0).toLocaleString(language) }), "success");
        goToView("apercu");
        return;
      }
      // Handed over: a project that modifies this network takes over, at its change step, with the brief.
      const origin = networkSourceOf(handle);
      const baseline = result.validationReport && !result.validationReport.unverified ? summarizeReport(result.validationReport) : null;
      const created = createProject({ job: "modify", name: name ? t("step.defaultName.modify", { name }) : t("step.defaultName.modifyNone"), network: { name, source: "catalogue", opened_at: origin.at, network_id: handle, baseline_validation: baseline?.validated ? { errors: baseline.errors, warnings: baseline.warnings } : null } });
      if (created) {
        const brief = typeof result.brief === "string" && result.brief.trim() ? result.brief : null;
        if (brief) handoverRef.current[created.id] = { plan: null, brief };
        navigate(projectPath(created.id, 3));
      }
    } catch (err) {
      console.error("Failed to open the network:", err);
      setError(t("app.errorAgencies"));
    } finally {
      setDataLoading(false);
    }
  };

  // « Reprendre »: the project's working copy expired — its last frozen version comes back from its
  // zip as a new working copy (never a new download of the catalogue), the project's network from now on,
  // the person staying on the step. Resolves once the network is back; throws the server's refusal otherwise.
  const resumeProject = async (projectRecord, version) => {
    const restored = await restoreWorkspaceVersion(projectRecord.id, version.id);
    setDataLoading(true);
    setError("");
    try {
      if (editing) await exitEditMode();
      setSessionId(restored.sessionId);
      openedNewNetwork("version");
      setSessionLost(false);
      if (restored.validationReport && !restored.validationReport.unverified) {
        setValidationReport(restored.validationReport);
        setValidationBaseline(summarizeReport(restored.validationReport));
      } else {
        setValidationReport(null);
        setValidationBaseline(null);
      }
      setShowValidationReport(false);
      await fetchAgencies({ keepView: true });
      await refreshStatus();
      setSelectedMainTabState(0);
      const handle = networkIdRef.current;
      updateProject(projectRecord.id, (p) => ({ ...p, network: { ...(p.network || {}), network_id: handle } }));
    } finally {
      setDataLoading(false);
    }
    return restored;
  };

  // "Re-upload" from the repair station: through the unsaved-changes guard,
  // then back to the upload screen (agencies cleared). The previous report
  // is dropped only once the user confirmed: dropped earlier, with the
  // dashboard still on screen, it would look like a lost feed.
  const handleReupload = () => {
    guard(
      async () => {
        if (editing) await exitEditMode();
        lastReportStartedAtRef.current = 0;
        setValidationReport(null);
        setValidationBaseline(null);
        setImportAdjustments(null);
        setAgencies([]);
        setRoutes([]);
        setSelectedAgency("");
        setSelectedRoute(null);
        setSelectedRouteDetails(null);
        setSelectedMainTabState(0);
        // Home, the upload screen: the network is no longer open here.
        navigate("/");
      },
      { reason: "upload" },
    );
  };

  // `keepView`: a hydration keeps the view the URL names instead of
  // returning to the overview.
  // Resolves with the agencies read (null when the read failed), for a caller that names the network after them.
  const fetchAgencies = async ({ keepView = false } = {}) => {
    let loadedAgencies = null;
    setLoading(true);
    armAutopick();
    try {
      const response = await fetchWithSession(`${baseUrl}/agencies`);
      const data = await response.json().catch(() => null);
      // CONTRACT: `agencies` state must ALWAYS be an array. Error envelopes
      // ({error: …} on 4xx/5xx — e.g. the session DB is missing because the
      // upload-time migration failed) must surface as the error banner, never
      // be stored as state: downstream consumers (.map in chatSessionContext,
      // selectors, FAB gate) assume an array and would white-screen.
      if (!response.ok || !Array.isArray(data)) {
        console.warn(
          `GET /agencies returned ${response.status} with a non-array body:`,
          data,
        );
        throw new Error(data?.error || `HTTP ${response.status}`);
      }
      setAgencies(data);
      loadedAgencies = data;
      setRoutes([]);
      setSelectedAgency("");
      setSelectedRoute(null);
      setSelectedDirection("");
      selectedDirectionRef.current = "";
      setDirections([]);
      setSelectedDate("");
      setStopsAndTimes({
        stops: [],
        stop_times: [],
        has_frequencies: false,
        has_normal_times: true,
        frequency_info: [],
      });
      setShapes({});
      setCalendar([]);
      setCalendarDates([]);
      // Back to the overview of the network just loaded.
      if (!keepView) setSelectedMainTab(0, { replace: true });
      setError("");
    } catch (error) {
      console.error("Error fetching agencies:", error);
      if (error.isRateLimit) {
        setError(`⚠️ ${error.message}`);
      } else {
        setError(t("app.errorAgencies"));
      }
    } finally {
      setLoading(false);
    }
    return loadedAgencies;
  };

  const fetchRoutes = async (agencyId) => {
    setLoading(true);
    try {
      const response = await fetchWithSession(
        `${baseUrl}/routes/${encodeURIComponent(agencyId)}`,
      );
      if (!response.ok) {
        const errorText = await response.text();
        throw new Error(errorText);
      }
      const data = await response.json();
      setRoutes(data);
      setSelectedRoute(null);
      setSelectedDirection("");
      selectedDirectionRef.current = "";
      setDirections([]);
      setSelectedDate("");
    } catch (error) {
      console.error("Error fetching routes:", error);
      if (error.isRateLimit) {
        setError(`⚠️ ${error.message}`);
      } else {
        setError(t("app.errorRoutes"));
      }
    } finally {
      setLoading(false);
    }
  };

  const handleAgencyChange = async (e) => {
    const agencyId = e.target.value;
    setSelectedAgency(agencyId);
    await fetchRoutes(agencyId);
  };

  const handleRouteChange = async (e) => {
    const routeId = e.target.value;
    setSelectedRoute(routeId);
    // Chosen by the person: the line a change started from here puts in focus.
    chosenRouteRef.current = routeId ? { network: networkIdRef.current, route: String(routeId) } : null;
    // Do NOT blank selectedDirection / directions here: the selectedDirection
    // render gate unmounts the entire grid+map block (re-initialising Leaflet)
    // whenever it is falsy, which would make the schedule/map appear to load
    // twice on a route change. The keyRef guard in fetchStopsAndTimes already
    // blocks any stale fetch, and the directions effect re-selects the correct
    // direction (and bumps scheduleRefetchToken) once R2's directions load.
    setStopFilter("");
    // The date is kept when the route changes
    const selectedRouteDetail = routes.find(
      (route) => route.route_id === routeId,
    );
    setSelectedRouteDetails(selectedRouteDetail);
    setError("");
  };

  // Keep selectedRouteDetails in sync with the routes list after silent
  // refetches (undo/redo may revert route_short_name or route_long_name).
  useEffect(() => {
    if (!selectedRoute || !routes.length) return;
    const detail = routes.find((r) => r.route_id === selectedRoute);
    if (detail) setSelectedRouteDetails(detail);
  }, [routes, selectedRoute]);

  // Auto-pick first agency once after fresh data load.
  // Most feeds have a single agency; when several are present, fall back to
  // a numeric-aware sort on agency_id so "1, 2, 10" doesn't become "1, 10, 2".
  useEffect(() => {
    if (!autopickAgencyRef.current) return;
    if (!agencies.length) return;
    if (selectedAgency) {
      autopickAgencyRef.current = false;
      return;
    }
    const sorted = [...agencies].sort((a, b) =>
      String(a.agency_id || "").localeCompare(
        String(b.agency_id || ""),
        undefined,
        {
          numeric: true,
          sensitivity: "base",
        },
      ),
    );
    const first = sorted[0];
    if (!first) return;
    autopickAgencyRef.current = false;
    setSelectedAgency(first.agency_id);
    fetchRoutes(first.agency_id);
  }, [agencies, selectedAgency]);

  // Auto-pick first route once after fresh data load. The shared
  // sortRoutesByPublisherOrder util drives both this auto-pick and the
  // LineSelector display, so the user sees the same "first route" everywhere.
  useEffect(() => {
    if (!autopickRouteRef.current) return;
    if (!selectedAgency) return;
    if (!routes.length) return;
    if (selectedRoute) {
      autopickRouteRef.current = false;
      return;
    }
    const first = sortRoutesByPublisherOrder(routes)[0];
    if (!first) return;
    autopickRouteRef.current = false;
    setSelectedRoute(first.route_id);
    setSelectedRouteDetails(first);
    // Date and direction will be auto-filled by the existing useEffects
    // downstream (calendar load → first available date, directions fetch →
    // direction 0 if present, else first available).
  }, [selectedAgency, routes, selectedRoute]);

  // Fetch calendar data when route changes (needed for CalendarPicker)
  useEffect(() => {
    if (!selectedRoute) {
      setCalendar([]);
      setCalendarDates([]);
      return;
    }
    const controller = new AbortController();
    const fetchCalendarData = async () => {
      try {
        const [calRes, cdRes] = await Promise.all([
          fetchWithSession(
            `${baseUrl}/calendar/${encodeURIComponent(selectedRoute)}`,
            { signal: controller.signal, cache: "no-store" },
          ),
          fetchWithSession(
            `${baseUrl}/calendar_dates/${encodeURIComponent(selectedRoute)}`,
            { signal: controller.signal, cache: "no-store" },
          ),
        ]);
        if (calRes.ok) {
          setCalendar(await calRes.json());
        }
        if (cdRes.ok) {
          setCalendarDates(await cdRes.json());
        }
      } catch (err) {
        if (err.name !== "AbortError") {
          console.error("Error fetching calendar data:", err);
        }
      }
    };
    fetchCalendarData();
    return () => controller.abort();
  }, [selectedRoute, baseUrl, dataVersion, lensKey]);

  // Fetch ALL shapes for the route (across all directions) so the map can
  // display and fly-to any shape the user clicks in RouteDetail.
  useEffect(() => {
    if (!selectedRoute) {
      setAllRouteShapes({});
      return;
    }
    const controller = new AbortController();
    fetchWithSession(
      `${baseUrl}/shapes_for_route/${encodeURIComponent(selectedRoute)}`,
      { signal: controller.signal },
    )
      .then((r) => (r.ok ? r.json() : []))
      .then((items) => {
        const byId = {};
        for (const item of items) {
          byId[item.shape_id] = item.points; // already [[lat, lon], ...]
        }
        setAllRouteShapes(byId);
      })
      .catch((err) => {
        if (err.name !== "AbortError") {
          console.warn("Failed to fetch all route shapes:", err);
        }
      });
    return () => controller.abort();
  }, [selectedRoute, baseUrl, dataVersion, lensKey]);

  // Auto-select a sensible default date so the schedule grid populates
  // automatically: today if it falls within a service period (most useful
  // case), otherwise the earliest start_date or calendar_dates exception
  // available. Bails out as soon as the user picks a date.
  useEffect(() => {
    if (selectedDate) return;
    if (calendar.length === 0 && calendarDates.length === 0) return;

    const today = new Date();
    const todayStr =
      today.getFullYear().toString() +
      String(today.getMonth() + 1).padStart(2, "0") +
      String(today.getDate()).padStart(2, "0");

    // Check if today falls within any calendar period
    const todayInRange = calendar.some(
      (c) => todayStr >= c.start_date && todayStr <= c.end_date,
    );
    // Also check calendar_dates for added service today
    const todayHasException = calendarDates.some(
      (cd) => String(cd.date) === todayStr && String(cd.exception_type) === "1",
    );
    if (todayInRange || todayHasException) {
      const todayIso = `${today.getFullYear()}-${String(today.getMonth() + 1).padStart(2, "0")}-${String(today.getDate()).padStart(2, "0")}`;
      setSelectedDate(todayIso);
      return;
    }

    // Find the earliest date across calendar entries and calendar_dates
    let earliest = null;
    for (const c of calendar) {
      if (c.start_date && (!earliest || c.start_date < earliest))
        earliest = c.start_date;
    }
    for (const cd of calendarDates) {
      const d = String(cd.date);
      if (d.length === 8 && String(cd.exception_type) === "1") {
        if (!earliest || d < earliest) earliest = d;
      }
    }
    if (earliest && earliest.length === 8) {
      const iso = `${earliest.substring(0, 4)}-${earliest.substring(4, 6)}-${earliest.substring(6, 8)}`;
      setSelectedDate(iso);
    }
  }, [calendar, calendarDates, selectedDate]);

  const handleDirectionChange = (e) => {
    setSelectedDirection(e.target.value);
    selectedDirectionRef.current = e.target.value;
    setError("");
  };

  const handleDateChange = (e) => {
    setSelectedDate(e.target.value);
    setError("");
  };

  const formatDateForAPI = (date) => {
    return date.replace(/-/g, "");
  };

  // Fetch directions when route + date are both selected
  useEffect(() => {
    if (!selectedRoute || !selectedDate) return;
    // Save the current direction to restore it when still valid for the new
    // route/date. We deliberately do NOT blank selectedDirection while the new
    // directions load: the render gate would unmount the grid+map block
    // (Leaflet re-init) and flash the "select" prompt on every filter change.
    // Stale fetches are blocked by the keyRef guard instead; the refetch is
    // re-triggered via scheduleRefetchToken once the new directions resolve.
    const previousDirection = selectedDirectionRef.current;
    const controller = new AbortController();
    const fetchDirections = async () => {
      try {
        const formattedDate = formatDateForAPI(selectedDate);
        const response = await fetchWithSession(
          `${baseUrl}/directions/${encodeURIComponent(selectedRoute)}/${formattedDate}`,
          { signal: controller.signal },
        );
        if (!response.ok) {
          setDirections([]);
          return;
        }
        const data = await response.json();
        setDirections(data);
        // Directions for THIS route|date are now authoritative. Set the key
        // BEFORE setSelectedDirection(...) so the commit it triggers already
        // sees a matching key (the real, single fetch), while the same-commit
        // stale fetch was blocked because the key still held the old combo.
        directionsLoadedKeyRef.current = `${selectedRoute}|${selectedDate}`;
        // Force the stops effect to refetch for this route|date even when the
        // resolved direction value is unchanged (e.g. a date change that keeps
        // direction 0), without blanking the direction to force a re-fire.
        setScheduleRefetchToken((n) => n + 1);
        // Preserve current selection if still valid, otherwise auto-select
        const dirValues = data.map((d) =>
          d.direction_id !== null ? String(d.direction_id) : "null",
        );
        if (previousDirection && dirValues.includes(previousDirection)) {
          // Restore the previous direction — it is still valid
          setSelectedDirection(previousDirection);
          selectedDirectionRef.current = previousDirection;
        } else if (data.length >= 1) {
          // Prefer direction 0 (publisher's primary direction), else fall
          // back to the first available so the schedule grid always loads.
          const preferred = dirValues.includes("0") ? "0" : dirValues[0];
          setSelectedDirection(preferred);
          selectedDirectionRef.current = preferred;
        } else {
          setSelectedDirection("");
          selectedDirectionRef.current = "";
        }
      } catch (err) {
        if (err.name !== "AbortError") {
          console.error("Error fetching directions:", err);
          setDirections([]);
        }
      }
    };
    fetchDirections();
    return () => controller.abort();
    // The lens changed: the directions (then the trips) are read again, from the draft or the working copy.
  }, [selectedRoute, selectedDate, baseUrl, lensKey]);

  // Of overlapping timetable requests, only the newest applies its answer (utils/latestRequest): a slow answer
  // for line A landing after line B's never overwrites B's grid and shapes.
  const stopsRequestsRef = useRef(latestRequest());
  const fetchStopsAndTimes = async () => {
    // Gate: only fetch once the directions effect has confirmed this exact
    // route|date is authoritative AND a direction is selected. This blocks the
    // stale-closure fetch (old direction, new route/date) that runs in the same
    // commit as a route/date change, before the directions effect resolves,
    // and would load everything twice on every filter change.
    const directionsReady =
      directionsLoadedKeyRef.current === `${selectedRoute}|${selectedDate}`;
    if (
      !selectedRoute ||
      !selectedDirection ||
      !selectedDate ||
      !directionsReady
    )
      return;
    const formattedDate = formatDateForAPI(selectedDate);
    const current = stopsRequestsRef.current.take();
    setLoading(true);
    setError("");
    try {
      const stopsTimesResponse = await fetchWithSession(
        `${baseUrl}/stops_and_times/${encodeURIComponent(selectedRoute)}/${encodeURIComponent(selectedDirection)}/${formattedDate}`,
      );
      if (!stopsTimesResponse.ok) {
        const errorText = await stopsTimesResponse.text();
        const requestError = new Error(errorText);
        requestError.status = stopsTimesResponse.status;
        throw requestError;
      }
      const stopsTimesData = await stopsTimesResponse.json();
      if (!current()) return;
      setStopsAndTimes(stopsTimesData);

      // Shapes only decorate the map: a shapes failure must not discard the
      // schedule that just loaded, nor be reported as "no service".
      try {
        const shapesResponse = await fetchWithSession(
          `${baseUrl}/shapes/${encodeURIComponent(selectedRoute)}/${encodeURIComponent(selectedDirection)}`,
        );

        if (!shapesResponse.ok) {
          const errorText = await shapesResponse.text();
          throw new Error(errorText);
        }
        const shapesData = await shapesResponse.json();
        if (!current()) return;
        const shapesRaw = shapesData.reduce((acc, shape) => {
          if (!acc[shape.shape_id]) acc[shape.shape_id] = [];
          acc[shape.shape_id].push({
            lat: parseFloat(shape.shape_pt_lat),
            lon: parseFloat(shape.shape_pt_lon),
            seq: parseInt(shape.shape_pt_sequence, 10),
          });
          return acc;
        }, {});
        const shapesById = {};
        for (const [id, pts] of Object.entries(shapesRaw)) {
          shapesById[id] = pts
            .sort((a, b) => a.seq - b.seq)
            .map((p) => [p.lat, p.lon]);
        }
        setShapes(shapesById);
      } catch (shapesError) {
        if (!current()) return;
        console.error("Error fetching shapes:", shapesError);
        setShapes({});
      }
    } catch (error) {
      if (!current()) return;
      console.error("Error fetching route data:", error);
      const errorKind = classifyFetchError(error);
      if (errorKind === "rate-limit") {
        setError(`⚠️ ${error.message}`);
      } else if (errorKind === "no-service") {
        setError(t("app.noService"));
      } else {
        setError(t("app.errorSchedule"));
      }
      setStopsAndTimes({
        stops: [],
        stop_times: [],
        has_frequencies: false,
        has_normal_times: true,
        frequency_info: [],
      });
      setShapes({});
    } finally {
      // A newer request owns the spinner.
      if (current()) setLoading(false);
    }
  };

  // Refetch on route/direction/date change → show spinner (normal UX).
  // scheduleRefetchToken re-fires this after directions (re)load even when the
  // direction value didn't change, so the direction is never blanked (that
  // would unmount the grid+map block and reload it visibly twice).
  useEffect(() => {
    fetchStopsAndTimes();
  }, [selectedRoute, selectedDirection, selectedDate, scheduleRefetchToken]);

  // Refs so the silent-refetch effect can read the latest values without
  // listing them as deps (which would cause it to fire on route/date changes
  // instead of only on mutation/undo/redo).
  const silentRefetchRouteRef = useRef(selectedRoute);
  const silentRefetchDirectionRef = useRef(selectedDirection);
  const silentRefetchDateRef = useRef(selectedDate);
  const silentRefetchBaseUrlRef = useRef(baseUrl);
  useEffect(() => {
    silentRefetchRouteRef.current = selectedRoute;
    silentRefetchDirectionRef.current = selectedDirection;
    silentRefetchDateRef.current = selectedDate;
    silentRefetchBaseUrlRef.current = baseUrl;
  });

  // Silent refetch after edit mutations (dataVersion bump) — no spinner,
  // the grid stays visible so the user can keep editing without losing
  // scroll position or local state.
  // deps: [dataVersion] only — fires exclusively on mutation/undo/redo.
  // cache: 'no-store' — bypasses browser HTTP cache so reverted DB values
  // are never served stale after an undo.
  useEffect(() => {
    if (dataVersion === 0) return; // skip initial mount
    const route = silentRefetchRouteRef.current;
    const direction = silentRefetchDirectionRef.current;
    const date = silentRefetchDateRef.current;
    const url = silentRefetchBaseUrlRef.current;
    if (!route || !direction || !date) return;
    const formattedDate = formatDateForAPI(date);
    const controller = new AbortController();

    // Silent refetch of stops_and_times
    fetchWithSession(
      `${url}/stops_and_times/${encodeURIComponent(route)}/${encodeURIComponent(direction)}/${formattedDate}`,
      { signal: controller.signal, cache: "no-store" },
    )
      .then((r) => {
        if (r.ok) return r.json();
        // Service removed for this date (e.g. exception_type=2) → clear grid
        setStopsAndTimes({
          stops: [],
          stop_times: [],
          has_frequencies: false,
          has_normal_times: true,
          frequency_info: [],
        });
        return null;
      })
      .then((data) => {
        if (data) setStopsAndTimes(data);
      })
      .catch((err) => {
        if (err.name !== "AbortError") {
          console.warn("Silent schedule refetch after edit failed:", err);
        }
      });

    // Silent refetch of shapes (so map polylines reflect edits)
    fetchWithSession(
      `${url}/shapes/${encodeURIComponent(route)}/${encodeURIComponent(direction)}`,
      { signal: controller.signal, cache: "no-store" },
    )
      .then((r) => (r.ok ? r.json() : []))
      .then((shapesData) => {
        const shapesRaw = shapesData.reduce((acc, shape) => {
          if (!acc[shape.shape_id]) acc[shape.shape_id] = [];
          acc[shape.shape_id].push({
            lat: parseFloat(shape.shape_pt_lat),
            lon: parseFloat(shape.shape_pt_lon),
            seq: parseInt(shape.shape_pt_sequence, 10),
          });
          return acc;
        }, {});
        const updatedShapes = {};
        for (const [id, pts] of Object.entries(shapesRaw)) {
          updatedShapes[id] = pts
            .sort((a, b) => a.seq - b.seq)
            .map((p) => [p.lat, p.lon]);
        }
        setShapes(updatedShapes);
      })
      .catch((err) => {
        if (err.name !== "AbortError") {
          console.warn("Silent shapes refetch after edit failed:", err);
        }
      });

    return () => controller.abort();
  }, [dataVersion]);

  // Shape edit request: { shapeId, token } or null.
  // Geometry editing lives in the dedicated Shape Studio tab. The read panels
  // (RouteDetail / ShapeDetail) still dispatch editShape / createShape, so we
  // reroute those events INTO Shape Studio with the line + shape (or create
  // intent) armed — instead of editing in the read-only Schedules & Map map.
  const [studioTarget, setStudioTarget] = useState(null);
  const studioTargetTokenRef = useRef(0);
  const selectedAgencyRef = useRef(selectedAgency);
  selectedAgencyRef.current = selectedAgency;
  const selectedRouteRef = useRef(selectedRoute);
  selectedRouteRef.current = selectedRoute;

  useEffect(() => {
    const handleEditShape = (e) => {
      const shapeId = e.detail?.shapeId;
      if (!shapeId) return;
      setStudioTarget({
        agencyId: e.detail?.agencyId || selectedAgencyRef.current,
        routeId: e.detail?.routeId || selectedRouteRef.current,
        shapeId,
        autoEdit: true,
        token: ++studioTargetTokenRef.current,
      });
      setSelectedMainTab(3);
    };
    const handleCreateShape = (e) => {
      const {
        shapeId,
        initialPoints,
        linkTripIds,
        routeId,
        agencyId,
        fitStops,
        directionId,
      } = e.detail || {};
      if (!shapeId) return;
      setStudioTarget({
        agencyId: agencyId || selectedAgencyRef.current,
        routeId: routeId || selectedRouteRef.current,
        create: {
          shapeId,
          initialPoints: initialPoints || [],
          linkTripIds: linkTripIds || [],
          fitStops: fitStops || null,
          directionId: directionId ?? null,
        },
        token: ++studioTargetTokenRef.current,
      });
      setSelectedMainTab(3);
    };
    window.addEventListener("editShape", handleEditShape);
    window.addEventListener("createShape", handleCreateShape);
    return () => {
      window.removeEventListener("editShape", handleEditShape);
      window.removeEventListener("createShape", handleCreateShape);
    };
  }, [setSelectedMainTab]);

  // View-level navigation requested by the chat assistant ("show route 12",
  // "open the shape studio"): {target: schedule|shape_studio|home, routeId?,
  // agencyId?}. Entity panels are opened by the chat itself.
  const routesRef = useRef(routes);
  routesRef.current = routes;
  const editingRef = useRef(editing);
  editingRef.current = editing;
  useEffect(() => {
    const selectRoute = async (routeId, agencyId) => {
      if (!routeId) return;
      if (agencyId && agencyId !== selectedAgencyRef.current) {
        setSelectedAgency(agencyId);
        try {
          const response = await fetchWithSession(
            `${baseUrl}/routes/${encodeURIComponent(agencyId)}`,
          );
          if (response.ok) {
            const data = await response.json();
            setRoutes(data);
            setSelectedRouteDetails(data.find((r) => r.route_id === routeId) || null);
          }
        } catch (err) {
          console.error("Error fetching routes for navigation:", err);
        }
      } else {
        setSelectedRouteDetails(
          routesRef.current.find((r) => r.route_id === routeId) || null,
        );
      }
      if (routeId !== selectedRouteRef.current) {
        setSelectedRoute(routeId);
        setSelectedDirection("");
        selectedDirectionRef.current = "";
        setDirections([]);
        setStopFilter("");
        setError("");
      }
    };
    const handler = async (e) => {
      const d = e.detail || {};
      if (d.target === "home") {
        setShowValidationReport(false);
        setSelectedMainTab(0);
        return;
      }
      if (d.target === "schedule") {
        setShowValidationReport(false);
        await selectRoute(d.routeId, d.agencyId);
        const day = String(d.date || "").replace(/-/g, "");
        if (/^\d{8}$/.test(day)) setSelectedDate(`${day.slice(0, 4)}-${day.slice(4, 6)}-${day.slice(6, 8)}`);
        setSelectedMainTab(1);
        return;
      }
      if (d.target === "shape_studio") {
        setShowValidationReport(false);
        if (!editingRef.current) {
          showToast(t("chat.nav.needsEditMode"), "warning");
          await selectRoute(d.routeId, d.agencyId);
          setSelectedMainTab(1);
          return;
        }
        setStudioTarget({
          agencyId: d.agencyId || selectedAgencyRef.current,
          routeId: d.routeId || selectedRouteRef.current,
          token: ++studioTargetTokenRef.current,
        });
        setSelectedMainTab(3);
      }
    };
    window.addEventListener("gtfs:navigate", handler);
    return () => window.removeEventListener("gtfs:navigate", handler);
    // Setters and refs are stable; baseUrl/showToast/t are constants of the app.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [baseUrl, showToast, t]);

  // Navigate to a different route when the detail panel targets a shape
  // from another route (e.g. clicking a shape chip in another route's RouteDetail).
  // entity.data carries { routeId, agencyId, directionId } set by the originating component.
  useEffect(() => {
    if (entity?.type !== "shape" || !entity.data?.routeId) return;
    const { routeId, agencyId, directionId } = entity.data;
    if (routeId === selectedRoute) return;

    const switchRoute = async () => {
      // Switch agency if needed (fetch its routes without resetting selection)
      if (agencyId && agencyId !== selectedAgency) {
        setSelectedAgency(agencyId);
        try {
          const response = await fetchWithSession(
            `${baseUrl}/routes/${encodeURIComponent(agencyId)}`,
          );
          if (response.ok) {
            const data = await response.json();
            setRoutes(data);
            setSelectedRouteDetails(
              data.find((r) => r.route_id === routeId) || null,
            );
          }
        } catch (err) {
          console.error("Error fetching routes for agency switch:", err);
        }
      } else {
        setSelectedRouteDetails(
          routes.find((r) => r.route_id === routeId) || null,
        );
      }

      setSelectedRoute(routeId);
      // Preselect the direction that contains the target shape;
      // the directions fetch effect will preserve it if valid.
      const targetDir = directionId != null ? String(directionId) : "";
      setSelectedDirection(targetDir);
      selectedDirectionRef.current = targetDir;
      setDirections([]);
      setStopFilter("");
      setError("");
    };
    switchRoute();
  }, [entity, selectedRoute, selectedAgency, baseUrl, routes]);

  // Auto-switch to map tab when a shape is focused in the detail panel
  useEffect(() => {
    if (entity?.type === "shape") {
      setSelectedSecondaryTab(1);
    }
  }, [entity]);

  // Whether a project of this browser records the network open here as its own (Home then lists it with the project).
  const projectOwning = (handle) => Boolean(handle) && listProjects().some((p) => p.network?.network_id === handle);

  // ── The reader's lens (« Avant | Après ») ───────────────────────────────
  // The project on screen owns the network open here (its handle) and its working copy is alive.
  const ownsOpenNetwork = Boolean(project?.network?.network_id && project.network.network_id === networkIdRef.current && agencies.length > 0 && !sessionLost);
  // The lens is offered where the draft it shows belongs: the project's own reader (/p/:id/voir), full width — ③
  // reads the draft at its own centre, one line at a time (ChangeReview), and opens this reader on
  // « Après » for the whole network (« Pleine largeur »).
  const lensVisible = Boolean(project?.job === "modify" && ownsOpenNetwork && route.name === "projectExplorer" && draftView?.projectId === project.id);
  // ── One screen for a modification: the project's reader with the panel « Modifications » (2026-10-13) ──
  // A modify project whose network is open here is its reader (/p/:id/voir/…) with the Change Studio as its right
  // panel; its steps' addresses lead there (① and ② open the brief's dialog, ⑤ the decision's, by ?ouvrir=…). Without
  // its network, ① stays the page that chooses it (or brings its last version back).
  const draftScreen = route.name === "projectExplorer" && project?.job === "modify" && ownsOpenNetwork;
  // The draft's kind: by hand, the reader is its editor; with a brief (or before the person chose), it is read only.
  const draftKind = draftScreen ? draftKindOf(project) : null;
  const draftScreenRef = useRef(draftScreen);
  draftScreenRef.current = draftScreen;
  // The draft is what the screen shows and edits: « Après » on arriving (« Avant » stays one click away, read only).
  useEffect(() => {
    if (draftScreen) setLensSide("after");
  }, [draftScreen]);
  // Its retouches are captured, never written to the working copy (utils/sessionManager setDraftCapture, the API's
  // transform/draftCapture): on the draft as simulated (its preview), or on the working copy while the draft holds
  // no operation (or none that changes anything). Nothing is captured while it is simulated again, once it is applied
  // (a new change starts from vN), or on « Avant ».
  const captureId = draftScreen && draftKind === "hand" && lensSide === "after" && draftView?.projectId === project?.id && !draftView?.applied ? draftView.previewId || (!draftView.simulating ? "base" : null) : null;
  useEffect(() => {
    setDraftCapture(captureId);
  }, [captureId]);
  useEffect(() => () => setDraftCapture(null), []);
  // Edit mode is the draft's own there: on while the draft can be retouched (no « Éditer » to press), held otherwise
  // with its reason; left with the draft (the reader outside it reads, its « Modifier » opens the draft again).
  const draftHold = draftScreen && !captureId ? (draftKind !== "hand" ? "draft.hold.brief" : draftView?.applied ? "draft.hold.applied" : lensSide === "before" ? "draft.hold.before" : "draft.hold.simulating") : null;
  useEffect(() => {
    if (!draftScreen) return;
    if (captureId) releaseEditing();
    else if (draftHold) holdEditing(draftHold);
    // The capture and its hold lead.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [draftScreen, captureId, draftHold]);
  // Once the hold is lifted (a render later), edit mode comes on by itself.
  useEffect(() => {
    if (draftScreen && captureId && !editHold && !editing) enterEditMode({ quiet: true });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [draftScreen, captureId, editHold, editing]);
  const wasDraftScreen = useRef(false);
  useEffect(() => {
    if (wasDraftScreen.current && !draftScreen) {
      releaseEditing();
      if (editing) exitEditMode();
    }
    wasDraftScreen.current = draftScreen;
    // Left once: the screen's own change leads.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [draftScreen]);
  // The draft's two views (« Réseau »: the reader full page; « Changement »: the change's desk), per project; until the
  // person picks one, the Change Studio picks it from what the draft holds (a brief: « Changement »).
  const [draftViews, setDraftViews] = useState({});
  const draftViewMode = project ? draftViews[project.id] || null : null;
  const draftViewShown = draftViewMode || "network";
  // On the reader out of a project: the draft already in progress on this network, which « Modifier » resumes.
  const readerDraftKind = route.name === "explorer" && agencies.length ? draftInProgressOf(modifyProjectsOf(listProjects(), networkIdRef.current)[0] || null) : null;
  const projectIdNow = project?.id || null;
  const setDraftViewMode = useCallback((v) => {
    if (projectIdNow) setDraftViews((m) => (m[projectIdNow] === v ? m : { ...m, [projectIdNow]: v }));
  }, [projectIdNow]);
  const [draftBarHost, setDraftBarHost] = useState(null);
  const [draftHeaderHost, setDraftHeaderHost] = useState(null);
  const location = useLocation();
  const PANEL_OPEN = { cahier: "brief", objectifs: "objectives", livraison: "apply" };
  const panelAsked = draftScreen ? PANEL_OPEN[new URLSearchParams(location.search).get("ouvrir")] || null : null;
  useEffect(() => {
    if (!project || project.job !== "modify" || dataLoading) return;
    if (route.name === "project" && ownsOpenNetwork) {
      const n = Number(route.params.step) || null;
      const open = n === 2 ? "objectifs" : n >= 4 ? "livraison" : null;
      navigate(`${projectExplorerPath(project.id, TAB_SLUG[selectedMainTabRef.current] || "apercu")}${open ? `?ouvrir=${open}` : ""}`, { replace: true });
    } else if (route.name === "projectExplorer" && !ownsOpenNetwork && !agencies.length) {
      // The project's reader without its network (a reload, a link): its page brings the last version back, or asks it.
      navigate(projectPath(project.id, 1), { replace: true });
    }
    // The address and the ownership lead; the tab is read when they change.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [route.name, route.params?.step, project?.id, project?.job, ownsOpenNetwork, dataLoading, agencies.length]);
  const lensPreview = lensVisible && lensSide === "after" && draftView?.previewId ? draftView.previewId : null;
  const lensSetRef = useRef(null);
  useEffect(() => {
    if (lensSetRef.current === lensPreview) return;
    lensSetRef.current = lensPreview;
    setReaderLens(lensPreview);
    setLensKey((k) => k + 1);
    if (draftScreenRef.current) return;
    if (lensPreview) {
      // A draft is changed by its operations: edit mode is left and held while « Après » shows (the retouches made
      // so far stay in the working copy, « Avant »).
      holdEditing("lens.editHold");
      if (editing) exitEditMode();
    } else releaseEditing();
    // The lens alone leads; edit mode is read when it changes.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [lensPreview]);
  // Another project (or none): the lens is « Avant » again. Between a project's steps and its reader the side is kept.
  const lensProjectRef = useRef(projectId);
  useEffect(() => {
    if (lensProjectRef.current === projectId) return;
    lensProjectRef.current = projectId;
    setLensSide(draftScreenRef.current ? "after" : "before");
  }, [projectId]);
  // ③'s « Ouvrir dans le lecteur » (ChangeReview): the project's reader, full width, on « Après » — at the line and on a
  // date a change shows on, when one is named.
  const openReader = useCallback(
    (pid, line = null) => {
      setLensSide("after");
      navigate(projectExplorerPath(pid, line?.route ? "horaires" : "apercu"));
      if (line?.route) setTimeout(() => window.dispatchEvent(new CustomEvent("gtfs:navigate", { detail: { target: "schedule", routeId: line.route, date: line.date || null } })), 0);
    },
    [navigate],
  );
  // The draft the reader looked at is no longer simulated (expired, or the working copy changed since): back to the
  // working copy, said once per draft, and the change is simulated again (ChangeStudio listens).
  const lensLostRef = useRef(new Set());
  useEffect(() => {
    const handler = (e) => {
      const id = e?.detail?.previewId || null;
      if (!id || lensLostRef.current.has(id)) return;
      lensLostRef.current.add(id);
      setLensSide("before");
      // « Après » waits for the next simulation (③ runs it again; elsewhere it is offered again once ③ has).
      setDraftView((d) => (d && d.previewId === id ? { ...d, previewId: null, simulating: false } : d));
      showToast(t(e.detail.code === "PREVIEW_STALE" ? "lens.lost.stale" : "lens.lost"), "info");
      window.dispatchEvent(new CustomEvent("gtfs:resimulate"));
    };
    window.addEventListener(LENS_LOST_EVENT, handler);
    return () => window.removeEventListener(LENS_LOST_EVENT, handler);
  }, [showToast, t]);
  // On the timetable of a line the draft changes: its trips before → after (the working copy read without the lens,
  // the draft through it), the new ones marked in the grid — what a map cannot show of a change of service.
  const touchedSig = (draftView?.touched || []).map((l) => String(l.route)).join("|");
  const [lensCompare, setLensCompare] = useState(null);
  useEffect(() => {
    setLensCompare(null);
    if (!lensPreview || !selectedRoute || !selectedDirection || !selectedDate) return undefined;
    if (!touchedSig.split("|").includes(String(selectedRoute))) return undefined;
    const controller = new AbortController();
    const path = `${baseUrl}/stops_and_times/${encodeURIComponent(selectedRoute)}/${encodeURIComponent(selectedDirection)}/${selectedDate.replace(/-/g, "")}`;
    const read = (headers) =>
      fetchWithSession(path, { signal: controller.signal, ...(headers ? { headers } : {}) })
        .then((r) => (r.ok ? r.json() : null))
        .catch(() => null);
    const tripsOf = (body) => new Set((body?.stop_times || []).map((st) => String(st.trip_id)));
    // An explicit empty lens reads the working copy (sessionManager leaves a caller's own lens as it is).
    Promise.all([read({ "X-View-Preview": "" }), read(null)]).then(([base, draft]) => {
      if (controller.signal.aborted) return;
      const before = tripsOf(base);
      const after = tripsOf(draft);
      setLensCompare({ route: String(selectedRoute), before: before.size, after: after.size, added: new Set([...after].filter((id) => !before.has(id))), removed: [...before].filter((id) => !after.has(id)).length });
    });
    return () => controller.abort();
  }, [lensPreview, selectedRoute, selectedDirection, selectedDate, touchedSig, baseUrl]);
  const markedRoutes = useMemo(() => (lensVisible && touchedSig ? new Set(touchedSig.split("|")) : null), [lensVisible, touchedSig]);
  const lensCompareShown = lensCompare && lensPreview && lensCompare.route === String(selectedRoute) ? lensCompare : null;
  // The working copy of the project's reader is bound to the project on the server (its edits frozen as versions),
  // as its steps bind it: the reader is where retouches are made.
  const boundReaderRef = useRef(null);
  useEffect(() => {
    if (route.name !== "projectExplorer" || !project || !ownsOpenNetwork || !remoteEnabled()) return;
    const key = `${project.id}:${networkIdRef.current}`;
    if (boundReaderRef.current === key) return;
    boundReaderRef.current = key;
    bindWorkspaceSession(project.id).catch(() => {
      boundReaderRef.current = null;
    });
  }, [route.name, project, ownsOpenNetwork]);
  // ── Dossier automatique: every modification happens in a project ──
  // Asking for edit mode on a network no project of this browser holds (the reader out of any project) puts it in one
  // first — the modify project that already works on it, else a new one —, in the same view of its own reader: its
  // retouches join the project's journal, its versions and its one delivery. Synchronous (EditModeToggle asks, then
  // enters). Without the studio's offer, the retouches stay outside a project.
  const featuresRef = useRef(features);
  featuresRef.current = features;
  useEffect(() => {
    const handler = () => {
      const current = routeRef.current;
      const handle = networkIdRef.current;
      if (!handle || !feedLoadedRef.current || current.name !== "explorer") return;
      const lock = licenceLockOf(featuresRef.current?.access);
      if (lock === "sign_in_required" || lock === "subscription_required") return;
      const existing = modifyProjectsOf(listProjects(), handle)[0] || null;
      const target = existing || createModifyRef.current();
      if (!target) return;
      // Editing in the reader is the draft's work by hand.
      handoverRef.current[target.id] = { ...(handoverRef.current[target.id] || {}), kind: "hand" };
      const tab = current.params.tab in TAB_INDEX || current.params.tab === "sql" ? current.params.tab : "apercu";
      navigate(projectExplorerPath(target.id, tab));
      showToast(t(existing ? "dossier.joined" : "dossier.created", { name: target.name }), "info");
    };
    window.addEventListener("gtfs:before-edit", handler);
    return () => window.removeEventListener("gtfs:before-edit", handler);
  }, [navigate, showToast, t]);

  // ── The chrome: title, top bar, status bar ──────────────────────────────
  const networkName = agencies[0]?.agency_name || agencies[0]?.agency_id || "";
  const viewLabels = {
    apercu: t("explorer.overview"),
    horaires: t("header.tabSchedules"),
    traces: t("explorer.shapes"),
    sql: t("sqlConsole.headerBtn"),
    comparer: t("compare.tab"),
    validation: t("explorer.validation"),
  };
  // Inside a project: its step ("Étape 3 sur 5 : Changement — Rentrée 2026 — GTFS Express"), or its explorer.
  const projectStep = route.name === "project" ? route.params.step || project?.step || 1 : null;
  const stepJob = project?.job === "modify" ? "modify" : "create";
  // One title per screen (RGAA 8.6): the screen, then its object, then the product.
  const pageTitle =
    route.name === "legal"
      ? documentTitle(t(`legal.tab.${route.params.tab}`))
      : route.name === "rules"
        ? documentTitle(t("rules.title"))
        : route.name === "accessibility"
          ? documentTitle(t("a11y.statement"))
          : route.name === "share"
            ? documentTitle(t("share.landingKicker"))
            : route.name === "project" && project
              ? documentTitle(stepHeading(t, stepFor(projectStep || 1, stepJob), stepJob), project.name)
              : route.name === "project"
                ? documentTitle(t("refusal.PROJECT_NOT_FOUND.title"))
                : inExplorer && agencies.length
                  ? documentTitle(viewLabels[view], route.name === "projectExplorer" && project ? project.name : networkName)
                  : route.name === "home"
                    ? documentTitle(t("home.projects"))
                    : STATIC_TITLE;
  const routeKey = route.name === "legal" ? `conditions/${route.params.tab}` : inExplorer ? `${route.params.id}/${view}` : route.name === "project" ? `p/${route.params.id}/${projectStep}` : route.name || "redirect";
  // In a project, the mode and the delivery belong to its network once it is the one open here.
  // A project owns the network open here only when it is its own (the handle it recorded), whatever its job: a
  // modify project whose tab now holds another network must not show that network's mode nor deliver it.
  const projectOwnsNetwork = !project || Boolean(project.network?.network_id && project.network.network_id === networkIdRef.current);
  // The work's identity in the top bar of the reader and of a project's steps (Header/BarParts): a project's name,
  // renamed in place — the network's name is already the page's (the overview's title, the timetables' agency). Its
  // state stands in the status bar beside the mode, so that the top bars keep their room for the tools. The state: the
  // network read as it is, or the project's draft — its operations not applied and the retouches since its last
  // version (the server's count) —, the change applied in vN, a version delivered. The state leads to where its
  // work is done: the change (③) while something is in progress, the delivery (⑤) once a version holds it.
  const workState = workStateOf({ project, networkLoaded: agencies.length > 0 && !sessionLost, ownsNetwork: Boolean(project) && projectOwnsNetwork, edits: sessionClock?.edits || 0, baseVersionId: sessionClock?.base || null });
  const openWork = project && workState ? () => navigate(projectPath(project.id, workState.kind === "applied" || workState.kind === "version" ? 5 : 3)) : null;
  const work = project ? { name: String(project.name ?? "").trim(), onRename: (name) => updateOpenProject({ name }) } : null;
  const statusWork = workState ? { state: workState, onOpen: openWork } : null;
  const projectSync = useProjectSync(project?.id || null);
  // From T-10 min the status bar says when the working copy expires, with "Prolonger" (a heartbeat at once).
  const sessionMinutes = agencies.length && !sessionLost && sessionClock && sessionClock.remainingMs <= 10 * 60 * 1000 ? Math.max(0, Math.ceil(sessionClock.remainingMs / 60000)) : null;
  const showNetworkCases = agencies.length > 0 && projectOwnsNetwork;
  const reportSummary = summarizeReport(validationReport);
  // The validation case: an act's own run on the network as it now is (an application) over a report read again.
  const validationCase = validationCaseOf({ running: backgroundValidating, summary: reportSummary, stale: validationStale, at: reportAt, unavailable: features?.access?.validator === "unavailable", vouched: vouchedValidation });
  // Home is the screen shown (the same test as the screens' choice below): it is edge to edge.
  const homeShown = !["legal", "rules", "accessibility", "project", "create", "modify"].includes(route.name) && !dataLoading && !(validationReport?.valid === false && validationReport?.structural) && (route.name === "home" || (!agencies.length && !shareToken));
  const statusBar = (
    <StatusBar
      network={showNetworkCases ? { name: networkName } : project ? { name: project.network?.name || project.name } : null}
      mode={showNetworkCases && !draftScreen ? (editing ? "edit" : "read") : null}
      work={statusWork}
      // On a project's steps the acts are the project's own (⑤ applies and delivers, the scenario undoes): the bar
      // says the mode and holds no edit toggle nor « Livrer… » there; the reader
      // inside a project (/p/:id/voir) keeps them for its retouches. Both stay mounted silent there: ⑤'s « Livrer »
      // opens the export preflight by `gtfs:open-export-preflight`, the palette enters edit mode by its event.
      modeControls={showNetworkCases ? (route.name === "project" ? <><EditModeToggle silent /><DeliverButton silent /></> : <EditModeToggle />) : null}
      // In a project whose working copy the server binds to its versions, an edit frozen in a version is not « non
      // livrée »: the version case says whether that version is delivered and the retouches no version holds yet.
      pendingEdits={undeliveredEditsOf({ pendingEdits, unfrozenEdits: sessionClock ? sessionClock.edits : null, inProject: Boolean(project && projectOwnsNetwork) })}
      savedAt={savedAt}
      onOpenJournal={() => openPanel("edit_history", "history")}
      validation={showNetworkCases ? { ...validationCase, seconds: validatingSeconds } : null}
      onOpenValidation={showNetworkCases && reportSummary.validated ? () => setShowValidationReport(true) : undefined}
      deliver={showNetworkCases && route.name !== "project" && !draftScreen ? <DeliverButton /> : null}
      // In the Network Studio the account is its bar's (the avatar): the bar of state does not repeat it.
      user={accountEnabled && route.name !== "project" ? (me ? { name: me.display_name || me.email } : { anonymous: true }) : null}
      onUser={() => openAccountDialog()}
      projectSave={projectSync ? { state: projectSync.state, at: projectSync.saved_at || null } : null}
      session={sessionMinutes !== null ? { minutes: sessionMinutes, onExtend: () => pollSession({ touch: true }) } : null}
    />
  );
  // The terms and contact line, in the flow under the status bar (never a
  // fixed footer over the page).
  const legal = (
    <Box sx={{ "& .footer": { position: "static", margin: 0, padding: "2px 8px", boxShadow: "none", borderTop: "none" } }}>
      <Footer compact={route.name === "project"} />
    </Box>
  );

  // The reader's views (the overview, timetables and map, shapes, comparison, the SQL console over them).
  const readerBody = () => (
    <>
      {/* The working copy is gone: said in place with the ways back — the project's « Reprendre »
          (its frozen version) inside a project, else Home (the file, the catalogue). */}
      {sessionLost && (
        <Alert
          severity="warning"
          data-testid="session-expired"
          sx={{ m: 1 }}
          action={
            route.name === "projectExplorer" ? (
              <Button color="inherit" size="small" onClick={() => navigate(projectPath(route.params.id))} sx={{ textTransform: "none", fontWeight: 800 }}>
                {t("recovery.resume")}
              </Button>
            ) : (
              <Button color="inherit" size="small" onClick={() => navigate("/")} sx={{ textTransform: "none", fontWeight: 800 }}>
                {t("home.projects")}
              </Button>
            )
          }
        >
          <strong>{t("recovery.title")}</strong> — {t(route.name === "projectExplorer" ? "recovery.body" : "recovery.notFound")}
        </Alert>
      )}
      {/* SQL Console — mounted only when active so it initialises
          lazily. Kept as a conditional render (not CSS-hidden) to
          avoid mounting a heavy editor that the user may never open. */}
      {sqlConsoleVisible && (
        <Box
          sx={{
            flex: 1,
            display: "flex",
            flexDirection: "column",
            minHeight: 0,
            overflow: "hidden",
          }}
        >
          <Deferred>
            <SqlConsole />
          </Deferred>
        </Box>
      )}
      {/* Tab content — kept mounted even while the SQL console is
          visible (hidden via CSS only). This means HomeDashboard
          remains subscribed to dataVersion and re-fetches statistics
          in the background, so the Home tab shows fresh data the
          instant the SQL console is closed — no loading flash. */}
      <Box
        sx={
          sqlConsoleVisible
            ? { display: "none" }
            : { display: "contents" }
        }
      >
        {selectedMainTab === 0 ? (
          // Tab 0 — Home dashboard (post-upload at-a-glance)
          <Deferred>
          <HomeDashboard
            key={`lens-${lensKey}`}
            validationReport={validationReport}
            importAdjustments={importAdjustments}
            networkReport={networkReport}
            onDismissReport={() => setNetworkReport(null)}
            onRefineReport={route.name === "projectExplorer" ? () => {
              setNetworkReport(null);
              navigate(projectPath(route.params.id, 3));
            } : null}
            onNavigateToValidation={() => {
              setShowValidationReport(true);
            }}
            onNavigateToSchedule={() => setSelectedMainTab(1)}
            agencies={agencies}
            validation={{ running: backgroundValidating, seconds: validatingSeconds, unavailable: features?.access?.validator === "unavailable" }}
          />
          </Deferred>
        ) : selectedMainTab === 1 ? (
          <>
            <LineSelector
              agencies={agencies}
              routes={routes}
              directions={directions}
              selectedAgency={selectedAgency}
              selectedRoute={selectedRoute}
              selectedDirection={selectedDirection}
              selectedDate={selectedDate}
              onAgencyChange={handleAgencyChange}
              onRouteChange={handleRouteChange}
              onDirectionChange={handleDirectionChange}
              onDateChange={handleDateChange}
              onRoutesChanged={(deletedRouteId) =>
                setRoutes((prev) =>
                  prev.filter((r) => r.route_id !== deletedRouteId),
                )
              }
              calendar={calendar}
              calendarDates={calendarDates}
              showGuide={showSelectorGuide}
              onGuideDone={() => setShowSelectorGuide(false)}
              openPanel={openPanel}
              markedRouteIds={markedRoutes}
            />
            {(!selectedAgency ||
              !selectedRoute ||
              !selectedDirection ||
              !selectedDate) && (
              <Box
                display="flex"
                justifyContent="center"
                alignItems="center"
                height="300px"
              >
                <Alert
                  severity="info"
                  sx={{
                    borderRadius: 3,
                    boxShadow: "0 4px 12px rgba(0,0,0,0.08)",
                    border: "1px solid rgba(25, 118, 210, 0.2)",
                    "& .MuiAlert-icon": {
                      fontSize: 28,
                    },
                  }}
                >
                  <Typography variant="body1" fontWeight={500}>
                    {t("app.selectPrompt")}
                  </Typography>
                </Alert>
              </Box>
            )}
            {loading ? (
              <Box
                display="flex"
                justifyContent="center"
                alignItems="center"
                height="200px"
                flexDirection="column"
                gap={2}
              >
                <CircularProgress size={48} thickness={4} />
                <Typography variant="body2" color="text.secondary">
                  {t("app.loadingRoute")}
                </Typography>
              </Box>
            ) : (
              <>
                {selectedRoute &&
                  selectedAgency &&
                  selectedDirection &&
                  selectedDate && (
                    <>
                      <Box
                        display="flex"
                        alignItems="center"
                        justifyContent="space-between"
                        marginBottom={0}
                        marginTop={-1.5}
                        sx={(theme) => ({
                          backgroundColor:
                            theme.palette.mode === "dark"
                              ? "#1e1e1e"
                              : "#ffffff",
                          padding: 1.5,
                          borderRadius: 0,
                          boxShadow: "none",
                          border:
                            theme.palette.mode === "dark"
                              ? "1px solid rgba(255,255,255,0.08)"
                              : "1px solid rgba(0,0,0,0.06)",
                          borderTop: "none",
                          borderBottom: "none",
                        })}
                      >
                        <Box
                          display="flex"
                          alignItems="center"
                          gap={1.5}
                        >
                          <div
                            style={{
                              width: 36,
                              height: 36,
                              minHeight: 36,
                              minWidth: 36,
                              backgroundColor: `#${selectedRouteDetails.route_color || "1976d2"}`,
                              color: `#${selectedRouteDetails.route_text_color || "FFFFFF"}`,
                              display: "flex",
                              alignItems: "center",
                              justifyContent: "center",
                              borderRadius: 8,
                              fontSize: 16,
                              fontWeight: 700,
                              boxShadow: "0 2px 8px rgba(0,0,0,0.12)",
                            }}
                          >
                            {selectedRouteDetails.route_short_name}
                          </div>
                          <Typography
                            variant="h6"
                            sx={(theme) => ({
                              fontWeight: 600,
                              color:
                                theme.palette.mode === "dark"
                                  ? "#e2e8f0"
                                  : "#1e293b",
                              fontSize: "1rem",
                            })}
                          >
                            {selectedRouteDetails.route_long_name}
                          </Typography>
                          <IconButton
                            size="small"
                            onClick={() =>
                              openPanel("route", selectedRoute)
                            }
                            sx={(theme) => ({
                              color:
                                theme.palette.mode === "dark"
                                  ? "rgba(255,255,255,0.5)"
                                  : "rgba(0,0,0,0.4)",
                              "&:hover": {
                                color: theme.palette.primary.main,
                                backgroundColor:
                                  theme.palette.mode === "dark"
                                    ? "rgba(144,202,249,0.1)"
                                    : "rgba(25,118,210,0.08)",
                              },
                            })}
                          >
                            <InfoOutlinedIcon sx={{ fontSize: 18 }} />
                          </IconButton>
                        </Box>
                        <Box
                          sx={{
                            flex: 1,
                            display: "flex",
                            alignItems: "center",
                            gap: 0.75,
                            flexWrap: "wrap",
                            justifyContent: "center",
                            px: 2,
                            minWidth: 0,
                          }}
                        >
                          {stopsAndTimes.has_frequencies &&
                            stopsAndTimes.frequency_info &&
                            stopsAndTimes.frequency_info.length > 0 && (
                              <Chip
                                icon={
                                  <ScheduleIcon sx={{ fontSize: 14 }} />
                                }
                                label={
                                  stopsAndTimes.frequency_info
                                    .length === 1
                                    ? `${t("schedule.frequencyBased")} · ${stopsAndTimes.frequency_info[0].headway_mins} min · ${stopsAndTimes.frequency_info[0].start_time.substring(0, 5)}–${stopsAndTimes.frequency_info[0].end_time.substring(0, 5)}`
                                    : `${t("schedule.frequencyBased")} · ${stopsAndTimes.frequency_info[0].headway_mins} min · ${stopsAndTimes.frequency_info.length}`
                                }
                                size="small"
                                sx={(theme) => ({
                                  height: 22,
                                  fontSize: "0.72rem",
                                  fontWeight: 500,
                                  backgroundColor:
                                    theme.palette.mode === "dark"
                                      ? "#1e3a5f"
                                      : "#e3f2fd",
                                  color:
                                    theme.palette.mode === "dark"
                                      ? "#90caf9"
                                      : "#1565c0",
                                  "& .MuiChip-icon": {
                                    color:
                                      theme.palette.mode === "dark"
                                        ? "#60a5fa"
                                        : "#1976d2",
                                  },
                                })}
                              />
                            )}
                          {stopsAndTimes.total_trips > 0 &&
                            stopsAndTimes.wheelchair_accessible_trips >
                              0 && (
                              <Chip
                                icon={
                                  <AccessibleIcon
                                    sx={{ fontSize: 14 }}
                                  />
                                }
                                label={
                                  stopsAndTimes.wheelchair_accessible_trips ===
                                  stopsAndTimes.total_trips
                                    ? t("schedule.wheelchairAll")
                                    : t("schedule.wheelchairPartial", {
                                        accessible:
                                          stopsAndTimes.wheelchair_accessible_trips,
                                        total:
                                          stopsAndTimes.total_trips,
                                      })
                                }
                                size="small"
                                sx={(theme) => ({
                                  height: 22,
                                  fontSize: "0.72rem",
                                  fontWeight: 500,
                                  backgroundColor:
                                    theme.palette.mode === "dark"
                                      ? "#1a2e1a"
                                      : "#f0fdf4",
                                  color:
                                    theme.palette.mode === "dark"
                                      ? "#86efac"
                                      : "#166534",
                                  "& .MuiChip-icon": {
                                    color:
                                      theme.palette.mode === "dark"
                                        ? "#4ade80"
                                        : "#16a34a",
                                  },
                                })}
                              />
                            )}
                        </Box>
                        <Box
                          display="flex"
                          alignItems="center"
                          gap={1.5}
                        >
                          {selectedSecondaryTab === 1 && (
                            <StopSearchAutocomplete
                              stops={stopsAndTimes.stops || []}
                              selectedStopId={focusedStopId}
                              onSelect={(stopId) => {
                                if (!stopId) {
                                  setFocusedStopId(null);
                                  return;
                                }
                                // Reset first so picking the same stop
                                // twice still triggers the flyTo effect
                                setFocusedStopId(null);
                                setTimeout(
                                  () => setFocusedStopId(stopId),
                                  0,
                                );
                              }}
                              width={240}
                            />
                          )}
                          {selectedSecondaryTab === 0 && (
                            <TextField
                              placeholder={t("app.stopSearch")}
                              value={stopFilter}
                              onChange={(e) =>
                                setStopFilter(e.target.value)
                              }
                              variant="outlined"
                              size="small"
                              sx={() => ({
                                width: 240,
                                "& .MuiOutlinedInput-root": {
                                  borderRadius: 2,
                                },
                              })}
                              InputProps={{
                                startAdornment: (
                                  <InputAdornment position="start">
                                    <SearchIcon
                                      sx={{
                                        color: "#64748b",
                                        fontSize: 18,
                                      }}
                                    />
                                  </InputAdornment>
                                ),
                                endAdornment: stopFilter && (
                                  <InputAdornment position="end">
                                    <ClearIcon
                                      sx={{
                                        color: "#64748b",
                                        fontSize: 18,
                                        cursor: "pointer",
                                        "&:hover": { color: "#334155" },
                                      }}
                                      onClick={() => setStopFilter("")}
                                    />
                                  </InputAdornment>
                                ),
                                sx: (theme) => ({
                                  borderRadius: 2,
                                  backgroundColor:
                                    theme.palette.mode === "dark"
                                      ? "#2d2d2d"
                                      : "#f8fafc",
                                  "&:hover": {
                                    backgroundColor:
                                      theme.palette.mode === "dark"
                                        ? "#3d3d3d"
                                        : "#f1f5f9",
                                  },
                                  "& .MuiOutlinedInput-notchedOutline":
                                    {
                                      borderColor:
                                        theme.palette.mode === "dark"
                                          ? "rgba(255,255,255,0.15)"
                                          : "#e2e8f0",
                                    },
                                  "&:hover .MuiOutlinedInput-notchedOutline":
                                    {
                                      borderColor:
                                        theme.palette.mode === "dark"
                                          ? "rgba(255,255,255,0.25)"
                                          : "#cbd5e1",
                                    },
                                  "&.Mui-focused": {
                                    backgroundColor:
                                      theme.palette.mode === "dark"
                                        ? "#2d2d2d"
                                        : "white",
                                  },
                                }),
                              }}
                            />
                          )}
                          <Tabs
                            value={selectedSecondaryTab}
                            onChange={(e, value) =>
                              setSelectedSecondaryTab(value)
                            }
                            sx={{
                              "& .MuiTabs-indicator": {
                                height: 3,
                                borderRadius: "3px 3px 0 0",
                              },
                              "& .MuiTab-root": {
                                textTransform: "none",
                                fontWeight: 500,
                                fontSize: "0.85rem",
                                minHeight: 40,
                                transition: "all 0.2s ease",
                                "&:hover": {
                                  backgroundColor:
                                    "rgba(25, 118, 210, 0.04)",
                                },
                                "&.Mui-selected": {
                                  fontWeight: 600,
                                },
                              },
                            }}
                          >
                            <Tab
                              icon={
                                <ScheduleIcon sx={{ fontSize: 18 }} />
                              }
                              iconPosition="start"
                              label={t("app.tabSchedules")}
                            />
                            <Tab
                              icon={<MapIcon sx={{ fontSize: 18 }} />}
                              iconPosition="start"
                              label={t("app.tabMap")}
                            />
                          </Tabs>
                        </Box>
                      </Box>
                      {selectedAgency &&
                        selectedRoute &&
                        selectedDirection &&
                        selectedDate && (
                          <Box
                            style={{
                              flex: 1,
                              overflowY: "auto",
                              height: "calc(100vh - 400px)",
                            }}
                          >
                            {error && (
                              <Alert
                                severity="error"
                                style={{
                                  margin: "24px",
                                  textAlign: "center",
                                }}
                              >
                                {error}
                              </Alert>
                            )}
                            {!error &&
                              selectedSecondaryTab === 0 &&
                              selectedRoute &&
                              selectedDirection &&
                              selectedDate && (
                                <Deferred>
                                <ScheduleGrid
                                  stops={stopsAndTimes.stops}
                                  stopTimes={stopsAndTimes.stop_times}
                                  selectedRouteDetails={
                                    selectedRouteDetails
                                  }
                                  frequencyInfo={
                                    stopsAndTimes.frequency_info
                                  }
                                  hasFrequencies={
                                    stopsAndTimes.has_frequencies
                                  }
                                  hasNormalTimes={
                                    stopsAndTimes.has_normal_times
                                  }
                                  stopFilter={stopFilter}
                                  datasetKey={`${selectedRoute}|${selectedDirection}|${selectedDate}`}
                                  wheelchairAccessibleTrips={
                                    stopsAndTimes.wheelchair_accessible_trips
                                  }
                                  totalTrips={stopsAndTimes.total_trips}
                                  highlightTripIds={lensCompareShown ? lensCompareShown.added : null}
                                />
                                </Deferred>
                              )}
                            {!error &&
                              selectedSecondaryTab === 1 &&
                              Object.keys(shapes).length === 0 &&
                              Object.keys(allRouteShapes).length ===
                                0 && (
                                <Alert
                                  severity="info"
                                  sx={{ mx: 2, mt: 1 }}
                                >
                                  {t("map.noShapes")}
                                </Alert>
                              )}
                            {!error && selectedSecondaryTab === 1 && (
                              <Deferred>
                              <LineMap
                                chrome="readonly"
                                shapesById={shapes}
                                allRouteShapes={allRouteShapes}
                                stops={stopsAndTimes.stops}
                                focusedStopId={focusedStopId}
                              />
                              </Deferred>
                            )}
                          </Box>
                        )}
                    </>
                  )}
              </>
            )}
          </>
        ) : selectedMainTab === 3 ? (
          <Deferred>
            <ShapeStudio agencies={agencies} target={studioTarget} />
          </Deferred>
        ) : selectedMainTab === 4 ? (
          <Deferred>
            <FeedDiffPage />
          </Deferred>
        ) : null}
      </Box>
    </>
  );

  // The lens's bar: in the project's own reader while a draft is simulated (the rail's « copie de travail » says the rest).
  const lineLabelOf = (id) => {
    const r = routes.find((x) => String(x.route_id) === String(id));
    return r ? String(r.route_short_name || r.route_long_name || id) : String(id);
  };
  // (The Change Studio is not mounted in the reader: a simulation it left running is not waited for here.)
  const lensDraft = draftView ? { ...draftView, simulating: false } : null;
  const readerLensBar = lensVisible ? (
    <ReaderLens
      draft={lensDraft}
      side={lensSide}
      onSide={setLensSide}
      compare={lensCompareShown ? { label: lineLabelOf(lensCompareShown.route), date: selectedDate ? formatDate(`${selectedDate}T12:00:00`, language) : "", before: lensCompareShown.before, after: lensCompareShown.after, added: lensCompareShown.added.size, removed: lensCompareShown.removed } : null}
      onLine={(line) => window.dispatchEvent(new CustomEvent("gtfs:navigate", { detail: { target: "schedule", routeId: line.route, date: line.date || null } }))}
      onObjectives={project && draftKind !== "hand" ? () => navigate(projectPath(project.id, 2)) : null}
      editing={editing}
      retouching={draftScreen}
      compact={draftKind === "hand"}
    />
  ) : null;
  const showLensInReader = route.name === "projectExplorer" && Boolean(readerLensBar) && Boolean(draftView?.previewId);
  // A project's steps are the Network Studio: its own look (StudioScope) and its own bar, which holds the steps and the
  // step's actions; the explorer of a project, like the rest of the app, keeps the app's header.
  const studio = route.name === "project";

  return (
    <>
      <StudioScope active={studio}>
      {/* Home draws its own ground edge to edge: no side padding of the shell around it (as the studio's workbench). */}
      <AppShell
        title={pageTitle}
        routeKey={routeKey}
        header={studio ? <StudioTopBar agenciesLoaded={agencies.length > 0} project={project} onRename={project ? (name) => updateOpenProject({ name }) : null} work={work} /> : <Header agenciesLoaded={agencies.length > 0} toolbar={!["accessibility", "legal", "rules"].includes(route.name) && (!projectId || route.name === "projectExplorer")} activeTab={view === "validation" ? false : view} onSelectTab={(slug) => {
          // In the draft's screen a tab of the reader is the reader's view.
          if (draftScreen) setDraftViewMode("network");
          goToView(slug);
        }} work={["accessibility", "legal", "rules"].includes(route.name) ? null : work} draft={draftScreen} tabsShown={!draftScreen || draftViewShown === "network"} draftInProgress={readerDraftKind} draftSlot={draftScreen ? setDraftHeaderHost : null} />}
        statusBar={statusBar}
        legal={legal}
        railSlot={Boolean(projectId) && !draftScreen}
        railInHeader
        flush={studio || homeShown || draftScreen}
      >
      {/* The explorer inside a project: the rail folds into "← Retour à l'étape N". */}
      {route.name === "projectExplorer" && project && !draftScreen && (
        <Rail>
          <StepNav folded job={project.job} current={stepFor(project.step || 1, project.job)} onSelect={(n) => navigate(projectPath(project.id, n))} />
        </Rail>
      )}
      {route.name === "legal" ? (
        /* The legal pages (/conditions/:tab): the notice, the terms of use and of sale, privacy — pages of their own. */
        <Deferred>
          <LegalPage tab={route.params.tab} />
        </Deferred>
      ) : route.name === "rules" ? (
        /* The validation rules (/regles), searchable, in the reader's language. */
        <Deferred>
          <ValidationRulesPage />
        </Deferred>
      ) : route.name === "accessibility" ? (
        /* The accessibility statement (/accessibilite, RGAA): a page of its own, whatever is open. */
        <Accessibility />
      ) : (
        <>
          {dataLoading ? (
            <Box
              display="flex"
              justifyContent="center"
              alignItems="center"
              flexGrow={1}
              flexDirection="column"
              gap={3}
            >
              <Box
                sx={{
                  position: "relative",
                  display: "flex",
                  alignItems: "center",
                  justifyContent: "center",
                }}
              >
                <CircularProgress
                  size={80}
                  thickness={1.5}
                  sx={{ color: "primary.main" }}
                />
                <DirectionsBusIcon
                  sx={{
                    position: "absolute",
                    fontSize: 36,
                    color: "primary.main",
                  }}
                />
              </Box>
              <Box textAlign="center">
                <Typography variant="h6" fontWeight={600} gutterBottom>
                  {t("app.loadingData")}
                </Typography>
                <Typography
                  key={loadingStep}
                  variant="body2"
                  color="text.secondary"
                  sx={{
                    minHeight: 24,
                    animation: "fadeInUp 0.5s ease-out",
                    "@keyframes fadeInUp": {
                      from: { opacity: 0, transform: "translateY(4px)" },
                      to: { opacity: 1, transform: "translateY(0)" },
                    },
                  }}
                >
                  {LOADING_MESSAGES[loadingStep]}
                </Typography>
              </Box>
              <LinearProgress
                sx={{
                  width: 280,
                  borderRadius: 4,
                  height: 6,
                  "& .MuiLinearProgress-bar": {
                    borderRadius: 4,
                  },
                }}
              />
            </Box>
          ) : route.name === "project" && project?.job === "modify" && ownsOpenNetwork ? (
            /* A modify project whose network is open: its reader with the panel (the address is being replaced). */
            null
          ) : route.name === "project" ? (
            /* A project's step: the rail, the step's page, its flow (steps/ProjectPage). */
            <Deferred>
              <ProjectPage
                id={route.params.id}
                step={route.params.step}
                tab={route.params.tab}
                networkLoaded={agencies.length > 0}
                networkHandle={networkIdRef.current}
                sessionLost={sessionLost}
                unfrozenEdits={sessionClock ? sessionClock.edits : null}
                network={agencies.length ? { name: networkName, validation: reportSummary.validated ? { errors: reportSummary.errors, warnings: reportSummary.warnings, time: reportAt ? formatTime(reportAt, language) : "" } : null } : null}
                onOpenBuilt={(result, target) => handleNetworkOpened(result, target)}
                onOpenFeed={(result) => handleNetworkOpened(result, {})}
                onNetworkOpened={(result) => handleNetworkOpened(result, { projectId: route.params.id, stay: true })}
                onPickFile={() => pickFileForProject(route.params.id)}
                onDropFile={(file) => guard(() => uploadForProject(file, route.params.id), { reason: "upload" })}
                onResume={resumeProject}
                actor={me?.display_name || rememberedName() || null}
                handover={handoverRef.current[route.params.id] || null}
                onOpenReader={openReader}
                onDraft={(d) => setDraftView(d ? { ...d, projectId: route.params.id } : null)}
                onHandoverTaken={(id) => {
                  // Taken once: a later visit of the step (after "Voir le réseau", a reload) never hands it over again.
                  delete handoverRef.current[id];
                }}
              />
            </Deferred>
          ) : route.name === "create" || route.name === "modify" ? null : validationReport?.valid === false &&
            validationReport?.structural ? (
            /* Structural rejection (no backend session): re-upload is the
               only way forward. */
            <Deferred>
              <ValidationErrorsPage report={validationReport} onReupload={handleReupload} />
            </Deferred>
          ) : route.name === "home" || (!agencies.length && !shareToken) ? (
            /* Home « Mes travaux »: the flows, the works to resume, the network open here (home/Home). */
            <Box flexGrow={1} sx={{ overflowY: "auto", display: "flex" }}>
              <Home
                onUploadSuccess={handleUploadSuccess}
                onLoadSample={handleLoadSample}
                onModifyNetwork={() => navigate(MODIFY_PATH)}
                onNetworkConsult={(result) => result?.sessionId && handleNetworkOpened(result, { explore: true })}
                onNetworkFound={openFromHome}
                onNetworkFile={dropFromHome}
                beforeModify={gateModify}
                sampleError={error}
                sessionLost={sessionLost && !agencies.length}
                openNetwork={agencies.length && !sessionLost && !projectOwning(networkIdRef.current) ? { name: networkName, onExplore: () => goToView(TAB_SLUG[selectedMainTabRef.current] || "apercu"), onModify: () => navigate(modifyPath(networkIdRef.current)) } : null}
                onOpenProject={(p) => navigate(projectPath(p.id))}
              />
            </Box>
          ) : showValidationReport && validationReport ? (
            /* Repair station — also the rescue landing for feeds loaded with
               canonical errors. The session is live: findings can be fixed,
               re-validated and the app freely navigated. */
            <Deferred>
              <ValidationErrorsPage
                report={validationReport}
                onReupload={handleReupload}
                onBack={closeValidationPage}
                onReportRefreshed={adoptReport}
                baselineCounts={validationBaseline}
                stale={validationStale}
                backgroundValidating={backgroundValidating}
                importAdjustments={importAdjustments}
              />
            </Deferred>
          ) : !agencies.length && shareToken ? (
            <Box flexGrow={1} sx={{ overflowY: "auto", px: 2 }}>
              <Deferred>
                <SharedFeedLanding token={shareToken} onOpened={handleShareOpened} onCancel={() => navigate("/", { replace: true })} />
              </Deferred>
            </Box>
          ) : draftScreen ? (
            // The draft's one screen: its bar (the Change Studio's, drawn in the head), then one of its two views — the
            // reader full page (the lens « Avant | Après » above it) or the change's desk. Both stay mounted, one over the
            // other (a map keeps its size; the composer its draft), the hidden one out of sight and of the keyboard.
            <Box data-testid="draft-screen" data-capture={captureId ? "on" : "off"} data-view={draftViewShown} sx={{ flex: 1, minHeight: 0, display: "flex", flexDirection: "column" }}>
              <EditModeToggle silent />
              <DeliverButton silent />
              <Box ref={setDraftBarHost} sx={{ flexShrink: 0 }} />
              <Box sx={{ position: "relative", flex: 1, minWidth: 0, minHeight: 0 }}>
                <Box data-testid="draft-network" aria-hidden={draftViewShown !== "network" ? "true" : undefined} inert={draftViewShown !== "network" ? "" : undefined} sx={{ position: "absolute", inset: 0, display: "flex", flexDirection: "column", overflowY: "auto", px: 2, visibility: draftViewShown === "network" ? "visible" : "hidden" }}>
                  {showLensInReader && readerLensBar}
                  {readerBody()}
                </Box>
                <Box data-testid="draft-change" aria-hidden={draftViewShown !== "change" ? "true" : undefined} inert={draftViewShown !== "change" ? "" : undefined} sx={{ position: "absolute", inset: 0, display: "flex", visibility: draftViewShown === "change" ? "visible" : "hidden" }}>
              <Deferred>
                <ProjectPage
                  panel
                  view={draftViewMode}
                  onView={setDraftViewMode}
                  barHost={draftBarHost}
                  headerHost={draftHeaderHost}
                  panelOpen={panelAsked}
                  onPanelOpened={() => navigate(projectExplorerPath(project.id, view || "apercu"), { replace: true })}
                  onLeave={() => navigate(explorerPath(networkIdRef.current, view || "apercu"))}
                  id={project.id}
                  networkLoaded={agencies.length > 0}
                  networkHandle={networkIdRef.current}
                  sessionLost={sessionLost}
                  unfrozenEdits={sessionClock ? sessionClock.edits : null}
                  network={agencies.length ? { name: networkName, validation: reportSummary.validated ? { errors: reportSummary.errors, warnings: reportSummary.warnings, time: reportAt ? formatTime(reportAt, language) : "" } : null } : null}
                  onResume={resumeProject}
                  actor={me?.display_name || rememberedName() || null}
                  handover={handoverRef.current[project.id] || null}
                  onOpenReader={openReader}
                  onDraft={(d) => setDraftView(d ? { ...d, projectId: project.id } : null)}
                  onHandoverTaken={(id) => {
                    delete handoverRef.current[id];
                  }}
                />
              </Deferred>
                </Box>
              </Box>
            </Box>
          ) : (
            <>
              {showLensInReader && readerLensBar}
              {readerBody()}
            </>
          )}
          {uploadSuccess && (
            <Alert severity="success" style={{ marginTop: "auto" }}>
              {t("app.uploadSuccess")}
            </Alert>
          )}
        </>
      )}
      </AppShell>
      </StudioScope>
      <DetailPanel />
      <CommandPalette feedLoaded={agencies.length > 0} />
      <ShortcutsHelpDialog />
      {/* The person's own GTFS file for a project that modifies it (① network-source-upload): picked here, the step stays on screen. */}
      <input
        ref={projectUploadRef}
        type="file"
        hidden
        accept=".zip,application/zip"
        data-testid="project-upload-input"
        onChange={(e) => {
          const file = e.target.files?.[0] || null;
          const target = uploadTargetRef.current;
          e.target.value = "";
          uploadTargetRef.current = null;
          if (!file || !target) return;
          guard(() => uploadForProject(file, target), { reason: "upload" });
        }}
      />
      <WorksDialog onOpenProject={(p) => navigate(projectPath(p.id))} />
      <PricingDialog
        open={Boolean(pricing)}
        reason={pricing?.reason || null}
        onClose={() => {
          pricingClosedAtRef.current = Date.now();
          // Closed without the licence: the « Modifier » it was opened for is given up.
          if (studioLockedNow()) pendingModifyRef.current = null;
          setPricing(null);
        }}
      />
      {/* Not in the studio: the journey has its own column for the assistant, which this button would cover. */}
      <ChatAssistantFAB
        feedLoaded={agencies.length > 0 && !studio}
        feedEpoch={feedEpoch}
        language={language}
        sessionContext={chatSessionContext}
      />
    </>
  );
}

export default GTFSApp;
