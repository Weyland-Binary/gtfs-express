/**
 * While this tab holds a project's network it says so to the server every half minute and when it comes back to the
 * front (worked on since or not), and lets the project go as the page closes or as it stops holding it. Told that
 * another tab or device took it (its beat answered `held: false`, or a write refused 409 PROJECT_TAKEN), it lets go at
 * once through `onLost`.
 */

import { useEffect, useRef } from "react";
import { beatWorkspacePresence } from "../../utils/projectApi";
import { remoteEnabled } from "../../utils/projectStore";
import { getSessionId } from "../../utils/sessionManager";
import { PROJECT_TAKEN_EVENT } from "../../utils/appEvents";

const BEAT_MS = 30000;
// Coming back to the window beats at once, at most this often.
const FOCUS_MS = 3000;
const WORK = ["pointerdown", "keydown", "wheel"];

export default function useProjectHolding({ projectId, holds, onLost }) {
  const onLostRef = useRef(onLost);
  onLostRef.current = onLost;
  useEffect(() => {
    if (!projectId || !holds || !remoteEnabled()) return undefined;
    // The copy beaten for: a network opened later in this tab never speaks for this project.
    const sessionId = getSessionId();
    let alive = true;
    let lost = false;
    let worked = true;
    const lose = (holder) => {
      if (lost || !alive) return;
      lost = true;
      onLostRef.current?.(holder || null);
    };
    const beat = () => {
      const active = worked;
      worked = false;
      return beatWorkspacePresence(projectId, { active, sessionId })
        .then((out) => {
          if (out && out.held === false) lose(out.holder);
        })
        .catch(() => {
          worked = worked || active;
        });
    };
    const release = () => {
      if (!lost) beatWorkspacePresence(projectId, { release: true, sessionId }).catch(() => {});
    };
    const markWorked = () => {
      worked = true;
    };
    let lastFocus = 0;
    const onVisible = () => {
      if (document.visibilityState !== "visible" || Date.now() - lastFocus < FOCUS_MS) return;
      lastFocus = Date.now();
      beat();
    };
    const onTaken = (event) => lose(event.detail?.holder);
    beat();
    const timer = setInterval(beat, BEAT_MS);
    WORK.forEach((name) => window.addEventListener(name, markWorked, { passive: true }));
    document.addEventListener("visibilitychange", onVisible);
    window.addEventListener("focus", onVisible);
    window.addEventListener(PROJECT_TAKEN_EVENT, onTaken);
    window.addEventListener("pagehide", release);
    return () => {
      alive = false;
      clearInterval(timer);
      WORK.forEach((name) => window.removeEventListener(name, markWorked));
      document.removeEventListener("visibilitychange", onVisible);
      window.removeEventListener("focus", onVisible);
      window.removeEventListener(PROJECT_TAKEN_EVENT, onTaken);
      window.removeEventListener("pagehide", release);
      // No longer holding it here (another network opened, the project left): free for another tab or device.
      release();
    };
  }, [projectId, holds]);
}
