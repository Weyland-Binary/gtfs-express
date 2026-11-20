/**
 * The two copies of one thing written twice, value against value: the copy the network shows, the duplicate the
 * export would still write. One choice settles the group: keep the copy shown, or use the duplicate in its place.
 */

import React from "react";
import { Box, Button, Dialog, DialogActions, DialogContent, Typography, alpha, useTheme } from "@mui/material";
import CompareArrowsRoundedIcon from "@mui/icons-material/CompareArrowsRounded";
import { useLanguage } from "../../contexts/LanguageContext";
import DialogHeader from "../common/DialogHeader";
import { groupLabelOf, rowKeyOf } from "./duplicateWords";

const LINES_MAX = 300;

export default function DuplicatesCompareDialog({ group, busy = false, onClose, onKeep, onUse }) {
  const theme = useTheme();
  const { t } = useLanguage();
  if (!group) return null;
  const lines = group.rows.flatMap((row) => (row.differing.length ? row.differing : [{ column: "—", shown: "", copy: "" }]).map((d) => ({ row, ...d })));
  const head = { fontSize: "0.72rem", fontWeight: 650, color: "text.secondary", textTransform: "uppercase", letterSpacing: "0.04em" };
  const cell = { fontSize: "0.82rem", py: 0.5, borderTop: `1px solid ${theme.palette.divider}`, minWidth: 0, overflowWrap: "anywhere" };
  const mono = { fontFamily: '"JetBrains Mono", "Fira Code", monospace', fontSize: "0.76rem" };
  return (
    <Dialog open onClose={busy ? undefined : onClose} maxWidth="sm" fullWidth data-testid="duplicates-compare-dialog">
      <DialogHeader icon={<CompareArrowsRoundedIcon />} title={t("duplicates.compareTitle")} subtitle={`${groupLabelOf(group, t)} · ${group.file}`} onClose={onClose} closeDisabled={busy} />
      <DialogContent sx={{ pt: 1 }}>
        <Typography sx={{ fontSize: "0.82rem", color: "text.secondary", mb: 1.25 }}>{t("duplicates.compareLead")}</Typography>
        <Box sx={{ display: "grid", gridTemplateColumns: "minmax(110px, 0.9fr) minmax(90px, 0.8fr) 1fr 1fr", columnGap: 1.5 }}>
          <Typography sx={head}>{t("duplicates.where")}</Typography>
          <Typography sx={head}>{t("duplicates.field")}</Typography>
          <Typography sx={head}>{t("duplicates.shown")}</Typography>
          <Typography sx={head}>{t("duplicates.copy")}</Typography>
          {lines.slice(0, LINES_MAX).map((l, i) => (
            <React.Fragment key={`${l.row.id}:${l.column}:${i}`}>
              <Typography sx={{ ...cell, ...mono }}>{rowKeyOf(group, l.row) || "—"}</Typography>
              <Typography sx={{ ...cell, ...mono }}>{l.column}</Typography>
              <Typography sx={cell}>{l.shown || "—"}</Typography>
              <Typography sx={{ ...cell, color: theme.palette.warning.dark, bgcolor: alpha(theme.palette.warning.main, 0.06) }}>{l.copy || "—"}</Typography>
            </React.Fragment>
          ))}
        </Box>
        {lines.length > LINES_MAX && <Typography sx={{ mt: 1, fontSize: "0.78rem", color: "text.secondary" }}>{t("duplicates.moreLines", { count: lines.length - LINES_MAX })}</Typography>}
      </DialogContent>
      <DialogActions sx={{ px: 3, pb: 2 }}>
        <Button onClick={onClose} disabled={busy} sx={{ textTransform: "none" }}>
          {t("app.cancel")}
        </Button>
        <Button variant="outlined" onClick={() => onUse(group.ids)} disabled={busy} data-testid="duplicates-use" sx={{ textTransform: "none", fontWeight: 600 }}>
          {t("duplicates.use")}
        </Button>
        <Button variant="contained" disableElevation onClick={() => onKeep(group.ids)} disabled={busy} data-testid="duplicates-keep-one" sx={{ textTransform: "none", fontWeight: 700 }}>
          {t("duplicates.keepShown")}
        </Button>
      </DialogActions>
    </Dialog>
  );
}
