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
  CURRENT_QUERY_KEY,
} from "../SqlConsole/constants";
import { CLOSE_VALIDATION_REPORT_EVENT, SET_QUERY_EVENT } from "../../utils/appEvents";

// Beyond this the IN (...) list is cut and a SQL comment says so: SQLite takes more, but 10k IDs in a textarea is worse.
const MAX_IDS_IN_QUERY = 500;

// GTFS table and key names, matching the backend schema: never translated.
const ENTITY_TABLE_MAP = {
  stop: { table: "stops", pk: "stop_id" },
  route: { table: "routes", pk: "route_id" },
  trip: { table: "trips", pk: "trip_id" },
};

/** The dominant entity type of the occurrences, for a generic rule mapping (entityType=null). */
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
 * Pushes an UPDATE skeleton over a rule group's entity IDs into the SQL console, never run by itself: the person
 * replaces its `<value>` placeholder first. Hidden under two IDs, where the per-row fix is quicker.
 */
function FixInSqlConsoleButton({ ruleCode, occurrences }) {
  const theme = useTheme();
  const { t } = useLanguage();
  const { editing, enterEditMode } = useEditMode();
  const { showSqlConsole } = useDetailPanel();
  const [snackbar, setSnackbar] = useState(null);

  // The rule's mapping wins; a generic rule takes the occurrences' majority type.
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

    // A mixed rule leaves out the occurrences of another type than the majority's.
    const idSet = new Set();
    for (const o of occurrences) {
      if (!o.entityId) continue;
      if (mapping.entityType) {
        // A strict mapping takes every occurrence as its type.
        idSet.add(String(o.entityId));
      } else if (o.entityType === entityType) {
        idSet.add(String(o.entityId));
      }
    }
    const ids = Array.from(idSet);
    if (ids.length === 0) return null;

    // A generic rule carries its field on the occurrence.
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

      // Outside edit mode a snackbar offers to enter it, then runs the click again.
      if (!editing) {
        setSnackbar({
          message: t("validation.fixInSql.needsEditMode"),
          severity: "warning",
          action: {
            label: t("validation.fixInSql.enterEditMode"),
            onClick: async () => {
              setSnackbar(null);
              const result = await enterEditMode();
              if (result?.ok) {
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

      // IDs are escaped as SQL literals: an ID may hold a quote.
      const idList = usedIds
        .map((id) => `'${String(id).replace(/'/g, "''")}'`)
        .join(", ");

      const placeholderHint = t("validation.fixInSql.placeholderHint");
      const headerComment = t("validation.fixInSql.commentTemplate", {
        ruleCode,
        count: totalIds,
        entityType,
      });

      // Every mapped field gets the placeholder, so the person sees each column to set.
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

      // The console, not mounted yet, reads this key when it mounts: an event alone would be lost in the swap.
      try {
        sessionStorage.setItem(CURRENT_QUERY_KEY, query);
      } catch {
        /* sessionStorage disabled: the event below still reaches a mounted console. */
      }
      // The report and the console render one at a time: without this, showSqlConsole() is silently ignored.
      window.dispatchEvent(new CustomEvent(CLOSE_VALIDATION_REPORT_EVENT));
      // For a console already mounted.
      window.dispatchEvent(
        new CustomEvent(SET_QUERY_EVENT, {
          detail: { query, autorun: false },
        }),
      );
      showSqlConsole();

      setSnackbar({
        message: t("validation.fixInSql.toast"),
        severity: "success",
      });
    },
    [resolution, editing, enterEditMode, showSqlConsole, ruleCode, t],
  );

  const closeSnackbar = useCallback(() => setSnackbar(null), []);

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
