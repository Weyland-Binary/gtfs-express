import React from "react";
import { Box, Typography, Tooltip, Alert, Chip, Switch } from "@mui/material";
import { alpha, useTheme } from "@mui/material/styles";
import StorageIcon from "@mui/icons-material/Storage";
import EditIcon from "@mui/icons-material/Edit";
import InfoOutlinedIcon from "@mui/icons-material/InfoOutlined";
import SearchIcon from "@mui/icons-material/Search";
import FiberManualRecordIcon from "@mui/icons-material/FiberManualRecord";
import CheckCircleOutlineIcon from "@mui/icons-material/CheckCircleOutline";
import { MONO_FONT } from "./constants";

/** The results column before any result: the refusal, or the quick actions on an empty console. */
export function ResultsIdle({ error, result, running, counts, browseFile, t }) {
  const theme = useTheme();
  return (
    <>
      {error && (
        <Box sx={{ px: 1.5, pt: 1 }}>
          <Alert severity="error" sx={{ mb: 0 }}>
            {error}
          </Alert>
        </Box>
      )}
      {!result && !error && !running && (
        <Box
          sx={{
            m: 1.5,
            border: `1px dashed ${alpha(theme.palette.text.primary, 0.12)}`,
            borderRadius: 1.5,
            px: 2,
            py: 3,
            textAlign: "center",
            color: theme.palette.text.secondary,
            animation: "sqlSlideIn 250ms ease-out",
          }}
        >
          <StorageIcon
            sx={{
              fontSize: 36,
              opacity: 0.18,
              color: theme.palette.primary.main,
              mb: 1,
            }}
          />
          <Typography
            variant="body2"
            sx={{
              fontWeight: 700,
              fontSize: 13,
              mb: 0.25,
              color: theme.palette.text.primary,
            }}
          >
            {t("sqlConsole.empty.runHint")}
          </Typography>
          <Typography
            variant="caption"
            sx={{
              display: "block",
              fontSize: 11,
              color: theme.palette.text.disabled,
              mb: 1.5,
            }}
          >
            {t("sqlConsole.empty.illustration")}
          </Typography>
          <Box
            sx={{
              display: "inline-flex",
              gap: 0.75,
              flexWrap: "wrap",
              justifyContent: "center",
            }}
          >
            {[
              {
                table: "stops",
                labelKey: "sqlConsole.empty.quickActionStops",
              },
              {
                table: "routes",
                labelKey: "sqlConsole.empty.quickActionRoutes",
              },
              {
                table: "trips",
                labelKey: "sqlConsole.empty.quickActionTrips",
              },
            ].map((qa) => {
              const present = (counts?.[qa.table] ?? 0) > 0;
              return (
                <Box
                  key={qa.table}
                  component="button"
                  type="button"
                  disabled={!present}
                  onClick={() => browseFile(qa.table)}
                  sx={{
                    display: "inline-flex",
                    alignItems: "center",
                    gap: 0.5,
                    height: 26,
                    px: 1.25,
                    borderRadius: 999,
                    border: `1px solid ${alpha(
                      theme.palette.primary.main,
                      0.3,
                    )}`,
                    background: alpha(theme.palette.primary.main, 0.06),
                    color: theme.palette.primary.main,
                    fontFamily: MONO_FONT,
                    fontSize: 11.5,
                    fontWeight: 600,
                    cursor: present ? "pointer" : "not-allowed",
                    opacity: present ? 1 : 0.4,
                    transition:
                      "transform 150ms ease, background-color 150ms ease",
                    "&:hover:not(:disabled)": {
                      background: alpha(
                        theme.palette.primary.main,
                        0.12,
                      ),
                      transform: "translateY(-1px)",
                    },
                  }}
                >
                  {t(qa.labelKey)}
                </Box>
              );
            })}
          </Box>
        </Box>
      )}
    </>
  );
}

