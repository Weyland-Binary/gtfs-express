/**
 * SpreadsheetImport — « Importer un tableur d'offre » at ② (mission step 6):
 * an operator's offer sheet read by the server, deterministically, cell by
 * cell (POST /spreadsheet/parse), shown as it was read, and the clauses it
 * states turned into the contract's clauses by a named person.
 *
 *   sheet-import         the dialog (a short task, §10 (d)); `sheet-file` the file picker (xlsx, xlsm, xls, ods, csv)
 *   sheet-summary        what was read: lines × directions, day types, bands, cells read and not read
 *   sheet-grid           one table per sheet (`data-sheet`): every non-empty cell (`sheet-cell`, `data-cell`,
 *                        `data-state` read | unread, `data-reason`), the state said in text and by an icon, never
 *                        by a colour alone; a large sheet is shown in part, and says so
 *   sheet-unread         the cells not read, each with its address, its text and the reason in words
 *   sheet-clause         one per clause the sheet states (`data-clause`), checked by default, with its line in
 *                        words, the cell it cites and the cell's text (the quote)
 *   sheet-not-converted  the values that give no clause, counted by reason (a direction the network does not
 *                        name yet, a departure stop the sheet does not say, a band without service…)
 *   sheet-wishes         what the sheet states that no clause will cover — each value not converted, each cell not
 *                        read, each clause left unticked — recorded with the clauses in the contract's « à vérifier
 *                        à la main » (sheetWishes: quote = the cell's text, document = the file, cell = its address),
 *                        so G5's coverage never loses it when the dialog closes; `data-count` the items
 *   sheet-operations     the timetables ③ will offer (`data-count`), those the sheet gives only in part (the engine
 *                        asks the rest) and the day types giving none, with their reason (`sheet-operations-skipped`)
 *   sheet-add-clauses    « Ajouter au contrat (N) »: the checked clauses, each retained under the decider's name,
 *                        and the wishes above (never anonymous: disabled with its reason until the name is given);
 *                        merged server-side like any clause of the contract
 *
 * Nothing is guessed on screen either: the counts, the reasons and the clauses are the server's. A refusal
 * (another format, an unreadable or empty workbook, too large) is shown in place (RefusalNotice).
 *
 *   <SpreadsheetImport open onClose name existing wishes onAddClauses={(clauses, result, wishes) => …} onParsed={(result) => …} />
 */

import React, { useMemo, useRef, useState } from "react";
import { Box, Button, Checkbox, CircularProgress, Dialog, DialogActions, DialogContent, DialogTitle, FormControlLabel, Typography, alpha, useMediaQuery, useTheme } from "@mui/material";
import UploadFileOutlinedIcon from "@mui/icons-material/UploadFileOutlined";
import CheckIcon from "@mui/icons-material/Check";
import HelpOutlineIcon from "@mui/icons-material/HelpOutline";
import { useLanguage } from "../../contexts/LanguageContext";
import { MAX_WISHES, OFFER_ACCEPT, clauseCells, columnName, decodeCell, parseOfferSheet, sheetCells, sheetWishes } from "../../utils/spreadsheetApi";
import RefusalNotice from "./RefusalNotice";

const MAX_ROWS = 60;
const MAX_COLS = 24;
const REASONS = ["unknown_header", "unknown_column", "not_recognised", "invalid_time", "not_a_time", "no_time", "invalid_headway", "headway_range", "unknown_day_type", "invalid_date", "invalid_period", "not_a_number", "error_value", "formula_without_value", "conflicting_value", "band_incomplete", "unknown_direction", "too_many", "comment"];
const NOT_CONVERTED = ["direction_unresolved", "origin_unknown", "line_unknown", "day_type_unknown", "band_without_service", "headway_without_window"];
const INCOMPLETE = ["bands_missing", "first_or_last_missing", "trips_without_time"];
const SKIPPED = ["line_unknown", "direction_unresolved", "day_type_unknown", "trips_without_time"];

