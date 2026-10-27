/** GET /config/features: what this server offers and what the caller may do, read by the web at start. */

"use strict";

const config = require("../config");
const accessService = require("./accessService");
const { CODE: HOSTED_EDITION_ONLY } = require("./hostedEdition");

// The reading companion's quota; the community edition has no assistant, so none.
const readerFeatureOf = (req) => {
  try {
    return require("./nl2sqlChatController").readerFeatureOf(req);
  } catch (err) {
    if (err && err.code === HOSTED_EDITION_ONLY) return null;
    throw err;
  }
};

const getFeatures = (req, res) => {
  // The payload names the caller once accounts are on: never share-cacheable.
  if (config.ACCOUNTS_ENABLED) res.setHeader("Cache-Control", "no-store");
  // The web never works out access on its own: it reads these gates; the flat fields beside them repeat its facts.
  const access = accessService.accessOf(req);
  res.json({
    access,
    validator: access.validator,
    provider: access.provider,
    projects_retention_days: access.projects_retention_days,
    request_access_url: access.request_access_url,
    legal: require("./legalService").legalFacts(),
    accounts: {
      enabled: Boolean(config.ACCOUNTS_ENABLED),
      signedIn: Boolean(req.user),
      entitlements: req.user && Array.isArray(req.user.entitlements) ? req.user.entitlements : [],
    },
    nl2sql: {
      enabled: Boolean(config.NL2SQL_ENABLED),
      model: config.NL2SQL_MODEL,
    },
    chat: {
      enabled:
        Boolean(config.NL2SQL_CHAT_ENABLED) && Boolean(config.LLM_CONFIGURED),
      model: config.NL2SQL_CHAT_MODEL || config.NL2SQL_MODEL,
      freeMessages: config.NL2SQL_FREE_MESSAGES_PER_SESSION,
      reader: Boolean(config.NL2SQL_CHAT_ENABLED) && Boolean(config.LLM_CONFIGURED) ? readerFeatureOf(req) : null,
    },
    workspace: {
      enabled: require("./workspace/workspaceStore").enabled(),
      retention_days: config.PROJECTS_RETENTION_DAYS,
      account_retention_days: config.ACCOUNT_PROJECTS_RETENTION_DAYS,
      max_projects: config.WORKSPACE_MAX_PROJECTS,
      max_versions: config.WORKSPACE_MAX_VERSIONS,
      max_version_bytes: config.WORKSPACE_MAX_VERSION_BYTES,
      snapshot: { edits: config.SNAPSHOT_EDITS, idle_minutes: config.SNAPSHOT_IDLE_MINUTES },
    },
  });
};

module.exports = { getFeatures };
