/**
 * useDraftScreen — one screen for a modification: a modify project whose network is open here is its reader
 * (/p/:id/voir/…) with the Change Studio as its right panel, in one of two views (« Réseau », the reader full page;
 * « Changement », the change's desk). The screen owns edit mode there: on by itself while the draft can be retouched
 * by hand — a draft by hand is a copy of the working copy kept as a session of its own (the API's
 * transform/draftSession), and on « Après » every request of the screen goes to it (sessionManager setDraftSession):
 * what an editor saves is what the reader shows at once — held with its reason otherwise (« Avant », the working copy,
 * read only), left with the screen. Its steps' addresses lead to the reader (?ouvrir=livraison opens the decision), its reader is
 * bound to the project on the server, and « Éditer » on a network no project holds puts it in one first
 * (gtfs:before-edit). The lens's effects run after this hook's: the screen's hold on edit mode comes first.
 */
import { useCallback, useEffect, useRef, useState } from "react";
import { useLocation, projectPath, projectExplorerPath } from "../../utils/routes";
import { listProjects, remoteEnabled } from "../../utils/projectStore";
import { bindWorkspaceSession } from "../../utils/projectApi";
import { draftInProgressOf, draftKindOf, modifyProjectsOf } from "../../utils/changeStates";
import { licenceLockOf } from "../../utils/featuresApi";
import { setDraftSession } from "../../utils/sessionManager";
import { TAB_INDEX, TAB_SLUG } from "./useAppRoutes";

export default function useDraftScreen({ route, routeRef, project, ownsOpenNetwork, draftView, lensSide, setLensSide, setLensKey, editing, editHold, holdEditing, releaseEditing, enterEditMode, exitEditMode, resetEditStateLocal, dataLoading, agencies, navigate, selectedMainTabRef, networkIdRef, feedLoadedRef, features, createModifyRef, handoverRef, showToast, t }) {
  // A modify project whose network is open here is its reader (/p/:id/voir/…) with the Change Studio as its right
  // panel; its steps' addresses lead there (⑤ opens the decision's dialog, by ?ouvrir=livraison). Without its network,
  // ① stays the page that chooses it (or brings its last version back).
  const draftScreen = route.name === "projectExplorer" && project?.job === "modify" && ownsOpenNetwork;
  // The draft's kind: by hand, the reader is its editor; with a brief (or before the person chose), it is read only.
  const draftKind = draftScreen ? draftKindOf(project) : null;
  const draftScreenRef = useRef(draftScreen);
  draftScreenRef.current = draftScreen;
  // The draft is what the screen shows and edits: « Après » on arriving (« Avant » stays one click away, read only).
  useEffect(() => {
    if (draftScreen) setLensSide("after");
  }, [draftScreen, setLensSide]);
  // A draft by hand is worked in on « Après »: every request of the screen goes to the draft's own session (its
  // copy of the working copy), which the Change Studio opens and publishes (`draftView.draftSession`). Not once the
  // draft is applied (a new change starts from vN), nor on « Avant » (the working copy, read as it is).
  const draftSessionId = draftScreen && (draftKind === "hand" || draftKind === "brief") && lensSide === "after" && draftView?.projectId === project?.id && !draftView?.applied ? draftView.draftSession || null : null;
  // One way per draft: by hand the person writes the draft; with a brief its agent does (its change proved by the
  // review), the person reads it.
  const retouchable = Boolean(draftSessionId) && draftKind === "hand";
  const swappedRef = useRef(null);
  useEffect(() => {
    if (swappedRef.current === draftSessionId) return;
    const leaving = swappedRef.current;
    swappedRef.current = draftSessionId;
    setDraftSession(draftSessionId);
    // Every view reads again, from the session it now names; the edit mode shown is that session's: the draft's comes
    // on below, the working copy's is never shown on (it takes no direct write while its draft is open).
    setLensKey((k) => k + 1);
    if (leaving && !draftSessionId) resetEditStateLocal();
    // The session switched alone leads.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [draftSessionId]);
  useEffect(() => () => setDraftSession(null), []);
  // Edit mode is the draft's own there: on while the draft can be retouched (no « Éditer » to press), held otherwise
  // with its reason; left with the draft (the reader outside it reads, its « Modifier » opens the draft again).
  const draftHold = draftScreen && !retouchable ? (draftView?.applied ? "draft.hold.applied" : draftKind === "brief" ? "draft.hold.brief" : lensSide === "before" ? "draft.hold.before" : "draft.hold.opening") : null;
  useEffect(() => {
    if (!draftScreen) return;
    if (retouchable) releaseEditing();
    else if (draftHold) holdEditing(draftHold);
    // The draft's session and its hold lead.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [draftScreen, retouchable, draftHold]);
  // Once the hold is lifted (a render later), edit mode comes on by itself, in the draft (already on there: the
  // answer only says it to the screen).
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
  // Beside the reader: a brief draft's report.
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
      // The project's reader without its network (a reload, a link): its page brings the last version back, or asks it.
      navigate(projectPath(project.id, 1), { replace: true });
    }
    // The address and the ownership lead; the tab is read when they change.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [route.name, route.params?.step, project?.id, project?.job, ownsOpenNetwork, dataLoading, agencies.length]);
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
  }, [route.name, project, ownsOpenNetwork, networkIdRef]);
  // ── Dossier automatique: every modification happens in a project ──
  // Asking for edit mode on a network no project of this browser holds (the reader out of any project) puts it in one
  // first — the modify project that already works on it, else a new one —, in the same view of its own reader: its
  // retouches join the project's journal, its versions and its one delivery. Synchronous (EditModeToggle asks, then
  // enters). Without the studio's offer, the retouches stay outside a project.
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
      // The person goes to the draft: edit mode is its screen's, not asked of this working copy.
      if (event?.detail) event.detail.moved = true;
      const tab = current.params.tab in TAB_INDEX || current.params.tab === "sql" ? current.params.tab : "apercu";
      // A brief draft in progress keeps its way: one way per draft, the other once it is applied or abandoned.
      if (existing && draftInProgressOf(existing) === "brief") {
        navigate(projectExplorerPath(target.id, tab));
        showToast(t("draft.otherBlocked"), "info");
        return;
      }
      // Editing in the reader is the draft's work by hand.
      handoverRef.current[target.id] = { ...(handoverRef.current[target.id] || {}), kind: "hand" };
      navigate(projectExplorerPath(target.id, tab));
      showToast(t(existing ? "dossier.joined" : "dossier.created", { name: target.name }), "info");
    };
    window.addEventListener("gtfs:before-edit", handler);
    return () => window.removeEventListener("gtfs:before-edit", handler);
  }, [navigate, showToast, t, createModifyRef, feedLoadedRef, handoverRef, networkIdRef, routeRef]);
  return { draftScreen, draftKind, draftScreenRef, draftSessionId, draftViewMode, draftViewShown, setDraftViewMode, readerDraftKind, draftBarHost, setDraftBarHost, draftHeaderHost, setDraftHeaderHost, draftSideHost, setDraftSideHost, panelAsked };
}
