/**
 * The canonical validator run in the background. `reportAt` is derived with the report, not set by an effect after
 * it, so the status bar says (and announces) its sentence once, with the right time.
 */
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import useElapsed from "../common/useElapsed";
import { fetchWithSession } from "../../utils/sessionManager";
import { useVouchedValidation } from "../../utils/vouchedValidation";

export default function useBackgroundValidation({ baseUrl, adoptReport, agencies, validationReport, validationStale, sessionLost, features, featuresLoaded, feedEpoch, dataVersion }) {
  // Once a report exists and something was edited, re-run ~25 s after the last change, in read mode too (leaving edit
  // mode right after an edit must not freeze an old report). One run at a time; a 429 / 5xx keeps the report stale and
  // retries a minute later.
  const [backgroundValidating, setBackgroundValidating] = useState(false);
  const validatingSeconds = useElapsed(backgroundValidating);
  const reportAt = useMemo(() => (validationReport ? new Date() : null), [validationReport]);
  const [revalidateRetryTick, setRevalidateRetryTick] = useState(0);
  // The network open now: a run captures it, and an answer (or a retry) of another network is dropped.
  const feedEpochRef = useRef(feedEpoch);
  feedEpochRef.current = feedEpoch;
  // The epoch whose run is in flight: a new network gets its own run, never a no-op behind the old one's.
  const inFlightEpochRef = useRef(null);
  const runBackgroundValidation = useCallback(async () => {
    const epoch = feedEpochRef.current;
    if (inFlightEpochRef.current === epoch) return;
    inFlightEpochRef.current = epoch;
    setBackgroundValidating(true);
    const startedAt = Date.now();
    let ok = false;
    try {
      const res = await fetchWithSession(`${baseUrl}/edit/validate`, {
        method: "POST",
      });
      if (feedEpochRef.current !== epoch) return;
      if (res.ok) {
        const fresh = await res.json();
        if (feedEpochRef.current !== epoch) return;
        if (fresh && typeof fresh === "object") {
          adoptReport(fresh, startedAt);
          ok = true;
        }
      }
    } catch (err) {
      console.warn("Background re-validation failed:", err);
    } finally {
      // Another network's run owns the flag by now: nothing of this one shows.
      if (inFlightEpochRef.current === epoch) {
        inFlightEpochRef.current = null;
        setBackgroundValidating(false);
        if (!ok && feedEpochRef.current === epoch) setTimeout(() => setRevalidateRetryTick((n) => n + 1), 60_000);
      }
    }
  }, [baseUrl, adoptReport]);
  // A network open without a report runs the validator at once, once per network, so the overview never says « pas
  // encore passé au validateur » beside a diagnostic of the same feed.
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
    // dataVersion restarts the debounce window; revalidateRetryTick re-arms after a failed run.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [validationStale, dataVersion, revalidateRetryTick]);
  // An act's own validator run on the network as it now is (the commit validates the very feed it leaves): the status
  // bar says it at once, never « à refaire » over it. Bound to the data version and the network open.
  const { vouched: vouchedValidation } = useVouchedValidation(`${feedEpoch}:${dataVersion}`, { onAnnounced: validationReport ? runBackgroundValidation : null });
  return { backgroundValidating, validatingSeconds, reportAt, runBackgroundValidation, vouchedValidation };
}
