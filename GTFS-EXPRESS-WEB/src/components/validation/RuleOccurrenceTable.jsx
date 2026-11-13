import React, { useMemo, useCallback } from "react";
import { DataTable } from "primereact/datatable";
import { Column } from "primereact/column";
import { Box, Button, ButtonBase, CircularProgress, Typography, useTheme, alpha } from "@mui/material";
import { visuallyHidden } from "../common/StatusBar";
import EditOutlinedIcon from "@mui/icons-material/EditOutlined";
import ReplayRoundedIcon from "@mui/icons-material/ReplayRounded";
import { useLanguage } from "../../contexts/LanguageContext";
import { useDetailPanel } from "../../contexts/DetailPanelContext";
import { useEditMode } from "../../contexts/EditModeContext";
import useFixDialog, { resolveFixMeta as resolveFixMetaFor } from "./useFixDialog";
import { weightOf } from "./reportModel";

const MONOSPACE = '"JetBrains Mono", "Fira Code", monospace';

// The validator's generic fields said in the reader's words; every other field keeps the engine's own name (a GTFS
// field is never translated).
const COLUMN_KEYS = { entityId: "validation.column.entity", filename: "validation.column.file", fieldName: "validation.column.field", fieldValue: "validation.column.value", csvRowNumber: "validation.column.row" };
const columnLabel = (key, t) => (COLUMN_KEYS[key] ? t(COLUMN_KEYS[key]) : key);
// The keys an edit names a finding's row by: its record, or the row the import kept aside.
const keysOf = (row) => [row.entityType && row.entityId ? `${row.entityType}:${row.entityId}` : null, row.asideId != null ? `aside:${row.asideId}` : null].filter(Boolean);

/**
 * The occurrences of one rule, filling the space it is given. Its columns are the fields the MobilityData engine
 * returned for this notice code, in its order: nothing invented, nothing empty rendered. « Corriger » only where an
 * editor fits the finding; a finding corrected since the report says it is being checked, and one the next report
 * still holds after its correction says so beside « Corriger ».
 */
