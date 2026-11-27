/**
 * The door's sizes, apart from the server's configuration: what reads a feed's files needs them, and is loaded where
 * the server's packages are not (the web's tests read the quick fixes from here).
 */

"use strict";

// The largest archive a network is sent or downloaded as, and the most it may unpack to.
const UPLOAD_MAX_MB = 200;
const UPLOAD_MAX_UNPACKED_BYTES = 2 * 1024 * 1024 * 1024;

module.exports = { UPLOAD_MAX_MB, UPLOAD_MAX_UNPACKED_BYTES };
