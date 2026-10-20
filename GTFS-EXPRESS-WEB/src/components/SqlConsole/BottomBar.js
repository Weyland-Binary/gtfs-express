import React from "react";
import {
  Box,
  IconButton,
  Tooltip,
  TextField,
  Divider,
  InputAdornment,
} from "@mui/material";
import { alpha, useTheme } from "@mui/material/styles";
import RefreshIcon from "@mui/icons-material/Refresh";
import EditIcon from "@mui/icons-material/Edit";
import DeleteOutlineIcon from "@mui/icons-material/DeleteOutline";
import CloseIcon from "@mui/icons-material/Close";
import SearchIcon from "@mui/icons-material/Search";
import AddIcon from "@mui/icons-material/Add";
import FileDownloadIcon from "@mui/icons-material/FileDownload";
import ArrowDropDownIcon from "@mui/icons-material/ArrowDropDown";
import { MONO_FONT } from "./constants";
import { formatRowCount } from "./formatters";

/**
 * BottomBar — the DBeaver-style strip pinned under the result: the filter on
 * the rows shown, the row actions (refresh, insert, edit the selection,
 * delete the selection — always visible, their tooltip saying why one is
 * greyed out), the export menu's button, and the status pushed right (rows ·
 * selected · filtered · ms · truncated) with the selection's clear.
 */
