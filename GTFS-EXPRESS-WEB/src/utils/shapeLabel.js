// A shape_id is opaque: a shape is labelled by its trips' direction, their
// dominant headsign and, when a direction holds several shapes, "short" or
// "variant N", the raw shape_id kept as the subtitle.

function haversineM(a, b) {
  const R = 6_371_000;
  const toRad = (d) => (d * Math.PI) / 180;
  const dLat = toRad(b[0] - a[0]);
  const dLon = toRad(b[1] - a[1]);
  const lat1 = toRad(a[0]);
  const lat2 = toRad(b[0]);
  const h =
    Math.sin(dLat / 2) ** 2 +
    Math.cos(lat1) * Math.cos(lat2) * Math.sin(dLon / 2) ** 2;
  return R * 2 * Math.atan2(Math.sqrt(h), Math.sqrt(1 - h));
}

// points: [lat, lon] pairs, as shapes_for_route returns them.
export function shapeDistanceM(points = []) {
  let d = 0;
  for (let i = 1; i < points.length; i++) {
    const a = points[i - 1];
    const b = points[i];
    if (!Array.isArray(a) || !Array.isArray(b)) continue;
    if (!Number.isFinite(a[0]) || !Number.isFinite(b[0])) continue;
    d += haversineM(a, b);
  }
  return d;
}

function dominantHeadsign(trips = []) {
  const counts = new Map();
  for (const trip of trips) {
    const h = (trip?.trip_headsign || "").trim();
    if (!h) continue;
    counts.set(h, (counts.get(h) || 0) + 1);
  }
  let best = null;
  let bestN = 0;
  for (const [h, n] of counts) {
    if (n > bestN) {
      best = h;
      bestN = n;
    }
  }
  return best;
}

function directionKey(directions = []) {
  const set = new Set((directions || []).map((d) => String(d)));
  const has0 = set.has("0");
  const has1 = set.has("1");
  if (has0 && has1) return "shared";
  if (has1 && !has0) return "inbound";
  // "0", empty or anything else counts as outbound.
  return "outbound";
}

// discriminator: null for a direction's longest shape, "short", or the
// 2-based variant index.
export function computeShapeLabels(shapes = []) {
  const enriched = shapes.map((s) => {
    const direction = directionKey(s.directions);
    return {
      shape_id: s.shape_id,
      direction,
      isShared: direction === "shared",
      headsign: dominantHeadsign(s.trips),
      distanceM: shapeDistanceM(s.points),
      pointCount: s.point_count ?? (s.points ? s.points.length : 0),
      tripCount: s.trip_count ?? 0,
    };
  });

  const groups = new Map();
  for (const e of enriched) {
    if (!groups.has(e.direction)) groups.set(e.direction, []);
    groups.get(e.direction).push(e);
  }

  const out = new Map();
  for (const group of groups.values()) {
    // The longest shape of a direction is its principal one.
    const sorted = [...group].sort((a, b) => b.distanceM - a.distanceM);
    sorted.forEach((e, idx) => {
      let discriminator = null;
      if (sorted.length > 1) {
        if (idx === 0) {
          discriminator = null;
        } else if (
          sorted.length === 2 &&
          sorted[0].distanceM > 0 &&
          e.distanceM < 0.8 * sorted[0].distanceM
        ) {
          discriminator = "short";
        } else {
          discriminator = idx + 1;
        }
      }
      out.set(e.shape_id, { ...e, discriminator });
    });
  }
  return out;
}

export function formatShapeLabel(shapeId, descriptor, t) {
  if (!descriptor) return { primary: shapeId, secondary: "" };
  const arrow =
    descriptor.direction === "inbound"
      ? "←"
      : descriptor.direction === "shared"
        ? "⇄"
        : "→";
  const dirWord =
    descriptor.direction === "inbound"
      ? t("shapeStudio.label.inbound")
      : descriptor.direction === "shared"
        ? t("shapeStudio.label.shared")
        : t("shapeStudio.label.outbound");

  let primary = `${arrow} ${dirWord}`;
  if (descriptor.headsign) primary += ` — ${descriptor.headsign}`;
  if (descriptor.discriminator === "short") {
    primary += ` · ${t("shapeStudio.label.short")}`;
  } else if (typeof descriptor.discriminator === "number") {
    primary += ` · ${t("shapeStudio.label.variant", { n: descriptor.discriminator })}`;
  }
  return { primary, secondary: shapeId };
}
