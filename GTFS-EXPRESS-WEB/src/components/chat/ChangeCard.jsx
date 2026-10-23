/**
 * A change the person asked the assistant for, written as a brief. The assistant never changes the network: the card
 * prepares the change in a draft with a brief (an agent makes it, an independent review checks it, the person
 * decides), behind the licence like every « Modifier »; with « Expert » on, its one statement opens in the SQL console,
 * never run from here.
 */

import React from "react";
import { Box, Button, Typography, alpha, useTheme } from "@mui/material";
import EditNoteRoundedIcon from "@mui/icons-material/EditNoteRounded";
import AutoAwesomeRoundedIcon from "@mui/icons-material/AutoAwesomeRounded";
import StorageRoundedIcon from "@mui/icons-material/StorageRounded";
import { useLanguage } from "../../contexts/LanguageContext";
import { useDetailPanel } from "../../contexts/DetailPanelContext";
import { licenceLockOf, openPaywall, useFeatures } from "../../utils/featuresApi";
import { openModifyProject } from "../../utils/modifyProject";
import { useExpertMode } from "../../utils/expertMode";
import { trackUi } from "../../utils/uiTelemetry";
import { openInSqlConsole } from "./openInSqlConsole";
import { CHAT_CLOSE_EVENT } from "../../utils/appEvents";

const MOTION = {
  "@keyframes changeCardIn": { "0%": { transform: "translateY(8px) scale(.985)", opacity: 0 }, "100%": { transform: "none", opacity: 1 } },
  animation: "changeCardIn 340ms cubic-bezier(.2,.8,.2,1) both",
  "@media (prefers-reduced-motion: reduce)": { animation: "none" },
};

export default function ChangeCard({ change }) {
  const theme = useTheme();
  const { t } = useLanguage();
  const { features } = useFeatures();
  const [expert] = useExpertMode();
  const { showSqlConsole } = useDetailPanel();
  const lock = licenceLockOf(features?.access);
  const tone = theme.palette.primary.main;
  const prepare = () => {
    trackUi("assistant.change", "brief");
    // The brief draft's panel takes the assistant's place beside the reader; the conversation stays.
    const open = () => {
      window.dispatchEvent(new CustomEvent(CHAT_CLOSE_EVENT));
      openModifyProject({ brief: change.brief });
    };
    if (lock) openPaywall("edit", lock, open);
    else open();
  };
  return (
    <Box data-testid="chat-change" sx={{ ...MOTION, mt: 1, borderRadius: "14px", border: `1px solid ${alpha(tone, 0.35)}`, backgroundColor: alpha(tone, theme.palette.mode === "dark" ? 0.1 : 0.04), overflow: "hidden" }}>
      <Box sx={{ display: "flex", alignItems: "center", gap: 1, px: 1.75, pt: 1.5 }}>
        <Box aria-hidden sx={{ width: 26, height: 26, borderRadius: "8px", display: "grid", placeItems: "center", color: theme.palette.primary.contrastText, backgroundColor: tone }}>
          <EditNoteRoundedIcon sx={{ fontSize: 17 }} />
        </Box>
        <Typography component="h4" sx={{ fontSize: "0.84rem", fontWeight: 750, m: 0 }}>
          {t("chat.change.title")}
        </Typography>
      </Box>
      <Typography data-testid="chat-change-brief" sx={{ mx: 1.75, mt: 1, px: 1.5, py: 1.25, borderRadius: "10px", fontSize: "0.86rem", lineHeight: 1.55, whiteSpace: "pre-line", backgroundColor: theme.palette.background.paper, border: `1px solid ${theme.palette.divider}` }}>
        {change.brief}
      </Typography>
      <Typography sx={{ mx: 1.75, mt: 1, fontSize: "0.74rem", color: "text.secondary", lineHeight: 1.45 }}>{t("chat.change.hint")}</Typography>
      <Box sx={{ display: "flex", flexWrap: "wrap", gap: 1, px: 1.75, pt: 1.25, pb: 1.5 }}>
        <Button variant="contained" disableElevation size="small" startIcon={<AutoAwesomeRoundedIcon />} onClick={prepare} data-testid="chat-change-prepare" sx={{ textTransform: "none", fontWeight: 700, borderRadius: "9px", px: 1.75, transition: "transform .12s", "&:active": { transform: "scale(.98)" } }}>
          {t("chat.change.prepare")}
        </Button>
        {expert && change.sql && (
          <Button size="small" startIcon={<StorageRoundedIcon />} onClick={() => openInSqlConsole(change.sql, showSqlConsole)} data-testid="chat-change-sql" sx={{ textTransform: "none", fontWeight: 650, borderRadius: "9px", color: "text.secondary" }}>
            {t("chat.change.sql")}
          </Button>
        )}
      </Box>
    </Box>
  );
}
