import React from "react";
import { Box } from "@mui/material";
import { alpha } from "@mui/material/styles";
import { MONO_FONT } from "./constants";

/* ------------------------------------------------------------------ */
/* Kbd — pro-grade keyboard shortcut chip                              */
/* Used across the toolbar, tooltips, and help dialog.                  */
/* ------------------------------------------------------------------ */

export default function Kbd({ children, sx, ...rest }) {
  return (
    <Box
      component="kbd"
      sx={{
        display: "inline-flex",
        alignItems: "center",
        height: 16,
        px: 0.5,
        ml: 0.75,
        borderRadius: "4px",
        fontFamily: MONO_FONT,
        fontSize: 10,
        lineHeight: 1,
        fontWeight: 600,
        background: (theme) => alpha(theme.palette.text.primary, 0.06),
        border: (theme) =>
          `1px solid ${alpha(theme.palette.text.primary, 0.12)}`,
        color: (theme) => alpha(theme.palette.text.primary, 0.7),
        userSelect: "none",
        ...sx,
      }}
      {...rest}
    >
      {children}
    </Box>
  );
}
