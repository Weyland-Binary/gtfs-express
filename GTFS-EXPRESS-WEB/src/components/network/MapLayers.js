/**
 * MapLayers — the territory's layers, where they belong: a small floating
 * control on the map (existing stops, places to serve, residents), each
 * with its count and a dot in the colour it has on the map.
 */

import React from "react";
import { Box, ButtonBase, Typography, alpha, useTheme } from "@mui/material";
import { useLanguage } from "../../contexts/LanguageContext";
import { compactNumber, soft } from "./StudioUI";

export default function MapLayers({ territory, layers, onToggle }) {
  const { t, language } = useLanguage();
  const theme = useTheme();
  if (!territory) return null;
  const isDark = theme.palette.mode === "dark";
  const items = [
    { key: "stops", label: t("network.layers.stops"), count: territory.existing_stops.length, color: isDark ? "#cbd5e1" : "#475569" },
    { key: "pois", label: t("network.layers.pois"), count: territory.pois.items.length, color: "#F9A825" },
    ...(territory.population_grid?.cells?.length ? [{ key: "population", label: t("network.layers.population"), count: territory.population_grid.total, color: isDark ? "#fbbf24" : "#7c3aed" }] : []),
  ];
  return (
    <Box data-testid="map-layers" sx={{ position: "absolute", top: 12, right: 12, zIndex: 1000, minWidth: 190, p: 0.5, borderRadius: "12px", background: alpha(theme.palette.background.paper, 0.94), backdropFilter: "blur(8px)", boxShadow: isDark ? "0 8px 24px rgba(0,0,0,0.45)" : "0 8px 24px rgba(15,23,42,0.12)" }}>
      <Typography sx={{ px: 1, pt: 0.5, pb: 0.25, fontSize: "0.64rem", fontWeight: 700, letterSpacing: "0.06em", textTransform: "uppercase", color: "text.secondary" }}>{t("network.layers.title")}</Typography>
      {items.map((it) => {
        const on = Boolean(layers[it.key]);
        return (
          <ButtonBase
            key={it.key}
            onClick={() => onToggle(it.key)}
            aria-pressed={on}
            data-testid={`territory-layer-${it.key}`}
            sx={{ width: "100%", justifyContent: "flex-start", gap: 1, px: 1, py: 0.6, borderRadius: 1.5, fontSize: "0.76rem", fontWeight: 600, color: on ? "text.primary" : "text.disabled", transition: "background 120ms", "&:hover": { background: soft(theme) } }}
          >
            <Box sx={{ width: 10, height: 10, borderRadius: "50%", flexShrink: 0, boxSizing: "border-box", border: `2px solid ${it.color}`, background: on ? it.color : "transparent", opacity: on ? 1 : 0.6 }} />
            <Box component="span" sx={{ flex: 1, textAlign: "left" }}>
              {it.label}
            </Box>
            <Box component="span" sx={{ fontWeight: 500, color: "text.secondary", fontVariantNumeric: "tabular-nums" }}>
              {it.count ? compactNumber(it.count, language) : "—"}
            </Box>
          </ButtonBase>
        );
      })}
    </Box>
  );
}
