import React, { useCallback } from "react";
import { Button, Tooltip, useTheme, alpha } from "@mui/material";
import AutoAwesomeIcon from "@mui/icons-material/AutoAwesome";
import { useLanguage } from "../../contexts/LanguageContext";
import { useDetailPanel } from "../../contexts/DetailPanelContext";
import { useEditMode } from "../../contexts/EditModeContext";
import { useFeatures } from "../../utils/featuresApi";
import { getRuleTitle } from "./ruleCatalog";
import { NL2SQL_PREFILL_KEY } from "../SqlConsole/constants";
import { CHAT_OPEN_EVENT } from "../chat/ChatAssistantFAB";

// Keep the prompt bounded: enough context for the model to understand the
// problem shape, small enough to stay cheap and readable in the panel.
const MAX_SAMPLE_OCCURRENCES = 5;

/**
 * "Ask AI to fix" — the bridge between a validation finding and the AI
 * assistant. Builds a natural-language question carrying the rule context
 * (code, title, count, sample occurrences) and hands it off to:
 *
 *   1. the chat companion (preferred) — dispatches CHAT_OPEN_EVENT; the
 *      drawer overlays the validation page, so the user keeps their place
 *      while the assistant streams its answer with full session context;
 *   2. the SQL Console NL2SQL popover (fallback when only the one-shot
 *      endpoint is enabled) — sessionStorage hand-off, console auto-opens.
 *
 * Shown on every rule row while editing — including rules that also have a
 * deterministic Quick Fix (the Quick Fix button stays first in the row; the
 * AI handles the cases the one-click repair can't express). Server feature
 * flag gated, like every other AI surface.
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
        // Preferred path: the chat companion overlays the current view —
        // no navigation, the question is sent automatically.
        window.dispatchEvent(
          new CustomEvent(CHAT_OPEN_EVENT, { detail: { message: prompt } }),
        );
        return;
      }

      // Fallback: one-shot NL2SQL popover inside the SQL Console.
      try {
        sessionStorage.setItem(NL2SQL_PREFILL_KEY, prompt);
      } catch {
        /* sessionStorage unavailable — the console still opens, the user
           can type the question manually. */
      }
      // The validation page is mutex-rendered with the SQL Console: dismiss
      // it first, then surface the console (same dance as
      // FixInSqlConsoleButton — see the comment there).
      window.dispatchEvent(new CustomEvent("gtfs:close-validation-report"));
      showSqlConsole();
    },
    [occurrences, ruleCode, showSqlConsole, t, features?.chat?.enabled],
  );

  if (!features?.nl2sql?.enabled && !features?.chat?.enabled) return null;
  if (!occurrences || occurrences.length === 0) return null;
  // AI repair is a beta/paid capability: the auto-built repair prompt runs
  // on the premium chat model and only makes sense when the fix can be
  // applied — both require edit mode. Read-only users go through the
  // "Fix this feed" CTA (beta gate) first; the free anonymous chat stays
  // available via the FAB for questions.
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
