/**
 * useElapsed — whole seconds since `active` turned true (0 while inactive):
 * a long wait (a territory read, a feed download) shows how long it has
 * been running instead of a bare spinner.
 */

import { useEffect, useState } from "react";

export default function useElapsed(active) {
  const [seconds, setSeconds] = useState(0);
  useEffect(() => {
    if (!active) return undefined;
    const started = Date.now();
    const id = setInterval(() => setSeconds(Math.floor((Date.now() - started) / 1000)), 1000);
    return () => {
      clearInterval(id);
      setSeconds(0);
    };
  }, [active]);
  return active ? seconds : 0;
}
