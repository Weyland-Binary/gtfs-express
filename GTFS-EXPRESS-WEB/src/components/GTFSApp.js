import React, {
  useState,
  useEffect,
  useRef,
  useCallback,
  useMemo,
} from "react";
import "./GTFSApp.css";
import LineMap from "./LineMap";
import LineSelector from "./LineSelector";
import ScheduleGrid from "./ScheduleGrid";
import StopSearchAutocomplete from "./StopSearchAutocomplete";
import Header from "./Header/Header";
import DetailPanel from "./DetailPanel";
import {
  Container,
  Typography,
  Box,
  Tabs,
  Tab,
  Alert,
  TextField,
  InputAdornment,
  IconButton,
  Chip,
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
import GTFSUploader from "./GTFSUploader";
import HomeDashboard from "./HomeDashboard";
import CommandPalette from "./CommandPalette";
import ShortcutsHelpDialog from "./ShortcutsHelpDialog";
import ChatAssistantFAB from "./chat/ChatAssistantFAB";
import SqlConsole from "./SqlConsole/SqlConsole";
import ShapeStudio from "./shapeStudio/ShapeStudio";
import FeedDiffPage from "./diff/FeedDiffPage";
// Import of the advanced analysis component

import ValidationErrorsPage from "./ValidationErrorsPage";
import CGU from "./CGU";
import API_BASE_URL from "../config";
import {
  getSessionId,
  fetchWithSession,
  setSessionId,
} from "../utils/sessionManager";
import { sortRoutesByPublisherOrder } from "../utils/routeSort";
import { useLanguage } from "../contexts/LanguageContext";
import { useEditMode } from "../contexts/EditModeContext";
import { useDetailPanel } from "../contexts/DetailPanelContext";

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
  } = useEditMode();
  const { openPanel, entity, sqlConsoleVisible } = useDetailPanel();
  const LOADING_MESSAGES = [
    t("app.loadingStep1"),
    t("app.loadingStep2"),
    t("app.loadingStep3"),
  ];
  const [loading, setLoading] = useState(false);
  const [feedEpoch, setFeedEpoch] = useState(0);
  const [agencies, setAgencies] = useState([]);
  const [routes, setRoutes] = useState([]);
  const [selectedRoute, setSelectedRoute] = useState(null);
  const [selectedDirection, setSelectedDirection] = useState("");
  const selectedDirectionRef = useRef("");
  // Marks the route|date combination whose directions have been resolved and
  // are now authoritative. The stops effect refuses to fetch until this key
  // matches the current selectedRoute|selectedDate, which suppresses the
  // stale-closure fetch that fired in the same commit as a route/date change
  // (before the directions effect's setSelectedDirection had settled) and
  // caused the schedule grid / map to load twice on every filter change.
  const directionsLoadedKeyRef = useRef("");
  const [directions, setDirections] = useState([]);
  // Bumped each time directions are (re)loaded for a new route|date so the
  // stops effect refetches even when the resolved direction value is unchanged
  // — replaces the old "blank selectedDirection to force a re-fire" trick that
  // unmounted the grid+map block (Leaflet re-init) and caused the double load.
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
  // (the former eager /stops/all fetch was removed: InsertStopDialog now
  // pulls the list on demand when it opens, so we no longer pay the
  // 6-15 MB JSON cost on every dataVersion bump.)
  // selectedMainTab manages the main views:
  // 0: Home dashboard (with ShapesMap + stats inline), 1: Schedules & Map,
  // 3: Shape Studio (edit mode only). Deep-linked via ?tab= so views are
  // shareable and survive a reload (session lifetime permitting).
  const [selectedMainTab, setSelectedMainTabState] = useState(() => {
    const tab = new URLSearchParams(window.location.search).get("tab");
    return { home: 0, schedules: 1, studio: 3, compare: 4 }[tab] ?? 0;
  });
  const setSelectedMainTab = useCallback((value) => {
    setSelectedMainTabState(value);
    const slug = { 0: "home", 1: "schedules", 3: "studio", 4: "compare" }[
      value
    ];
    const url = new URL(window.location.href);
    if (slug && slug !== "home") url.searchParams.set("tab", slug);
    else url.searchParams.delete("tab");
    window.history.replaceState(window.history.state || {}, "", url.toString());
  }, []);
  // Browser back/forward restores the tab encoded in the URL.
  useEffect(() => {
    const onPop = () => {
      const tab = new URLSearchParams(window.location.search).get("tab");
      setSelectedMainTabState(
        { home: 0, schedules: 1, studio: 3, compare: 4 }[tab] ?? 0,
      );
    };
    window.addEventListener("popstate", onPop);
    return () => window.removeEventListener("popstate", onPop);
  }, []);
  const [selectedSecondaryTab, setSelectedSecondaryTab] = useState(0);
  const [selectedAgency, setSelectedAgency] = useState("");
  const [selectedRouteDetails, setSelectedRouteDetails] = useState(null);
  const [error, setError] = useState("");
  const [uploadSuccess, setUploadSuccess] = useState(false);
  const [calendar, setCalendar] = useState([]);
  const [calendarDates, setCalendarDates] = useState([]);
  const [validationReport, setValidationReport] = useState(null);
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
  const [showCGU, setShowCGU] = useState(false);
  const [dataLoading, setDataLoading] = useState(false);
  const [loadingStep, setLoadingStep] = useState(0);
  const [showValidationReport, setShowValidationReport] = useState(false);
  const [showSelectorGuide, setShowSelectorGuide] = useState(false);

  // Listen for the custom event dispatched by ExportPreflightDialog → "Review errors"
  useEffect(() => {
    const handler = () => setShowValidationReport(true);
    window.addEventListener("gtfs:review-errors", handler);
    return () => window.removeEventListener("gtfs:review-errors", handler);
  }, []);

  // Shape Studio (tab 3) is edit-mode-only. If the user leaves edit mode while
  // on it, drop back to Schedules & Map — the tab also disappears from Header.
  useEffect(() => {
    if (!editing && selectedMainTab === 3) setSelectedMainTab(1);
  }, [editing, selectedMainTab]);

  // A guided chat repair (RepairFlow) revalidates the feed after applying a
  // fix and broadcasts the fresh report — adopt it so the header badge, the
  // validation page and the chat session context all stay in sync.
  useEffect(() => {
    const handler = (e) => {
      const report = e?.detail?.report;
      if (report && typeof report === "object") setValidationReport(report);
    };
    window.addEventListener("gtfs:validation-refreshed", handler);
    return () =>
      window.removeEventListener("gtfs:validation-refreshed", handler);
  }, []);

  // Close the validation report when a fix navigates the user elsewhere
  // (e.g. FixInSqlConsoleButton → SQL Console). The validation page is
  // mutex-rendered with the rest of the app, so without this dismiss the
  // navigation request would be silently ignored — user sees a toast but
  // stays stuck on the report.
  useEffect(() => {
    const handler = () => setShowValidationReport(false);
    window.addEventListener("gtfs:close-validation-report", handler);
    return () =>
      window.removeEventListener("gtfs:close-validation-report", handler);
  }, []);

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
  useEffect(() => {
    if (!statusReady) return;
    if (hydratedFromEditRef.current) return;
    if (editing && !agencies.length) {
      hydratedFromEditRef.current = true;
      setDataLoading(true);
      fetchAgencies().finally(() => {
        setDataLoading(false);
        setShowSelectorGuide(false);
      });
    }
  }, [statusReady, editing]);

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
  const dataVersionAgenciesRef = useRef(dataVersion);
  useEffect(() => {
    if (dataVersion === dataVersionAgenciesRef.current) return;
    dataVersionAgenciesRef.current = dataVersion;
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
  }, [dataVersion, baseUrl]);

  // Re-fetch routes silently when dataVersion changes (undo / edit mutation).
  // Skip initial mount (dataVersion === 0) and skip when no agency is selected.
  const dataVersionRef = useRef(dataVersion);
  useEffect(() => {
    if (dataVersion === dataVersionRef.current) return;
    dataVersionRef.current = dataVersion;
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
  }, [dataVersion, selectedAgency, baseUrl]);

  // The full list of stops used to be eager-fetched here on every
  // dataVersion change. On large feeds (~30k stops + parent stations =
  // 6-15 MB JSON) this was a major bandwidth + parse-time hit on every
  // edit. The single real consumer is InsertStopDialog, which now does
  // its own lazy fetch when it opens. allStops is kept as state purely
  // so the legacy ScheduleGrid signature still receives an array (it
  // tolerates an empty one and falls back to the route's stops).

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
    // re-sanitizes and caps the list). Defensive Array.isArray: this memo
    // crashed the whole app when a backend error envelope leaked into the
    // agencies state (Docker, failed upload-time migration) — never again.
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

    if (!validationReport || !validationReport.errors) {
      if (!feed && !adjustments) return null;
      return {
        ...(feed ? { feed } : {}),
        ...(adjustments ? { importAdjustments: adjustments } : {}),
        tab,
      };
    }
    const counts = validationReport.counts || {};
    const tally = new Map();
    for (const findings of Object.values(validationReport.errors)) {
      if (!Array.isArray(findings)) continue;
      for (const f of findings) {
        if (!f || !f.ruleCode) continue;
        // Import-resolved findings (duplicates dropped by the tolerant
        // loader) are not outstanding work — keep them out of the model's
        // "top findings" so it never drafts repairs for absent rows.
        if (f.resolvedByImport) continue;
        const key = `${f.ruleCode}::${f.severity || "error"}`;
        tally.set(key, (tally.get(key) || 0) + 1);
      }
    }
    const topRules = Array.from(tally.entries())
      .map(([key, count]) => {
        const [code, severity] = key.split("::");
        return { code, severity, count };
      })
      .sort((a, b) => b.count - a.count)
      .slice(0, 5);
    return {
      validation: {
        errors: counts.errors || 0,
        warnings: counts.warnings || 0,
        infos: counts.infos || 0,
        topRules,
      },
      feed,
      ...(adjustments ? { importAdjustments: adjustments } : {}),
      tab,
    };
  }, [
    validationReport,
    showValidationReport,
    selectedMainTab,
    agencies,
    importAdjustments,
  ]);

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
      // The feed was accepted but gtfs.db could not be built — reads will
      // fail until edit mode re-runs the migration. Say it loudly instead of
      // leaving the user on a silently broken landing page.
      console.error("Upload migration failed:", meta.migrationError);
      showToast(t("upload.migrationFailed"), "error");
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
    setFeedEpoch((e) => e + 1);
    setValidationReport(validationReport);
    setValidationBaseline(validationReport?.counts || null);
    // Structural rejections (corrupt rows, REQUIRED_FIELDS_MISSING) have no
    // backend session — the full-screen report with "re-upload" is all we
    // can offer. Everything else, INCLUDING a feed with canonical errors,
    // now has a live session (rescue flow): load the app around it.
    if (!validationReport?.structural) {
      setDataLoading(true);
      fetchAgencies().finally(() => {
        setDataLoading(false);
        setShowSelectorGuide(false);
        setSelectedMainTab(0);
      });
      // SQL-first: backend builds gtfs.db at upload. Pull the row counts so
      // the SQL Console "Browse files" chips light up immediately in read mode.
      refreshStatus();
      if (validationReport?.valid === false) {
        // Rescue landing: open the repair station on top of the loaded app.
        setShowValidationReport(true);
      }
    }
  };

  // Called after a `.gtfsproj` has been successfully imported via GTFSUploader.
  // EditModeContext.openProject() has already switched to edit mode on the context side;
  // what remains is to populate agencies to exit the landing screen.
  const handleProjectOpened = async () => {
    setUploadSuccess(true);
    setTimeout(() => setUploadSuccess(false), 3000);
    setFeedEpoch((e) => e + 1);
    // An imported project has no associated validation report: we start from
    // a clean slate — the user can re-run validation on demand.
    setValidationReport(null);
    setValidationBaseline(null);
    setShowValidationReport(false);
    setDataLoading(true);
    try {
      await fetchAgencies();
      setShowSelectorGuide(false);
      setSelectedMainTab(0);
    } finally {
      setDataLoading(false);
    }
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
        const body = await response.json().catch(() => null);
        setError(body?.error || t("app.errorAgencies"));
        return;
      }
      const result = await response.json();
      if (!result.sessionId) {
        setError(t("app.errorAgencies"));
        return;
      }
      setSessionId(result.sessionId);
      setFeedEpoch((e) => e + 1);
      // The sample feed is trusted but may contain deliberate validator
      // findings (e.g. block-overlap trips in the NYC demo fixture). Surface
      // the baseline report to the user so there's no surprise at export time.
      if (result.validationReport) {
        setValidationReport(result.validationReport);
        setValidationBaseline(result.validationReport.counts || null);
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

  const handleReupload = async () => {
    if (editing) {
      await exitEditMode();
    }
    setValidationReport(null);
    setValidationBaseline(null);
    setShowValidationReport(false);
  };

  const fetchAgencies = async () => {
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
      // Reset the main tab (e.g. return to the Schedules view)
      setSelectedMainTab(0);
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
    // Do NOT blank selectedDirection / directions here: the selectedDirection
    // render gate unmounts the entire grid+map block (re-initialising Leaflet)
    // whenever it is falsy, which is what made the schedule/map appear to load
    // twice on a route change. The keyRef guard in fetchStopsAndTimes already
    // blocks any stale fetch, and the directions effect re-selects the correct
    // direction (and bumps scheduleRefetchToken) once R2's directions load.
    setStopFilter("");
    // We no longer reset the date, to keep it when changing route
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
  }, [selectedRoute, baseUrl, dataVersion]);

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
  }, [selectedRoute, baseUrl, dataVersion]);

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
        // direction 0). This replaces the old blank-to-"" re-fire trick.
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
  }, [selectedRoute, selectedDate, baseUrl]);

  const fetchStopsAndTimes = async () => {
    // Gate: only fetch once the directions effect has confirmed this exact
    // route|date is authoritative AND a direction is selected. This blocks the
    // stale-closure fetch (old direction, new route/date) that runs in the same
    // commit as a route/date change, before the directions effect resolves —
    // the cause of the double load on every filter change.
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
    setLoading(true);
    setError("");
    try {
      const stopsTimesResponse = await fetchWithSession(
        `${baseUrl}/stops_and_times/${encodeURIComponent(selectedRoute)}/${encodeURIComponent(selectedDirection)}/${formattedDate}`,
      );
      if (!stopsTimesResponse.ok) {
        const errorText = await stopsTimesResponse.text();
        throw new Error(errorText);
      }
      const stopsTimesData = await stopsTimesResponse.json();
      setStopsAndTimes(stopsTimesData);

      const shapesResponse = await fetchWithSession(
        `${baseUrl}/shapes/${encodeURIComponent(selectedRoute)}/${encodeURIComponent(selectedDirection)}`,
      );

      if (!shapesResponse.ok) {
        const errorText = await shapesResponse.text();
        throw new Error(errorText);
      }
      const shapesData = await shapesResponse.json();
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
    } catch (error) {
      console.error("Error fetching route data:", error);
      if (error.isRateLimit) {
        setError(`⚠️ ${error.message}`);
      } else {
        setError(t("app.noService"));
      }
      setStopsAndTimes({
        stops: [],
        stop_times: [],
        has_frequencies: false,
        has_normal_times: true,
        frequency_info: [],
      });
    } finally {
      setLoading(false);
    }
  };

  // Refetch on route/direction/date change → show spinner (normal UX).
  // scheduleRefetchToken re-fires this after directions (re)load even when the
  // direction value didn't change, so we no longer blank the direction (which
  // unmounted the grid+map block and caused the visible double reload).
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
  // intent) armed — instead of editing in the now-read-only Schedules & Map map.
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
      const { shapeId, initialPoints, linkTripIds, routeId, agencyId } =
        e.detail || {};
      if (!shapeId) return;
      setStudioTarget({
        agencyId: agencyId || selectedAgencyRef.current,
        routeId: routeId || selectedRouteRef.current,
        create: {
          shapeId,
          initialPoints: initialPoints || [],
          linkTripIds: linkTripIds || [],
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
  }, []);

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

  useEffect(() => {
    const handleShowCGU = () => setShowCGU(true);
    window.addEventListener("showCGU", handleShowCGU);
    return () => {
      window.removeEventListener("showCGU", handleShowCGU);
    };
  }, []);

  return (
    <Container
      maxWidth={false}
      disableGutters
      sx={{
        display: "flex",
        flexDirection: "column",
        height: "calc(100vh - 42px)",
        paddingX: 2,
      }}
    >
      {showCGU ? (
        <CGU onClose={() => setShowCGU(false)} />
      ) : (
        <>
          <Header
            agenciesLoaded={agencies.length > 0}
            selectedMainTab={selectedMainTab}
            setSelectedMainTab={setSelectedMainTab}
            validationReport={validationReport}
            onShowValidationReport={() => setShowValidationReport(true)}
          />
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
          ) : validationReport?.valid === false &&
            validationReport?.structural ? (
            /* Structural rejection (no backend session): re-upload is the
               only way forward. */
            <ValidationErrorsPage
              report={validationReport}
              onReupload={handleReupload}
            />
          ) : showValidationReport && validationReport ? (
            /* Repair station — also the rescue landing for feeds loaded with
               canonical errors. The session is live: findings can be fixed,
               re-validated and the app freely navigated. */
            <ValidationErrorsPage
              report={validationReport}
              onReupload={handleReupload}
              onBack={() => setShowValidationReport(false)}
              onReportRefreshed={setValidationReport}
              baselineCounts={validationBaseline}
            />
          ) : !agencies.length ? (
            <Box
              display="flex"
              justifyContent="center"
              alignItems={{ xs: "flex-start", md: "center" }}
              flexGrow={1}
            >
              <GTFSUploader
                onUploadSuccess={handleUploadSuccess}
                onLoadSample={handleLoadSample}
                onProjectOpened={handleProjectOpened}
                sampleError={error}
              />
            </Box>
          ) : (
            <>
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
                  <SqlConsole />
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
                  <HomeDashboard
                    validationReport={validationReport}
                    onNavigateToValidation={(ruleCode) => {
                      setShowValidationReport(true);
                    }}
                    onNavigateToSchedule={() => setSelectedMainTab(1)}
                  />
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
                                      sx={(theme) => ({
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
                                          wheelchairAccessibleTrips={
                                            stopsAndTimes.wheelchair_accessible_trips
                                          }
                                          totalTrips={stopsAndTimes.total_trips}
                                        />
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
                                      <LineMap
                                        chrome="readonly"
                                        shapesById={shapes}
                                        allRouteShapes={allRouteShapes}
                                        stops={stopsAndTimes.stops}
                                        focusedStopId={focusedStopId}
                                      />
                                    )}
                                  </Box>
                                )}
                            </>
                          )}
                      </>
                    )}
                  </>
                ) : selectedMainTab === 3 ? (
                  <ShapeStudio agencies={agencies} target={studioTarget} />
                ) : selectedMainTab === 4 ? (
                  <FeedDiffPage />
                ) : null}
              </Box>
            </>
          )}
          {uploadSuccess && (
            <Alert severity="success" style={{ marginTop: "auto" }}>
              {t("app.uploadSuccess")}
            </Alert>
          )}
          <Footer />
        </>
      )}
      <DetailPanel />
      <CommandPalette />
      <ShortcutsHelpDialog />
      <ChatAssistantFAB
        feedLoaded={agencies.length > 0}
        feedEpoch={feedEpoch}
        language={language}
        sessionContext={chatSessionContext}
      />
    </Container>
  );
}

export default GTFSApp;
