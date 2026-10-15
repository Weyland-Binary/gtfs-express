/**
 * vouchedValidation — what the canonical validator said of the network as it
 * now is, when an act ran it on that very network, told to the status bar.
 *
 * The status bar's validation case reads the session's last full report and
 * calls it « à refaire » as soon as an edit came after it. A change plan
 * applied is an edit, but its commit runs the canonical validator on the
 * very feed it leaves (POST /transform/commit: nothing is applied with a new
 * error): the bar must not say « Validation GTFS : à refaire » beside a
 * version just applied with 0 error and 7 warnings. The act says
 * what its own run answered; the bar says it (common/StatusBar
 * validationCaseOf) until the network changes again or a report read after
 * it says the same network in full — that report is read right behind it
 * (`onAnnounced`: the validation page lists its findings).
 *
 *   announceValidated({ errors, warnings })   the act's own run (a window event, VALIDATED_EVENT), said
 *                                             right after the act's edit is recorded
 *   useVouchedValidation(networkState, { onAnnounced })
 *     → { vouched: { errors, warnings, at } | null }
 *       the last answer announced, bound to the state of the network in the render that brought it
 *       (`networkState`: the data version, and which network is open — the act's edit is in it) and
 *       dropped by the next change of it (an edit, an undo, another network); `onAnnounced()` runs once
 *       it is bound — the edit recorded, so a report read from then on covers it
 */

import { useEffect, useRef, useState } from "react";

export const VALIDATED_EVENT = "gtfs:validated";

const countOf = (v) => (typeof v === "number" && Number.isFinite(v) && v >= 0 ? v : null);

/** The act's own run of the canonical validator on the network as it now is (its counts), for the status bar. */
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
  // Bound to the state of the network it arrived with (the act's edit and its announcement land in the same render);
  // any later change of it drops it.
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
