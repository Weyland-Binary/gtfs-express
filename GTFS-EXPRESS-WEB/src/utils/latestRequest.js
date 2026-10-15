/**
 * latestRequest — only the newest of overlapping requests may apply its answer.
 *
 * Why: answers can arrive out of order. In the reader's timetable fetch
 * (GTFSApp.fetchStopsAndTimes), a slow answer for line A landing after line
 * B's would overwrite B's grid and shapes with A's (its siblings —
 * directions, details, stops — carry an abort or a token of their own).
 * A caller takes a ticket before its request
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
