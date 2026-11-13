import React from "react";
import { Box, ButtonBase, alpha, useTheme } from "@mui/material";

/** A notice of one line across the report: its tone's tint, its icon, its words and at most one act. */
export function Notice({ tone, icon, action = null, testId, title, children }) {
  const theme = useTheme();
  const dark = theme.palette.mode === "dark";
  return (
    <Box
      role="status"
      data-testid={testId}
      title={title}
      sx={{ flexShrink: 0, display: "flex", alignItems: "center", gap: 1.25, minHeight: 36, px: 3, py: 0.75, bgcolor: alpha(tone, dark ? 0.14 : 0.08), borderBottom: `1px solid ${theme.palette.divider}`, fontSize: "0.8125rem", lineHeight: 1.45, color: "text.primary" }}
    >
      <Box aria-hidden sx={{ display: "flex", flexShrink: 0, color: tone, "& svg": { fontSize: 17 } }}>
        {icon}
      </Box>
      <Box sx={{ flex: 1, minWidth: 0 }}>{children}</Box>
      {action}
    </Box>
  );
}

export function NoticeAct({ onClick, children, testId }) {
  const theme = useTheme();
  return (
    <ButtonBase
      onClick={onClick}
      data-testid={testId}
      sx={{ flexShrink: 0, font: "inherit", fontWeight: 600, color: "primary.main", px: 0.5, borderRadius: "4px", "&:hover": { textDecoration: "underline" }, "&.Mui-focusVisible": { outline: `2px solid ${theme.palette.primary.main}`, outlineOffset: 2 } }}
    >
      {children}
    </ButtonBase>
  );
}
