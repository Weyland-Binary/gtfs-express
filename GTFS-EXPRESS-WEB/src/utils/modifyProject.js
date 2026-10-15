/**
 * modifyProject — the one way into a modification of the network open here: GTFSApp handles the event, joining the
 * draft that already works on the network (one draft per network) or opening a new one.
 */

/**
 * Ask the app to open the draft that modifies the network open here; `fresh`: a new project; `kind`: the way the
 * person chose (« hand » | « brief »), taken by a draft that holds no work in progress.
 */
export const openModifyProject = ({ fresh = false, kind = null } = {}) => {
  const detail = { ...(fresh ? { fresh: true } : {}), ...(kind ? { kind } : {}) };
  window.dispatchEvent(new CustomEvent("gtfs:open-change-studio", Object.keys(detail).length ? { detail } : undefined));
};
