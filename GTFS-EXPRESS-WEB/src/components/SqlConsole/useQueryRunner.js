import { useCallback, useEffect, useRef, useState } from "react";
import API_BASE_URL from "../../config";
import { fetchWithSession } from "../../utils/sessionManager";
import { humanError } from "../../utils/humanError";
import { SET_QUERY_EVENT } from "./constants";
import { detectMutation, extractErrorLine } from "./sqlText";

/**
 * useQueryRunner — the console's query execution and its state: the run on
 * /sql (read) or /edit/sql (edit mode), the preview-and-confirm gate a
 * mutation goes through first (POST /edit/sql/preview, the SqlPreviewDialog's
 * state and its confirm / cancel), the error strip's text and the editor's
 * error line (a refusal — SQL_TIMEOUT, BUSY, SQL_UNBOUNDED, an expired working
 * copy — said in the interface's language through humanError), the last query
 * run, and the three effects around a run: the `gtfs:sql-set-query` event
 * other screens send, the first mount's `SELECT * FROM routes;`, and the
 * replay of the last SELECT when dataVersion advances (auto-refresh, toggleable).
 * The editor's text (`query`) stays the caller's: presets, the history, the
 * assistant and the mutator all write it. The caller resets its selection and
 * folds its panels when a result lands (the setters passed in), and records the
 * query in the history (`pushHistory`).
 */

/**
 * The words of a refused query: the SQL engine's own sentence (it names the
 * column, the line), or — for a typed refusal such as a working copy that
 * expired (SESSION_NOT_FOUND) — the refusal said in the interface's language.
 */
export const refusedText = (body, status, t) => (body?.code && body?.code === body?.error ? humanError({ code: body.code, status, message: body.message }, t)?.message : body?.error) || null;

export default function useQueryRunner({
  query,
  setQuery,
  editing,
  counts,
  dataVersion,
  recordEdit,
  t,
  setSelectedRows,
  setMutatorOpen,
  setDeleteConfirmOpen,
  pushHistory,
}) {
  /* --- preview-and-confirm state --------------------------------- */
  // Holds the response from POST /edit/sql/preview while the modal is
  // open. Null means "no pending preview" — the user is either looking
  // at results or in the middle of a normal flow. The confirm checkbox
  // is reset on every dialog open so an opt-in from a previous large
  // mutation doesn't leak into the next one.
  const [previewData, setPreviewData] = useState(null);
  const [previewQuery, setPreviewQuery] = useState("");
  const [confirmedLargeMutation, setConfirmedLargeMutation] = useState(false);

  const [running, setRunning] = useState(false);
  const [result, setResult] = useState(null);
  const [error, setError] = useState(null);
  const [errorLine, setErrorLine] = useState(null);
  const [lastRanQuery, setLastRanQuery] = useState(null);

  /* --- auto-refresh on dataVersion bump (toggleable) ------------- */
  const [autoRefresh, setAutoRefresh] = useState(true);

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

      // Template guard: presets and "Fix in SQL Console" seed queries with
      // placeholders such as '<value>' / 'XXXXXX' / OFFSET_SECS that the user
      // must replace. A mutation still carrying one would otherwise run
      // silently on ≤50 rows (the preview gate auto-bypasses small batches).
      if (editing && detectMutation(trimmed) && /<[a-z_ ]+>|\bXXXXXX\b|\bOFFSET_SECS\b|\bAGENCY_ID\b/i.test(trimmed)) {
        setError(t("sqlConsole.placeholderGuard"));
        return;
      }

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
              refusedText(body, res.status, t) ||
              t("sqlConsole.preview.previewError", {
                error: t("sqlConsole.queryError"),
              });
            setError(t("sqlConsole.preview.previewError", { error: msg }));
            setErrorLine(extractErrorLine(msg));
            return;
          }
          const total = Number(body.totalAffected) || 0;
          const threshold = Number(body.previewThreshold) || 50;
          // Auto-bypass for tiny mutations — keeps single-row UPDATEs
          // zero-friction.
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
          const msg = refusedText(body, res.status, t) || t("sqlConsole.queryError");
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
        pushHistory(trimmed);
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
    [
      sqlEndpoint,
      editing,
      t,
      recordEdit,
      pushHistory,
      setSelectedRows,
      setMutatorOpen,
      setDeleteConfirmOpen,
    ],
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
  }, [runQueryWith, setQuery]);

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
  }, [counts, query, result, runQueryWith, setQuery]);

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

  return {
    running,
    result,
    setResult,
    error,
    setError,
    errorLine,
    lastRanQuery,
    setLastRanQuery,
    autoRefresh,
    setAutoRefresh,
    runQueryWith,
    runQuery,
    previewData,
    previewQuery,
    confirmedLargeMutation,
    setConfirmedLargeMutation,
    handlePreviewConfirm,
    handlePreviewCancel,
  };
}
