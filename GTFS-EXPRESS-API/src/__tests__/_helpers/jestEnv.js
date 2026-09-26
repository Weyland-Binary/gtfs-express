/**
 * jestEnv.js — runs before every test file (package.json jest.setupFiles).
 *
 * Loading the session manager deletes session folders older than the TTL in
 * GTFS_UPLOAD_DIR, and a test that forgets to point it elsewhere would
 * clean the developer's real uploads folder. Every test process gets its own
 * temporary upload root unless the test sets one itself.
 */

"use strict";

const fs = require("fs");
const os = require("os");
const path = require("path");

if (!process.env.GTFS_UPLOAD_DIR) process.env.GTFS_UPLOAD_DIR = fs.mkdtempSync(path.join(os.tmpdir(), "gtfs-express-jest-"));
