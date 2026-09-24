import React, { useMemo, useCallback } from "react";
import { DataTable } from "primereact/datatable";
import { Column } from "primereact/column";
import {
  Box,
  Chip,
  Typography,
  Tooltip,
  IconButton,
  useTheme,
  alpha,
  CircularProgress,
} from "@mui/material";
import ErrorOutlineIcon from "@mui/icons-material/ErrorOutline";
import WarningAmberIcon from "@mui/icons-material/WarningAmber";
import InfoOutlinedIcon from "@mui/icons-material/InfoOutlined";
import AutoFixHighIcon from "@mui/icons-material/AutoFixHigh";
import { useLanguage } from "../../contexts/LanguageContext";
import { useDetailPanel } from "../../contexts/DetailPanelContext";
import { useEditMode } from "../../contexts/EditModeContext";
import useFixDialog, { resolveFixMeta as resolveFixMetaFor } from "./useFixDialog";

const SEVERITY_ICONS = {
  error: ErrorOutlineIcon,
  warning: WarningAmberIcon,
  info: InfoOutlinedIcon,
};

const MONOSPACE = '"JetBrains Mono", "Fira Code", monospace';

/**
 * Dense PrimeReact DataTable for the occurrences of one canonical rule.
 *
 * Columns are DYNAMIC: the union of the fields the MobilityData engine
 * returned for this notice code (`finding.context`, in engine order) — a
 * duplicate_key row shows csvRowNumber/oldCsvRowNumber/fieldName1/… while
 * an invalid_url row shows filename/csvRowNumber/fieldName/fieldValue.
 * Nothing is invented, nothing empty is rendered.
 *
 * Two non-engine columns are added only when useful: the severity icon
 * (engine data, rendered compactly) and a Fix action when a deterministic
 * edit-dialog mapping exists for the rule.
 */
