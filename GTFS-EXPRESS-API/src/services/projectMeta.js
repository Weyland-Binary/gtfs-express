/**
 * A working copy's `_project_meta` table: the app's mark (PROJECT_MAGIC, never changed), schema version, id, source.
 * The edit core keeps its own keys there too (edit_mode_active).
 */

"use strict";

const crypto = require("crypto");
const { SCHEMA_VERSION, PROJECT_MAGIC } = require("./db/schema");

// Idempotent: values already present are kept, except schema_version, always brought up to date.
const ensureProjectMeta = (db, { sourceFeedName = null } = {}) => {
  db.exec("CREATE TABLE IF NOT EXISTS _project_meta (key TEXT PRIMARY KEY, value TEXT)");
  const get = db.prepare("SELECT value FROM _project_meta WHERE key = ?");
  const upsert = db.prepare("INSERT INTO _project_meta (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value");
  if (!get.get("app_magic")) upsert.run("app_magic", PROJECT_MAGIC);
  if (!get.get("created_at")) upsert.run("created_at", new Date().toISOString());
  if (!get.get("project_id")) upsert.run("project_id", crypto.randomUUID());
  if (sourceFeedName && !get.get("source_feed_name")) upsert.run("source_feed_name", sourceFeedName);
  upsert.run("schema_version", String(SCHEMA_VERSION));
};

module.exports = { ensureProjectMeta };
