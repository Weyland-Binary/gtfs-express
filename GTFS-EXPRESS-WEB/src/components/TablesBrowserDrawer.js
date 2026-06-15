import React, { useEffect, useMemo, useState } from "react";
import Accordion from "@mui/material/Accordion";
import AccordionSummary from "@mui/material/AccordionSummary";
import AccordionDetails from "@mui/material/AccordionDetails";
import {
  Box,
  Chip,
  Divider,
  Drawer,
  IconButton,
  InputAdornment,
  Skeleton,
  TextField,
  Tooltip,
  Typography,
  alpha,
} from "@mui/material";
import { useTheme } from "@mui/material/styles";
import CloseIcon from "@mui/icons-material/Close";
import ClearIcon from "@mui/icons-material/Clear";
import ExpandMoreIcon from "@mui/icons-material/ExpandMore";
import LaunchIcon from "@mui/icons-material/Launch";
import SearchIcon from "@mui/icons-material/Search";
import TableChartOutlinedIcon from "@mui/icons-material/TableChartOutlined";
import API_BASE_URL from "../config";
import { fetchWithSession } from "../utils/sessionManager";
import { useLanguage } from "../contexts/LanguageContext";
import { useDetailPanel } from "../contexts/DetailPanelContext";
import { openInSqlConsole } from "./chat/openInSqlConsole";

const TABLE_GROUPS = [
  {
    id: "core",
    titleKey: "tablesBrowser.group.core",
    tables: ["agency", "stops", "routes", "trips", "stop_times", "calendar"],
  },
  {
    id: "optional",
    titleKey: "tablesBrowser.group.optional",
    tables: [
      "calendar_dates",
      "shapes",
      "frequencies",
      "transfers",
      "feed_info",
      "levels",
      "pathways",
      "translations",
      "attributions",
    ],
  },
  {
    id: "fares_v1",
    titleKey: "tablesBrowser.group.faresV1",
    tables: ["fare_attributes", "fare_rules"],
  },
  {
    id: "fares_v2",
    titleKey: "tablesBrowser.group.faresV2",
    tables: [
      "areas",
      "stop_areas",
      "networks",
      "route_networks",
      "fare_media",
      "rider_categories",
      "fare_products",
      "timeframes",
      "fare_leg_rules",
      "fare_leg_join_rules",
      "fare_transfer_rules",
    ],
  },
  {
    id: "flex",
    titleKey: "tablesBrowser.group.flex",
    tables: [
      "booking_rules",
      "locations_geojson",
      "location_groups",
      "location_group_stops",
    ],
  },
];

const ALL_KNOWN_TABLES = new Set(TABLE_GROUPS.flatMap((g) => g.tables));

const SKELETON_WIDTHS = [58, 76, 48, 84, 62, 40, 72, 55, 68, 45];

