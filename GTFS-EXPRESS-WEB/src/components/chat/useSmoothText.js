/**
 * useSmoothText — silky streaming text reveal.
 *
 * SSE tokens arrive in bursty chunks (whole sentences at once, then a
 * pause), which makes the raw render feel jittery. This hook turns the
 * growing target string into a smooth character reveal driven by
 * requestAnimationFrame, with an ADAPTIVE catch-up rate: the further the
 * display lags behind the stream, the bigger the per-frame chunk — so the
 * animation never adds more than ~250ms of perceived latency and always
 * lands exactly on the final text.
 *
 * Contract:
 *   - while `enabled` (streaming), returns the progressively revealed text;
 *   - the moment `enabled` flips false (turn complete/aborted), it snaps to
 *     the full target — completion is never delayed by the animation;
 *   - a shrinking target (regenerate cleared the turn) resets instantly.
 */

import { useEffect, useRef, useState } from "react";

// Reveal at least this many characters per frame so short answers still
// animate, and divide the backlog so long bursts catch up quickly.
const MIN_CHARS_PER_FRAME = 2;
const CATCHUP_DIVISOR = 14;

export default function useSmoothText(target, enabled) {
  const [shown, setShown] = useState(target);
  const shownRef = useRef(target);
  const rafRef = useRef(null);

  useEffect(() => {
    if (!enabled) {
      shownRef.current = target;
      setShown(target);
      return undefined;
    }
    // Regenerate / reset: target no longer extends what we've shown.
    if (!target.startsWith(shownRef.current)) {
      shownRef.current = target;
      setShown(target);
      return undefined;
    }

    const step = () => {
      const cur = shownRef.current;
      if (cur.length >= target.length) {
        rafRef.current = null;
        return;
      }
      const behind = target.length - cur.length;
      const chunk = Math.max(
        MIN_CHARS_PER_FRAME,
        Math.ceil(behind / CATCHUP_DIVISOR),
      );
      const next = target.slice(0, cur.length + chunk);
      shownRef.current = next;
      setShown(next);
      rafRef.current = requestAnimationFrame(step);
    };

    if (rafRef.current == null && shownRef.current.length < target.length) {
      rafRef.current = requestAnimationFrame(step);
    }
    return () => {
      if (rafRef.current != null) {
        cancelAnimationFrame(rafRef.current);
        rafRef.current = null;
      }
    };
  }, [target, enabled]);

  return enabled ? shown : target;
}
