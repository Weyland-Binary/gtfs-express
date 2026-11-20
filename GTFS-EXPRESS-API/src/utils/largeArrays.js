/**
 * Lists as long as a feed's tables. `target.push(...items)` and `Math.max(...values)` pass one argument per item,
 * and past about 100 000 items the call throws "Maximum call stack size exceeded": these take any length.
 */

"use strict";

/** Appends every item of `items` (any iterable) to `target`, and returns `target`. */
const pushAll = (target, items) => {
  for (const item of items) target.push(item);
  return target;
};

/** Math.max of a list: -Infinity when empty, NaN when a value is no number. */
const maxOf = (values) => {
  let max = -Infinity;
  for (const value of values) max = Math.max(max, value);
  return max;
};

/** Math.min of a list: Infinity when empty, NaN when a value is no number. */
const minOf = (values) => {
  let min = Infinity;
  for (const value of values) min = Math.min(min, value);
  return min;
};

module.exports = { pushAll, maxOf, minOf };
