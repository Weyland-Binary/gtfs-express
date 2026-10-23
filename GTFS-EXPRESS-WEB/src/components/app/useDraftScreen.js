/**
 * A modify project whose network is open here is its draft's one screen (/p/:id/voir/…). The screen owns edit mode
 * there: on by itself on « Après » of a draft by hand, held with its reason otherwise. Its effects run before the
 * lens's: the screen's hold on edit mode comes first.
 */
import { useCallback, useEffect, useRef, useState } from "react";
import { useLocation, projectPath, projectExplorerPath } from "../../utils/routes";
import { listProjects, remoteEnabled } from "../../utils/projectStore";
import { bindWorkspaceSession } from "../../utils/projectApi";
import { draftInProgressOf, draftKindOf, modifyProjectsOf } from "../../utils/changeStates";
import { licenceLockOf } from "../../utils/featuresApi";
import { setDraftSession } from "../../utils/sessionManager";
import { TAB_INDEX, TAB_SLUG } from "./useAppRoutes";
import { BEFORE_EDIT_EVENT } from "../../utils/appEvents";

export default function useDraftScreen({ route, routeRef, project, ownsOpenNetwork, draftView, lensSide, setLensSide, setLensKey, editing, editHold, holdEditing, releaseEditing, enterEditMode, exitEditMode, resetEditStateLocal, dataLoading, agencies, navigate, selectedMainTabRef, networkIdRef, feedLoadedRef, features, createModifyRef, handoverRef, showToast, t }) {
  const draftScreen = route.name === "projectExplorer" && project?.job === "modify" && ownsOpenNetwork;
  const draftKind = draftScreen ? draftKindOf(project) : null;
  const draftScreenRef = useRef(draftScreen);
  draftScreenRef.current = draftScreen;
  useEffect(() => {
    if (draftScreen) setLensSide("after");
  }, [draftScreen, setLensSide]);
  // On « Après » of a draft by hand every request of the screen goes to the draft's own session; not once the draft
  // is applied (a new change starts from vN), nor on « Avant » (the working copy, read only).
  const draftSessionId = draftScreen && (draftKind === "hand" || draftKind === "brief") && lensSide === "after" && draftView?.projectId === project?.id && !draftView?.applied ? draftView.draftSession || null : null;
  const retouchable = Boolean(draftSessionId) && draftKind === "hand";
  const swappedRef = useRef(null);
  useEffect(() => {
    if (swappedRef.current === draftSessionId) return;
    const leaving = swappedRef.current;
    swappedRef.current = draftSessionId;
    setDraftSession(draftSessionId);
    // The working copy's edit mode is never shown on: it takes no direct write while its draft is open.
    setLensKey((k) => k + 1);
    if (leaving && !draftSessionId) resetEditStateLocal();
    // The session switched alone leads.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [draftSessionId]);
  useEffect(() => () => setDraftSession(null), []);
  const draftHold = draftScreen && !retouchable ? (draftView?.applied ? "draft.hold.applied" : draftKind === "brief" ? "draft.hold.brief" : lensSide === "before" ? "draft.hold.before" : "draft.hold.opening") : null;
  useEffect(() => {
    if (!draftScreen) return;
    if (retouchable) releaseEditing();
    else if (draftHold) holdEditing(draftHold);
    // The draft's session and its hold lead.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [draftScreen, retouchable, draftHold]);
  // Once the hold is lifted (a render later), edit mode comes on by itself.
  useEffect(() => {
    if (draftScreen && retouchable && !editHold && !editing) enterEditMode({ quiet: true });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [draftScreen, retouchable, editHold, editing]);
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
  const [draftViews, setDraftViews] = useState({});
  const draftViewMode = project ? draftViews[project.id] || null : null;
  const draftViewShown = draftViewMode || "network";
  const readerDraftKind = route.name === "explorer" && agencies.length ? draftInProgressOf(modifyProjectsOf(listProjects(), networkIdRef.current)[0] || null) : null;
  const projectIdNow = project?.id || null;
  const setDraftViewMode = useCallback((v) => {
    if (projectIdNow) setDraftViews((m) => (m[projectIdNow] === v ? m : { ...m, [projectIdNow]: v }));
  }, [projectIdNow]);
  const [draftBarHost, setDraftBarHost] = useState(null);
  const [draftHeaderHost, setDraftHeaderHost] = useState(null);
  const [draftSideHost, setDraftSideHost] = useState(null);
  const location = useLocation();
  const PANEL_OPEN = { livraison: "apply" };
  const panelAsked = draftScreen ? PANEL_OPEN[new URLSearchParams(location.search).get("ouvrir")] || null : null;
  useEffect(() => {
    if (!project || project.job !== "modify" || dataLoading) return;
    if (route.name === "project" && ownsOpenNetwork) {
      const n = Number(route.params.step) || null;
      const open = n >= 4 ? "livraison" : null;
      navigate(`${projectExplorerPath(project.id, TAB_SLUG[selectedMainTabRef.current] || "apercu")}${open ? `?ouvrir=${open}` : ""}`, { replace: true });
    } else if (route.name === "projectExplorer" && !ownsOpenNetwork && !agencies.length) {
      navigate(projectPath(project.id, 1), { replace: true });
    }
    // The address and the ownership lead; the tab is read when they change.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [route.name, route.params?.step, project?.id, project?.job, ownsOpenNetwork, dataLoading, agencies.length]);
  const boundReaderRef = useRef(null);
  useEffect(() => {
    if (route.name !== "projectExplorer" || !project || !ownsOpenNetwork || !remoteEnabled()) return;
    const key = `${project.id}:${networkIdRef.current}`;
    if (boundReaderRef.current === key) return;
    boundReaderRef.current = key;
    bindWorkspaceSession(project.id).catch(() => {
      boundReaderRef.current = null;
    });
  }, [route.name, project, ownsOpenNetwork, networkIdRef]);
  // ── Every modification happens in a project
  // Edit mode asked on a network no project of this browser holds puts it in one first (the project already working on
  // it, else a new one). Synchronous: EditModeToggle asks, then enters.
  const featuresRef = useRef(features);
  featuresRef.current = features;
  useEffect(() => {
    const handler = (event) => {
      const current = routeRef.current;
      const handle = networkIdRef.current;
      if (!handle || !feedLoadedRef.current || current.name !== "explorer") return;
      const lock = licenceLockOf(featuresRef.current?.access);
      if (lock === "sign_in_required" || lock === "subscription_required") return;
      const existing = modifyProjectsOf(listProjects(), handle)[0] || null;
      const target = existing || createModifyRef.current();
      if (!target) return;
      if (event?.detail) event.detail.moved = true;
      // A correction asked from the validation report goes on with its report (and its fix queue) in the draft's screen.
      const tab = current.params.tab in TAB_INDEX || current.params.tab === "sql" || current.params.tab === "validation" ? current.params.tab : "apercu";
      // One way per draft: a brief draft in progress is never turned into one by hand.
      if (existing && draftInProgressOf(existing) === "brief") {
        navigate(projectExplorerPath(target.id, tab));
        showToast(t("draft.otherBlocked"), "info");
        return;
      }
      handoverRef.current[target.id] = { ...(handoverRef.current[target.id] || {}), kind: "hand" };
      navigate(projectExplorerPath(target.id, tab));
      showToast(t(existing ? "dossier.joined" : "dossier.created", { name: target.name }), "info");
    };
    window.addEventListener(BEFORE_EDIT_EVENT, handler);
    return () => window.removeEventListener(BEFORE_EDIT_EVENT, handler);
  }, [navigate, showToast, t, createModifyRef, feedLoadedRef, handoverRef, networkIdRef, routeRef]);
  return { draftScreen, draftKind, draftScreenRef, draftSessionId, draftViewMode, draftViewShown, setDraftViewMode, readerDraftKind, draftBarHost, setDraftBarHost, draftHeaderHost, setDraftHeaderHost, draftSideHost, setDraftSideHost, panelAsked };
}