export default function BottomBar({
  result,
  filter,
  setFilter,
  debouncedFilter,
  filteredRows,
  allRows,
  running,
  query,
  lastRanQuery,
  runQueryWith,
  editable,
  selectedRows,
  clearSelection,
  canInsert,
  insertDisabledKey,
  beginInlineInsert,
  pendingInsertRow,
  canEdit,
  editDisabledKey,
  openMutator,
  canDelete,
  deleteDisabledKey,
  deleting,
  setDeleteConfirmOpen,
  setExportAnchor,
  t,
}) {
  const theme = useTheme();
  const isDark = theme.palette.mode === "dark";
  return (
    <>
      {/* ---------- DBeaver-style bottom toolbar ----------
      Persistent, full-width strip pinned to the bottom of the
      result area. 36px height to match the top status bar.
      Carries:
      - filter input (left)
      - row actions: refresh / insert / edit / delete (icons)
      - export menu (CSV / JSON / SQL / Markdown — anchored)
      - status push-end: rows · selected · ms · truncated
      - clear-selection IconButton (only when selection > 0)
      Buttons stay visible at all times; their disabled state
      signals *why* an action is unavailable via tooltip copy
      (`bottomBar.tooltip.disabled.*`). Solid surfaceAlt keeps
      it readable over both light and dark table backgrounds. */}
      <Box
        sx={{
          display: "flex",
          alignItems: "center",
          gap: 0.75,
          px: 1.25,
          height: 36,
          borderTop: `1px solid ${theme.palette.divider}`,
          background: alpha(
            theme.palette.text.primary,
            isDark ? 0.04 : 0.025,
          ),
          flexShrink: 0,
        }}
      >
        {/* Filter input — sized to fit toolbar height (28px). */}
        <TextField
          size="small"
          placeholder={t("sqlConsole.bottomBar.filter")}
          value={filter}
          onChange={(e) => setFilter(e.target.value)}
          disabled={!result}
          sx={{
            width: 240,
            "& .MuiOutlinedInput-root": {
              height: 28,
              background: theme.palette.background.paper,
            },
          }}
          slotProps={{
            input: {
              startAdornment: (
                <InputAdornment position="start">
                  <SearchIcon
                    sx={{
                      fontSize: 14,
                      color: theme.palette.text.disabled,
                    }}
                  />
                </InputAdornment>
              ),
              endAdornment: filter ? (
                <InputAdornment position="end">
                  <IconButton
                    size="small"
                    onClick={() => setFilter("")}
                    aria-label={t("sqlConsole.filterResults")}
                    sx={{ width: 22, height: 22 }}
                  >
                    <CloseIcon sx={{ fontSize: 14 }} />
                  </IconButton>
                </InputAdornment>
              ) : null,
            },
            htmlInput: {
              style: { fontSize: 12, padding: "2px 6px" },
              "aria-label": t("sqlConsole.bottomBar.filter"),
            },
          }}
        />

        <Divider
          orientation="vertical"
          flexItem
          sx={{ my: 0.75, borderColor: theme.palette.divider }}
        />

        {/* Row actions — uniform 28×28 icon buttons. */}
        <Tooltip title={t("sqlConsole.refresh")} arrow>
          <span>
            <IconButton
              size="small"
              onClick={() => runQueryWith(lastRanQuery || query)}
              disabled={running || !lastRanQuery}
              aria-label={t("sqlConsole.refresh")}
              sx={{ width: 28, height: 28 }}
            >
              <RefreshIcon fontSize="small" />
            </IconButton>
          </span>
        </Tooltip>

        <Tooltip
          title={
            canInsert
              ? t("sqlConsole.insertRow.tooltip", {
                  table: editable?.table || "",
                })
              : t(insertDisabledKey)
          }
          arrow
        >
          <span>
            <IconButton
              size="small"
              onClick={beginInlineInsert}
              disabled={!canInsert || Boolean(pendingInsertRow)}
              aria-label={t("sqlConsole.insertRow")}
              sx={{ width: 28, height: 28 }}
            >
              <AddIcon fontSize="small" />
            </IconButton>
          </span>
        </Tooltip>

        <Tooltip
          title={
            canEdit
              ? t("sqlConsole.editSelected", {
                  count: selectedRows.size,
                })
              : t(editDisabledKey)
          }
          arrow
        >
          <span>
            <IconButton
              size="small"
              onClick={openMutator}
              disabled={!canEdit}
              sx={{
                width: 28,
                height: 28,
                color: canEdit
                  ? theme.palette.primary.main
                  : undefined,
              }}
              aria-label={t("sqlConsole.editSelected", {
                count: selectedRows.size,
              })}
            >
              <EditIcon fontSize="small" />
            </IconButton>
          </span>
        </Tooltip>

        <Tooltip
          title={
            canDelete
              ? t("sqlConsole.deleteSelected", {
                  count: selectedRows.size,
                })
              : t(deleteDisabledKey)
          }
          arrow
        >
          <span>
            <IconButton
              size="small"
              onClick={() => setDeleteConfirmOpen(true)}
              disabled={!canDelete || deleting}
              sx={{
                width: 28,
                height: 28,
                color: canDelete
                  ? theme.palette.error.main
                  : undefined,
              }}
              aria-label={t("sqlConsole.deleteSelected", {
                count: selectedRows.size,
              })}
            >
              <DeleteOutlineIcon fontSize="small" />
            </IconButton>
          </span>
        </Tooltip>

        <Divider
          orientation="vertical"
          flexItem
          sx={{ my: 0.75, borderColor: theme.palette.divider }}
        />

        {/* Export menu — anchored on the icon, opens a 4×download +
      4×clipboard menu. Disabled when there are no rows. */}
        <Tooltip title={t("sqlConsole.export.menu")} arrow>
          <span>
            <IconButton
              size="small"
              onClick={(e) => setExportAnchor(e.currentTarget)}
              disabled={!result?.rows?.length}
              aria-label={t("sqlConsole.export.menu")}
              sx={{
                height: 28,
                borderRadius: 1,
                px: 0.5,
              }}
            >
              <FileDownloadIcon fontSize="small" />
              <ArrowDropDownIcon sx={{ fontSize: 16, ml: -0.25 }} />
            </IconButton>
          </span>
        </Tooltip>

        {/* Status push-end. Plain spans (no Chips) — DBeaver-style:
      compact mono-font row with tabular-nums (so digits don't
      jiggle as counts update), separators are middots. We
      always render rows; selection / filter / ms / truncated
      are conditional so the bar stays clean on simple SELECTs. */}
        <Box
          sx={{
            ml: "auto",
            display: "flex",
            alignItems: "center",
            gap: 0.75,
            fontSize: 11,
            color: theme.palette.text.secondary,
            fontFamily: MONO_FONT,
            fontVariantNumeric: "tabular-nums",
            whiteSpace: "nowrap",
          }}
        >
          <span>
            {t("sqlConsole.statusRows", {
              rows: formatRowCount(allRows.length),
            })}
          </span>
          {selectedRows.size > 0 && (
            <>
              <span style={{ opacity: 0.5 }}>·</span>
              <Box
                component="span"
                sx={{
                  color: theme.palette.primary.main,
                  fontWeight: 700,
                }}
              >
                {t("sqlConsole.statusSelected", {
                  selected: selectedRows.size,
                })}
              </Box>
            </>
          )}
          {debouncedFilter.trim() &&
            filteredRows.length !== allRows.length && (
              <>
                <span style={{ opacity: 0.5 }}>·</span>
                <span>
                  {t("sqlConsole.statusFiltered", {
                    shown: filteredRows.length,
                    total: allRows.length,
                  })}
                </span>
              </>
            )}
          {typeof result.duration_ms === "number" && (
            <>
              <span style={{ opacity: 0.5 }}>·</span>
              <span>
                {t("sqlConsole.statusDuration", {
                  ms: result.duration_ms,
                })}
              </span>
            </>
          )}
          {result.truncated && (
            <>
              <span style={{ opacity: 0.5 }}>·</span>
              <Box
                component="span"
                sx={{
                  color: theme.palette.warning.main,
                  fontWeight: 700,
                }}
              >
                {t("sqlConsole.statusTruncated", { limit: 10000 })}
              </Box>
            </>
          )}
          {selectedRows.size > 0 && (
            <Tooltip
              title={t("sqlConsole.selectionToolbar.clearTooltip")}
              arrow
            >
              <IconButton
                size="small"
                onClick={clearSelection}
                aria-label={t(
                  "sqlConsole.selectionToolbar.clearTooltip",
                )}
                sx={{ ml: 0.5 }}
              >
                <CloseIcon sx={{ fontSize: 14 }} />
              </IconButton>
            </Tooltip>
          )}
        </Box>
      </Box>
    </>
  );
}
