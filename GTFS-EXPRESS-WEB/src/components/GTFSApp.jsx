import React, {
  useState,
  useEffect,
  useRef,
  useCallback,
  useMemo,
  lazy,
} from "react";
import "./GTFSApp.css";
import Header from "./Header/Header";
import AppShell from "./AppShell";
import EditModeToggle, { DeliverButton } from "./edit/EditModeToggle";
import DetailPanel from "./DetailPanel";
import {
  Typography,
  Box,
  Alert,
} from "@mui/material";
import CircularProgress from "@mui/material/CircularProgress";
import DirectionsBusIcon from "@mui/icons-material/DirectionsBus";
import LinearProgress from "@mui/material/LinearProgress";
import StudioScope from "./studio/StudioScope";
import StudioTopBar from "./studio/StudioTopBar";
import Home from "./home/Home";
import CommandPalette from "./CommandPalette";
import ShortcutsHelpDialog from "./ShortcutsHelpDialog";
import ChatAssistantFAB from "./chat/ChatAssistantFAB";
import { openModifyProject } from "../utils/modifyProject";
import useReaderLens, { useReaderLensState } from "./app/useReaderLens";
import useAppRoutes, { useExplorerView } from "./app/useAppRoutes";
import { networkSourceOf, rememberNetworkSource } from "./app/networkSource";
import useWorkingCopyClock from "./app/useWorkingCopyClock";
import useBackgroundValidation from "./app/useBackgroundValidation";
import useDraftScreen from "./app/useDraftScreen";
import useAppChrome from "./app/useAppChrome";
import useFeedLoading from "./app/useFeedLoading";
import ReaderBody from "./app/ReaderBody";
import Deferred from "./app/Deferred";
import StepNav, { stepFor } from "./steps/StepNav";
import { Rail } from "./AppShell";
import { useRoute, useNavigate, resolveRoute, explorerPath, getNetworkId, newNetworkId, projectPath, projectExplorerPath, modifyPath, MODIFY_PATH } from "../utils/routes";
import { createProject, getProject, listProjects, updateProject, useProject, withJournal, withReference, configureRemote, remoteEnabled, refreshProjects, deliveryOf, withDelivery, setDeliveryResolver, whenOnServer } from "../utils/projectStore";
import { draftInProgressOf, modifyProjectsOf } from "../utils/changeStates";
import { listWorkspaceProjects, getWorkspaceProject, createWorkspaceProject, patchWorkspaceProject, deleteWorkspaceProject, freezeWorkspaceVersion, deleteWorkspaceVersion, restoreWorkspaceVersion, setProjectReady } from "../utils/projectApi";
import { licenceLockOf, openPaywall, useFeatures } from "../utils/featuresApi";
import PricingDialog from "./PricingDialog";
import { trackUi, trackVisit } from "../utils/uiTelemetry";
import WorksDialog from "./home/WorksDialog";
import WayChoice from "./transform/WayChoice";
import { useAccount } from "../contexts/AccountContext";

import Accessibility from "./Accessibility";
// What the first screen never needs loads on demand, behind a loader (Deferred). The comparison and the accessibility
// statement stay in the bundle: StepDelivery and the footer import parts of them.
const SharedFeedLanding = lazy(() => import("./share/SharedFeedLanding"));
const ValidationErrorsPage = lazy(() => import("./ValidationErrorsPage"));
const ProjectPage = lazy(() => import("./steps/ProjectPage"));
const LegalPage = lazy(() => import("./legal/LegalPage"));
const ValidationRulesPage = lazy(() => import("./rules/ValidationRulesPage"));
import API_BASE_URL from "../config";
import {
  getSessionId,
  fetchWithSession,
  newSessionId,
  setSessionId,
} from "../utils/sessionManager";
import { rememberedName } from "./common/AcknowledgementForm";
import { approvalOf, approvalRequired } from "../utils/deliverablesApi";
import { summarizeReport } from "../utils/validationSummary";
import { humanError } from "../utils/humanError";
import { useLanguage } from "../contexts/LanguageContext";
import { useEditMode } from "../contexts/EditModeContext";
import { useDetailPanel } from "../contexts/DetailPanelContext";
import { useDestructiveGuard } from "../contexts/DestructiveGuardContext";
import { CHAT_OPEN_EVENT, CLOSE_VALIDATION_REPORT_EVENT, DELIVERED_EVENT, FIND_NETWORK_EVENT, OPEN_CHANGE_STUDIO_EVENT, OPEN_SHEETS_EVENT, PAYWALL_EVENT, PRICING_EVENT, REVIEW_ERRORS_EVENT, VALIDATION_REFRESHED_EVENT } from "../utils/appEvents";

