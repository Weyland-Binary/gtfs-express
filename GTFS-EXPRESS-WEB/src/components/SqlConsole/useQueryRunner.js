import { useCallback, useEffect, useRef, useState } from "react";
import API_BASE_URL from "../../config";
import { fetchWithSession } from "../../utils/sessionManager";
import { humanError } from "../../utils/humanError";
import { detectMutation, extractErrorLine } from "./sqlText";
import { SET_QUERY_EVENT } from "../../utils/appEvents";

/**
 * The SQL engine's own sentence (it names the column, the line), or a typed
 * refusal (SESSION_NOT_FOUND) said in the interface's language.
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
  // The opt-in is reset on every opening: one large write's tick never
  // carries over to the next.
  const [previewData, setPreviewData] = useState(null);
  const [previewQuery, setPreviewQuery] = useState("");
  const [confirmedLargeMutation, setConfirmedLargeMutation] = useState(false);

  const [running, setRunning] = useState(false);
  const [result, setResult] = useState(null);
  const [error, setError] = useState(null);
  const [errorLine, setErrorLine] = useState(null);
  const [lastRanQuery, setLastRanQuery] = useState(null);

  const [autoRefresh, setAutoRefresh] = useState(true);

  const sqlEndpoint = editing ? "/edit/sql" : "/sql";

  // A write in edit mode is previewed first; one within previewThreshold runs
  // at once, else the dialog calls back with `skipPreview: true`.
  const runQueryWith = useCallback(
    async (sqlText, options = {}) => {
      const { skipPreview = false, confirmedLargeMutation: confirmed = false } =
        options;
      const trimmed = (sqlText || "").trim();
      if (!trimmed) return;

      // A template's placeholders would otherwise run unseen on a small batch,
      // which skips the preview.
      if (editing && detectMutation(trimmed) && /<[a-z_ ]+>|\bXXXXXX\b|\bOFFSET_SECS\b|\bAGENCY_ID\b/i.test(trimmed)) {
        setError(t("sqlConsole.placeholderGuard"));
        return;
      }

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
          if (
            total <= threshold &&
            !body.exceedsDefaultCap &&
            !body.exceedsConfirmedCap
          ) {
            return runQueryWith(trimmed, { skipPreview: true });
          }
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
        setSelectedRows(new Set());
        setMutatorOpen(false);
        setDeleteConfirmOpen(false);
        pushHistory(trimmed);
        if (body.mutated && body.affected != null) {
          // #17: without it no other panel refetches after a free-form write.
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

  // The values are read before closing the dialog clears them.
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

  // On first mount. A seeded write only fills the editor: it may carry a
  // placeholder, and it goes through the preview on Run.
  const didFirstMountAutorunRef = useRef(false);
  useEffect(() => {
    if (didFirstMountAutorunRef.current) return;
    if (result !== null) {
      didFirstMountAutorunRef.current = true;
      return;
    }
    if (!counts || (counts.routes ?? 0) <= 0) return; // wait for feed
    didFirstMountAutorunRef.current = true;
    if (query !== "") {
      if (detectMutation(query)) {
        return;
      }
      runQueryWith(query);
    } else {
      const sql = "SELECT * FROM routes;";
      setQuery(sql);
      runQueryWith(sql);
    }
  }, [counts, query, result, runQueryWith, setQuery]);

  // A write is never replayed: its recordEdit() would bump dataVersion again,
  // an endless loop. A change that lands while a query runs is replayed once it ends.
  const lastDataVersionRef = useRef(dataVersion);
  useEffect(() => {
    if (lastDataVersionRef.current === dataVersion || running) return;
    lastDataVersionRef.current = dataVersion;
    if (autoRefresh && lastRanQuery && !detectMutation(lastRanQuery)) {
      runQueryWith(lastRanQuery);
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
