"use strict";

const { ipKeyGenerator } = require("express-rate-limit");

/**
 * At most `total` requests at once through what it guards, `perAddress` of them from one address; beyond, 503
 * SERVER_BUSY before a byte of the body is read. Guards the multipart parsers, which hold each body in memory: the
 * rate limiters count requests an hour, not the bodies open at one moment.
 */
const inFlightCap = ({ total, perAddress, retryAfterSec = 5 }) => {
  const byAddress = new Map();
  let open = 0;
  return (req, res, next) => {
    const key = ipKeyGenerator(req.ip || "") || "unknown";
    const mine = byAddress.get(key) || 0;
    if (open >= total || mine >= perAddress) {
      res.set("Retry-After", String(retryAfterSec));
      // The body is not read: the connection cannot be reused.
      res.set("Connection", "close");
      return res.status(503).json({ error: "SERVER_BUSY", message: "Too many files are being received at once. Try again in a few seconds.", retryAfterSec });
    }
    open += 1;
    byAddress.set(key, mine + 1);
    let released = false;
    res.once("close", () => {
      if (released) return;
      released = true;
      open -= 1;
      const left = (byAddress.get(key) || 1) - 1;
      if (left > 0) byAddress.set(key, left);
      else byAddress.delete(key);
    });
    next();
  };
};

module.exports = { inFlightCap };
