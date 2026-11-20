/**
 * DialogHeader — the head every dialog shares: the icon of its role (primary to do, warning to warn, error to
 * delete), its title (the dialog's accessible name), what it concerns, and the close at the top right.
 */

import React from "react";
import { Box, DialogTitle, IconButton, Typography, alpha, useTheme } from "@mui/material";
import CloseRoundedIcon from "@mui/icons-material/CloseRounded";
import { useLanguage } from "../../contexts/LanguageContext";

export default function DialogHeader({
  icon = null,
  tone = "primary",
  title,
  subtitle = null,
  extra = null,
  onClose = null,
  closeDisabled = false,
  closeTestId,
  titleId,
  titleTestId,
  sx,
}) {
  const { t } = useLanguage();
  const theme = useTheme();
  const main = (theme.palette[tone] || theme.palette.primary).main;
  return (
    <Box
      className="gx-dialog-header"
      sx={{ display: "flex", alignItems: "flex-start", gap: 1.75, p: "20px 16px 16px 24px", flex: "0 0 auto", ...sx }}
    >
      {icon && (
        <Box
          aria-hidden
          sx={{
            width: 40,
            height: 40,
            flex: "none",
            borderRadius: "11px",
            display: "flex",
            alignItems: "center",
            justifyContent: "center",
            bgcolor: alpha(main, theme.palette.mode === "dark" ? 0.16 : 0.1),
            color: main,
            "& svg": { fontSize: 20 },
          }}
        >
          {icon}
        </Box>
      )}
      <Box sx={{ flex: 1, minWidth: 0, alignSelf: subtitle ? "flex-start" : "center", pt: subtitle && icon ? "1px" : 0 }}>
        <DialogTitle id={titleId} data-testid={titleTestId} sx={{ p: 0, overflowWrap: "anywhere" }}>
          {title}
        </DialogTitle>
        {subtitle && (
          <Typography component="div" sx={{ mt: "3px", fontSize: 13, lineHeight: 1.45, color: "text.secondary", overflowWrap: "anywhere" }}>
            {subtitle}
          </Typography>
        )}
      </Box>
      {extra && <Box sx={{ flex: "none", alignSelf: "center", display: "flex", alignItems: "center", gap: 1 }}>{extra}</Box>}
      {onClose && (
        <IconButton
          onClick={onClose}
          disabled={closeDisabled}
          aria-label={t("app.close")}
          data-testid={closeTestId}
          sx={{ width: 32, height: 32, flex: "none", borderRadius: "8px", color: "text.secondary" }}
        >
          <CloseRoundedIcon sx={{ fontSize: 20 }} />
        </IconButton>
      )}
    </Box>
  );
}