function RuleOccurrenceTable({ occurrences, ruleCode }) {
  const theme = useTheme();
  const isDark = theme.palette.mode === "dark";
  const { t } = useLanguage();
  const { openPanel } = useDetailPanel();
  const { editing, touchedEntities } = useEditMode();
  // Shared fix flow (fetch the entity, open the right dialog with the
  // offending fields highlighted; offers to enter edit mode first).
  const { openFix, loadingId, dialogs } = useFixDialog();

  // Aggregate tail markers ("N additional occurrences not sampled…") are
  // not real rows — surface them as a footer note instead of table rows.
  const { rows, aggregates } = useMemo(() => {
    const real = [];
    const tail = [];
    for (const o of occurrences) {
      if (o.aggregate) tail.push(o);
      else real.push(o);
    }
    return { rows: real, aggregates: tail };
  }, [occurrences]);

  // Union of the engine's fields across this rule's occurrences, in the
  // order the engine emitted them.
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

  const resolveFixMeta = useCallback(
    (row) => resolveFixMetaFor({ ...row, ruleCode: row.ruleCode || ruleCode }),
    [ruleCode],
  );

  const hasFixColumn = useMemo(
    () => rows.some((row) => resolveFixMeta(row) !== null),
    [rows, resolveFixMeta],
  );

  const handleFixClick = useCallback(
    (row) => openFix({ ...row, ruleCode: row.ruleCode || ruleCode }),
    [openFix, ruleCode],
  );

  // Rows whose entity was edited since this report was produced: the
  // finding may already be fixed — shown dimmed with a "modified" hint
  // until the next validation run confirms.
  const isTouched = useCallback(
    (row) =>
      Boolean(
        row.entityType &&
          row.entityId &&
          touchedEntities &&
          touchedEntities[`${row.entityType}:${row.entityId}`],
      ),
    [touchedEntities],
  );

  // ── Cell renderers ─────────────────────────────────────────────────────────

  const severityBody = (row) => {
    const sev = row.severity || "error";
    const color = (
      theme.palette.severities[sev] || theme.palette.severities.error
    ).main;
    const Icon = SEVERITY_ICONS[sev] || ErrorOutlineIcon;
    return (
      <Tooltip title={sev} arrow>
        <Box sx={{ display: "flex", alignItems: "center", justifyContent: "center" }}>
          <Icon sx={{ fontSize: 14, color }} />
        </Box>
      </Tooltip>
    );
  };

  // Engine-field cell: a handful of keys get a richer treatment, the rest
  // render as plain monospace values.
  const contextBody = (key) => (row) => {
    const value = row.context ? row.context[key] : undefined;
    if (value === undefined || value === "") {
      return <span style={{ color: theme.palette.text.disabled }}>—</span>;
    }

    // entityId-bearing fields become a link into the detail panel when the
    // normalizer identified the entity.
    if (key === "entityId" && row.entityType && row.entityId) {
      return (
        <Chip
          size="small"
          label={value}
          onClick={() => openPanel(row.entityType, row.entityId)}
          variant="outlined"
          sx={{
            height: 20,
            cursor: "pointer",
            fontSize: "0.68rem",
            fontWeight: 600,
            fontFamily: MONOSPACE,
            color: theme.palette.primary.main,
            borderColor: alpha(theme.palette.primary.main, 0.4),
            "&:hover": {
              bgcolor: alpha(theme.palette.primary.main, 0.08),
            },
          }}
        />
      );
    }

    const isNumericRowRef = /csvrownumber$/i.test(key);
    return (
      <Typography
        variant="caption"
        sx={{
          fontFamily: MONOSPACE,
          fontSize: "0.72rem",
          color: isNumericRowRef ? "text.secondary" : "text.primary",
          wordBreak: "break-word",
        }}
      >
        {value}
      </Typography>
    );
  };

  // Legacy fallback (reports persisted before `context` existed): one
  // message column carrying the normalised detail string.
  const messageBody = (row) => (
    <Typography
      variant="caption"
      sx={{ fontSize: "0.78rem", color: "text.primary", lineHeight: 1.4 }}
    >
      {row.message}
    </Typography>
  );

  const fixBody = (row) => {
    const meta = resolveFixMeta(row);
    if (!meta) return null;
    const isLoading = loadingId === String(row.entityId);
    return (
      <Tooltip title={t("validation.fix.tooltip")} arrow>
        <span>
          <IconButton
            size="small"
            onClick={() => handleFixClick(row)}
            disabled={isLoading}
            sx={{
              color: theme.palette.warning.main,
              opacity: editing ? 1 : 0.6,
              "&:hover": { bgcolor: alpha(theme.palette.warning.main, 0.1) },
            }}
          >
            {isLoading ? (
              <CircularProgress size={14} color="warning" />
            ) : (
              <AutoFixHighIcon sx={{ fontSize: 15 }} />
            )}
          </IconButton>
        </span>
      </Tooltip>
    );
  };

  const tableStyle = {
    fontSize: "0.78rem",
    "--surface-card": theme.palette.background.paper,
    "--surface-section": theme.palette.background.default,
    "--surface-overlay": theme.palette.background.paper,
    "--surface-border": theme.palette.divider,
    "--text-color": theme.palette.text.primary,
    "--text-color-secondary": theme.palette.text.secondary,
  };

  return (
    <>
      <Box
        sx={{
          maxHeight: 360,
          overflow: "auto",
          overscrollBehavior: "contain",
          "& .p-datatable": { fontSize: "0.78rem", fontFamily: "inherit" },
          "& .p-datatable .p-datatable-thead": {
            position: "sticky",
            top: 0,
            zIndex: 2,
          },
          "& .p-datatable .p-datatable-thead > tr > th": {
            backgroundColor: `${theme.palette.background.paper} !important`,
            color: `${theme.palette.text.secondary} !important`,
            fontWeight: "700 !important",
            fontSize: "0.66rem !important",
            letterSpacing: "0.05em",
            fontFamily: MONOSPACE,
            textTransform: "none !important",
            borderBottom: `1px solid ${theme.palette.divider} !important`,
            padding: "6px 10px !important",
            whiteSpace: "nowrap",
          },
          "& .p-datatable .p-datatable-tbody > tr": {
            bgcolor: "transparent",
            transition: "background 0.1s",
          },
          "& .p-datatable .p-datatable-tbody > tr.finding-touched > td": {
            opacity: 0.55,
            textDecoration: "line-through",
            textDecorationColor: alpha(theme.palette.text.secondary, 0.5),
          },
          "& .p-datatable .p-datatable-tbody > tr:hover": {
            bgcolor: isDark ? "rgba(255,255,255,0.03)" : "rgba(0,0,0,0.015)",
          },
          "& .p-datatable .p-datatable-tbody > tr > td": {
            borderBottom: `1px solid ${alpha(theme.palette.divider, 0.5)}`,
            padding: "4px 10px !important",
            textAlign: "left",
            verticalAlign: "middle",
          },
        }}
      >
        <DataTable
          value={rows}
          style={tableStyle}
          size="small"
          rowClassName={(row) => (isTouched(row) ? "finding-touched" : "")}
          emptyMessage={
            <Box sx={{ px: 2, py: 1, color: "text.secondary", fontSize: "0.8rem" }}>
              {t("validation.occurrence.empty")}
            </Box>
          }
        >
          <Column
            field="severity"
            header=""
            body={severityBody}
            style={{ width: "34px", textAlign: "center" }}
          />
          {contextKeys.length > 0 ? (
            contextKeys.map((key) => (
              <Column
                key={key}
                field={`context.${key}`}
                header={key}
                body={contextBody(key)}
                sortable
              />
            ))
          ) : (
            <Column
              field="message"
              header={t("validation.occurrence.column.message")}
              body={messageBody}
              sortable
            />
          )}
          {hasFixColumn && (
            <Column
              header={t("validation.fix.button")}
              body={fixBody}
              style={{ width: "56px", textAlign: "center" }}
            />
          )}
        </DataTable>

        {/* Tail entries the validator did not sample row-by-row */}
        {aggregates.map((agg, i) => (
          <Typography
            key={i}
            variant="caption"
            component="div"
            sx={{
              px: 1.5,
              py: 0.75,
              color: "text.secondary",
              fontStyle: "italic",
              borderTop: `1px dashed ${theme.palette.divider}`,
            }}
          >
            {agg.message}
          </Typography>
        ))}
      </Box>

      {dialogs}
    </>
  );
}

export default RuleOccurrenceTable;
