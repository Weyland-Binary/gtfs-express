/**
 * A column of a file as the person reads it. The import keys a column whose header cell is empty by its place (a
 * space, then the cell's index from 0: the API's csvReader namelessKey), so that its values are kept and come back;
 * nobody reads that key, the column is said by its place counted from 1, as the validator counts it.
 */

const NAMELESS = /^ (\d+)$/;

export const isNamelessColumn = (column) => typeof column === "string" && NAMELESS.test(column);

/** `column` as it is named, or « colonne sans nom (3) » for one its file leaves without a name. */
export const columnWords = (column, t) => {
  const nameless = typeof column === "string" ? NAMELESS.exec(column) : null;
  return nameless ? t("validation.column.nameless", { place: Number(nameless[1]) + 1 }) : column;
};
