/**
 * Only the newest of overlapping requests may apply its answer: answers can arrive out of order.
 * A caller takes a ticket before its request and checks it after each await; a stale one applies
 * nothing, not even the spinner's end, which the newer request owns.
 */

export const latestRequest = () => {
  let latest = 0;
  return {
    take() {
      const mine = ++latest;
      return () => mine === latest;
    },
    get count() {
      return latest;
    },
  };
};
