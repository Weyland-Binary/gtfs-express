/**
 * What the file holds twice, said at the head of the report: each thing written twice (a trip, a stop…) with the copy
 * the network shows beside the duplicate the export would still write, and one act that removes the duplicates.
 */

import React from "react";
import { Box, Button, ButtonBase, Typography, alpha, useTheme } from "@mui/material";
import ContentCopyRoundedIcon from "@mui/icons-material/ContentCopyRounded";
import { useLanguage } from "../../contexts/LanguageContext";
import { countWords } from "../../utils/countWords";
import { copyWordsOf, groupLabelOf } from "./duplicateWords";

const SHOWN = 3;

export default function DuplicatesCard({ groups = [], total = 0, errors = 0, busy = false, onKeepAll, onCompare }) {
  const theme = useTheme();
  const { t } = useLanguage();
  if (!total || !groups.length) return null;
  const dark = theme.palette.mode === "dark";
  const tone = theme.palette.severities.warning.main;
  const more = total - Math.min(SHOWN, groups.length);
  const cell = { fontSize: "0.8rem", lineHeight: 1.45, minWidth: 0, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" };
  return (
    <Box component="section" role="status" data-testid="duplicates-card" sx={{ flexShrink: 0, px: 3, py: 1.5, bgcolor: alpha(tone, dark ? 0.14 : 0.08), borderBottom: `1px solid ${theme.palette.divider}` }}>
      <Box sx={{ display: "flex", alignItems: "flex-start", gap: 1.25 }}>
        <ContentCopyRoundedIcon aria-hidden sx={{ fontSize: 17, mt: "2px", color: tone, flexShrink: 0 }} />
        <Box sx={{ flex: 1, minWidth: 0 }}>
          <Typography component="h3" sx={{ fontSize: "0.875rem", fontWeight: 650, lineHeight: 1.4 }}>
            {countWords(t, "duplicates.title", total, { count: total })}
          </Typography>
          <Typography sx={{ mt: 0.25, fontSize: "0.8125rem", color: "text.secondary", lineHeight: 1.5 }}>{t("duplicates.lead")}</Typography>

          <Box sx={{ mt: 1, display: "grid", gridTemplateColumns: "minmax(140px, 0.9fr) minmax(0, 1fr) minmax(0, 1fr) auto", columnGap: 2, rowGap: 0.5, alignItems: "baseline" }}>
            <span />
            <Typography sx={{ ...cell, fontSize: "0.72rem", fontWeight: 650, color: "text.secondary" }}>{t("duplicates.shown")}</Typography>
            <Typography sx={{ ...cell, fontSize: "0.72rem", fontWeight: 650, color: "text.secondary" }}>{t("duplicates.copy")}</Typography>
            <span />
            {groups.slice(0, SHOWN).map((g, i) => (
              <React.Fragment key={`${g.table}:${JSON.stringify(g.key)}`}>
                <Typography data-testid="duplicates-label" sx={{ ...cell, fontWeight: 600 }}>
                  {groupLabelOf(g, t)}
                </Typography>
                <Typography sx={cell}>{copyWordsOf(g, "shown", t)}</Typography>
                <Typography sx={{ ...cell, color: "text.secondary" }}>{copyWordsOf(g, "copy", t)}</Typography>
                <ButtonBase onClick={() => onCompare(g)} data-testid={`duplicates-compare-${i}`} sx={{ font: "inherit", fontSize: "0.8rem", fontWeight: 600, color: "primary.main", px: 0.5, borderRadius: "4px", "&:hover": { textDecoration: "underline" } }}>
                  {t("duplicates.compare")}
                </ButtonBase>
              </React.Fragment>
            ))}
          </Box>
          {more > 0 && <Typography sx={{ mt: 0.5, fontSize: "0.78rem", color: "text.secondary" }}>{t("duplicates.more", { count: more })}</Typography>}
        </Box>
        <Box sx={{ flexShrink: 0, display: "flex", flexDirection: "column", alignItems: "flex-end", gap: 0.5, pt: 0.25 }}>
          <Button variant="contained" disableElevation onClick={onKeepAll} disabled={busy} data-testid="duplicates-keep" sx={{ height: 34, fontSize: "0.82rem", fontWeight: 650, textTransform: "none", borderRadius: "8px", whiteSpace: "nowrap" }}>
            {countWords(t, "duplicates.keep", total, { count: total })}
          </Button>
          {errors > 0 && (
            <Typography data-testid="duplicates-fixes" sx={{ fontSize: "0.75rem", color: "text.secondary" }}>
              {countWords(t, "duplicates.fixes", errors, { count: errors })}
            </Typography>
          )}
        </Box>
      </Box>
    </Box>
  );
}
