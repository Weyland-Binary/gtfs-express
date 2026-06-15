/**
 * UpsellPanel — the paywall moment of the AI companion.
 *
 * Rendered in place of the input bar when the anonymous free trial is used
 * up (server-typed FREE_QUOTA_EXHAUSTED). The user has just experienced the
 * assistant on THEIR feed — this panel converts that moment: benefits
 * recap, "request access" CTA (mailto, future subscription slot) and an
 * "I have a code" path that unlocks and immediately retries the blocked
 * question.
 */

import React from "react";
import { Box, Button, Stack, Typography, useTheme, alpha } from "@mui/material";
import AutoFixHighIcon from "@mui/icons-material/AutoFixHigh";
import AllInclusiveIcon from "@mui/icons-material/AllInclusive";
import IosShareIcon from "@mui/icons-material/IosShare";
import LockOpenOutlinedIcon from "@mui/icons-material/LockOpenOutlined";
import MailOutlineIcon from "@mui/icons-material/MailOutline";
import VpnKeyOutlinedIcon from "@mui/icons-material/VpnKeyOutlined";
import { useLanguage } from "../../contexts/LanguageContext";

const SUPPORT_EMAIL = "weylandbinary@gmail.com";

const BENEFITS = [
  { Icon: AllInclusiveIcon, key: "chat.upsell.benefitUnlimited" },
  { Icon: AutoFixHighIcon, key: "chat.upsell.benefitRepair" },
  { Icon: IosShareIcon, key: "chat.upsell.benefitExport" },
];

function UpsellPanel({ onHaveCode }) {
  const theme = useTheme();
  const { t } = useLanguage();

  const mailto = `mailto:${SUPPORT_EMAIL}?subject=${encodeURIComponent(
    "GTFS Express — Access request (AI companion)",
  )}&body=${encodeURIComponent(
    "Hello,\n\nI tried the AI companion on my GTFS feed and would like full access.\n\nName / Organization:\nUse case (briefly):\n\nThank you.",
  )}`;

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
          {t("chat.upsell.title")}
        </Typography>
      </Box>
      <Typography
        variant="caption"
        color="text.secondary"
        component="div"
        sx={{ mb: 1.25, lineHeight: 1.5 }}
      >
        {t("chat.upsell.body")}
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
          startIcon={<MailOutlineIcon sx={{ fontSize: 15 }} />}
          href={mailto}
          target="_blank"
          rel="noreferrer"
          sx={{
            textTransform: "none",
            fontWeight: 700,
            flex: 1,
            boxShadow: "none",
            "&:hover": { boxShadow: "none" },
          }}
        >
          {t("chat.upsell.requestCta")}
        </Button>
        <Button
          variant="outlined"
          size="small"
          startIcon={<VpnKeyOutlinedIcon sx={{ fontSize: 15 }} />}
          onClick={onHaveCode}
          data-testid="chat-upsell-have-code"
          sx={{ textTransform: "none", fontWeight: 600, flexShrink: 0 }}
        >
          {t("chat.upsell.haveCodeCta")}
        </Button>
      </Stack>
    </Box>
  );
}

export default UpsellPanel;
