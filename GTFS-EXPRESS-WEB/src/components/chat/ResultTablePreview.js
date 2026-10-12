/**
 * ResultTablePreview — Compact table preview for SQL results inside an
 * assistant bubble.
 *
 * UX:
 *  - Sticky header row, zebra striping, mono font on cell values.
 *  - Caps at PREVIEW_ROWS rows visible; if more rows exist, surfaces a
 *    "View all in SQL Console" CTA. The full result is the user's; the
 *    chat just samples it for context.
 *  - Empty result → friendly "0 rows" placeholder with a hint to refine.
 *  - Wide tables scroll horizontally; column count chip + row count chip
 *    in the header keep the user oriented.
 *  - Cell values are rendered defensively (null → muted "NULL", booleans
 *    coerced to int strings to match GTFS conventions).
 */

import React, { useMemo } from "react";
import {
  Box,
  Chip,
  IconButton,
  Tooltip,
  alpha,
  useTheme,
} from "@mui/material";
import OpenInNewIcon from "@mui/icons-material/OpenInNew";
import TableViewIcon from "@mui/icons-material/TableView";
import { useLanguage } from "../../contexts/LanguageContext";
import { MONO_FONT } from "../SqlConsole/constants";

const PREVIEW_ROWS = 10;
const PREVIEW_COL_CHARS = 32;

const formatCell = (v) => {
  if (v === null || v === undefined) return { text: "NULL", muted: true };
  if (typeof v === "boolean") return { text: v ? "1" : "0" };
  if (typeof v === "object") return { text: JSON.stringify(v) };
  const s = String(v);
  if (s.length > PREVIEW_COL_CHARS) {
    return { text: s.slice(0, PREVIEW_COL_CHARS - 1) + "…", title: s };
  }
  return { text: s };
};

const formatNumber = (n) => {
  try {
    return new Intl.NumberFormat().format(n);
  } catch {
    return String(n);
  }
};

