import React, {
  Suspense,
  lazy,
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import {
  Box,
  Button,
  Typography,
  IconButton,
  Tooltip,
  Alert,
  LinearProgress,
  Chip,
  TextField,
  Divider,
  Collapse,
  Fade,
  List,
  ListItemButton,
  ListItemIcon,
  ListItemText,
  Menu,
  MenuItem,
  Popover,
  Snackbar,
  Dialog,
  DialogTitle,
  DialogContent,
  DialogActions,
  InputAdornment,
  Select,
  FormControl,
  InputLabel,
  Paper,
  Switch,
  CircularProgress,
} from "@mui/material";
import { alpha, useTheme } from "@mui/material/styles";
import GlobalStyles from "@mui/material/GlobalStyles";
import PlayArrowIcon from "@mui/icons-material/PlayArrow";
import DownloadIcon from "@mui/icons-material/Download";
import ClearIcon from "@mui/icons-material/Clear";
import SchemaIcon from "@mui/icons-material/Schema";
import ExpandMoreIcon from "@mui/icons-material/ExpandMore";
import ChevronRightIcon from "@mui/icons-material/ChevronRight";
import InfoOutlinedIcon from "@mui/icons-material/InfoOutlined";
import HistoryIcon from "@mui/icons-material/History";
import StarBorderIcon from "@mui/icons-material/StarBorder";
import StarIcon from "@mui/icons-material/Star";
import RefreshIcon from "@mui/icons-material/Refresh";
import EditIcon from "@mui/icons-material/Edit";
import DeleteOutlineIcon from "@mui/icons-material/DeleteOutline";
import DeleteForeverIcon from "@mui/icons-material/DeleteForever";
import WarningAmberIcon from "@mui/icons-material/WarningAmber";
import CloseIcon from "@mui/icons-material/Close";
import SearchIcon from "@mui/icons-material/Search";
import FormatAlignLeftIcon from "@mui/icons-material/FormatAlignLeft";
import StorageIcon from "@mui/icons-material/Storage";
import ContentCopyIcon from "@mui/icons-material/ContentCopy";
import DataObjectIcon from "@mui/icons-material/DataObject";
import TableViewIcon from "@mui/icons-material/TableView";
import IntegrationInstructionsIcon from "@mui/icons-material/IntegrationInstructions";
import FiberManualRecordIcon from "@mui/icons-material/FiberManualRecord";
import AddIcon from "@mui/icons-material/Add";
import FileDownloadIcon from "@mui/icons-material/FileDownload";
import ArrowDropDownIcon from "@mui/icons-material/ArrowDropDown";
import ArrowUpwardIcon from "@mui/icons-material/ArrowUpward";
import ArrowDownwardIcon from "@mui/icons-material/ArrowDownward";
import UnfoldMoreIcon from "@mui/icons-material/UnfoldMore";
import MenuBookIcon from "@mui/icons-material/MenuBook";
import CheckCircleOutlineIcon from "@mui/icons-material/CheckCircleOutline";
import AutoAwesomeIcon from "@mui/icons-material/AutoAwesome";
import API_BASE_URL from "../../config";
import { fetchWithSession } from "../../utils/sessionManager";
import { useFeatures } from "../../utils/featuresApi";
import { useEditMode } from "../../contexts/EditModeContext";
import { useLanguage } from "../../contexts/LanguageContext";
import { useKeyboardShortcut } from "../../contexts/ShortcutsContext";
import EditStopDialog from "../edit/EditStopDialog";
import EditRouteDialog from "../edit/EditRouteDialog";
import EditTripDialog from "../edit/EditTripDialog";
import NL2SQLPanel from "./NL2SQLPanel";
import BetaGateDialog, { BETA_CODE_STORAGE_KEY } from "../edit/BetaGateDialog";
import {
  MONO_FONT,
  HISTORY_MAX,
  EDITOR_HEIGHT_KEY,
  EDITOR_HEIGHT_MIN,
  EDITOR_HEIGHT_MAX,
  EDITOR_HEIGHT_DEFAULT,
  SCHEMA_VISIBLE_KEY,
  CURRENT_QUERY_KEY,
  SCHEMA_WIDTH_KEY,
  SCHEMA_WIDTH_MIN,
  SCHEMA_WIDTH_MAX,
  SCHEMA_WIDTH_DEFAULT,
  SET_QUERY_EVENT,
  NL2SQL_PREFILL_KEY,
} from "./constants";
import {
  EDITABLE_ENTITIES,
  EDITABLE_FIELDS,
  PATCH_ENDPOINTS,
  SQL_FALLBACK_TABLES,
  PARENT_CASCADE_TABLES,
  SINGLETON_REQUIRED_TABLES,
} from "./editableFields";
import {
  BROWSE_FILES,
  BROWSE_GROUPS,
  FILE_PRESET_SHORTCUTS,
  PRESET_QUERIES,
  GROUP_ICONS,
} from "./presetQueries";
import {
  loadHistory,
  saveHistory,
  loadUserPresets,
  saveUserPresets,
  loadCachedSchema,
  persistCachedSchema,
  invalidateCachedSchema,
} from "./persistence";
import {
  toCSV,
  toJSON,
  toMarkdown,
  toInsertSqlAll,
  downloadAs,
} from "./exporters";
import {
  sqlQuote,
  buildInsertSql,
  buildBulkUpdateSql,
  buildBulkUpdateSqlFull,
  buildBulkDeleteSqlFull,
} from "./sqlBuilders";
import { validateFieldValue } from "./fieldValidation";
import {
  formatSql,
  highlightSqlInline,
  inferEditable,
  extractErrorLine,
  inferColumnType,
  TYPE_TO_COLOR,
  detectMutation,
} from "./sqlText";
import { formatHumanCount, formatRowCount, formatRelative } from "./formatters";
import Kbd from "./Kbd";
import SqlInsertDraftRow from "./SqlInsertDraftRow";
import SqlResultRow from "./SqlResultRow";
import SqlPreviewDialog from "./SqlPreviewDialog";

// Lazy-loaded CodeMirror editor: keeps main bundle slim. While CodeMirror
// loads, we fall back to a plain TextField so users can still type.
const CodeMirrorQueryEditor = lazy(() => import("./CodeMirrorQueryEditor"));

/* ------------------------------------------------------------------ */
/* Component                                                           */
/* ------------------------------------------------------------------ */

// Read the beta code from localStorage. Falls back to null on
// incognito-strict browsers where localStorage throws. Mirrors the helper
// in NL2SQLPanel.js — duplicated at module level here rather than imported
// since the two components own their own gate logic.
const readBetaCode = () => {
  try {
    return localStorage.getItem(BETA_CODE_STORAGE_KEY);
  } catch {
    return null;
  }
};

function SqlConsole() {
  const { t, language } = useLanguage();
  const { editing, counts, dataVersion, recordEdit } = useEditMode();
  // Server-side feature flags — used to gate the NL2SQL panel below. The
  // hook seeds with conservative defaults (everything off) until the
  // /gtfs/config/features call lands, so we never flash a button that
  // would 503 on click. `loaded` is only used here for diagnostics.
  const { features: serverFeatures } = useFeatures();
  const theme = useTheme();
  const isDark = theme.palette.mode === "dark";

  // Sort each preset group's items alphabetically by their localized label.
  // Sorting on the resolved label (via `t(labelKey)`) gives the user an
  // alphabetical list in their own language. We use Intl.Collator with the
  // current `language` so accented and non-Latin scripts sort correctly
  // (Arabic, Chinese, etc.). The memo is keyed on `language` because `t` is
  // stable across renders within the same language but the sort outcome
  // changes when the user switches languages.
  const presetGroups = useMemo(() => {
    const collator = new Intl.Collator(language || undefined, {
      sensitivity: "base",
      numeric: true,
    });
    return PRESET_QUERIES.map((group) => ({
      ...group,
      items: [...group.items].sort((a, b) =>
        collator.compare(t(a.labelKey), t(b.labelKey)),
      ),
    }));
  }, [language, t]);

  /* --- preview-and-confirm state --------------------------------- */
  // Holds the response from POST /edit/sql/preview while the modal is
  // open. Null means "no pending preview" — the user is either looking
  // at results or in the middle of a normal flow. The confirm checkbox
  // is reset on every dialog open so an opt-in from a previous large
  // mutation doesn't leak into the next one.
  const [previewData, setPreviewData] = useState(null);
  const [previewQuery, setPreviewQuery] = useState("");
  const [confirmedLargeMutation, setConfirmedLargeMutation] = useState(false);

  /* --- query state ------------------------------------------------ */
  // Seeded from sessionStorage so the query survives tab switches
  // (unmount/remount). Falls back to "" so the first-mount autorun
  // effect below can still inject `SELECT * FROM routes;` on a fresh load.
  const [query, setQuery] = useState(() => {
    try {
      return sessionStorage.getItem(CURRENT_QUERY_KEY) || "";
    } catch {
      return "";
    }
  });
  const textareaRef = useRef(null); // fallback TextField (Suspense fallback)
  const cmEditorRef = useRef(null); // CodeMirrorQueryEditor imperative handle
  const [running, setRunning] = useState(false);
  const [result, setResult] = useState(null);
  const [error, setError] = useState(null);
  const [errorLine, setErrorLine] = useState(null);
  const [lastRanQuery, setLastRanQuery] = useState(null);

  /* --- result UI state ------------------------------------------- */
  const [filter, setFilter] = useState("");
  const [debouncedFilter, setDebouncedFilter] = useState("");
  const [selectedRows, setSelectedRows] = useState(() => new Set());

  /* --- inline mutator state -------------------------------------- */
  const [mutatorOpen, setMutatorOpen] = useState(false);
  const [mutatorColumn, setMutatorColumn] = useState("");
  const [mutatorValue, setMutatorValue] = useState("");
  const [mutatorApplying, setMutatorApplying] = useState(false);

  /* --- bulk delete state ----------------------------------------- */
  const [deleteConfirmOpen, setDeleteConfirmOpen] = useState(false);
  const [deleting, setDeleting] = useState(false);

  /* --- bottom toolbar state -------------------------------------- */
  // Export menu (CSV / JSON / SQL / Markdown) anchor.
  const [exportAnchor, setExportAnchor] = useState(null);
  // Inline insert (replaces former modal Insert dialog). When non-null,
  // a draft row is rendered directly in the table, editable inline, with
  // commit/cancel buttons. Shape:
  //   { values: { [col]: string }, errors: { [col]: string },
  //     position: "after-selected" | "end", anchorId: string|null }
  const [pendingInsertRow, setPendingInsertRow] = useState(null);
  const [insertSubmitting, setInsertSubmitting] = useState(false);
  // Ref to focus the first editable input as soon as the draft row mounts.
  const pendingInsertFirstInputRef = useRef(null);
  // Guards the auto-focus effect: true once the first input has been focused
  // for the current draft session. Prevents re-focus on every keystroke
  // (updatePendingInsertValue creates a new object reference each time,
  // which would re-trigger a naive useEffect([pendingInsertRow]) and steal
  // focus back to the first field while the user is typing in another one).
  const pendingInsertFocusedRef = useRef(false);

  /* --- cell editing state (DBeaver-style double-click) ----------- */
  // editingCell: { rowId, column } when an input is open.
  // cellStatus:  { [rowId-column]: "saving" | "saved" | "error" } for the
  // visual feedback fade.
  const [editingCell, setEditingCell] = useState(null);
  const [cellInputValue, setCellInputValue] = useState("");
  const [cellStatus, setCellStatus] = useState({});
  const cellInputRef = useRef(null);

  /* --- copy context menu (right-click on cell/row) --------------- */
  const [copyMenu, setCopyMenu] = useState(null); // { x, y, row, col }

  /* --- auto-refresh on dataVersion bump (toggleable) ------------- */
  const [autoRefresh, setAutoRefresh] = useState(true);

  /* --- schema browser state -------------------------------------- */
  // We seed `schema` from sessionStorage so the schema browser opens with
  // zero network on subsequent mounts within the same session.
  const sessionIdForCache = useMemo(() => {
    try {
      return window.localStorage.getItem("gtfs_session_id") || null;
    } catch {
      return null;
    }
  }, []);
  const [schema, setSchema] = useState(() =>
    loadCachedSchema(sessionIdForCache),
  );
  // schemaVisible drives the left sidebar (DBeaver-like). Default true on
  // first load (no persisted preference) so newcomers immediately see the
  // schema tree; existing users keep their toggled-off preference.
  const [schemaVisible, setSchemaVisible] = useState(() => {
    try {
      const raw = window.localStorage.getItem(SCHEMA_VISIBLE_KEY);
      if (raw === null) return true; // first load: show by default
      return raw === "1";
    } catch {
      return true;
    }
  });
  const [schemaWidth, setSchemaWidth] = useState(() => {
    try {
      const raw = window.localStorage.getItem(SCHEMA_WIDTH_KEY);
      const n = parseInt(raw, 10);
      if (Number.isFinite(n)) {
        return Math.min(SCHEMA_WIDTH_MAX, Math.max(SCHEMA_WIDTH_MIN, n));
      }
    } catch {
      /* ignore */
    }
    return SCHEMA_WIDTH_DEFAULT;
  });
  const [schemaSearch, setSchemaSearch] = useState("");
  const [schemaLoading, setSchemaLoading] = useState(false);
  const [expandedTables, setExpandedTables] = useState({});
  const schemaSplitterDragRef = useRef(null);

  /* --- presets / history ----------------------------------------- */
  const [presetLibraryAnchor, setPresetLibraryAnchor] = useState(null);
  const [presetSearch, setPresetSearch] = useState("");
  const [activePresetGroup, setActivePresetGroup] = useState(
    PRESET_QUERIES[0].groupId,
  );
  const [history, setHistory] = useState(() => loadHistory());
  const [userPresets, setUserPresets] = useState(() => loadUserPresets());
  const [historyAnchor, setHistoryAnchor] = useState(null);
  const [nl2sqlAnchor, setNl2sqlAnchor] = useState(null);
  const [nl2sqlBetaOpen, setNl2sqlBetaOpen] = useState(false);
  const nl2sqlButtonRef = useRef(null);
  // Stable DOM handle on the sparkles trigger so the popover can be opened
  // programmatically (validation page "Ask AI to fix" hand-off), not only
  // from the button's own click event.
  const nl2sqlTriggerRef = useRef(null);
  const [savePresetOpen, setSavePresetOpen] = useState(false);
  const [savePresetName, setSavePresetName] = useState("");

  /* --- toast / snack --------------------------------------------- */
  const [snack, setSnack] = useState(null);

  /* --- single-row edit dialog ------------------------------------ */
  const [editTarget, setEditTarget] = useState(null);

  /* --- resizable editor pane (drag splitter) --------------------- */
  const [editorHeight, setEditorHeight] = useState(() => {
    try {
      const raw = window.localStorage.getItem(EDITOR_HEIGHT_KEY);
      const n = parseInt(raw, 10);
      if (Number.isFinite(n)) {
        return Math.min(EDITOR_HEIGHT_MAX, Math.max(EDITOR_HEIGHT_MIN, n));
      }
    } catch {
      /* ignore */
    }
    return EDITOR_HEIGHT_DEFAULT;
  });
  const splitterDragRef = useRef(null);

  /* --- shortcut help dialog -------------------------------------- */
  const [helpOpen, setHelpOpen] = useState(false);

  /* --- helpers --------------------------------------------------- */
  const showSnack = useCallback((msg) => setSnack({ msg }), []);

  // Splitter drag — pure DOM listeners on window, fires until mouseup.
  const handleSplitterMouseDown = useCallback(
    (e) => {
      e.preventDefault();
      const startY = e.clientY;
      const startHeight = editorHeight;
      splitterDragRef.current = { startY, startHeight };
      const onMove = (ev) => {
        const dy = ev.clientY - startY;
        const next = Math.min(
          EDITOR_HEIGHT_MAX,
          Math.max(EDITOR_HEIGHT_MIN, startHeight + dy),
        );
        setEditorHeight(next);
      };
      const onUp = () => {
        window.removeEventListener("mousemove", onMove);
        window.removeEventListener("mouseup", onUp);
        try {
          window.localStorage.setItem(
            EDITOR_HEIGHT_KEY,
            String(splitterDragRef.current?.lastValue ?? editorHeight),
          );
        } catch {
          /* ignore */
        }
      };
      window.addEventListener("mousemove", onMove);
      window.addEventListener("mouseup", onUp);
    },
    [editorHeight],
  );

  // Persist on every change (debounced via the next animation frame).
  useEffect(() => {
    const id = window.requestAnimationFrame(() => {
      try {
        window.localStorage.setItem(EDITOR_HEIGHT_KEY, String(editorHeight));
      } catch {
        /* ignore */
      }
    });
    return () => window.cancelAnimationFrame(id);
  }, [editorHeight]);

  // Persist schema sidebar visibility flip (cheap, no rAF needed).
  useEffect(() => {
    try {
      window.localStorage.setItem(
        SCHEMA_VISIBLE_KEY,
        schemaVisible ? "1" : "0",
      );
    } catch {
      /* ignore */
    }
  }, [schemaVisible]);

  // Persist schema sidebar width (rAF-debounced so we don't thrash storage
  // during a drag).
  useEffect(() => {
    const id = window.requestAnimationFrame(() => {
      try {
        window.localStorage.setItem(SCHEMA_WIDTH_KEY, String(schemaWidth));
      } catch {
        /* ignore */
      }
    });
    return () => window.cancelAnimationFrame(id);
  }, [schemaWidth]);

  // Auto-collapse the schema sidebar on small screens — it would consume
  // too much horizontal real estate. We only collapse when crossing the
  // breakpoint downward; the user is free to re-open it.
  useEffect(() => {
    if (typeof window === "undefined") return;
    const mq = window.matchMedia("(max-width: 768px)");
    const apply = () => {
      if (mq.matches) setSchemaVisible(false);
    };
    apply();
    mq.addEventListener?.("change", apply);
    return () => mq.removeEventListener?.("change", apply);
  }, []);

  // Schema splitter — vertical drag between sidebar and results. The hard
  // upper bound is also clamped to 50% of the parent in render to avoid
  // hiding the result table on narrow viewports.
  const handleSchemaSplitterMouseDown = useCallback(
    (e) => {
      e.preventDefault();
      const startX = e.clientX;
      const startWidth = schemaWidth;
      schemaSplitterDragRef.current = { startX, startWidth };
      const onMove = (ev) => {
        const dx = ev.clientX - startX;
        const next = Math.min(
          SCHEMA_WIDTH_MAX,
          Math.max(SCHEMA_WIDTH_MIN, startWidth + dx),
        );
        setSchemaWidth(next);
      };
      const onUp = () => {
        window.removeEventListener("mousemove", onMove);
        window.removeEventListener("mouseup", onUp);
      };
      window.addEventListener("mousemove", onMove);
      window.addEventListener("mouseup", onUp);
    },
    [schemaWidth],
  );

  const computeEditable = useCallback((response, ranQuery) => {
    if (response?.editable) return response.editable;
    return inferEditable(ranQuery || "", response?.columns || []);
  }, []);

  const editable = useMemo(
    () => computeEditable(result, lastRanQuery),
    [result, lastRanQuery, computeEditable],
  );

  // `entityForEdit` gates the row-level Edit dialog (pencil button) — limited
  // to entities for which we ship a dedicated Edit*Dialog (stop / route / trip).
  const entityForEdit = useMemo(() => {
    if (!editable?.isEditable) return null;
    if (!editable.pkPresentInColumns) return null;
    if (!EDITABLE_ENTITIES.has(editable.entity)) return null;
    return editable.entity;
  }, [editable]);

  // `cellEditableEntity` gates inline (double-click) cell editing — covers ALL
  // 15 GTFS tables. PK identification varies: feed_info has no PK (singleton),
  // composite-PK tables expose `editable.pk` as an array, and SQL-fallback
  // tables (calendar_dates, shapes) still need their composite-PK columns
  // present in the result set so we can build a WHERE clause.
  const cellEditableEntity = useMemo(() => {
    if (!editable?.isEditable) return null;
    const table = editable.table;
    if (!table) return null;
    if (!EDITABLE_FIELDS[table]) return null;
    // Singleton tables (feed_info) — no PK requirement.
    if (editable.pk == null) return editable.entity;
    // Standard tables — backend's pkPresentInColumns flag must be true so
    // that we have an addressable identifier for the PATCH/SQL UPDATE.
    if (!editable.pkPresentInColumns) return null;
    return editable.entity;
  }, [editable]);

  const pkAccessor = useCallback(
    (row) => {
      // Singleton tables (e.g. feed_info) — synthesise a stable key so
      // cell-status / selection maps work without a real PK.
      if (editable?.isEditable && editable?.pk == null && editable?.table) {
        return `__singleton__:${editable.table}`;
      }
      if (!editable?.pk) return null;
      if (Array.isArray(editable.pk)) {
        return editable.pk.map((k) => row?.[k] ?? "").join(":");
      }
      return row?.[editable.pk] != null ? String(row[editable.pk]) : null;
    },
    [editable],
  );

  // Pick the right endpoint depending on edit mode. /sql is the read-only
  // entry point; /edit/sql accepts mutations when the user is in edit mode.
  const sqlEndpoint = editing ? "/edit/sql" : "/sql";

  /* --- run query ------------------------------------------------- */
  // `options.skipPreview` short-circuits the preview-and-confirm gate.
  //   - Default flow (skipPreview=false): if `editing` is on AND the SQL is
  //     a mutation, we POST /edit/sql/preview first. If totalAffected is at
  //     or below the previewThreshold (typically 50), we recurse into the
  //     same function with `skipPreview: true` so small UPDATEs run with no
  //     friction. Otherwise we open the SqlPreviewDialog and bail out — the
  //     dialog will call us back with `skipPreview: true` on confirm.
  //   - `options.confirmedLargeMutation` is forwarded to /edit/sql when the
  //     user opted into the 200k cap from the dialog.
  const runQueryWith = useCallback(
    async (sqlText, options = {}) => {
      const { skipPreview = false, confirmedLargeMutation: confirmed = false } =
        options;
      const trimmed = (sqlText || "").trim();
      if (!trimmed) return;

      // Preview-and-confirm gate. Only triggers when the user is in edit
      // mode AND the query is a mutation AND we haven't already confirmed.
      if (!skipPreview && editing && detectMutation(trimmed)) {
        setRunning(true);
        setError(null);
        try {
          const res = await fetchWithSession(
            `${API_BASE_URL}/edit/sql/preview`,
            {
              method: "POST",
              headers: { "Content-Type": "application/json" },
              body: JSON.stringify({ query: trimmed }),
            },
          );
          const body = await res.json();
          if (!res.ok) {
            const msg =
              body.error ||
              t("sqlConsole.preview.previewError", {
                error: t("sqlConsole.queryError"),
              });
            setError(t("sqlConsole.preview.previewError", { error: msg }));
            setErrorLine(extractErrorLine(msg));
            return;
          }
          const total = Number(body.totalAffected) || 0;
          const threshold = Number(body.previewThreshold) || 50;
          // Auto-bypass for tiny mutations — keeps single-row UPDATEs as
          // zero-friction as before.
          if (
            total <= threshold &&
            !body.exceedsDefaultCap &&
            !body.exceedsConfirmedCap
          ) {
            // Recurse with the bypass flag set so we go straight to
            // /edit/sql. The outer finally (below) will release `running`
            // after the inner call's promise resolves; the inner call
            // re-acquires running on its own. Net effect: a single
            // running=true window from the user's perspective.
            return runQueryWith(trimmed, { skipPreview: true });
          }
          // Open the dialog. Reset the opt-in checkbox so the previous
          // session's tick doesn't carry over.
          setPreviewData(body);
          setPreviewQuery(trimmed);
          setConfirmedLargeMutation(false);
          return;
        } catch (err) {
          setError(
            t("sqlConsole.preview.previewError", {
              error: err.message || "Network error",
            }),
          );
        } finally {
          setRunning(false);
        }
        return;
      }

      setRunning(true);
      setError(null);
      try {
        // The `confirmedLargeMutation` flag only matters for /edit/sql
        // (mutation path). It's harmless on /sql but we keep it scoped.
        const payload = { query: trimmed };
        if (editing && confirmed) {
          payload.confirmedLargeMutation = true;
        }
        const res = await fetchWithSession(`${API_BASE_URL}${sqlEndpoint}`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify(payload),
        });
        const body = await res.json();
        if (!res.ok) {
          const msg = body.error || t("sqlConsole.queryError");
          setError(msg);
          setErrorLine(extractErrorLine(msg));
          return;
        }
        setErrorLine(null);
        setResult(body);
        setLastRanQuery(trimmed);
        // Selection is meaningful only against the previous result set.
        setSelectedRows(new Set());
        setMutatorOpen(false);
        setDeleteConfirmOpen(false);
        setHistory((prev) => {
          if (prev.length > 0 && prev[0].query === trimmed) return prev;
          const next = [{ query: trimmed, ts: Date.now() }, ...prev].slice(
            0,
            HISTORY_MAX,
          );
          saveHistory(next);
          return next;
        });
        if (body.mutated && body.affected != null) {
          // recordEdit() bumps dataVersion AND emits a success toast — without
          // it the SQL Console would never trigger refetches after a free-form
          // UPDATE/INSERT/DELETE, leaving every other panel stale until F5.
          recordEdit?.(
            t("sqlConsole.mutatedToast", {
              count: body.affected,
              table: body.table || "",
            }),
            body.validation,
            { entity: "sql_console", entityId: body.table || null },
          );
        }
      } catch (err) {
        setError(err.message || "Network error");
      } finally {
        setRunning(false);
      }
    },
    [sqlEndpoint, editing, t, recordEdit],
  );

  /* --- preview-confirm handlers ---------------------------------- */
  // Confirm: close dialog, then invoke runQueryWith with both bypass
  // flags. We snapshot the values into locals first because closing
  // the dialog clears `previewQuery`/`previewData` synchronously.
  const handlePreviewConfirm = useCallback(() => {
    const sqlToRun = previewQuery;
    const confirmed = confirmedLargeMutation;
    setPreviewData(null);
    setPreviewQuery("");
    setConfirmedLargeMutation(false);
    runQueryWith(sqlToRun, {
      skipPreview: true,
      confirmedLargeMutation: confirmed,
    });
  }, [previewQuery, confirmedLargeMutation, runQueryWith]);

  const handlePreviewCancel = useCallback(() => {
    setPreviewData(null);
    setPreviewQuery("");
    setConfirmedLargeMutation(false);
  }, []);

  const runQuery = useCallback(() => {
    if (running) return;
    runQueryWith(query);
  }, [query, running, runQueryWith]);

  /* --- schema (lazy on open + sessionStorage cache) -------------- */
  const loadSchema = useCallback(
    async ({ force = false } = {}) => {
      // Cache hit: short-circuit unless caller forces a reload (e.g. after
      // a DDL statement modified the schema).
      if (!force && schema) return;
      setSchemaLoading(true);
      try {
        const path = editing ? "/edit/sql/schema" : "/sql/schema";
        const res = await fetchWithSession(`${API_BASE_URL}${path}`);
        const body = await res.json();
        if (res.ok) {
          setSchema(body);
          if (sessionIdForCache) persistCachedSchema(sessionIdForCache, body);
        }
      } catch (err) {
        console.warn("schema load failed", err);
      } finally {
        setSchemaLoading(false);
      }
    },
    [editing, schema, sessionIdForCache],
  );

  // Eagerly load the schema when missing so autocomplete has the table+
  // column list ready before the user opens the schema browser. Cheap
  // because the response is cached in sessionStorage on first hit.
  useEffect(() => {
    if (schema) return;
    loadSchema();
  }, [schema, loadSchema]);

  // Invalidate the cached schema whenever:
  //   - edit mode flips (entering edit mode swaps backend endpoints and
  //     may surface different tables);
  //   - the active session changes (a new upload replaces the DB);
  //   - dataVersion bumps (a mutation may have ALTERed the schema, e.g.
  //     a CREATE TABLE in the SQL Console).
  // Without these deps the cached schema can be stale and autocomplete
  // suggests columns that no longer exist.
  useEffect(() => {
    invalidateCachedSchema();
  }, [editing, sessionIdForCache, dataVersion]);

  /* --- listen to external "set query" events --------------------- */
  useEffect(() => {
    const handler = (e) => {
      const detail = e?.detail || {};
      if (typeof detail.query !== "string") return;
      setQuery(detail.query);
      if (detail.autorun) {
        setTimeout(() => runQueryWith(detail.query), 0);
      }
    };
    window.addEventListener(SET_QUERY_EVENT, handler);
    return () => window.removeEventListener(SET_QUERY_EVENT, handler);
  }, [runQueryWith]);

  /* --- first-mount default query (autorun SELECT * FROM routes) -- */
  // Seed the console with `SELECT * FROM routes;` on the very first mount
  // so the user lands on data rather than an empty state. We skip the
  // autorun if:
  //   - results are already present (defensive),
  //   - no feed is loaded yet (counts.routes is unknown / zero),
  //   - the persisted query is a MUTATION (UPDATE/INSERT/DELETE/REPLACE)
  //     — auto-executing a mutation on tab-switch or fix-button arrival
  //     would silently apply potentially destructive changes (or fail on
  //     a `<value>` placeholder from FixInSqlConsoleButton).
  const didFirstMountAutorunRef = useRef(false);
  useEffect(() => {
    if (didFirstMountAutorunRef.current) return;
    if (result !== null) {
      // Results already present — nothing to do.
      didFirstMountAutorunRef.current = true;
      return;
    }
    if (!counts || (counts.routes ?? 0) <= 0) return; // wait for feed
    didFirstMountAutorunRef.current = true;
    if (query !== "") {
      if (detectMutation(query)) {
        // Mutation seeded externally — ONLY pre-fill the editor, never
        // auto-execute. The user must explicitly click Run (and will go
        // through the preview-and-confirm dialog for any non-trivial
        // affected count).
        return;
      }
      // Persisted SELECT (tab switch remount) — re-run to repopulate the
      // results table with fresh data.
      runQueryWith(query);
    } else {
      // Fresh load — seed with default SELECT query.
      const sql = "SELECT * FROM routes;";
      setQuery(sql);
      runQueryWith(sql);
    }
  }, [counts, query, result, runQueryWith]);

  /* --- auto-refresh after mutation (dataVersion bump) ------------ */
  // Replay the last *SELECT* every time `dataVersion` advances. Covers
  // inline cell edits, the Mutator, and edits performed elsewhere in the
  // app while the SQL Console is open. We MUST skip when `lastRanQuery`
  // is itself a mutation: replaying a DELETE/UPDATE/INSERT from this
  // effect would re-run the mutation, which calls `recordEdit()` →
  // bumps `dataVersion` again → infinite loop. The user can also pause
  // the auto-refresh entirely via the toggle.
  const lastDataVersionRef = useRef(dataVersion);
  useEffect(() => {
    if (lastDataVersionRef.current !== dataVersion) {
      lastDataVersionRef.current = dataVersion;
      if (
        autoRefresh &&
        lastRanQuery &&
        !running &&
        !detectMutation(lastRanQuery)
      ) {
        runQueryWith(lastRanQuery);
      }
    }
  }, [dataVersion, lastRanQuery, running, runQueryWith, autoRefresh]);

  /* --- persist current query to sessionStorage (survives tab switches) */
  useEffect(() => {
    try {
      sessionStorage.setItem(CURRENT_QUERY_KEY, query);
    } catch {}
  }, [query]);

  /* --- debounce filter input (avoid filtering on every keystroke) */
  useEffect(() => {
    const timer = setTimeout(() => setDebouncedFilter(filter), 120);
    return () => clearTimeout(timer);
  }, [filter]);

  /* --- export / clear / format ----------------------------------- */

  // Filename stem shared across all export formats. We prefer the editable
  // table name (e.g. `stops`) for legibility; fall back to a timestamped
  // generic name when the query is read-only / multi-table.
  const exportFilenameStem = useCallback(() => {
    const stamp = new Date().toISOString().replace(/[:.]/g, "-");
    const tbl = (editable?.table || "").replace(/[^A-Za-z0-9_-]/g, "");
    return tbl ? `gtfs-${tbl}-${stamp}` : `gtfs-query-${stamp}`;
  }, [editable]);

  const exportJSON = useCallback(() => {
    if (!result?.columns || !result?.rows) return;
    const json = toJSON(result.columns, result.rows);
    downloadAs(json, `${exportFilenameStem()}.json`, "application/json");
  }, [result, exportFilenameStem]);

  // Single CSV button. Server-side streaming is tried first (no row cap,
  // RFC 4180). If the server refuses (multi-statement batch, mutation,
  // network error) we fall back silently to the in-memory snapshot of the
  // currently displayed rows so the user always gets a file.
  const exportCSV = useCallback(async () => {
    const text = (query || "").trim();
    const stem = exportFilenameStem();

    const fallbackInMemory = () => {
      if (!result?.columns || !result?.rows?.length) return false;
      const csv = toCSV(result.columns, result.rows);
      downloadAs(csv, `${stem}.csv`, "text/csv");
      return true;
    };

    if (!text) {
      if (!fallbackInMemory()) return;
      return;
    }

    try {
      const res = await fetchWithSession(`${API_BASE_URL}/sql/export.csv`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ query: text, filename: stem }),
      });
      if (res.ok) {
        const blob = await res.blob();
        const dispo = res.headers.get("Content-Disposition") || "";
        const match = dispo.match(/filename="([^"]+)"/i);
        const filename = match ? match[1] : `${stem}.csv`;
        const url = URL.createObjectURL(blob);
        const a = document.createElement("a");
        a.href = url;
        a.download = filename;
        document.body.appendChild(a);
        a.click();
        document.body.removeChild(a);
        URL.revokeObjectURL(url);
        return;
      }
      // Streaming refused (400 multi-statement, 403 mutation, 5xx, etc.):
      // use the in-memory snapshot when we have one, otherwise surface the
      // server error.
      if (fallbackInMemory()) return;
      let msg = t("sqlConsole.export.csvStreamFailed");
      try {
        const body = await res.json();
        if (body?.error) msg = body.error;
      } catch {
        /* non-JSON body */
      }
      showSnack(msg);
    } catch (err) {
      console.error("CSV export failed, falling back to in-memory:", err);
      if (fallbackInMemory()) return;
      showSnack(t("sqlConsole.export.csvStreamFailed"));
    }
  }, [query, result, exportFilenameStem, showSnack, t]);

  const exportInsertSql = useCallback(() => {
    if (!result?.columns || !result?.rows) return;
    const tbl = editable?.table || "table_name";
    const sql = toInsertSqlAll(tbl, result.columns, result.rows);
    downloadAs(sql, `${exportFilenameStem()}.sql`, "application/sql");
  }, [result, editable, exportFilenameStem]);

  const exportMarkdown = useCallback(() => {
    if (!result?.columns || !result?.rows) return;
    const md = toMarkdown(result.columns, result.rows);
    downloadAs(md, `${exportFilenameStem()}.md`, "text/markdown");
  }, [result, exportFilenameStem]);

  // Clipboard variants — same payloads, different sink. We share a single
  // helper to surface a uniform "copied" toast on success / error.
  const copyToClipboardWithToast = useCallback(
    async (content, toastKey) => {
      try {
        await navigator.clipboard.writeText(content);
        showSnack(t(toastKey || "sqlConsole.copy.copied"));
      } catch {
        showSnack(t("sqlConsole.copy.copied"));
      }
    },
    [showSnack, t],
  );

  const copyExportCsv = useCallback(() => {
    if (!result?.columns || !result?.rows) return;
    copyToClipboardWithToast(
      toCSV(result.columns, result.rows),
      "sqlConsole.copy.copied",
    );
  }, [result, copyToClipboardWithToast]);

  const copyExportJson = useCallback(() => {
    if (!result?.columns || !result?.rows) return;
    copyToClipboardWithToast(
      toJSON(result.columns, result.rows),
      "sqlConsole.copy.copied",
    );
  }, [result, copyToClipboardWithToast]);

  const copyExportSql = useCallback(() => {
    if (!result?.columns || !result?.rows) return;
    const tbl = editable?.table || "table_name";
    copyToClipboardWithToast(
      toInsertSqlAll(tbl, result.columns, result.rows),
      "sqlConsole.copy.copied",
    );
  }, [result, editable, copyToClipboardWithToast]);

  const copyExportMarkdown = useCallback(() => {
    if (!result?.columns || !result?.rows) return;
    copyToClipboardWithToast(
      toMarkdown(result.columns, result.rows),
      "sqlConsole.copy.copied",
    );
  }, [result, copyToClipboardWithToast]);

  const handleClearAll = useCallback(() => {
    setQuery("");
    setResult(null);
    setError(null);
    setLastRanQuery(null);
    setFilter("");
    setSelectedRows(new Set());
    setMutatorOpen(false);
    setDeleteConfirmOpen(false);
  }, []);

  const clearSelection = useCallback(() => {
    setSelectedRows(new Set());
    setMutatorOpen(false);
  }, []);

  const handleFormat = useCallback(() => {
    setQuery((q) => formatSql(q));
  }, []);

  /* --- preset / file actions ------------------------------------- */
  const browseFile = useCallback(
    (table) => {
      const sql = `SELECT * FROM ${table};`;
      setQuery(sql);
      runQueryWith(sql);
    },
    [runQueryWith],
  );

  const insertPreset = useCallback(
    (sql, autorun = false) => {
      setQuery(sql);
      if (autorun) runQueryWith(sql);
    },
    [runQueryWith],
  );

  const handleSavePreset = useCallback(() => {
    const name = savePresetName.trim();
    if (!name) return;
    const next = [
      ...userPresets,
      { id: `user-${Date.now()}`, name, sql: query, ts: Date.now() },
    ];
    setUserPresets(next);
    saveUserPresets(next);
    setSavePresetOpen(false);
    setSavePresetName("");
    showSnack(t("sqlConsole.presetSaved", { name }));
  }, [savePresetName, userPresets, query, showSnack, t]);

  const handleDeleteUserPreset = useCallback(
    (id) => {
      const next = userPresets.filter((p) => p.id !== id);
      setUserPresets(next);
      saveUserPresets(next);
    },
    [userPresets],
  );

  const handleClearHistory = useCallback(() => {
    setHistory([]);
    saveHistory([]);
    setHistoryAnchor(null);
  }, []);

  /* --- NL2SQL beta gate ------------------------------------------ */
  // Lightweight server-side validation of the beta code BEFORE we open the
  // NL2SQL popover. We send `naturalLanguage: "x"` (under the 3-char floor)
  // which means the gate runs FIRST (403 if code invalid) and the actual
  // Claude call short-circuits with 400 AFTER the gate passes — so a valid
  // code yields 400, an invalid one yields 403. No upstream tokens burnt.
  const handleNl2sqlGateSubmit = useCallback(
    async (code) => {
      try {
        const res = await fetchWithSession(`${API_BASE_URL}/sql/nl2sql`, {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            "X-Beta-Code": code,
          },
          body: JSON.stringify({
            naturalLanguage: "x",
            mode: "read",
            language,
          }),
        });
        if (res.status === 403) {
          const body = await res.json().catch(() => ({}));
          return { ok: false, errorCode: body.error || "INVALID_BETA_CODE" };
        }
        // 400 = gate passed (input too short is caught AFTER the gate) —
        // code valid. Open the NL2SQL popover and close this dialog.
        setNl2sqlBetaOpen(false);
        setNl2sqlAnchor(nl2sqlButtonRef.current);
        return { ok: true };
      } catch {
        return { ok: false, errorCode: "NETWORK_ERROR" };
      }
    },
    [language],
  );

  // Auto-open the NL2SQL popover when an external surface (validation page
  // "Ask AI to fix") parked a pre-filled question in sessionStorage. The
  // prefill itself is consumed by NL2SQLPanel on open; here we only handle
  // the "make the popover visible" half, including the beta gate.
  const nl2sqlAutoOpenDone = useRef(false);
  const nl2sqlEnabled = Boolean(serverFeatures?.nl2sql?.enabled);
  useEffect(() => {
    if (!nl2sqlEnabled || nl2sqlAutoOpenDone.current) return;
    let pending = null;
    try {
      pending = sessionStorage.getItem(NL2SQL_PREFILL_KEY);
    } catch {
      /* sessionStorage unavailable — nothing to auto-open */
    }
    if (!pending) return;
    const el = nl2sqlTriggerRef.current;
    if (!el) return;
    nl2sqlAutoOpenDone.current = true;
    if (readBetaCode()) {
      setNl2sqlAnchor(el);
    } else {
      nl2sqlButtonRef.current = el;
      setNl2sqlBetaOpen(true);
    }
  }, [nl2sqlEnabled]);

  /* --- column insertion in editor -------------------------------- */
  const insertAtCursor = useCallback((text) => {
    // Prefer the CodeMirror imperative API when mounted; falls back to
    // the plain textarea (used while the lazy chunk is still loading).
    if (cmEditorRef.current?.insertAtCursor) {
      cmEditorRef.current.insertAtCursor(text);
      return;
    }
    const el = textareaRef.current;
    if (!el) {
      setQuery((q) => `${q}${text}`);
      return;
    }
    const start = el.selectionStart ?? el.value.length;
    const end = el.selectionEnd ?? el.value.length;
    const before = el.value.slice(0, start);
    const after = el.value.slice(end);
    const next = `${before}${text}${after}`;
    setQuery(next);
    setTimeout(() => {
      try {
        el.focus();
        el.setSelectionRange(start + text.length, start + text.length);
      } catch {
        /* ignore */
      }
    }, 0);
  }, []);

  /* --- selection toggles ---------------------------------------- */
  const toggleRow = useCallback(
    (row) => {
      const id = pkAccessor(row);
      if (!id) return;
      setSelectedRows((prev) => {
        const next = new Set(prev);
        if (next.has(id)) next.delete(id);
        else next.add(id);
        return next;
      });
    },
    [pkAccessor],
  );

  const toggleAllVisible = useCallback(
    (rows) => {
      const ids = rows.map(pkAccessor).filter(Boolean);
      setSelectedRows((prev) => {
        const allSelected = ids.length > 0 && ids.every((id) => prev.has(id));
        const next = new Set(prev);
        if (allSelected) {
          ids.forEach((id) => next.delete(id));
        } else {
          ids.forEach((id) => next.add(id));
        }
        return next;
      });
    },
    [pkAccessor],
  );

  /* --- inline mutator ------------------------------------------- */
  const mutatorTable = editable?.table;
  const mutatorPk = editable?.pk;
  const mutatorEditableFields = useMemo(
    () => (mutatorTable && EDITABLE_FIELDS[mutatorTable]) || [],
    [mutatorTable],
  );
  const mutatorFieldDef = useMemo(
    () => mutatorEditableFields.find((f) => f.key === mutatorColumn) || null,
    [mutatorEditableFields, mutatorColumn],
  );

  // Reset mutator inputs whenever the result set or selection radically
  // changes (different table → different fields).
  useEffect(() => {
    setMutatorColumn("");
    setMutatorValue("");
  }, [mutatorTable]);

  const generatedMutatorPreview = useMemo(() => {
    if (
      !mutatorTable ||
      !mutatorPk ||
      !mutatorColumn ||
      selectedRows.size === 0
    ) {
      return "";
    }
    return buildBulkUpdateSql(
      mutatorTable,
      mutatorPk,
      selectedRows,
      mutatorColumn,
      mutatorValue,
    );
  }, [mutatorTable, mutatorPk, selectedRows, mutatorColumn, mutatorValue]);

  const handleMutatorInsertInEditor = useCallback(() => {
    if (!mutatorTable || !mutatorPk || !mutatorColumn) return;
    const sql = buildBulkUpdateSqlFull(
      mutatorTable,
      mutatorPk,
      selectedRows,
      mutatorColumn,
      mutatorValue,
    );
    setQuery(sql);
    setMutatorOpen(false);
    showSnack(t("sqlConsole.mutator.insertedToast"));
  }, [
    mutatorTable,
    mutatorPk,
    mutatorColumn,
    mutatorValue,
    selectedRows,
    t,
    showSnack,
  ]);

  const handleMutatorApply = useCallback(async () => {
    if (!editing) return; // /sql endpoint refuses mutations
    if (!mutatorTable || !mutatorPk || !mutatorColumn) return;
    const sql = buildBulkUpdateSqlFull(
      mutatorTable,
      mutatorPk,
      selectedRows,
      mutatorColumn,
      mutatorValue,
    );
    setMutatorApplying(true);
    setError(null);
    try {
      const res = await fetchWithSession(`${API_BASE_URL}/edit/sql`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ query: sql }),
      });
      const body = await res.json();
      if (!res.ok) {
        setError(body.error || t("sqlConsole.queryError"));
        return;
      }
      // recordEdit() bumps dataVersion AND emits the success toast. The
      // dataVersion effect re-runs the last SELECT so the table updates.
      setMutatorOpen(false);
      setSelectedRows(new Set());
      recordEdit?.(
        t("sqlConsole.mutatedToast", {
          count: body.affected ?? selectedRows.size,
          table: mutatorTable,
        }),
        body.validation,
        { entity: "sql_console", entityId: mutatorTable },
      );
    } catch (err) {
      setError(err.message || "Network error");
    } finally {
      setMutatorApplying(false);
    }
  }, [
    editing,
    mutatorTable,
    mutatorPk,
    mutatorColumn,
    mutatorValue,
    selectedRows,
    t,
    recordEdit,
  ]);

  /* --- bulk delete --------------------------------------------- */
  // We can DELETE iff:
  //   - edit mode is on (otherwise /sql endpoint refuses mutations)
  //   - the result set carries an addressable PK (no PK → no safe WHERE)
  //   - at least one row is selected
  const canDelete = useMemo(
    () =>
      Boolean(
        editing &&
        editable?.isEditable &&
        editable?.table &&
        editable?.pk &&
        editable?.pkPresentInColumns &&
        selectedRows.size > 0,
      ),
    [editing, editable, selectedRows],
  );

  // Cascade hint for the confirm dialog. Returns the immediate child tables
  // (joined as a comma list) for parent tables, or null for leaf tables.
  const cascadeChildren = useMemo(() => {
    if (!editable?.table) return null;
    return PARENT_CASCADE_TABLES[editable.table] || null;
  }, [editable]);

  /* --- bottom toolbar: insert / edit gating ---------------------- */
  // canInsert: user can open the insert dialog when in edit mode AND the
  // backend recognises the table as editable AND we have a known PATCH
  // endpoint (or it's a SQL-fallback table — both flow through /edit/sql).
  const canInsert = useMemo(
    () =>
      Boolean(
        editing &&
        editable?.isEditable &&
        editable?.table &&
        (PATCH_ENDPOINTS[editable.entity] ||
          SQL_FALLBACK_TABLES[editable.table] ||
          EDITABLE_FIELDS[editable.table]),
      ),
    [editing, editable],
  );

  // canEdit: bottom-bar Edit button (opens the mutator). Same predicate as
  // the original selection-toolbar Edit button — requires a selection.
  const canEdit = useMemo(
    () => Boolean(editing && cellEditableEntity && selectedRows.size > 0),
    [editing, cellEditableEntity, selectedRows.size],
  );

  // Disabled-state translation keys — hint *why* a button is greyed out.
  // Read-mode is the dominant cause; "no selection" follows; "not editable"
  // is the residual (joins / multi-table / read-only result).
  const insertDisabledKey = !editing
    ? "sqlConsole.bottomBar.tooltip.disabled.readMode"
    : "sqlConsole.bottomBar.tooltip.disabled.notEditable";
  const editDisabledKey = !editing
    ? "sqlConsole.bottomBar.tooltip.disabled.readMode"
    : selectedRows.size === 0
      ? "sqlConsole.bottomBar.tooltip.disabled.noSelection"
      : "sqlConsole.bottomBar.tooltip.disabled.notEditable";
  const deleteDisabledKey = editDisabledKey;

  // GTFS-spec singleton guard: agency and feed_info must keep at least one
  // row. We warn the user if they're about to delete every visible row of
  // such a table — backend will reject anyway, but we surface the reason.
  const willEmptySingletonTable = useMemo(() => {
    if (!editable?.table) return false;
    if (!SINGLETON_REQUIRED_TABLES.has(editable.table)) return false;
    const total = result?.rows?.length || 0;
    return total > 0 && selectedRows.size >= total;
  }, [editable, result, selectedRows.size]);

  const handleDeleteSelected = useCallback(async () => {
    if (!canDelete || !editable?.table || !editable?.pk) return;
    const sql = buildBulkDeleteSqlFull(
      editable.table,
      editable.pk,
      selectedRows,
    );
    setDeleting(true);
    setError(null);
    try {
      const res = await fetchWithSession(`${API_BASE_URL}/edit/sql`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ query: sql }),
      });
      const body = await res.json();
      if (!res.ok) {
        setError(body.error || t("sqlConsole.queryError"));
        return;
      }
      const directCount = selectedRows.size;
      const totalAffected =
        typeof body.affected === "number" ? body.affected : directCount;
      const tableName = editable.table;
      // Bump dataVersion + show the global edit toast so the rest of the
      // app refetches its data. The backend already logged the cascade as a
      // single _edit_log entry, so Ctrl+Z replays the whole batch atomically.
      recordEdit?.(`Deleted ${directCount} row(s) from ${tableName}`, body.validation, {
        entity: "sql_console",
        entityId: tableName,
      });
      // If the backend reports a higher count than the user asked for, the
      // delta is the cascade fan-out — surface it explicitly so the user
      // understands the scope before they (maybe) Ctrl+Z.
      if (totalAffected > directCount) {
        showSnack(
          t("sqlConsole.deleted.toastCascade", {
            count: directCount,
            total: totalAffected,
            table: tableName,
          }),
        );
      } else {
        showSnack(
          t("sqlConsole.deleted.toast", {
            count: directCount,
            table: tableName,
          }),
        );
      }
      setDeleteConfirmOpen(false);
      setSelectedRows(new Set());
      setMutatorOpen(false);
    } catch (err) {
      setError(err.message || "Network error");
    } finally {
      setDeleting(false);
    }
  }, [canDelete, editable, selectedRows, t, showSnack, recordEdit]);

  /* --- bottom toolbar: open mutator from edit IconButton --------- */
  // Bottom-bar Edit button is a thin wrapper that toggles the mutator panel.
  // Selection / editability gating happens upstream via canEdit; the handler
  // is intentionally permissive so disabled state is purely visual.
  const openMutator = useCallback(() => {
    setMutatorOpen((v) => !v);
  }, []);

  /* --- bottom toolbar: inline insert (draft row) ----------------- */
  // Open the inline draft row. If exactly one row is selected, the draft is
  // anchored AFTER it; otherwise it lands at the end of the visible list.
  // Refuses silently if a draft is already pending — user must commit/cancel
  // first (keeps the flow obvious instead of stacking drafts).
  const beginInlineInsert = useCallback(() => {
    if (!editing || !editable?.table) return;
    if (pendingInsertRow) return;
    const single = selectedRows.size === 1 ? Array.from(selectedRows)[0] : null;
    setPendingInsertRow({
      values: {},
      errors: {},
      position: single ? "after-selected" : "end",
      anchorId: single,
    });
  }, [editing, editable, pendingInsertRow, selectedRows]);

  const cancelInlineInsert = useCallback(() => {
    setPendingInsertRow(null);
  }, []);

  // Update a single cell value of the draft row. Clears the per-field error
  // as soon as the user types — error feedback is non-sticky.
  const updatePendingInsertValue = useCallback((col, value) => {
    setPendingInsertRow((prev) => {
      if (!prev) return prev;
      const nextErrors = { ...prev.errors };
      delete nextErrors[col];
      return {
        ...prev,
        values: { ...prev.values, [col]: value },
        errors: nextErrors,
      };
    });
  }, []);

  const commitInlineInsert = useCallback(async () => {
    if (!editing || !editable?.table || !pendingInsertRow) return;
    const tbl = editable.table;
    const fields = EDITABLE_FIELDS[tbl] || [];
    const pkCols = Array.isArray(editable.pk)
      ? editable.pk
      : editable.pk
        ? [editable.pk]
        : [];

    // Some tables expose an auto-assigned identifier column that the user
    // must NOT fill (transfers.id, attributions.attribution_id). The backend
    // assigns it at INSERT time. We surface them as disabled "auto" cells.
    const AUTO_ASSIGNED_PK = {
      transfers: new Set(["id"]),
      attributions: new Set(["attribution_id"]),
    };
    const autoSet = AUTO_ASSIGNED_PK[tbl] || new Set();

    // Client-side validation: required PKs (excluding auto-assigned) + any
    // explicitly-required field.
    const values = pendingInsertRow.values || {};
    const errors = {};
    let firstMissing = null;
    for (const col of pkCols) {
      if (autoSet.has(col)) continue;
      if (!String(values[col] ?? "").trim()) {
        errors[col] = t("sqlConsole.insertInline.required", { field: col });
        if (!firstMissing) firstMissing = col;
      }
    }
    for (const f of fields) {
      if (f.required && !String(values[f.key] ?? "").trim()) {
        errors[f.key] = t("sqlConsole.insertInline.required", { field: f.key });
        if (!firstMissing) firstMissing = f.key;
      }
    }
    if (Object.keys(errors).length > 0) {
      setPendingInsertRow((prev) => (prev ? { ...prev, errors } : prev));
      if (firstMissing) {
        showSnack(
          t("sqlConsole.insertInline.required", { field: firstMissing }),
        );
      }
      return;
    }

    // Build INSERT — include only filled columns + non-auto PKs.
    const cols = [];
    const row = {};
    for (const col of pkCols) {
      if (autoSet.has(col)) continue;
      cols.push(col);
      row[col] = values[col];
    }
    for (const f of fields) {
      const v = values[f.key];
      if (v != null && String(v).trim() !== "" && !pkCols.includes(f.key)) {
        cols.push(f.key);
        row[f.key] = v;
      }
    }
    const sql = buildInsertSql(tbl, cols, row);

    setInsertSubmitting(true);
    setError(null);
    try {
      const res = await fetchWithSession(`${API_BASE_URL}/edit/sql`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ query: sql }),
      });
      const body = await res.json();
      if (!res.ok) {
        // Keep the draft row visible so the user can correct & retry.
        const msg = body.error || t("sqlConsole.queryError");
        setError(msg);
        showSnack(msg);
        return;
      }
      recordEdit?.(`Inserted row in ${tbl}`, body.validation, {
        entity: "sql_console",
        entityId: tbl,
      });
      showSnack(t("sqlConsole.insertRow.success", { table: tbl }));
      setPendingInsertRow(null);
      setSelectedRows(new Set());
      // Refresh the result set so the new row appears in place.
      if (lastRanQuery) {
        runQueryWith(lastRanQuery);
      }
    } catch (err) {
      setError(err.message || "Network error");
    } finally {
      setInsertSubmitting(false);
    }
  }, [
    editing,
    editable,
    pendingInsertRow,
    t,
    showSnack,
    recordEdit,
    lastRanQuery,
    runQueryWith,
  ]);

  // Drop the draft row whenever the underlying result/table changes. This
  // avoids a stale draft that no longer matches the visible columns.
  useEffect(() => {
    setPendingInsertRow(null);
  }, [editable?.table, lastRanQuery]);

  // Auto-focus the first editable input as soon as the draft row mounts.
  // Auto-focus the first editable input when the draft row is first opened.
  // The ref is attached to a single column inside SqlInsertDraftRow.
  // We guard with pendingInsertFocusedRef so that subsequent value changes
  // (updatePendingInsertValue creates a new object on every keystroke) do NOT
  // re-trigger focus — which would steal the cursor back to the first field
  // while the user is typing in any other field.
  useEffect(() => {
    if (!pendingInsertRow) {
      // Draft row closed — reset so the next open focuses again.
      pendingInsertFocusedRef.current = false;
      return;
    }
    if (pendingInsertFocusedRef.current) return; // already focused this session
    pendingInsertFocusedRef.current = true;
    const id = window.requestAnimationFrame(() => {
      try {
        pendingInsertFirstInputRef.current?.focus();
        pendingInsertFirstInputRef.current?.select?.();
      } catch {
        /* ignore */
      }
    });
    return () => window.cancelAnimationFrame(id);
  }, [pendingInsertRow]);

  /* --- derived (rows / filter / columns) ------------------------- */
  // Defined here (not at the bottom) so cell-edit / copy-menu hooks below
  // can reference allColumns without violating rules-of-hooks.
  const allRows = result?.rows || [];
  const allColumns = result?.columns || [];

  /* --- cell editing: double-click → input → PATCH --------------- */
  // Only columns listed in EDITABLE_FIELDS are editable, and only when:
  //   - we're in edit mode
  //   - the result set carries a known PK column
  //   - the column is not the PK itself (PKs are never edited inline; use
  //     a dedicated dialog with cascade tooling)
  // Cell-edit configuration: keyed by column → field-def. Excludes any column
  // listed as a PK (composite or single). PKs are never edited inline; use a
  // dedicated dialog with cascade tooling. For singleton tables (feed_info)
  // every editable field is exposed.
  const editableColumnsConfig = useMemo(() => {
    if (!cellEditableEntity || !editable?.table) return null;
    const pkSet = new Set();
    if (Array.isArray(editable.pk)) {
      for (const k of editable.pk) pkSet.add(k);
    } else if (typeof editable.pk === "string") {
      pkSet.add(editable.pk);
    }
    const fields = EDITABLE_FIELDS[editable.table] || [];
    const map = {};
    for (const f of fields) {
      if (pkSet.has(f.key)) continue;
      map[f.key] = f;
    }
    return map;
  }, [cellEditableEntity, editable]);

  const isCellEditable = useCallback(
    (column) =>
      editing &&
      Boolean(editableColumnsConfig) &&
      Object.prototype.hasOwnProperty.call(editableColumnsConfig, column),
    [editing, editableColumnsConfig],
  );

  // Keep cellInputRef focused when editing turns on.
  useEffect(() => {
    if (editingCell && cellInputRef.current) {
      try {
        cellInputRef.current.focus();
        if (typeof cellInputRef.current.select === "function") {
          cellInputRef.current.select();
        }
      } catch {
        /* ignore */
      }
    }
  }, [editingCell]);

  const beginCellEdit = useCallback(
    (row, column) => {
      if (!isCellEditable(column)) return;
      const id = pkAccessor(row);
      if (!id) return;
      const initial = row[column] == null ? "" : String(row[column]);
      setEditingCell({ rowId: id, column });
      setCellInputValue(initial);
    },
    [isCellEditable, pkAccessor],
  );

  const cancelCellEdit = useCallback(() => {
    setEditingCell(null);
    setCellInputValue("");
  }, []);

  // Apply a single-cell mutation. Two paths:
  //   1) An entry exists in PATCH_ENDPOINTS  → dedicated REST PATCH/PUT.
  //   2) The table is in SQL_FALLBACK_TABLES → POST /edit/sql with a UPDATE
  //      built from prepared composite WHERE + sqlQuote-escaped value.
  // Both paths flow through the standard logEdit pipeline so the user gets
  // an identical Ctrl+Z entry.
  const commitCellEdit = useCallback(
    async (row, column, rawValue) => {
      const entity = editable?.entity;
      const table = editable?.table;
      if (!entity || !table) return;

      // Use the cell key (id + column) for visual feedback. For composite-PK
      // and singleton tables, fall back to a stable per-row index when the
      // pkAccessor returns null (feed_info).
      const id = pkAccessor(row);
      const cellKey = `${id ?? `_row_${column}`}-${column}`;

      // No-op detection: same value → close editor without round-trip.
      const previous = row[column] == null ? "" : String(row[column]);
      if (rawValue === previous) {
        cancelCellEdit();
        return;
      }

      // Client-side validation BEFORE network round-trip. Required-empty,
      // bad time/date/url/email, out-of-range numbers, etc. are rejected
      // with a Snackbar and a brief red flash.
      const fieldDef = editableColumnsConfig?.[column];
      const validation = validateFieldValue(fieldDef, rawValue);
      if (!validation.ok) {
        setCellStatus((s) => ({ ...s, [cellKey]: "error" }));
        showSnack(t(validation.hintKey, validation.hintParams || {}));
        setTimeout(() => {
          setCellStatus((s) => {
            const next = { ...s };
            delete next[cellKey];
            return next;
          });
        }, 1200);
        return;
      }
      const payloadValue = validation.value;

      // Fan out to either REST PATCH/PUT or SQL fallback.
      const endpoint = PATCH_ENDPOINTS[entity];
      const sqlFallback = SQL_FALLBACK_TABLES[table];
      if (!endpoint && !sqlFallback) {
        showSnack(t("sqlConsole.cell.notEditable"));
        cancelCellEdit();
        return;
      }

      setCellStatus((s) => ({ ...s, [cellKey]: "saving" }));

      const flashErrorAndClear = (errMsg) => {
        setCellStatus((s) => ({ ...s, [cellKey]: "error" }));
        showSnack(
          t("sqlConsole.cell.saveError", {
            error: errMsg || t("sqlConsole.queryError"),
          }),
        );
        setTimeout(() => {
          setCellStatus((s) => {
            const next = { ...s };
            delete next[cellKey];
            return next;
          });
        }, 1200);
      };

      const flashSuccess = (validationBlock = null) => {
        recordEdit?.(
          `Updated ${entity} ${id ?? table}.${column}`,
          validationBlock,
          { entity: "sql_console", entityId: table },
        );
        setCellStatus((s) => ({ ...s, [cellKey]: "saved" }));
        setTimeout(() => {
          setCellStatus((s) => {
            const next = { ...s };
            delete next[cellKey];
            return next;
          });
        }, 800);
        cancelCellEdit();
      };

      try {
        if (endpoint) {
          // REST PATCH/PUT path
          const url = endpoint.url(row);
          if (!url) {
            flashErrorAndClear(t("sqlConsole.cell.notEditable"));
            return;
          }
          let body = { [column]: payloadValue };
          if (typeof endpoint.augmentBody === "function") {
            body = endpoint.augmentBody(row, body);
          }
          const res = await fetchWithSession(`${API_BASE_URL}${url}`, {
            method: endpoint.method || "PATCH",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify(body),
          });
          const respBody = await res.json().catch(() => ({}));
          if (!res.ok) {
            flashErrorAndClear(respBody.error);
            return;
          }
          flashSuccess(respBody.validation);
          return;
        }

        // SQL fallback (calendar_dates, shapes). Build a UPDATE with a
        // composite-PK WHERE clause; values are quoted via sqlQuote.
        const pkCols = Array.isArray(sqlFallback.pk)
          ? sqlFallback.pk
          : [sqlFallback.pk];
        const whereParts = pkCols.map((c) => `${c} = ${sqlQuote(row[c])}`);
        const valueLiteral =
          payloadValue === null
            ? "NULL"
            : typeof payloadValue === "number"
              ? String(payloadValue)
              : sqlQuote(payloadValue);
        const sql = `UPDATE ${table} SET ${column} = ${valueLiteral} WHERE ${whereParts.join(" AND ")};`;
        const res = await fetchWithSession(`${API_BASE_URL}/edit/sql`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ query: sql }),
        });
        const respBody = await res.json().catch(() => ({}));
        if (!res.ok) {
          flashErrorAndClear(respBody.error);
          return;
        }
        flashSuccess(respBody.validation);
      } catch (err) {
        flashErrorAndClear(err.message || "Network error");
      }
    },
    [
      editable,
      editableColumnsConfig,
      pkAccessor,
      cancelCellEdit,
      recordEdit,
      showSnack,
      t,
    ],
  );

  /* --- copy context menu handlers -------------------------------- */
  const closeCopyMenu = useCallback(() => setCopyMenu(null), []);

  const copyToClipboard = useCallback(
    async (text, label) => {
      try {
        await navigator.clipboard.writeText(text);
        showSnack(label || t("sqlConsole.copy.copied"));
      } catch {
        showSnack(t("sqlConsole.copy.copied"));
      }
    },
    [showSnack, t],
  );

  const handleCopyCell = useCallback(() => {
    if (!copyMenu) return;
    const v = copyMenu.row?.[copyMenu.col];
    copyToClipboard(v == null ? "" : String(v));
    closeCopyMenu();
  }, [copyMenu, copyToClipboard, closeCopyMenu]);

  const handleCopyRowJson = useCallback(() => {
    if (!copyMenu) return;
    const obj = {};
    for (const c of allColumns) obj[c] = copyMenu.row?.[c] ?? null;
    copyToClipboard(JSON.stringify(obj, null, 2));
    closeCopyMenu();
  }, [copyMenu, allColumns, copyToClipboard, closeCopyMenu]);

  const handleCopyRowCsv = useCallback(() => {
    if (!copyMenu) return;
    const csv = toCSV(allColumns, [copyMenu.row]);
    copyToClipboard(csv);
    closeCopyMenu();
  }, [copyMenu, allColumns, copyToClipboard, closeCopyMenu]);

  const handleCopyRowSql = useCallback(() => {
    if (!copyMenu) return;
    const tableName = editable?.table || "table";
    const ins = buildInsertSql(tableName, allColumns, copyMenu.row);
    copyToClipboard(ins);
    closeCopyMenu();
  }, [copyMenu, allColumns, editable, copyToClipboard, closeCopyMenu]);

  /* --- stable callbacks for SqlResultRow -------------------------
   * These must be useCallback so SqlResultRow's React.memo comparison
   * returns true across renders where only unrelated state changed.
   */

  // Bound t() helper for the "sqlConsole." prefix used inside SqlResultRow.
  // Avoids passing the full t() function whose identity may change on
  // language switch — we only need the keys used in the row component.
  const tLabel = useCallback((key) => t(`sqlConsole.${key}`), [t]);

  const handleCellContextMenu = useCallback((e, row, col) => {
    setCopyMenu({ x: e.clientX, y: e.clientY, row, col });
  }, []);

  const handleEditRowFromTable = useCallback(
    (row) => {
      setEditTarget({ entity: entityForEdit, row });
    },
    [entityForEdit],
  );

  // "Delete this row" right-click action — selects only that row then opens
  // the same confirm dialog used by the bulk delete button. This keeps the
  // single-row and bulk-delete code paths fully unified (one undo entry, one
  // cascade pipeline, one toast).
  const handleDeleteRowFromMenu = useCallback(() => {
    if (!copyMenu?.row || !canDelete) {
      // canDelete is keyed off selectedRows.size — we recompute the same
      // gate inline since the user might right-click without any selection.
      if (
        !editing ||
        !editable?.isEditable ||
        !editable?.pkPresentInColumns ||
        !editable?.pk
      ) {
        closeCopyMenu();
        return;
      }
    }
    const id = pkAccessor(copyMenu.row);
    if (!id) {
      closeCopyMenu();
      return;
    }
    setSelectedRows(new Set([id]));
    setDeleteConfirmOpen(true);
    closeCopyMenu();
  }, [copyMenu, canDelete, editing, editable, pkAccessor, closeCopyMenu]);

  // "Edit this cell" right-click action — focuses the cell and enters the
  // inline editor (same as a double-click). Available only when the column is
  // editable AND we're in edit mode.
  const handleEditCellFromMenu = useCallback(() => {
    if (!copyMenu?.row || !copyMenu?.col) return;
    beginCellEdit(copyMenu.row, copyMenu.col);
    closeCopyMenu();
  }, [copyMenu, beginCellEdit, closeCopyMenu]);

  /* --- keyboard shortcuts (always before early returns) ---------- */
  useKeyboardShortcut({
    id: "sqlConsole.run",
    keys: ["mod+enter"],
    description: t("sqlConsole.kbd.run"),
    category: "advanced",
    allowInInputs: true,
    handler: (e) => {
      e.preventDefault();
      runQuery();
    },
  });

  useKeyboardShortcut({
    id: "sqlConsole.savePreset",
    keys: ["mod+s"],
    description: t("sqlConsole.kbd.savePreset"),
    category: "advanced",
    allowInInputs: true,
    when: () => Boolean(query.trim()),
    handler: (e) => {
      e.preventDefault();
      setSavePresetName("");
      setSavePresetOpen(true);
    },
  });

  useKeyboardShortcut({
    id: "sqlConsole.clearAll",
    keys: ["mod+l"],
    description: t("sqlConsole.kbd.clearAll"),
    category: "advanced",
    allowInInputs: true,
    handler: (e) => {
      e.preventDefault();
      handleClearAll();
    },
  });

  // Ctrl+1..9 — jump to file presets. We need a STATIC number of
  // useKeyboardShortcut calls to honour the rules-of-hooks (no loop), so we
  // unroll the 9 registrations explicitly below. The handler indexes into
  // FILE_PRESET_SHORTCUTS at call time, allowing the table list to evolve
  // without changing the hook count.
  const browseByIndex = useCallback(
    (idx) => {
      const table = FILE_PRESET_SHORTCUTS[idx];
      if (table) browseFile(table);
    },
    [browseFile],
  );
  useKeyboardShortcut({
    id: "sqlConsole.file.1",
    keys: ["mod+1"],
    description: t("sqlConsole.kbd.fileJump", {
      table: FILE_PRESET_SHORTCUTS[0],
    }),
    category: "advanced",
    allowInInputs: true,
    handler: (e) => {
      e.preventDefault();
      browseByIndex(0);
    },
  });
  useKeyboardShortcut({
    id: "sqlConsole.file.2",
    keys: ["mod+2"],
    description: t("sqlConsole.kbd.fileJump", {
      table: FILE_PRESET_SHORTCUTS[1],
    }),
    category: "advanced",
    allowInInputs: true,
    handler: (e) => {
      e.preventDefault();
      browseByIndex(1);
    },
  });
  useKeyboardShortcut({
    id: "sqlConsole.file.3",
    keys: ["mod+3"],
    description: t("sqlConsole.kbd.fileJump", {
      table: FILE_PRESET_SHORTCUTS[2],
    }),
    category: "advanced",
    allowInInputs: true,
    handler: (e) => {
      e.preventDefault();
      browseByIndex(2);
    },
  });
  useKeyboardShortcut({
    id: "sqlConsole.file.4",
    keys: ["mod+4"],
    description: t("sqlConsole.kbd.fileJump", {
      table: FILE_PRESET_SHORTCUTS[3],
    }),
    category: "advanced",
    allowInInputs: true,
    handler: (e) => {
      e.preventDefault();
      browseByIndex(3);
    },
  });
  useKeyboardShortcut({
    id: "sqlConsole.file.5",
    keys: ["mod+5"],
    description: t("sqlConsole.kbd.fileJump", {
      table: FILE_PRESET_SHORTCUTS[4],
    }),
    category: "advanced",
    allowInInputs: true,
    handler: (e) => {
      e.preventDefault();
      browseByIndex(4);
    },
  });
  useKeyboardShortcut({
    id: "sqlConsole.file.6",
    keys: ["mod+6"],
    description: t("sqlConsole.kbd.fileJump", {
      table: FILE_PRESET_SHORTCUTS[5],
    }),
    category: "advanced",
    allowInInputs: true,
    handler: (e) => {
      e.preventDefault();
      browseByIndex(5);
    },
  });
  useKeyboardShortcut({
    id: "sqlConsole.file.7",
    keys: ["mod+7"],
    description: t("sqlConsole.kbd.fileJump", {
      table: FILE_PRESET_SHORTCUTS[6],
    }),
    category: "advanced",
    allowInInputs: true,
    handler: (e) => {
      e.preventDefault();
      browseByIndex(6);
    },
  });
  useKeyboardShortcut({
    id: "sqlConsole.file.8",
    keys: ["mod+8"],
    description: t("sqlConsole.kbd.fileJump", {
      table: FILE_PRESET_SHORTCUTS[7],
    }),
    category: "advanced",
    allowInInputs: true,
    handler: (e) => {
      e.preventDefault();
      browseByIndex(7);
    },
  });
  useKeyboardShortcut({
    id: "sqlConsole.file.9",
    keys: ["mod+9"],
    description: t("sqlConsole.kbd.fileJump", {
      table: FILE_PRESET_SHORTCUTS[8],
    }),
    category: "advanced",
    allowInInputs: true,
    handler: (e) => {
      e.preventDefault();
      browseByIndex(8);
    },
  });

  // "?" toggles the local SQL Console help overlay. Distinct from the
  // global ShortcutsHelpDialog: this one is scoped to SQL features only.
  useKeyboardShortcut({
    id: "sqlConsole.help",
    keys: ["shift+/"],
    description: t("sqlConsole.kbd.help"),
    category: "advanced",
    allowInInputs: false,
    handler: (e) => {
      e.preventDefault();
      setHelpOpen((v) => !v);
    },
  });

  // Mod+\ — toggle the schema sidebar (DBeaver / VSCode panel toggle).
  useKeyboardShortcut({
    id: "sqlConsole.toggleSchema",
    keys: ["mod+\\"],
    description: t("sqlConsole.kbd.toggleSchema"),
    category: "advanced",
    allowInInputs: true,
    handler: (e) => {
      e.preventDefault();
      setSchemaVisible((v) => !v);
    },
  });

  /* --- derived (filtered rows / virtual slice) ------------------- */
  const filteredRows = useMemo(() => {
    const q = debouncedFilter.trim().toLowerCase();
    if (!q) return allRows;
    return allRows.filter((row) =>
      allColumns.some((col) => {
        const v = row[col];
        return v != null && String(v).toLowerCase().includes(q);
      }),
    );
  }, [allRows, allColumns, debouncedFilter]);

  // Column sorting — single-column tri-state (asc → desc → none). Click on
  // another column resets the previous sort. Type detection reuses the same
  // column-type inference as the header chips so numbers sort numerically and
  // GTFS times/dates (HH:MM:SS, YYYYMMDD — both zero-padded) sort
  // lexicographically as expected.
  const [sortBy, setSortBy] = useState({ column: null, direction: null });

  // Reset sort when the underlying result changes (new query, cleared, …).
  // Filter changes alone don't reset — users can sort then filter.
  useEffect(() => {
    setSortBy({ column: null, direction: null });
  }, [result]);

  const handleSortColumn = useCallback((column) => {
    setSortBy((prev) => {
      if (prev.column !== column) return { column, direction: "asc" };
      if (prev.direction === "asc") return { column, direction: "desc" };
      // 3rd click on the same column clears the sort.
      return { column: null, direction: null };
    });
  }, []);

  const sortedRows = useMemo(() => {
    if (!sortBy.column || !sortBy.direction) return filteredRows;
    const col = sortBy.column;
    const dir = sortBy.direction === "desc" ? -1 : 1;
    const colType = inferColumnType(filteredRows, col);
    const isNumeric = colType === "INTEGER" || colType === "REAL";
    const collator = new Intl.Collator(undefined, {
      numeric: true,
      sensitivity: "base",
    });
    // Copy before sort — useMemo result must not mutate filteredRows.
    const out = filteredRows.slice();
    out.sort((a, b) => {
      const va = a?.[col];
      const vb = b?.[col];
      const aEmpty = va == null || va === "";
      const bEmpty = vb == null || vb === "";
      // NULL/empty always sink to the bottom regardless of direction.
      if (aEmpty && bEmpty) return 0;
      if (aEmpty) return 1;
      if (bEmpty) return -1;
      let cmp;
      if (isNumeric) {
        const na = Number(va);
        const nb = Number(vb);
        cmp = na - nb;
        // Fallback to string compare if NaN sneaks in (mixed-type column).
        if (Number.isNaN(cmp)) cmp = collator.compare(String(va), String(vb));
      } else {
        cmp = collator.compare(String(va), String(vb));
      }
      return cmp * dir;
    });
    return out;
  }, [filteredRows, sortBy.column, sortBy.direction]);

  // Incremental render: initially show VIRT_PAGE rows, expand by VIRT_PAGE
  // on each near-bottom scroll event. This avoids mounting 15 000+ DOM nodes
  // for a 1000 row × 15 col result while keeping full scroll semantics.
  const VIRT_PAGE = 200;
  const [renderedCount, setRenderedCount] = useState(VIRT_PAGE);

  // Reset rendered window whenever the underlying data changes (new query,
  // new filter, result cleared, sort applied).
  useEffect(() => {
    setRenderedCount(VIRT_PAGE);
  }, [sortedRows]);

  const visibleRows = useMemo(
    () => sortedRows.slice(0, renderedCount),
    [sortedRows, renderedCount],
  );

  // Ref for the scrollable container so we can attach the scroll handler.
  const tableScrollRef = useRef(null);

  const handleTableScroll = useCallback(() => {
    const el = tableScrollRef.current;
    if (!el) return;
    // Load more when within 120 px of the bottom
    if (el.scrollHeight - el.scrollTop - el.clientHeight < 120) {
      setRenderedCount((prev) => Math.min(prev + VIRT_PAGE, sortedRows.length));
    }
  }, [sortedRows.length]);

  const schemaTables = useMemo(
    () =>
      schema?.tables
        ? [...schema.tables].sort((a, b) => a.name.localeCompare(b.name))
        : [],
    [schema],
  );

  // Filtered table list for the sidebar search box. Matches both the table
  // name and any of its column names so a user typing "headsign" finds the
  // trips table even though the table name doesn't contain it.
  const filteredSchemaTables = useMemo(() => {
    const q = schemaSearch.trim().toLowerCase();
    if (!q) return schemaTables;
    return schemaTables.filter((tbl) => {
      if (tbl.name.toLowerCase().includes(q)) return true;
      return (tbl.columns || []).some((c) => c.name.toLowerCase().includes(q));
    });
  }, [schemaTables, schemaSearch]);

  /* --- match active file chip ------------------------------------ */
  const activeBrowseTable = useMemo(() => {
    if (!query) return null;
    const m = /^\s*select\s+\*\s+from\s+([A-Za-z_]+)\s*;?\s*$/i.exec(query);
    return m ? m[1].toLowerCase() : null;
  }, [query]);

  /* --- render helpers -------------------------------------------- */
  // Modernised browse chip strip: pill shape, hover lift, glow on active,
  // monospace count badge inside the chip.
  const renderBrowseChips = (files = BROWSE_FILES) => {
    return files.map((f) => {
      const count = counts?.[f.table] ?? 0;
      const present = count > 0;
      const isActive = activeBrowseTable === f.table;
      const dotColor = present
        ? theme.palette.success.main
        : alpha(theme.palette.text.disabled, 0.5);
      return (
        <Box
          key={f.table}
          component="button"
          type="button"
          className={`sql-browse-chip${
            !present ? " sql-browse-chip--disabled" : ""
          }`}
          disabled={!present}
          onClick={present ? () => browseFile(f.table) : undefined}
          sx={{
            display: "inline-flex",
            alignItems: "center",
            gap: 0.5,
            height: 24,
            px: 1,
            borderRadius: 999,
            border: `1px solid ${
              isActive ? "transparent" : alpha(theme.palette.text.primary, 0.12)
            }`,
            background: isActive
              ? theme.palette.primary.main
              : alpha(theme.palette.background.paper, 0.6),
            color: isActive
              ? theme.palette.primary.contrastText
              : present
                ? theme.palette.text.primary
                : theme.palette.text.disabled,
            cursor: present ? "pointer" : "not-allowed",
            opacity: present ? 1 : 0.5,
            fontFamily: MONO_FONT,
            fontSize: 11.5,
            fontWeight: 600,
            outline: "none",
            boxShadow: isActive
              ? `0 0 0 1px ${alpha(theme.palette.primary.main, 0.3)}, 0 1px 3px ${alpha(
                  theme.palette.primary.main,
                  0.25,
                )}`
              : "none",
            "&:hover:not(:disabled)": {
              background: isActive
                ? theme.palette.primary.main
                : alpha(theme.palette.text.primary, 0.04),
              boxShadow: isActive
                ? `0 0 0 1px ${alpha(theme.palette.primary.main, 0.4)}, 0 2px 6px ${alpha(
                    theme.palette.primary.main,
                    0.3,
                  )}`
                : `0 1px 3px ${alpha(theme.palette.text.primary, 0.08)}`,
            },
            "&:focus-visible": {
              outline: `2px solid ${theme.palette.primary.main}`,
              outlineOffset: 2,
            },
          }}
        >
          <Box
            component="span"
            sx={{
              width: 6,
              height: 6,
              borderRadius: "50%",
              background: isActive
                ? alpha(theme.palette.primary.contrastText, 0.85)
                : dotColor,
              flexShrink: 0,
            }}
          />
          <span style={{ fontWeight: 700 }}>{f.table}</span>
          <span
            style={{
              fontSize: 10,
              opacity: isActive ? 0.85 : 0.6,
              fontWeight: 600,
            }}
          >
            {formatHumanCount(count)}
          </span>
        </Box>
      );
    });
  };

  return (
    <>
      {/* Global styles for SqlResultRow: keyframes + editable-cell hover.
        All animations use CSS transitions/keyframes (no JS animation libs).
        Pulse/shimmer/flash are GPU-accelerated (transform/opacity only). */}
      <GlobalStyles
        styles={{
          "@keyframes spin": { to: { transform: "rotate(360deg)" } },
          "@keyframes sqlPulseDot": {
            "0%, 100%": { opacity: 1, transform: "scale(1)" },
            "50%": { opacity: 0.55, transform: "scale(0.9)" },
          },
          "@keyframes sqlPulseRun": {
            "0%, 100%": { boxShadow: "0 0 0 0 rgba(99,102,241,0.5)" },
            "50%": { boxShadow: "0 0 0 4px rgba(99,102,241,0)" },
          },
          "@keyframes sqlFlashSaved": {
            "0%": { backgroundColor: "rgba(34,197,94,0.18)" },
            "100%": { backgroundColor: "transparent" },
          },
          "@keyframes sqlFlashError": {
            "0%": { backgroundColor: "rgba(239,68,68,0.22)" },
            "20%": { transform: "translateX(-2px)" },
            "40%": { transform: "translateX(2px)" },
            "60%": { transform: "translateX(-1px)" },
            "100%": {
              backgroundColor: "transparent",
              transform: "translateX(0)",
            },
          },
          "@keyframes sqlShimmer": {
            "0%": { backgroundPosition: "-200px 0" },
            "100%": { backgroundPosition: "calc(200px + 100%) 0" },
          },
          "@keyframes sqlSlideIn": {
            from: { opacity: 0, transform: "translateY(-4px)" },
            to: { opacity: 1, transform: "translateY(0)" },
          },
          "@keyframes sqlSlideInLeft": {
            from: { opacity: 0, transform: "translateX(-12px)" },
            to: { opacity: 1, transform: "translateX(0)" },
          },
          ".sql-cell-editable:hover": {
            boxShadow: "inset 0 0 0 1px rgba(99,102,241,0.35) !important",
            backgroundColor: "rgba(99,102,241,0.04) !important",
          },
          ".sql-browse-chip": {
            transition:
              "transform 150ms ease, box-shadow 150ms ease, background-color 150ms ease, color 150ms ease",
          },
          ".sql-browse-chip:hover:not(.sql-browse-chip--disabled)": {
            transform: "translateY(-1px)",
          },
        }}
      />
      <Paper
        elevation={0}
        sx={{
          flex: 1,
          display: "flex",
          flexDirection: "column",
          minHeight: 0,
          height: "100%",
          background: theme.palette.background.default,
          border: `1px solid ${theme.palette.divider}`,
          borderTop: "none",
          borderRadius: 0,
          // overflow:hidden is mandatory: the inner row (sidebar + results)
          // owns its own scroll viewports via flex:1 + minHeight:0 cascading.
          overflow: "hidden",
        }}
      >
        {/* ---------- Top header bar (zone identity + mode + metrics) ----
          36px tall, surfaceAlt fill, divider-bottom separator. Carries the
          console identity (icon + title), edit/read-only mode badge, a
          discrete tables/rows breadcrumb, the live last-query metric, and
          the keyboard-help affordance. Real "row count / duration / select"
          metrics for the active result live in the bottom toolbar — this
          top strip is purely about *console mode* and *feed-level scale*. */}
        <Box
          sx={{
            px: 1.5,
            height: 36,
            display: "flex",
            alignItems: "center",
            gap: 1,
            borderBottom: `1px solid ${theme.palette.divider}`,
            background: alpha(
              theme.palette.text.primary,
              isDark ? 0.04 : 0.025,
            ),
            flexShrink: 0,
          }}
        >
          <StorageIcon
            sx={{
              fontSize: 14,
              color: theme.palette.primary.main,
              flexShrink: 0,
            }}
          />
          <Typography
            sx={{
              fontWeight: 700,
              letterSpacing: "0.06em",
              textTransform: "uppercase",
              fontSize: 11,
              color: theme.palette.text.primary,
            }}
          >
            {t("sqlConsole.title")}
          </Typography>
          <Divider
            orientation="vertical"
            flexItem
            sx={{
              my: 0.75,
              borderColor: theme.palette.divider,
            }}
          />
          {/* Mode badge: gray READ-ONLY or warning EDIT MODE with pulsing dot */}
          <Box
            sx={{
              display: "inline-flex",
              alignItems: "center",
              gap: 0.5,
              height: 20,
              px: 0.75,
              borderRadius: 0.75,
              fontSize: 10,
              fontWeight: 700,
              letterSpacing: "0.05em",
              textTransform: "uppercase",
              fontFamily: MONO_FONT,
              background: editing
                ? alpha(theme.palette.warning.main, 0.14)
                : alpha(theme.palette.text.primary, 0.06),
              color: editing
                ? theme.palette.warning.main
                : theme.palette.text.secondary,
              border: `1px solid ${
                editing
                  ? alpha(theme.palette.warning.main, 0.3)
                  : alpha(theme.palette.text.primary, 0.08)
              }`,
            }}
          >
            {editing && (
              <Box
                component="span"
                sx={{
                  width: 6,
                  height: 6,
                  borderRadius: "50%",
                  background: theme.palette.warning.main,
                  animation: "sqlPulseDot 1.4s ease-in-out infinite",
                }}
              />
            )}
            {editing ? t("sqlConsole.modeEdit") : t("sqlConsole.modeReadOnly")}
          </Box>
          {/* Subtle breadcrumb: tables · rows */}
          {schemaTables.length > 0 && (
            <Typography
              sx={{
                fontSize: 11,
                color: theme.palette.text.disabled,
                fontFamily: MONO_FONT,
                fontVariantNumeric: "tabular-nums",
                ml: 0.25,
                display: { xs: "none", sm: "inline" },
              }}
            >
              {t("sqlConsole.statusBar.tablesSummary", {
                tables: schemaTables.length,
                rows: formatHumanCount(
                  Object.values(counts || {}).reduce(
                    (acc, n) => acc + (n || 0),
                    0,
                  ),
                ),
              })}
            </Typography>
          )}
          <Box flex={1} />
          {/* Live last-query metric */}
          {result && typeof result.duration_ms === "number" && (
            <Box
              sx={{
                display: "inline-flex",
                alignItems: "center",
                gap: 0.5,
                fontSize: 10.5,
                fontFamily: MONO_FONT,
                fontVariantNumeric: "tabular-nums",
                color: theme.palette.text.secondary,
                fontWeight: 600,
              }}
            >
              <Box
                component="span"
                sx={{
                  width: 5,
                  height: 5,
                  borderRadius: "50%",
                  background: theme.palette.success.main,
                  opacity: 0.8,
                }}
              />
              {`${result.duration_ms}ms · ${formatRowCount(allRows.length)} ${
                result.truncated ? "· truncated@10000" : ""
              }`}
            </Box>
          )}
          <Tooltip
            title={t("sqlConsole.kbd.help")}
            arrow
            placement="bottom-end"
          >
            <IconButton
              size="small"
              onClick={() => setHelpOpen(true)}
              aria-label={t("sqlConsole.kbd.help")}
              sx={{
                width: 22,
                height: 22,
                fontSize: 11,
                color: theme.palette.text.secondary,
              }}
            >
              <Box
                component="span"
                sx={{
                  fontFamily: MONO_FONT,
                  fontWeight: 700,
                  fontSize: 12,
                  lineHeight: 1,
                }}
              >
                ?
              </Box>
            </IconButton>
          </Tooltip>
        </Box>

        {/* ---------- Browse files / Query library strip ----------
          Compact row with two related affordances side-by-side: 1-click
          chips per GTFS table (left) and the saved/built-in preset library
          (right). Sits on the surfaceAlt background to read as a single
          "browse" zone, separated from the editor below by a divider. */}
        <Box
          sx={{
            px: 2,
            pt: 1,
            pb: 0.75,
            background: alpha(
              theme.palette.text.primary,
              isDark ? 0.025 : 0.015,
            ),
            borderBottom: `1px solid ${theme.palette.divider}`,
          }}
        >
          <Box
            sx={{
              display: "flex",
              alignItems: "center",
              gap: 1.25,
              mb: 0.5,
            }}
          >
            <Typography
              variant="caption"
              sx={{
                fontSize: 10,
                fontWeight: 700,
                letterSpacing: "0.08em",
                textTransform: "uppercase",
                color: theme.palette.text.disabled,
              }}
            >
              {t("sqlConsole.browseFiles")}
            </Typography>
            <Box flex={1} />
            <Button
              size="small"
              startIcon={<MenuBookIcon sx={{ fontSize: "14px !important" }} />}
              endIcon={
                <ArrowDropDownIcon sx={{ fontSize: "16px !important" }} />
              }
              onClick={(e) => {
                setPresetLibraryAnchor(e.currentTarget);
                setActivePresetGroup(PRESET_QUERIES[0].groupId);
              }}
              aria-haspopup="true"
              aria-expanded={Boolean(presetLibraryAnchor)}
              sx={{
                fontSize: 11,
                height: 24,
                textTransform: "none",
                px: 1,
                color: theme.palette.text.secondary,
                border: `1px solid ${alpha(theme.palette.text.primary, 0.12)}`,
                borderRadius: 1,
                gap: 0,
                "&:hover": {
                  background: alpha(theme.palette.text.primary, 0.04),
                  borderColor: alpha(theme.palette.text.primary, 0.22),
                },
              }}
            >
              {t("sqlConsole.presetLibrary")}
              {userPresets.length > 0 && (
                <Box
                  component="span"
                  sx={{
                    ml: 0.75,
                    display: "inline-flex",
                    alignItems: "center",
                    justifyContent: "center",
                    minWidth: 16,
                    height: 16,
                    px: 0.5,
                    borderRadius: "8px",
                    background: theme.palette.warning.main,
                    color: theme.palette.warning.contrastText,
                    fontSize: 9,
                    fontWeight: 700,
                    lineHeight: 1,
                  }}
                >
                  {userPresets.length}
                </Box>
              )}
            </Button>
          </Box>
          {(() => {
            const visibleGroupCount = BROWSE_GROUPS.filter(
              (g, i) =>
                i === 0 || g.files.some((f) => (counts?.[f.table] ?? 0) > 0),
            ).length;
            return BROWSE_GROUPS.map((group, idx) => {
              // Always show the Schedule group. Extension groups stay hidden
              // until the session DB has at least one row in any of their
              // tables — keeps the strip uncluttered for plain Schedule feeds.
              const groupHasData = group.files.some(
                (f) => (counts?.[f.table] ?? 0) > 0,
              );
              if (idx > 0 && !groupHasData) return null;
              return (
                <Box
                  key={group.id}
                  sx={{
                    mt: idx === 0 ? 0 : 0.75,
                    display: "flex",
                    alignItems: "flex-start",
                    gap: 1,
                  }}
                >
                  {visibleGroupCount > 1 && (
                    <Typography
                      variant="caption"
                      sx={{
                        flexShrink: 0,
                        minWidth: 56,
                        pt: "4px",
                        fontSize: 9.5,
                        fontWeight: 700,
                        letterSpacing: "0.06em",
                        textTransform: "uppercase",
                        color: theme.palette.text.disabled,
                      }}
                    >
                      {t(group.labelKey)}
                    </Typography>
                  )}
                  <Box
                    sx={{
                      flex: 1,
                      display: "flex",
                      flexWrap: "wrap",
                      gap: "6px",
                    }}
                  >
                    {renderBrowseChips(group.files)}
                  </Box>
                </Box>
              );
            });
          })()}
        </Box>

        {/* ---------- NL2SQL popover (beta, kill-switched server-side) ----------
          The popover is anchored on a sparkles IconButton in the editor
          toolbar (see below). Rendering nothing when `nl2sqlAnchor` is null
          means zero DOM cost and zero vertical space lost above the editor.
          We mount the component itself only when the server flag is on so
          we never flash a button that would 503 on click — the toolbar
          IconButton lives behind the same `serverFeatures?.nl2sql?.enabled`
          gate.

          The generated SQL is INSERTED into the editor, never auto-run —
          the user reviews and clicks Run on their own. This is a UX
          guarantee (no surprise mutations) and a legal one (the user is
          always the actor of any DB change). */}
        {serverFeatures?.nl2sql?.enabled && (
          <>
            <NL2SQLPanel
              anchorEl={nl2sqlAnchor}
              onClose={() => setNl2sqlAnchor(null)}
              onInsertSql={(sql) => {
                setQuery(sql);
                setNl2sqlAnchor(null);
              }}
              currentMode={editing ? "edit" : "read"}
            />
            <BetaGateDialog
              open={nl2sqlBetaOpen}
              onClose={() => setNl2sqlBetaOpen(false)}
              onSubmit={handleNl2sqlGateSubmit}
              bodyKey="beta.bodyNl2sql"
            />
          </>
        )}

        {/* ---------- Query editor (CodeMirror 6, lazy-loaded) ----------
          Editor + its action toolbar share one container. Padding is
          explicit so the splitter (mx: -2) reaches parent edges. The
          borderBottom separates this zone from the results area below. */}
        <Box
          sx={{
            px: 2,
            pt: 0.75,
            borderBottom: `1px solid ${theme.palette.divider}`,
            flexShrink: 0,
          }}
        >
          <Suspense
            fallback={
              <TextField
                inputRef={textareaRef}
                multiline
                minRows={5}
                maxRows={12}
                fullWidth
                value={query}
                onChange={(e) => setQuery(e.target.value)}
                placeholder="SELECT * FROM stops LIMIT 100;"
                slotProps={{
                  htmlInput: {
                    style: {
                      fontFamily: MONO_FONT,
                      fontSize: 13,
                      lineHeight: 1.5,
                    },
                    spellCheck: false,
                    "aria-label": t("sqlConsole.title"),
                  },
                }}
                sx={{
                  "& .MuiOutlinedInput-root": {
                    background: isDark
                      ? alpha(theme.palette.common.black, 0.25)
                      : alpha(theme.palette.common.black, 0.02),
                  },
                }}
              />
            }
          >
            <CodeMirrorQueryEditor
              ref={cmEditorRef}
              value={query}
              onChange={setQuery}
              onRunQuery={runQuery}
              onSavePreset={() => {
                if (!query.trim()) return;
                setSavePresetName("");
                setSavePresetOpen(true);
              }}
              onClearAll={handleClearAll}
              schemaTables={schemaTables}
              isDarkMode={isDark}
              height={`${editorHeight}px`}
              placeholder={t("sqlConsole.title")}
              errorLine={errorLine}
            />
          </Suspense>
          {/* Resizable splitter handle (4px line, 2px hit zone padding) */}
          <Tooltip title={t("sqlConsole.resize.tooltip")} arrow placement="top">
            <Box
              role="separator"
              aria-orientation="horizontal"
              aria-label={t("sqlConsole.resize.tooltip")}
              onMouseDown={handleSplitterMouseDown}
              sx={{
                height: 4,
                mx: -2,
                cursor: "row-resize",
                transition: "background-color 150ms ease",
                background: "transparent",
                position: "relative",
                "&:hover": {
                  background: alpha(theme.palette.primary.main, 0.18),
                },
                "&::after": {
                  content: '""',
                  position: "absolute",
                  left: "50%",
                  top: "50%",
                  transform: "translate(-50%, -50%)",
                  width: 28,
                  height: 2,
                  borderRadius: 2,
                  background: alpha(theme.palette.text.primary, 0.18),
                  opacity: 0,
                  transition: "opacity 150ms ease",
                },
                "&:hover::after": { opacity: 1 },
              }}
            />
          </Tooltip>
          {/* Editor toolbar — primary action stands out (height 32 to match
            secondary buttons), secondary actions grouped after a vertical
            divider, all with kbd-badge tooltips. Sits flush with the
            CodeMirror surface, separated from the next zone (results) by
            a borderBottom on the parent block. */}
          <Box
            sx={{
              display: "flex",
              alignItems: "center",
              gap: 0.5,
              mt: 0.75,
              mb: 0.5,
              flexWrap: "wrap",
              minHeight: 32,
            }}
          >
            <Button
              variant="contained"
              color="primary"
              onClick={runQuery}
              disabled={running || !query.trim()}
              data-testid="sql-run"
              startIcon={
                running ? (
                  <CircularProgress size={14} color="inherit" />
                ) : (
                  <PlayArrowIcon />
                )
              }
              sx={{
                height: 32,
                px: 1.5,
                fontWeight: 700,
                letterSpacing: "0.02em",
                textTransform: "none",
                boxShadow: "none",
                animation: running
                  ? "sqlPulseRun 1.2s ease-in-out infinite"
                  : "none",
                "&:hover": { boxShadow: "none" },
              }}
            >
              {running ? t("sqlConsole.running") : t("sqlConsole.run")}
              <Kbd
                sx={{
                  ml: 1,
                  background: (th) =>
                    alpha(th.palette.primary.contrastText, 0.18),
                  border: (th) =>
                    `1px solid ${alpha(th.palette.primary.contrastText, 0.25)}`,
                  color: (th) => alpha(th.palette.primary.contrastText, 0.85),
                }}
              >
                ⌘↵
              </Kbd>
            </Button>
            <Tooltip title={t("sqlConsole.format")} arrow>
              <span>
                <Button
                  variant="outlined"
                  size="small"
                  onClick={handleFormat}
                  disabled={!query.trim()}
                  startIcon={<FormatAlignLeftIcon fontSize="small" />}
                  sx={{
                    height: 32,
                    textTransform: "none",
                    borderColor: alpha(theme.palette.text.primary, 0.12),
                    color: theme.palette.text.primary,
                    "&:hover": {
                      borderColor: alpha(theme.palette.text.primary, 0.22),
                      background: alpha(theme.palette.text.primary, 0.04),
                    },
                  }}
                >
                  {t("sqlConsole.format")}
                </Button>
              </span>
            </Tooltip>
            <Divider
              orientation="vertical"
              flexItem
              sx={{
                mx: 0.5,
                my: 0.5,
                borderColor: theme.palette.divider,
              }}
            />
            {/* NL2SQL trigger — sparkles IconButton anchoring the Popover.
              Same gate as the Popover itself: only mount when the server
              feature flag resolves to enabled (off by default). The
              `aria-pressed` mirrors the open state for screen readers. */}
            {serverFeatures?.nl2sql?.enabled && (
              <>
                <Tooltip title={t("nl2sql.title")} arrow>
                  <IconButton
                    size="small"
                    ref={nl2sqlTriggerRef}
                    onClick={(e) => {
                      if (nl2sqlAnchor) {
                        setNl2sqlAnchor(null);
                        return;
                      }
                      const code = readBetaCode();
                      if (code) {
                        setNl2sqlAnchor(e.currentTarget);
                      } else {
                        nl2sqlButtonRef.current = e.currentTarget;
                        setNl2sqlBetaOpen(true);
                      }
                    }}
                    aria-label={t("nl2sql.title")}
                    aria-pressed={Boolean(nl2sqlAnchor)}
                    sx={{
                      width: 32,
                      height: 32,
                      color: nl2sqlAnchor ? "#fff" : "#C9A84C",
                      background: nl2sqlAnchor
                        ? "#C9A84C"
                        : alpha("#C9A84C", 0.1),
                      border: `1px solid ${alpha("#C9A84C", 0.35)}`,
                      borderRadius: "6px",
                      transition:
                        "background-color 150ms ease, color 150ms ease, border-color 150ms ease",
                      "&:hover": {
                        background: nl2sqlAnchor
                          ? alpha("#C9A84C", 0.85)
                          : alpha("#C9A84C", 0.2),
                        borderColor: alpha("#C9A84C", 0.55),
                      },
                    }}
                  >
                    <AutoAwesomeIcon fontSize="small" />
                  </IconButton>
                </Tooltip>
                <Divider
                  orientation="vertical"
                  flexItem
                  sx={{
                    mx: 0.5,
                    my: 0.5,
                    borderColor: theme.palette.divider,
                  }}
                />
              </>
            )}
            <Tooltip
              title={
                <Box sx={{ display: "inline-flex", alignItems: "center" }}>
                  {t("sqlConsole.history")}
                </Box>
              }
              arrow
            >
              <span>
                <IconButton
                  size="small"
                  onClick={(e) => setHistoryAnchor(e.currentTarget)}
                  disabled={history.length === 0}
                  aria-label={t("sqlConsole.history")}
                  sx={{ width: 32, height: 32 }}
                >
                  <HistoryIcon fontSize="small" />
                </IconButton>
              </span>
            </Tooltip>
            <Tooltip
              title={
                <Box sx={{ display: "inline-flex", alignItems: "center" }}>
                  {t("sqlConsole.schema.toggle")}
                  <Kbd>⌘\</Kbd>
                </Box>
              }
              arrow
            >
              <span>
                <IconButton
                  size="small"
                  onClick={() => setSchemaVisible((v) => !v)}
                  aria-label={t("sqlConsole.schema.toggle")}
                  aria-pressed={schemaVisible}
                  sx={{
                    width: 32,
                    height: 32,
                    background: schemaVisible
                      ? alpha(theme.palette.primary.main, 0.12)
                      : "transparent",
                    color: schemaVisible
                      ? theme.palette.primary.main
                      : theme.palette.text.secondary,
                    transition: "background-color 150ms ease, color 150ms ease",
                    "&:hover": {
                      background: schemaVisible
                        ? alpha(theme.palette.primary.main, 0.18)
                        : alpha(theme.palette.text.primary, 0.06),
                    },
                  }}
                >
                  <SchemaIcon fontSize="small" />
                </IconButton>
              </span>
            </Tooltip>
            <Tooltip
              title={
                <Box sx={{ display: "inline-flex", alignItems: "center" }}>
                  {t("sqlConsole.savePreset")}
                  <Kbd>⌘S</Kbd>
                </Box>
              }
              arrow
            >
              <span>
                <IconButton
                  size="small"
                  onClick={() => {
                    setSavePresetName("");
                    setSavePresetOpen(true);
                  }}
                  disabled={!query.trim()}
                  aria-label={t("sqlConsole.savePreset")}
                  sx={{ width: 32, height: 32 }}
                >
                  <StarBorderIcon fontSize="small" />
                </IconButton>
              </span>
            </Tooltip>
            <Tooltip
              title={
                <Box sx={{ display: "inline-flex", alignItems: "center" }}>
                  {t("sqlConsole.clearAll")}
                  <Kbd>⌘L</Kbd>
                </Box>
              }
              arrow
            >
              <span>
                <IconButton
                  size="small"
                  onClick={handleClearAll}
                  aria-label={t("sqlConsole.clearAll")}
                  disabled={!query.trim() && !result}
                  sx={{ width: 32, height: 32 }}
                >
                  <ClearIcon fontSize="small" />
                </IconButton>
              </span>
            </Tooltip>
            <Box flex={1} />
            {/* Inline autocomplete hint — pushed to the right of the toolbar
              so it occupies otherwise-empty space and doesn't add a row. */}
            <Typography
              variant="caption"
              sx={{
                fontSize: 10,
                color: theme.palette.text.disabled,
                fontFamily: MONO_FONT,
                userSelect: "none",
                display: { xs: "none", md: "inline" },
                mr: result ? 0.5 : 0,
              }}
            >
              {t("sqlConsole.editor.autocomplete")}
            </Typography>
            {result && (
              <Tooltip title={t("sqlConsole.exportCsv")} arrow>
                <IconButton
                  size="small"
                  onClick={exportCSV}
                  aria-label={t("sqlConsole.exportCsv")}
                  sx={{ width: 32, height: 32 }}
                >
                  <DownloadIcon fontSize="small" />
                </IconButton>
              </Tooltip>
            )}
          </Box>
        </Box>

        {/* History menu */}
        <Menu
          anchorEl={historyAnchor}
          open={Boolean(historyAnchor)}
          onClose={() => setHistoryAnchor(null)}
          slotProps={{
            paper: {
              sx: { minWidth: 360, maxWidth: 520, maxHeight: 400 },
            },
          }}
        >
          <Box sx={{ px: 1.5, py: 0.5, display: "flex", alignItems: "center" }}>
            <Typography
              variant="caption"
              sx={{
                fontWeight: 700,
                letterSpacing: "0.06em",
                textTransform: "uppercase",
                color: theme.palette.text.secondary,
              }}
            >
              {t("sqlConsole.history")}
            </Typography>
            <Box flex={1} />
            {history.length > 0 && (
              <Button size="small" onClick={handleClearHistory}>
                {t("sqlConsole.historyClear")}
              </Button>
            )}
          </Box>
          <Divider />
          {history.length === 0 ? (
            <MenuItem disabled>
              <Typography variant="caption">
                {t("sqlConsole.historyEmpty")}
              </Typography>
            </MenuItem>
          ) : (
            history.map((h) => (
              <MenuItem
                key={h.ts}
                onClick={() => {
                  setQuery(h.query);
                  setHistoryAnchor(null);
                }}
                sx={{ display: "block", py: 0.5 }}
              >
                <Typography
                  variant="caption"
                  sx={{
                    display: "block",
                    fontSize: 10,
                    color: theme.palette.text.secondary,
                    fontWeight: 600,
                  }}
                >
                  {formatRelative(h.ts, t)}
                </Typography>
                <Typography
                  variant="body2"
                  sx={{
                    fontFamily: MONO_FONT,
                    fontSize: 11.5,
                    whiteSpace: "nowrap",
                    overflow: "hidden",
                    textOverflow: "ellipsis",
                    maxWidth: 480,
                  }}
                >
                  {h.query.length > 80 ? `${h.query.slice(0, 80)}…` : h.query}
                </Typography>
              </MenuItem>
            ))
          )}
        </Menu>

        {/* ================================================================
          Preset Library — rich two-column Popover
          ╔══════════════════════════════════════════════════════╗
          ║  🔖 Query Library          [ 🔍 search…          ]  ║
          ╠══════════════╦═══════════════════════════════════════╣
          ║ ▌ Network  7 ║  Route · trip count                   ║
          ║   Quality 12 ║    SELECT r.route_id …   (on hover)   ║
          ║   Topology 4 ║  Routes per agency                    ║
          ║  ★ Saved   2 ║  …                                    ║
          ╚══════════════╩═══════════════════════════════════════╝
         ================================================================ */}
        <Popover
          open={Boolean(presetLibraryAnchor)}
          anchorEl={presetLibraryAnchor}
          onClose={() => {
            setPresetLibraryAnchor(null);
            setPresetSearch("");
          }}
          anchorOrigin={{ horizontal: "left", vertical: "bottom" }}
          transformOrigin={{ horizontal: "left", vertical: "top" }}
          PaperProps={{
            elevation: 6,
            sx: {
              width: 560,
              height: 440,
              display: "flex",
              flexDirection: "column",
              overflow: "hidden",
              mt: 0.5,
              border: `1px solid ${theme.palette.divider}`,
              borderRadius: 1.5,
            },
          }}
        >
          {/* ── Header ─────────────────────────────────────────────── */}
          <Box
            sx={{
              px: 2,
              py: 0.75,
              display: "flex",
              alignItems: "center",
              gap: 1,
              borderBottom: `1px solid ${theme.palette.divider}`,
              flexShrink: 0,
              background: alpha(theme.palette.text.primary, 0.02),
            }}
          >
            <MenuBookIcon
              sx={{ fontSize: 14, color: theme.palette.text.secondary }}
            />
            <Typography
              variant="caption"
              sx={{
                fontWeight: 700,
                letterSpacing: "0.07em",
                textTransform: "uppercase",
                fontSize: 10,
                color: theme.palette.text.secondary,
              }}
            >
              {t("sqlConsole.presetLibrary")}
            </Typography>
            <Box flex={1} />
            <TextField
              size="small"
              placeholder={t("sqlConsole.presetSearch")}
              value={presetSearch}
              onChange={(e) => setPresetSearch(e.target.value)}
              autoComplete="off"
              slotProps={{
                input: {
                  startAdornment: (
                    <InputAdornment position="start">
                      <SearchIcon
                        sx={{
                          fontSize: 13,
                          color: theme.palette.text.disabled,
                        }}
                      />
                    </InputAdornment>
                  ),
                },
              }}
              sx={{
                width: 175,
                "& .MuiInputBase-input": { fontSize: 11.5, py: "3.5px" },
                "& .MuiOutlinedInput-root": { height: 26, borderRadius: 1 },
              }}
            />
          </Box>

          {/* ── Body ────────────────────────────────────────────────── */}
          {presetSearch.trim() ? (
            /* ── Flat search results (all groups) ── */
            <Box sx={{ flex: 1, overflowY: "auto", py: 0.5 }}>
              {(() => {
                const q = presetSearch.trim().toLowerCase();
                const hits = presetGroups.flatMap((g) =>
                  g.items
                    .filter((p) => t(p.labelKey).toLowerCase().includes(q))
                    .map((p) => ({ ...p, groupLabelKey: g.groupLabelKey })),
                );
                if (hits.length === 0)
                  return (
                    <Typography
                      variant="caption"
                      sx={{
                        px: 2.5,
                        py: 1.5,
                        display: "block",
                        color: theme.palette.text.disabled,
                      }}
                    >
                      {t("sqlConsole.schema.empty")}
                    </Typography>
                  );
                return hits.map((p) => (
                  <Box
                    key={p.id}
                    onClick={() => {
                      insertPreset(p.sql, false);
                      setPresetLibraryAnchor(null);
                      setPresetSearch("");
                    }}
                    sx={{
                      px: 2.5,
                      py: 0.7,
                      cursor: "pointer",
                      display: "flex",
                      alignItems: "flex-start",
                      gap: 1.5,
                      "&:hover": {
                        background: alpha(theme.palette.primary.main, 0.06),
                      },
                    }}
                  >
                    <Box flex={1} sx={{ minWidth: 0 }}>
                      <Typography
                        variant="body2"
                        sx={{ fontSize: 12.5, lineHeight: 1.3 }}
                      >
                        {t(p.labelKey)}
                      </Typography>
                    </Box>
                    <Chip
                      label={t(p.groupLabelKey)}
                      size="small"
                      sx={{
                        height: 16,
                        fontSize: 9,
                        flexShrink: 0,
                        mt: 0.3,
                        "& .MuiChip-label": { px: 0.75 },
                      }}
                    />
                  </Box>
                ));
              })()}
            </Box>
          ) : (
            /* ── Two-column layout ── */
            <Box sx={{ flex: 1, display: "flex", minHeight: 0 }}>
              {/* Left rail — group tabs */}
              <Box
                sx={{
                  width: 152,
                  flexShrink: 0,
                  borderRight: `1px solid ${theme.palette.divider}`,
                  overflowY: "auto",
                  py: 0.5,
                  background: alpha(theme.palette.text.primary, 0.015),
                }}
              >
                {presetGroups.map((group) => {
                  const GroupIcon = GROUP_ICONS[group.groupId];
                  const isActive = activePresetGroup === group.groupId;
                  return (
                    <Box
                      key={group.groupId}
                      onClick={() => setActivePresetGroup(group.groupId)}
                      sx={{
                        px: 1.5,
                        py: 0.8,
                        display: "flex",
                        alignItems: "center",
                        gap: 1,
                        cursor: "pointer",
                        borderLeft: isActive
                          ? `3px solid ${theme.palette.primary.main}`
                          : "3px solid transparent",
                        background: isActive
                          ? alpha(theme.palette.primary.main, 0.09)
                          : "transparent",
                        transition: "background 120ms, border-color 120ms",
                        "&:hover": {
                          background: isActive
                            ? alpha(theme.palette.primary.main, 0.12)
                            : alpha(theme.palette.text.primary, 0.05),
                        },
                      }}
                    >
                      {GroupIcon && (
                        <GroupIcon
                          sx={{
                            fontSize: 14,
                            color: isActive
                              ? theme.palette.primary.main
                              : theme.palette.text.secondary,
                            flexShrink: 0,
                            transition: "color 120ms",
                          }}
                        />
                      )}
                      <Typography
                        variant="caption"
                        sx={{
                          flex: 1,
                          fontSize: 11.5,
                          fontWeight: isActive ? 700 : 400,
                          color: isActive
                            ? theme.palette.primary.main
                            : theme.palette.text.primary,
                          transition: "color 120ms",
                          lineHeight: 1.2,
                        }}
                      >
                        {t(group.groupLabelKey)}
                      </Typography>
                      <Box
                        sx={{
                          minWidth: 18,
                          height: 16,
                          px: 0.5,
                          borderRadius: 0.75,
                          background: isActive
                            ? alpha(theme.palette.primary.main, 0.15)
                            : alpha(theme.palette.text.primary, 0.07),
                          display: "flex",
                          alignItems: "center",
                          justifyContent: "center",
                          fontSize: 9,
                          fontWeight: 700,
                          color: isActive
                            ? theme.palette.primary.main
                            : theme.palette.text.disabled,
                          flexShrink: 0,
                          transition: "background 120ms, color 120ms",
                        }}
                      >
                        {group.items.length}
                      </Box>
                    </Box>
                  );
                })}
                {userPresets.length > 0 && (
                  <>
                    <Divider sx={{ my: 0.5 }} />
                    <Box
                      onClick={() => setActivePresetGroup("saved")}
                      sx={{
                        px: 1.5,
                        py: 0.8,
                        display: "flex",
                        alignItems: "center",
                        gap: 1,
                        cursor: "pointer",
                        borderLeft:
                          activePresetGroup === "saved"
                            ? `3px solid ${theme.palette.warning.main}`
                            : "3px solid transparent",
                        background:
                          activePresetGroup === "saved"
                            ? alpha(theme.palette.warning.main, 0.09)
                            : "transparent",
                        transition: "background 120ms",
                        "&:hover": {
                          background:
                            activePresetGroup === "saved"
                              ? alpha(theme.palette.warning.main, 0.13)
                              : alpha(theme.palette.text.primary, 0.05),
                        },
                      }}
                    >
                      <StarIcon
                        sx={{
                          fontSize: 14,
                          color:
                            activePresetGroup === "saved"
                              ? theme.palette.warning.main
                              : theme.palette.text.secondary,
                          flexShrink: 0,
                          transition: "color 120ms",
                        }}
                      />
                      <Typography
                        variant="caption"
                        sx={{
                          flex: 1,
                          fontSize: 11.5,
                          fontWeight: activePresetGroup === "saved" ? 700 : 400,
                          color:
                            activePresetGroup === "saved"
                              ? theme.palette.warning.main
                              : theme.palette.text.primary,
                          transition: "color 120ms",
                          lineHeight: 1.2,
                        }}
                      >
                        {t("sqlConsole.userPresets")}
                      </Typography>
                      <Box
                        sx={{
                          minWidth: 18,
                          height: 16,
                          px: 0.5,
                          borderRadius: 0.75,
                          background: alpha(
                            theme.palette.warning.main,
                            activePresetGroup === "saved" ? 0.18 : 0.1,
                          ),
                          display: "flex",
                          alignItems: "center",
                          justifyContent: "center",
                          fontSize: 9,
                          fontWeight: 700,
                          color: theme.palette.warning.main,
                          flexShrink: 0,
                        }}
                      >
                        {userPresets.length}
                      </Box>
                    </Box>
                  </>
                )}
              </Box>

              {/* Right panel — items */}
              <Box sx={{ flex: 1, overflowY: "auto", py: 0.5, minWidth: 0 }}>
                {activePresetGroup === "saved"
                  ? userPresets.map((p) => (
                      <Box
                        key={p.id}
                        sx={{
                          px: 2.5,
                          py: 0.7,
                          display: "flex",
                          alignItems: "flex-start",
                          gap: 0.5,
                          "&:hover": {
                            background: alpha(theme.palette.warning.main, 0.06),
                          },
                        }}
                      >
                        <Box
                          flex={1}
                          sx={{ cursor: "pointer", minWidth: 0 }}
                          onClick={() => {
                            insertPreset(p.sql, false);
                            setPresetLibraryAnchor(null);
                            setPresetSearch("");
                          }}
                        >
                          <Typography
                            variant="body2"
                            sx={{
                              fontSize: 12.5,
                              lineHeight: 1.3,
                              overflow: "hidden",
                              textOverflow: "ellipsis",
                              whiteSpace: "nowrap",
                            }}
                          >
                            {p.name}
                          </Typography>
                        </Box>
                        <Tooltip
                          title={t("sqlConsole.presetDeleteTooltip")}
                          arrow
                        >
                          <IconButton
                            size="small"
                            onClick={() => handleDeleteUserPreset(p.id)}
                            aria-label={t("sqlConsole.presetDeleteTooltip")}
                            sx={{
                              width: 22,
                              height: 22,
                              flexShrink: 0,
                              mt: 0.1,
                            }}
                          >
                            <DeleteOutlineIcon sx={{ fontSize: 13 }} />
                          </IconButton>
                        </Tooltip>
                      </Box>
                    ))
                  : (
                      presetGroups.find((g) => g.groupId === activePresetGroup)
                        ?.items ?? []
                    ).map((p) => (
                      <Box
                        key={p.id}
                        onClick={() => {
                          insertPreset(p.sql, false);
                          setPresetLibraryAnchor(null);
                          setPresetSearch("");
                        }}
                        sx={{
                          px: 2.5,
                          py: 0.7,
                          cursor: "pointer",
                          "&:hover": {
                            background: alpha(theme.palette.primary.main, 0.06),
                          },
                        }}
                      >
                        <Typography
                          variant="body2"
                          sx={{ fontSize: 12.5, lineHeight: 1.3 }}
                        >
                          {t(p.labelKey)}
                        </Typography>
                      </Box>
                    ))}
              </Box>
            </Box>
          )}
        </Popover>

        <Divider sx={{ mx: 0, my: 0 }} />
        {running && (
          <LinearProgress
            sx={{ height: 2 }}
            aria-label={t("sqlConsole.running")}
          />
        )}

        {/* ---------- Results area + Schema sidebar (DBeaver-like row) ----
          The flex row makes the result table claim ALL remaining vertical
          space below the toolbar. The sidebar is a sibling, not a parent —
          this keeps the table flex-grow behaviour clean across viewports. */}
        <Box
          sx={{
            flex: 1,
            display: "flex",
            flexDirection: "row",
            minHeight: 0,
            minWidth: 0,
            overflow: "hidden",
          }}
        >
          {/* Left sidebar — Schema explorer (collapsible, persisted) */}
          {schemaVisible && (
            <>
              <Box
                className="schema-sidebar"
                sx={{
                  width: schemaWidth,
                  minWidth: SCHEMA_WIDTH_MIN,
                  maxWidth: SCHEMA_WIDTH_MAX,
                  flexShrink: 0,
                  display: "flex",
                  flexDirection: "column",
                  background: alpha(
                    theme.palette.text.primary,
                    isDark ? 0.025 : 0.015,
                  ),
                  borderRight: `1px solid ${theme.palette.divider}`,
                  overflow: "hidden",
                  animation: "sqlSlideInLeft 200ms ease-out",
                }}
              >
                {/* Sticky sidebar header — 36px to align with the top status
                  bar; the close affordance lives at the right edge. */}
                <Box
                  sx={{
                    display: "flex",
                    alignItems: "center",
                    gap: 0.75,
                    px: 1.25,
                    height: 36,
                    borderBottom: `1px solid ${theme.palette.divider}`,
                    background: alpha(
                      theme.palette.text.primary,
                      isDark ? 0.04 : 0.025,
                    ),
                    flexShrink: 0,
                  }}
                >
                  <SchemaIcon
                    sx={{
                      fontSize: 14,
                      color: theme.palette.primary.main,
                    }}
                  />
                  <Typography
                    variant="caption"
                    sx={{
                      textTransform: "uppercase",
                      letterSpacing: "0.06em",
                      fontWeight: 700,
                      fontSize: 10,
                      color: theme.palette.text.primary,
                    }}
                  >
                    {t("sqlConsole.schema")}
                  </Typography>
                  {schemaTables.length > 0 && (
                    <Typography
                      variant="caption"
                      sx={{
                        fontSize: 10,
                        fontFamily: MONO_FONT,
                        fontVariantNumeric: "tabular-nums",
                        color: theme.palette.text.disabled,
                        fontWeight: 600,
                      }}
                    >
                      {t("sqlConsole.schema.tablesCount", {
                        count: schemaTables.length,
                      })}
                    </Typography>
                  )}
                  {schemaLoading && (
                    <LinearProgress
                      sx={{
                        flex: 1,
                        ml: 0.5,
                        maxWidth: 60,
                        height: 2,
                      }}
                    />
                  )}
                  <Box flex={1} />
                  <Tooltip title={t("sqlConsole.schema.close")} arrow>
                    <IconButton
                      size="small"
                      onClick={() => setSchemaVisible(false)}
                      aria-label={t("sqlConsole.schema.close")}
                      sx={{
                        width: 22,
                        height: 22,
                        color: theme.palette.text.secondary,
                      }}
                    >
                      <ClearIcon sx={{ fontSize: 14 }} />
                    </IconButton>
                  </Tooltip>
                </Box>

                {/* Sidebar search box (with click-hint as helperText so we
                  don't add an extra row). */}
                <Box
                  sx={{
                    px: 1,
                    py: 0.75,
                    borderBottom: `1px solid ${theme.palette.divider}`,
                    flexShrink: 0,
                  }}
                >
                  <Tooltip
                    title={t("sqlConsole.schemaClickColumn")}
                    placement="bottom-start"
                    arrow
                  >
                    <TextField
                      size="small"
                      fullWidth
                      value={schemaSearch}
                      onChange={(e) => setSchemaSearch(e.target.value)}
                      placeholder={t("sqlConsole.schema.search")}
                      slotProps={{
                        input: {
                          startAdornment: (
                            <InputAdornment position="start">
                              <SearchIcon
                                fontSize="small"
                                sx={{
                                  color: theme.palette.text.secondary,
                                  fontSize: 14,
                                }}
                              />
                            </InputAdornment>
                          ),
                        },
                        htmlInput: {
                          style: { fontSize: 12, padding: "4px 6px" },
                          "aria-label": t("sqlConsole.schema.search"),
                        },
                      }}
                    />
                  </Tooltip>
                </Box>

                {/* Table tree (scrollable) */}
                <Box sx={{ flex: 1, overflow: "auto", minHeight: 0 }}>
                  {schemaLoading && schemaTables.length === 0 && (
                    // Shimmer skeleton while the schema endpoint is in flight
                    <Box sx={{ px: 1.25, pt: 0.5 }}>
                      {[0, 1, 2, 3, 4].map((i) => (
                        <Box
                          key={i}
                          sx={{
                            height: 18,
                            mb: 0.5,
                            borderRadius: 0.5,
                            background: `linear-gradient(90deg, ${alpha(
                              theme.palette.text.primary,
                              0.04,
                            )} 0%, ${alpha(
                              theme.palette.text.primary,
                              0.08,
                            )} 50%, ${alpha(
                              theme.palette.text.primary,
                              0.04,
                            )} 100%)`,
                            backgroundSize: "200px 100%",
                            animation: "sqlShimmer 1.4s ease-in-out infinite",
                          }}
                        />
                      ))}
                    </Box>
                  )}
                  {!schemaLoading && filteredSchemaTables.length === 0 && (
                    <Typography
                      variant="caption"
                      sx={{
                        display: "block",
                        px: 1.25,
                        py: 1.5,
                        textAlign: "center",
                        color: theme.palette.text.disabled,
                      }}
                    >
                      {t("sqlConsole.schema.empty")}
                    </Typography>
                  )}
                  <List dense disablePadding>
                    {filteredSchemaTables.map((tbl) => {
                      const tableCount = counts?.[tbl.name] ?? null;
                      const isExpanded = Boolean(expandedTables[tbl.name]);
                      return (
                        <Box key={tbl.name}>
                          <ListItemButton
                            onClick={() =>
                              setExpandedTables((x) => ({
                                ...x,
                                [tbl.name]: !x[tbl.name],
                              }))
                            }
                            sx={{
                              py: 0.25,
                              "&:hover": {
                                background: alpha(
                                  theme.palette.primary.main,
                                  0.04,
                                ),
                              },
                            }}
                          >
                            <ListItemText
                              primary={
                                <Box
                                  display="flex"
                                  alignItems="center"
                                  gap={0.5}
                                >
                                  {isExpanded ? (
                                    <ExpandMoreIcon sx={{ fontSize: 14 }} />
                                  ) : (
                                    <ChevronRightIcon sx={{ fontSize: 14 }} />
                                  )}
                                  <Typography
                                    variant="body2"
                                    sx={{
                                      fontFamily: MONO_FONT,
                                      fontSize: 12,
                                      fontWeight: 600,
                                    }}
                                  >
                                    {tbl.name}
                                  </Typography>
                                  {tableCount != null && (
                                    <Typography
                                      variant="caption"
                                      color="text.secondary"
                                      sx={{
                                        fontSize: 10,
                                        fontFamily: MONO_FONT,
                                      }}
                                    >
                                      {formatRowCount(tableCount)}
                                    </Typography>
                                  )}
                                  <Box flex={1} />
                                  <Button
                                    size="small"
                                    variant="text"
                                    onClick={(e) => {
                                      e.stopPropagation();
                                      browseFile(tbl.name);
                                    }}
                                    sx={{
                                      minWidth: 0,
                                      fontSize: 10,
                                      py: 0,
                                      px: 0.75,
                                    }}
                                  >
                                    {t("sqlConsole.schemaBrowseBtn")}
                                  </Button>
                                </Box>
                              }
                            />
                          </ListItemButton>
                          <Collapse in={isExpanded}>
                            <Box
                              sx={{
                                pl: 3.5,
                                pr: 1,
                                pb: 0.5,
                                fontSize: 11,
                                fontFamily: MONO_FONT,
                              }}
                            >
                              {(tbl.columns || []).map((c) => {
                                const colType = (c.type || "").toUpperCase();
                                const typeColor = TYPE_TO_COLOR(
                                  colType.includes("INT")
                                    ? "INTEGER"
                                    : colType.includes("REAL") ||
                                        colType.includes("FLOAT") ||
                                        colType.includes("DOUBLE")
                                      ? "REAL"
                                      : "TEXT",
                                  theme.palette,
                                );
                                return (
                                  <Box
                                    key={c.name}
                                    onClick={() => {
                                      insertAtCursor(c.name);
                                      showSnack(
                                        t("sqlConsole.schemaInsertedToast", {
                                          name: c.name,
                                        }),
                                      );
                                    }}
                                    sx={{
                                      display: "flex",
                                      alignItems: "center",
                                      gap: 0.5,
                                      py: 0.25,
                                      cursor: "pointer",
                                      borderRadius: 0.5,
                                      px: 0.5,
                                      "&:hover": {
                                        background: alpha(
                                          theme.palette.primary.main,
                                          0.08,
                                        ),
                                      },
                                    }}
                                  >
                                    {c.pk ? (
                                      <Box
                                        component="span"
                                        sx={{
                                          fontSize: 10,
                                          color: theme.palette.warning.main,
                                          fontWeight: 700,
                                          minWidth: 12,
                                          textAlign: "center",
                                        }}
                                        aria-label="primary key"
                                        title="primary key"
                                      >
                                        ⚿
                                      </Box>
                                    ) : (
                                      <Box
                                        component="span"
                                        sx={{ minWidth: 12 }}
                                      />
                                    )}
                                    <Box
                                      component="span"
                                      sx={{
                                        flex: 1,
                                        fontWeight: c.pk ? 700 : 500,
                                        overflow: "hidden",
                                        textOverflow: "ellipsis",
                                        whiteSpace: "nowrap",
                                      }}
                                    >
                                      {c.name}
                                    </Box>
                                    <Box
                                      component="span"
                                      sx={{
                                        fontSize: 9,
                                        fontWeight: 700,
                                        letterSpacing: "0.04em",
                                        color: typeColor,
                                        opacity: 0.85,
                                        px: 0.4,
                                        borderRadius: 0.4,
                                        background: alpha(typeColor, 0.1),
                                        flexShrink: 0,
                                      }}
                                    >
                                      {colType || "TEXT"}
                                    </Box>
                                  </Box>
                                );
                              })}
                            </Box>
                          </Collapse>
                        </Box>
                      );
                    })}
                  </List>
                </Box>
              </Box>
              {/* Vertical splitter — drag to resize sidebar (200-400px). */}
              <Tooltip
                title={t("sqlConsole.schema.toggle")}
                arrow
                placement="right"
              >
                <Box
                  role="separator"
                  aria-orientation="vertical"
                  aria-label={t("sqlConsole.schema.toggle")}
                  onMouseDown={handleSchemaSplitterMouseDown}
                  sx={{
                    width: 4,
                    flexShrink: 0,
                    cursor: "col-resize",
                    background: "transparent",
                    position: "relative",
                    transition: "background-color 150ms ease",
                    "&:hover": {
                      background: alpha(theme.palette.primary.main, 0.4),
                    },
                    "&::after": {
                      content: '""',
                      position: "absolute",
                      top: "50%",
                      left: "50%",
                      transform: "translate(-50%, -50%)",
                      width: 2,
                      height: 28,
                      borderRadius: 2,
                      background: alpha(theme.palette.text.primary, 0.18),
                      opacity: 0,
                      transition: "opacity 150ms ease",
                    },
                    "&:hover::after": { opacity: 1 },
                  }}
                />
              </Tooltip>
            </>
          )}

          {/* Results column — flex-grow, claims all remaining horizontal &
            vertical space. minWidth/Height: 0 unlocks shrinking. */}
          <Box
            sx={{
              flex: 1,
              display: "flex",
              flexDirection: "column",
              minWidth: 0,
              minHeight: 0,
              overflow: "hidden",
            }}
          >
            {/* ---------- Results zone ----------
          Flush against the sidebar (visual separation comes from the
          sidebar's borderRight + the 4px splitter). The result area owns
          its own header (identity bar), table, and bottom toolbar. */}
            <Box
              sx={{
                px: 0,
                pb: 0,
                pt: 0,
                flex: 1,
                display: "flex",
                flexDirection: "column",
                minHeight: 0,
                overflow: "hidden",
              }}
            >
              {error && (
                <Box sx={{ px: 1.5, pt: 1 }}>
                  <Alert severity="error" sx={{ mb: 0 }}>
                    {error}
                  </Alert>
                </Box>
              )}
              {!result && !error && !running && (
                <Box
                  sx={{
                    m: 1.5,
                    border: `1px dashed ${alpha(theme.palette.text.primary, 0.12)}`,
                    borderRadius: 1.5,
                    px: 2,
                    py: 3,
                    textAlign: "center",
                    color: theme.palette.text.secondary,
                    animation: "sqlSlideIn 250ms ease-out",
                  }}
                >
                  <StorageIcon
                    sx={{
                      fontSize: 36,
                      opacity: 0.18,
                      color: theme.palette.primary.main,
                      mb: 1,
                    }}
                  />
                  <Typography
                    variant="body2"
                    sx={{
                      fontWeight: 700,
                      fontSize: 13,
                      mb: 0.25,
                      color: theme.palette.text.primary,
                    }}
                  >
                    {t("sqlConsole.empty.runHint")}
                  </Typography>
                  <Typography
                    variant="caption"
                    sx={{
                      display: "block",
                      fontSize: 11,
                      color: theme.palette.text.disabled,
                      mb: 1.5,
                    }}
                  >
                    {t("sqlConsole.empty.illustration")}
                  </Typography>
                  <Box
                    sx={{
                      display: "inline-flex",
                      gap: 0.75,
                      flexWrap: "wrap",
                      justifyContent: "center",
                    }}
                  >
                    {[
                      {
                        table: "stops",
                        labelKey: "sqlConsole.empty.quickActionStops",
                      },
                      {
                        table: "routes",
                        labelKey: "sqlConsole.empty.quickActionRoutes",
                      },
                      {
                        table: "trips",
                        labelKey: "sqlConsole.empty.quickActionTrips",
                      },
                    ].map((qa) => {
                      const present = (counts?.[qa.table] ?? 0) > 0;
                      return (
                        <Box
                          key={qa.table}
                          component="button"
                          type="button"
                          disabled={!present}
                          onClick={() => browseFile(qa.table)}
                          sx={{
                            display: "inline-flex",
                            alignItems: "center",
                            gap: 0.5,
                            height: 26,
                            px: 1.25,
                            borderRadius: 999,
                            border: `1px solid ${alpha(
                              theme.palette.primary.main,
                              0.3,
                            )}`,
                            background: alpha(theme.palette.primary.main, 0.06),
                            color: theme.palette.primary.main,
                            fontFamily: MONO_FONT,
                            fontSize: 11.5,
                            fontWeight: 600,
                            cursor: present ? "pointer" : "not-allowed",
                            opacity: present ? 1 : 0.4,
                            transition:
                              "transform 150ms ease, background-color 150ms ease",
                            "&:hover:not(:disabled)": {
                              background: alpha(
                                theme.palette.primary.main,
                                0.12,
                              ),
                              transform: "translateY(-1px)",
                            },
                          }}
                        >
                          {t(qa.labelKey)}
                        </Box>
                      );
                    })}
                  </Box>
                </Box>
              )}
              {result && (
                <Box
                  sx={{
                    flex: 1,
                    display: "flex",
                    flexDirection: "column",
                    minHeight: 0,
                    overflow: "hidden",
                  }}
                >
                  {/* Results section header — 32px strip, surfaceAlt fill, sits
                flush at the top of the results column. Carries the section
                label ("RESULTS"), the editable/read-only chip, and the
                auto-refresh toggle. Live row/duration/selection counters
                live in the bottom toolbar (DBeaver-style). */}
                  <Box
                    sx={{
                      display: "flex",
                      alignItems: "center",
                      gap: 0.75,
                      px: 1.5,
                      height: 32,
                      background: alpha(
                        theme.palette.text.primary,
                        isDark ? 0.025 : 0.015,
                      ),
                      borderBottom: `1px solid ${theme.palette.divider}`,
                      flexShrink: 0,
                    }}
                  >
                    {cellEditableEntity ? (
                      <Tooltip title={t("sqlConsole.editableHint")} arrow>
                        <Chip
                          size="small"
                          icon={<EditIcon sx={{ fontSize: 12 }} />}
                          label={editable.table}
                          sx={{
                            height: 20,
                            fontSize: 10.5,
                            fontWeight: 700,
                            fontFamily: MONO_FONT,
                            bgcolor: alpha(theme.palette.success.main, 0.12),
                            color: theme.palette.success.main,
                            "& .MuiChip-icon": { ml: 0.5, color: "inherit" },
                            "& .MuiChip-label": { px: 0.75 },
                          }}
                        />
                      </Tooltip>
                    ) : (
                      <Tooltip title={t("sqlConsole.readOnlyHint")} arrow>
                        <Chip
                          size="small"
                          label={t("sqlConsole.readOnlyTag")}
                          sx={{
                            height: 20,
                            fontSize: 10.5,
                            fontWeight: 700,
                            bgcolor: alpha(theme.palette.text.primary, 0.06),
                            "& .MuiChip-label": { px: 0.75 },
                          }}
                        />
                      </Tooltip>
                    )}
                    <Box flex={1} />
                    <Tooltip title={t("sqlConsole.autoRefresh.tooltip")} arrow>
                      <Box
                        sx={{
                          display: "inline-flex",
                          alignItems: "center",
                          gap: 0.25,
                          border: `1px solid ${theme.palette.divider}`,
                          borderRadius: 999,
                          pl: 0.75,
                          pr: 0.25,
                          height: 22,
                          background: theme.palette.background.paper,
                        }}
                        onClick={() => setAutoRefresh((v) => !v)}
                        role="switch"
                        aria-checked={autoRefresh}
                      >
                        <FiberManualRecordIcon
                          sx={{
                            fontSize: 8,
                            color: autoRefresh
                              ? theme.palette.success.main
                              : alpha(theme.palette.text.secondary, 0.5),
                          }}
                        />
                        <Typography
                          variant="caption"
                          sx={{
                            fontSize: 10,
                            fontWeight: 700,
                            letterSpacing: "0.04em",
                            cursor: "pointer",
                            userSelect: "none",
                          }}
                        >
                          {autoRefresh
                            ? t("sqlConsole.autoRefresh.on")
                            : t("sqlConsole.autoRefresh.off")}
                        </Typography>
                        <Switch
                          size="small"
                          checked={autoRefresh}
                          onChange={(e) => setAutoRefresh(e.target.checked)}
                          sx={{ ml: 0.25, transform: "scale(0.65)" }}
                          inputProps={{
                            "aria-label": autoRefresh
                              ? t("sqlConsole.autoRefresh.on")
                              : t("sqlConsole.autoRefresh.off"),
                          }}
                        />
                      </Box>
                    </Tooltip>
                  </Box>

                  {/* Read-only hint only in edit mode (when user might expect cell editing) */}
                  {result && !cellEditableEntity && editing && (
                    <Alert
                      severity="info"
                      icon={<InfoOutlinedIcon fontSize="small" />}
                      sx={{ mx: 1.5, mt: 1, mb: 0, py: 0.25, fontSize: 11 }}
                    >
                      {t("sqlConsole.readOnlyHint")}
                    </Alert>
                  )}

                  {/* Inline mutator (fade-in / slide-down on open). Border-left
                accent signals an interactive section; gap between picker
                fields, inline syntax highlight in the SQL preview block. */}
                  <Collapse
                    in={Boolean(mutatorOpen && cellEditableEntity)}
                    timeout={200}
                  >
                    <Fade
                      in={Boolean(mutatorOpen && cellEditableEntity)}
                      timeout={200}
                    >
                      <Paper
                        elevation={0}
                        sx={{
                          pl: 2,
                          pr: 1.5,
                          py: 1.25,
                          mx: 1.5,
                          mt: 1,
                          mb: 0,
                          border: `1px solid ${alpha(theme.palette.primary.main, 0.2)}`,
                          borderLeft: `3px solid ${theme.palette.primary.main}`,
                          borderRadius: 1,
                          background: alpha(theme.palette.primary.main, 0.04),
                          animation: "sqlSlideIn 200ms ease-out",
                        }}
                      >
                        <Typography
                          variant="caption"
                          sx={{
                            display: "block",
                            fontWeight: 700,
                            textTransform: "uppercase",
                            letterSpacing: "0.06em",
                            fontSize: 10,
                            color: theme.palette.text.secondary,
                            mb: 0.75,
                          }}
                        >
                          {t("sqlConsole.mutator.title", {
                            count: selectedRows.size,
                          })}
                        </Typography>
                        <Box
                          sx={{
                            display: "flex",
                            gap: 0.75,
                            alignItems: "flex-start",
                            mb: 0.75,
                            flexWrap: "wrap",
                          }}
                        >
                          <FormControl size="small" sx={{ minWidth: 220 }}>
                            <InputLabel>
                              {t("sqlConsole.mutator.pickColumn")}
                            </InputLabel>
                            <Select
                              value={mutatorColumn}
                              label={t("sqlConsole.mutator.pickColumn")}
                              onChange={(e) => {
                                setMutatorColumn(e.target.value);
                                setMutatorValue("");
                              }}
                            >
                              {mutatorEditableFields.map((f) => (
                                <MenuItem key={f.key} value={f.key}>
                                  <span style={{ fontFamily: MONO_FONT }}>
                                    {f.key}
                                  </span>
                                </MenuItem>
                              ))}
                            </Select>
                          </FormControl>
                          {mutatorFieldDef?.type === "enum" ? (
                            <FormControl size="small" sx={{ minWidth: 220 }}>
                              <InputLabel>
                                {t("sqlConsole.mutator.setValue")}
                              </InputLabel>
                              <Select
                                value={mutatorValue}
                                label={t("sqlConsole.mutator.setValue")}
                                onChange={(e) =>
                                  setMutatorValue(e.target.value)
                                }
                              >
                                <MenuItem value="">
                                  <em>NULL</em>
                                </MenuItem>
                                {mutatorFieldDef.options.map((o) => (
                                  <MenuItem key={o.value} value={o.value}>
                                    {o.label}
                                  </MenuItem>
                                ))}
                              </Select>
                            </FormControl>
                          ) : (
                            <TextField
                              size="small"
                              label={t("sqlConsole.mutator.setValue")}
                              type={
                                mutatorFieldDef?.type === "number"
                                  ? "number"
                                  : "text"
                              }
                              value={mutatorValue}
                              onChange={(e) => setMutatorValue(e.target.value)}
                              disabled={!mutatorColumn}
                              sx={{ minWidth: 220 }}
                            />
                          )}
                        </Box>
                        {generatedMutatorPreview && (
                          <>
                            <Typography
                              variant="caption"
                              sx={{
                                display: "block",
                                fontWeight: 700,
                                textTransform: "uppercase",
                                letterSpacing: "0.06em",
                                fontSize: 9.5,
                                color: theme.palette.text.disabled,
                                mb: 0.5,
                              }}
                            >
                              {t("sqlConsole.mutator.generatedSql")}
                            </Typography>
                            <Box
                              component="pre"
                              sx={{
                                m: 0,
                                p: 1.25,
                                fontFamily: MONO_FONT,
                                fontSize: 11.5,
                                lineHeight: 1.5,
                                background: alpha(
                                  theme.palette.background.default,
                                  isDark ? 0.6 : 0.7,
                                ),
                                border: `1px solid ${alpha(
                                  theme.palette.text.primary,
                                  0.08,
                                )}`,
                                borderRadius: 1,
                                whiteSpace: "pre-wrap",
                                wordBreak: "break-all",
                                mb: 1,
                              }}
                            >
                              {(
                                highlightSqlInline(generatedMutatorPreview) ||
                                []
                              ).map((part, i) =>
                                part.kind === "kw" ? (
                                  <Box
                                    key={i}
                                    component="span"
                                    sx={{
                                      color: theme.palette.primary.main,
                                      fontWeight: 700,
                                    }}
                                  >
                                    {part.value}
                                  </Box>
                                ) : (
                                  <span key={i}>{part.value}</span>
                                ),
                              )}
                            </Box>
                          </>
                        )}
                        <Box
                          sx={{
                            display: "flex",
                            gap: 1,
                            justifyContent: "flex-end",
                          }}
                        >
                          <Button
                            size="small"
                            onClick={() => setMutatorOpen(false)}
                            disabled={mutatorApplying}
                          >
                            {t("app.cancel")}
                          </Button>
                          <Button
                            size="small"
                            variant="outlined"
                            onClick={handleMutatorInsertInEditor}
                            disabled={!mutatorColumn || mutatorApplying}
                          >
                            {t("sqlConsole.mutator.insertInEditor")}
                          </Button>
                          <Button
                            size="small"
                            variant="contained"
                            onClick={handleMutatorApply}
                            disabled={!mutatorColumn || mutatorApplying}
                          >
                            {mutatorApplying
                              ? t("sqlConsole.running")
                              : t("sqlConsole.mutator.apply")}
                          </Button>
                        </Box>
                      </Paper>
                    </Fade>
                  </Collapse>

                  {/* Empty results — separate copy for mutation-zero-affected vs
                SELECT-zero-rows. The SELECT empty state suggests relaxing
                the WHERE clause; the mutation empty state confirms that
                nothing matched (a successful but inert run, undo entry
                still produced) so the user knows the run did happen and
                the WHERE just didn't hit anything. */}
                  {allRows.length === 0 && (
                    <Box
                      sx={{
                        m: 1.5,
                        border: `1px solid ${theme.palette.divider}`,
                        borderRadius: 1.5,
                        px: 2,
                        py: 3,
                        textAlign: "center",
                        color: theme.palette.text.secondary,
                        animation: "sqlSlideIn 200ms ease-out",
                      }}
                    >
                      {result?.mutated ? (
                        <>
                          <CheckCircleOutlineIcon
                            sx={{
                              fontSize: 32,
                              opacity: 0.55,
                              color: theme.palette.success.main,
                              mb: 0.5,
                            }}
                          />
                          <Typography
                            variant="body2"
                            sx={{
                              fontWeight: 700,
                              mb: 0.25,
                              color: theme.palette.text.primary,
                            }}
                          >
                            {t("sqlConsole.mutation.zeroAffectedTitle")}
                          </Typography>
                          <Typography
                            variant="caption"
                            sx={{ fontSize: 11, opacity: 0.7 }}
                          >
                            {t("sqlConsole.mutation.zeroAffectedHint")}
                          </Typography>
                        </>
                      ) : (
                        <>
                          <SearchIcon
                            sx={{
                              fontSize: 32,
                              opacity: 0.22,
                              color: theme.palette.text.secondary,
                              mb: 0.5,
                            }}
                          />
                          <Typography
                            variant="body2"
                            sx={{
                              fontWeight: 700,
                              mb: 0.25,
                              color: theme.palette.text.primary,
                            }}
                          >
                            {t("sqlConsole.emptyResults")}
                          </Typography>
                          <Typography
                            variant="caption"
                            sx={{ fontSize: 11, opacity: 0.7 }}
                          >
                            {t("sqlConsole.empty.noResults")}
                          </Typography>
                        </>
                      )}
                    </Box>
                  )}

                  {/* Result table — flex-grow to fill remaining vertical space.
                The container is the scroll viewport; sticky <thead> stays
                pinned. minHeight: 0 unlocks shrinking inside flex parents. */}
                  {allRows.length > 0 && (
                    <Box
                      ref={tableScrollRef}
                      onScroll={handleTableScroll}
                      sx={{
                        flex: 1,
                        minHeight: 0,
                        display: "flex",
                        flexDirection: "column",
                        overflow: "auto",
                        background: isDark
                          ? alpha(theme.palette.common.white, 0.02)
                          : theme.palette.background.paper,
                      }}
                    >
                      <Box
                        component="table"
                        role="table"
                        sx={{
                          borderCollapse: "collapse",
                          width: "100%",
                          fontSize: 12,
                          fontFamily: MONO_FONT,
                          "& th, & td": {
                            px: 1,
                            py: 0.5,
                            borderBottom: `1px solid ${alpha(
                              theme.palette.text.primary,
                              0.06,
                            )}`,
                            whiteSpace: "nowrap",
                            textAlign: "left",
                            verticalAlign: "top",
                          },
                          "& th": {
                            position: "sticky",
                            top: 0,
                            // Background MUST be fully opaque or scrolling rows
                            // bleed through the sticky header. We layer a subtle
                            // alpha tint on top of an opaque paper base via
                            // background-image so the header stays theme-aware
                            // *and* truly opaque.
                            backgroundColor: theme.palette.background.paper,
                            backgroundImage: `linear-gradient(${
                              isDark
                                ? alpha(theme.palette.common.white, 0.04)
                                : alpha(theme.palette.text.primary, 0.025)
                            }, ${
                              isDark
                                ? alpha(theme.palette.common.white, 0.04)
                                : alpha(theme.palette.text.primary, 0.025)
                            })`,
                            boxShadow: `inset 0 -1px 0 ${theme.palette.divider}`,
                            fontWeight: 700,
                            zIndex: 2,
                            letterSpacing: "0.02em",
                            py: 0.625,
                          },
                          "& tbody tr": {
                            transition: "background-color 100ms ease",
                          },
                          // Hover state takes precedence over zebra striping but
                          // not over selection (selection has higher specificity
                          // via inline style on <tr>). We tint the cells (not the
                          // <tr>) so the sticky row-number column inherits hover.
                          "& tbody tr:hover td": {
                            background: alpha(theme.palette.primary.main, 0.06),
                          },
                          "& tbody tr:hover td.sql-rownum-cell": {
                            background: alpha(theme.palette.primary.main, 0.06),
                          },
                        }}
                      >
                        <thead>
                          <tr>
                            {/* Row-number header column (sticky-left, monospace).
                          Empty header label keeps the column unobtrusive.
                          Background MUST be opaque — this cell is BOTH a
                          sticky <th> (covers vertical scroll) AND sticky-left
                          (covers horizontal scroll), so any transparency
                          would let cell content bleed through in two axes. */}
                            <th
                              style={{
                                width: 48,
                                minWidth: 48,
                                maxWidth: 48,
                                position: "sticky",
                                left: 0,
                                zIndex: 3,
                                backgroundColor: theme.palette.background.paper,
                                backgroundImage: `linear-gradient(${
                                  isDark
                                    ? alpha(theme.palette.common.white, 0.04)
                                    : alpha(theme.palette.text.primary, 0.025)
                                }, ${
                                  isDark
                                    ? alpha(theme.palette.common.white, 0.04)
                                    : alpha(theme.palette.text.primary, 0.025)
                                })`,
                                borderRight: `1px solid ${theme.palette.divider}`,
                              }}
                              aria-label="row-number"
                            />
                            {cellEditableEntity && editing && (
                              <th style={{ width: 28 }}>
                                <input
                                  type="checkbox"
                                  aria-label={t("sqlConsole.selectAll")}
                                  checked={
                                    visibleRows.length > 0 &&
                                    visibleRows.every((r) => {
                                      const id = pkAccessor(r);
                                      return id && selectedRows.has(id);
                                    })
                                  }
                                  onChange={() => toggleAllVisible(visibleRows)}
                                />
                              </th>
                            )}
                            {allColumns.map((c) => {
                              const colType = inferColumnType(allRows, c);
                              const typeColor = TYPE_TO_COLOR(
                                colType,
                                theme.palette,
                              );
                              const pkName =
                                typeof editable?.pk === "string"
                                  ? editable.pk
                                  : (editable?.pk || [])[0];
                              const isPkHeader = pkName === c;
                              const isSorted = sortBy.column === c;
                              const sortDir = isSorted
                                ? sortBy.direction
                                : null;
                              // 3-state aria-sort follows WAI-ARIA conventions
                              // (ascending / descending / none).
                              const ariaSort = isSorted
                                ? sortDir === "asc"
                                  ? "ascending"
                                  : "descending"
                                : "none";
                              // Tooltip walks through the next state in the cycle:
                              // unsorted → asc → desc → cleared.
                              const sortTooltip = !isSorted
                                ? t("sqlConsole.sortAsc")
                                : sortDir === "asc"
                                  ? t("sqlConsole.sortDesc")
                                  : t("sqlConsole.sortClear");
                              return (
                                <th
                                  key={c}
                                  aria-sort={ariaSort}
                                  onClick={() => handleSortColumn(c)}
                                  style={{
                                    cursor: "pointer",
                                    userSelect: "none",
                                    background: isSorted
                                      ? alpha(theme.palette.primary.main, 0.06)
                                      : undefined,
                                  }}
                                >
                                  <Tooltip
                                    title={sortTooltip}
                                    placement="top"
                                    arrow
                                    enterDelay={400}
                                  >
                                    <Box
                                      component="span"
                                      sx={{
                                        display: "inline-flex",
                                        alignItems: "center",
                                        gap: 0.5,
                                        // Reveal the discrete sort hint on hover
                                        // when the column is unsorted.
                                        "&:hover .sql-sort-hint": {
                                          opacity: 0.55,
                                        },
                                      }}
                                    >
                                      <Box
                                        component="span"
                                        sx={{
                                          fontWeight: 700,
                                          color: isPkHeader
                                            ? theme.palette.primary.main
                                            : "inherit",
                                        }}
                                      >
                                        {c}
                                      </Box>
                                      {isPkHeader && (
                                        <Box
                                          component="span"
                                          sx={{
                                            fontSize: 8.5,
                                            fontWeight: 700,
                                            fontFamily: MONO_FONT,
                                            px: 0.4,
                                            height: 12,
                                            display: "inline-flex",
                                            alignItems: "center",
                                            borderRadius: 0.4,
                                            background: alpha(
                                              theme.palette.primary.main,
                                              0.16,
                                            ),
                                            color: theme.palette.primary.main,
                                            letterSpacing: "0.04em",
                                          }}
                                        >
                                          PK
                                        </Box>
                                      )}
                                      <Box
                                        component="span"
                                        sx={{
                                          fontSize: 9,
                                          fontFamily: MONO_FONT,
                                          fontWeight: 600,
                                          color: typeColor,
                                          opacity: 0.75,
                                          textTransform: "uppercase",
                                          letterSpacing: "0.04em",
                                        }}
                                      >
                                        {colType}
                                      </Box>
                                      {/* Sort arrow — solid when active, discrete
                                    UnfoldMore icon on hover otherwise. */}
                                      {isSorted ? (
                                        sortDir === "asc" ? (
                                          <ArrowUpwardIcon
                                            sx={{
                                              fontSize: 14,
                                              color: theme.palette.primary.main,
                                              ml: 0.25,
                                            }}
                                          />
                                        ) : (
                                          <ArrowDownwardIcon
                                            sx={{
                                              fontSize: 14,
                                              color: theme.palette.primary.main,
                                              ml: 0.25,
                                            }}
                                          />
                                        )
                                      ) : (
                                        <UnfoldMoreIcon
                                          className="sql-sort-hint"
                                          sx={{
                                            fontSize: 14,
                                            ml: 0.25,
                                            opacity: 0,
                                            color: theme.palette.text.secondary,
                                            transition: "opacity 120ms",
                                          }}
                                        />
                                      )}
                                    </Box>
                                  </Tooltip>
                                </th>
                              );
                            })}
                            {entityForEdit && editing && (
                              <th style={{ width: 28 }} aria-label="edit" />
                            )}
                          </tr>
                        </thead>
                        <tbody>
                          {(() => {
                            const out = [];
                            const pkName =
                              typeof editable?.pk === "string"
                                ? editable.pk
                                : (editable?.pk || [])[0];
                            // Draft row trailing slot — only render when the
                            // result actually exposes the active table and we
                            // hold a pending insert. Defined here once so we
                            // can inject after the anchor or at the end.
                            const draftSlot =
                              pendingInsertRow &&
                              cellEditableEntity &&
                              editing ? (
                                <SqlInsertDraftRow
                                  key="__pending_insert__"
                                  columns={allColumns}
                                  showSelection={Boolean(
                                    cellEditableEntity && editing,
                                  )}
                                  showRowDialog={Boolean(
                                    entityForEdit && editing,
                                  )}
                                  tableName={editable?.table || ""}
                                  pkColumns={
                                    Array.isArray(editable?.pk)
                                      ? editable.pk
                                      : editable?.pk
                                        ? [editable.pk]
                                        : []
                                  }
                                  editableFields={
                                    EDITABLE_FIELDS[editable?.table] || []
                                  }
                                  values={pendingInsertRow.values}
                                  errors={pendingInsertRow.errors}
                                  submitting={insertSubmitting}
                                  onChange={updatePendingInsertValue}
                                  onCommit={commitInlineInsert}
                                  onCancel={cancelInlineInsert}
                                  firstInputRef={pendingInsertFirstInputRef}
                                  t={t}
                                  tLabel={tLabel}
                                  monoFont={MONO_FONT}
                                  palette={theme.palette}
                                />
                              ) : null;

                            visibleRows.forEach((row, i) => {
                              const id = pkAccessor(row);
                              const checked = id ? selectedRows.has(id) : false;
                              out.push(
                                <SqlResultRow
                                  key={id || i}
                                  row={row}
                                  rowIndex={i}
                                  columns={allColumns}
                                  showSelection={Boolean(
                                    cellEditableEntity && editing,
                                  )}
                                  showRowDialog={Boolean(
                                    entityForEdit && editing,
                                  )}
                                  editingCell={editingCell}
                                  cellStatus={cellStatus}
                                  isChecked={checked}
                                  cellInputValue={cellInputValue}
                                  cellInputRef={cellInputRef}
                                  pkAccessor={pkAccessor}
                                  pkColumn={pkName}
                                  isCellEditable={isCellEditable}
                                  editableColumnsConfig={editableColumnsConfig}
                                  beginCellEdit={beginCellEdit}
                                  commitCellEdit={commitCellEdit}
                                  cancelCellEdit={cancelCellEdit}
                                  setCellInputValue={setCellInputValue}
                                  onToggle={toggleRow}
                                  onEditRow={handleEditRowFromTable}
                                  onContextMenu={handleCellContextMenu}
                                  tLabel={tLabel}
                                  monoFont={MONO_FONT}
                                  palette={theme.palette}
                                  isDark={isDark}
                                />,
                              );
                              // Inject the draft row right after the selected
                              // anchor, when the user clicked "+" with exactly
                              // one row selected.
                              if (
                                draftSlot &&
                                pendingInsertRow?.position ===
                                  "after-selected" &&
                                pendingInsertRow?.anchorId &&
                                id === pendingInsertRow.anchorId
                              ) {
                                out.push(draftSlot);
                              }
                            });

                            // Trailing draft (empty result, no anchor, or anchor
                            // not visible in current page).
                            if (
                              draftSlot &&
                              (pendingInsertRow.position !== "after-selected" ||
                                !pendingInsertRow.anchorId ||
                                !visibleRows.some(
                                  (r) =>
                                    pkAccessor(r) === pendingInsertRow.anchorId,
                                ))
                            ) {
                              out.push(draftSlot);
                            }
                            return out;
                          })()}
                        </tbody>
                      </Box>
                      {/* Cap notice — only when virtualised window < total. The
                    right-click hint moved to the bottom toolbar (status
                    push-end side) to avoid stacking two micro-footers. */}
                      {sortedRows.length > visibleRows.length && (
                        <Box
                          sx={{
                            px: 1.5,
                            py: 0.375,
                            fontSize: 10,
                            color: theme.palette.text.disabled,
                            borderTop: `1px solid ${theme.palette.divider}`,
                            fontFamily: MONO_FONT,
                            fontVariantNumeric: "tabular-nums",
                            userSelect: "none",
                          }}
                        >
                          {t("sqlConsole.results.cap", {
                            shown: visibleRows.length,
                            total: sortedRows.length,
                          })}
                        </Box>
                      )}
                    </Box>
                  )}
                  {/* ---------- DBeaver-style bottom toolbar ----------
                Persistent, full-width strip pinned to the bottom of the
                result area. 36px height to match the top status bar.
                Carries:
                  - filter input (left)
                  - row actions: refresh / insert / edit / delete (icons)
                  - export menu (CSV / JSON / SQL / Markdown — anchored)
                  - status push-end: rows · selected · ms · truncated
                  - clear-selection IconButton (only when selection > 0)
                Buttons stay visible at all times; their disabled state
                signals *why* an action is unavailable via tooltip copy
                (`bottomBar.tooltip.disabled.*`). Solid surfaceAlt keeps
                it readable over both light and dark table backgrounds. */}
                  <Box
                    sx={{
                      display: "flex",
                      alignItems: "center",
                      gap: 0.75,
                      px: 1.25,
                      height: 36,
                      borderTop: `1px solid ${theme.palette.divider}`,
                      background: alpha(
                        theme.palette.text.primary,
                        isDark ? 0.04 : 0.025,
                      ),
                      flexShrink: 0,
                    }}
                  >
                    {/* Filter input — sized to fit toolbar height (28px). */}
                    <TextField
                      size="small"
                      placeholder={t("sqlConsole.bottomBar.filter")}
                      value={filter}
                      onChange={(e) => setFilter(e.target.value)}
                      disabled={!result}
                      sx={{
                        width: 240,
                        "& .MuiOutlinedInput-root": {
                          height: 28,
                          background: theme.palette.background.paper,
                        },
                      }}
                      slotProps={{
                        input: {
                          startAdornment: (
                            <InputAdornment position="start">
                              <SearchIcon
                                sx={{
                                  fontSize: 14,
                                  color: theme.palette.text.disabled,
                                }}
                              />
                            </InputAdornment>
                          ),
                          endAdornment: filter ? (
                            <InputAdornment position="end">
                              <IconButton
                                size="small"
                                onClick={() => setFilter("")}
                                aria-label={t("sqlConsole.filterResults")}
                                sx={{ width: 22, height: 22 }}
                              >
                                <CloseIcon sx={{ fontSize: 14 }} />
                              </IconButton>
                            </InputAdornment>
                          ) : null,
                        },
                        htmlInput: {
                          style: { fontSize: 12, padding: "2px 6px" },
                          "aria-label": t("sqlConsole.bottomBar.filter"),
                        },
                      }}
                    />

                    <Divider
                      orientation="vertical"
                      flexItem
                      sx={{ my: 0.75, borderColor: theme.palette.divider }}
                    />

                    {/* Row actions — uniform 28×28 icon buttons. */}
                    <Tooltip title={t("sqlConsole.refresh")} arrow>
                      <span>
                        <IconButton
                          size="small"
                          onClick={() => runQueryWith(lastRanQuery || query)}
                          disabled={running || !lastRanQuery}
                          aria-label={t("sqlConsole.refresh")}
                          sx={{ width: 28, height: 28 }}
                        >
                          <RefreshIcon fontSize="small" />
                        </IconButton>
                      </span>
                    </Tooltip>

                    <Tooltip
                      title={
                        canInsert
                          ? t("sqlConsole.insertRow.tooltip", {
                              table: editable?.table || "",
                            })
                          : t(insertDisabledKey)
                      }
                      arrow
                    >
                      <span>
                        <IconButton
                          size="small"
                          onClick={beginInlineInsert}
                          disabled={!canInsert || Boolean(pendingInsertRow)}
                          aria-label={t("sqlConsole.insertRow")}
                          sx={{ width: 28, height: 28 }}
                        >
                          <AddIcon fontSize="small" />
                        </IconButton>
                      </span>
                    </Tooltip>

                    <Tooltip
                      title={
                        canEdit
                          ? t("sqlConsole.editSelected", {
                              count: selectedRows.size,
                            })
                          : t(editDisabledKey)
                      }
                      arrow
                    >
                      <span>
                        <IconButton
                          size="small"
                          onClick={openMutator}
                          disabled={!canEdit}
                          sx={{
                            width: 28,
                            height: 28,
                            color: canEdit
                              ? theme.palette.primary.main
                              : undefined,
                          }}
                          aria-label={t("sqlConsole.editSelected", {
                            count: selectedRows.size,
                          })}
                        >
                          <EditIcon fontSize="small" />
                        </IconButton>
                      </span>
                    </Tooltip>

                    <Tooltip
                      title={
                        canDelete
                          ? t("sqlConsole.deleteSelected", {
                              count: selectedRows.size,
                            })
                          : t(deleteDisabledKey)
                      }
                      arrow
                    >
                      <span>
                        <IconButton
                          size="small"
                          onClick={() => setDeleteConfirmOpen(true)}
                          disabled={!canDelete || deleting}
                          sx={{
                            width: 28,
                            height: 28,
                            color: canDelete
                              ? theme.palette.error.main
                              : undefined,
                          }}
                          aria-label={t("sqlConsole.deleteSelected", {
                            count: selectedRows.size,
                          })}
                        >
                          <DeleteOutlineIcon fontSize="small" />
                        </IconButton>
                      </span>
                    </Tooltip>

                    <Divider
                      orientation="vertical"
                      flexItem
                      sx={{ my: 0.75, borderColor: theme.palette.divider }}
                    />

                    {/* Export menu — anchored on the icon, opens a 4×download +
                  4×clipboard menu. Disabled when there are no rows. */}
                    <Tooltip title={t("sqlConsole.export.menu")} arrow>
                      <span>
                        <IconButton
                          size="small"
                          onClick={(e) => setExportAnchor(e.currentTarget)}
                          disabled={!result?.rows?.length}
                          aria-label={t("sqlConsole.export.menu")}
                          sx={{
                            height: 28,
                            borderRadius: 1,
                            px: 0.5,
                          }}
                        >
                          <FileDownloadIcon fontSize="small" />
                          <ArrowDropDownIcon sx={{ fontSize: 16, ml: -0.25 }} />
                        </IconButton>
                      </span>
                    </Tooltip>

                    {/* Status push-end. Plain spans (no Chips) — DBeaver-style:
                  compact mono-font row with tabular-nums (so digits don't
                  jiggle as counts update), separators are middots. We
                  always render rows; selection / filter / ms / truncated
                  are conditional so the bar stays clean on simple SELECTs. */}
                    <Box
                      sx={{
                        ml: "auto",
                        display: "flex",
                        alignItems: "center",
                        gap: 0.75,
                        fontSize: 11,
                        color: theme.palette.text.secondary,
                        fontFamily: MONO_FONT,
                        fontVariantNumeric: "tabular-nums",
                        whiteSpace: "nowrap",
                      }}
                    >
                      <span>
                        {t("sqlConsole.statusRows", {
                          rows: formatRowCount(allRows.length),
                        })}
                      </span>
                      {selectedRows.size > 0 && (
                        <>
                          <span style={{ opacity: 0.5 }}>·</span>
                          <Box
                            component="span"
                            sx={{
                              color: theme.palette.primary.main,
                              fontWeight: 700,
                            }}
                          >
                            {t("sqlConsole.statusSelected", {
                              selected: selectedRows.size,
                            })}
                          </Box>
                        </>
                      )}
                      {debouncedFilter.trim() &&
                        filteredRows.length !== allRows.length && (
                          <>
                            <span style={{ opacity: 0.5 }}>·</span>
                            <span>
                              {t("sqlConsole.statusFiltered", {
                                shown: filteredRows.length,
                                total: allRows.length,
                              })}
                            </span>
                          </>
                        )}
                      {typeof result.duration_ms === "number" && (
                        <>
                          <span style={{ opacity: 0.5 }}>·</span>
                          <span>
                            {t("sqlConsole.statusDuration", {
                              ms: result.duration_ms,
                            })}
                          </span>
                        </>
                      )}
                      {result.truncated && (
                        <>
                          <span style={{ opacity: 0.5 }}>·</span>
                          <Box
                            component="span"
                            sx={{
                              color: theme.palette.warning.main,
                              fontWeight: 700,
                            }}
                          >
                            {t("sqlConsole.statusTruncated", { limit: 10000 })}
                          </Box>
                        </>
                      )}
                      {selectedRows.size > 0 && (
                        <Tooltip
                          title={t("sqlConsole.selectionToolbar.clearTooltip")}
                          arrow
                        >
                          <IconButton
                            size="small"
                            onClick={clearSelection}
                            aria-label={t(
                              "sqlConsole.selectionToolbar.clearTooltip",
                            )}
                            sx={{ ml: 0.5 }}
                          >
                            <CloseIcon sx={{ fontSize: 14 }} />
                          </IconButton>
                        </Tooltip>
                      )}
                    </Box>
                  </Box>
                </Box>
              )}
            </Box>
          </Box>
          {/* /Results column */}
        </Box>
        {/* /Results area + Schema sidebar row */}

        {/* ---------- Save preset dialog ---------- */}
        <Dialog
          open={savePresetOpen}
          onClose={() => setSavePresetOpen(false)}
          maxWidth="xs"
          fullWidth
        >
          <DialogTitle>{t("sqlConsole.presetSavePrompt")}</DialogTitle>
          <DialogContent>
            <TextField
              autoFocus
              fullWidth
              value={savePresetName}
              onChange={(e) => setSavePresetName(e.target.value)}
              placeholder="My audit query"
              onKeyDown={(e) => {
                if (e.key === "Enter" && savePresetName.trim()) {
                  e.preventDefault();
                  handleSavePreset();
                }
              }}
              slotProps={{
                htmlInput: {
                  "aria-label": t("sqlConsole.presetSavePrompt"),
                },
              }}
              sx={{ mt: 1 }}
            />
          </DialogContent>
          <DialogActions>
            <Button onClick={() => setSavePresetOpen(false)}>
              {t("app.cancel")}
            </Button>
            <Button
              variant="contained"
              disabled={!savePresetName.trim()}
              onClick={handleSavePreset}
            >
              {t("app.save")}
            </Button>
          </DialogActions>
        </Dialog>

        {/* ---------- Preview-and-confirm dialog ----------
          Opens when a mutation is about to run (UPDATE / INSERT / DELETE /
          REPLACE in edit mode) and the impact is non-trivial. The backend
          /edit/sql/preview returned an aggregate row count plus per-statement
          breakdown. The user reviews and confirms; we then re-issue the same
          SQL with `skipPreview: true` to bypass the gate. Small mutations
          (≤ previewThreshold) skip this dialog entirely for zero friction. */}
        <SqlPreviewDialog
          open={Boolean(previewData)}
          onClose={handlePreviewCancel}
          onConfirm={handlePreviewConfirm}
          previewData={previewData}
          query={previewQuery}
          confirmedLargeMutation={confirmedLargeMutation}
          setConfirmedLargeMutation={setConfirmedLargeMutation}
          running={running}
          t={t}
          language={language}
        />

        {/* ---------- Bulk delete confirm dialog ----------
          GTFS-aware delete confirmation: surfaces (a) the immediate cascade
          fan-out hint when deleting from a parent table (agency/routes/
          trips/stops/calendar), (b) a singleton-required warning when the
          user is about to wipe agency or feed_info entirely. We don't
          pre-compute the actual cascade row counts — the backend reports
          them in the response and we reflect the total in the success
          toast. Ctrl+Z hint mentioned explicitly so the action feels safe. */}
        <Dialog
          open={deleteConfirmOpen}
          onClose={() => (deleting ? null : setDeleteConfirmOpen(false))}
          maxWidth="xs"
          fullWidth
          slotProps={{
            paper: {
              sx: {
                border: `1px solid ${alpha(theme.palette.error.main, 0.3)}`,
                borderLeft: `3px solid ${theme.palette.error.main}`,
              },
            },
          }}
        >
          <DialogTitle
            sx={{
              display: "flex",
              alignItems: "center",
              gap: 1,
              fontSize: 14,
              fontWeight: 700,
              pb: 1,
            }}
          >
            <WarningAmberIcon
              sx={{ fontSize: 20, color: theme.palette.error.main }}
            />
            {t("sqlConsole.deleteConfirm.title", {
              count: selectedRows.size,
              table: editable?.table || "",
            })}
          </DialogTitle>
          <DialogContent dividers sx={{ px: 2.5, py: 2 }}>
            {willEmptySingletonTable && (
              <Alert
                severity="error"
                icon={<WarningAmberIcon fontSize="small" />}
                sx={{ mb: 1.5, py: 0.5, fontSize: 12 }}
              >
                {t("sqlConsole.deleteConfirm.singletonWarning", {
                  table: editable?.table || "",
                })}
              </Alert>
            )}
            {cascadeChildren && cascadeChildren.length > 0 && (
              <Alert
                severity="warning"
                icon={<InfoOutlinedIcon fontSize="small" />}
                sx={{
                  mb: 1.5,
                  py: 0.5,
                  fontSize: 12,
                  "& .MuiAlert-message": {
                    fontFamily: MONO_FONT,
                    fontSize: 11.5,
                  },
                }}
              >
                {t("sqlConsole.deleteConfirm.cascadeWarning", {
                  tables: cascadeChildren.join(", "),
                })}
              </Alert>
            )}
            <Typography
              variant="caption"
              sx={{
                display: "block",
                fontSize: 11.5,
                color: theme.palette.text.secondary,
                fontStyle: "italic",
              }}
            >
              {t("sqlConsole.deleteConfirm.undoHint")}
            </Typography>
          </DialogContent>
          <DialogActions sx={{ px: 2.5, py: 1 }}>
            <Button
              size="small"
              onClick={() => setDeleteConfirmOpen(false)}
              disabled={deleting}
            >
              {t("app.cancel")}
            </Button>
            <Button
              size="small"
              variant="contained"
              color="error"
              startIcon={
                deleting ? (
                  <CircularProgress size={14} color="inherit" />
                ) : (
                  <DeleteForeverIcon />
                )
              }
              onClick={handleDeleteSelected}
              disabled={deleting || willEmptySingletonTable}
            >
              {t("sqlConsole.deleteConfirm.confirmBtn", {
                count: selectedRows.size,
              })}
            </Button>
          </DialogActions>
        </Dialog>

        {/* ---------- Edit row dialog (single) ---------- */}
        {editTarget?.entity === "stop" && (
          <EditStopDialog
            open
            stop={editTarget.row}
            onClose={() => setEditTarget(null)}
          />
        )}
        {editTarget?.entity === "route" && (
          <EditRouteDialog
            open
            route={editTarget.row}
            onClose={() => setEditTarget(null)}
          />
        )}
        {editTarget?.entity === "trip" && (
          <EditTripDialog
            open
            trip={editTarget.row}
            onClose={() => setEditTarget(null)}
          />
        )}

        {/* ---------- Cell copy context menu ----------
          Menu order (top-down): cell-edit (when editable) → delete row
          (when in edit mode + PK present) → divider → copy variants. The
          edit/delete actions are surfaced at the top because they're the
          high-intent actions; copy is the fallback for read-only flows. */}
        <Menu
          open={Boolean(copyMenu)}
          onClose={closeCopyMenu}
          anchorReference="anchorPosition"
          anchorPosition={
            copyMenu ? { top: copyMenu.y, left: copyMenu.x } : undefined
          }
          slotProps={{ paper: { sx: { minWidth: 220 } } }}
        >
          {copyMenu &&
            editing &&
            isCellEditable(copyMenu.col) && [
              <MenuItem key="edit-cell" onClick={handleEditCellFromMenu} dense>
                <ListItemIcon sx={{ minWidth: 32 }}>
                  <EditIcon fontSize="small" />
                </ListItemIcon>
                <ListItemText primary={t("sqlConsole.editCell.contextMenu")} />
              </MenuItem>,
            ]}
          {copyMenu &&
            editing &&
            editable?.isEditable &&
            editable?.pkPresentInColumns && [
              <MenuItem
                key="delete-row"
                onClick={handleDeleteRowFromMenu}
                dense
                sx={{
                  color: theme.palette.error.main,
                  "&:hover": {
                    background: alpha(theme.palette.error.main, 0.08),
                  },
                }}
              >
                <ListItemIcon sx={{ minWidth: 32 }}>
                  <DeleteOutlineIcon
                    fontSize="small"
                    sx={{ color: theme.palette.error.main }}
                  />
                </ListItemIcon>
                <ListItemText primary={t("sqlConsole.deleteRow.contextMenu")} />
              </MenuItem>,
              <Divider key="div-after-edit" sx={{ my: 0.25 }} />,
            ]}
          <MenuItem onClick={handleCopyCell} dense>
            <ListItemIcon sx={{ minWidth: 32 }}>
              <ContentCopyIcon fontSize="small" />
            </ListItemIcon>
            <ListItemText primary={t("sqlConsole.copy.cell")} />
          </MenuItem>
          <MenuItem onClick={handleCopyRowJson} dense>
            <ListItemIcon sx={{ minWidth: 32 }}>
              <DataObjectIcon fontSize="small" />
            </ListItemIcon>
            <ListItemText primary={t("sqlConsole.copy.rowJson")} />
          </MenuItem>
          <MenuItem onClick={handleCopyRowCsv} dense>
            <ListItemIcon sx={{ minWidth: 32 }}>
              <TableViewIcon fontSize="small" />
            </ListItemIcon>
            <ListItemText primary={t("sqlConsole.copy.rowCsv")} />
          </MenuItem>
          <MenuItem onClick={handleCopyRowSql} dense>
            <ListItemIcon sx={{ minWidth: 32 }}>
              <IntegrationInstructionsIcon fontSize="small" />
            </ListItemIcon>
            <ListItemText primary={t("sqlConsole.copy.rowSql")} />
          </MenuItem>
        </Menu>

        {/* ---------- Shortcut help dialog (compact, scoped to SQL Console) */}
        <Dialog
          open={helpOpen}
          onClose={() => setHelpOpen(false)}
          maxWidth="xs"
          fullWidth
          slotProps={{
            paper: {
              sx: {
                border: `1px solid ${alpha(theme.palette.text.primary, 0.08)}`,
                backgroundImage: "none",
              },
            },
          }}
        >
          <DialogTitle
            sx={{
              display: "flex",
              alignItems: "center",
              gap: 1,
              pb: 1,
              fontSize: 14,
              fontWeight: 700,
              letterSpacing: "0.02em",
            }}
          >
            <StorageIcon
              sx={{ fontSize: 16, color: theme.palette.primary.main }}
            />
            {t("sqlConsole.help.title")}
          </DialogTitle>
          <DialogContent dividers sx={{ px: 2.5, py: 1.5 }}>
            {[
              { keys: ["⌘", "↵"], label: t("sqlConsole.kbd.run") },
              { keys: ["⌘", "S"], label: t("sqlConsole.kbd.savePreset") },
              { keys: ["⌘", "L"], label: t("sqlConsole.kbd.clearAll") },
              {
                keys: ["⌘", "1-9"],
                label: t("sqlConsole.help.fileJumpRange"),
              },
              { keys: ["Esc"], label: t("sqlConsole.help.escape") },
              { keys: ["F2"], label: t("sqlConsole.help.f2") },
              { keys: ["⌘", "C"], label: t("sqlConsole.help.copy") },
              { keys: ["?"], label: t("sqlConsole.kbd.help") },
            ].map((row, i) => (
              <Box
                key={i}
                sx={{
                  display: "flex",
                  alignItems: "center",
                  gap: 1,
                  py: 0.625,
                  borderBottom:
                    i === 7
                      ? "none"
                      : `1px solid ${alpha(theme.palette.text.primary, 0.06)}`,
                }}
              >
                <Box
                  sx={{
                    flex: 1,
                    fontSize: 12,
                    color: theme.palette.text.primary,
                  }}
                >
                  {row.label}
                </Box>
                <Box sx={{ display: "inline-flex", gap: 0.25 }}>
                  {row.keys.map((k, j) => (
                    <Kbd key={j} sx={{ ml: 0 }}>
                      {k}
                    </Kbd>
                  ))}
                </Box>
              </Box>
            ))}
          </DialogContent>
          <DialogActions sx={{ px: 2.5, py: 1 }}>
            <Button onClick={() => setHelpOpen(false)} size="small">
              {t("app.cancel")}
            </Button>
          </DialogActions>
        </Dialog>

        {/* ---------- Bottom toolbar: export menu ----------
          4×download + 4×clipboard. Anchored on the FileDownloadIcon button.
          Disabled at the icon level when result has no rows — but we keep
          the menu structure here regardless so the JSX is uncluttered.
          The SQL variants use the editable.table when known, fall back to
          a generic placeholder when the query is read-only. */}
        <Menu
          anchorEl={exportAnchor}
          open={Boolean(exportAnchor)}
          onClose={() => setExportAnchor(null)}
          slotProps={{ paper: { sx: { minWidth: 240 } } }}
        >
          <MenuItem
            dense
            onClick={() => {
              exportCSV();
              setExportAnchor(null);
            }}
          >
            <ListItemIcon sx={{ minWidth: 32 }}>
              <TableViewIcon fontSize="small" />
            </ListItemIcon>
            <ListItemText primary={t("sqlConsole.export.csv")} />
          </MenuItem>
          <MenuItem
            dense
            onClick={() => {
              exportJSON();
              setExportAnchor(null);
            }}
          >
            <ListItemIcon sx={{ minWidth: 32 }}>
              <DataObjectIcon fontSize="small" />
            </ListItemIcon>
            <ListItemText primary={t("sqlConsole.export.json")} />
          </MenuItem>
          <MenuItem
            dense
            onClick={() => {
              exportInsertSql();
              setExportAnchor(null);
            }}
          >
            <ListItemIcon sx={{ minWidth: 32 }}>
              <IntegrationInstructionsIcon fontSize="small" />
            </ListItemIcon>
            <ListItemText primary={t("sqlConsole.export.sql")} />
          </MenuItem>
          <MenuItem
            dense
            onClick={() => {
              exportMarkdown();
              setExportAnchor(null);
            }}
          >
            <ListItemIcon sx={{ minWidth: 32 }}>
              <FormatAlignLeftIcon fontSize="small" />
            </ListItemIcon>
            <ListItemText primary={t("sqlConsole.export.markdown")} />
          </MenuItem>
          <Divider sx={{ my: 0.25 }} />
          <MenuItem
            dense
            onClick={() => {
              copyExportCsv();
              setExportAnchor(null);
            }}
          >
            <ListItemIcon sx={{ minWidth: 32 }}>
              <ContentCopyIcon fontSize="small" />
            </ListItemIcon>
            <ListItemText primary={t("sqlConsole.export.copy.csv")} />
          </MenuItem>
          <MenuItem
            dense
            onClick={() => {
              copyExportJson();
              setExportAnchor(null);
            }}
          >
            <ListItemIcon sx={{ minWidth: 32 }}>
              <ContentCopyIcon fontSize="small" />
            </ListItemIcon>
            <ListItemText primary={t("sqlConsole.export.copy.json")} />
          </MenuItem>
          <MenuItem
            dense
            onClick={() => {
              copyExportSql();
              setExportAnchor(null);
            }}
          >
            <ListItemIcon sx={{ minWidth: 32 }}>
              <ContentCopyIcon fontSize="small" />
            </ListItemIcon>
            <ListItemText primary={t("sqlConsole.export.copy.sql")} />
          </MenuItem>
          <MenuItem
            dense
            onClick={() => {
              copyExportMarkdown();
              setExportAnchor(null);
            }}
          >
            <ListItemIcon sx={{ minWidth: 32 }}>
              <ContentCopyIcon fontSize="small" />
            </ListItemIcon>
            <ListItemText primary={t("sqlConsole.export.copy.markdown")} />
          </MenuItem>
        </Menu>

        {/* ---------- Snackbar ---------- */}
        <Snackbar
          open={Boolean(snack)}
          autoHideDuration={2400}
          onClose={() => setSnack(null)}
          message={snack?.msg}
          anchorOrigin={{ vertical: "bottom", horizontal: "center" }}
          ContentProps={{ "aria-live": "polite" }}
        />
      </Paper>
    </>
  );
}

export default SqlConsole;
