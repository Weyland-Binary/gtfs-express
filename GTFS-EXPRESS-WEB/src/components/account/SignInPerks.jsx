/**
 * What a free account brings, said before its address is asked: the assistant's questions a month, the Expert tools,
 * the trial. Its figures are the server's; what asked for the sign-in comes first (the assistant, or a locked act for
 * the trial). Nothing under the open model, where everything is open already.
 */
import React from "react";
import { Box, Typography, alpha, useTheme } from "@mui/material";
import AutoAwesomeOutlinedIcon from "@mui/icons-material/AutoAwesomeOutlined";
import InsightsOutlinedIcon from "@mui/icons-material/InsightsOutlined";
import WorkspacePremiumOutlinedIcon from "@mui/icons-material/WorkspacePremiumOutlined";
import { useLanguage } from "../../contexts/LanguageContext";
import { isPaidModel, useFeatures } from "../../utils/featuresApi";

const LOCKED_FROM = new Set(["paywall", "lock", "offer"]);

export default function SignInPerks({ reason = null, from = null }) {
  const theme = useTheme();
  const { t } = useLanguage();
  const { features } = useFeatures();
  const access = features?.access;
  if (!isPaidModel(access)) return null;
  const questions = Number(features?.chat?.reader?.limit || reason?.limit) || 0;
  const days = Number(access?.billing?.trial_days) || 0;
  const perks = [
    questions > 0 && { id: "assistant", Icon: AutoAwesomeOutlinedIcon, color: theme.palette.ai?.main || theme.palette.primary.main, text: t("account.perks.assistant", { count: questions }) },
    { id: "expert", Icon: InsightsOutlinedIcon, color: theme.palette.primary.main, text: t("account.perks.expert") },
    days > 0 && { id: "trial", Icon: WorkspacePremiumOutlinedIcon, color: theme.palette.primary.main, text: t("account.perks.trial", { days }) },
  ].filter(Boolean);
  const lead = reason?.kind === "reader" || from === "assistant" ? "assistant" : LOCKED_FROM.has(from) ? "trial" : null;
  const shown = lead ? [...perks.filter((p) => p.id === lead), ...perks.filter((p) => p.id !== lead)] : perks;
  return (
    <Box data-testid="account-perks" data-lead={lead || undefined} sx={{ mb: 2, px: 1.5, py: 1.25, borderRadius: "12px", backgroundColor: alpha(theme.palette.primary.main, theme.palette.mode === "dark" ? 0.12 : 0.05) }}>
      <Typography component="h3" sx={{ m: 0, mb: 0.75, fontSize: "0.7rem", fontWeight: 700, letterSpacing: "0.06em", textTransform: "uppercase", color: "text.secondary" }}>
        {t("account.perks.title")}
      </Typography>
      <Box component="ul" sx={{ m: 0, p: 0, listStyle: "none", display: "flex", flexDirection: "column", gap: 0.75 }}>
        {shown.map(({ id, Icon, color, text }) => (
          <Box component="li" key={id} data-perk={id} sx={{ display: "flex", alignItems: "flex-start", gap: 1 }}>
            <Icon aria-hidden sx={{ fontSize: 18, mt: "1px", color, flexShrink: 0 }} />
            <Typography sx={{ fontSize: "0.84rem", lineHeight: 1.45, fontWeight: id === lead ? 700 : 500 }}>{text}</Typography>
          </Box>
        ))}
      </Box>
    </Box>
  );
}
