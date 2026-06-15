/* ------------------------------------------------------------------ */
/* Storage keys, UI invariants, and shared regex used across the SQL  */
/* console and its helpers. Pure data, no React.                       */
/* ------------------------------------------------------------------ */

export const MONO_FONT = "ui-monospace, Menlo, Consolas, monospace";

export const HISTORY_KEY = "gtfs.sql.history";
export const USER_PRESETS_KEY = "gtfs.sql.userPresets";
export const HISTORY_MAX = 20;

// Persisted vertical splitter (editor height in px). Tuned for laptop 13".
export const EDITOR_HEIGHT_KEY = "gtfs.sql.editorHeight";
export const EDITOR_HEIGHT_MIN = 100;
export const EDITOR_HEIGHT_MAX = 400;
export const EDITOR_HEIGHT_DEFAULT = 180;

// Persisted Schema sidebar (DBeaver-like left rail). Default collapsed: the
// Browse-files chip strip already covers ~90% of common workflows; the
// sidebar is for advanced exploration (column hunting, FK chasing).
export const SCHEMA_VISIBLE_KEY = "gtfs.sql.schemaVisible";
export const CURRENT_QUERY_KEY = "gtfs.sql.currentQuery";
export const SCHEMA_WIDTH_KEY = "gtfs.sql.schemaWidth";
export const SCHEMA_WIDTH_MIN = 200;
export const SCHEMA_WIDTH_MAX = 400;
export const SCHEMA_WIDTH_DEFAULT = 260;

export const SCHEMA_CACHE_KEY = "gtfs.sql.schemaCache";

// Heuristic FK detection — column names matching this pattern are clickable
// when their value is non-null. We never trust the regex alone; the schema
// browser is the ground truth for actual FK relationships.
export const FK_COLUMN_RE = /_(?:id)$/i;

// Custom event used by external callers to push a query into the console.
export const SET_QUERY_EVENT = "gtfs:sql-set-query";

// sessionStorage hand-off used by external surfaces (e.g. the validation
// page's "Ask AI to fix" action) to open the NL2SQL panel pre-filled with
// a question. Written by the caller, consumed-and-cleared by NL2SQLPanel.
export const NL2SQL_PREFILL_KEY = "gtfs.sql.nl2sqlPrefill";

// Single-table SELECT detection — fallback when the backend does not expose
// editable metadata (forward-compat with the older /edit/sql contract).
export const SINGLE_TABLE_SELECT_RE =
  /^\s*select\s+(?!.*\bjoin\b)(?!.*\bgroup\s+by\b)(?!.*\bunion\b).*?\bfrom\s+([A-Za-z_][A-Za-z0-9_]*)\s*(?:where\b[\s\S]*?)?(?:order\s+by\b[\s\S]*?)?(?:limit\s+\d+\s*)?;?\s*$/i;

export const URL_RE = /^https?:\/\//i;
export const TIME_RE = /^\d{1,2}:\d{2}:\d{2}$/;
