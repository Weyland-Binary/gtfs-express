/**
 * latestRequest — only the newest of overlapping requests may apply its answer.
 *
 * Why: the reader's timetable fetch (GTFSApp.fetchStopsAndTimes) had no
 * guard against answers arriving out of order: a slow answer for line A,
 * landing after line B's, overwrote B's grid and shapes with A's, while its
 * siblings (directions, details, stops) already carried an abort or a
 * token (review of 2026-10-09). A caller takes a ticket before its request
 * and asks, after each await, whether its ticket is still the latest; a
 * stale one applies nothing, not even the spinner's end, which the newer
 * request owns.
 *
 *   const requests = latestRequest();
 *   const current = requests.take();   // → () => boolean
 *   const data = await fetch(...);
 *   if (!current()) return;
 */

export const latestRequest = () => {
  let latest = 0;
  return {
    /** A ticket for the request about to start: the function says whether it is still the newest. */
    take() {
      const mine = ++latest;
      return () => mine === latest;
    },
    /** How many requests took a ticket (tests). */
    get count() {
      return latest;
    },
  };
};
