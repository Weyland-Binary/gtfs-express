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
 * The console's result table. Every row-level handler comes from the caller as
 * a stable callback so SqlResultRow's React.memo holds across renders.
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
      {/* The container is the scroll viewport that keeps <thead> sticky;
        minHeight: 0 lets it shrink inside its flex parent. */}
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
                // An opaque base under the tint: scrolling rows would
                // otherwise bleed through the sticky header.
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
              // The cells are tinted, not the <tr>, so the sticky row-number
              // column follows the hover; the selection's inline style wins.
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
                {/* Opaque: this cell is sticky on both axes, so any
              transparency lets the content bleed through. */}
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
                  const ariaSort = isSorted
                    ? sortDir === "asc"
                      ? "ascending"
                      : "descending"
                    : "none";
                  // The tooltip names the next state of the cycle.
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

                // At the end when there is no anchor or it is not shown.
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

/** The right-click menu on a cell: the clipboard copies and, in edit mode, delete the row or edit the cell. */
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
  const [copyMenu, setCopyMenu] = useState(null); // { x, y, row, col }
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

  // Goes through the bulk delete's confirm with that row alone selected:
  // one path, one undo entry, one cascade pipeline.
  const handleDeleteRowFromMenu = useCallback(() => {
    if (!copyMenu?.row || !canDelete) {
      // canDelete follows the selection, which may be empty here.
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
