import React, { useCallback, useState } from "react";
import {
  Box,
  Divider,
  ListItemIcon,
  ListItemText,
  Menu,
  MenuItem,
  Tooltip,
} from "@mui/material";
import { alpha, useTheme } from "@mui/material/styles";
import EditIcon from "@mui/icons-material/Edit";
import DeleteOutlineIcon from "@mui/icons-material/DeleteOutline";
import ContentCopyIcon from "@mui/icons-material/ContentCopy";
import DataObjectIcon from "@mui/icons-material/DataObject";
import TableViewIcon from "@mui/icons-material/TableView";
import IntegrationInstructionsIcon from "@mui/icons-material/IntegrationInstructions";
import ArrowUpwardIcon from "@mui/icons-material/ArrowUpward";
import ArrowDownwardIcon from "@mui/icons-material/ArrowDownward";
import UnfoldMoreIcon from "@mui/icons-material/UnfoldMore";
import { MONO_FONT } from "./constants";
import { EDITABLE_FIELDS } from "./editableFields";
import { toCSV } from "./exporters";
import { buildInsertSql } from "./sqlBuilders";
import { inferColumnType, TYPE_TO_COLOR } from "./sqlText";
import SqlInsertDraftRow from "./SqlInsertDraftRow";
import SqlResultRow from "./SqlResultRow";

/**
 * ResultGrid — the console's result table: a sticky header row (one cell per
 * column with its inferred type, the primary key marked, the sort cycle
 * asc → desc → none on click), the selection column in edit mode, one
 * SqlResultRow per visible row (the incremental window the caller's scroll
 * handler widens), the inline insert's draft row after its anchor or at the
 * end, and the cap notice when the window is shorter than the sorted rows.
 * Every row-level handler comes from the caller as a stable callback so
 * SqlResultRow's React.memo holds across renders that change nothing of a row.
 * The grid renders nothing without rows: the caller shows the empty states.
 */
export default function ResultGrid({
  tableScrollRef,
  handleTableScroll,
  allRows,
  allColumns,
  visibleRows,
  sortedRows,
  sortBy,
  handleSortColumn,
  editable,
  cellEditableEntity,
  entityForEdit,
  editing,
  pkAccessor,
  selectedRows,
  toggleRow,
  toggleAllVisible,
  pendingInsertRow,
  insertSubmitting,
  updatePendingInsertValue,
  commitInlineInsert,
  cancelInlineInsert,
  pendingInsertFirstInputRef,
  editingCell,
  cellStatus,
  cellInputValue,
  cellInputRef,
  setCellInputValue,
  isCellEditable,
  editableColumnsConfig,
  beginCellEdit,
  commitCellEdit,
  cancelCellEdit,
  handleEditRowFromTable,
  handleCellContextMenu,
  tLabel,
  t,
}) {
  const theme = useTheme();
  const isDark = theme.palette.mode === "dark";
  return (
    <>
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
        right-click hint lives in the bottom toolbar (status
        push-end side) so two micro-footers never stack. */}
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
    </>
  );
}

/**
 * useCopyMenu — the right-click menu on a cell: where it opened and on what
 * (`copyMenu`), the clipboard copies (the cell, the row as JSON, CSV or an
 * INSERT), and the two edit-mode actions that reuse the console's own paths —
 * « delete this row » selects that row alone and opens the bulk delete's
 * confirm (one undo entry, one cascade pipeline, one toast), « edit this
 * cell » enters the inline editor as a double-click would.
 */
export function useCopyMenu({
  allColumns,
  editable,
  showSnack,
  t,
  canDelete,
  editing,
  pkAccessor,
  setSelectedRows,
  setDeleteConfirmOpen,
  beginCellEdit,
}) {
  /* --- copy context menu (right-click on cell/row) --------------- */
  const [copyMenu, setCopyMenu] = useState(null); // { x, y, row, col }
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

  const handleCellContextMenu = useCallback((e, row, col) => {
    setCopyMenu({ x: e.clientX, y: e.clientY, row, col });
  }, []);

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
  }, [
    copyMenu,
    canDelete,
    editing,
    editable,
    pkAccessor,
    closeCopyMenu,
    setSelectedRows,
    setDeleteConfirmOpen,
  ]);

  // "Edit this cell" right-click action — focuses the cell and enters the
  // inline editor (same as a double-click). Available only when the column is
  // editable AND we're in edit mode.
  const handleEditCellFromMenu = useCallback(() => {
    if (!copyMenu?.row || !copyMenu?.col) return;
    beginCellEdit(copyMenu.row, copyMenu.col);
    closeCopyMenu();
  }, [copyMenu, beginCellEdit, closeCopyMenu]);

  return {
    copyMenu,
    closeCopyMenu,
    handleCellContextMenu,
    handleCopyCell,
    handleCopyRowJson,
    handleCopyRowCsv,
    handleCopyRowSql,
    handleDeleteRowFromMenu,
    handleEditCellFromMenu,
  };
}

/**
 * CopyMenu — the menu useCopyMenu drives, anchored at the pointer. Menu order
 * (top-down): cell-edit (when editable) → delete row (when in edit mode + PK
 * present) → divider → copy variants: the high-intent actions first, copy as
 * the fallback for read-only flows.
 */
export function CopyMenu({
  copyMenu,
  closeCopyMenu,
  editing,
  editable,
  isCellEditable,
  handleEditCellFromMenu,
  handleDeleteRowFromMenu,
  handleCopyCell,
  handleCopyRowJson,
  handleCopyRowCsv,
  handleCopyRowSql,
  t,
}) {
  const theme = useTheme();
  return (
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
  );
}
