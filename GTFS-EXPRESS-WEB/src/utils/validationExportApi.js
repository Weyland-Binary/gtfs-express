import API_BASE_URL from "../config";
import { ensureOk, jsonHeaders, request } from "./apiRequest";

/**
 * The validation report's workbook, written by the server from the report it keeps and the texts the screen sends
 * (reportExport workbookRequestOf), then saved by the browser.
 */
export const downloadValidationWorkbook = async ({ name, lang, summary, audit, texts }) => {
  const res = await ensureOk(await request(`${API_BASE_URL}/documents/validation/xlsx`, { method: "POST", headers: jsonHeaders(), body: JSON.stringify({ name, lang, summary, audit, texts }) }));
  const url = URL.createObjectURL(await res.blob());
  const a = document.createElement("a");
  a.href = url;
  a.download = `${name}.xlsx`;
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
};
