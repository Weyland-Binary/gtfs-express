/**
 * useReaderLens — the reader's lens « Avant | Après » (components/reader/ReaderLens) on the app's reader: the draft
 * of the modify project on screen as its Change Studio publishes it (`draftView`), which side the reader shows, and
 * what « Après » entails — every view read again through the API's lens (sessionManager.setReaderLens, `lensKey`), a
 * lens the API lost said once and the change simulated again, a touched line's trips compared before → after for its
 * timetable — and the lens's bar over the reader. Edit mode is the draft's screen's own (app/useDraftScreen).
 *
 * Two hooks: the feed's effects read `lensKey` and are declared before the draft's screen, which the lens's effects
 * read in turn. `useReaderLensState` owns the state at the top of the app; `useReaderLens` runs the effects after
 * the screen's.
 */
import React, { useCallback, useEffect, useMemo, useRef, useState } from "react";
import ReaderLens from "../reader/ReaderLens";
import { projectExplorerPath } from "../../utils/routes";
import { fetchWithSession, getSessionId, setReaderLens, LENS_LOST_EVENT } from "../../utils/sessionManager";
import { formatDate } from "../../utils/formatDate";

export function useReaderLensState() {
  // `draftView`: the draft of the modify project on screen, as its Change Studio publishes it (`onDraft`): { projectId,
  // previewId, operations, touched: [{ route, label, date }], simulating, applied }. « Après » (`lensSide`) makes the
  // reader read that draft through the API's lens (sessionManager.setReaderLens): every view is read again (`lensKey`).
  const [draftView, setDraftView] = useState(null);
  const [lensSide, setLensSide] = useState("before");
  const [lensKey, setLensKey] = useState(0);
  return { draftView, setDraftView, lensSide, setLensSide, lensKey, setLensKey };
}

/**
 * The lens's effects and what the reader draws from them, once the draft's screen is known. `draftScreenRef` is
 * read inside the effects (the screen as it stands when they run), as the app read it.
 */
export default function useReaderLens({ project, projectId, route, ownsOpenNetwork, draftScreen, draftScreenRef, draftKind, setDraftViewMode, draftView, setDraftView, lensSide, setLensSide, setLensKey, selectedRoute, selectedDirection, selectedDate, routes, baseUrl, language, editing, showToast, t, navigate }) {
  // The lens is offered where the draft it shows belongs: the project's own reader (/p/:id/voir), full width — ③
  // reads the draft at its own centre, one line at a time (ChangeReview), and opens this reader on
  // « Après » for the whole network (« Pleine largeur »).
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
  // ③'s « Ouvrir dans le lecteur » (ChangeReview): the project's reader, full width, on « Après » — at the line and on a
  // date a change shows on, when one is named.
  const openReader = useCallback(
    (pid, line = null) => {
      setLensSide("after");
      navigate(projectExplorerPath(pid, line?.route ? "horaires" : "apercu"));
      if (line?.route) setTimeout(() => window.dispatchEvent(new CustomEvent("gtfs:navigate", { detail: { target: "schedule", routeId: line.route, date: line.date || null } })), 0);
    },
    [navigate, setLensSide],
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
  }, [showToast, t, setDraftView, setLensSide]);
  // On the timetable of a line the draft changes: its trips before → after (the working copy, the draft — its own
  // session, or a simulation read through the lens), the new ones marked in the grid — what a map cannot show of a
  // change of service.
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
    // The working copy named (an explicit empty lens, or its own session while the screen works in its draft).
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
      onReport={draftScreen && draftKind === "brief" ? () => setDraftViewMode("change") : null}
      editing={editing}
      retouching={draftScreen}
      compact={draftKind === "hand"}
    />
  ) : null;
  // A draft's screen says its side in the header (transform/DraftBar: the hand's button, the brief's bar), no band over
  // the reader.
  const showLensInReader = route.name === "projectExplorer" && Boolean(readerLensBar) && Boolean(draftView?.previewId || draftView?.draftSession) && !(draftScreen && (draftKind === "hand" || draftKind === "brief"));
  return { openReader, markedRoutes, lensCompareShown, readerLensBar, showLensInReader };
}
