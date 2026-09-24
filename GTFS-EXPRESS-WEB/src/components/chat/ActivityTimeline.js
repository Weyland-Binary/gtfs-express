/**
 * ActivityTimeline — what the assistant did during a turn: the queries it
 * ran (with their results), the views it opened, the tool currently
 * running. Expanded while the turn streams so the user follows along;
 * collapsed to a one-line summary once complete (click to reopen).
 */

import React, { useEffect, useState } from "react";
import { Box, Chip, Collapse, IconButton, Tooltip, alpha, useTheme, CircularProgress } from "@mui/material";
import ExpandMoreIcon from "@mui/icons-material/ExpandMore";
import CheckCircleOutlineIcon from "@mui/icons-material/CheckCircleOutline";
import ErrorOutlineIcon from "@mui/icons-material/ErrorOutline";
import OpenInNewIcon from "@mui/icons-material/OpenInNew";
import TerminalOutlinedIcon from "@mui/icons-material/TerminalOutlined";
import NearMeOutlinedIcon from "@mui/icons-material/NearMeOutlined";
import ReplayIcon from "@mui/icons-material/Replay";
import { useLanguage } from "../../contexts/LanguageContext";
import SqlAccordion from "./SqlAccordion";
import ResultTablePreview from "./ResultTablePreview";

const TOOL_LABEL_KEYS = {
  run_sql: "chat.activity.tool.run_sql",
  propose_fix: "chat.activity.tool.propose_fix",
  get_validation_findings: "chat.activity.tool.get_validation_findings",
  get_rule_info: "chat.activity.tool.get_rule_info",
  get_feed_overview: "chat.activity.tool.get_feed_overview",
  navigate: "chat.activity.tool.navigate",
  show_chart: "chat.activity.tool.show_chart",
};

