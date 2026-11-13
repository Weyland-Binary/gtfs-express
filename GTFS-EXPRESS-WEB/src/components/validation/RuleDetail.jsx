import React, { useState } from "react";
import { Box, Button, Link, Typography, alpha, useTheme } from "@mui/material";
import NorthEastRoundedIcon from "@mui/icons-material/NorthEastRounded";
import BuildOutlinedIcon from "@mui/icons-material/BuildOutlined";
import AutoFixHighIcon from "@mui/icons-material/AutoFixHigh";
import { useLanguage } from "../../contexts/LanguageContext";
import { countWords } from "../../utils/countWords";
import { SAFE_REPAIR_RULES } from "../../utils/safeRepairs";
import { useExpertMode } from "../../utils/expertMode";
import { getRuleDocUrl } from "./ruleCatalog";
import { isFixableFinding } from "./useFixDialog";
import RuleOccurrenceTable from "./RuleOccurrenceTable";
import QuickFixDialog from "./QuickFixDialog";
import FixInSqlConsoleButton from "./FixInSqlConsoleButton";
import AskAiFixButton from "./AskAiFixButton";
import SeverityTile from "./SeverityTile";
import AutoAwesomeIcon from "@mui/icons-material/AutoAwesome";
import VerifiedOutlinedIcon from "@mui/icons-material/VerifiedOutlined";

const MONOSPACE = '"JetBrains Mono", "Fira Code", monospace';
const SAFE = new Set(SAFE_REPAIR_RULES);
const SEVERITY_ONE = { error: "validation.severity.one.error", warning: "validation.severity.one.warning", info: "validation.severity.one.info" };

/** What the report can do for a rule's findings, the surest first. */
const offerOf = (group, quickFixCount) => {
  if (group.occurrences.some((o) => o.asideId)) return "aside";
  if (SAFE.has(group.ruleCode)) return "safe";
  if (quickFixCount > 0) return "quick";
  if (group.occurrences.some((o) => isFixableFinding(o))) return "editor";
  return "none";
};

