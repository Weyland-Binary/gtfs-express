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
import { builtSessionOf, fetchNetworkReport } from "../utils/networkStudioApi";
import { useRoute, useNavigate, resolveRoute, explorerPath, getNetworkId, newNetworkId, projectPath, projectExplorerPath, modifyPath, CREATE_PATH, MODIFY_PATH } from "../utils/routes";
import { createProject, getProject, listProjects, updateProject, useProject, withJournal, withReference, configureRemote, remoteEnabled, refreshProjects, deliveryOf, withDelivery, setDeliveryResolver } from "../utils/projectStore";
import { draftInProgressOf, modifyProjectsOf } from "../utils/changeStates";
import { countWords } from "../utils/countWords";
import { listWorkspaceProjects, getWorkspaceProject, createWorkspaceProject, patchWorkspaceProject, deleteWorkspaceProject, freezeWorkspaceVersion, deleteWorkspaceVersion, restoreWorkspaceVersion } from "../utils/projectApi";
import { licenceLockOf, networkStudioOn, openPaywall, useFeatures } from "../utils/featuresApi";
import PricingDialog, { PRICING_EVENT } from "./PricingDialog";
import { trackUi, trackVisit } from "../utils/uiTelemetry";
import WorksDialog from "./home/WorksDialog";
import { useAccount } from "../contexts/AccountContext";
// Import of the advanced analysis component

