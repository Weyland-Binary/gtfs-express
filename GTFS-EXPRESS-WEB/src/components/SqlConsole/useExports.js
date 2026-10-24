import { useCallback } from "react";
import API_BASE_URL from "../../config";
import { fetchWithSession } from "../../utils/sessionManager";
import {
  toCSV,
  toJSON,
  toMarkdown,
  toInsertSqlAll,
  downloadAs,
} from "./exporters";
import { refusedText } from "./useQueryRunner";

/** `lastRanQuery`: the query that produced the rows on screen; the editor's text only when nothing ran yet. */
export default function useExports({ query, lastRanQuery = null, result, editable, showSnack, t }) {
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

  // The server streams the whole result (no row cap); when it refuses (a
  // batch, a write, a network error) the rows on screen are the file.
  const exportCSV = useCallback(async () => {
    // The editor may hold a query never run: the file is the result shown.
    const text = (lastRanQuery || query || "").trim();
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
      if (fallbackInMemory()) return;
      let msg = t("sqlConsole.export.csvStreamFailed");
      try {
        const body = await res.json();
        if (body?.error) msg = refusedText(body, res.status, t) || body.error;
      } catch {
        /* non-JSON body */
      }
      showSnack(msg);
    } catch (err) {
      console.error("CSV export failed, falling back to in-memory:", err);
      if (fallbackInMemory()) return;
      showSnack(t("sqlConsole.export.csvStreamFailed"));
    }
  }, [query, lastRanQuery, result, exportFilenameStem, showSnack, t]);

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
  return {
    exportJSON,
    exportCSV,
    exportInsertSql,
    exportMarkdown,
    copyExportCsv,
    copyExportJson,
    copyExportSql,
    copyExportMarkdown,
  };
}
