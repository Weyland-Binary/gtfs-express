/**
 * networkStudio — the Network Studio (designing a network from a territory) is off unless NETWORK_STUDIO_ENABLED is
 * true. While it is off, its own routes answer 404 NETWORK_STUDIO_DISABLED and the workspace refuses a project of
 * the "create" job; what the modify journey shares with it stays open: the catalogue of public feeds, the brief's
 * documents, the coherence report and the network report. The studio's code is kept so the flag can turn it back on.
 */

"use strict";

const config = require("../config");
const { refusal } = require("../services/refusal");

/** Whether this server offers the Network Studio (read on every request, so a test can switch it). */
const networkStudioEnabled = () => Boolean(config.NETWORK_STUDIO_ENABLED);

const disabled = () => refusal(404, "NETWORK_STUDIO_DISABLED", "The Network Studio is not available on this server.");

/** Route guard of the studio's own routes. */
const networkStudioOnly = (req, res, next) => (networkStudioEnabled() ? next() : next(disabled()));

module.exports = { networkStudioEnabled, networkStudioOnly, networkStudioDisabled: disabled };
