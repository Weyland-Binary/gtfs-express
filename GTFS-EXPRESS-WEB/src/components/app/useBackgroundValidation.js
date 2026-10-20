/**
 * useBackgroundValidation — the canonical validator run in the background: once a report exists and something was
 * edited, ~25 s after the last change (one run at a time, a failure retried a minute later); at once, once per
 * network, when a network opens without a report; and what an act's own run said of the network as it now is
 * (utils/vouchedValidation). `reportAt` is derived with the report so the status bar says its time once, right.
 */
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import useElapsed from "../common/useElapsed";
import { fetchWithSession } from "../../utils/sessionManager";
import { useVouchedValidation } from "../../utils/vouchedValidation";

export default function useBackgroundValidation({ baseUrl, adoptReport, agencies, validationReport, validationStale, sessionLost, features, featuresLoaded, feedEpoch, dataVersion }) {
  // ── Background re-validation ───────────────────────────────────────────
  // Once a report exists and something was edited, re-run the canonical
  // validator ~25 s after the last change: findings disappear from the
  // validation page / header badge without pressing "Re-validate", and the
  // export preflight starts from a fresh report. Runs in read mode too
  // (leaving edit mode right after an edit must not freeze an old report).
  // One run at a time; a 429 / 5xx keeps the report flagged stale and
  // retries a minute later.
  const [backgroundValidating, setBackgroundValidating] = useState(false);
  const validatingSeconds = useElapsed(backgroundValidating);
  // When the report on screen arrived: the status bar's "(14:20)".
  // Derived with the report, not set by an effect after it: the render that
  // shows a new report already carries its time, so the status bar says (and
  // announces) its sentence once, with the right time.
  const reportAt = useMemo(() => (validationReport ? new Date() : null), [validationReport]);
  const [revalidateRetryTick, setRevalidateRetryTick] = useState(0);
  const autoRevalidateInFlightRef = useRef(false);
  const runBackgroundValidation = useCallback(async () => {
    if (autoRevalidateInFlightRef.current) return;
    autoRevalidateInFlightRef.current = true;
    setBackgroundValidating(true);
    const startedAt = Date.now();
    let ok = false;
    try {
      const res = await fetchWithSession(`${baseUrl}/edit/validate`, {
        method: "POST",
      });
      if (res.ok) {
        const fresh = await res.json();
        if (fresh && typeof fresh === "object") {
          adoptReport(fresh, startedAt);
          ok = true;
        }
      }
    } catch (err) {
      console.warn("Background re-validation failed:", err);
    } finally {
      autoRevalidateInFlightRef.current = false;
      setBackgroundValidating(false);
      if (!ok) setTimeout(() => setRevalidateRetryTick((n) => n + 1), 60_000);
    }
  }, [baseUrl, adoptReport]);
  // A network open without a report (a project opened again, a version restored, a page reloaded): the validator runs
  // at once in the background, once per network — the overview says « validation en cours », then its verdict,
  // never « pas encore passé au validateur » beside a Diagnostic that read the same feed. Only a server
  // without the validator leaves the network unvalidated, and says so.
  const autoValidatedEpochRef = useRef(null);
  useEffect(() => {
    if (!agencies.length || validationReport || sessionLost || !featuresLoaded) return;
    if (features?.access?.validator === "unavailable" || autoValidatedEpochRef.current === feedEpoch) return;
    autoValidatedEpochRef.current = feedEpoch;
    runBackgroundValidation();
  }, [agencies.length, validationReport, sessionLost, featuresLoaded, features, feedEpoch, runBackgroundValidation]);
  useEffect(() => {
    if (!validationStale) return undefined;
    const timer = setTimeout(runBackgroundValidation, 25_000);
    return () => clearTimeout(timer);
    // dataVersion in deps: every further edit restarts the debounce window;
    // revalidateRetryTick re-arms after a failed run.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [validationStale, dataVersion, revalidateRetryTick]);
  // What an act's own run of the canonical validator said of the network as it now is (a change plan applied: the
  // commit validates the very feed it leaves): the status bar says it at once — never « à refaire » over it — and the
  // report the validation page lists, when there is one, is read again right behind it (utils/vouchedValidation).
  // Bound to the network as it is: its data version, and which network is open (another one drops it).
  const { vouched: vouchedValidation } = useVouchedValidation(`${feedEpoch}:${dataVersion}`, { onAnnounced: validationReport ? runBackgroundValidation : null });
  return { backgroundValidating, validatingSeconds, reportAt, runBackgroundValidation, vouchedValidation };
}
