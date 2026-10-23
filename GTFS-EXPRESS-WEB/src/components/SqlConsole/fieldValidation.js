// Loose where the GTFS spec is loose.
// HH may exceed 24 (overnight trips).
export const TIME_FIELD_RE = /^\d{1,3}:[0-5]\d:[0-5]\d$/;
export const DATE_FIELD_RE = /^\d{8}$/;
export const URL_FIELD_RE = /^https?:\/\/\S+$/i;
// Permissive on purpose: the backend checks again.
export const EMAIL_FIELD_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
export const COLOR_FIELD_RE = /^[0-9A-Fa-f]{6}$/;

/**
 * `{ ok: true, value }` with the value the backend accepts (a number cast), or `{ ok: false, hintKey, hintParams }`.
 * An empty value is an error when `required`, else null (clears the column).
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
