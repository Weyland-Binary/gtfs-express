import React, { useMemo, useState } from "react";
import {
  Box,
  Chip,
  Collapse,
  Paper,
  Typography,
  useTheme,
  alpha,
} from "@mui/material";
import TaskAltIcon from "@mui/icons-material/TaskAlt";
import KeyboardArrowDownIcon from "@mui/icons-material/KeyboardArrowDown";
import { useLanguage } from "../../contexts/LanguageContext";
import RuleOccurrenceTable from "./RuleOccurrenceTable";

const MONOSPACE = '"JetBrains Mono", "Fira Code", monospace';

/**
 * Announces the findings the tolerant import already fixed: exact
 * duplicate-primary-key rows are dropped at load time (first occurrence
 * kept), so the matching duplicate_key findings from the upload report no
 * longer exist in the session. They are NOT outstanding work — no repair,
 * no re-validation needed — but silently hiding them would misrepresent
 * the engine's report, so they live here: a success-toned summary with the
 * full engine detail one click away.
 */
function AutoFixedBanner({ findings }) {
  const theme = useTheme();
  const isDark = theme.palette.mode === "dark";
  const { t } = useLanguage();
  const [open, setOpen] = useState(false);

  const successColor = theme.palette.success.main;

  // Per-file tallies for the summary chips (aggregate tails count for
  // their real share).
  const byFile = useMemo(() => {
    const map = new Map();
    let total = 0;
    for (const f of findings) {
      const weight = f.aggregate ? f.aggregateCount || 1 : 1;
      total += weight;
      map.set(f.fileName, (map.get(f.fileName) || 0) + weight);
    }
    return { entries: [...map.entries()], total };
  }, [findings]);

  return (
    <Paper
      elevation={0}
      data-testid="auto-fixed-banner"
      sx={{
        border: `1px solid ${alpha(successColor, 0.35)}`,
        borderRadius: 3,
        overflow: "hidden",
        bgcolor: alpha(successColor, isDark ? 0.08 : 0.045),
      }}
    >
      <Box
        role="button"
        tabIndex={0}
        aria-expanded={open}
        onClick={() => setOpen((v) => !v)}
        onKeyDown={(e) => {
          if (e.key === "Enter" || e.key === " ") {
            e.preventDefault();
            setOpen((v) => !v);
          }
        }}
        sx={{
          px: 2,
          py: 1.25,
          display: "flex",
          alignItems: "center",
          gap: 1.25,
          cursor: "pointer",
          userSelect: "none",
          outline: "none",
          "&:focus-visible": {
            outline: `2px solid ${successColor}`,
            outlineOffset: -2,
          },
        }}
      >
        <TaskAltIcon sx={{ fontSize: 20, color: successColor, flexShrink: 0 }} />
        <Box sx={{ flex: 1, minWidth: 0 }}>
          <Typography variant="body2" sx={{ fontWeight: 700 }}>
            {t("validation.autoFixed.title", { count: byFile.total })}
          </Typography>
          <Typography variant="caption" color="text.secondary">
            {t("validation.autoFixed.body")}
          </Typography>
        </Box>
        <Box sx={{ display: "flex", gap: 0.5, flexShrink: 0, flexWrap: "wrap" }}>
          {byFile.entries.map(([fileName, count]) => (
            <Chip
              key={fileName}
              size="small"
              label={`${fileName} · ${count}`}
              sx={{
                height: 22,
                fontSize: "0.68rem",
                fontWeight: 600,
                fontFamily: MONOSPACE,
                bgcolor: alpha(successColor, isDark ? 0.18 : 0.1),
                color: isDark
                  ? theme.palette.success.light
                  : theme.palette.success.dark,
              }}
            />
          ))}
        </Box>
        <KeyboardArrowDownIcon
          sx={{
            fontSize: 19,
            color: "text.disabled",
            flexShrink: 0,
            transition: "transform 0.2s cubic-bezier(0.4,0,0.2,1)",
            transform: open ? "rotate(180deg)" : "rotate(0deg)",
          }}
        />
      </Box>

      {/* Full engine detail, faithful columns — collapsed by default.
          unmountOnExit: don't pay for hundreds of resolved rows unless
          the user actually asks to see them. */}
      <Collapse in={open} timeout={200} unmountOnExit>
        <Box
          sx={{
            borderTop: `1px solid ${alpha(successColor, 0.25)}`,
            bgcolor: "background.paper",
          }}
        >
          <RuleOccurrenceTable
            occurrences={findings}
            ruleCode={findings[0]?.ruleCode || "duplicate_key"}
          />
        </Box>
      </Collapse>
    </Paper>
  );
}

export default AutoFixedBanner;
