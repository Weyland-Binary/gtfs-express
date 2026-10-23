/**
 * The server sweeps an idle working copy. This reads every minute when that will be (GET /session/status is never a
 * touch) and sends a heartbeat only when the person was active since the last one, so a tab forgotten overnight lets
 * the copy go. A copy gone (404) sets `sessionLost`, said once in place.
 */
import { useCallback, useEffect, useRef, useState } from "react";
import { resolveRoute } from "../../utils/routes";
import { refreshProject, remoteEnabled } from "../../utils/projectStore";
import { fetchWithSession, getSessionId } from "../../utils/sessionManager";
import { SESSION_LOST_EVENT, WORK_FROZEN_EVENT } from "../../utils/appEvents";

export default function useWorkingCopyClock({ baseUrl, agencies, feedEpoch }) {
  const [sessionClock, setSessionClock] = useState(null); // { remainingMs, edits, base, at }
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
          // Always the working copy's session, even on a draft's screen: the draft lives and goes with it.
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
        // The retouches were just frozen in a version: closing the tab loses nothing.
        if (edits === 0 && editsSeenRef.current > 0) window.dispatchEvent(new CustomEvent(WORK_FROZEN_EVENT));
        editsSeenRef.current = edits;
        // `base`: the version the working copy was restored from or last frozen as.
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
  // An edit met 404 SESSION_NOT_FOUND: said at once, without waiting for the next tick.
  useEffect(() => {
    if (!agencies.length) return undefined;
    const handler = () => {
      setSessionLost(true);
      setSessionClock(null);
    };
    window.addEventListener(SESSION_LOST_EVENT, handler);
    return () => window.removeEventListener(SESSION_LOST_EVENT, handler);
  }, [agencies.length]);
  // The project carries its snapshots: read it again once the edits were frozen, and the count of edits left.
  useEffect(() => {
    const handler = () => {
      const current = resolveRoute(window.location.pathname);
      const pid = current.name === "project" || current.name === "projectExplorer" ? current.params.id : null;
      if (pid && remoteEnabled()) refreshProject(pid);
      if (agencies.length) pollSession();
    };
    window.addEventListener(WORK_FROZEN_EVENT, handler);
    return () => window.removeEventListener(WORK_FROZEN_EVENT, handler);
  }, [agencies.length, pollSession]);
  return { sessionClock, sessionLost, setSessionLost, pollSession };
}
