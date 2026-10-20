/**
 * UpsellPanel — the paywall moment of the AI companion.
 *
 * Rendered in place of the input bar when the free questions are used up
 * (server-typed FREE_QUOTA_EXHAUSTED): a session's, or the reading
 * companion's of the month (`month`, with the day they come back, `resets`). The user has just experienced the
 * assistant on THEIR feed — this panel converts that moment: benefits
 * recap, the plans and the "request access" CTA (mailto).
 */

import React from "react";
import { Box, Button, Stack, Typography, useTheme, alpha } from "@mui/material";
import AutoFixHighIcon from "@mui/icons-material/AutoFixHigh";
import AllInclusiveIcon from "@mui/icons-material/AllInclusive";
import IosShareIcon from "@mui/icons-material/IosShare";
import LockOpenOutlinedIcon from "@mui/icons-material/LockOpenOutlined";
import MailOutlineIcon from "@mui/icons-material/MailOutline";
import WorkspacePremiumOutlinedIcon from "@mui/icons-material/WorkspacePremiumOutlined";
import { useLanguage } from "../../contexts/LanguageContext";
import { useFeatures, requestAccessLink } from "../../utils/featuresApi";
import { formatDate } from "../../utils/formatDate";

const BENEFITS = [
  { Icon: AllInclusiveIcon, key: "chat.upsell.benefitUnlimited" },
  { Icon: AutoFixHighIcon, key: "chat.upsell.benefitRepair" },
  { Icon: IosShareIcon, key: "chat.upsell.benefitExport" },
];

function UpsellPanel({ month = false, resets = null }) {
  const theme = useTheme();
  const { t, language } = useLanguage();
  // The "request access" link comes from the server (request_access_url);
  // without one the button is not shown, the plans remain.
  const { features } = useFeatures();
  const mailto = requestAccessLink(features?.request_access_url, { subject: t("mailto.subject"), body: t("mailto.body") });

  return (
    <Box
      data-testid="chat-upsell"
      sx={{
        flexShrink: 0,
        px: 2,
        py: 1.75,
        borderTop: `1px solid ${alpha(theme.palette.primary.main, 0.25)}`,
        background: `linear-gradient(180deg, ${alpha(
          theme.palette.primary.main,
          0.06,
        )} 0%, ${alpha(theme.palette.primary.main, 0.02)} 100%)`,
      }}
    >
      <Box sx={{ display: "flex", alignItems: "center", gap: 1, mb: 1 }}>
        <LockOpenOutlinedIcon
          sx={{ fontSize: 20, color: theme.palette.primary.main }}
        />
        <Typography variant="subtitle2" sx={{ fontWeight: 700 }}>
          {t(month ? "chat.upsell.month.title" : "chat.upsell.title")}
        </Typography>
      </Box>
      <Typography
        variant="caption"
        color="text.secondary"
        component="div"
        sx={{ mb: 1.25, lineHeight: 1.5 }}
      >
        {month ? (resets ? t("chat.upsell.month.body", { date: formatDate(`${resets}T00:00:00`, language, "long") || resets }) : t("chat.upsell.month.bodyNoDate")) : t("chat.upsell.body")}
      </Typography>

      <Stack spacing={0.5} sx={{ mb: 1.5 }}>
        {BENEFITS.map(({ Icon, key }) => (
          <Box
            key={key}
            sx={{
              display: "flex",
              alignItems: "center",
              gap: 1,
              px: 1,
              py: 0.5,
              borderRadius: 1,
              background: alpha(theme.palette.primary.main, 0.05),
            }}
          >
            <Icon
              sx={{
                fontSize: 14,
                color: theme.palette.primary.main,
                flexShrink: 0,
              }}
            />
            <Typography variant="caption" lineHeight={1.4}>
              {t(key)}
            </Typography>
          </Box>
        ))}
      </Stack>

      <Stack direction="row" spacing={1}>
        <Button
          variant="contained"
          size="small"
          startIcon={<WorkspacePremiumOutlinedIcon sx={{ fontSize: 15 }} />}
          onClick={() => window.dispatchEvent(new CustomEvent("gtfs:open-pricing", { detail: { reason: "ai_quota" } }))}
          data-testid="chat-upsell-plans"
          sx={{
            textTransform: "none",
            fontWeight: 700,
            flex: 1,
            boxShadow: "none",
            "&:hover": { boxShadow: "none" },
          }}
        >
          {t("chat.upsell.seePlans")}
        </Button>
        {mailto && (
          <Button
            variant="outlined"
            size="small"
            startIcon={<MailOutlineIcon sx={{ fontSize: 15 }} />}
            href={mailto}
            target="_blank"
            rel="noreferrer"
            data-testid="chat-upsell-request"
            sx={{ textTransform: "none", fontWeight: 600, flexShrink: 0 }}
          >
            {t("chat.upsell.requestCta")}
          </Button>
        )}
      </Stack>
    </Box>
  );
}

export default UpsellPanel;
