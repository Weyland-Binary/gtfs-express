/**
 * OfferOperations — ③ Changement offers the timetables of the offer sheet
 * imported at ②: one build_timetable operation per line,
 * direction and day type, as the server read them (POST /spreadsheet/parse,
 * kept with the project's context), each added to the change plan by the
 * person (`change-offer-add`) — then the engine asks what the sheet does not
 * say (which stop pattern, which running times, the dates the line does not
 * run yet, the other patterns), in the operation's card, never guessed.
 *
 *   change-offer        the panel (`data-count`: the operations the sheet gives)
 *   change-offer-item   one per operation (`data-added` once in the plan), its line · destination · day type;
 *                       `data-incomplete` (bands_missing | first_or_last_missing) when the sheet gives only part of
 *                       it — said in words, the engine asks the rest once it is added
 *   change-offer-add    « Ajouter au changement »: the operation becomes the person's (source.author "user",
 *                       source.offer: the sheet and its index, so it is never added twice)
 *
 *   change-offer-add-all « Ajouter les N grilles au changement »: every timetable not added yet, in one act
 *                       (`onAddAll`); once all are in the plan, the panel says so in one line
 *
 * An operation added keeps the sheet's label (« 16 · BEAULIEU · SEMAINE PS »): the plan's card is named by it.
 *
 *   offerKey(offer, i) → the key an added operation carries
 */

import React from "react";
import { Box, Button, Typography, alpha, useTheme } from "@mui/material";
import TableChartOutlinedIcon from "@mui/icons-material/TableChartOutlined";
import AddIcon from "@mui/icons-material/Add";
import { useLanguage } from "../../contexts/LanguageContext";
import { operationText } from "../common/SpreadsheetImport";

// Named by the operation's own sheet and its place among that sheet's (several sheets of one brief share the offer:
// a second sheet joined later never renames the first one's timetables — they would all be offered again).
export const offerKey = (offer, i) => {
  const ops = offer?.operations || [];
  const doc = ops[i]?.source?.document || null;
  if (!doc) return `${offer?.name || "offre"}#${i}`;
  let n = 0;
  for (let j = 0; j < i; j += 1) if (ops[j]?.source?.document === doc) n += 1;
  return `${doc}#${n}`;
};

/** An offer's timetable as the plan's operation: the person's, its label kept, never added twice (source.offer). */
export const offerOperation = (offer, op, i) => ({ type: op.type, params: op.params, ...(op.label ? { label: op.label } : {}), source: { ...(op.source || {}), author: "user", offer: offerKey(offer, i) } });

export default function OfferOperations({ offer, plan, disabled = false, onAdd, onAddAll = null }) {
  const { t } = useLanguage();
  const theme = useTheme();
  const ops = offer?.operations || [];
  if (!ops.length) return null;
  const added = new Set((plan?.operations || []).map((o) => o?.source?.offer).filter(Boolean));
  const missing = ops.map((op, i) => ({ op, i })).filter(({ i }) => !added.has(offerKey(offer, i)));
  if (!missing.length && onAddAll) {
    return (
      <Typography data-testid="change-offer" data-count={ops.length} data-done="true" sx={{ display: "flex", alignItems: "center", gap: 0.75, fontSize: "0.76rem", color: "success.main", fontWeight: 600 }}>
        <TableChartOutlinedIcon sx={{ fontSize: 16 }} aria-hidden="true" />
        {t("sheet.operations.allAdded", { count: ops.length })}
      </Typography>
    );
  }
  return (
    <Box component="section" aria-labelledby="change-offer-title" data-testid="change-offer" data-count={ops.length} sx={{ p: 1.25, borderRadius: "12px", background: alpha(theme.palette.primary.main, 0.05), display: "flex", flexDirection: "column", gap: 0.5 }}>
      <Typography id="change-offer-title" component="h3" sx={{ fontSize: "0.8rem", fontWeight: 800, display: "flex", alignItems: "center", gap: 0.5 }}>
        <TableChartOutlinedIcon sx={{ fontSize: 16 }} aria-hidden="true" />
        {t("sheet.operations.title", { file: offer.name || "—", count: ops.length })}
      </Typography>
      <Typography sx={{ fontSize: "0.72rem", color: "text.secondary", lineHeight: 1.45 }}>{t("sheet.operations.hint")}</Typography>
      {onAddAll && missing.length > 0 && (
        <Button size="small" variant="contained" disableElevation startIcon={<AddIcon />} disabled={disabled} onClick={() => onAddAll(missing.map(({ op, i }) => offerOperation(offer, op, i)))} data-testid="change-offer-add-all" sx={{ alignSelf: "flex-start", textTransform: "none", fontWeight: 600, my: 0.25 }}>
          {t("sheet.operations.addAll", { count: missing.length })}
        </Button>
      )}
      <Box component="ul" sx={{ listStyle: "none", m: 0, p: 0 }}>
        {ops.map((op, i) => {
          const key = offerKey(offer, i);
          const isAdded = added.has(key);
          return (
            <Box component="li" key={key} data-testid="change-offer-item" data-added={isAdded ? "true" : "false"} data-incomplete={op.incomplete || undefined} sx={{ display: "flex", alignItems: "center", gap: 1, py: 0.25, borderTop: i ? `1px solid ${alpha(theme.palette.divider, 0.6)}` : "none" }}>
              <Typography sx={{ flex: 1, minWidth: 0, fontSize: "0.76rem", overflowWrap: "anywhere" }}>
                {op.label}
                {op.incomplete ? <Box component="span" sx={{ display: "block", fontSize: "0.7rem", color: "text.secondary" }}>{operationText(t, op.incomplete)}</Box> : null}
              </Typography>
              {isAdded ? (
                <Typography sx={{ fontSize: "0.72rem", color: "success.main", fontWeight: 700 }}>{t("sheet.operations.added")}</Typography>
              ) : (
                <Button size="small" startIcon={<AddIcon />} disabled={disabled} onClick={() => onAdd(offerOperation(offer, op, i))} data-testid="change-offer-add" sx={{ textTransform: "none", fontWeight: 700, flexShrink: 0 }}>
                  {t("sheet.operations.add")}
                </Button>
              )}
            </Box>
          );
        })}
      </Box>
    </Box>
  );
}