export default function ResultTablePreview({
  result,
  onOpenInConsole,
  durationMs,
}) {
  const { t } = useLanguage();
  const theme = useTheme();

  const cols = result?.columns || [];
  const rows = result?.rowsPreview || [];
  const rowCount = result?.rowCount ?? rows.length;
  const truncated = Boolean(result?.truncated);

  const visibleRows = useMemo(() => rows.slice(0, PREVIEW_ROWS), [rows]);
  const moreRowsCount = Math.max(0, rowCount - PREVIEW_ROWS);

  const headerBg = alpha(theme.palette.text.primary, 0.06);
  const borderColor = alpha(theme.palette.text.primary, 0.10);
  const stripeBg = alpha(theme.palette.text.primary, 0.025);

  const empty = rowCount === 0;

  return (
    <Box
      sx={{
        mt: 1,
        borderRadius: 1.5,
        overflow: "hidden",
        border: `1px solid ${borderColor}`,
        background: theme.palette.background.paper,
      }}
    >
      {/* Stat strip */}
      <Box
        sx={{
          display: "flex",
          alignItems: "center",
          gap: 0.75,
          px: 1.25,
          py: 0.65,
          background: headerBg,
          borderBottom: `1px solid ${borderColor}`,
        }}
      >
        <TableViewIcon sx={{ fontSize: 14, color: "text.secondary", flexShrink: 0 }} />
        <Chip
          label={t("chat.result.rowCount", { count: formatNumber(rowCount) })}
          size="small"
          sx={{
            height: 18,
            fontSize: "0.62rem",
            fontWeight: 700,
            color: empty ? "text.disabled" : "info.main",
            bgcolor: alpha(
              empty ? theme.palette.text.disabled : theme.palette.info.main,
              0.12,
            ),
            "& .MuiChip-label": { px: 0.85 },
          }}
        />
        {cols.length > 0 && (
          <Chip
            label={t("chat.result.colCount", { count: cols.length })}
            size="small"
            sx={{
              height: 18,
              fontSize: "0.62rem",
              color: "text.secondary",
              bgcolor: alpha(theme.palette.text.primary, 0.06),
              "& .MuiChip-label": { px: 0.85 },
            }}
          />
        )}
        {typeof durationMs === "number" && (
          <Chip
            label={`${durationMs} ms`}
            size="small"
            variant="outlined"
            sx={{
              height: 18,
              fontSize: "0.6rem",
              color: "text.disabled",
              borderColor: alpha(theme.palette.text.primary, 0.15),
              "& .MuiChip-label": { px: 0.7 },
            }}
          />
        )}
        <Box sx={{ flex: 1 }} />
        {onOpenInConsole && (
          <Tooltip title={t("chat.result.openInConsole")}>
            <IconButton
              size="small"
              onClick={onOpenInConsole}
              sx={{ width: 22, height: 22 }}
            >
              <OpenInNewIcon sx={{ fontSize: 13 }} />
            </IconButton>
          </Tooltip>
        )}
      </Box>

      {empty ? (
        <Box
          sx={{
            px: 2,
            py: 2.5,
            textAlign: "center",
            color: "text.disabled",
            fontSize: "0.78rem",
            fontStyle: "italic",
          }}
        >
          {t("chat.result.empty")}
        </Box>
      ) : (
        <Box
          sx={{
            maxHeight: 260,
            overflow: "auto",
            // Custom thin scrollbar matches the rest of the chat panel.
            "&::-webkit-scrollbar": { width: 8, height: 8 },
            "&::-webkit-scrollbar-thumb": {
              background: alpha(theme.palette.text.primary, 0.18),
              borderRadius: 4,
            },
          }}
        >
          <Box
            component="table"
            sx={{
              width: "100%",
              borderCollapse: "separate",
              borderSpacing: 0,
              fontFamily: MONO_FONT,
              fontSize: "0.7rem",
            }}
          >
            <Box component="thead">
              <Box component="tr">
                {cols.map((c) => (
                  <Box
                    key={c}
                    component="th"
                    sx={{
                      position: "sticky",
                      top: 0,
                      zIndex: 1,
                      textAlign: "left",
                      px: 1,
                      py: 0.6,
                      background: headerBg,
                      borderBottom: `1px solid ${borderColor}`,
                      fontWeight: 700,
                      color: "text.primary",
                      whiteSpace: "nowrap",
                      fontSize: "0.66rem",
                      letterSpacing: 0.2,
                    }}
                  >
                    {c}
                  </Box>
                ))}
              </Box>
            </Box>
            <Box component="tbody">
              {visibleRows.map((row, rIdx) => (
                <Box
                  key={rIdx}
                  component="tr"
                  sx={{
                    background: rIdx % 2 === 1 ? stripeBg : "transparent",
                    "&:hover": {
                      background: alpha(theme.palette.primary.main, 0.06),
                    },
                  }}
                >
                  {cols.map((c) => {
                    const cell = formatCell(row[c]);
                    return (
                      <Box
                        key={c}
                        component="td"
                        title={cell.title || undefined}
                        sx={{
                          px: 1,
                          py: 0.5,
                          borderBottom: `1px solid ${alpha(theme.palette.text.primary, 0.06)}`,
                          color: cell.muted ? "text.disabled" : "text.primary",
                          fontStyle: cell.muted ? "italic" : "normal",
                          whiteSpace: "nowrap",
                          maxWidth: 240,
                          overflow: "hidden",
                          textOverflow: "ellipsis",
                        }}
                      >
                        {cell.text}
                      </Box>
                    );
                  })}
                </Box>
              ))}
            </Box>
          </Box>
        </Box>
      )}

      {(moreRowsCount > 0 || truncated) && onOpenInConsole && (
        <Box
          onClick={onOpenInConsole}
          sx={{
            px: 1.5,
            py: 0.75,
            background: alpha(theme.palette.primary.main, 0.04),
            borderTop: `1px solid ${borderColor}`,
            color: "primary.main",
            fontSize: "0.7rem",
            fontWeight: 600,
            cursor: "pointer",
            display: "flex",
            alignItems: "center",
            justifyContent: "center",
            gap: 0.5,
            "&:hover": {
              background: alpha(theme.palette.primary.main, 0.10),
            },
          }}
        >
          {t("chat.result.viewAll", {
            count: formatNumber(moreRowsCount > 0 ? moreRowsCount : rowCount),
          })}
          <OpenInNewIcon sx={{ fontSize: 12 }} />
        </Box>
      )}
    </Box>
  );
}
