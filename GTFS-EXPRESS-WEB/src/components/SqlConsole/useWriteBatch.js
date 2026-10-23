import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import API_BASE_URL from "../../config";
import { fetchWithSession } from "../../utils/sessionManager";
import {
  EDITABLE_FIELDS,
  PATCH_ENDPOINTS,
  SQL_FALLBACK_TABLES,
  PARENT_CASCADE_TABLES,
  SINGLETON_REQUIRED_TABLES,
} from "./editableFields";
import {
  sqlQuote,
  buildInsertSql,
  buildBulkUpdateSql,
  buildBulkUpdateSqlFull,
  buildBulkDeleteSqlFull,
} from "./sqlBuilders";
import { validateFieldValue } from "./fieldValidation";
import { refusedText } from "./useQueryRunner";

/**
 * Every write the console sends from its grid (the mutator, the bulk delete,
 * the inline insert, a cell's edit), each through POST /edit/sql or the
 * entity's PATCH and recorded by recordEdit (#17), one undo entry each.
 */
export default function useWriteBatch({
  editing,
  editable,
  cellEditableEntity,
  result,
  lastRanQuery,
  selectedRows,
  setSelectedRows,
  setMutatorOpen,
  setDeleteConfirmOpen,
  setQuery,
  setError,
  showSnack,
  recordEdit,
  t,
  pkAccessor,
}) {
  const [mutatorColumn, setMutatorColumn] = useState("");
  const [mutatorValue, setMutatorValue] = useState("");
  const [mutatorApplying, setMutatorApplying] = useState(false);

  const [deleting, setDeleting] = useState(false);

  // { values: { [col]: string }, errors: { [col]: string },
  //   position: "after-selected" | "end", anchorId: string|null }
  const [pendingInsertRow, setPendingInsertRow] = useState(null);
  const [insertSubmitting, setInsertSubmitting] = useState(false);
  const pendingInsertFirstInputRef = useRef(null);
  // Focus once per draft: every keystroke makes a new pendingInsertRow, and
  // refocusing would steal the cursor from the field being typed in.
  const pendingInsertFocusedRef = useRef(false);

  // cellStatus: { [rowId-column]: "saving" | "saved" | "error" }
  const [editingCell, setEditingCell] = useState(null);
  const [cellInputValue, setCellInputValue] = useState("");
  const [cellStatus, setCellStatus] = useState({});
  const cellInputRef = useRef(null);

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
    setQuery,
    setMutatorOpen,
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
        setError(refusedText(body, res.status, t) || t("sqlConsole.queryError"));
        return;
      }
      // The dataVersion bump re-runs the last SELECT.
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
    setError,
    setMutatorOpen,
    setSelectedRows,
  ]);

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

  const cascadeChildren = useMemo(() => {
    if (!editable?.table) return null;
    return PARENT_CASCADE_TABLES[editable.table] || null;
  }, [editable]);

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

  const canEdit = useMemo(
    () => Boolean(editing && cellEditableEntity && selectedRows.size > 0),
    [editing, cellEditableEntity, selectedRows.size],
  );

  // The key that says why a button is greyed out.
  const insertDisabledKey = !editing
    ? "sqlConsole.bottomBar.tooltip.disabled.readMode"
    : "sqlConsole.bottomBar.tooltip.disabled.notEditable";
  const editDisabledKey = !editing
    ? "sqlConsole.bottomBar.tooltip.disabled.readMode"
    : selectedRows.size === 0
      ? "sqlConsole.bottomBar.tooltip.disabled.noSelection"
      : "sqlConsole.bottomBar.tooltip.disabled.notEditable";
  const deleteDisabledKey = editDisabledKey;

  // agency and feed_info keep at least one row: the server refuses, the
  // dialog says why first.
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
        setError(refusedText(body, res.status, t) || t("sqlConsole.queryError"));
        return;
      }
      const directCount = selectedRows.size;
      const totalAffected =
        typeof body.affected === "number" ? body.affected : directCount;
      const tableName = editable.table;
      // The server logs the cascade as one _edit_log entry: one Ctrl+Z.
      recordEdit?.(t("sqlConsole.deleted.recorded", { count: directCount, table: tableName }), body.validation, {
        entity: "sql_console",
        entityId: tableName,
      });
      // The cascade's rows are named before a Ctrl+Z.
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
  }, [
    canDelete,
    editable,
    selectedRows,
    t,
    showSnack,
    recordEdit,
    setError,
    setDeleteConfirmOpen,
    setSelectedRows,
    setMutatorOpen,
  ]);

  // Gated by canEdit upstream; the disabled state is purely visual.
  const openMutator = useCallback(() => {
    setMutatorOpen((v) => !v);
  }, [setMutatorOpen]);

  // One draft at a time; after the selected row when there is exactly one.
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

    // Assigned by the server at INSERT: shown as disabled "auto" cells.
    const AUTO_ASSIGNED_PK = {
      transfers: new Set(["id"]),
      attributions: new Set(["attribution_id"]),
    };
    const autoSet = AUTO_ASSIGNED_PK[tbl] || new Set();

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
        // The draft stays for a correction.
        const msg = body.error || t("sqlConsole.queryError");
        setError(msg);
        showSnack(msg);
        return;
      }
      recordEdit?.(t("sqlConsole.insertRow.success", { table: tbl }), body.validation, {
        entity: "sql_console",
        entityId: tbl,
      });
      showSnack(t("sqlConsole.insertRow.success", { table: tbl }));
      setPendingInsertRow(null);
      setSelectedRows(new Set());
      // recordEdit's dataVersion bump re-runs lastRanQuery (useQueryRunner): no second run here.
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
    setError,
    setSelectedRows,
  ]);

  // A stale draft would no longer match the columns shown.
  useEffect(() => {
    setPendingInsertRow(null);
  }, [editable?.table, lastRanQuery]);

  // Once per draft (see pendingInsertFocusedRef).
  useEffect(() => {
    if (!pendingInsertRow) {
      pendingInsertFocusedRef.current = false;
      return;
    }
    if (pendingInsertFocusedRef.current) return;
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

  // A key column is never edited inline: its cascades need a dedicated dialog.
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

  // Through the entity's PATCH, else an UPDATE on /edit/sql for the SQL
  // fallback tables: one Ctrl+Z entry either way.
  const commitCellEdit = useCallback(
    async (row, column, rawValue) => {
      const entity = editable?.entity;
      const table = editable?.table;
      if (!entity || !table) return;

      // pkAccessor returns null on a singleton (feed_info).
      const id = pkAccessor(row);
      const cellKey = `${id ?? `_row_${column}`}-${column}`;

      const previous = row[column] == null ? "" : String(row[column]);
      if (rawValue === previous) {
        cancelCellEdit();
        return;
      }

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
          t("sqlConsole.cell.updatedToast", { column, entity, id: id ?? table }),
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
  return {
    mutatorColumn,
    setMutatorColumn,
    mutatorValue,
    setMutatorValue,
    mutatorApplying,
    mutatorEditableFields,
    mutatorFieldDef,
    generatedMutatorPreview,
    handleMutatorInsertInEditor,
    handleMutatorApply,
    canDelete,
    cascadeChildren,
    canInsert,
    canEdit,
    insertDisabledKey,
    editDisabledKey,
    deleteDisabledKey,
    willEmptySingletonTable,
    deleting,
    handleDeleteSelected,
    openMutator,
    pendingInsertRow,
    insertSubmitting,
    pendingInsertFirstInputRef,
    beginInlineInsert,
    cancelInlineInsert,
    updatePendingInsertValue,
    commitInlineInsert,
    editableColumnsConfig,
    isCellEditable,
    editingCell,
    cellInputValue,
    setCellInputValue,
    cellStatus,
    cellInputRef,
    beginCellEdit,
    cancelCellEdit,
    commitCellEdit,
  };
}
