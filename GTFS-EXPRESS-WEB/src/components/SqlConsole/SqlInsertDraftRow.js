import React from "react";
import { alpha } from "@mui/material/styles";
import { AUTO_ASSIGNED_PK_COLS } from "./editableFields";

/* ------------------------------------------------------------------ */
/* SqlInsertDraftRow — inline draft row for the "+" button (replaces   */
/* the former modal Insert dialog). Renders as a single <tr> with     */
/* native <input>/<select> elements already in edit mode, an accent   */
/* left border + tinted background to signal "draft", and inline      */
/* commit/cancel buttons. Enter commits, Escape cancels.               */
/* ------------------------------------------------------------------ */

export default function SqlInsertDraftRow({
  columns,
  showSelection,
  showRowDialog,
  tableName,
  pkColumns,
  editableFields,
  values,
  errors,
  submitting,
  onChange,
  onCommit,
  onCancel,
  firstInputRef,
  t,
  tLabel,
  monoFont,
  palette,
}) {
  // Build a quick lookup for editable field definitions by column key.
  const fieldByCol = {};
  for (const f of editableFields) fieldByCol[f.key] = f;
  const pkSet = new Set(pkColumns);
  const autoSet = AUTO_ASSIGNED_PK_COLS[tableName] || new Set();

  // Find the first focusable column: prefer a non-auto PK, then any
  // required field, then the first editable column. Auto-assigned PKs
  // are skipped because their inputs are disabled.
  let firstFocusCol = null;
  for (const c of columns) {
    if (pkSet.has(c) && !autoSet.has(c)) {
      firstFocusCol = c;
      break;
    }
  }
  if (!firstFocusCol) {
    for (const f of editableFields) {
      if (f.required && !autoSet.has(f.key)) {
        firstFocusCol = f.key;
        break;
      }
    }
  }
  if (!firstFocusCol) {
    for (const c of columns) {
      const fd = fieldByCol[c];
      if (fd && !autoSet.has(c)) {
        firstFocusCol = c;
        break;
      }
    }
  }

  const handleKey = (e) => {
    if (e.key === "Enter") {
      e.preventDefault();
      onCommit();
    } else if (e.key === "Escape") {
      e.preventDefault();
      onCancel();
    }
  };

  const draftBg = alpha(palette.success.main, 0.04);
  const errorBorder = palette.error.main;
  const inputBaseStyle = {
    width: "100%",
    border: `1px solid ${alpha(palette.text.primary, 0.18)}`,
    borderRadius: 3,
    outline: "none",
    background: palette.background.paper,
    fontFamily: monoFont,
    fontSize: 12,
    color: palette.text.primary,
    padding: "2px 4px",
    boxSizing: "border-box",
  };

  // Action buttons rendered inside the last data cell when there's no
  // pencil column. This keeps the table header/row column counts in sync.
  const renderActions = (compact) => (
    <div
      style={{
        display: "inline-flex",
        alignItems: "center",
        gap: 4,
        marginLeft: compact ? 0 : 6,
      }}
    >
      <button
        type="button"
        onClick={onCommit}
        disabled={submitting}
        title={t("sqlConsole.insertInline.commit")}
        aria-label={t("sqlConsole.insertInline.commit")}
        style={{
          border: `1px solid ${palette.success.main}`,
          background: alpha(palette.success.main, 0.12),
          color: palette.success.main,
          fontFamily: monoFont,
          fontSize: 11,
          fontWeight: 700,
          padding: compact ? "1px 6px" : "2px 8px",
          borderRadius: 3,
          cursor: submitting ? "default" : "pointer",
          opacity: submitting ? 0.6 : 1,
        }}
      >
        {compact ? "✓" : `✓ ${t("sqlConsole.insertInline.commit")}`}
      </button>
      <button
        type="button"
        onClick={onCancel}
        disabled={submitting}
        title={t("sqlConsole.insertInline.cancel")}
        aria-label={t("sqlConsole.insertInline.cancel")}
        style={{
          border: `1px solid ${alpha(palette.text.primary, 0.2)}`,
          background: "transparent",
          color: palette.text.secondary,
          fontFamily: monoFont,
          fontSize: 11,
          padding: compact ? "1px 6px" : "2px 8px",
          borderRadius: 3,
          cursor: submitting ? "default" : "pointer",
          opacity: submitting ? 0.6 : 1,
        }}
      >
        {compact ? "✕" : `✕ ${t("sqlConsole.insertInline.cancel")}`}
      </button>
    </div>
  );

  const renderCell = (col, isLast) => {
    const fd = fieldByCol[col];
    const isPk = pkSet.has(col);
    const isAuto = autoSet.has(col);
    const isEditableField = Boolean(fd) || isPk;
    const value = values[col] ?? "";
    const hasErr = Boolean(errors[col]);
    // When the table has no row-edit pencil column, pin the action
    // buttons to the last data cell so we don't introduce a stray
    // <td> without a matching <th>.
    const trailingActions =
      isLast && !showRowDialog ? renderActions(false) : null;

    // Auto-assigned PK or non-editable column → disabled placeholder.
    if (isAuto) {
      return (
        <td key={col} style={{ background: draftBg }}>
          <span
            style={{
              fontFamily: monoFont,
              fontSize: 11,
              color: palette.text.disabled,
              fontStyle: "italic",
            }}
            title="auto-assigned"
          >
            auto
          </span>
          {trailingActions}
        </td>
      );
    }
    if (!isEditableField) {
      return (
        <td key={col} style={{ background: draftBg }}>
          <span style={{ color: palette.text.disabled }}>—</span>
          {trailingActions}
        </td>
      );
    }

    const sharedStyle = {
      ...inputBaseStyle,
      borderColor: hasErr ? errorBorder : inputBaseStyle.border,
      ...(hasErr ? { borderColor: errorBorder } : {}),
    };

    // Enum: native <select>.
    if (fd?.type === "enum" && Array.isArray(fd.options)) {
      return (
        <td key={col} style={{ background: draftBg }}>
          <div
            style={{
              display: "flex",
              alignItems: "center",
              gap: 6,
              width: "100%",
            }}
          >
            <select
              ref={col === firstFocusCol ? firstInputRef : undefined}
              value={value}
              disabled={submitting}
              onChange={(e) => onChange(col, e.target.value)}
              onKeyDown={handleKey}
              aria-label={col}
              style={{ ...sharedStyle, flex: 1, minWidth: 80 }}
            >
              {!fd.required && <option value="">NULL</option>}
              {fd.options.map((o) => (
                <option key={o.value} value={o.value}>
                  {o.label}
                </option>
              ))}
            </select>
            {trailingActions}
          </div>
        </td>
      );
    }

    // Text-like input. PKs default to text (no field def for them).
    const inputType =
      fd?.type === "number"
        ? "number"
        : fd?.type === "url"
          ? "url"
          : fd?.type === "email"
            ? "email"
            : "text";
    const placeholder =
      fd?.type === "time"
        ? "HH:MM:SS"
        : fd?.type === "date"
          ? "YYYYMMDD"
          : fd?.type === "color"
            ? "RRGGBB"
            : col;

    return (
      <td key={col} style={{ background: draftBg }}>
        <div
          style={{
            display: "flex",
            alignItems: "center",
            gap: 6,
            width: "100%",
          }}
        >
          <input
            ref={col === firstFocusCol ? firstInputRef : undefined}
            type={inputType}
            value={value}
            placeholder={placeholder}
            disabled={submitting}
            onChange={(e) => onChange(col, e.target.value)}
            onKeyDown={handleKey}
            aria-label={col}
            aria-invalid={hasErr || undefined}
            title={errors[col] || undefined}
            style={{ ...sharedStyle, flex: 1, minWidth: 60 }}
            inputMode={
              fd?.type === "time" || fd?.type === "date" ? "numeric" : undefined
            }
          />
          {trailingActions}
        </div>
      </td>
    );
  };

  return (
    <tr
      style={{
        background: draftBg,
        animation: "sqlSlideIn 150ms ease-out",
      }}
      data-pending-insert="1"
    >
      {/* Row-number column: "+" accent in success.main instead of a
          number, sticky-left to match the data rows. */}
      <td
        style={{
          width: 48,
          minWidth: 48,
          maxWidth: 48,
          textAlign: "right",
          paddingRight: 8,
          paddingLeft: 4,
          fontFamily: monoFont,
          fontSize: 12,
          fontWeight: 700,
          color: palette.success.main,
          userSelect: "none",
          background: alpha(palette.success.main, 0.08),
          borderRight: `1px solid ${palette.divider}`,
          borderLeft: `3px solid ${palette.success.main}`,
          position: "sticky",
          left: 0,
          zIndex: 1,
        }}
        aria-label={t("sqlConsole.insertInline.placeholderNew")}
        title={t("sqlConsole.insertInline.placeholderNew")}
      >
        +
      </td>
      {showSelection && <td style={{ background: draftBg }} />}
      {columns.map((c, idx) => renderCell(c, idx === columns.length - 1))}
      {/* When the table exposes the pencil-column (stops/routes/trips),
          we have an extra trailing <th> in the header — fill it with the
          compact action buttons. For all other tables, the buttons are
          already pinned to the last data cell via renderCell(_, true). */}
      {showRowDialog && (
        <td
          style={{
            background: draftBg,
            padding: "2px 4px",
            whiteSpace: "nowrap",
          }}
        >
          {renderActions(true)}
        </td>
      )}
    </tr>
  );
}
