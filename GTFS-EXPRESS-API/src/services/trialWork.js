/**
 * Whether a request's licence is the free trial. The trial opens everything a licence does, exports included;
 * only the stop sheets tell it apart (their « trial » watermark).
 */

"use strict";

const isTrial = (req) => Boolean(req && req.user && req.user.licence && req.user.licence.active && req.user.licence.source === "trial");

const holdsDelivery = (req) => Boolean(req && req.user && req.user.licence && req.user.licence.active && req.user.licence.source !== "trial");

module.exports = { isTrial, holdsDelivery };