/** A reason code in words (an unknown code is shown as sent). */
export const reasonText = (t, reason) => (REASONS.includes(reason) ? t(`sheet.reason.${reason}`) : reason);
/** A not-converted reason in words (an unknown code is shown as sent). */
export const notConvertedText = (t, reason) => (NOT_CONVERTED.includes(reason) ? t(`sheet.notConverted.${reason}`) : reason);
/** Why a timetable is given in part, or gives no operation, in words. */
export const operationText = (t, reason) => (INCOMPLETE.includes(reason) ? t(`sheet.operations.incomplete.${reason}`) : SKIPPED.includes(reason) ? t(`sheet.operations.skipped.${reason}`) : reason);

/** The words of the wishes an import records (sheetWishes), in the person's language. */
export const wishWords = (t, file) => ({
  unread: (reason) => t("sheet.wish.unread", { file, reason: reasonText(t, reason) }),
  notConverted: (reasons) => t("sheet.wish.notConverted", { file, reasons: reasons.map((r) => notConvertedText(t, r)).join(", ") }),
  left: (clause) => t("sheet.wish.left", { file, clause: clause.text || clause.kind }),
  group: (count, why) => t("sheet.wish.group", { count, why }),
  rest: (count) => t("sheet.wish.rest", { count, file }),
});

/** The cells of one sheet as a bounded grid: { rows: [r], cols: [c], at: Map("r,c" → { addr, state, reason, text }), truncated }. */
export const gridOf = (cells, sheet) => {
  const at = new Map();
  for (const [key, v] of cells) {
    const i = key.lastIndexOf("!");
    if (key.slice(0, i) !== sheet) continue;
    const pos = decodeCell(key.slice(i + 1));
    if (pos) at.set(`${pos.r},${pos.c}`, { addr: key.slice(i + 1), ...v });
  }
  const pos = [...at.keys()].map((k) => k.split(",").map(Number));
  if (!pos.length) return { rows: [], cols: [], at, truncated: false };
  const r0 = Math.min(...pos.map((p) => p[0]));
  const c0 = Math.min(...pos.map((p) => p[1]));
  const r1 = Math.max(...pos.map((p) => p[0]));
  const c1 = Math.max(...pos.map((p) => p[1]));
  const rows = [];
  const cols = [];
  for (let r = r0; r <= Math.min(r1, r0 + MAX_ROWS - 1); r++) rows.push(r);
  for (let c = c0; c <= Math.min(c1, c0 + MAX_COLS - 1); c++) cols.push(c);
  return { rows, cols, at, truncated: r1 - r0 + 1 > MAX_ROWS || c1 - c0 + 1 > MAX_COLS };
};

function SheetGrid({ name, cells }) {
  const { t } = useLanguage();
  const theme = useTheme();
  const g = useMemo(() => gridOf(cells, name), [cells, name]);
  const tone = { read: theme.palette.success.main, unread: theme.palette.warning.main };
  return (
    <Box data-testid="sheet-grid" data-sheet={name} sx={{ overflowX: "auto", maxHeight: 360, border: `1px solid ${theme.palette.divider}`, borderRadius: 1.5 }}>
      <Box component="table" sx={{ borderCollapse: "collapse", fontSize: "0.68rem", minWidth: "100%" }}>
        <caption style={{ textAlign: "left", padding: "4px 6px", fontWeight: 700 }}>{t("sheet.grid.caption", { sheet: name })}</caption>
        <thead>
          <tr>
            <Box component="th" scope="col" sx={{ position: "sticky", top: 0, background: theme.palette.background.paper, px: 0.5 }} />
            {g.cols.map((c) => (
              <Box component="th" scope="col" key={c} sx={{ position: "sticky", top: 0, background: theme.palette.background.paper, px: 0.5, color: "text.secondary", fontWeight: 600 }}>
                {columnName(c)}
              </Box>
            ))}
          </tr>
        </thead>
        <tbody>
          {g.rows.map((r) => (
            <tr key={r}>
              <Box component="th" scope="row" sx={{ px: 0.5, color: "text.secondary", fontWeight: 600, textAlign: "right" }}>
                {r + 1}
              </Box>
              {g.cols.map((c) => {
                const v = g.at.get(`${r},${c}`);
                if (!v) return <Box component="td" key={c} sx={{ border: `1px solid ${alpha(theme.palette.divider, 0.4)}`, minWidth: 28 }} />;
                const label = v.state === "read" ? t("sheet.cell.read", { cell: v.addr }) : t("sheet.cell.unread", { cell: v.addr, reason: reasonText(t, v.reason) });
                return (
                  <Box component="td" key={c} data-testid="sheet-cell" data-cell={v.addr} data-state={v.state} data-reason={v.reason || undefined} title={label} sx={{ border: `1px solid ${alpha(theme.palette.divider, 0.6)}`, px: 0.5, py: 0.2, maxWidth: 180, whiteSpace: "nowrap", overflow: "hidden", textOverflow: "ellipsis", background: alpha(tone[v.state], 0.1) }}>
                    <Box component="span" aria-hidden="true" sx={{ color: tone[v.state], mr: 0.25 }}>
                      {v.state === "read" ? "✓" : "?"}
                    </Box>
                    <span className="visually-hidden">{label} </span>
                    {v.text}
                  </Box>
                );
              })}
            </tr>
          ))}
        </tbody>
      </Box>
      {g.truncated && <Typography sx={{ fontSize: "0.68rem", color: "text.secondary", px: 0.75, py: 0.5 }}>{t("sheet.grid.truncated", { rows: MAX_ROWS, cols: MAX_COLS })}</Typography>}
    </Box>
  );
}