// The loader's rotating messages, by their i18n keys: their count is the rotation's period, read by an effect
// that must not depend on the translated strings.
const LOADING_MESSAGE_KEYS = Object.freeze(["app.loadingStep1", "app.loadingStep2", "app.loadingStep3"]);

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
  const { guard, isViewDirty } = useDestructiveGuard();
  const LOADING_MESSAGES = LOADING_MESSAGE_KEYS.map((key) => t(key));
  const [feedEpoch, setFeedEpoch] = useState(0);
  // A new network gets a new epoch for the feed-bound views and a new handle for its URLs (/r/:id/…). `source`
  // (catalogue | upload | sample | version, null for a shared copy) becomes a modify project's reference origin.
  const openedNewNetwork = (source = null) => {
    networkIdRef.current = newNetworkId();
    rememberNetworkSource(networkIdRef.current, source);
    setFeedEpoch((e) => e + 1);
  };
  // The URL leads the explorer's view: a tab click, Back, a reload or a sent link land on the same view. `:id` is
  // this tab's handle of the open network, never the session id.
  const route = useRoute();
  const navigate = useNavigate();
  const routeRef = useRef(route);
  routeRef.current = route;
  const inExplorer = route.name === "explorer" || route.name === "projectExplorer";
  const view = inExplorer ? route.params.tab : null;
  const projectId = route.name === "project" || route.name === "projectExplorer" ? route.params.id : null;
  const [project, updateOpenProject] = useProject(projectId);
  const networkIdRef = useRef(getNetworkId());
  // ── The reader's lens: « Avant | Après » (components/reader/ReaderLens) ──
  const { draftView, setDraftView, lensSide, setLensSide, lensKey, setLensKey } = useReaderLensState();
  // Bumped when a plan is handed over to the project already open, so the page reads the hand-over again.
  const [, setHandoverTick] = useState(0);
  const { selectedMainTab, setSelectedMainTabState, selectedMainTabRef, goToView, setSelectedMainTab, showValidationReport, setShowValidationReport, closeValidationPage } = useExplorerView({ view, navigate, networkIdRef, guard, isViewDirty });
  // ── The feed: its lists, their loading and the reader's navigation events (app/useFeedLoading) ──
  const feed = useFeedLoading({ baseUrl, t, dataVersion, lensKey, entity, editing, showToast, networkIdRef, setSelectedMainTab, setShowValidationReport });
  const { agencies, setAgencies, routes, setRoutes, selectedRoute, setSelectedRoute, selectedDirection, selectedDate, setSelectedAgency, selectedRouteDetails, setSelectedRouteDetails, error, setError, chosenRouteRef, fetchAgencies, fetchAgenciesRef } = feed;
  const [uploadSuccess, setUploadSuccess] = useState(false);
  const [validationReport, setValidationReport] = useState(null);
  // A fresh report clears the "modified since report" markers of the edits made before `startedAt` (when its request
  // was issued); a report older than the one adopted (two overlapping runs) is ignored.
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
  // The counts at feed load: the repair banner measures progress against them, never updated by re-validation.
  const [validationBaseline, setValidationBaseline] = useState(null);
  // Rows the tolerant loader dropped at upload ({table: droppedCount}): the AI context says those duplicate-key
  // findings are already resolved.
  const [importAdjustments, setImportAdjustments] = useState(null);
  // A network just opened takes its own verdict or none (an "unverified" report, the validator not run, is no
  // verdict): the previous network's report, baseline and import adjustments never pass to it, and without a
  // verdict the background validator runs for it.
  const takeNetworkReport = (report, dropped = null) => {
    const verdict = report && typeof report === "object" && !report.unverified ? report : null;
    lastReportStartedAtRef.current = 0;
    setValidationReport(verdict);
    // The repair banner's baseline uses the same weighted tally as every other screen (utils/validationSummary.js),
    // else « X of Y fixed » drifts from what the page shows.
    setValidationBaseline(verdict ? summarizeReport(verdict) : null);
    setImportAdjustments(dropped);
  };
  // The shared landing (/partage/:token; `?share=` redirects there).
  const shareToken = route.name === "share" ? route.params.token : null;
  const { me } = useAccount();
  const { features, loaded: featuresLoaded } = useFeatures();
  // With the server's workspace on, the browser store is its cache; a version is frozen from this tab's working
  // copy only when the project's network is the one open here.
  const workspaceOn = Boolean(features?.workspace?.enabled);
  // Read by the store when the server does not list a project of this browser's token: such a project is kept until
  // attached, never forgotten because the person signed in.
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
      sessionOf: (p) => (p?.network?.network_id && p.network.network_id === networkIdRef.current ? getSessionId() : null),
    });
    // A project's own acts wait until it is on the server (a project made a moment ago is saved a tick later).
    setProjectReady(whenOnServer);
    return () => {
      setProjectReady(null);
      configureRemote(null);
    };
  }, [workspaceOn]);
  // Signing in or out changes whose projects the server lists: the works are read again.
  const signedIn = Boolean(me);
  const signedInSeen = useRef(signedIn);
  useEffect(() => {
    if (signedInSeen.current === signedIn) return;
    signedInSeen.current = signedIn;
    if (remoteEnabled()) refreshProjects();
  }, [signedIn]);
  // What a modify project receives when it opens, by project id: { brief, focus, kind } (a brief from the assistant).
  const handoverRef = useRef({});
  useEffect(() => {
    const handler = () => navigate(MODIFY_PATH);
    window.addEventListener(FIND_NETWORK_EVENT, handler);
    return () => window.removeEventListener(FIND_NETWORK_EVENT, handler);
  }, [navigate]);
  const feedLoadedRef = useRef(false);
  const pendingHandoverRef = useRef(null);
  const readerFocusRef = useRef(null);
  readerFocusRef.current = entity?.type === "route" && entity.id ? String(entity.id) : chosenRouteRef.current && chosenRouteRef.current.network === networkIdRef.current ? chosenRouteRef.current.route : null;
  // Back to a modify project's change (`step` null: the step it was left at), the reader's line in focus there.
  const toChange = useCallback(
    (pid, step = 3) => {
      const focus = readerFocusRef.current;
      if (focus) handoverRef.current[pid] = { brief: null, ...(handoverRef.current[pid] || {}), focus };
      navigate(projectPath(pid, step));
    },
    [navigate],
  );
  useEffect(() => {
    const handler = (e) => {
      const brief = typeof e?.detail?.brief === "string" && e.detail.brief.trim() ? e.detail.brief : null;
      // The way chosen at « Modifier » (« hand » | « brief »): the draft takes it unless it holds work of the other way.
      const kind = e?.detail?.kind === "hand" || e?.detail?.kind === "brief" ? e.detail.kind : null;
      // Every change of the network open here happens in ONE project: the one on screen, else this browser's modify
      // project that already works on it; never a second project bound to the same working copy.
      const current = routeRef.current;
      const handle = networkIdRef.current;
      const onScreen = current.name === "projectExplorer" || current.name === "project" ? getProject(current.params.id) : null;
      // `fresh` asks for a new project (« Nouveau projet »).
      const fresh = Boolean(e?.detail?.fresh);
      const own = !feedLoadedRef.current ? null : onScreen?.job === "modify" && onScreen.network?.network_id === handle ? onScreen : fresh ? null : modifyProjectsOf(listProjects(), handle)[0] || null;
      if (own) {
        // One way per draft: a brief never lands in a draft by hand that holds work.
        if (brief && draftInProgressOf(own) === "hand") {
          showToast(t("draft.otherBlocked"), "info");
          return;
        }
        if (brief || kind) handoverRef.current[own.id] = { brief, focus: readerFocusRef.current, kind };
        toChange(own.id);
        setHandoverTick((n) => n + 1);
        return;
      }
      const focus = feedLoadedRef.current ? readerFocusRef.current : null;
      pendingHandoverRef.current = brief || focus || kind ? { brief, focus, kind } : null;
      navigate(feedLoadedRef.current ? modifyPath(networkIdRef.current) : MODIFY_PATH);
    };
    window.addEventListener(OPEN_CHANGE_STUDIO_EVENT, handler);
    return () => window.removeEventListener(OPEN_CHANGE_STUDIO_EVENT, handler);
  }, [navigate, toChange, showToast, t]);
  useEffect(() => {
    feedLoadedRef.current = agencies.length > 0;
  }, [agencies]);
  const [pricing, setPricing] = useState(null);
  // The act asked without the licence, carried out once the licence runs, forgotten when the offer closes without it.
  const pendingModifyRef = useRef(null);
  const pricingClosedAtRef = useRef(0);
  // One visit per browser tab, for the operator's console (utils/uiTelemetry).
  useEffect(() => trackVisit(), []);
  useEffect(() => {
    const handler = (e) => {
      trackUi("offer.shown", "pricing");
      setPricing({ reason: e?.detail?.reason || null });
    };
    // A server refusal coming back just after the person closed the offer (an autosave retrying) does not reopen it;
    // an action of the person always does.
    const paywall = (e) => {
      if (!e?.detail?.explicit && Date.now() - pricingClosedAtRef.current < 60000) return;
      if (typeof e?.detail?.resume === "function") pendingModifyRef.current = e.detail.resume;
      const entitlement = e?.detail?.entitlement;
      const reason = entitlement === "edit" || entitlement === "deliver" ? entitlement : "studio";
      // Counted for the console: what was asked, or the server's refusal when no click of the person opened it.
      trackUi("offer.shown", e?.detail?.explicit ? reason : "refusal");
      setPricing({ reason });
    };
    window.addEventListener(PRICING_EVENT, handler);
    window.addEventListener(PAYWALL_EVENT, paywall);
    return () => {
      window.removeEventListener(PRICING_EVENT, handler);
      window.removeEventListener(PAYWALL_EVENT, paywall);
    };
  }, []);
  // Which version a download from edit mode delivers, asked before the export so the file is named after it: with
  // retouches since the last frozen version, a new one frozen from the working copy; else the version the working copy
  // is, or the last one. A shared project's version is delivered only approved (`blocked` says why).
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
  // A delivery downloaded in a project that owns the network open here marks its version delivered (kept as long as
  // the project, never purged over the caps) and is recorded; a shared project's unapproved version records nothing.
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
    window.addEventListener(DELIVERED_EVENT, handler);
    return () => window.removeEventListener(DELIVERED_EVENT, handler);
  }, []);
  const [dataLoading, setDataLoading] = useState(false);
  const [loadingStep, setLoadingStep] = useState(0);
  const [showSelectorGuide, setShowSelectorGuide] = useState(false);

  useEffect(() => {
    const handler = () => setShowValidationReport(true);
    window.addEventListener(REVIEW_ERRORS_EVENT, handler);
    return () => window.removeEventListener(REVIEW_ERRORS_EVENT, handler);
  }, [setShowValidationReport]);

  // The shapes tab exists in edit mode only: leaving edit mode on it drops back to Lines, once the server's edit
  // status is known (a reload on /traces in edit mode must stay).
  useEffect(() => {
    if (!statusReady || editing) return;
    if (view === "traces") setSelectedMainTab(1, { replace: true });
    else if (selectedMainTab === 3) setSelectedMainTabState(1);
  }, [statusReady, editing, selectedMainTab, view, setSelectedMainTab, setSelectedMainTabState]);

  // A guided chat repair broadcasts its fresh report: adopted so the header badge, the validation page and the chat
  // context stay in sync.
  useEffect(() => {
    const handler = (e) => {
      const report = e?.detail?.report;
      if (report && typeof report === "object") {
        adoptReport(report, e.detail.startedAt || Date.now());
      }
    };
    window.addEventListener(VALIDATION_REFRESHED_EVENT, handler);
    return () =>
      window.removeEventListener(VALIDATION_REFRESHED_EVENT, handler);
  }, [adoptReport]);

  // The SQL console and the validation page are two routes: showing one leaves the other.

  // A fix that opens the SQL console pushes its route over the validation page, so Back returns to the report; a page
  // still showing after that is closed, so a sender that navigates nowhere never leaves the person stuck on it.
  useEffect(() => {
    const handler = () => setTimeout(() => setShowValidationReport(false), 0);
    window.addEventListener(CLOSE_VALIDATION_REPORT_EVENT, handler);
    return () =>
      window.removeEventListener(CLOSE_VALIDATION_REPORT_EVENT, handler);
  }, [setShowValidationReport]);

  useEffect(() => {
    if (!dataLoading) {
      setLoadingStep(0);
      return;
    }
    const interval = setInterval(() => {
      setLoadingStep((prev) => (prev + 1) % LOADING_MESSAGE_KEYS.length);
    }, 2500);
    return () => clearInterval(interval);
  }, [dataLoading]);

  // Boot: an edit session the server still holds (/edit/status, disk truth) with nothing loaded here is hydrated,
  // else the person would be stuck on the uploader with their data still on the server.
  const hydratedFromEditRef = useRef(false);
  // True while a boot hydration runs: the route guard below waits for it
  // before deciding that an explorer URL has no network behind it.
  const hydratingRef = useRef(false);
  useEffect(() => {
    if (!statusReady) return;
    if (hydratedFromEditRef.current) return;
    // Whether a network is loaded is read as it stands when the status arrives (feedLoadedRef follows `agencies`
    // in the effect above): a list emptied later must not start a hydration.
    if (editing && !feedLoadedRef.current) {
      hydratedFromEditRef.current = true;
      hydratingRef.current = true;
      if (!networkIdRef.current) networkIdRef.current = newNetworkId();
      setDataLoading(true);
      // Reloaded on an explorer URL: stay on its view.
      fetchAgenciesRef.current({ keepView: ["explorer", "project", "projectExplorer"].includes(routeRef.current.name) }).finally(() => {
        hydratingRef.current = false;
        setDataLoading(false);
        setShowSelectorGuide(false);
      });
    }
  }, [statusReady, editing, fetchAgenciesRef]);

  // A reload or Back on /r/:id/… of this tab's network brings it back while the server holds its session; once the
  // heartbeat answers 404, or for another tab's handle, the page says the network is not open here and returns Home.
  // The boot route is the one the URL leads to, so a short form being redirected keeps its network.
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

  // ── New projects (/modifier), the route guard, the SQL console's route (app/useAppRoutes) ──
  const { createModifyRef } = useAppRoutes({ route, navigate, agencies, features, featuresLoaded, t, validationReport, statusReady, dataLoading, editing, bootRef, hydratingRef, goToView, selectedMainTabRef, networkIdRef, handoverRef, pendingHandoverRef, inExplorer, view, sqlConsoleVisible, showSqlConsole, hideSqlConsole });


  // Live-session snapshot sent with every chat turn so the assistant can help repair THIS feed; the backend
  // re-sanitizes everything (best-effort context, not API).
  // The shell's aside, where the assistant docks beside the reader.
  const [assistantHost, setAssistantHost] = useState(null);
  const chatSessionContext = useMemo(() => {
    const tab = showValidationReport
      ? "validation"
      : ["home", "schedules", "sql", "studio", "compare"][selectedMainTab] ||
        "home";
    // Real identifiers ground the generated SQL in this feed (the backend re-sanitizes and caps them). Array.isArray:
    // an error envelope can reach the agencies state (a failed upload-time migration) and must not crash the app.
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

  // ── The working copy's clock (app/useWorkingCopyClock) ──────────────────
  const { sessionClock, sessionLost, setSessionLost, pollSession } = useWorkingCopyClock({ baseUrl, agencies, feedEpoch });

  // ── Background re-validation (app/useBackgroundValidation) ─────────────
  const { backgroundValidating, validatingSeconds, reportAt, vouchedValidation } = useBackgroundValidation({ baseUrl, adoptReport, agencies, validationReport, validationStale, sessionLost, features, featuresLoaded, feedEpoch, dataVersion });

  const handleUploadSuccess = async (data, validationReport, meta = {}) => {
    // The backend already ended the edit session atomically: reset local state only, without a second /edit/exit
    // (it would race the upload).
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
      // Accepted but gtfs.db could not be built, so every read fails: say it once and stop here.
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
    setUploadSuccess(true);
    setTimeout(() => setUploadSuccess(false), 3000);
    openedNewNetwork("upload");
    takeNetworkReport(validationReport, droppedTotal > 0 ? meta.importAdjustments : null);
    // A structural rejection has no backend session: only the full-screen report with re-upload. Everything else, a
    // feed with canonical errors included, has a live session. `meta.projectId`: the file becomes that modify project's
    // reference and the person stays on the step.
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
          // Opened over the loaded app, after the tab reset: selecting a tab closes the report page.
          if (validationReport?.valid === false) setShowValidationReport(true);
        });
      // Row counts for the SQL console's file chips in read mode.
      refreshStatus();
    }
  };

  // The person's own file chosen in a modify project's first step, adopted as its reference (source "upload").
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
  // « Modifier » without the licence opens the offer before any network is loaded or file sent. `resume` is carried
  // out once the licence runs, forgotten if the offer closes without it; null when choosing a file needs a click.
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
    const created = createProject({ name: t("step.defaultName.modifyNone") });
    if (created) navigate(projectPath(created.id, 1));
    return created;
  };
  // Home's « Modifier »: the way first (a dialog), then a new modify project with it whose reference is the network or
  // the file, behind the licence's gate. Closing the dialog makes nothing.
  const [homeWay, setHomeWay] = useState(null); // { name, go(kind) }
  const startWithWay = (created, kind) => {
    if (created && kind) handoverRef.current[created.id] = { brief: null, focus: null, kind };
  };
  const openFromHome = (result) => {
    if (!result?.sessionId) return;
    if (!gateModify(() => openFromHome(result))) return;
    setHomeWay({
      name: result.openedFeed?.name || result.name || null,
      go: (kind) => {
        const created = newModifyProject();
        startWithWay(created, kind);
        if (created) handleNetworkOpened(result, { projectId: created.id, stay: true });
      },
    });
  };
  const dropFromHome = (file) => {
    if (!gateModify(() => dropFromHome(file))) return;
    setHomeWay({
      name: file?.name || null,
      go: (kind) => {
        const created = newModifyProject();
        startWithWay(created, kind);
        if (created) guard(() => uploadForProject(file, created.id), { reason: "upload" });
      },
    });
  };

  // Home's showcase opens the demo on the screen a tab shows: a view of the reader, the assistant, or a draft (behind
  // the licence's gate, which opens the offer).
  // « modify » opens the draft without a way, so the person chooses by hand or with a brief.
  const SHOWCASE_TARGETS = { reader: { view: "horaires" }, shapes: { modify: "hand" }, modify: { modify: true }, sheets: { view: "fiches" }, sql: { view: "sql" } };
  const handleLoadSample = async (options = null) => {
    const target = typeof options?.show === "string" ? SHOWCASE_TARGETS[options.show] : null;
    try {
      setDataLoading(true);
      setError("");
      // The sample gets a new backend session: the current edit DB is released first, else it stays orphaned until
      // TTL cleanup and `editing` stays true on the new session.
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
      // The demo feed may carry deliberate validator findings: its report is shown now, not as a surprise at export.
      takeNetworkReport(result.validationReport);
      await fetchAgencies();
      // Row counts for the SQL console's chips in read mode.
      await refreshStatus();
      if (target) {
        // After the reader has taken the demo's overview as its view.
        setTimeout(() => {
          if (target.view) goToView(target.view);
          if (target.chat) window.dispatchEvent(new CustomEvent(CHAT_OPEN_EVENT));
          if (target.modify) openModifyProject(typeof target.modify === "string" ? { kind: target.modify } : {});
        }, 0);
      }
    } catch (err) {
      console.error("Failed to load sample:", err);
      setError(
        err.isRateLimit ? t("app.rateLimitSample") : t("app.errorAgencies"),
      );
    } finally {
      setDataLoading(false);
    }
  };

  // A share link: the server built the visitor's own session from the snapshot, adopted like the sample.
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
      takeNetworkReport(result.validationReport);
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

  // A network opened from the catalogue or a file in a new server session, adopted like the sample. `target`:
  // { projectId, stay } makes it that modify project's reference (name, origin, opening, validation); { explore } reads it.
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
    // The network replaces the one on screen: unsaved edits go through the guard first.
    guard(() => adoptNetwork(result, target));
  };
  const adoptNetwork = async (result, target = {}) => {
    try {
      setDataLoading(true);
      setError("");
      if (editing) await exitEditMode();
      setSessionId(result.sessionId);
      openedNewNetwork("catalogue");
      takeNetworkReport(result.validationReport);
      setShowValidationReport(false);
      // The project's route leads: the overview is not forced over it.
      await fetchAgencies({ keepView: true });
      await refreshStatus();
      setSelectedMainTabState(0);
      const name = result.openedFeed?.name || "";
      if (name) showToast(t("status.message.networkOpened", { name, routes: (result.counts?.routes ?? 0).toLocaleString(language), trips: (result.counts?.trips ?? 0).toLocaleString(language) }), "success");
      if (target.projectId) {
        adoptForProject(target.projectId, { name, source: "catalogue", report: result.validationReport });
        return;
      }
      // Opened to be read (Home, without the studio's offer): the reader, its overview first.
      goToView("apercu");
    } catch (err) {
      console.error("Failed to open the network:", err);
      setError(t("app.errorAgencies"));
    } finally {
      setDataLoading(false);
    }
  };

  // « Reprendre »: an expired working copy comes back from the project's last frozen zip, never a new download.
  // Resolves once the network is back; throws the server's refusal otherwise.
  const resumeProject = async (projectRecord, version) => {
    const restored = await restoreWorkspaceVersion(projectRecord.id, version.id);
    setDataLoading(true);
    setError("");
    try {
      if (editing) await exitEditMode();
      setSessionId(restored.sessionId);
      openedNewNetwork("version");
      setSessionLost(false);
      takeNetworkReport(restored.validationReport);
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

  // The previous report is dropped only once the person confirmed: dropped earlier, with the dashboard still on
  // screen, it would look like a lost feed.
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


  // ── The project on screen and its network: the draft's screen, then the lens ──
  // The project on screen owns the network open here (its handle) and its working copy is alive.
  const ownsOpenNetwork = Boolean(project?.network?.network_id && project.network.network_id === networkIdRef.current && agencies.length > 0 && !sessionLost);
  // ── One screen for a modification: the project's reader with its panel
  const { draftScreen, draftKind, draftScreenRef, draftSessionId, draftViewMode, draftViewShown, setDraftViewMode, readerDraftKind, draftBarHost, setDraftBarHost, draftHeaderHost, setDraftHeaderHost, draftSideHost, setDraftSideHost, panelAsked } = useDraftScreen({ route, routeRef, project, ownsOpenNetwork, draftView, lensSide, setLensSide, setLensKey, editing, editHold, holdEditing, releaseEditing, enterEditMode, exitEditMode, resetEditStateLocal, dataLoading, agencies, navigate, selectedMainTabRef, networkIdRef, feedLoadedRef, features, createModifyRef, handoverRef, showToast, t });
  // After the draft's screen, whose hold on edit mode comes first.
  const { openReader, markedRoutes, lensCompareShown, readerLensBar, showLensInReader } = useReaderLens({ project, projectId, route, ownsOpenNetwork, draftScreen, draftScreenRef, draftKind, setDraftViewMode, draftView, setDraftView, lensSide, setLensSide, setLensKey, selectedRoute, selectedDirection, selectedDate, routes, baseUrl, language, editing, showToast, t, navigate });

  // ── The chrome: title, top bar, status bar ──────────────────────────────
  const { pageTitle, routeKey, work, homeShown, statusBar, legal } = useAppChrome({ route, project, inExplorer, view, agencies, t, networkIdRef, sessionClock, sessionLost, navigate, updateOpenProject, editing, pendingEdits, dataVersion, backgroundValidating, validatingSeconds, validationStale, reportAt, features, vouchedValidation, dataLoading, validationReport, shareToken, draftScreen, openPanel, setShowValidationReport, pollSession });

  // A stop's « print » (its detail panel) opens the sheets on that stop (sheets/sheetPrefs holds which).
  useEffect(() => {
    const handler = () => {
      if (draftScreen) setDraftViewMode("network");
      goToView("fiches");
    };
    window.addEventListener(OPEN_SHEETS_EVENT, handler);
    return () => window.removeEventListener(OPEN_SHEETS_EVENT, handler);
  }, [draftScreen, setDraftViewMode, goToView]);
  const readerBody = <ReaderBody feed={feed} sessionLost={sessionLost} route={route} sqlConsoleVisible={sqlConsoleVisible} selectedMainTab={selectedMainTab} setSelectedMainTab={setSelectedMainTab} setShowValidationReport={setShowValidationReport} lensKey={lensKey} validationReport={validationReport} importAdjustments={importAdjustments} backgroundValidating={backgroundValidating} validatingSeconds={validatingSeconds} features={features} showSelectorGuide={showSelectorGuide} setShowSelectorGuide={setShowSelectorGuide} openPanel={openPanel} markedRoutes={markedRoutes} lensCompareShown={lensCompareShown} />;
  // Inside a draft the repair station is one of the draft's views, its fixes written in the draft, never a page over
  // the draft's screen.
  const validationShown = Boolean(showValidationReport && validationReport);
  const validationPage = validationShown ? (
    <Deferred>
      <ValidationErrorsPage report={validationReport} onReupload={handleReupload} onBack={closeValidationPage} onReportRefreshed={adoptReport} baselineCounts={validationBaseline} stale={validationStale} backgroundValidating={backgroundValidating} importAdjustments={importAdjustments} />
    </Deferred>
  ) : null;

  // A project's steps have the studio's own look (StudioScope) and its own bar, which holds the steps and the
  // step's actions; the explorer of a project, like the rest of the app, keeps the app's header.
  const studio = route.name === "project";
  // The reader's overview, its lines, the SQL console and the validation report draw their own ground edge to edge: no
  // side padding around them (their bands and panes carry their own inner spacing).
  const readerFlush = agencies.length > 0 && !dataLoading && (sqlConsoleVisible || selectedMainTab === 0 || selectedMainTab === 1 || selectedMainTab === 5 || Boolean(showValidationReport && validationReport)) && !["legal", "rules", "accessibility"].includes(route.name);

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
        flush={studio || homeShown || draftScreen || readerFlush}
        asideRef={setAssistantHost}
      >
      {/* The explorer inside a project: the rail folds into "← Retour à l'étape N". */}
      {route.name === "projectExplorer" && project && !draftScreen && (
        <Rail compact>
          <StepNav folded current={stepFor(project.step || 1)} onSelect={(n) => navigate(projectPath(project.id, n))} />
        </Rail>
      )}
      {route.name === "legal" ? (
        <Deferred>
          <LegalPage tab={route.params.tab} />
        </Deferred>
      ) : route.name === "rules" ? (
        <Deferred>
          <ValidationRulesPage />
        </Deferred>
      ) : route.name === "accessibility" ? (
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
            /* The address is being replaced by the draft's screen. */
            null
          ) : route.name === "project" ? (
            <Deferred>
              <ProjectPage
                id={route.params.id}
                step={route.params.step}
                networkLoaded={agencies.length > 0}
                networkHandle={networkIdRef.current}
                sessionLost={sessionLost}
                unfrozenEdits={sessionClock ? sessionClock.edits : null}
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
          ) : route.name === "modify" ? null : validationReport?.valid === false &&
            validationReport?.structural ? (
            /* No backend session: re-upload is the only way forward. */
            <Deferred>
              <ValidationErrorsPage report={validationReport} onReupload={handleReupload} />
            </Deferred>
          ) : route.name === "home" || (!agencies.length && !shareToken) ? (
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
                onOpenProject={(p) => navigate(projectPath(p.id))}
              />
            </Box>
          ) : validationShown && !draftScreen ? (
            validationPage
          ) : !agencies.length && shareToken ? (
            <Box flexGrow={1} sx={{ overflowY: "auto", px: 2 }}>
              <Deferred>
                <SharedFeedLanding token={shareToken} onOpened={handleShareOpened} onCancel={() => navigate("/", { replace: true })} />
              </Deferred>
            </Box>
          ) : draftScreen ? (
            // Both views stay mounted, one over the other (a map keeps its size, the composer its draft), the hidden one
            // out of sight and of the keyboard.
            <Box data-testid="draft-screen" data-draft-session={draftSessionId ? "on" : "off"} data-view={draftViewShown} sx={{ flex: 1, minHeight: 0, display: "flex", flexDirection: "column" }}>
              <EditModeToggle silent />
              <DeliverButton silent />
              <Box ref={setDraftBarHost} sx={{ flexShrink: 0 }} />
              <Box sx={{ flex: 1, minHeight: 0, display: "flex" }}>
              <Box sx={{ position: "relative", flex: 1, minWidth: 0, minHeight: 0 }}>
                <Box data-testid="draft-network" aria-hidden={draftViewShown !== "network" ? "true" : undefined} inert={draftViewShown !== "network" ? "" : undefined} sx={{ position: "absolute", inset: 0, display: "flex", flexDirection: "column", overflowY: "auto", px: readerFlush ? 0 : 2, visibility: draftViewShown === "network" ? "visible" : "hidden" }}>
                  {showLensInReader && readerLensBar}
                  {validationPage || readerBody}
                </Box>
                <Box data-testid="draft-change" aria-hidden={draftViewShown !== "change" ? "true" : undefined} inert={draftViewShown !== "change" ? "" : undefined} sx={{ position: "absolute", inset: 0, display: "flex", visibility: draftViewShown === "change" ? "visible" : "hidden" }}>
              <Deferred>
                <ProjectPage
                  panel
                  view={draftViewMode}
                  onView={setDraftViewMode}
                  barHost={draftBarHost}
                  headerHost={draftHeaderHost}
                  sideHost={draftSideHost}
                  panelOpen={panelAsked}
                  onPanelOpened={() => navigate(projectExplorerPath(project.id, view || "apercu"), { replace: true })}
                  onLeave={() => navigate(explorerPath(networkIdRef.current, view || "apercu"))}
                  id={project.id}
                  networkLoaded={agencies.length > 0}
                  networkHandle={networkIdRef.current}
                  sessionLost={sessionLost}
                  unfrozenEdits={sessionClock ? sessionClock.edits : null}
                  onResume={resumeProject}
                  actor={me?.display_name || rememberedName() || null}
                  handover={handoverRef.current[project.id] || null}
                  onOpenReader={openReader}
                  onDraft={(d) => setDraftView(d ? { ...d, projectId: project.id } : null)}
                  lens={{ side: lensSide, onSide: setLensSide }}
                  onHandoverTaken={(id) => {
                    delete handoverRef.current[id];
                  }}
                />
              </Deferred>
                </Box>
              </Box>
              {/* Beside the views: a brief draft's report, while the reader shows its network. */}
              <Box ref={setDraftSideHost} data-testid="draft-side" sx={{ flexShrink: 0, display: "flex", minHeight: 0 }} />
              </Box>
            </Box>
          ) : (
            <>
              {showLensInReader && readerLensBar}
              {readerBody}
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
      {/* The person's own GTFS file for a modify project: the step stays on screen. */}
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
      {homeWay && (
        <WayChoice
          networkName={homeWay.name}
          onClose={() => setHomeWay(null)}
          onStart={(kind) => {
            const { go } = homeWay;
            setHomeWay(null);
            go(kind);
          }}
        />
      )}
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
      <ChatAssistantFAB
        host={assistantHost}
        feedLoaded={agencies.length > 0 && !studio}
        feedEpoch={feedEpoch}
        language={language}
        sessionContext={chatSessionContext}
      />
    </>
  );
}

export default GTFSApp;
