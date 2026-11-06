export const MONO_FONT = "ui-monospace, Menlo, Consolas, monospace";

export const HISTORY_KEY = "gtfs.sql.history";
export const USER_PRESETS_KEY = "gtfs.sql.userPresets";
export const HISTORY_MAX = 20;

// Editor height in px.
export const EDITOR_HEIGHT_KEY = "gtfs.sql.editorHeight";
export const EDITOR_HEIGHT_MIN = 100;
export const EDITOR_HEIGHT_MAX = 400;
export const EDITOR_HEIGHT_DEFAULT = 180;

// Collapsed by default: the browse strip covers the common cases, the sidebar is for exploring columns and keys.
export const SCHEMA_VISIBLE_KEY = "gtfs.sql.schemaVisible";
export const CURRENT_QUERY_KEY = "gtfs.sql.currentQuery";
export const SCHEMA_WIDTH_KEY = "gtfs.sql.schemaWidth";
export const SCHEMA_WIDTH_MIN = 200;
export const SCHEMA_WIDTH_MAX = 400;
export const SCHEMA_WIDTH_DEFAULT = 260;

export const SCHEMA_CACHE_KEY = "gtfs.sql.schemaCache";

// Clickable when non-null; a heuristic only, the schema browser holds the real foreign keys.
export const FK_COLUMN_RE = /_(?:id)$/i;

// Pushes a query into the console from elsewhere in the app.

// A question parked in sessionStorage by another screen (« Ask AI to fix »), read and cleared by NL2SQLPanel.
export const NL2SQL_PREFILL_KEY = "gtfs.sql.nl2sqlPrefill";

// Fallback when the backend's answer carries no editable metadata.
export const SINGLE_TABLE_SELECT_RE =
  /^\s*select\s+(?!.*\bjoin\b)(?!.*\bgroup\s+by\b)(?!.*\bunion\b).*?\bfrom\s+([A-Za-z_][A-Za-z0-9_]*)\s*(?:where\b[\s\S]*?)?(?:order\s+by\b[\s\S]*?)?(?:limit\s+\d+\s*)?;?\s*$/i;

export const URL_RE = /^https?:\/\//i;
export const TIME_RE = /^\d{1,2}:\d{2}:\d{2}$/;
