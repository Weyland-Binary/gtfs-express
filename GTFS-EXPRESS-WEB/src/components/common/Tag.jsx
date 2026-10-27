import React from "react";
import { Box, alpha, useTheme } from "@mui/material";

/** A neutral tint for surfaces and hovers, readable in both themes. */
export const soft = (theme, strength = 1) => alpha(theme.palette.text.primary, (theme.palette.mode === "dark" ? 0.07 : 0.045) * strength);

/** A small rounded label in a colour of the palette. */
export function Tag({ children, color = null, sx = {} }) {
  const theme = useTheme();
  const c = color || theme.palette.primary.main;
  return (
    <Box component="span" sx={{ display: "inline-flex", alignItems: "center", gap: 0.4, px: 0.75, py: 0.2, borderRadius: 99, fontSize: "0.64rem", fontWeight: 700, lineHeight: 1.4, color: c, background: alpha(c, theme.palette.mode === "dark" ? 0.18 : 0.1), whiteSpace: "nowrap", ...sx }}>
      {children}
    </Box>
  );
}