import Accessibility from "./Accessibility";
// The screens a reader may never open load on demand, so Home draws without reading the whole bundle: the SQL
// console, the shape studio, a project's steps (both studios), the legal pages and the rules. Each waits behind a
// loader (Deferred). The comparison and the accessibility statement stay in the bundle: StepDelivery and the footer
// import parts of them. What the first screen never needs travels apart too: the timetable grid (PrimeReact and the
// edit dialogs), the line map (Leaflet), the diff, the share landing, the rejection page.
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
  PAYWALL_EVENT,
} from "../utils/sessionManager";
import { rememberedName } from "./common/AcknowledgementForm";
import { approvalOf, approvalRequired } from "../utils/deliverablesApi";
import { summarizeReport } from "../utils/validationSummary";
import { humanError } from "../utils/humanError";
import { useLanguage } from "../contexts/LanguageContext";
import { useEditMode } from "../contexts/EditModeContext";
import { useDetailPanel } from "../contexts/DetailPanelContext";
import { useDestructiveGuard } from "../contexts/DestructiveGuardContext";

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
  const { guard } = useDestructiveGuard();
  const LOADING_MESSAGES = LOADING_MESSAGE_KEYS.map((key) => t(key));
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
  const { draftView, setDraftView, lensSide, setLensSide, lensKey, setLensKey } = useReaderLensState();
  // A plan handed over to the project already open (« Ajouter au changement »): the page reads the hand-over again.
  const [, setHandoverTick] = useState(0);
  // The explorer's view and the ways to another (app/useAppRoutes).
  const { selectedMainTab, setSelectedMainTabState, selectedMainTabRef, goToView, setSelectedMainTab, showValidationReport, setShowValidationReport, closeValidationPage } = useExplorerView({ view, navigate, networkIdRef });
  // ── The feed: its lists, their loading and the reader's navigation events (app/useFeedLoading) ──
  const feed = useFeedLoading({ baseUrl, t, dataVersion, lensKey, entity, editing, showToast, networkIdRef, setSelectedMainTab, setShowValidationReport });
  const { agencies, setAgencies, routes, setRoutes, selectedRoute, setSelectedRoute, selectedDirection, selectedDate, setSelectedAgency, selectedRouteDetails, setSelectedRouteDetails, error, setError, chosenRouteRef, fetchAgencies, fetchAgenciesRef } = feed;
  const [uploadSuccess, setUploadSuccess] = useState(false);
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
  // The projects: "Concevoir un réseau" (the landing
  // tile, the command palette, "gtfs:open-network-studio") goes to /creer, a
  // new project that designs a network; "Modifier ce réseau" (the overview's
  // next-step card, the palette, the chat's plan cards,
  // "gtfs:open-change-studio") to /modifier, a new project that modifies the
  // network open here — its draft, with the plan (a draft by hand) or the
  // brief (a brief draft) handed over — or, with no network open, its ① where
  // the network is chosen. The studios are the
  // projects' steps, never a full-screen dialog; the assistant's gate is said
  // next to the assistant.
  const [networkReport, setNetworkReport] = useState(null); // the report of a network just built here (the overview's card)
  // The shared landing (/partage/:token; `?share=` redirects there).
  const shareToken = route.name === "share" ? route.params.token : null;
  const { me } = useAccount();
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
      // bar's, the palette's) goes back to its change; a plan of the assistant joins its draft by hand (« Ajouter au
      // changement »), a brief waits in its brief draft's field — never a second project bound to the same working copy.
      const current = routeRef.current;
      const handle = networkIdRef.current;
      const onScreen = current.name === "projectExplorer" || current.name === "project" ? getProject(current.params.id) : null;
      // (« Nouveau projet », the next-step card's own choice beside « Reprendre », asks for a new one: `fresh`.)
      const fresh = Boolean(e?.detail?.fresh);
      const own = !feedLoadedRef.current ? null : onScreen?.job === "modify" && onScreen.network?.network_id === handle ? onScreen : fresh ? null : modifyProjectsOf(listProjects(), handle)[0] || null;
      if (own) {
        // One way per draft: a plan never joins a brief draft in progress.
        if (plan && draftInProgressOf(own) === "brief") {
          showToast(t("draft.otherBlocked"), "info");
          return;
        }
        if (plan || brief || kind) handoverRef.current[own.id] = { plan, brief, append: Boolean(plan), focus: readerFocusRef.current, kind };
        toChange(own.id);
        if (plan) showToast(countWords(t, "change.append.toast", Array.isArray(plan.operations) ? plan.operations.length : 0, { name: own.name }), "success");
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
  // One visit per browser tab, for the operator's console (utils/uiTelemetry).
  useEffect(() => trackVisit(), []);
  useEffect(() => {
    const handler = (e) => {
      trackUi("offer.shown", "pricing");
      setPricing({ reason: e?.detail?.reason || null });
    };
    // The paid offer (sessionManager.PAYWALL_EVENT): a locked journey, « Éditer », or the server's 402 — the same
    // offer, saying what was asked. The server's refusal coming back just after the person closed it (an autosave
    // retrying) does not reopen it; an action of the person always does.
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
  // on it, drop back to Lines — the tab also disappears from Header.
  // Waits for the server's edit status: a reload on /traces in edit mode
  // must not be sent away before the status says it is still editing.
  useEffect(() => {
    if (!statusReady || editing) return;
    if (view === "traces") setSelectedMainTab(1, { replace: true });
    else if (selectedMainTab === 3) setSelectedMainTabState(1);
  }, [statusReady, editing, selectedMainTab, view, setSelectedMainTab, setSelectedMainTabState]);

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
      setLoadingStep((prev) => (prev + 1) % LOADING_MESSAGE_KEYS.length);
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

  // ── New projects (/creer, /modifier), the route guard, the SQL console's route (app/useAppRoutes) ──
  const { createModifyRef } = useAppRoutes({ route, navigate, agencies, features, featuresLoaded, t, validationReport, statusReady, dataLoading, editing, bootRef, hydratingRef, goToView, selectedMainTabRef, networkIdRef, handoverRef, pendingHandoverRef, inExplorer, view, sqlConsoleVisible, showSqlConsole, hideSqlConsole });


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

  // ── The working copy's clock (app/useWorkingCopyClock) ──────────────────
  const { sessionClock, sessionLost, setSessionLost, pollSession } = useWorkingCopyClock({ baseUrl, agencies, feedEpoch });

  // ── Background re-validation (app/useBackgroundValidation) ─────────────
  const { backgroundValidating, validatingSeconds, reportAt, vouchedValidation } = useBackgroundValidation({ baseUrl, adoptReport, agencies, validationReport, validationStale, sessionLost, features, featuresLoaded, feedEpoch, dataVersion });

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
  //                              as its brief draft, with the brief (prefilled, not sent)
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


  // ── The project on screen and its network: the draft's screen, then the lens ──
  // The project on screen owns the network open here (its handle) and its working copy is alive.
  const ownsOpenNetwork = Boolean(project?.network?.network_id && project.network.network_id === networkIdRef.current && agencies.length > 0 && !sessionLost);
  // ── One screen for a modification: the project's reader with the panel « Modifications » (2026-10-13) ──
  const { draftScreen, draftKind, draftScreenRef, draftSessionId, draftViewMode, draftViewShown, setDraftViewMode, readerDraftKind, draftBarHost, setDraftBarHost, draftHeaderHost, setDraftHeaderHost, draftSideHost, setDraftSideHost, panelAsked } = useDraftScreen({ route, routeRef, project, ownsOpenNetwork, draftView, lensSide, setLensSide, setLensKey, editing, editHold, holdEditing, releaseEditing, enterEditMode, exitEditMode, resetEditStateLocal, dataLoading, agencies, navigate, selectedMainTabRef, networkIdRef, feedLoadedRef, features, createModifyRef, handoverRef, showToast, t });
  // The lens's effects, its bar and what the reader marks (app/useReaderLens): after the draft's screen, whose hold on edit
  // mode comes first.
  const { openReader, markedRoutes, lensCompareShown, readerLensBar, showLensInReader } = useReaderLens({ project, projectId, route, ownsOpenNetwork, draftScreen, draftScreenRef, draftKind, setDraftViewMode, draftView, setDraftView, lensSide, setLensSide, setLensKey, selectedRoute, selectedDirection, selectedDate, routes, baseUrl, language, editing, showToast, t, navigate });

  // ── The chrome: title, top bar, status bar ──────────────────────────────
  const { pageTitle, routeKey, work, homeShown, statusBar, legal } = useAppChrome({ route, project, inExplorer, view, agencies, t, networkIdRef, sessionClock, sessionLost, navigate, updateOpenProject, editing, pendingEdits, dataVersion, backgroundValidating, validatingSeconds, validationStale, reportAt, features, vouchedValidation, dataLoading, validationReport, shareToken, draftScreen, openPanel, setShowValidationReport, pollSession });

  // The reader's views (app/ReaderBody): the overview, timetables and map, shapes, comparison, the SQL console over them.
  const readerBody = <ReaderBody feed={feed} sessionLost={sessionLost} route={route} sqlConsoleVisible={sqlConsoleVisible} selectedMainTab={selectedMainTab} setSelectedMainTab={setSelectedMainTab} setShowValidationReport={setShowValidationReport} lensKey={lensKey} validationReport={validationReport} importAdjustments={importAdjustments} networkReport={networkReport} setNetworkReport={setNetworkReport} backgroundValidating={backgroundValidating} validatingSeconds={validatingSeconds} features={features} showSelectorGuide={showSelectorGuide} setShowSelectorGuide={setShowSelectorGuide} openPanel={openPanel} markedRoutes={markedRoutes} lensCompareShown={lensCompareShown} />;

  // A project's steps are the Network Studio: its own look (StudioScope) and its own bar, which holds the steps and the
  // step's actions; the explorer of a project, like the rest of the app, keeps the app's header.
  const studio = route.name === "project";
  // The reader's overview, its lines, the SQL console and the validation report draw their own ground edge to edge: no
  // side padding around them (their bands and panes carry their own inner spacing).
  const readerFlush = agencies.length > 0 && !dataLoading && (sqlConsoleVisible || selectedMainTab === 0 || selectedMainTab === 1 || Boolean(showValidationReport && validationReport)) && !["legal", "rules", "accessibility"].includes(route.name);

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
            <Box data-testid="draft-screen" data-draft-session={draftSessionId ? "on" : "off"} data-view={draftViewShown} sx={{ flex: 1, minHeight: 0, display: "flex", flexDirection: "column" }}>
              <EditModeToggle silent />
              <DeliverButton silent />
              <Box ref={setDraftBarHost} sx={{ flexShrink: 0 }} />
              <Box sx={{ flex: 1, minHeight: 0, display: "flex" }}>
              <Box sx={{ position: "relative", flex: 1, minWidth: 0, minHeight: 0 }}>
                <Box data-testid="draft-network" aria-hidden={draftViewShown !== "network" ? "true" : undefined} inert={draftViewShown !== "network" ? "" : undefined} sx={{ position: "absolute", inset: 0, display: "flex", flexDirection: "column", overflowY: "auto", px: readerFlush ? 0 : 2, visibility: draftViewShown === "network" ? "visible" : "hidden" }}>
                  {showLensInReader && readerLensBar}
                  {readerBody}
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
