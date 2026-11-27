/**
 * Where the report's check stands after an edit: « pending » until the validator starts, « running » with its seconds
 * (and the last check's length as an estimate), « done » a moment once a fresh report is in, with the errors the
 * report held when the edits began (`before`) beside those it holds now (`errors`), else nothing.
 */

import { useEffect, useRef, useState } from "react";
import useElapsed from "../common/useElapsed";

// Kept across the report's mounts: the next check is estimated by the last one's length.
let lastCheckMs = null;
const DONE_MS = 6000;

export default function useReportCheck({ stale, staleReason = null, checking, errors = 0 }) {
  const seconds = useElapsed(checking);
  // The errors shown when the first edit left the report behind: what the checks that follow are measured against.
  const busy = Boolean(stale || checking);
  const busyRef = useRef(false);
  const [before, setBefore] = useState(null);
  useEffect(() => {
    if (busy && !busyRef.current) setBefore(errors);
    busyRef.current = busy;
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [busy]);
  const startedRef = useRef(null);
  const [done, setDone] = useState(false);
  const [estimate, setEstimate] = useState(() => (lastCheckMs ? Math.max(1, Math.round(lastCheckMs / 1000)) : null));
  useEffect(() => {
    if (checking) {
      startedRef.current = Date.now();
      setDone(false);
      return undefined;
    }
    if (startedRef.current == null) return undefined;
    lastCheckMs = Date.now() - startedRef.current;
    startedRef.current = null;
    setEstimate(Math.max(1, Math.round(lastCheckMs / 1000)));
    setDone(true);
    const timer = setTimeout(() => setDone(false), DONE_MS);
    return () => clearTimeout(timer);
  }, [checking]);
  // A run that ends on a report still behind the edits leaves it pending: another run follows.
  const state = checking ? "running" : stale ? "pending" : done ? "done" : null;
  // Why it waits: an edit made here, or a report of another copy than the one on screen (a work resumed).
  return { state, seconds, estimate, before, errors, reason: state === "pending" ? staleReason || "edit" : null };
}
