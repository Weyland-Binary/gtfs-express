/**
 * The text a search compares: lowercase, accents removed, so « gorlitz » finds « Görlitz » and « ecole » « École ».
 * The server folds what it searches the same way (its utils/searchText.js).
 */
export const foldText = (value) =>
  String(value ?? "")
    .normalize("NFD")
    .replace(/[̀-ͯ]/g, "")
    .toLowerCase();

/** Whether one of the values holds what was typed; nothing typed matches everything. */
export const matchesText = (typed, values) => {
  const needle = foldText(typed).trim();
  return !needle || values.some((v) => v != null && foldText(v).includes(needle));
};
