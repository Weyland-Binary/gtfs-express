/** The app's routes beyond the screens' choice (utils/routes.jsx). The route decides, the state follows it. */
import { useCallback, useEffect, useRef, useState } from "react";
import { resolveRoute, explorerPath, newNetworkId, projectPath, projectExplorerPath, HOME_PATH } from "../../utils/routes";
import { createProject } from "../../utils/projectStore";
import { licenceLockOf, openPaywall } from "../../utils/featuresApi";
import { summarizeReport } from "../../utils/validationSummary";
import { networkSourceOf } from "./networkSource";

export const TAB_INDEX = Object.freeze({ apercu: 0, horaires: 1, traces: 3, comparer: 4, fiches: 5 });
export const TAB_SLUG = Object.freeze({ 0: "apercu", 1: "horaires", 3: "traces", 4: "comparer", 5: "fiches" });
/** Read live: navigations can precede the render. */
const onValidationPage = () => {
  const current = resolveRoute(window.location.pathname);
  return (current.name === "explorer" || current.name === "projectExplorer") && current.params.tab === "validation";
};

/** A reason for the view guard's dialog: the map editor's own words (the only work in progress a view holds). */
const VIEW_GUARD = { scope: "view", reason: "leaveView" };

/**
 * `guard` / `isViewDirty` (DestructiveGuardContext): a view change that would unmount the view in progress (the
 * shapes editor's draft is in no edit log yet) waits for the person; the SQL console keeps the reader mounted under
 * it, so it never asks.
 */
