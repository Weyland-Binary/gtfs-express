/**
 * StudioSheet — the layout of the Network Studio's reading and deciding
 * steps (② Contrat, ④ Contrôles, ⑤ Livraison), in the studio's own look
 * (studioTheme tokens), as the workbenches of ① and ③ are:
 *
 *   StudioSheet  the page: an optional lead (the step's purpose, in one
 *                line), the step's indicators (KpiTiles) and a work area of
 *                one column, or two (`aside`: what is read beside the work,
 *                360 px on a wide screen, under it otherwise). It fills the
 *                width the window gives — never a narrow column with an empty
 *                half beside it.
 *   SheetCard    a section of the page: a surface with its heading (an
 *                index or a state mark, the title, a state in words, the
 *                section's own actions) and its body. `index` numbers the
 *                acts of a sequence (⑤: accept → build → deliver).
 *   KpiTiles     the indicators read first: each tile a label, a value, a
 *                tone (ok · warn · error · accent · neutral) and a hint —
 *                never a decision, only what the server measured.
 *
 * Nothing here holds the journey's state: the step passes what it shows.
 */

import React from "react";
import { Box, Typography } from "@mui/material";
import { useTheme } from "@mui/material/styles";
import CheckRoundedIcon from "@mui/icons-material/CheckRounded";
import { tokensOf } from "./studioTheme";

/** A tone's ink and ground in the studio's tokens. */
export const toneOf = (k, tone) =>
  ({
    ok: { ink: k.success, ground: k.successSoft },
    warn: { ink: k.warning, ground: k.warningSoft },
    error: { ink: k.error, ground: k.errorSoft },
    accent: { ink: k.accent, ground: k.accentSoft },
  })[tone] || { ink: k.ink2, ground: k.subtle };

export function KpiTiles({ tiles = [], testid = "kpi-tiles" }) {
  const k = tokensOf(useTheme());
  const shown = tiles.filter(Boolean);
  if (!shown.length) return null;
  return (
    <Box component="ul" data-testid={testid} sx={{ listStyle: "none", m: 0, p: 0, display: "grid", gridTemplateColumns: { xs: "repeat(2, minmax(0, 1fr))", md: `repeat(${Math.min(shown.length, 4)}, minmax(0, 1fr))` }, gap: 1 }}>
      {shown.map((tile) => {
        const tone = toneOf(k, tile.tone);
        return (
          <Box component="li" key={tile.id} data-testid={`kpi-${tile.id}`} data-tone={tile.tone || "neutral"} sx={{ minWidth: 0, px: 1.5, py: 1.25, borderRadius: "10px", border: `1px solid ${k.line}`, backgroundColor: k.surface, display: "flex", flexDirection: "column", gap: 0.25 }}>
            <Typography component="span" sx={{ fontSize: "0.7rem", fontWeight: 500, letterSpacing: "0.02em", color: k.ink3, textTransform: "uppercase", whiteSpace: "nowrap", overflow: "hidden", textOverflow: "ellipsis" }}>
              {tile.label}
            </Typography>
            <Box sx={{ display: "flex", alignItems: "center", gap: 0.75, minWidth: 0 }}>
              <Box component="span" aria-hidden sx={{ width: 8, height: 8, flexShrink: 0, borderRadius: "50%", backgroundColor: tone.ink, boxShadow: `0 0 0 3px ${tone.ground}` }} />
              <Typography component="span" title={typeof tile.value === "string" ? tile.value : undefined} sx={{ fontSize: "1.05rem", fontWeight: 600, color: k.ink, lineHeight: 1.3, whiteSpace: "nowrap", overflow: "hidden", textOverflow: "ellipsis", fontVariantNumeric: "tabular-nums" }}>
                {tile.value}
              </Typography>
            </Box>
            {tile.hint && (
              <Typography component="span" sx={{ fontSize: "0.74rem", color: k.ink2, lineHeight: 1.4, display: "-webkit-box", WebkitLineClamp: 2, WebkitBoxOrient: "vertical", overflow: "hidden" }}>
                {tile.hint}
              </Typography>
            )}
          </Box>
        );
      })}
    </Box>
  );
}

