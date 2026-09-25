/**
 * StudioUI — the quiet building blocks of the Network Studio.
 *
 * Borders separate the regions of the page (header, side panel, map,
 * footer). Inside a region, hierarchy comes from type, spacing and soft
 * tints: section labels instead of boxes, text actions instead of outlined
 * buttons, stats as numbers instead of chips. One filled action per area.
 */

import React from "react";
import { Box, Button, ButtonBase, Tooltip, Typography, alpha, useTheme } from "@mui/material";
import ExpandMoreIcon from "@mui/icons-material/ExpandMore";

/** A neutral tint for surfaces and hovers, readable in both themes. */
export const soft = (theme, strength = 1) => alpha(theme.palette.text.primary, (theme.palette.mode === "dark" ? 0.07 : 0.045) * strength);

/** Compact numbers for stats: 133 625 → "134 k" (locale-aware). */
export const compactNumber = (n, locale) => {
  if (typeof n !== "number" || !Number.isFinite(n)) return "—";
  if (Math.abs(n) < 10000) return n.toLocaleString(locale);
  try {
    return new Intl.NumberFormat(locale, { notation: "compact", maximumFractionDigits: 1 }).format(n);
  } catch {
    return n.toLocaleString(locale);
  }
};

/** An uppercase section label, optionally collapsible, with an action slot on the right. */
export function SectionHeader({ label, right = null, open = null, onToggle = null, testid = undefined }) {
  const text = (
    <Typography component="span" sx={{ fontSize: "0.68rem", fontWeight: 700, letterSpacing: "0.06em", textTransform: "uppercase", color: "text.secondary", lineHeight: 1 }}>
      {label}
    </Typography>
  );
  return (
    <Box sx={{ display: "flex", alignItems: "center", gap: 0.5, minHeight: 26 }} data-testid={testid}>
      {onToggle ? (
        <ButtonBase onClick={onToggle} aria-expanded={Boolean(open)} sx={{ display: "flex", alignItems: "center", gap: 0.25, borderRadius: 1, px: 0.5, py: 0.25, ml: -0.5 }}>
          {text}
          <ExpandMoreIcon sx={{ fontSize: 16, color: "text.secondary", transform: open ? "none" : "rotate(-90deg)", transition: "transform 150ms" }} />
        </ButtonBase>
      ) : (
        text
      )}
      <Box sx={{ flex: 1 }} />
      {right}
    </Box>
  );
}

/** A text action: no border, compact, primary by default. */
export const QuietButton = React.forwardRef(function QuietButton({ children, sx = {}, ...props }, ref) {
  return (
    <Button ref={ref} size="small" variant="text" {...props} sx={{ textTransform: "none", fontWeight: 600, fontSize: "0.76rem", lineHeight: 1.4, px: 1, py: 0.4, minWidth: 0, borderRadius: 1.5, whiteSpace: "nowrap", "& .MuiButton-startIcon": { mr: 0.5 }, ...sx }}>
      {children}
    </Button>
  );
});

/** A number over its label, on a soft tile. */
export function Stat({ icon: Icon = null, value, label, hint = null, muted = false, testid = undefined }) {
  const theme = useTheme();
  const tile = (
    <Box data-testid={testid} sx={{ minWidth: 0, px: 1, py: 0.85, borderRadius: "10px", background: soft(theme) }}>
      <Box sx={{ display: "flex", alignItems: "center", gap: 0.5, color: muted ? "text.disabled" : "text.primary" }}>
        {Icon && <Icon sx={{ fontSize: 14, color: muted ? "text.disabled" : "text.secondary" }} />}
        <Typography component="span" sx={{ fontSize: "0.95rem", fontWeight: 800, lineHeight: 1.1, fontVariantNumeric: "tabular-nums" }}>
          {value}
        </Typography>
      </Box>
      <Typography sx={{ fontSize: "0.66rem", color: "text.secondary", lineHeight: 1.25, mt: 0.35, minHeight: "2.5em", display: "-webkit-box", WebkitLineClamp: 2, WebkitBoxOrient: "vertical", overflow: "hidden", overflowWrap: "anywhere" }} title={typeof label === "string" ? label : undefined}>
        {label}
      </Typography>
    </Box>
  );
  return hint ? <Tooltip title={hint}>{tile}</Tooltip> : tile;
}

/** A thin labelled progress bar (coverage and the like). */
export function Meter({ label, pct, color = null }) {
  const theme = useTheme();
  const value = Math.max(0, Math.min(100, Number(pct) || 0));
  const c = color || (value >= 70 ? theme.palette.success.main : value >= 45 ? theme.palette.warning.main : theme.palette.error.main);
  return (
    <Box sx={{ display: "grid", gridTemplateColumns: "72px 1fr 38px", alignItems: "center", gap: 1 }}>
      <Typography sx={{ fontSize: "0.72rem", color: "text.secondary" }} noWrap>
        {label}
      </Typography>
      <Box sx={{ height: 6, borderRadius: 99, background: soft(theme, 1.6), overflow: "hidden" }}>
        <Box sx={{ width: `${value}%`, height: "100%", borderRadius: 99, background: c, transition: "width 300ms" }} />
      </Box>
      <Typography sx={{ fontSize: "0.72rem", fontWeight: 700, textAlign: "right", fontVariantNumeric: "tabular-nums" }}>{pct == null ? "—" : `${value}%`}</Typography>
    </Box>
  );
}

/** A small rounded tag (status, scope), tinted, never outlined. */
export function Tag({ children, color = null, sx = {} }) {
  const theme = useTheme();
  const c = color || theme.palette.primary.main;
  return (
    <Box component="span" sx={{ display: "inline-flex", alignItems: "center", gap: 0.4, px: 0.75, py: 0.2, borderRadius: 99, fontSize: "0.64rem", fontWeight: 700, lineHeight: 1.4, color: c, background: alpha(c, theme.palette.mode === "dark" ? 0.18 : 0.1), whiteSpace: "nowrap", ...sx }}>
      {children}
    </Box>
  );
}
