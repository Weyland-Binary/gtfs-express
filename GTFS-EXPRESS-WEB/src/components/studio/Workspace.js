/**
 * Workspace — the Network Studio's workbench on a desktop screen, the same
 * for both jobs: the map in the middle, on the whole height; on its left a
 * tool rail and the panel of the tool chosen (the starting point, the
 * lines, the stops, the conversation, the catalogue…); on its right what the
 * engine says (the inspector). Each pane scrolls on its own; the page never
 * does.
 *
 *   ToolRail   a vertical tab list (`role="tablist"`, ↑/↓, Home/End): one
 *              icon and a short word per tool; choosing the open tool again
 *              folds the panel (the host decides: `onSelect(key)`)
 *   Panel      the tool's panel: its title, a line that says what it is
 *              for, actions, a body that scrolls, an optional foot
 *   Section    a block of a panel or of the inspector, under a small title
 *   Inspector  the right-hand column
 *   Kpi        one measured figure and what it counts
 *   floatSx    the look of what floats over the map
 */

import React, { useRef } from "react";
import { Box, ButtonBase, Typography } from "@mui/material";
import { useTheme } from "@mui/material/styles";
import { tokensOf } from "./studioTheme";

export const floatSx = (theme) => {
  const k = tokensOf(theme);
  return { backgroundColor: k.surface, border: `1px solid ${k.line}`, borderRadius: "10px", boxShadow: k.float };
};

export function Workspace({ rail = null, panel = null, center, inspector = null, testid = "workspace", flush = false, sx = {} }) {
  const theme = useTheme();
  const k = tokensOf(theme);
  return (
    <Box data-testid={testid} data-flush={flush ? "true" : "false"} sx={{ flex: 1, minHeight: 0, display: "flex", border: flush ? "none" : `1px solid ${k.line}`, borderRadius: flush ? 0 : "12px", overflow: "hidden", backgroundColor: k.surface, ...sx }}>
      {rail}
      {panel}
      <Box sx={{ flex: "1 0 360px", minWidth: 360, minHeight: 0, position: "relative", display: "flex", flexDirection: "column", backgroundColor: k.ground }}>{center}</Box>
      {inspector}
    </Box>
  );
}

/**
 * The tool rail. `items`: [{ key, label, icon, testid, count, hidden, bottom, disabled }]; `value`: the open tool (or
 * null: the panel folded); `idBase` names the tabs and their panels (`${idBase}-tab-${key}`, `${idBase}-panel-${key}`).
 */