function RuleOccurrenceTable({ occurrences, ruleCode }) {
  const theme = useTheme();
  const { t } = useLanguage();
  const { openPanel } = useDetailPanel();
  const { touchedEntities, recheckedEntities } = useEditMode();
  const { openFix, loadingId, dialogs } = useFixDialog();

  // A sampled tail (« N more not sampled ») is no row: the footer says how many the validator left out.
  const { rows, notSampled } = useMemo(() => {
    const real = [];
    let tail = 0;
    for (const o of occurrences) {
      if (o.aggregate) tail += weightOf(o);
      else real.push(o);
    }
    return { rows: real, notSampled: tail };
  }, [occurrences]);

  const contextKeys = useMemo(() => {
    const keys = [];
    const seen = new Set();
    for (const row of rows) {
      for (const key of Object.keys(row.context || {})) {
        if (!seen.has(key)) {
          seen.add(key);
          keys.push(key);
        }
      }
    }
    return keys;
  }, [rows]);

  const resolveFixMeta = useCallback((row) => resolveFixMetaFor({ ...row, ruleCode: row.ruleCode || ruleCode }), [ruleCode]);

  // An entity edited since the report may already be fixed: dimmed, « being checked », until the next report says.
  const isTouched = useCallback((row) => keysOf(row).some((k) => touchedEntities?.[k]), [touchedEntities]);
  // Corrected, checked again, and still reported: the correction did not settle it.
  const isStill = useCallback((row) => !isTouched(row) && keysOf(row).some((k) => recheckedEntities?.[k]), [isTouched, recheckedEntities]);
  const hasFixColumn = useMemo(() => rows.some((row) => resolveFixMeta(row) !== null || isTouched(row)), [rows, resolveFixMeta, isTouched]);

  const contextBody = (key) => (row) => {
    const value = row.context ? row.context[key] : undefined;
    if (value === undefined || value === "") return <span style={{ color: theme.palette.text.disabled }}>—</span>;
    if (key === "entityId" && row.entityType && row.entityId) {
      return (
        <ButtonBase
          onClick={() => openPanel(row.entityType, row.entityId)}
          sx={{ font: "inherit", fontFamily: MONOSPACE, fontSize: "0.78rem", fontWeight: 600, color: "primary.main", borderRadius: "4px", "&:hover": { textDecoration: "underline" }, "&.Mui-focusVisible": { outline: `2px solid ${theme.palette.primary.main}`, outlineOffset: 2 } }}
        >
          {value}
        </ButtonBase>
      );
    }
    const isRowRef = /csvrownumber$/i.test(key);
    return (
      <Typography component="span" sx={{ fontFamily: MONOSPACE, fontSize: isRowRef ? "0.74rem" : "0.78rem", color: isRowRef ? "text.secondary" : "text.primary", fontVariantNumeric: "tabular-nums", overflowWrap: "anywhere" }}>
        {value}
      </Typography>
    );
  };

  // A stored report without `context`: one message column.
  const messageBody = (row) => (
    <Typography component="span" sx={{ fontSize: "0.8rem", color: "text.primary", lineHeight: 1.45 }}>
      {row.message}
    </Typography>
  );

  const pill = (tone, testId, icon, words) => (
    <Box component="span" data-testid={testId} sx={{ display: "inline-flex", alignItems: "center", gap: 0.6, height: 26, px: 1, borderRadius: 99, fontSize: "0.75rem", fontWeight: 600, whiteSpace: "nowrap", color: tone, bgcolor: alpha(tone, theme.palette.mode === "dark" ? 0.16 : 0.08) }}>
      {icon}
      {words}
    </Box>
  );

  const fixBody = (row) => {
    if (isTouched(row)) return pill(theme.palette.primary.main, "occurrence-checking", <CircularProgress size={11} thickness={6} color="inherit" />, t("validation.occurrence.checking"));
    if (!resolveFixMeta(row)) return null;
    const isLoading = loadingId === String(row.entityId);
    const still = isStill(row);
    return (
      <Box sx={{ display: "inline-flex", alignItems: "center", gap: 1 }}>
        {still && pill(theme.palette.severities.error.main, "occurrence-still", <ReplayRoundedIcon sx={{ fontSize: 14 }} />, t("validation.occurrence.still"))}
      <Button
        size="small"
        variant="outlined"
        color="inherit"
        onClick={() => openFix({ ...row, ruleCode: row.ruleCode || ruleCode })}
        disabled={isLoading}
        data-testid="occurrence-fix"
        startIcon={isLoading ? null : <EditOutlinedIcon sx={{ fontSize: "15px !important" }} />}
        sx={{ height: 30, minWidth: 96, px: 1.25, gap: 0, whiteSpace: "nowrap", flexShrink: 0, borderRadius: "8px", fontSize: "0.8rem", fontWeight: 600, textTransform: "none", color: "primary.main", borderColor: alpha(theme.palette.primary.main, 0.3), bgcolor: alpha(theme.palette.primary.main, theme.palette.mode === "dark" ? 0.1 : 0.04), "& .MuiButton-startIcon": { mr: 0.6 }, "&:hover": { borderColor: theme.palette.primary.main, bgcolor: alpha(theme.palette.primary.main, theme.palette.mode === "dark" ? 0.18 : 0.09) } }}
      >
        {isLoading ? <CircularProgress size={13} color="inherit" /> : t("validation.fix.button")}
      </Button>
      </Box>
    );
  };

  const tableStyle = {
    "--surface-card": theme.palette.background.paper,
    "--surface-section": theme.palette.background.paper,
    "--surface-overlay": theme.palette.background.paper,
    "--surface-border": theme.palette.divider,
    "--text-color": theme.palette.text.primary,
    "--text-color-secondary": theme.palette.text.secondary,
  };
  const edge = { "&:first-of-type": { paddingLeft: "28px !important" }, "&:last-of-type": { paddingRight: "28px !important" } };

  return (
    <>
      <Box
        data-testid="occurrence-table"
        sx={{
          flex: 1,
          minHeight: 0,
          overflow: "auto",
          overscrollBehavior: "contain",
          bgcolor: "background.paper",
          "& .p-datatable": { fontSize: "0.8125rem", fontFamily: "inherit" },
          "& .p-datatable .p-datatable-thead": { position: "sticky", top: 0, zIndex: 2 },
          "& .p-datatable .p-datatable-thead > tr > th": {
            backgroundColor: `${theme.palette.background.default} !important`,
            color: `${theme.palette.text.secondary} !important`,
            fontWeight: "600 !important",
            fontSize: "0.75rem !important",
            textTransform: "none !important",
            borderBottom: `1px solid ${theme.palette.divider} !important`,
            padding: "0 16px !important",
            height: 36,
            whiteSpace: "nowrap",
            ...edge,
          },
          "& .p-datatable .p-datatable-tbody > tr": { bgcolor: "transparent", transition: "background 0.1s" },
          "& .p-datatable .p-datatable-tbody > tr:hover": { bgcolor: theme.palette.action.hover },
          "& .p-datatable .p-datatable-tbody > tr.finding-touched > td": { opacity: 0.55 },
          "& .p-datatable .p-datatable-tbody > tr.finding-touched > td:last-of-type": { opacity: 1 },
          "& .p-datatable .p-datatable-tbody > tr > td": {
            borderBottom: `1px solid ${alpha(theme.palette.divider, 0.6)}`,
            padding: "6px 16px !important",
            height: 40,
            textAlign: "left",
            verticalAlign: "middle",
            ...edge,
          },
        }}
      >
        <DataTable
          value={rows}
          style={tableStyle}
          size="small"
          rowClassName={(row) => (isTouched(row) ? "finding-touched" : "")}
          emptyMessage={<Box sx={{ px: 1, py: 1, color: "text.secondary", fontSize: "0.8rem" }}>{t("validation.occurrence.empty")}</Box>}
        >
          {contextKeys.length > 0 ? (
            contextKeys.map((key) => <Column key={key} field={`context.${key}`} header={columnLabel(key, t)} body={contextBody(key)} sortable />)
          ) : (
            <Column field="message" header={t("validation.occurrence.column.message")} body={messageBody} sortable />
          )}
          {hasFixColumn && (
            <Column
              header={<Box component="span" sx={visuallyHidden}>{t("validation.occurrence.actions")}</Box>}
              body={fixBody}
              style={{ width: "148px", textAlign: "right", whiteSpace: "nowrap" }}
            />
          )}
        </DataTable>
        {notSampled > 0 && (
          <Typography data-testid="occurrence-not-sampled" sx={{ px: 3.5, py: 1.5, fontSize: "0.78rem", color: "text.secondary", fontVariantNumeric: "tabular-nums" }}>
            {t("validation.occurrence.sampled", { shown: rows.length.toLocaleString(), total: (rows.length + notSampled).toLocaleString() })}
          </Typography>
        )}
      </Box>
      {dialogs}
    </>
  );
}

export default RuleOccurrenceTable;
