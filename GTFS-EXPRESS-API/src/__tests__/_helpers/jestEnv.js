/**
 * jestEnv — the environment every suite runs under (package.json jest.setupFiles).
 *
 * Runs before any module is required: the config reads these once, at load. Each worker gets its own scratch
 * directories (uploads, projects, the usage logs) under the OS temp directory, so a suite never writes into the checkout and
 * two runs never share a session file. NODE_ENV=test under Jest is what lets the canonical validator's deterministic
 * stub answer (canonicalValidatorService.stubAllowed); a suite that needs the real JAR sets
 * GTFS_CANONICAL_VALIDATOR_JAR itself.
 */

"use strict";

const fs = require("fs");
const os = require("os");
const path = require("path");

process.env.NODE_ENV = "test";

const root = fs.mkdtempSync(path.join(os.tmpdir(), `gtfs-express-test-${process.env.JEST_WORKER_ID || "0"}-`));
const dir = (name) => {
  const p = path.join(root, name);
  fs.mkdirSync(p, { recursive: true });
  return p;
};

process.env.GTFS_UPLOAD_DIR = process.env.GTFS_UPLOAD_DIR || dir("uploads");
process.env.PROJECTS_DIR = process.env.PROJECTS_DIR || dir("projects");
const logs = dir("logs");
process.env.BETA_USAGE_PATH = process.env.BETA_USAGE_PATH || path.join(logs, "usage.jsonl");
process.env.NL2SQL_CHAT_USAGE_PATH = process.env.NL2SQL_CHAT_USAGE_PATH || path.join(logs, "chat-usage.jsonl");

// Test-only secrets (never the defaults production refuses, never real keys).
process.env.IP_HASH_SECRET = process.env.IP_HASH_SECRET || "test-ip-hash-secret-0123456789abcdef0123456789abcdef";
process.env.ADMIN_TOKEN = process.env.ADMIN_TOKEN || "test-admin-token-distinct-from-the-ip-hash-secret";
process.env.CLIENT_TOKEN_SECRET = process.env.CLIENT_TOKEN_SECRET || "test-client-token-secret-0123456789abcdef";
process.env.MAIL_PROVIDER = process.env.MAIL_PROVIDER || "memory";
// No suite calls a model: a key left in the developer's shell must not be spent by a test.
delete process.env.ANTHROPIC_API_KEY;