function SqlStep({ step, onOpenInConsole }) {
  const { t } = useLanguage();
  const theme = useTheme();
  const [open, setOpen] = useState(false);
  const running = step.status === "running";
  const failed = Boolean(step.error);
  return (
    <Box
      data-testid="chat-step"
      sx={{
        borderRadius: 1.25,
        border: `1px solid ${alpha(failed ? theme.palette.error.main : theme.palette.text.primary, failed ? 0.35 : 0.1)}`,
        background: alpha(theme.palette.background.paper, 0.6),
        overflow: "hidden",
      }}
    >
      <Box
        component="button"
        type="button"
        onClick={() => setOpen((o) => !o)}
        sx={{
          all: "unset",
          cursor: "pointer",
          width: "100%",
          boxSizing: "border-box",
          display: "flex",
          alignItems: "center",
          gap: 0.75,
          px: 1,
          py: 0.6,
          "&:hover": { background: alpha(theme.palette.primary.main, 0.05) },
        }}
      >
        {running ? (
          <CircularProgress size={13} thickness={5} />
        ) : failed ? (
          <ErrorOutlineIcon sx={{ fontSize: 15, color: "error.main" }} />
        ) : (
          <CheckCircleOutlineIcon sx={{ fontSize: 15, color: "success.main" }} />
        )}
        <Box sx={{ flex: 1, minWidth: 0, fontSize: "0.76rem", fontWeight: 600, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
          {step.purpose || t("chat.activity.query")}
        </Box>
        {!running && !failed && typeof step.rowCount === "number" && (
          <Chip
            size="small"
            label={t("chat.result.rowCount", { count: step.rowCount })}
            sx={{ height: 18, fontSize: "0.62rem", fontWeight: 700 }}
          />
        )}
        {failed && (
          <Chip size="small" color="error" variant="outlined" label={t("chat.activity.failed")} sx={{ height: 18, fontSize: "0.62rem" }} />
        )}
        <ExpandMoreIcon
          sx={{ fontSize: 16, color: "text.secondary", transform: open ? "rotate(180deg)" : "none", transition: "transform 160ms" }}
        />
      </Box>
      <Collapse in={open} unmountOnExit>
        <Box sx={{ px: 1, pb: 1, display: "flex", flexDirection: "column", gap: 0.5 }}>
          <SqlAccordion sql={step.sql} defaultExpanded dense />
          {failed && (
            <Box sx={{ fontSize: "0.72rem", color: "error.main", fontFamily: "monospace", whiteSpace: "pre-wrap" }}>
              {step.error}
            </Box>
          )}
          {!failed && !running && (
            <ResultTablePreview
              result={{
                rowCount: step.rowCount,
                columns: step.columns || [],
                rowsPreview: step.rowsPreview || [],
                truncated: step.truncated,
              }}
              durationMs={step.durationMs}
              onOpenInConsole={onOpenInConsole ? () => onOpenInConsole(step.sql) : null}
            />
          )}
        </Box>
      </Collapse>
    </Box>
  );
}

export default function ActivityTimeline({
  steps = [],
  uiActions = [],
  pendingTool = null,
  streaming = false,
  onOpenInConsole = null,
  onReplayAction = null,
}) {
  const { t } = useLanguage();
  const theme = useTheme();
  // Open while streaming; collapse once the turn is over (unless the user
  // already toggled it by hand).
  const [expanded, setExpanded] = useState(true);
  const [touched, setTouched] = useState(false);
  useEffect(() => {
    if (!touched) setExpanded(streaming);
  }, [streaming, touched]);

  const sqlSteps = steps.filter((s) => s.kind === "sql");
  const count = sqlSteps.length;
  const failed = sqlSteps.filter((s) => s.error).length;
  if (count === 0 && uiActions.length === 0 && !pendingTool) return null;

  const summaryParts = [];
  if (count > 0) summaryParts.push(t("chat.activity.queries", { count }));
  if (uiActions.length > 0) summaryParts.push(t("chat.activity.actions", { count: uiActions.length }));
  if (failed > 0) summaryParts.push(t("chat.activity.failedCount", { count: failed }));

  return (
    <Box data-testid="chat-activity" sx={{ mb: 0.75 }}>
      <Box
        component="button"
        type="button"
        onClick={() => {
          setTouched(true);
          setExpanded((e) => !e);
        }}
        sx={{
          all: "unset",
          cursor: "pointer",
          display: "flex",
          alignItems: "center",
          gap: 0.6,
          fontSize: "0.7rem",
          fontWeight: 700,
          color: "text.secondary",
          letterSpacing: 0.3,
          textTransform: "uppercase",
          py: 0.25,
          "&:hover": { color: "text.primary" },
        }}
      >
        <TerminalOutlinedIcon sx={{ fontSize: 14 }} />
        {pendingTool && streaming
          ? t(TOOL_LABEL_KEYS[pendingTool] || "chat.activity.working")
          : summaryParts.join(" · ") || t("chat.activity.working")}
        {pendingTool && streaming && <CircularProgress size={11} thickness={5} sx={{ ml: 0.5 }} />}
        <ExpandMoreIcon sx={{ fontSize: 15, transform: expanded ? "rotate(180deg)" : "none", transition: "transform 160ms" }} />
      </Box>
      <Collapse in={expanded}>
        <Box sx={{ display: "flex", flexDirection: "column", gap: 0.6, mt: 0.5 }}>
          {sqlSteps.map((s) => (
            <SqlStep key={s.stepId} step={s} onOpenInConsole={onOpenInConsole} />
          ))}
          {uiActions.length > 0 && (
            <Box sx={{ display: "flex", gap: 0.5, flexWrap: "wrap" }}>
              {uiActions.map((a) => (
                <Chip
                  key={a.actionId}
                  size="small"
                  icon={<NearMeOutlinedIcon sx={{ fontSize: 13 }} />}
                  label={t("chat.activity.opened", { label: a.label })}
                  onClick={onReplayAction ? () => onReplayAction(a) : undefined}
                  deleteIcon={
                    <Tooltip title={t("chat.activity.replay")}>
                      <ReplayIcon sx={{ fontSize: 13 }} />
                    </Tooltip>
                  }
                  onDelete={onReplayAction ? () => onReplayAction(a) : undefined}
                  data-testid="chat-ui-action"
                  sx={{
                    height: 22,
                    fontSize: "0.66rem",
                    fontWeight: 600,
                    color: theme.palette.primary.dark,
                    bgcolor: alpha(theme.palette.primary.main, 0.08),
                  }}
                />
              ))}
            </Box>
          )}
          {onOpenInConsole && count > 0 && !streaming && (
            <Box sx={{ display: "flex", justifyContent: "flex-end" }}>
              <Tooltip title={t("chat.action.openInConsole")}>
                <IconButton size="small" onClick={() => onOpenInConsole(sqlSteps[sqlSteps.length - 1].sql)} sx={{ width: 22, height: 22 }}>
                  <OpenInNewIcon sx={{ fontSize: 13 }} />
                </IconButton>
              </Tooltip>
            </Box>
          )}
        </Box>
      </Collapse>
    </Box>
  );
}
