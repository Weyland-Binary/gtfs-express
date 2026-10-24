import React, { useCallback } from "react";
import { Button, Tooltip, useTheme, alpha } from "@mui/material";
import AutoAwesomeIcon from "@mui/icons-material/AutoAwesome";
import { useLanguage } from "../../contexts/LanguageContext";
import { useDetailPanel } from "../../contexts/DetailPanelContext";
import { useEditMode } from "../../contexts/EditModeContext";
import { useFeatures } from "../../utils/featuresApi";
import { getRuleTitle } from "./ruleCatalog";
import { NL2SQL_PREFILL_KEY } from "../SqlConsole/constants";
import { CHAT_OPEN_EVENT, CLOSE_VALIDATION_REPORT_EVENT } from "../../utils/appEvents";

// A bounded prompt: enough context for the model, cheap and readable in the panel.
const MAX_SAMPLE_OCCURRENCES = 5;

/**
 * Hands a validation finding to the assistant as a question carrying the rule's context: the chat drawer, which keeps
 * the page in place, else the SQL console's one-shot NL2SQL popover. Shown beside a Quick Fix too: the AI handles
 * what the one-click repair cannot express.
 */
function AskAiFixButton({ ruleCode, occurrences }) {
  const theme = useTheme();
  const { t } = useLanguage();
  const { showSqlConsole } = useDetailPanel();
  const { editing } = useEditMode();
  const { features } = useFeatures();

  const handleClick = useCallback(
    (e) => {
      e.stopPropagation();
      const samples = occurrences
        .slice(0, MAX_SAMPLE_OCCURRENCES)
        .map((o) => {
          const parts = [];
          if (o.fileName) parts.push(o.fileName);
          if (o.entityType && o.entityId)
            parts.push(`${o.entityType} ${o.entityId}`);
          if (o.field) parts.push(`field ${o.field}`);
          if (o.message) parts.push(String(o.message));
          return `- ${parts.join(" · ")}`;
        })
        .join("\n");

      const prompt = t("validation.aiFix.prompt", {
        ruleCode,
        title: getRuleTitle(ruleCode),
        count: occurrences.length,
        samples,
      });

      if (features?.chat?.enabled) {
        // The chat drawer overlays the current view: no navigation, the question is sent at once.
        window.dispatchEvent(
          new CustomEvent(CHAT_OPEN_EVENT, { detail: { message: prompt } }),
        );
        return;
      }

      // Fallback: one-shot NL2SQL popover inside the SQL Console.
      try {
        sessionStorage.setItem(NL2SQL_PREFILL_KEY, prompt);
      } catch {
        /* sessionStorage unavailable: the console still opens, the question is typed by hand. */
      }
      // The validation page and the SQL console render one at a time: close the page first, else the console stays hidden.
      window.dispatchEvent(new CustomEvent(CLOSE_VALIDATION_REPORT_EVENT));
      showSqlConsole();
    },
    [occurrences, ruleCode, showSqlConsole, t, features?.chat?.enabled],
  );

  if (!features?.nl2sql?.enabled && !features?.chat?.enabled) return null;
  if (!occurrences || occurrences.length === 0) return null;
  // Edit mode only: the repair prompt runs on the premium model and only makes sense when the fix can be applied.
  if (!editing) return null;

  return (
    <Tooltip title={t("validation.aiFix.tooltip")} arrow>
      <Button
        size="small"
        variant="outlined"
        color="secondary"
        startIcon={<AutoAwesomeIcon sx={{ fontSize: 14 }} />}
        onClick={handleClick}
        data-testid="ask-ai-fix"
        sx={{
          flexShrink: 0,
          height: 24,
          px: 1,
          fontSize: "0.7rem",
          fontWeight: 700,
          textTransform: "none",
          borderColor: alpha(theme.palette.secondary.main, 0.4),
          "&:hover": {
            borderColor: theme.palette.secondary.main,
            bgcolor: alpha(theme.palette.secondary.main, 0.06),
          },
        }}
      >
        {t("validation.aiFix.button")}
      </Button>
    </Tooltip>
  );
}

export default AskAiFixButton;
