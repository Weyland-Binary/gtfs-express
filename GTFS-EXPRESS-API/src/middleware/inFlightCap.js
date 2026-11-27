"use strict";

const { ipKeyGenerator } = require("express-rate-limit");

/**
 * At most `total` requests at once through what it guards, `perAddress` of them from one address; beyond, 503
 * SERVER_BUSY before a byte of the body is read. Guards the parsers of large bodies, which hold each one in memory or on
 * disk, and the archives the door reads: the rate limiters count requests an hour, not the bodies open or the archives
 * read at one moment.
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
      return res.status(503).json({ error: "SERVER_BUSY", message: "Too many requests are being received at once. Try again in a few seconds.", retryAfterSec });
    }
    open += 1;
    byAddress.set(key, mine + 1);
    let released = false;
    const release = () => {
      if (released) return;
      released = true;
      open -= 1;
      const left = (byAddress.get(key) || 1) - 1;
      if (left > 0) byAddress.set(key, left);
      else byAddress.delete(key);
    };
    // A handler whose work goes on once its sender hangs up holds the place until that work ends, through what this
    // gives back; else the place is freed when the response closes. A sender that hung up before its handler held the
    // place had it freed by the close: the handler takes one again only where the caps still have room, else it gets
    // null and does no work.
    let held = false;
    req.holdInFlight = () => {
      held = true;
      if (released) {
        const left = byAddress.get(key) || 0;
        if (open >= total || left >= perAddress) return null;
        released = false;
        open += 1;
        byAddress.set(key, left + 1);
      }
      return release;
    };
    res.once("close", () => {
      if (!held) release();
    });
    next();
  };
};

module.exports = { inFlightCap };
