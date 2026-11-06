/**
 * The reader's lens « Avant | Après ». Two hooks: the feed's effects read `lensKey` and are declared before the
 * draft's screen, whose state the lens's effects read in turn; `useReaderLensState` owns the state at the top of the
 * app and `useReaderLens` runs the effects after the screen's.
 */
import React, { useCallback, useEffect, useMemo, useRef, useState } from "react";
import ReaderLens from "../reader/ReaderLens";
import { projectExplorerPath } from "../../utils/routes";
import { fetchWithSession, getSessionId, setReaderLens } from "../../utils/sessionManager";
import { formatDate } from "../../utils/formatDate";
import { LENS_LOST_EVENT, NAVIGATE_EVENT, RESIMULATE_EVENT } from "../../utils/appEvents";

export function useReaderLensState() {
  // `draftView`, as the Change Studio publishes it: { projectId, previewId, operations, touched: [{ route, label,
  // date }], simulating, applied }. « Après » reads that draft through the API's lens and every view again.
  const [draftView, setDraftView] = useState(null);
  const [lensSide, setLensSide] = useState("before");
  const [lensKey, setLensKey] = useState(0);
  return { draftView, setDraftView, lensSide, setLensSide, lensKey, setLensKey };
}

/** `draftScreenRef` is read inside the effects: the screen as it stands when they run. */
export default function useReaderLens({ project, projectId, route, ownsOpenNetwork, draftScreen, draftScreenRef, draftKind, setDraftViewMode, draftView, setDraftView, lensSide, setLensSide, setLensKey, selectedRoute, selectedDirection, selectedDate, routes, baseUrl, language, editing, showToast, t, navigate }) {
  // The lens is offered in the project's own reader (/p/:id/voir) only.
  const lensVisible = Boolean(project?.job === "modify" && ownsOpenNetwork && route.name === "projectExplorer" && draftView?.projectId === project.id);
  const lensPreview = lensVisible && lensSide === "after" && draftView?.previewId ? draftView.previewId : null;
  const lensSetRef = useRef(null);
  useEffect(() => {
    if (lensSetRef.current === lensPreview) return;
    lensSetRef.current = lensPreview;
    setReaderLens(lensPreview);
    setLensKey((k) => k + 1);
    // The lens alone leads.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [lensPreview]);
  // Another project (or none): the lens is « Avant » again. Between a project's steps and its reader the side is kept.
  const lensProjectRef = useRef(projectId);
  useEffect(() => {
    if (lensProjectRef.current === projectId) return;
    lensProjectRef.current = projectId;
    setLensSide(draftScreenRef.current ? "after" : "before");
  }, [projectId, draftScreenRef, setLensSide]);
  // On « Après », at the line and on a date a change shows on when one is named.
  const openReader = useCallback(
    (pid, line = null) => {
      setLensSide("after");
      navigate(projectExplorerPath(pid, line?.route ? "horaires" : "apercu"));
      if (line?.route) setTimeout(() => window.dispatchEvent(new CustomEvent(NAVIGATE_EVENT, { detail: { target: "schedule", routeId: line.route, date: line.date || null } })), 0);
    },
    [navigate, setLensSide],
  );
  // The draft is no longer simulated (expired, or the working copy changed): back to the working copy, said once per
  // draft, and the change simulated again (ChangeStudio listens).
  const lensLostRef = useRef(new Set());
  useEffect(() => {
    const handler = (e) => {
      const id = e?.detail?.previewId || null;
      if (!id || lensLostRef.current.has(id)) return;
      lensLostRef.current.add(id);
      setLensSide("before");
      setDraftView((d) => (d && d.previewId === id ? { ...d, previewId: null, simulating: false } : d));
      showToast(t(e.detail.code === "PREVIEW_STALE" ? "lens.lost.stale" : "lens.lost"), "info");
      window.dispatchEvent(new CustomEvent(RESIMULATE_EVENT));
    };
    window.addEventListener(LENS_LOST_EVENT, handler);
    return () => window.removeEventListener(LENS_LOST_EVENT, handler);
  }, [showToast, t, setDraftView, setLensSide]);
  // The trips of a line the draft changes, before → after, the new ones marked in the grid: what a map cannot show of
  // a change of service.
  const touchedSig = (draftView?.touched || []).map((l) => String(l.route)).join("|");
  const draftAfter = lensVisible && lensSide === "after" && Boolean(draftView?.draftSession);
  const comparing = Boolean(lensPreview || draftAfter);
  const [lensCompare, setLensCompare] = useState(null);
  useEffect(() => {
    setLensCompare(null);
    if (!comparing || !selectedRoute || !selectedDirection || !selectedDate) return undefined;
    if (!touchedSig.split("|").includes(String(selectedRoute))) return undefined;
    const controller = new AbortController();
    const path = `${baseUrl}/stops_and_times/${encodeURIComponent(selectedRoute)}/${encodeURIComponent(selectedDirection)}/${selectedDate.replace(/-/g, "")}`;
    const read = (headers) =>
      fetchWithSession(path, { signal: controller.signal, ...(headers ? { headers } : {}) })
        .then((r) => (r.ok ? r.json() : null))
        .catch(() => null);
    const tripsOf = (body) => new Set((body?.stop_times || []).map((st) => String(st.trip_id)));
    // An explicit empty lens, or the working copy's own session while the screen works in its draft.
    Promise.all([read(lensPreview ? { "X-View-Preview": "" } : { "X-Session-ID": getSessionId() }), read(null)]).then(([base, draft]) => {
      if (controller.signal.aborted) return;
      const before = tripsOf(base);
      const after = tripsOf(draft);
      setLensCompare({ route: String(selectedRoute), before: before.size, after: after.size, added: new Set([...after].filter((id) => !before.has(id))), removed: [...before].filter((id) => !after.has(id)).length });
    });
    return () => controller.abort();
  }, [comparing, lensPreview, selectedRoute, selectedDirection, selectedDate, touchedSig, baseUrl]);
  const markedRoutes = useMemo(() => (lensVisible && touchedSig ? new Set(touchedSig.split("|")) : null), [lensVisible, touchedSig]);
  const lensCompareShown = lensCompare && comparing && lensCompare.route === String(selectedRoute) ? lensCompare : null;
  const lineLabelOf = (id) => {
    const r = routes.find((x) => String(x.route_id) === String(id));
    return r ? String(r.route_short_name || r.route_long_name || id) : String(id);
  };
  // The Change Studio is not mounted in the reader: a simulation it left running is not waited for here.
  const lensDraft = draftView ? { ...draftView, simulating: false } : null;
  const readerLensBar = lensVisible ? (
    <ReaderLens
      draft={lensDraft}
      side={lensSide}
      onSide={setLensSide}
      compare={lensCompareShown ? { label: lineLabelOf(lensCompareShown.route), date: selectedDate ? formatDate(`${selectedDate}T12:00:00`, language) : "", before: lensCompareShown.before, after: lensCompareShown.after, added: lensCompareShown.added.size, removed: lensCompareShown.removed } : null}
      onLine={(line) => window.dispatchEvent(new CustomEvent(NAVIGATE_EVENT, { detail: { target: "schedule", routeId: line.route, date: line.date || null } }))}
      onReport={draftScreen && draftKind === "brief" ? () => setDraftViewMode("change") : null}
      editing={editing}
      retouching={draftScreen}
      compact={draftKind === "hand"}
    />
  ) : null;
  // A draft's screen says its side in the header (transform/DraftBar), no band over the reader.
  const showLensInReader = route.name === "projectExplorer" && Boolean(readerLensBar) && Boolean(draftView?.previewId || draftView?.draftSession) && !(draftScreen && (draftKind === "hand" || draftKind === "brief"));
  return { openReader, markedRoutes, lensCompareShown, readerLensBar, showLensInReader };
}
