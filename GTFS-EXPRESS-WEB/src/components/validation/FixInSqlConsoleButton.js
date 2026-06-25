import React, { useCallback, useMemo, useState } from "react";
import {
  Button,
  Tooltip,
  Snackbar,
  Alert,
  useTheme,
  alpha,
} from "@mui/material";
import AutoFixHighIcon from "@mui/icons-material/AutoFixHigh";
import { useLanguage } from "../../contexts/LanguageContext";
import { useEditMode } from "../../contexts/EditModeContext";
import { useDetailPanel } from "../../contexts/DetailPanelContext";
import { getFixMetaForRule } from "../../utils/ruleFieldMapping";
import {
  SET_QUERY_EVENT,
  CURRENT_QUERY_KEY,
} from "../SqlConsole/constants";

// Maximum number of IDs included in the IN (...) clause. Beyond this we slice
// and warn the user via a SQL comment. SQLite supports more, but the UX cost
// of pasting 10k IDs into a textarea is worse than the partial-fix tradeoff.
const MAX_IDS_IN_QUERY = 500;

// Map editable entity types to (table, primary key column) pairs. Kept in sync
// with the backend SQLite schema — DO NOT translate or alias these names; they
// are GTFS spec field identifiers.
const ENTITY_TABLE_MAP = {
  stop: { table: "stops", pk: "stop_id" },
  route: { table: "routes", pk: "route_id" },
  trip: { table: "trips", pk: "trip_id" },
};

/**
 * Compute the dominant entity type for occurrences when the rule mapping is
 * generic (entityType=null). Returns { entityType, majorityCount, ignored }.
 */
function pickMajorityEntityType(occurrences) {
  const counts = {};
  for (const o of occurrences) {
    if (!o.entityType || !o.entityId) continue;
    if (!ENTITY_TABLE_MAP[o.entityType]) continue;
    counts[o.entityType] = (counts[o.entityType] || 0) + 1;
  }
  const entries = Object.entries(counts);
  if (entries.length === 0) return null;
  entries.sort((a, b) => b[1] - a[1]);
  const [majority, majorityCount] = entries[0];
  const ignored = entries.slice(1).reduce((acc, [, c]) => acc + c, 0);
  return { entityType: majority, majorityCount, ignored };
}

/**
 * Bulk-fix accelerator: collects all entity IDs from a rule group's
 * occurrences, generates a SQL UPDATE skeleton with a `<value>` placeholder,
 * and pushes it into the SQL Console (autorun=false — user must replace the
 * placeholder before running).
 *
 * Visibility rules:
 *   - Hidden when no editable mapping exists for the rule
 *   - Hidden when fewer than 2 distinct entity IDs are present (single-row
 *     fix is more efficient via the per-row Fix button)
 *   - Disabled (with a "needs edit mode" snackbar CTA) when not in edit mode
 */
