/**
 * laea — ETRS89-extended / LAEA Europe (EPSG:3035) ↔ WGS84 latitude and
 * longitude, to read the INSEE 200 m grid (Filosofi "données carroyées"),
 * whose cells are named after their south-west corner in that projection:
 * "CRS3035RES200mN2889000E3760400".
 *
 * Lambert Azimuthal Equal Area, oblique ellipsoidal form (EPSG method 9820,
 * IOGP Guidance Note 7-2), on the GRS80 ellipsoid with the EPSG:3035
 * parameters: latitude of origin 52°N, longitude of origin 10°E, false
 * easting 4 321 000 m, false northing 3 210 000 m. ETRS89 is taken equal to
 * WGS84 (they differ by well under a metre in France, far below a cell).
 *
 * The inverse is exact: the authalic latitude is converted back with the
 * EPSG series, then refined by Newton iterations on the authalic function q
 * until it moves by less than 1e-12 rad (sub-millimetre).
 */

"use strict";

const A = 6378137; // GRS80 semi-major axis (m)
const F = 1 / 298.257222101; // GRS80 flattening
const E2 = 2 * F - F * F;
const E = Math.sqrt(E2);
const LAT0 = (52 * Math.PI) / 180;
const LON0 = (10 * Math.PI) / 180;
const FE = 4321000;
const FN = 3210000;

const DEG = 180 / Math.PI;
const RAD = Math.PI / 180;

/** The authalic function q(φ). */
const q = (phi) => {
  const s = Math.sin(phi);
  return (1 - E2) * (s / (1 - E2 * s * s) - (1 / (2 * E)) * Math.log((1 - E * s) / (1 + E * s)));
};

const QP = q(Math.PI / 2);
const BETA0 = Math.asin(q(LAT0) / QP);
const RQ = A * Math.sqrt(QP / 2);
const D = (A * Math.cos(LAT0)) / Math.sqrt(1 - E2 * Math.sin(LAT0) ** 2) / (RQ * Math.cos(BETA0));

/** WGS84 → EPSG:3035 { e, n } in metres. */
const toLaea = (lat, lon) => {
  const beta = Math.asin(Math.max(-1, Math.min(1, q(lat * RAD) / QP)));
  const dl = lon * RAD - LON0;
  const B = RQ * Math.sqrt(2 / (1 + Math.sin(BETA0) * Math.sin(beta) + Math.cos(BETA0) * Math.cos(beta) * Math.cos(dl)));
  return {
    e: FE + B * D * Math.cos(beta) * Math.sin(dl),
    n: FN + (B / D) * (Math.cos(BETA0) * Math.sin(beta) - Math.sin(BETA0) * Math.cos(beta) * Math.cos(dl)),
  };
};

/** EPSG:3035 easting / northing (m) → WGS84 { lat, lon } in degrees. */
const fromLaea = (e, n) => {
  const x = e - FE;
  const y = n - FN;
  const rho = Math.hypot(x / D, D * y);
  if (rho < 1e-9) return { lat: LAT0 * DEG, lon: LON0 * DEG };
  const C = 2 * Math.asin(Math.min(1, rho / (2 * RQ)));
  const betaP = Math.asin(Math.max(-1, Math.min(1, Math.cos(C) * Math.sin(BETA0) + (D * y * Math.sin(C) * Math.cos(BETA0)) / rho)));
  const lon = LON0 + Math.atan2(x * Math.sin(C), D * rho * Math.cos(BETA0) * Math.cos(C) - D * D * y * Math.sin(BETA0) * Math.sin(C));
  // Authalic → geodetic latitude: the EPSG series, then Newton on q(φ) = qP sin β'.
  const e4 = E2 * E2;
  const e6 = e4 * E2;
  let phi = betaP + (E2 / 3 + (31 * e4) / 180 + (517 * e6) / 5040) * Math.sin(2 * betaP) + ((23 * e4) / 360 + (251 * e6) / 3780) * Math.sin(4 * betaP) + ((761 * e6) / 45360) * Math.sin(6 * betaP);
  const target = QP * Math.sin(betaP);
  for (let i = 0; i < 8 && Math.abs(phi) < Math.PI / 2 - 1e-10; i++) {
    const s = Math.sin(phi);
    const w = 1 - E2 * s * s;
    const step = ((w * w) / (2 * Math.cos(phi))) * (target / (1 - E2) - s / w + (1 / (2 * E)) * Math.log((1 - E * s) / (1 + E * s)));
    phi += step;
    if (Math.abs(step) < 1e-12) break;
  }
  return { lat: phi * DEG, lon: lon * DEG };
};

// INSPIRE / INSEE grid cell ids: CRS3035RES<size>mN<northing>E<easting>,
// the coordinates of the cell's south-west corner.
const CELL_ID_RE = /^CRS3035RES(\d+)mN(\d+)E(\d+)$/i;

/** "CRS3035RES200mN2889000E3760400" → { size, n, e, lat, lon } of the cell's centre, or null. */
const cellCentre = (id) => {
  const m = CELL_ID_RE.exec(String(id || "").trim());
  if (!m) return null;
  const size = Number(m[1]);
  const n = Number(m[2]);
  const e = Number(m[3]);
  if (!(size > 0) || !Number.isFinite(n) || !Number.isFinite(e)) return null;
  const c = fromLaea(e + size / 2, n + size / 2);
  return { size, n, e, lat: c.lat, lon: c.lon };
};

module.exports = { toLaea, fromLaea, cellCentre, CELL_ID_RE, _internals: { q, QP, BETA0, RQ, D, E2 } };
