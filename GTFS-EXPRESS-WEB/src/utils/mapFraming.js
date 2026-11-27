/**
 * How a map goes to a line of [lat, lon] a person asked to see. The view is the person's: a framing never stands
 * further back than the line needs, and nothing moves when they already work on a part of it.
 */

import L from "leaflet";

// The closest a framing comes by itself; a person standing closer is not taken back to it.
const NEAR_ZOOM = 16;

const boxOf = (bounds) => ({ south: bounds.getSouth(), west: bounds.getWest(), north: bounds.getNorth(), east: bounds.getEast() });

// Liang-Barsky: the part of the segment inside the box, if any.
function crosses(a, b, box) {
  const dLat = b[0] - a[0];
  const dLon = b[1] - a[1];
  let from = 0;
  let to = 1;
  for (const [p, q] of [
    [-dLon, a[1] - box.west],
    [dLon, box.east - a[1]],
    [-dLat, a[0] - box.south],
    [dLat, box.north - a[0]],
  ]) {
    if (p === 0) {
      if (q < 0) return false;
      continue;
    }
    const r = q / p;
    if (p < 0) from = Math.max(from, r);
    else to = Math.min(to, r);
    if (from > to) return false;
  }
  return true;
}

/** Whether a line runs through a box { south, west, north, east }: a point in it, or a segment across it. */
export function runsThrough(latlngs, box) {
  if (latlngs.length === 1) return crosses(latlngs[0], latlngs[0], box);
  for (let i = 1; i < latlngs.length; i++) if (crosses(latlngs[i - 1], latlngs[i], box)) return true;
  return false;
}

/**
 * Whether the person already works on the line: it runs through their view, which shows a part of it from closer
 * than its whole. Showing the whole would then take away the place they stand at.
 */
export function atHand(map, latlngs, padding = 0) {
  const whole = L.latLngBounds(latlngs);
  if (!whole.isValid()) return false;
  const view = map.getBounds();
  if (view.contains(whole)) return false;
  if (map.getZoom() <= map.getBoundsZoom(whole, false, L.point(padding * 2, padding * 2))) return false;
  return runsThrough(latlngs, boxOf(view));
}

/**
 * Shows the line whole, from as close as it fits: at the person's own zoom when it fits there. `fly` is a flight's
 * seconds; `animate: false` moves at once, the view read right after being the one arrived at.
 */
export function frame(map, latlngs, { padding = 0, fly = 0, animate } = {}) {
  const whole = L.latLngBounds(latlngs);
  if (!whole.isValid()) return;
  const options = { padding: [padding, padding], maxZoom: Math.max(map.getZoom(), NEAR_ZOOM) };
  if (fly) map.flyToBounds(whole, { ...options, duration: fly });
  else map.fitBounds(whole, animate === false ? { ...options, animate: false } : options);
}

/** Brings the line under the person's eyes; false when it was at hand and nothing moved. */
export function bring(map, latlngs, options) {
  if (atHand(map, latlngs, options?.padding)) return false;
  frame(map, latlngs, options);
  return true;
}