function FixInSqlConsoleButton({ ruleCode, occurrences }) {
  const theme = useTheme();
  const { t } = useLanguage();
  const { editing, enterEditMode } = useEditMode();
  const { showSqlConsole } = useDetailPanel();
  const [snackbar, setSnackbar] = useState(null);

  // Resolve entity type: rule-mapping wins; fallback to occurrences majority
  // for generic rules (entityType=null in the mapping).
  const resolution = useMemo(() => {
    const mapping = getFixMetaForRule(ruleCode);
    if (!mapping) return null;

    let entityType = mapping.entityType;
    let mixedInfo = null;
    if (!entityType) {
      const majority = pickMajorityEntityType(occurrences);
      if (!majority) return null;
      entityType = majority.entityType;
      if (majority.ignored > 0) {
        mixedInfo = {
          majorityCount: majority.majorityCount,
          majorityType: majority.entityType,
          ignored: majority.ignored,
        };
      }
    }

    if (!ENTITY_TABLE_MAP[entityType]) return null;

    // Collect unique IDs that match the resolved entity type. For mixed-rule
    // cases this filters out occurrences whose entityType differs from the
    // majority pick.
    const idSet = new Set();
    for (const o of occurrences) {
      if (!o.entityId) continue;
      if (mapping.entityType) {
        // Strict mapping — every occurrence is assumed to be the same type
        idSet.add(String(o.entityId));
      } else if (o.entityType === entityType) {
        idSet.add(String(o.entityId));
      }
    }
    const ids = Array.from(idSet);
    if (ids.length === 0) return null;

    // Effective fields: rule-mapping wins; fallback to first occurrence with
    // a `field` value (generic rules carry it on the row).
    let fields = mapping.fields;
    if (!fields || fields.length === 0) {
      const fromOcc = occurrences.find((o) => o.field)?.field;
      fields = fromOcc ? [fromOcc] : [];
    }
    if (!fields || fields.length === 0) return null;

    return { entityType, ids, fields, mixedInfo };
  }, [ruleCode, occurrences]);

  const handleClick = useCallback(
    (e) => {
      e.stopPropagation();
      if (!resolution) return;

      // Edit mode required: surface a snackbar with a CTA that re-enters edit
      // mode and re-triggers the click. We capture `e` before await so the
      // re-trigger can dispatch a synthetic stopPropagation no-op safely.
      if (!editing) {
        setSnackbar({
          message: t("validation.fixInSql.needsEditMode"),
          severity: "warning",
          action: {
            label: t("validation.fixInSql.enterEditMode"),
            onClick: async () => {
              setSnackbar(null);
              const ok = await enterEditMode();
              if (ok) {
                // Re-run the same flow now that editing=true (next render).
                // We synthesize a no-op event so handleClick can early-return
                // its stopPropagation safely.
                handleClick({ stopPropagation: () => {} });
              }
            },
          },
        });
        return;
      }

      const { entityType, ids, fields, mixedInfo } = resolution;
      const { table, pk } = ENTITY_TABLE_MAP[entityType];
      const totalIds = ids.length;
      const usedIds = ids.slice(0, MAX_IDS_IN_QUERY);
      const truncated = totalIds > MAX_IDS_IN_QUERY;

      // SQL string literal escaping: GTFS IDs are safe ASCII in practice but
      // we still escape single quotes defensively (id'with-quote → id''…).
      const idList = usedIds
        .map((id) => `'${String(id).replace(/'/g, "''")}'`)
        .join(", ");

      const placeholderHint = t("validation.fixInSql.placeholderHint");
      const headerComment = t("validation.fixInSql.commentTemplate", {
        ruleCode,
        count: totalIds,
        entityType,
      });

      // Build the SQL. If multiple fields are mapped, set them to the same
      // placeholder so the user can see all relevant columns at once and tweak.
      const setClause = fields
        .map((f) => `  ${f} = '<value>'`)
        .join(",\n");

      let query = `-- ${headerComment}\n`;
      if (truncated) {
        query += `-- ${t("validation.fixInSql.truncatedNote", { total: totalIds })}\n`;
      }
      if (mixedInfo) {
        query += `-- ${t("validation.fixInSql.tooltipMixed", {
          majorityCount: mixedInfo.majorityCount,
          majorityType: mixedInfo.majorityType,
          ignored: mixedInfo.ignored,
        })}\n`;
      }
      query += `UPDATE ${table}\n`;
      query += `SET\n${setClause}  -- ${placeholderHint}\n`;
      query += `WHERE ${pk} IN (${idList});\n`;

      // Step 1: persist the query to sessionStorage with the SAME key the
      // SqlConsole reads in its useState initialiser. Critical when the
      // console is not yet mounted (typical case here — we're navigating
      // FROM the validation report TO the console). Synchronously
      // dispatched events would be lost; sessionStorage survives the
      // mutex-render swap.
      try {
        sessionStorage.setItem(CURRENT_QUERY_KEY, query);
      } catch {
        /* sessionStorage may be disabled — fall through, the event below
           still works when the console is already mounted. */
      }
      // Step 2: close the validation report page. It's mutex-rendered with
      // the SQL Console in GTFSApp's view tree, so without this dismiss the
      // showSqlConsole() call below would be silently ignored — user sees
      // the toast but stays stuck on the report.
      window.dispatchEvent(new CustomEvent("gtfs:close-validation-report"));
      // Step 3: dispatch the set-query event for the case where the console
      // IS already mounted (e.g. fix triggered from a different surface
      // than the validation page). Idempotent with the sessionStorage seed.
      window.dispatchEvent(
        new CustomEvent(SET_QUERY_EVENT, {
          detail: { query, autorun: false },
        }),
      );
      // Step 4: surface the SQL Console (sets the visibility flag — reaches
      // the right branch in GTFSApp now that the report is dismissed).
      showSqlConsole();

      setSnackbar({
        message: t("validation.fixInSql.toast"),
        severity: "success",
      });
    },
    [resolution, editing, enterEditMode, showSqlConsole, ruleCode, t],
  );

  const closeSnackbar = useCallback(() => setSnackbar(null), []);

  // Visibility gate: nothing to show if mapping/IDs missing or single-row.
  if (!resolution) return null;
  const totalIds = resolution.ids.length;
  if (totalIds < 2) return null;

  const truncated = totalIds > MAX_IDS_IN_QUERY;
  const buttonLabel = truncated
    ? t("validation.fixInSql.buttonOver", { count: totalIds })
    : t("validation.fixInSql.button", { count: totalIds });

  const tooltipText = !editing
    ? t("validation.fixInSql.needsEditMode")
    : t("validation.fixInSql.tooltip", {
        count: totalIds,
        entityType: resolution.entityType,
        ruleCode,
        fields: resolution.fields.join(", "),
      });

  return (
    <>
      <Tooltip title={tooltipText} arrow>
        <span>
          <Button
            size="small"
            variant="contained"
            color="warning"
            startIcon={<AutoFixHighIcon sx={{ fontSize: 15 }} />}
            onClick={handleClick}
            sx={{
              flexShrink: 0,
              height: 24,
              px: 1,
              fontSize: "0.7rem",
              fontWeight: 700,
              textTransform: "none",
              boxShadow: "none",
              opacity: editing ? 1 : 0.6,
              "&:hover": {
                boxShadow: "none",
                bgcolor: alpha(theme.palette.warning.main, 0.85),
              },
            }}
          >
            {buttonLabel}
          </Button>
        </span>
      </Tooltip>

      <Snackbar
        open={Boolean(snackbar)}
        autoHideDuration={snackbar?.action ? null : 4000}
        onClose={closeSnackbar}
        anchorOrigin={{ vertical: "bottom", horizontal: "center" }}
      >
        {snackbar ? (
          <Alert
            severity={snackbar.severity || "info"}
            onClose={closeSnackbar}
            action={
              snackbar.action ? (
                <Button
                  color="inherit"
                  size="small"
                  onClick={snackbar.action.onClick}
                >
                  {snackbar.action.label}
                </Button>
              ) : undefined
            }
            sx={{ alignItems: "center" }}
          >
            {snackbar.message}
          </Alert>
        ) : (
          <span />
        )}
      </Snackbar>
    </>
  );
}

export default FixInSqlConsoleButton;
