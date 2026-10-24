/**
 * Reveals bursty streamed text smoothly, the per-frame chunk growing with the lag so it adds little latency. Once
 * `enabled` turns false it snaps to the full text: completion is never delayed by the animation.
 */

import { useEffect, useRef, useState } from "react";

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
    // A regenerate or reset: the target no longer extends what is shown.
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
