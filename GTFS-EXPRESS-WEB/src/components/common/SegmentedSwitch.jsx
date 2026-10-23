/**
 * A choice of how to show the same thing (a view, a side), not a navigation: segments in one rounded group, each a
 * radio, the one shown raised. The draft's « Avant | Après » and the reader's « Grille | Carte » share it.
 */

import React from "react";
import { Box, ButtonBase, alpha, useTheme } from "@mui/material";

export default function SegmentedSwitch({ options, value, onChange, tone, label, testid, size = "small", ...rest }) {
  const theme = useTheme();
  const large = size === "large";
  const shown = tone || theme.palette.primary.main;
  return (
    <Box role="radiogroup" aria-label={label} data-testid={testid} data-value={value} {...rest} sx={{ display: "inline-flex", alignItems: "center", gap: "2px", p: large ? "4px" : "3px", flexShrink: 0, borderRadius: large ? "11px" : "9px", backgroundColor: alpha(shown, theme.palette.mode === "dark" ? 0.16 : 0.1) }}>
      {options.map((option) => {
        const on = value === option.value;
        return (
          <ButtonBase
            key={option.value}
            role="radio"
            aria-checked={on ? "true" : "false"}
            disabled={Boolean(option.disabled)}
            onClick={() => !on && onChange(option.value)}
            data-testid={`${testid}-${option.value}`}
            sx={{ height: large ? 34 : 26, px: large ? 1.75 : 1.1, gap: large ? 0.75 : 0.6, borderRadius: large ? "8px" : "7px", fontSize: large ? "0.88rem" : "0.78rem", fontWeight: on ? 700 : 550, whiteSpace: "nowrap", color: on ? shown : "text.secondary", backgroundColor: on ? theme.palette.background.paper : "transparent", boxShadow: on ? `0 1px 2px ${alpha(theme.palette.common.black, 0.12)}` : "none", transition: "background-color 120ms, color 120ms", "&:hover": { color: on ? shown : "text.primary" }, "&.Mui-focusVisible": { outline: `2px solid ${theme.palette.primary.main}`, outlineOffset: 1 }, "&.Mui-disabled": { opacity: 0.4 }, "& svg": { fontSize: large ? 19 : 16 } }}
          >
            {option.icon || null}
            {option.label}
          </ButtonBase>
        );
      })}
    </Box>
  );
}