/** The mark in front of a card's title: its index in a sequence, a check once done, or nothing. */
function Mark({ index = null, done = false, k }) {
  if (index == null && !done) return null;
  return (
    <Box component="span" aria-hidden sx={{ width: 22, height: 22, flexShrink: 0, borderRadius: "50%", display: "inline-flex", alignItems: "center", justifyContent: "center", fontSize: "0.72rem", fontWeight: 600, ...(done ? { backgroundColor: k.success, color: k.surface } : { backgroundColor: k.accentSoft, color: k.accent, border: `1px solid ${k.accentLine}` }) }}>
      {done ? <CheckRoundedIcon sx={{ fontSize: 15 }} /> : index}
    </Box>
  );
}

export function SheetCard({ title = null, index = null, done = false, status = null, statusTone = null, actions = null, children, testid = null, sx = {}, bodySx = {}, component = "section" }) {
  const k = tokensOf(useTheme());
  const tone = toneOf(k, statusTone);
  return (
    <Box component={component} aria-label={typeof title === "string" ? title : undefined} data-testid={testid || undefined} sx={{ borderRadius: "12px", border: `1px solid ${k.line}`, backgroundColor: k.surface, boxShadow: k.raise, minWidth: 0, display: "flex", flexDirection: "column", ...sx }}>
      {(title || actions) && (
        <Box sx={{ display: "flex", alignItems: "center", gap: 1, px: 2, pt: 1.5, pb: 1, flexWrap: "wrap" }}>
          <Mark index={index} done={done} k={k} />
          {title && (
            <Typography component="h2" sx={{ fontSize: "0.92rem", fontWeight: 600, color: k.ink, lineHeight: 1.35, minWidth: 0 }}>
              {title}
            </Typography>
          )}
          {status && (
            <Box component="span" sx={{ height: 20, px: 0.9, borderRadius: 999, display: "inline-flex", alignItems: "center", fontSize: "0.7rem", fontWeight: 500, color: tone.ink, backgroundColor: tone.ground, whiteSpace: "nowrap" }}>
              {status}
            </Box>
          )}
          <Box sx={{ flex: 1 }} />
          {actions}
        </Box>
      )}
      <Box sx={{ px: 2, pb: 1.75, pt: title || actions ? 0 : 1.75, display: "flex", flexDirection: "column", gap: 1, minWidth: 0, ...bodySx }}>{children}</Box>
    </Box>
  );
}

export default function StudioSheet({ lead = null, tiles = null, aside = null, children, testid = null, asideWidth = 360 }) {
  const k = tokensOf(useTheme());
  return (
    <Box data-testid={testid || "studio-sheet"} sx={{ width: "100%", minWidth: 0, px: { xs: 0, md: 2 }, py: { xs: 0.5, md: 1.5 }, display: "flex", flexDirection: "column", gap: 1.5, boxSizing: "border-box" }}>
      {lead && <Typography sx={{ fontSize: "0.84rem", color: k.ink2, lineHeight: 1.5, maxWidth: 960 }}>{lead}</Typography>}
      {tiles}
      <Box sx={{ display: "grid", gridTemplateColumns: aside ? { xs: "minmax(0, 1fr)", lg: `minmax(0, 1fr) ${asideWidth}px` } : "minmax(0, 1fr)", gap: 1.5, alignItems: "start" }}>
        <Box sx={{ display: "flex", flexDirection: "column", gap: 1.5, minWidth: 0 }}>{children}</Box>
        {aside && (
          <Box component="aside" sx={{ display: "flex", flexDirection: "column", gap: 1.5, minWidth: 0, position: { lg: "sticky" }, top: { lg: 0 } }}>
            {aside}
          </Box>
        )}
      </Box>
    </Box>
  );
}