export function ToolRail({ label, items, value, onSelect, idBase = "studio" }) {
  const theme = useTheme();
  const k = tokensOf(theme);
  const refs = useRef({});
  const shown = items.filter((x) => !x.hidden);
  const order = [...shown.filter((x) => !x.bottom), ...shown.filter((x) => x.bottom)];
  const onKeyDown = (event, i) => {
    const to = { ArrowDown: i + 1, ArrowUp: i - 1, Home: 0, End: order.length - 1 }[event.key];
    if (to === undefined) return;
    event.preventDefault();
    const next = order[(to + order.length) % order.length];
    refs.current[next.key]?.focus();
  };
  const button = (x) => {
    const on = x.key === value;
    const i = order.indexOf(x);
    return (
      <ButtonBase
        key={x.key}
        ref={(el) => {
          refs.current[x.key] = el;
        }}
        role="tab"
        id={`${idBase}-tab-${x.key}`}
        aria-selected={on}
        aria-controls={`${idBase}-panel-${x.key}`}
        tabIndex={on || (!value && i === 0) ? 0 : -1}
        disabled={Boolean(x.disabled)}
        onClick={() => onSelect?.(x.key)}
        onKeyDown={(e) => onKeyDown(e, i)}
        data-testid={x.testid}
        data-state={on ? "open" : "closed"}
        sx={{
          width: 56,
          py: "8px",
          px: 0.5,
          borderRadius: "9px",
          display: "flex",
          flexDirection: "column",
          alignItems: "center",
          gap: "5px",
          position: "relative",
          color: on ? (theme.palette.mode === "dark" ? k.accent : k.accentDark) : k.ink2,
          backgroundColor: on ? k.accentSoft : "transparent",
          "&:hover": { backgroundColor: on ? k.accentSoft : k.hover, color: on ? undefined : k.ink },
          "& svg": { fontSize: 20 },
          "&.Mui-disabled": { opacity: 0.45 },
        }}
      >
        {x.icon}
        <Box component="span" sx={{ fontSize: "0.66rem", fontWeight: 500, lineHeight: 1.1, textAlign: "center", maxWidth: 54, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
          {x.label}
        </Box>
        {x.count ? (
          <>
            <Box component="span" aria-hidden sx={{ position: "absolute", top: 3, right: 6, minWidth: 16, height: 16, px: "4px", borderRadius: 999, fontSize: "0.62rem", fontWeight: 600, lineHeight: "16px", textAlign: "center", backgroundColor: on ? k.accent : k.hover, color: on ? k.onAccent : k.ink2, fontVariantNumeric: "tabular-nums" }}>
              {x.count}
            </Box>
            <Box component="span" className="visually-hidden">{` (${x.count})`}</Box>
          </>
        ) : null}
      </ButtonBase>
    );
  };
  return (
    <Box component="nav" aria-label={label} sx={{ width: 68, flexShrink: 0, borderRight: `1px solid ${k.line}`, backgroundColor: k.surface, display: "flex", flexDirection: "column", alignItems: "center", py: 1.25 }}>
      <Box role="tablist" aria-label={label} aria-orientation="vertical" sx={{ display: "flex", flexDirection: "column", alignItems: "center", gap: 0.5, flex: 1, minHeight: 0 }}>
        {shown.filter((x) => !x.bottom).map(button)}
        <Box sx={{ flex: 1 }} />
        {shown.filter((x) => x.bottom).map(button)}
      </Box>
    </Box>
  );
}

/** A tool's panel: kept mounted while folded or while another tool is open (`hidden`), so nothing typed is lost. */
export function Panel({ tool, idBase = "studio", title, subtitle = null, actions = null, footer = null, children, width = 360, hidden = false, testid, flush = false, standalone = false }) {
  const theme = useTheme();
  const k = tokensOf(theme);
  const titleId = `${idBase}-panel-${tool}-title`;
  return (
    <Box
      component="section"
      role={standalone ? undefined : "tabpanel"}
      id={`${idBase}-panel-${tool}`}
      aria-labelledby={standalone ? titleId : `${idBase}-tab-${tool}`}
      hidden={hidden}
      data-testid={testid}
      sx={{ flex: `0 1 ${width}px`, width, minWidth: 320, borderRight: `1px solid ${k.line}`, backgroundColor: k.surface, display: hidden ? "none" : "flex", flexDirection: "column", minHeight: 0 }}
    >
      {title && (
        <Box sx={{ px: 2, pt: 2, pb: 1.5, display: "flex", alignItems: "flex-start", gap: 1, flexShrink: 0 }}>
          <Box sx={{ flex: 1, minWidth: 0 }}>
            <Typography id={titleId} component="h2" sx={{ fontSize: "0.94rem", fontWeight: 600, letterSpacing: "-0.01em", lineHeight: 1.3 }}>
              {title}
            </Typography>
            {subtitle && <Typography sx={{ fontSize: "0.78rem", color: "text.secondary", mt: 0.375, lineHeight: 1.45 }}>{subtitle}</Typography>}
          </Box>
          {actions}
        </Box>
      )}
      <Box sx={{ flex: 1, minHeight: 0, overflowY: "auto", overflowX: "hidden", display: "flex", flexDirection: "column", ...(flush ? {} : { pb: 2 }) }}>{children}</Box>
      {footer && <Box sx={{ flexShrink: 0, borderTop: `1px solid ${k.lineSoft}`, px: 2, py: 1.25, backgroundColor: k.subtle }}>{footer}</Box>}
    </Box>
  );
}

/** A block of a panel or of the inspector, under its small title; `first` drops the line above it. */
export function Section({ title = null, action = null, children, testid, first = false, sx = {} }) {
  const theme = useTheme();
  const k = tokensOf(theme);
  return (
    <Box component="section" data-testid={testid} aria-label={typeof title === "string" ? title : undefined} sx={{ px: 2, pt: first ? 0.5 : 2, pb: 2, borderTop: first ? "none" : `1px solid ${k.lineSoft}`, display: "flex", flexDirection: "column", gap: 1.25, ...sx }}>
      {(title || action) && (
        <Box sx={{ display: "flex", alignItems: "center", justifyContent: "space-between", gap: 1, minHeight: 20 }}>
          {title && (
            <Typography component="h3" sx={{ fontSize: "0.69rem", fontWeight: 600, letterSpacing: "0.06em", textTransform: "uppercase", color: "text.disabled" }}>
              {title}
            </Typography>
          )}
          {action}
        </Box>
      )}
      {children}
    </Box>
  );
}

/** The right-hand column: what the engine measured, said beside the work. */
export function Inspector({ title, subtitle = null, children, footer = null, width = 320, testid = "studio-inspector", label = null }) {
  const theme = useTheme();
  const k = tokensOf(theme);
  return (
    <Box component="aside" aria-label={label || (typeof title === "string" ? title : undefined)} data-testid={testid} sx={{ flex: `0 1 ${width}px`, width, minWidth: 280, borderLeft: `1px solid ${k.line}`, backgroundColor: k.surface, display: "flex", flexDirection: "column", minHeight: 0 }}>
      {title && (
        <Box sx={{ px: 2, pt: 2, pb: 1, flexShrink: 0 }}>
          <Typography component="h2" sx={{ fontSize: "0.94rem", fontWeight: 600, letterSpacing: "-0.01em", lineHeight: 1.3 }}>
            {title}
          </Typography>
          {subtitle && <Typography sx={{ fontSize: "0.78rem", color: "text.secondary", mt: 0.375, lineHeight: 1.45 }}>{subtitle}</Typography>}
        </Box>
      )}
      {/* Scrolling on its own, reachable by the keyboard (WCAG 2.1.1): a column of text alone holds nothing to tab to. */}
      <Box tabIndex={0} role="region" aria-label={label || (typeof title === "string" ? title : undefined)} sx={{ flex: 1, minHeight: 0, overflowY: "auto", overflowX: "hidden", display: "flex", flexDirection: "column", "&:focus-visible": { outline: `2px solid ${theme.palette.primary.main}`, outlineOffset: -2 } }}>
        {children}
      </Box>
      {footer && <Box sx={{ flexShrink: 0, borderTop: `1px solid ${k.lineSoft}`, px: 2, py: 1.25, backgroundColor: k.subtle }}>{footer}</Box>}
    </Box>
  );
}

/** One measured figure: the value (tabular), what it counts. */
export function Kpi({ value, label, tone = null, testid, onClick = null }) {
  const theme = useTheme();
  const k = tokensOf(theme);
  const Root = onClick ? ButtonBase : Box;
  return (
    <Root data-testid={testid} onClick={onClick || undefined} sx={{ display: "flex", flexDirection: "column", alignItems: "flex-start", gap: 0.25, px: 1.5, py: 1.25, border: `1px solid ${k.lineSoft}`, borderRadius: "9px", backgroundColor: k.surface, textAlign: "left", minWidth: 0, ...(onClick ? { "&:hover": { backgroundColor: k.hover } } : {}) }}>
      <Box component="span" sx={{ fontSize: "1rem", fontWeight: 600, letterSpacing: "-0.01em", fontVariantNumeric: "tabular-nums", color: tone || "text.primary", lineHeight: 1.25, maxWidth: "100%", overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
        {value}
      </Box>
      <Box component="span" sx={{ fontSize: "0.72rem", color: "text.secondary", lineHeight: 1.3 }}>
        {label}
      </Box>
    </Root>
  );
}

export function KpiGrid({ children, columns = 2 }) {
  return <Box sx={{ display: "grid", gridTemplateColumns: `repeat(${columns}, minmax(0, 1fr))`, gap: 1 }}>{children}</Box>;
}
