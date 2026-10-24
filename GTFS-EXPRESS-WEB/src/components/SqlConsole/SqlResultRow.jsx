import React from "react";
import { Box } from "@mui/material";
import { alpha } from "@mui/material/styles";
import { URL_RE, TIME_RE, FK_COLUMN_RE } from "./constants";
import { getEnumLabel } from "./sqlText";

/**
 * One result row as a plain <tr>: MUI Box would inject emotion styles per cell
 * (15 000 for 1000 rows × 15 columns). Every prop is primitive or stable so
 * React.memo's shallow compare holds.
 */
const SqlResultRow = React.memo(function SqlResultRow({
  row,
  rowIndex,
  columns,
  showSelection,
  // The pencil button: only the entities that have a dedicated Edit*Dialog.
  showRowDialog,
  editingCell,
  cellStatus,
  isChecked,
  cellInputValue,
  cellInputRef,
  pkAccessor,
  pkColumn,
  isCellEditable,
  editableColumnsConfig,
  beginCellEdit,
  commitCellEdit,
  cancelCellEdit,
  setCellInputValue,
  onToggle,
  onEditRow,
  onContextMenu,
  tLabel,
  monoFont,
  palette,
  isDark,
}) {
  const id = pkAccessor(row);

  const zebraBg =
    rowIndex % 2 === 1
      ? isDark
        ? alpha(palette.common.white, 0.02)
        : alpha(palette.text.primary, 0.025)
      : "transparent";
  const trStyle = {
    backgroundColor: isChecked ? alpha(palette.primary.main, 0.1) : zebraBg,
  };

  return (
    <tr style={trStyle} data-zebra={rowIndex % 2 === 1 ? "1" : "0"}>
      <td
        className="sql-rownum-cell"
        onClick={() => onToggle(row)}
        title={tLabel("selectRow")}
        style={{
          width: 48,
          minWidth: 48,
          maxWidth: 48,
          textAlign: "right",
          paddingRight: 8,
          paddingLeft: 4,
          fontFamily: monoFont,
          fontSize: 11,
          color: palette.text.disabled,
          cursor: id ? "pointer" : "default",
          userSelect: "none",
          // Opaque, or the data cells bleed through on a horizontal scroll.
          background: palette.background.paper,
          borderRight: `1px solid ${palette.divider}`,
          position: "sticky",
          left: 0,
          zIndex: 1,
        }}
      >
        {rowIndex + 1}
      </td>
      {showSelection && (
        <td>
          <input
            type="checkbox"
            aria-label={tLabel("selectRow")}
            checked={isChecked}
            onChange={() => onToggle(row)}
          />
        </td>
      )}
      {columns.map((c) => {
        const cellKey = id ? `${id}-${c}` : null;
        const status = cellKey ? cellStatus[cellKey] : null;
        const isEditingThisCell =
          editingCell?.rowId === id && editingCell?.column === c;
        const cellEditable = isCellEditable(c);
        const fieldDef = editableColumnsConfig?.[c];

        const outlineColor =
          status === "saving"
            ? palette.primary.main
            : status === "saved"
              ? palette.success.main
              : status === "error"
                ? palette.error.main
                : null;

        const tdStyle = {
          cursor: cellEditable ? "cell" : "default",
          outline: outlineColor ? `2px solid ${outlineColor}` : "none",
          outlineOffset: "-2px",
          transition:
            "outline-color 600ms ease-out, background-color 120ms ease-out",
          maxWidth: 320,
          overflow: "hidden",
          textOverflow: "ellipsis",
          ...(isEditingThisCell
            ? {
                backgroundColor: isDark
                  ? "rgba(99,102,241,0.18)"
                  : "rgba(99,102,241,0.12)",
              }
            : {}),
        };

        if (isEditingThisCell && fieldDef?.type === "enum") {
          return (
            <td key={c} style={tdStyle}>
              <select
                // eslint-disable-next-line jsx-a11y/no-autofocus -- the cell the person just opened for editing
                autoFocus
                value={cellInputValue}
                ref={cellInputRef}
                style={{
                  width: "100%",
                  fontFamily: monoFont,
                  fontSize: 12,
                  border: "none",
                  outline: "none",
                  background: "transparent",
                  color: palette.text.primary,
                  padding: 0,
                  appearance: "auto",
                }}
                onChange={(e) => {
                  setCellInputValue(e.target.value);
                  commitCellEdit(row, c, e.target.value);
                }}
                onBlur={() => cancelCellEdit()}
              >
                {/* A required enum field offers no NULL. */}
                {!fieldDef.required && <option value="">NULL</option>}
                {(fieldDef.options || []).map((o) => (
                  <option key={o.value} value={o.value}>
                    {o.label}
                  </option>
                ))}
              </select>
            </td>
          );
        }

        if (isEditingThisCell) {
          const inputType = (() => {
            switch (fieldDef?.type) {
              case "number":
                return "number";
              case "url":
                return "url";
              case "email":
                return "email";
              // Time and date stay text: GTFS writes HH:MM:SS past 24 and YYYYMMDD.
              default:
                return "text";
            }
          })();
          const isColor = fieldDef?.type === "color";
          const colorPreview = isColor
            ? `#${String(cellInputValue || "")
                .replace(/^#/, "")
                .slice(0, 6)}`
            : null;
          return (
            <td key={c} style={tdStyle}>
              <Box
                sx={{
                  display: "flex",
                  alignItems: "center",
                  gap: isColor ? 0.5 : 0,
                  width: "100%",
                  height: "100%",
                }}
              >
                {isColor && (
                  <Box
                    aria-hidden
                    sx={{
                      width: 12,
                      height: 12,
                      flexShrink: 0,
                      border: `1px solid ${alpha(palette.text.primary, 0.2)}`,
                      borderRadius: "2px",
                      background: /^#[0-9A-Fa-f]{6}$/.test(colorPreview)
                        ? colorPreview
                        : "transparent",
                    }}
                  />
                )}
                <input
                  // eslint-disable-next-line jsx-a11y/no-autofocus -- the cell the person just opened for editing
                  autoFocus
                  type={inputType}
                  value={cellInputValue}
                  ref={cellInputRef}
                  onChange={(e) => setCellInputValue(e.target.value)}
                  onBlur={() => commitCellEdit(row, c, cellInputValue)}
                  onKeyDown={(e) => {
                    if (e.key === "Enter") {
                      e.preventDefault();
                      commitCellEdit(row, c, cellInputValue);
                    } else if (e.key === "Escape") {
                      e.preventDefault();
                      cancelCellEdit();
                    }
                  }}
                  aria-label={`${c} ${tLabel("cell.editing")}`}
                  inputMode={
                    fieldDef?.type === "time" || fieldDef?.type === "date"
                      ? "numeric"
                      : undefined
                  }
                  placeholder={
                    fieldDef?.type === "time"
                      ? "HH:MM:SS"
                      : fieldDef?.type === "date"
                        ? "YYYYMMDD"
                        : fieldDef?.type === "color"
                          ? "RRGGBB"
                          : undefined
                  }
                  style={{
                    width: "100%",
                    height: "100%",
                    border: "none",
                    outline: "none",
                    background: "transparent",
                    fontFamily: monoFont,
                    fontSize: "inherit",
                    color: palette.text.primary,
                    padding: 0,
                    margin: 0,
                    lineHeight: "inherit",
                    boxSizing: "border-box",
                    display: "block",
                    MozAppearance:
                      fieldDef?.type === "number" ? "textfield" : undefined,
                  }}
                />
              </Box>
            </td>
          );
        }

        const rawValue = row[c];
        const displayValue = rawValue == null ? null : String(rawValue);
        const isPk = pkColumn && c === pkColumn;
        const isUrl = displayValue && URL_RE.test(displayValue);
        const isTime = displayValue && TIME_RE.test(displayValue);
        const enumLabel = getEnumLabel(c, rawValue);
        const isFkLike = !isPk && FK_COLUMN_RE.test(c) && displayValue;
        const isJustSaved = status === "saved";
        const isJustErrored = status === "error";

        const fgColor = isPk
          ? palette.primary.main
          : isFkLike
            ? palette.info.main
            : isUrl
              ? palette.info.main
              : "inherit";
        const fontWeight = isPk ? 600 : 400;
        const fontFeatureSettings = isTime ? '"tnum" 1' : undefined;

        const tdStyleSmart = {
          ...tdStyle,
          ...(isJustSaved && {
            animation: "sqlFlashSaved 600ms ease-out",
          }),
          ...(isJustErrored && {
            animation: "sqlFlashError 600ms ease-out",
          }),
        };

        return (
          <td
            key={c}
            className={
              cellEditable && !isEditingThisCell
                ? "sql-cell-editable"
                : undefined
            }
            style={tdStyleSmart}
            onDoubleClick={() => beginCellEdit(row, c)}
            onContextMenu={(e) => {
              e.preventDefault();
              onContextMenu(e, row, c);
            }}
            title={
              displayValue && displayValue.length > 60
                ? displayValue
                : undefined
            }
          >
            {status === "saving" && (
              <span
                style={{
                  display: "inline-block",
                  width: 10,
                  height: 10,
                  marginRight: 4,
                  verticalAlign: "middle",
                  borderRadius: "50%",
                  border: `2px solid ${palette.primary.main}`,
                  borderTopColor: "transparent",
                  animation: "spin 0.7s linear infinite",
                }}
              />
            )}
            {displayValue == null ? (
              <span style={{ opacity: 0.4, fontStyle: "italic" }}>·</span>
            ) : isUrl ? (
              <a
                href={displayValue}
                target="_blank"
                rel="noopener noreferrer"
                style={{
                  color: fgColor,
                  textDecoration: "none",
                  borderBottom: `1px dotted ${alpha(palette.info.main, 0.4)}`,
                }}
                onClick={(e) => e.stopPropagation()}
              >
                {displayValue}
              </a>
            ) : enumLabel ? (
              <span
                style={{
                  display: "inline-flex",
                  alignItems: "center",
                  gap: 4,
                  color: palette.text.primary,
                }}
              >
                <span style={{ fontWeight, fontFamily: monoFont }}>
                  {displayValue}
                </span>
                <span
                  style={{
                    fontSize: 10,
                    fontFamily: monoFont,
                    color: palette.text.disabled,
                    fontStyle: "italic",
                  }}
                >
                  {enumLabel}
                </span>
              </span>
            ) : (
              <span
                style={{
                  color: fgColor,
                  fontWeight,
                  fontFeatureSettings,
                }}
              >
                {displayValue}
              </span>
            )}
          </td>
        );
      })}
      {showRowDialog && (
        <td>
          <button
            title={tLabel("editRow")}
            onClick={() => onEditRow(row)}
            style={{
              background: "none",
              border: "none",
              cursor: "pointer",
              padding: "2px",
              color: palette.text.secondary,
              display: "flex",
              alignItems: "center",
            }}
          >
            <svg width="14" height="14" viewBox="0 0 24 24" fill="currentColor">
              <path d="M3 17.25V21h3.75L17.81 9.94l-3.75-3.75L3 17.25zM20.71 7.04a1 1 0 0 0 0-1.41l-2.34-2.34a1 1 0 0 0-1.41 0l-1.83 1.83 3.75 3.75 1.83-1.83z" />
            </svg>
          </button>
        </td>
      )}
    </tr>
  );
});

export default SqlResultRow;
