/**
 * The community edition of GTFS Express carries the reading and the validation of a network; what the licence pays for
 * (changing a network by hand or from a brief, the assistant, the Expert tools, projects and versions, the printed
 * documents) belongs to the hosted edition, https://gtfsexpress.com. In the community edition's source each of their
 * modules is replaced by `absent(name)`: a route handler answers 404 HOSTED_EDITION_ONLY, anything else called throws it.
 */

"use strict";

const { refusal } = require("./refusal");

const CODE = "HOSTED_EDITION_ONLY";
const MESSAGE = "This feature belongs to the hosted edition of GTFS Express (https://gtfsexpress.com).";

const refused = () => refusal(404, CODE, MESSAGE);

/** What stands for the module `name`: every export a function, refusing when called. */
const absent = (name) => {
  const fn = (...args) => {
    const [, res, next] = args;
    // An Express handler hands the refusal to the error middleware; any other call throws it.
    if (res && typeof res.status === "function" && typeof next === "function") return next(refused());
    throw refused();
  };
  return new Proxy(fn, {
    // A function's own properties stay a function's (a router reads a handler's length); never a thenable, so that
    // an `await` on the module itself does not hang.
    get: (target, prop) => (prop === "then" ? undefined : typeof prop === "symbol" || prop in target ? Reflect.get(target, prop) : absent(`${name}.${prop}`)),
  });
};

module.exports = { absent, CODE, MESSAGE };