export function useExplorerView({ view, navigate, networkIdRef, guard = null, isViewDirty = null }) {
  // The last of the four tab views, so the SQL console and the validation page know where « back » is.
  const [selectedMainTab, setSelectedMainTabState] = useState(() => TAB_INDEX[view] ?? 0);
  const selectedMainTabRef = useRef(selectedMainTab);
  selectedMainTabRef.current = selectedMainTab;
  const unmountsView = (slug) => slug !== "sql" && TAB_INDEX[slug] !== selectedMainTabRef.current;
  // The view a goToView() navigation was agreed for: its route change is followed without a second question.
  const agreedViewRef = useRef(null);
  // A route change from elsewhere (Back, a link, the palette) that the guard holds: the reader keeps its view until
  // the person decides. State set in render, like `followedView`, so the validation page stays off meanwhile.
  const [heldView, setHeldView] = useState(null);
  // Follows the route in the same render (not in an effect): the new view is on screen when the shell moves the focus.
  const [followedView, setFollowedView] = useState(view);
  if (followedView !== view) {
    setFollowedView(view);
    const agreed = agreedViewRef.current === view;
    agreedViewRef.current = null;
    if ((view in TAB_INDEX || view === "validation") && !agreed && unmountsView(view) && isViewDirty?.()) setHeldView(view);
    else if (view in TAB_INDEX) setSelectedMainTabState(TAB_INDEX[view]);
  }
  /**
   * Between two views of the same network the entry is pushed and the detail panel's query kept; arriving from Home
   * or a share landing replaces it, so back never bounces into a screen that redirects.
   */
  const navigateToView = useCallback(
    (slug, { replace = false } = {}) => {
      if (!networkIdRef.current) networkIdRef.current = newNetworkId();
      const id = networkIdRef.current;
      // The address bar, not the last render: several navigations can follow each other before React renders.
      const current = resolveRoute(window.location.pathname);
      const inProject = current.name === "projectExplorer" || current.name === "project";
      if (inProject) {
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
      // Remembers the view it was opened over, so its Back button returns to that very entry.
      const state = push && slug === "validation" ? { from: current.params.tab } : undefined;
      navigate(`${explorerPath(id, slug)}${search}`, { replace: !push, state });
    },
    [navigate, networkIdRef],
  );
  // Through the guard first when the view would lose its work in progress; agreed, the route change is followed as is.
  const goToView = useCallback(
    (slug, options) => {
      agreedViewRef.current = null;
      if (guard && unmountsView(slug) && isViewDirty?.()) {
        guard(() => {
          agreedViewRef.current = slug;
          navigateToView(slug, options);
        }, VIEW_GUARD);
        return;
      }
      navigateToView(slug, options);
    },
    [guard, isViewDirty, navigateToView],
  );
  // The held route change: followed once agreed; refused, the address returns to the view still shown (replaced: the
  // entry under it is whatever brought the change, Back or a push from elsewhere, and is not told apart).
  useEffect(() => {
    if (heldView == null || !guard) return;
    if (heldView !== view) {
      setHeldView(null);
      return;
    }
    guard(
      () => {
        setHeldView(null);
        if (heldView in TAB_INDEX) setSelectedMainTabState(TAB_INDEX[heldView]);
      },
      {
        ...VIEW_GUARD,
        onCancel: () => {
          setHeldView(null);
          navigateToView(TAB_SLUG[selectedMainTabRef.current] || "apercu", { replace: true });
        },
      },
    );
  }, [heldView, view, guard, navigateToView]);
  const setSelectedMainTab = useCallback(
    (value, options) => {
      const slug = TAB_SLUG[value] || "apercu";
      if (guard && unmountsView(slug) && isViewDirty?.()) {
        goToView(slug, options);
        return;
      }
      setSelectedMainTabState(value);
      goToView(slug, options);
    },
    [guard, isViewDirty, goToView],
  );
  const showValidationReport = view === "validation" && heldView !== "validation";
  // Closing replaces the page's entry: it is gone, nothing to come back to.
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
  // When the entry under the page is the tab it was pushed from (history.state.from), go back one entry so the
  // history never holds that tab twice; otherwise (a reload, a link, a replace) replace the entry.
  const closeValidationPage = useCallback(() => {
    if (!onValidationPage()) return;
    const target = TAB_SLUG[selectedMainTabRef.current] || "apercu";
    if (window.history.state?.from === target) navigate(-1);
    else goToView(target, { replace: true });
  }, [goToView, navigate]);
  return { selectedMainTab, setSelectedMainTabState, selectedMainTabRef, goToView, setSelectedMainTab, showValidationReport, setShowValidationReport, closeValidationPage };
}

/**
 * The projects started by an address, the route guard and the SQL console's route. The guard waits for the boot
 * hydrations (`bootRef`, `hydratingRef`) before deciding an explorer URL has no network.
 */
export default function useAppRoutes({ route, navigate, agencies, features, featuresLoaded, t, validationReport, statusReady, dataLoading, editing, bootRef, hydratingRef, goToView, selectedMainTabRef, networkIdRef, handoverRef, pendingHandoverRef, inExplorer, view, sqlConsoleVisible, showSqlConsole, hideSqlConsole }) {
  // ── New projects (/modifier)
  // Created once per visit of the address, then replaced by the project's own address, so back never lands on a
  // creation. The guard is forgotten once the route is anything else: the same address visited again starts a new
  // project instead of rendering nothing.
  const startedRef = useRef(null);
  const createModifyForOpenNetwork = () => {
    const handle = networkIdRef.current;
    const name = agencies[0]?.agency_name || agencies[0]?.agency_id || "";
    const summary = summarizeReport(validationReport);
    const origin = networkSourceOf(handle);
    return createProject({ name: t("step.defaultName.modify", { name }), network: { name, source: origin.source, opened_at: origin.at, network_id: handle, baseline_validation: summary.validated ? { errors: summary.errors, warnings: summary.warnings } : null } });
  };
  const createModifyRef = useRef(createModifyForOpenNetwork);
  createModifyRef.current = createModifyForOpenNetwork;
  const startProject = useCallback(
    () => {
      const href = window.location.href;
      if (startedRef.current === href) return;
      startedRef.current = href;
      const handle = new URLSearchParams(window.location.search).get("network");
      const loaded = agencies.length > 0;
      // Without the licence, the offer instead of a project the server would refuse to keep.
      const lock = licenceLockOf(features?.access);
      if (lock === "sign_in_required" || lock === "subscription_required") {
        const asked = window.location.pathname + window.location.search;
        navigate(HOME_PATH, { replace: true });
        openPaywall("studio", lock, () => navigate(asked));
        return;
      }
      if (handle && loaded && handle === networkIdRef.current) {
        const created = createModifyRef.current();
        if (created) {
          if (pendingHandoverRef.current) handoverRef.current[created.id] = pendingHandoverRef.current;
          pendingHandoverRef.current = null;
          navigate(projectPath(created.id, 3), { replace: true });
        }
        return;
      }
      const created = createProject({ name: t("step.defaultName.modifyNone") });
      if (created) navigate(projectPath(created.id, 1), { replace: true });
    },
    [agencies, navigate, t, features, handoverRef, networkIdRef, pendingHandoverRef],
  );

  // ── Route guard
  useEffect(() => {
    if (route.name !== "modify") startedRef.current = null;
    if (route.redirect) {
      navigate(route.redirect, { replace: true });
      return;
    }
    const loaded = agencies.length > 0;
    if (route.name === "modify") {
      // The server's access first: under the paid offer, a draft made before the answer could be refused by the server.
      if (featuresLoaded) startProject();
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
    if (route.name === "share" && loaded && !dataLoading) goToView(TAB_SLUG[selectedMainTabRef.current] || "apercu", { replace: true });
  }, [route, agencies.length, statusReady, dataLoading, editing, validationReport, navigate, goToView, startProject, featuresLoaded, bootRef, hydratingRef, networkIdRef, selectedMainTabRef]);

  // ── The SQL console follows its route
  // The assistant or a validation fix can also open it, and then the route follows. Only what changed since the last
  // run leads, so the two never chase each other.
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
  }, [view, sqlConsoleVisible, inExplorer, agencies.length, goToView, showSqlConsole, hideSqlConsole, selectedMainTabRef]);
  useEffect(() => {
    if (agencies.length && view === "sql" && !sqlConsoleVisible) showSqlConsole();
    // Only when the network arrives.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [agencies.length]);
  return { createModifyRef };
}