/** One rule beside the list: what it checks, what the report can do about it, and its occurrences. */
export default function RuleDetail({ group, titleOf, descriptionOf, quickFixCount = 0, chatEnabled = false, duplicatesPending = false }) {
  const theme = useTheme();
  const { t } = useLanguage();
  const [expert] = useExpertMode();
  const [quickFixOpen, setQuickFixOpen] = useState(false);
  const dark = theme.palette.mode === "dark";
  const { ruleCode, severity, count, files, occurrences } = group;
  const tone = (theme.palette.severities[severity] || theme.palette.severities.error).main;
  const known = ruleCode !== "__ungrouped__";
  // The duplicates kept aside are settled from the report's head, where they are said with their two copies.
  const keep = ruleCode === "duplicate_key" && duplicatesPending;
  const offer = keep ? "aside" : offerOf(group, quickFixCount);
  const note = keep
    ? t("validation.note.duplicates")
    : offer === "none"
      ? t(chatEnabled ? "validation.note.ai" : "validation.note.none")
      : t(`validation.note.${offer}`);
  const description = known ? descriptionOf(ruleCode) : "";
  const noteTone = offer === "safe" ? theme.palette.success.main : offer === "none" ? (chatEnabled ? theme.palette.ai.main : theme.palette.text.secondary) : theme.palette.primary.main;
  const NoteIcon = offer === "safe" ? VerifiedOutlinedIcon : offer === "none" && chatEnabled ? AutoAwesomeIcon : BuildOutlinedIcon;
  const smallAct = { height: 32, fontSize: "0.8rem", borderRadius: "8px", px: 1.25, flexShrink: 0 };

  return (
    <Box data-testid="validation-rule-detail" data-rule={ruleCode} sx={{ flex: 1, minHeight: 0, display: "flex", flexDirection: "column" }}>
      <Box sx={{ flexShrink: 0, display: "flex", alignItems: "flex-start", gap: 2, px: 3.5, pt: 2.25, pb: 2, bgcolor: "background.paper", borderBottom: `1px solid ${theme.palette.divider}` }}>
        <Box sx={{ pt: 0.25 }}>
          <SeverityTile severity={severity} size={46} radius="12px" />
        </Box>
        <Box sx={{ flex: 1, minWidth: 0 }}>
          <Box sx={{ display: "flex", alignItems: "center", gap: 1, mb: 0.75, minWidth: 0 }}>
            <Box component="span" sx={{ flexShrink: 0, fontSize: "0.72rem", fontWeight: 650, px: 1.1, py: 0.25, borderRadius: 99, color: tone, bgcolor: alpha(tone, dark ? 0.18 : 0.1) }}>
              {t(SEVERITY_ONE[severity])}
            </Box>
            {known && (
              <Typography noWrap sx={{ fontFamily: MONOSPACE, fontSize: "0.75rem", color: "text.secondary" }}>
                {ruleCode}
              </Typography>
            )}
          </Box>
          <Typography component="h3" data-testid="validation-rule-title" sx={{ fontSize: "1.25rem", fontWeight: 650, letterSpacing: "-0.01em", lineHeight: 1.3 }}>
            {titleOf(ruleCode)}
          </Typography>
          <Typography sx={{ mt: 0.5, fontSize: "0.8125rem", color: "text.secondary", fontVariantNumeric: "tabular-nums" }}>
            {countWords(t, "validation.detail.occurrences", count, { count: count.toLocaleString() })}
            {files.length > 0 && (
              <>
                {" · "}
                <Box component="span" sx={{ fontFamily: MONOSPACE, fontSize: "0.75rem" }}>
                  {files.join(", ")}
                </Box>
              </>
            )}
          </Typography>
        </Box>
        <Box sx={{ flexShrink: 0, display: "flex", alignItems: "center", gap: 1.25, pt: 0.5, flexWrap: "wrap", justifyContent: "flex-end" }}>
          {known && (
            <Link href={getRuleDocUrl(ruleCode)} target="_blank" rel="noopener noreferrer" underline="hover" data-testid="validation-rule-doc" sx={{ display: "inline-flex", alignItems: "center", gap: 0.4, fontSize: "0.8125rem", fontWeight: 500 }}>
              {t("validation.detail.doc")}
              <NorthEastRoundedIcon sx={{ fontSize: 14 }} />
            </Link>
          )}
          {known && <AskAiFixButton ruleCode={ruleCode} occurrences={occurrences} buttonSx={smallAct} />}
          {known && expert && <FixInSqlConsoleButton ruleCode={ruleCode} occurrences={occurrences} buttonSx={smallAct} />}
          {known && quickFixCount > 0 && (
            <Button
              variant="outlined"
              color="success"
              onClick={() => setQuickFixOpen(true)}
              data-testid="rule-quick-fix"
              startIcon={<AutoFixHighIcon sx={{ fontSize: 16 }} />}
              sx={{ ...smallAct, height: 36, fontSize: "0.84rem", fontWeight: 600, textTransform: "none" }}
            >
              {t("validation.detail.quickFix", { count: quickFixCount.toLocaleString() })}
            </Button>
          )}
        </Box>
      </Box>

      <Box sx={{ flexShrink: 0, px: 3.5, py: 1.75, borderBottom: `1px solid ${theme.palette.divider}` }}>
        {description && (
          <Typography data-testid="rule-description" sx={{ maxWidth: 820, fontSize: "0.84rem", lineHeight: 1.55, color: "text.primary" }}>
            {description}
          </Typography>
        )}
        <Typography data-testid="rule-note" sx={{ mt: description ? 1.5 : 0, maxWidth: 820, display: "flex", alignItems: "flex-start", gap: 1.25, px: 1.5, py: 1.1, borderRadius: "10px", border: `1px solid ${alpha(noteTone, 0.25)}`, bgcolor: alpha(noteTone, dark ? 0.12 : 0.06), fontSize: "0.8125rem", lineHeight: 1.5, color: "text.primary" }}>
          <NoteIcon aria-hidden sx={{ fontSize: 17, mt: "1px", flexShrink: 0, color: noteTone }} />
          <span>
            {note}
            {severity !== "error" && ` ${t("validation.note.notBlocking")}`}
          </span>
        </Typography>
      </Box>

      <RuleOccurrenceTable occurrences={occurrences} ruleCode={ruleCode} />

      {quickFixOpen && <QuickFixDialog open={quickFixOpen} onClose={() => setQuickFixOpen(false)} ruleCode={ruleCode} />}
    </Box>
  );
}
