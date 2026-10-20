/**
 * useAppRoutes — the app's routes beyond the screens' choice (utils/routes.js): the explorer's views as addresses
 * (`useExplorerView`: which view the reader shows, how a view is reached — pushed between two views of one network,
 * replaced on arrival —, the validation page opened over a view and closed back to it), the projects started by an
 * address (/creer, /modifier), the route guard that replaces short or stale addresses and sends an explorer URL with
 * no network behind it Home, and the SQL console following its route. The route decides, the state follows it.
 */
import { useCallback, useEffect, useRef, useState } from "react";
import { resolveRoute, explorerPath, newNetworkId, projectPath, projectExplorerPath, HOME_PATH } from "../../utils/routes";
import { createProject } from "../../utils/projectStore";
import { licenceLockOf, networkStudioOn, openPaywall } from "../../utils/featuresApi";
import { summarizeReport } from "../../utils/validationSummary";
import { networkSourceOf } from "./networkSource";

// The explorer's tab views: route slug ↔ the index the views were built on.
export const TAB_INDEX = Object.freeze({ apercu: 0, horaires: 1, traces: 3, comparer: 4 });
export const TAB_SLUG = Object.freeze({ 0: "apercu", 1: "horaires", 3: "traces", 4: "comparer" });
/** Whether the address bar is on the validation page (read live: navigations can precede the render). */
const onValidationPage = () => {
  const current = resolveRoute(window.location.pathname);
  return (current.name === "explorer" || current.name === "projectExplorer") && current.params.tab === "validation";
};

/** The explorer's view the route names, and the ways to another view (`goToView`, `setSelectedMainTab`) or to the validation page. */
export function useExplorerView({ view, navigate, networkIdRef }) {
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
    [navigate, networkIdRef],
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
  return { selectedMainTab, setSelectedMainTabState, selectedMainTabRef, goToView, setSelectedMainTab, showValidationReport, setShowValidationReport, closeValidationPage };
}

/**
 * The projects started by an address, the route guard and the SQL console's route. `bootRef` and `hydratingRef` are
 * the boot hydrations' (the guard waits for them before deciding an explorer URL has no network); `createModifyRef`
 * is returned for « Éditer » in the reader, which puts the network in a project the same way.
 */
export default function useAppRoutes({ route, navigate, agencies, features, featuresLoaded, t, validationReport, statusReady, dataLoading, editing, bootRef, hydratingRef, goToView, selectedMainTabRef, networkIdRef, handoverRef, pendingHandoverRef, inExplorer, view, sqlConsoleVisible, showSqlConsole, hideSqlConsole }) {
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
    [agencies, navigate, t, features, handoverRef, networkIdRef, pendingHandoverRef],
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
  }, [route, agencies.length, statusReady, dataLoading, editing, validationReport, navigate, goToView, startProject, featuresLoaded, bootRef, hydratingRef, networkIdRef, selectedMainTabRef]);

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
  }, [view, sqlConsoleVisible, inExplorer, agencies.length, goToView, showSqlConsole, hideSqlConsole, selectedMainTabRef]);
  // A reload on /r/:id/sql: the console opens once the network is back.
  useEffect(() => {
    if (agencies.length && view === "sql" && !sqlConsoleVisible) showSqlConsole();
    // Only when the network arrives.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [agencies.length]);
  return { createModifyRef };
}
