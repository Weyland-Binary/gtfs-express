// An act asked on a screen of the reader that first took the person to the network's draft (edit mode always
// happens there), carried out by the same screen once it stands there in edit mode. Kept in memory only, and briefly:
// a reload never replays it, and another screen never takes it.
let pending = null;
const TTL_MS = 30_000;

export const askActAfterMove = (screen, act) => {
  pending = { screen, act, at: Date.now() };
};

export const takeActAfterMove = (screen) => {
  if (!pending) return null;
  if (Date.now() - pending.at >= TTL_MS) {
    pending = null;
    return null;
  }
  if (pending.screen !== screen) return null;
  const { act } = pending;
  pending = null;
  return act;
};
