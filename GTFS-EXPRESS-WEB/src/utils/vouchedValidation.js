/**
 * A commit runs the canonical validator on the feed it leaves, so the status bar must not call validation
 * « à refaire » after that edit: the act announces its own run's counts, which hold until the network changes
 * again. `onAnnounced` runs once the counts are bound to the network's state, so a report read then covers the edit.
 */

import { useEffect, useRef, useState } from "react";
import { VALIDATED_EVENT } from "./appEvents";


const countOf = (v) => (typeof v === "number" && Number.isFinite(v) && v >= 0 ? v : null);

/** Dispatch right after the act's edit is recorded. */
export const announceValidated = ({ errors, warnings } = {}) => {
  if (countOf(errors) === null || countOf(warnings) === null || typeof window === "undefined") return false;
  window.dispatchEvent(new CustomEvent(VALIDATED_EVENT, { detail: { errors, warnings } }));
  return true;
};

export function useVouchedValidation(networkState, { onAnnounced = null } = {}) {
  const [vouched, setVouched] = useState(null); // { errors, warnings, at: Date, version: networkState | null }
  const announced = useRef(onAnnounced);
  announced.current = onAnnounced;
  useEffect(() => {
    const handler = (e) => {
      const errors = countOf(e?.detail?.errors);
      const warnings = countOf(e?.detail?.warnings);
      if (errors === null || warnings === null) return;
      setVouched({ errors, warnings, at: new Date(), version: null });
    };
    window.addEventListener(VALIDATED_EVENT, handler);
    return () => window.removeEventListener(VALIDATED_EVENT, handler);
  }, []);
  // The act's edit and its announcement land in the same render: bind to that state, drop on any later change.
  useEffect(() => {
    if (!vouched) return;
    if (vouched.version === null) {
      setVouched((v) => (v && v.version === null ? { ...v, version: networkState } : v));
      announced.current?.();
    } else if (vouched.version !== networkState) setVouched(null);
  }, [vouched, networkState]);
  const current = vouched && (vouched.version === null || vouched.version === networkState) ? { errors: vouched.errors, warnings: vouched.warnings, at: vouched.at } : null;
  return { vouched: current };
}
