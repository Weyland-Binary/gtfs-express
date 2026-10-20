/**
 * projectMeta.js — the `_project_meta` table of a working copy (uploads/<session>/gtfs.db): the application's mark
 * (`app_magic`, PROJECT_MAGIC, never changed), the schema version, when the copy was created, its id and the name of
 * the feed it came from. The edit core keeps its own keys there too (edit_mode_active).
 */

"use strict";

const crypto = require("crypto");
const { SCHEMA_VERSION, PROJECT_MAGIC } = require("./db/schema");

/**
 * Ensures that `_project_meta` exists and holds app_magic, schema_version, created_at and project_id. Values already
 * present are kept, except schema_version, always brought up to date. Idempotent: safe on every edit-mode entry.
 */
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
