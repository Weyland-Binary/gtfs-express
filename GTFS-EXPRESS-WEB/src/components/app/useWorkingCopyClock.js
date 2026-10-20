/**
 * useWorkingCopyClock — the working copy's clock. The server sweeps a working copy after an idle hour or two (no
 * write, no heartbeat): while a network is open, this reads every minute when that will be (GET /session/status,
 * never a touch) and prolongs it by a heartbeat only when the person was active since the last one, so a tab
 * forgotten overnight lets the copy go — the project's retouches frozen first — and the status bar can say, from
 * T-10 min, when it expires. A copy that is gone (404) is said once, in place (`sessionLost`); the boot and the
 * resume flows set it too.
 */
import { useCallback, useEffect, useRef, useState } from "react";
import { resolveRoute } from "../../utils/routes";
import { refreshProject, remoteEnabled } from "../../utils/projectStore";
import { fetchWithSession, getSessionId } from "../../utils/sessionManager";

export default function useWorkingCopyClock({ baseUrl, agencies, feedEpoch }) {
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
          // The working copy's own clock, whatever the screen works in (its draft lives and goes with it).
          const beat = await fetchWithSession(`${baseUrl}/session/heartbeat`, { method: "POST", headers: { "X-Session-ID": getSessionId() } });
          if (beat.status === 404) {
            setSessionLost(true);
            setSessionClock(null);
            return;
          }
          lastTouchRef.current = Date.now();
        }
        const res = await fetchWithSession(`${baseUrl}/session/status`, { cache: "no-store", headers: { "X-Session-ID": getSessionId() } });
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
  return { sessionClock, sessionLost, setSessionLost, pollSession };
}
