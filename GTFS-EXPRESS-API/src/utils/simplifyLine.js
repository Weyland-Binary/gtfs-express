/**
 * Douglas-Peucker on [lat, lon] points, the tolerance in degrees: the points a map can drop without the line moving
 * by more than the tolerance. The overview map applies the same rule to what it draws (ShapesMap simplifyDP), so a
 * line simplified here is drawn as it was.
 */

"use strict";

const simplifyLine = (points, tolerance) => {
  const n = points.length;
  if (n < 3) return points;
  const sqTol = tolerance * tolerance;
  const keep = new Uint8Array(n);
  keep[0] = 1;
  keep[n - 1] = 1;
  const stack = [[0, n - 1]];
  while (stack.length) {
    const [first, last] = stack.pop();
    let maxSqDist = 0;
    let index = -1;
    const [ax, ay] = points[first];
    const [bx, by] = points[last];
    const dx = bx - ax;
    const dy = by - ay;
    const lenSq = dx * dx + dy * dy;
    for (let i = first + 1; i < last; i++) {
      const [px, py] = points[i];
      let sqDist;
      if (lenSq === 0) {
        const ex = px - ax;
        const ey = py - ay;
        sqDist = ex * ex + ey * ey;
      } else {
        const t = ((px - ax) * dx + (py - ay) * dy) / lenSq;
        const tc = t < 0 ? 0 : t > 1 ? 1 : t;
        const ex = ax + tc * dx - px;
        const ey = ay + tc * dy - py;
        sqDist = ex * ex + ey * ey;
      }
      if (sqDist > maxSqDist) {
        maxSqDist = sqDist;
        index = i;
      }
    }
    if (index !== -1 && maxSqDist > sqTol) {
      keep[index] = 1;
      stack.push([first, index]);
      stack.push([index, last]);
    }
  }
  const out = [];
  for (let i = 0; i < n; i++) if (keep[i]) out.push(points[i]);
  return out;
};

module.exports = { simplifyLine };
