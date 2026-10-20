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

/**
 * useExports — the result as a file or on the clipboard: CSV (streamed by the
 * server without a row cap when it accepts the query, else the rows on
 * screen), JSON, INSERT statements on the editable table, Markdown; the same
 * four copied, each with its toast. File names say the table when the result
 * is one table's, else a timestamped generic stem.
 */
export default function useExports({ query, result, editable, showSnack, t }) {
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
