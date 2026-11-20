import React from "react";
import { Box } from "@mui/material";
import { alpha, useTheme } from "@mui/material/styles";
import { lineBadgeColors } from "../../utils/lineColors";

// The minimum widths are the squares a number of one or two characters always had.
const SIZES = {
  xs: { minWidth: 24, height: 18, px: "4px", fontSize: 10, borderRadius: "4px", fontWeight: 800 },
  sm: { minWidth: 24, height: 24, px: "3px", fontSize: 12, borderRadius: "5px", fontWeight: 600 },
  md: { minWidth: 28, height: 28, px: "4px", fontSize: 11, borderRadius: "6px", fontWeight: 800 },
  lg: { minWidth: 36, height: 36, px: "6px", fontSize: 16, borderRadius: "8px", fontWeight: 700 },
};

/**
 * A line's number on its colours (utils/lineColors), as wide as the number asks: a minimum width, never a fixed one.
 * The hairline keeps a white line a badge on a white ground.
 */
export default function LineBadge({ route, size = "sm", sx = null }) {
  const theme = useTheme();
  const { bg, fg } = lineBadgeColors(route);
  return (
    <Box
      component="span"
      data-testid="line-badge"
      style={{ backgroundColor: bg, color: fg }}
      sx={{
        ...SIZES[size],
        maxWidth: 120,
        boxSizing: "border-box",
        flexShrink: 0,
        display: "inline-flex",
        alignItems: "center",
        justifyContent: "center",
        lineHeight: 1,
        boxShadow: `inset 0 0 0 1px ${alpha(theme.palette.text.primary, 0.14)}`,
        ...sx,
      }}
    >
      <Box component="span" sx={{ minWidth: 0, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
        {route?.route_short_name}
      </Box>
    </Box>
  );
}
