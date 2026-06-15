/* ------------------------------------------------------------------ */
/* Field-level client validation                                       */
/* ------------------------------------------------------------------ */

// Format regexes — kept loose where the GTFS spec is loose.
// HH:MM:SS where HH may exceed 24 (overnight trips).
export const TIME_FIELD_RE = /^\d{1,3}:[0-5]\d:[0-5]\d$/;
// YYYYMMDD strict.
export const DATE_FIELD_RE = /^\d{8}$/;
// Bare http(s) URL — we don't validate the path for ergonomic reasons.
export const URL_FIELD_RE = /^https?:\/\/\S+$/i;
// Naive but pragmatic email shape (intentionally permissive — backend re-checks).
export const EMAIL_FIELD_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
// Six-character hex colour (uppercase or lowercase, no leading #).
export const COLOR_FIELD_RE = /^[0-9A-Fa-f]{6}$/;

/**
 * Validate a raw input string against a field definition.
 * Returns `{ ok: true, value }` (where `value` is the canonical form
 * accepted by the backend, e.g. cast to Number) or
 * `{ ok: false, hintKey, hintParams }` (i18n keys for the snackbar).
 *
 * Empty strings / null map to:
 *   - error for `required: true` fields
 *   - the literal `null` (clears the column) otherwise
 */
export function validateFieldValue(fieldDef, rawValue) {
  if (!fieldDef) return { ok: true, value: rawValue };
  const isEmpty = rawValue === "" || rawValue == null;

  if (isEmpty) {
    if (fieldDef.required) {
      return {
        ok: false,
        hintKey: "sqlConsole.cell.requiredField",
        hintParams: { field: fieldDef.key },
      };
    }
    return { ok: true, value: null };
  }

  switch (fieldDef.type) {
    case "number": {
      const n = Number(rawValue);
      if (!Number.isFinite(n)) {
        return {
          ok: false,
          hintKey: "sqlConsole.cell.invalidFormat",
          hintParams: { hint: "number" },
        };
      }
      if (fieldDef.min != null && n < fieldDef.min) {
        return {
          ok: false,
          hintKey: "sqlConsole.cell.numberRange",
          hintParams: { field: fieldDef.key, constraint: `≥ ${fieldDef.min}` },
        };
      }
      if (fieldDef.max != null && n > fieldDef.max) {
        return {
          ok: false,
          hintKey: "sqlConsole.cell.numberRange",
          hintParams: { field: fieldDef.key, constraint: `≤ ${fieldDef.max}` },
        };
      }
      return { ok: true, value: n };
    }
    case "time":
      if (!TIME_FIELD_RE.test(String(rawValue))) {
        return { ok: false, hintKey: "sqlConsole.cell.invalidTime" };
      }
      return { ok: true, value: String(rawValue) };
    case "date":
      if (!DATE_FIELD_RE.test(String(rawValue))) {
        return { ok: false, hintKey: "sqlConsole.cell.invalidDate" };
      }
      return { ok: true, value: String(rawValue) };
    case "url":
      if (!URL_FIELD_RE.test(String(rawValue))) {
        return { ok: false, hintKey: "sqlConsole.cell.invalidUrl" };
      }
      return { ok: true, value: String(rawValue) };
    case "email":
      if (!EMAIL_FIELD_RE.test(String(rawValue))) {
        return { ok: false, hintKey: "sqlConsole.cell.invalidEmail" };
      }
      return { ok: true, value: String(rawValue) };
    case "color": {
      const stripped = String(rawValue).replace(/^#/, "");
      if (!COLOR_FIELD_RE.test(stripped)) {
        return {
          ok: false,
          hintKey: "sqlConsole.cell.invalidFormat",
          hintParams: { hint: "RRGGBB" },
        };
      }
      return { ok: true, value: stripped.toUpperCase() };
    }
    case "enum":
    case "text":
    default:
      return { ok: true, value: rawValue };
  }
}