function TablesBrowserDrawer({ open, onClose }) {
  const theme = useTheme();
  const isDark = theme.palette.mode === "dark";
  const { t } = useLanguage();
  const { showSqlConsole } = useDetailPanel();

  const [schema, setSchema] = useState(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState(null);
  const [filter, setFilter] = useState("");
  const [expandedGroups, setExpandedGroups] = useState({});
  const [expandedInitialized, setExpandedInitialized] = useState(false);

  // Reset accordion state on every open so it recomputes from fresh schema
  useEffect(() => {
    if (!open) return;
    setExpandedGroups({});
    setExpandedInitialized(false);
  }, [open]);

  useEffect(() => {
    if (!open) return;
    let cancelled = false;
    setLoading(true);
    setError(null);
    (async () => {
      try {
        const res = await fetchWithSession(`${API_BASE_URL}/sql/schema`);
        if (!res.ok) throw new Error(`HTTP ${res.status}`);
        const data = await res.json();
        if (!cancelled) setSchema(data);
      } catch (err) {
        if (!cancelled) setError(err.message || String(err));
      } finally {
        if (!cancelled) setLoading(false);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [open]);

  const rowCounts = useMemo(() => {
    const map = new Map();
    if (!schema?.tables) return map;
    for (const tbl of schema.tables) {
      if (tbl?.name) map.set(tbl.name, tbl.rowCount ?? tbl.row_count ?? null);
    }
    return map;
  }, [schema]);

  const presentTables = useMemo(() => {
    if (!schema?.tables) return new Set();
    return new Set(schema.tables.map((tbl) => tbl.name));
  }, [schema]);

  // Compute initial accordion state once schema is loaded:
  // open if at least one table in the group is present AND has rows > 0
  useEffect(() => {
    if (loading || !schema || expandedInitialized) return;
    const initial = { other: true };
    for (const group of TABLE_GROUPS) {
      initial[group.id] = group.tables.some(
        (name) =>
          presentTables.has(name) && (rowCounts.get(name) ?? 0) > 0,
      );
    }
    setExpandedGroups(initial);
    setExpandedInitialized(true);
  }, [loading, schema, presentTables, rowCounts, expandedInitialized]);

  const toggleGroup = (groupId) => {
    setExpandedGroups((prev) => ({ ...prev, [groupId]: !prev[groupId] }));
  };

  const handleOpen = (tableName) => {
    openInSqlConsole(`SELECT * FROM ${tableName} LIMIT 100;`, showSqlConsole, {
      autorun: true,
    });
    onClose();
  };

  const normalizedFilter = filter.trim().toLowerCase();

  // When a filter is active, force-expand groups that have matching tables
  const isGroupExpanded = (groupId, tables) => {
    if (normalizedFilter) {
      return tables.some((name) =>
        name.toLowerCase().includes(normalizedFilter),
      );
    }
    if (!expandedInitialized) return true;
    return expandedGroups[groupId] ?? false;
  };

  const getStatus = (name) => {
    if (!presentTables.has(name)) return "absent";
    const count = rowCounts.get(name);
    return count === 0 ? "empty" : "present";
  };

  const renderTableRow = (name, alwaysPresent = false) => {
    const status = alwaysPresent ? "present" : getStatus(name);
    const isClickable = status !== "absent";
    const rowCount = rowCounts.get(name);

    const dotColor =
      status === "present"
        ? theme.palette.success.main
        : status === "empty"
          ? theme.palette.warning.main
          : theme.palette.action.disabled;

    return (
      <Box
        key={name}
        onClick={() => isClickable && handleOpen(name)}
        sx={{
          display: "flex",
          alignItems: "center",
          gap: 1.25,
          px: 2,
          py: 0.85,
          borderLeft: "2px solid transparent",
          cursor: isClickable ? "pointer" : "default",
          userSelect: "none",
          transition: "background-color 0.12s, border-color 0.12s",
          ...(isClickable && {
            "&:hover": {
              backgroundColor: alpha(
                theme.palette.primary.main,
                isDark ? 0.1 : 0.05,
              ),
              borderLeftColor: theme.palette.primary.main,
              "& .tbd-launch": {
                opacity: 1,
                transform: "translateX(0)",
              },
            },
          }),
        }}
      >
        <Box
          sx={{
            width: 6,
            height: 6,
            borderRadius: "50%",
            flexShrink: 0,
            backgroundColor: dotColor,
            ...(status === "present" && {
              boxShadow: `0 0 0 2.5px ${alpha(dotColor, 0.22)}`,
            }),
          }}
        />

        <Typography
          sx={{
            flex: 1,
            fontFamily: 'ui-monospace, "SF Mono", Menlo, Consolas, monospace',
            fontSize: "0.83rem",
            fontWeight: status === "absent" ? 400 : 500,
            letterSpacing: "-0.01em",
            color:
              status === "absent"
                ? theme.palette.text.disabled
                : theme.palette.text.primary,
          }}
        >
          {name}
        </Typography>

        {isClickable && rowCount != null && rowCount > 0 && (
          <Chip
            label={rowCount.toLocaleString()}
            size="small"
            sx={{
              height: 17,
              fontSize: "0.67rem",
              fontFamily: 'ui-monospace, "SF Mono", Menlo, Consolas, monospace',
              fontWeight: 600,
              backgroundColor: alpha(
                theme.palette.primary.main,
                isDark ? 0.14 : 0.07,
              ),
              color: theme.palette.primary.main,
              border: `1px solid ${alpha(theme.palette.primary.main, isDark ? 0.28 : 0.18)}`,
              "& .MuiChip-label": { px: 0.75 },
            }}
          />
        )}

        {isClickable && rowCount === 0 && (
          <Typography
            sx={{
              fontSize: "0.65rem",
              fontFamily: 'ui-monospace, "SF Mono", Menlo, Consolas, monospace',
              fontWeight: 700,
              lineHeight: 1,
              color: theme.palette.warning.main,
              backgroundColor: alpha(theme.palette.warning.main, 0.1),
              border: `1px solid ${alpha(theme.palette.warning.main, 0.25)}`,
              borderRadius: "4px",
              px: 0.75,
              py: 0.35,
            }}
          >
            0
          </Typography>
        )}

        {isClickable && (
          <LaunchIcon
            className="tbd-launch"
            sx={{
              fontSize: 12,
              flexShrink: 0,
              opacity: 0,
              transform: "translateX(-4px)",
              transition: "opacity 0.12s, transform 0.12s",
              color: theme.palette.primary.main,
            }}
          />
        )}
      </Box>
    );
  };

  const accordionSummarySx = {
    minHeight: 0,
    px: 2,
    pt: 2,
    pb: 0.5,
    backgroundColor: isDark
      ? alpha(theme.palette.common.white, 0.04)
      : alpha(theme.palette.common.black, 0.03),
    "&.Mui-expanded": { minHeight: 0 },
    "& .MuiAccordionSummary-content": { my: 0, alignItems: "center" },
    "& .MuiAccordionSummary-expandIconWrapper": { ml: 0.75 },
  };

  const accordionSx = {
    backgroundColor: "transparent",
    backgroundImage: "none",
    boxShadow: "none",
    "&::before": { display: "none" },
  };

  const renderGroup = (group) => {
    const filtered = group.tables.filter(
      (name) =>
        !normalizedFilter || name.toLowerCase().includes(normalizedFilter),
    );
    if (filtered.length === 0) return null;

    const presentCount = group.tables.filter(
      (n) => (rowCounts.get(n) ?? 0) > 0,
    ).length;
    const allPresent = presentCount === group.tables.length;
    const showCount = schema && !loading;
    const forcedOpen = !!normalizedFilter;
    const expanded = isGroupExpanded(group.id, group.tables);

    return (
      <Accordion
        key={group.id}
        expanded={expanded}
        onChange={() => !forcedOpen && toggleGroup(group.id)}
        disableGutters
        square
        sx={accordionSx}
      >
        <AccordionSummary
          expandIcon={
            <ExpandMoreIcon
              sx={{
                fontSize: 15,
                color: theme.palette.text.secondary,
                opacity: forcedOpen ? 0.35 : 1,
              }}
            />
          }
          sx={{
            ...accordionSummarySx,
            cursor: forcedOpen ? "default !important" : "pointer",
            "&:hover": !forcedOpen
              ? {
                  backgroundColor: alpha(theme.palette.text.primary, 0.03),
                }
              : {},
          }}
        >
          <Typography
            variant="caption"
            sx={{
              flex: 1,
              textTransform: "uppercase",
              letterSpacing: "0.08em",
              fontWeight: 700,
              fontSize: "0.62rem",
              color: theme.palette.text.secondary,
            }}
          >
            {t(group.titleKey)}
          </Typography>
          {showCount && (
            <Typography
              variant="caption"
              sx={{
                fontSize: "0.63rem",
                fontFamily: 'ui-monospace, "SF Mono", Menlo, Consolas, monospace',
                fontWeight: 600,
                mr: 0.5,
                color: allPresent
                  ? theme.palette.success.main
                  : theme.palette.text.disabled,
              }}
            >
              {presentCount}/{group.tables.length}
            </Typography>
          )}
        </AccordionSummary>
        <AccordionDetails sx={{ p: 0, pb: 0.75 }}>
          {filtered.map((name) => renderTableRow(name))}
        </AccordionDetails>
      </Accordion>
    );
  };

  const unknownTables = useMemo(() => {
    if (!schema?.tables) return [];
    return schema.tables
      .map((tbl) => tbl.name)
      .filter(
        (n) =>
          n &&
          !ALL_KNOWN_TABLES.has(n) &&
          !n.startsWith("_") &&
          !n.startsWith("sqlite_"),
      );
  }, [schema]);

  const filteredUnknown = unknownTables.filter(
    (name) =>
      !normalizedFilter || name.toLowerCase().includes(normalizedFilter),
  );

  return (
    <Drawer
      anchor="right"
      open={open}
      onClose={onClose}
      PaperProps={{
        sx: {
          width: { xs: "100%", sm: 380 },
          maxWidth: "100vw",
          display: "flex",
          flexDirection: "column",
        },
      }}
    >
      {/* Header */}
      <Box
        sx={{
          display: "flex",
          alignItems: "center",
          justifyContent: "space-between",
          px: 2,
          py: 1.5,
          flexShrink: 0,
          borderBottom: `1px solid ${theme.palette.divider}`,
        }}
      >
        <Box sx={{ display: "flex", alignItems: "center", gap: 1.25 }}>
          <Box
            sx={{
              width: 32,
              height: 32,
              borderRadius: 1.5,
              display: "flex",
              alignItems: "center",
              justifyContent: "center",
              flexShrink: 0,
              backgroundColor: alpha(
                theme.palette.primary.main,
                isDark ? 0.16 : 0.09,
              ),
            }}
          >
            <TableChartOutlinedIcon
              sx={{ color: theme.palette.primary.main, fontSize: 17 }}
            />
          </Box>
          <Box>
            <Typography
              variant="subtitle2"
              fontWeight={700}
              sx={{ lineHeight: 1.25, fontSize: "0.88rem" }}
            >
              {t("tablesBrowser.title")}
            </Typography>
            <Typography
              variant="caption"
              sx={{
                color: theme.palette.text.secondary,
                fontSize: "0.69rem",
                lineHeight: 1.2,
              }}
            >
              {t("tablesBrowser.subtitle")}
            </Typography>
          </Box>
        </Box>
        <IconButton
          onClick={onClose}
          size="small"
          aria-label={t("app.close")}
          sx={{
            flexShrink: 0,
            color: theme.palette.text.secondary,
            "&:hover": {
              backgroundColor: alpha(theme.palette.text.primary, 0.05),
            },
          }}
        >
          <CloseIcon fontSize="small" />
        </IconButton>
      </Box>

      {/* Search */}
      <Box sx={{ px: 1.5, py: 1.25, flexShrink: 0 }}>
        <TextField
          fullWidth
          size="small"
          placeholder={t("tablesBrowser.filterPlaceholder")}
          value={filter}
          onChange={(e) => setFilter(e.target.value)}
          InputProps={{
            startAdornment: (
              <InputAdornment position="start">
                <SearchIcon
                  sx={{ fontSize: 16, color: theme.palette.text.secondary }}
                />
              </InputAdornment>
            ),
            endAdornment: filter ? (
              <InputAdornment position="end">
                <IconButton
                  size="small"
                  onClick={() => setFilter("")}
                  edge="end"
                  aria-label={t("app.clearFilter")}
                  sx={{ p: 0.25 }}
                >
                  <ClearIcon sx={{ fontSize: 14 }} />
                </IconButton>
              </InputAdornment>
            ) : null,
          }}
          sx={{
            "& .MuiOutlinedInput-root": {
              borderRadius: 2,
              fontSize: "0.83rem",
              backgroundColor: isDark
                ? alpha(theme.palette.common.white, 0.04)
                : alpha(theme.palette.common.black, 0.025),
            },
          }}
        />
      </Box>

      <Divider />

      {/* Content */}
      <Box sx={{ flex: 1, overflowY: "auto", pb: 2 }}>
        {loading && (
          <Box sx={{ px: 2, pt: 1.5 }}>
            {SKELETON_WIDTHS.map((w, i) => (
              <Box
                key={i}
                sx={{
                  display: "flex",
                  alignItems: "center",
                  gap: 1.25,
                  py: 0.85,
                }}
              >
                <Skeleton
                  variant="circular"
                  width={6}
                  height={6}
                  sx={{ flexShrink: 0 }}
                />
                <Skeleton
                  variant="text"
                  sx={{ fontSize: "0.83rem", flex: 1, maxWidth: `${w}%` }}
                />
                {i % 3 === 0 && (
                  <Skeleton variant="rounded" width={38} height={17} />
                )}
              </Box>
            ))}
          </Box>
        )}

        {error && !loading && (
          <Box sx={{ px: 2, py: 3, textAlign: "center" }}>
            <Typography
              variant="body2"
              sx={{ color: theme.palette.error.main, fontSize: "0.82rem" }}
            >
              {t("tablesBrowser.error")}: {error}
            </Typography>
          </Box>
        )}

        {!loading && !error && TABLE_GROUPS.map(renderGroup)}

        {!loading && !error && filteredUnknown.length > 0 && (
          <Accordion
            expanded={isGroupExpanded("other", unknownTables)}
            onChange={() =>
              !normalizedFilter && toggleGroup("other")
            }
            disableGutters
            square
            sx={accordionSx}
          >
            <AccordionSummary
              expandIcon={
                <ExpandMoreIcon
                  sx={{
                    fontSize: 15,
                    color: theme.palette.text.secondary,
                    opacity: normalizedFilter ? 0.35 : 1,
                  }}
                />
              }
              sx={{
                ...accordionSummarySx,
                cursor: normalizedFilter ? "default !important" : "pointer",
                "&:hover": !normalizedFilter
                  ? { backgroundColor: alpha(theme.palette.text.primary, 0.03) }
                  : {},
              }}
            >
              <Typography
                variant="caption"
                sx={{
                  flex: 1,
                  textTransform: "uppercase",
                  letterSpacing: "0.08em",
                  fontWeight: 700,
                  fontSize: "0.62rem",
                  color: theme.palette.text.secondary,
                }}
              >
                {t("tablesBrowser.group.other")}
              </Typography>
            </AccordionSummary>
            <AccordionDetails sx={{ p: 0, pb: 0.75 }}>
              {filteredUnknown.map((name) => renderTableRow(name, true))}
            </AccordionDetails>
          </Accordion>
        )}
      </Box>

      {/* Footer */}
      <Box
        sx={{
          borderTop: `1px solid ${theme.palette.divider}`,
          px: 2,
          py: 1,
          flexShrink: 0,
          backgroundColor: alpha(
            theme.palette.primary.main,
            isDark ? 0.04 : 0.02,
          ),
        }}
      >
        <Typography
          variant="caption"
          sx={{
            color: theme.palette.text.disabled,
            fontSize: "0.68rem",
            lineHeight: 1.5,
          }}
        >
          {t("tablesBrowser.footerHint")}
        </Typography>
      </Box>
    </Drawer>
  );
}

export default TablesBrowserDrawer;

export function TablesBrowserButton({ disabled }) {
  const { t } = useLanguage();
  const theme = useTheme();
  const isDark = theme.palette.mode === "dark";
  const [open, setOpen] = useState(false);

  return (
    <>
      <Tooltip title={t("tablesBrowser.tooltip")} arrow>
        <span>
          <IconButton
            onClick={() => setOpen(true)}
            size="small"
            disabled={disabled}
            aria-label={t("tablesBrowser.tooltip")}
            sx={{
              padding: 1,
              borderRadius: 2.5,
              backgroundColor: isDark
                ? alpha(theme.palette.primary.main, 0.1)
                : alpha(theme.palette.primary.main, 0.06),
              color: theme.palette.primary.main,
              transition: "all 0.2s ease-in-out",
              "&:hover": {
                backgroundColor: isDark
                  ? alpha(theme.palette.primary.main, 0.18)
                  : alpha(theme.palette.primary.main, 0.12),
                transform: "scale(1.05)",
              },
            }}
          >
            <TableChartOutlinedIcon sx={{ fontSize: 20 }} />
          </IconButton>
        </span>
      </Tooltip>
      <TablesBrowserDrawer open={open} onClose={() => setOpen(false)} />
    </>
  );
}
