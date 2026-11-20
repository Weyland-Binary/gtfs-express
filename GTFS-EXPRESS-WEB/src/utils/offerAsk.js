// The line a panel elsewhere in the reader asks the offer to open on, taken once by the offer.
let pendingLine = null;
const listeners = new Set();

export const askOfferFor = (routeId) => {
  pendingLine = routeId;
  listeners.forEach((fn) => fn(routeId));
};

export const takeAskedLine = () => {
  const id = pendingLine;
  pendingLine = null;
  return id;
};

export const onOfferAsked = (fn) => {
  listeners.add(fn);
  return () => listeners.delete(fn);
};
