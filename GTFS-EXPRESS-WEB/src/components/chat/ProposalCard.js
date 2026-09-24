/**
 * ProposalCard — a fix the assistant proposed: title, rationale, the SQL
 * and the guided repair flow (already previewed server-side → the user is
 * one click from applying, with undo and re-validation).
 */

import React, { useState } from "react";
import { Box, Chip, alpha, useTheme } from "@mui/material";
import AutoFixHighIcon from "@mui/icons-material/AutoFixHigh";
import { useLanguage } from "../../contexts/LanguageContext";
import SqlAccordion from "./SqlAccordion";
import RepairFlow from "./RepairFlow";

export default function ProposalCard({ proposal, index, currentErrorCount, onOutcome }) {
  const { t } = useLanguage();
  const theme = useTheme();
  const [applied, setApplied] = useState(false);
  const affected = proposal.preview?.totalAffected;

  return (
    <Box
      data-testid="chat-proposal"
      sx={{
        mt: 1,
        borderRadius: 1.5,
        overflow: "hidden",
        border: `1px solid ${alpha(applied ? theme.palette.success.main : theme.palette.warning.main, 0.5)}`,
        background: alpha(applied ? theme.palette.success.main : theme.palette.warning.main, 0.05),
      }}
    >
      <Box sx={{ px: 1.5, py: 1, display: "flex", alignItems: "flex-start", gap: 1 }}>
        <AutoFixHighIcon sx={{ fontSize: 18, color: applied ? "success.main" : theme.palette.warning.dark, mt: 0.1 }} />
        <Box sx={{ flex: 1, minWidth: 0 }}>
          <Box sx={{ display: "flex", alignItems: "center", gap: 0.75, flexWrap: "wrap" }}>
            <Box sx={{ fontSize: "0.8rem", fontWeight: 700, lineHeight: 1.35 }}>
              {index != null ? `${index + 1}. ` : ""}
              {proposal.title}
            </Box>
            {typeof affected === "number" && (
              <Chip
                size="small"
                label={t("chat.proposal.affected", { count: affected })}
                color={affected === 0 ? "default" : "warning"}
                variant="outlined"
                sx={{ height: 18, fontSize: "0.62rem", fontWeight: 700 }}
              />
            )}
          </Box>
          {proposal.rationale && (
            <Box sx={{ fontSize: "0.74rem", color: "text.secondary", mt: 0.35, lineHeight: 1.5 }}>
              {proposal.rationale}
            </Box>
          )}
        </Box>
      </Box>
      <Box sx={{ px: 1.25, pb: 1, display: "flex", flexDirection: "column", gap: 0.75 }}>
        <SqlAccordion sql={proposal.sql} defaultExpanded={false} dense />
        <RepairFlow
          draftSql={proposal.sql}
          currentErrorCount={currentErrorCount}
          initialPreview={proposal.preview || null}
          onApplied={setApplied}
          onOutcome={onOutcome}
        />
      </Box>
    </Box>
  );
}