/** The strip at the top of a result; the live counters are the bottom bar's. */
export function ResultsHeader({
  result,
  editable,
  cellEditableEntity,
  editing,
  autoRefresh,
  setAutoRefresh,
  t,
}) {
  const theme = useTheme();
  const isDark = theme.palette.mode === "dark";
  return (
    <>
      <Box
        sx={{
          display: "flex",
          alignItems: "center",
          gap: 0.75,
          px: 1.5,
          height: 32,
          background: alpha(
            theme.palette.text.primary,
            isDark ? 0.025 : 0.015,
          ),
          borderBottom: `1px solid ${theme.palette.divider}`,
          flexShrink: 0,
        }}
      >
        {cellEditableEntity ? (
          <Tooltip title={t("sqlConsole.editableHint")} arrow>
            <Chip
              size="small"
              icon={<EditIcon sx={{ fontSize: 12 }} />}
              label={editable.table}
              sx={{
                height: 20,
                fontSize: 10.5,
                fontWeight: 700,
                fontFamily: MONO_FONT,
                bgcolor: alpha(theme.palette.success.main, 0.12),
                color: theme.palette.success.main,
                "& .MuiChip-icon": { ml: 0.5, color: "inherit" },
                "& .MuiChip-label": { px: 0.75 },
              }}
            />
          </Tooltip>
        ) : (
          <Tooltip title={t("sqlConsole.readOnlyHint")} arrow>
            <Chip
              size="small"
              label={t("sqlConsole.readOnlyTag")}
              sx={{
                height: 20,
                fontSize: 10.5,
                fontWeight: 700,
                bgcolor: alpha(theme.palette.text.primary, 0.06),
                "& .MuiChip-label": { px: 0.75 },
              }}
            />
          </Tooltip>
        )}
        <Box flex={1} />
        <Tooltip title={t("sqlConsole.autoRefresh.tooltip")} arrow>
          <Box
            sx={{
              display: "inline-flex",
              alignItems: "center",
              gap: 0.25,
              border: `1px solid ${theme.palette.divider}`,
              borderRadius: 999,
              pl: 0.75,
              pr: 0.25,
              height: 22,
              background: theme.palette.background.paper,
            }}
            onClick={() => setAutoRefresh((v) => !v)}
            role="switch"
            aria-checked={autoRefresh}
          >
            <FiberManualRecordIcon
              sx={{
                fontSize: 8,
                color: autoRefresh
                  ? theme.palette.success.main
                  : alpha(theme.palette.text.secondary, 0.5),
              }}
            />
            <Typography
              variant="caption"
              sx={{
                fontSize: 10,
                fontWeight: 700,
                letterSpacing: "0.04em",
                cursor: "pointer",
                userSelect: "none",
              }}
            >
              {autoRefresh
                ? t("sqlConsole.autoRefresh.on")
                : t("sqlConsole.autoRefresh.off")}
            </Typography>
            <Switch
              size="small"
              checked={autoRefresh}
              onChange={(e) => setAutoRefresh(e.target.checked)}
              sx={{ ml: 0.25, transform: "scale(0.65)" }}
              inputProps={{
                "aria-label": autoRefresh
                  ? t("sqlConsole.autoRefresh.on")
                  : t("sqlConsole.autoRefresh.off"),
              }}
            />
          </Box>
        </Tooltip>
      </Box>

      {result && !cellEditableEntity && editing && (
        <Alert
          severity="info"
          icon={<InfoOutlinedIcon fontSize="small" />}
          sx={{ mx: 1.5, mt: 1, mb: 0, py: 0.25, fontSize: 11 }}
        >
          {t("sqlConsole.readOnlyHint")}
        </Alert>
      )}
    </>
  );
}

/** A result with no row: a mutation that matched nothing (its undo entry still produced) or an empty SELECT. */
export function EmptyResult({ allRows, result, t }) {
  const theme = useTheme();
  return (
    <>
      {allRows.length === 0 && (
        <Box
          sx={{
            m: 1.5,
            border: `1px solid ${theme.palette.divider}`,
            borderRadius: 1.5,
            px: 2,
            py: 3,
            textAlign: "center",
            color: theme.palette.text.secondary,
            animation: "sqlSlideIn 200ms ease-out",
          }}
        >
          {result?.mutated ? (
            <>
              <CheckCircleOutlineIcon
                sx={{
                  fontSize: 32,
                  opacity: 0.55,
                  color: theme.palette.success.main,
                  mb: 0.5,
                }}
              />
              <Typography
                variant="body2"
                sx={{
                  fontWeight: 700,
                  mb: 0.25,
                  color: theme.palette.text.primary,
                }}
              >
                {t("sqlConsole.mutation.zeroAffectedTitle")}
              </Typography>
              <Typography
                variant="caption"
                sx={{ fontSize: 11, opacity: 0.7 }}
              >
                {t("sqlConsole.mutation.zeroAffectedHint")}
              </Typography>
            </>
          ) : (
            <>
              <SearchIcon
                sx={{
                  fontSize: 32,
                  opacity: 0.22,
                  color: theme.palette.text.secondary,
                  mb: 0.5,
                }}
              />
              <Typography
                variant="body2"
                sx={{
                  fontWeight: 700,
                  mb: 0.25,
                  color: theme.palette.text.primary,
                }}
              >
                {t("sqlConsole.emptyResults")}
              </Typography>
              <Typography
                variant="caption"
                sx={{ fontSize: 11, opacity: 0.7 }}
              >
                {t("sqlConsole.empty.noResults")}
              </Typography>
            </>
          )}
        </Box>
      )}
    </>
  );
}
