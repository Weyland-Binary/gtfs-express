// Derive human-readable labels for GTFS shapes.
//
// A GTFS shape only carries an opaque `shape_id` (often a hash like
// "shp_8821"). Transit operators think in roles — "the outbound trace", "the
// short-turn variant" — not in ids. So the Shape Studio rail shows a derived
// label built from the shape's direction (`direction_id` of its trips), its
// destination (the dominant `trip_headsign`) and a discriminator when a single
// direction holds several shapes (the shortest becomes "short", the rest
// "variant N"), while keeping the raw `shape_id` as a discreet subtitle.

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

// points: array of [lat, lon] pairs (the shapes_for_route format).
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
  // Only "0", empty, or anything else → treat as the outbound direction.
  return "outbound";
}

// shapes: [{ shape_id, points, point_count, trip_count, directions, trips }]
// Returns Map<shape_id, {
//   direction: "outbound" | "inbound" | "shared",
//   headsign: string | null,
//   discriminator: null | "short" | number (variant index, 2-based),
//   distanceM, pointCount, tripCount, isShared
// }>
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

  // Group by direction to assign discriminators within each direction.
  const groups = new Map();
  for (const e of enriched) {
    if (!groups.has(e.direction)) groups.set(e.direction, []);
    groups.get(e.direction).push(e);
  }

  const out = new Map();
  for (const group of groups.values()) {
    // Longest first — the longest shape in a direction is the "principal".
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
          discriminator = idx + 1; // variant 2, 3, …
        }
      }
      out.set(e.shape_id, { ...e, discriminator });
    });
  }
  return out;
}

// Compose the i18n display string from a descriptor + the t() function.
// Returns { primary, secondary } where secondary is the raw shape_id.
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
