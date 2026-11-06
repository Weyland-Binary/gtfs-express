/**
 * The ground under white cards (the detail panel, the validation report): a shade darker than the cards in both modes,
 * so a section reads as a card, never white on white.
 */
import { alpha } from "@mui/material";

export const groundOf = (theme) => (theme.palette.mode === "dark" ? "#0f131a" : "#e9edf3");

export const cardSx = (theme) => ({
  borderRadius: "14px",
  border: `1px solid ${theme.palette.divider}`,
  backgroundColor: theme.palette.background.paper,
  boxShadow: `0 1px 2px ${alpha(theme.palette.common.black, theme.palette.mode === "dark" ? 0.4 : 0.05)}`,
});
