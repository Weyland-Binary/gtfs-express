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
 * useWriteBatch — every write the console sends from its grid, each on the
 * engine's own path (POST /edit/sql, or the entity's PATCH) and recorded by
 * recordEdit so the rest of the app refetches and Ctrl+Z holds one entry:
 *   - the mutator: one column set on the selected rows (its generated UPDATE
 *     previewed, applied, or put in the editor to be run through the
 *     preview gate);
 *   - the bulk delete of the selection, with the cascade and singleton
 *     warnings the confirm dialog shows;
 *   - the inline insert: a draft row validated on the client (required keys,
 *     auto-assigned identifiers left out) then INSERTed;
 *   - a cell's edit on double-click: validated, PATCHed or UPDATEd through
 *     the table's SQL fallback, with the saving / saved / error flash;
 *   - and what each allows (canInsert, canEdit, canDelete) with the key that
 *     says why a button is greyed out.
 * The free-form statement's own preview gate is the runner's (useQueryRunner).
 * The panels' open flags (mutatorOpen, deleteConfirmOpen) and the selection
 * stay the caller's: the runner folds them when a result lands.
 */
export default function useWriteBatch({
  editing,
  editable,
  cellEditableEntity,
  result,
  lastRanQuery,
  runQueryWith,
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
  /* --- inline mutator state -------------------------------------- */
  const [mutatorColumn, setMutatorColumn] = useState("");
  const [mutatorValue, setMutatorValue] = useState("");
  const [mutatorApplying, setMutatorApplying] = useState(false);

  /* --- bulk delete state ----------------------------------------- */
  const [deleting, setDeleting] = useState(false);

  /* --- inline insert state --------------------------------------- */
  // Inline insert. When non-null,
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
    setError,
    setMutatorOpen,
    setSelectedRows,
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

  // canEdit: bottom-bar Edit button (opens the mutator) — requires a
  // selection.
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
        setError(refusedText(body, res.status, t) || t("sqlConsole.queryError"));
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

  /* --- bottom toolbar: open mutator from edit IconButton --------- */
  // Bottom-bar Edit button is a thin wrapper that toggles the mutator panel.
  // Selection / editability gating happens upstream via canEdit; the handler
  // is intentionally permissive so disabled state is purely visual.
  const openMutator = useCallback(() => {
    setMutatorOpen((v) => !v);
  }, [setMutatorOpen]);

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
    setError,
    setSelectedRows,
  ]);

  // Drop the draft row whenever the underlying result/table changes. This
  // avoids a stale draft that no longer matches the visible columns.
  useEffect(() => {
    setPendingInsertRow(null);
  }, [editable?.table, lastRanQuery]);

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

  /* --- cell editing: double-click → input → PATCH --------------- */
  // Cell-edit configuration: keyed by column → field-def. Only columns listed
  // in EDITABLE_FIELDS are editable, and only when:
  //   - we're in edit mode
  //   - the result set carries a known PK column
  //   - the column is not a PK (composite or single): PKs are never edited
  //     inline; use a dedicated dialog with cascade tooling
  // For singleton tables (feed_info) every editable field is exposed.
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
