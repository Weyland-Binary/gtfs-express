/**
 * The publisher's route order: route_sort_order (empty last), then route_short_name with
 * numeric-aware collation ("1, 2, 10"), then route_id as a deterministic tie-breaker.
 */

const collator = new Intl.Collator(undefined, {
  numeric: true,
  sensitivity: "base",
});

const hasOrder = (v) => v !== undefined && v !== null && v !== "";

export const compareRoutesByPublisherOrder = (a, b) => {
  const aHas = hasOrder(a.route_sort_order);
  const bHas = hasOrder(b.route_sort_order);
  if (aHas && bHas) {
    const diff = Number(a.route_sort_order) - Number(b.route_sort_order);
    if (diff !== 0) return diff;
  } else if (aHas) {
    return -1;
  } else if (bHas) {
    return 1;
  }
  const sn = collator.compare(
    String(a.route_short_name || ""),
    String(b.route_short_name || ""),
  );
  if (sn !== 0) return sn;
  return collator.compare(String(a.route_id || ""), String(b.route_id || ""));
};

export const sortRoutesByPublisherOrder = (routes) =>
  [...routes].sort(compareRoutesByPublisherOrder);