export default function SpreadsheetImport({ open, onClose, name = "", nameOk = () => true, onAddClauses = null, onParsed = null, existing = [], wishes = [] }) {
  const { t, language } = useLanguage();
  const theme = useTheme();
  const fullScreen = useMediaQuery(theme.breakpoints.down("sm"));
  const fileRef = useRef(null);
  const [state, setState] = useState({ status: "idle", result: null, error: null, file: null });
  const [unchecked, setUnchecked] = useState(() => new Set());
  const result = state.result;
  const cells = useMemo(() => sheetCells(result), [result]);
  const known = new Set(existing);
  const clauses = (result?.clauses || []).filter((c) => !known.has(c.id));
  const chosen = clauses.filter((c) => !unchecked.has(c.id));
  const agg = result?.aggregates;
  // What no clause will cover (G5): recorded with the clauses, to check by hand.
  const left = clauses.filter((c) => unchecked.has(c.id));
  const toCheck = result ? sheetWishes(result, { left, existing: wishes, words: wishWords(t, result.model?.file?.name || "") }) : { wishes: [], items: 0, full: false };
  const operations = result?.operations || [];
  const skippedOps = result?.operations_skipped || [];
  const byReason = (list, key) => {
    const by = new Map();
    for (const x of list) if (x[key]) by.set(x[key], (by.get(x[key]) || 0) + 1);
    return [...by.entries()].map(([r, n]) => `${operationText(t, r)} (${n})`).join(", ");
  };

  const read = async (file) => {
    if (!file) return;
    setState({ status: "reading", result: null, error: null, file: file.name });
    setUnchecked(new Set());
    try {
      const r = await parseOfferSheet(file, { lang: language || "fr" });
      setState({ status: "done", result: r, error: null, file: file.name });
      onParsed?.(r);
    } catch (err) {
      setState({ status: "error", result: null, error: err, file: file.name });
    }
  };
  const toggle = (id) =>
    setUnchecked((s) => {
      const next = new Set(s);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  const notConverted = useMemo(() => {
    const by = new Map();
    for (const x of result?.not_converted || []) by.set(x.reason, (by.get(x.reason) || 0) + 1);
    return [...by.entries()];
  }, [result]);
  const canAdd = (chosen.length > 0 || toCheck.wishes.length > 0) && !toCheck.full && nameOk(name) && Boolean(onAddClauses);

  return (
    <Dialog open={open} onClose={onClose} fullScreen={fullScreen} maxWidth="lg" fullWidth aria-labelledby="sheet-import-title" data-testid="sheet-import">
      <DialogTitle id="sheet-import-title" sx={{ fontSize: "1rem", fontWeight: 800 }}>
        {t("sheet.title")}
      </DialogTitle>
      <DialogContent dividers sx={{ display: "flex", flexDirection: "column", gap: 1.25 }}>
        <Typography sx={{ fontSize: "0.8rem", color: "text.secondary" }}>{t("sheet.import.hint")}</Typography>
        <Box sx={{ display: "flex", alignItems: "center", gap: 1, flexWrap: "wrap" }}>
          <input
            ref={fileRef}
            type="file"
            hidden
            accept={OFFER_ACCEPT}
            data-testid="sheet-file"
            onChange={(e) => {
              read(e.target.files?.[0]);
              e.target.value = "";
            }}
          />
          <Button variant="outlined" size="small" startIcon={<UploadFileOutlinedIcon />} onClick={() => fileRef.current?.click()} disabled={state.status === "reading"} data-testid="sheet-choose" sx={{ textTransform: "none", fontWeight: 700 }}>
            {t("sheet.choose")}
          </Button>
          {state.file && <Typography sx={{ fontSize: "0.76rem" }}>{t("sheet.file", { name: state.file })}</Typography>}
          {state.status === "reading" && (
            <Typography role="status" data-testid="sheet-reading" sx={{ fontSize: "0.76rem", display: "flex", alignItems: "center", gap: 0.5 }}>
              <CircularProgress size={12} /> {t("sheet.reading")}
            </Typography>
          )}
        </Box>
        {state.status === "error" && <RefusalNotice refusal={state.error} supported={[]} testid="sheet-refusal" />}
        {result && (
          <>
            <Typography data-testid="sheet-summary" role="status" sx={{ fontSize: "0.82rem", fontWeight: 700 }}>
              {t("sheet.summary", { lines: agg.lines, dayTypes: agg.day_types, bands: agg.bands, read: agg.read, cells: agg.cells, unread: agg.unread })}
            </Typography>
            <Box sx={{ display: "flex", gap: 1.5, fontSize: "0.7rem", color: "text.secondary" }} aria-hidden="true">
              <span>
                <CheckIcon sx={{ fontSize: 12, color: "success.main", verticalAlign: "middle" }} /> {t("sheet.legend.read")}
              </span>
              <span>
                <HelpOutlineIcon sx={{ fontSize: 12, color: "warning.main", verticalAlign: "middle" }} /> {t("sheet.legend.unread")}
              </span>
            </Box>
            {(result.model?.sheets || []).filter((s) => s.cells > 0).map((s) => (
              <SheetGrid key={s.name} name={s.name} cells={cells} />
            ))}
            <Box component="section" aria-labelledby="sheet-unread-title" data-testid="sheet-unread" data-count={result.model.unread.length}>
              <Typography id="sheet-unread-title" component="h3" sx={{ fontSize: "0.78rem", fontWeight: 800 }}>
                {t("sheet.unread.title", { count: result.model.unread.length })}
              </Typography>
              {result.model.unread.length ? (
                <Box component="ul" sx={{ m: 0, pl: 2.5, fontSize: "0.74rem" }}>
                  {result.model.unread.slice(0, 200).map((u) => (
                    <li key={`${u.sheet}!${u.cell}`} data-testid="sheet-unread-item" data-cell={`${u.sheet}!${u.cell}`} data-reason={u.reason}>
                      {t("sheet.unread.item", { cell: `${u.sheet}!${u.cell}`, text: u.text || "—", reason: reasonText(t, u.reason) })}
                    </li>
                  ))}
                </Box>
              ) : (
                <Typography sx={{ fontSize: "0.74rem", color: "text.secondary" }}>{t("sheet.unread.none")}</Typography>
              )}
            </Box>
            <Box component="section" aria-labelledby="sheet-clauses-title" data-testid="sheet-clauses" sx={{ display: "flex", flexDirection: "column", gap: 0.5 }}>
              <Typography id="sheet-clauses-title" component="h3" sx={{ fontSize: "0.78rem", fontWeight: 800 }}>
                {t("sheet.clauses.title", { count: clauses.length })}
              </Typography>
              <Typography sx={{ fontSize: "0.72rem", color: "text.secondary" }}>{t("sheet.clauses.hint")}</Typography>
              {clauses.length > 0 && (
                <Box sx={{ display: "flex", gap: 1 }}>
                  <Button size="small" onClick={() => setUnchecked(new Set())} sx={{ textTransform: "none" }} data-testid="sheet-clauses-all">
                    {t("sheet.clauses.all")}
                  </Button>
                  <Button size="small" onClick={() => setUnchecked(new Set(clauses.map((c) => c.id)))} sx={{ textTransform: "none" }} data-testid="sheet-clauses-none">
                    {t("sheet.clauses.none")}
                  </Button>
                </Box>
              )}
              {!clauses.length && <Typography sx={{ fontSize: "0.74rem", color: "text.secondary" }}>{t("sheet.clauses.empty")}</Typography>}
              <Box component="ul" sx={{ listStyle: "none", m: 0, p: 0, maxHeight: 280, overflowY: "auto" }}>
                {clauses.map((c) => (
                  <Box component="li" key={c.id} data-testid="sheet-clause" data-clause={c.id} data-kind={c.kind} sx={{ borderTop: `1px solid ${alpha(theme.palette.divider, 0.6)}`, py: 0.25 }}>
                    <FormControlLabel
                      control={<Checkbox size="small" checked={!unchecked.has(c.id)} onChange={() => toggle(c.id)} />}
                      label={
                        <Box>
                          <Typography sx={{ fontSize: "0.78rem", fontWeight: 600 }}>
                            {c.text || c.kind}
                            {c.status === "assumed" ? ` — ${t("sheet.clause.assumed")}` : ""}
                          </Typography>
                          <Typography sx={{ fontSize: "0.7rem", color: "text.secondary" }}>{t("sheet.clause.cited", { cell: clauseCells(c) || "—", text: c.quote || "—" })}</Typography>
                        </Box>
                      }
                    />
                  </Box>
                ))}
              </Box>
              {notConverted.length > 0 && (
                <Typography data-testid="sheet-not-converted" data-count={result.not_converted.length} sx={{ fontSize: "0.72rem", color: "text.secondary" }}>
                  {t("sheet.notConverted", { count: result.not_converted.length, reasons: notConverted.map(([r, n]) => `${notConvertedText(t, r)} (${n})`).join(", ") })}
                </Typography>
              )}
              {toCheck.items > 0 && (
                <Typography data-testid="sheet-wishes" data-count={toCheck.items} data-full={toCheck.full ? "true" : "false"} sx={{ fontSize: "0.72rem", fontWeight: 600 }}>
                  {toCheck.full ? t("sheet.wishes.full", { count: toCheck.items, max: MAX_WISHES }) : t("sheet.wishes", { count: toCheck.items })}
                </Typography>
              )}
            </Box>
            <Box component="section" aria-labelledby="sheet-operations-title" data-testid="sheet-operations" data-count={operations.length} sx={{ display: "flex", flexDirection: "column", gap: 0.25 }}>
              <Typography id="sheet-operations-title" component="h3" sx={{ fontSize: "0.78rem", fontWeight: 800 }}>
                {t("sheet.operations.summary", { count: operations.length, incomplete: operations.filter((o) => o.incomplete).length })}
              </Typography>
              {operations.some((o) => o.incomplete) && <Typography sx={{ fontSize: "0.72rem", color: "text.secondary" }}>{t("sheet.operations.incompleteList", { reasons: byReason(operations, "incomplete") })}</Typography>}
              {skippedOps.length > 0 && (
                <Typography data-testid="sheet-operations-skipped" data-count={skippedOps.length} sx={{ fontSize: "0.72rem", color: "text.secondary" }}>
                  {t("sheet.operations.skipped", { count: skippedOps.length, reasons: byReason(skippedOps, "reason") })}
                </Typography>
              )}
            </Box>
          </>
        )}
      </DialogContent>
      <DialogActions sx={{ flexWrap: "wrap", gap: 1 }}>
        {result && !nameOk(name) && <Typography sx={{ fontSize: "0.72rem", color: "text.secondary", flex: 1 }}>{t("sheet.nameFirst")}</Typography>}
        <Button onClick={onClose} sx={{ textTransform: "none" }} data-testid="sheet-close">
          {t("sheet.close")}
        </Button>
        {result && (
          <Button variant="contained" disabled={!canAdd} onClick={() => onAddClauses(chosen, result, toCheck.wishes)} data-testid="sheet-add-clauses" sx={{ textTransform: "none", fontWeight: 700 }}>
            {t("sheet.add", { count: chosen.length })}
          </Button>
        )}
      </DialogActions>
    </Dialog>
  );
}
