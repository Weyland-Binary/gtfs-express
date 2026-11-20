/**
 * The text a search compares: lowercase, accents removed, so « ecole » finds « École » and « hotel » « Hôtel ».
 * The web folds what it filters the same way (src/utils/searchText.js there).
 */

"use strict";

const foldText = (value) =>
  String(value ?? "")
    .normalize("NFD")
    .replace(/[̀-ͯ]/g, "")
    .toLowerCase();

module.exports = { foldText };
