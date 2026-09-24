/**
 * TerritoryPanel — the ground the network is designed on: type a town or an
 * area, the server assembles the public-data dossier (OpenStreetMap stops,
 * lines and trip generators, Wikidata population, holidays, timezone) and
 * the studio shows it as facts, map layers and a coverage score. Every
 * source is attributed.
 */

import React, { useCallback, useState } from "react";
import { Box, Button, Chip, CircularProgress, Collapse, IconButton, Link, TextField, Tooltip, Typography, alpha, useTheme } from "@mui/material";
import PublicIcon from "@mui/icons-material/Public";
import SearchIcon from "@mui/icons-material/Search";
import ExpandMoreIcon from "@mui/icons-material/ExpandMore";
import DirectionsBusFilledOutlinedIcon from "@mui/icons-material/DirectionsBusFilledOutlined";
import PlaceOutlinedIcon from "@mui/icons-material/PlaceOutlined";
import SchoolOutlinedIcon from "@mui/icons-material/SchoolOutlined";
import LocalHospitalOutlinedIcon from "@mui/icons-material/LocalHospitalOutlined";
import StorefrontOutlinedIcon from "@mui/icons-material/StorefrontOutlined";
import TrainOutlinedIcon from "@mui/icons-material/TrainOutlined";
import StadiumOutlinedIcon from "@mui/icons-material/StadiumOutlined";
import FactoryOutlinedIcon from "@mui/icons-material/FactoryOutlined";
import AccountBalanceOutlinedIcon from "@mui/icons-material/AccountBalanceOutlined";
import EventOutlinedIcon from "@mui/icons-material/EventOutlined";
import GroupsOutlinedIcon from "@mui/icons-material/GroupsOutlined";
import { useLanguage } from "../../contexts/LanguageContext";
import { fetchTerritory } from "../../utils/networkStudioApi";
import ExistingFeeds from "./ExistingFeeds";

export const CATEGORY_ICON = { school: SchoolOutlinedIcon, college: SchoolOutlinedIcon, hospital: LocalHospitalOutlinedIcon, civic: AccountBalanceOutlinedIcon, market: StorefrontOutlinedIcon, station: TrainOutlinedIcon, leisure: StadiumOutlinedIcon, work: FactoryOutlinedIcon };
export const CATEGORY_COLOR = { school: "#F9A825", college: "#F57F17", hospital: "#D32F2F", civic: "#5E35B1", market: "#00897B", station: "#1E88E5", leisure: "#43A047", work: "#6D4C41" };

const fmtNumber = (n) => (typeof n === "number" ? n.toLocaleString() : "—");

export default function TerritoryPanel({ territory, onTerritory, layers, onToggleLayer, coverage, onUseExistingStops, onRefineStops = null, canRefine = false, refining = false, onImportedFeed = null, busy = false }) {
  const { t } = useLanguage();
  const theme = useTheme();
  const [query, setQuery] = useState(territory?.place?.query || "");
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState(null);
  const [open, setOpen] = useState(true);

  const search = useCallback(async () => {
    const q = query.trim();
    if (q.length < 2 || loading) return;
    setLoading(true);
    setError(null);
    try {
      const d = await fetchTerritory(q);
      onTerritory(d);
      setOpen(true);
    } catch (err) {
      setError(err.code === "PLACE_NOT_FOUND" ? t("territory.notFound") : err.message);
    } finally {
      setLoading(false);
    }
  }, [query, loading, onTerritory, t]);

  const d = territory;
  const cats = d ? Object.entries(d.pois?.categories || {}).sort((a, b) => b[1] - a[1]) : [];

  return (
    <Box data-testid="territory-panel" sx={{ borderBottom: `1px solid ${alpha(theme.palette.divider, 1)}`, background: alpha(theme.palette.info.main, 0.03) }}>
      <Box sx={{ display: "flex", alignItems: "center", gap: 1, px: 1.5, pt: 1.25, pb: d ? 0.5 : 1.25 }}>
        <PublicIcon sx={{ fontSize: 18, color: theme.palette.info.main }} />
        <TextField
          size="small"
          fullWidth
          placeholder={t("territory.placeholder")}
          value={query}
          onChange={(e) => setQuery(e.target.value.slice(0, 200))}
          onKeyDown={(e) => {
            if (e.key === "Enter") {
              e.preventDefault();
              search();
            }
          }}
          inputProps={{ "data-testid": "territory-query" }}
          disabled={loading}
        />
        <Button size="small" variant={d ? "outlined" : "contained"} disableElevation onClick={search} disabled={loading || query.trim().length < 2} startIcon={loading ? <CircularProgress size={12} color="inherit" /> : <SearchIcon sx={{ fontSize: 16 }} />} data-testid="territory-search" sx={{ textTransform: "none", fontWeight: 700, whiteSpace: "nowrap", flexShrink: 0 }}>
          {loading ? t("territory.loading") : t("territory.analyze")}
        </Button>
        {d && (
          <IconButton size="small" onClick={() => setOpen((v) => !v)} aria-label={t("territory.toggle")}>
            <ExpandMoreIcon sx={{ fontSize: 18, transform: open ? "rotate(180deg)" : "none", transition: "transform 160ms" }} />
          </IconButton>
        )}
      </Box>
      {error && <Typography sx={{ px: 1.5, pb: 1, fontSize: "0.74rem", color: "error.main" }}>{error}</Typography>}
      {!d && !error && !loading && <Typography sx={{ px: 1.5, pb: 1.25, fontSize: "0.72rem", color: "text.secondary", lineHeight: 1.45 }}>{t("territory.hint")}</Typography>}
      {d && (
        <Collapse in={open}>
          <Box sx={{ px: 1.5, pb: 1.25, display: "flex", flexDirection: "column", gap: 0.75 }} data-testid="territory-card">
            <Box>
              <Typography sx={{ fontSize: "0.84rem", fontWeight: 800, lineHeight: 1.2 }} noWrap title={d.place.display_name}>
                {d.place.name}
                {d.place.country ? <Box component="span" sx={{ fontWeight: 500, color: "text.secondary" }}>{` · ${d.place.country}`}</Box> : null}
              </Typography>
              <Typography sx={{ fontSize: "0.7rem", color: "text.secondary" }}>
                {d.timezone || "—"}
                {d.population ? ` · ${t("territory.population", { count: fmtNumber(d.population.value) })}` : ""}
                {d.elevation_m != null ? ` · ${Math.round(d.elevation_m)} m` : ""}
              </Typography>
            </Box>
            <Box sx={{ display: "flex", flexWrap: "wrap", gap: 0.5 }}>
              <Tooltip title={t("territory.layer.stopsHint")}>
                <Chip size="small" icon={<DirectionsBusFilledOutlinedIcon sx={{ fontSize: 14 }} />} label={t("territory.stops", { count: d.existing_stops.length })} color={layers.stops ? "primary" : "default"} variant={layers.stops ? "filled" : "outlined"} onClick={() => onToggleLayer("stops")} data-testid="territory-layer-stops" sx={{ height: 22, fontSize: "0.66rem", fontWeight: 700 }} />
              </Tooltip>
              <Tooltip title={t("territory.layer.poisHint")}>
                <Chip size="small" icon={<PlaceOutlinedIcon sx={{ fontSize: 14 }} />} label={t("territory.pois", { count: d.pois.items.length })} color={layers.pois ? "primary" : "default"} variant={layers.pois ? "filled" : "outlined"} onClick={() => onToggleLayer("pois")} data-testid="territory-layer-pois" sx={{ height: 22, fontSize: "0.66rem", fontWeight: 700 }} />
              </Tooltip>
              {d.population_grid?.cells?.length > 0 && (
                <Tooltip title={t("territory.layer.populationHint", { km2: d.population_grid.residential_km2 })}>
                  <Chip size="small" icon={<GroupsOutlinedIcon sx={{ fontSize: 14 }} />} label={`${t("territory.residents", { count: fmtNumber(d.population_grid.total) })}${d.population_grid.estimated ? " ≈" : ""}`} color={layers.population ? "primary" : "default"} variant={layers.population ? "filled" : "outlined"} onClick={() => onToggleLayer("population")} data-testid="territory-layer-population" sx={{ height: 22, fontSize: "0.66rem", fontWeight: 700 }} />
                </Tooltip>
              )}
              {d.existing_lines.length > 0 && <Chip size="small" label={t("territory.lines", { count: d.existing_lines.length })} variant="outlined" sx={{ height: 22, fontSize: "0.66rem" }} />}
              {d.holidays.length > 0 && <Chip size="small" icon={<EventOutlinedIcon sx={{ fontSize: 14 }} />} label={t("territory.holidays", { count: d.holidays.length })} variant="outlined" sx={{ height: 22, fontSize: "0.66rem" }} />}
              {d.school_holidays.length > 0 && <Chip size="small" icon={<SchoolOutlinedIcon sx={{ fontSize: 14 }} />} label={t("territory.schoolHolidays", { count: d.school_holidays.length })} variant="outlined" sx={{ height: 22, fontSize: "0.66rem" }} />}
            </Box>
            {cats.length > 0 && (
              <Box sx={{ display: "flex", flexWrap: "wrap", gap: 0.4 }}>
                {cats.map(([c, n]) => {
                  const Icon = CATEGORY_ICON[c] || PlaceOutlinedIcon;
                  return <Chip key={c} size="small" icon={<Icon sx={{ fontSize: 13, color: `${CATEGORY_COLOR[c]} !important` }} />} label={`${t(`territory.category.${c}`)} ${n}`} sx={{ height: 20, fontSize: "0.62rem", background: alpha(CATEGORY_COLOR[c] || theme.palette.text.secondary, 0.08) }} />;
                })}
              </Box>
            )}
            {coverage && (coverage.pois_total > 0 || coverage.population) && (
              <Box data-testid="territory-coverage" sx={{ display: "flex", alignItems: "center", gap: 1, px: 1, py: 0.6, borderRadius: 1.5, background: alpha(theme.palette.success.main, 0.06), border: `1px solid ${alpha(theme.palette.success.main, 0.3)}` }}>
                <GroupsOutlinedIcon sx={{ fontSize: 16, color: theme.palette.success.main }} />
                <Box sx={{ flex: 1, minWidth: 0 }}>
                  <Typography sx={{ fontSize: "0.74rem", fontWeight: 700 }}>
                    {t("territory.coverage", { pct: coverage.coverage_pct ?? 0, covered: coverage.pois_covered, total: coverage.pois_total })}
                    {coverage.population && coverage.population.pct != null ? ` · ${t("territory.coverageResidents", { pct: coverage.population.pct })}` : ""}
                  </Typography>
                  <Typography sx={{ fontSize: "0.68rem", color: "text.secondary" }} noWrap>
                    {t("territory.reused", { reused: coverage.existing_stops_reused, total: coverage.stops_planned })}
                    {coverage.top_missed?.length ? ` · ${t("territory.missed", { name: coverage.top_missed[0].name })}` : ""}
                  </Typography>
                </Box>
              </Box>
            )}
            <Box sx={{ display: "flex", alignItems: "center", gap: 1, flexWrap: "wrap" }}>
              {d.existing_stops.some((s) => s.name) && (
                <Button size="small" variant="outlined" onClick={() => onUseExistingStops(d)} data-testid="territory-use-stops" sx={{ textTransform: "none", fontWeight: 600 }}>
                  {t("territory.useStops")}
                </Button>
              )}
              {onRefineStops && canRefine && d.existing_stops.some((s) => s.name) && (
                <Tooltip title={t("network.refineStopsHint")}>
                  <span>
                    <Button size="small" variant="outlined" color="secondary" disabled={refining} onClick={onRefineStops} startIcon={refining ? <CircularProgress size={12} color="inherit" /> : null} data-testid="territory-refine" sx={{ textTransform: "none", fontWeight: 600 }}>
                      {t("network.refineStops")}
                    </Button>
                  </span>
                </Tooltip>
              )}
              <Typography sx={{ fontSize: "0.62rem", color: "text.disabled", flex: 1 }}>
                {t("territory.sources")}{" "}
                {d.sources.map((s, i) => (
                  <React.Fragment key={s.id}>
                    {i > 0 ? ", " : ""}
                    <Link href={s.url} target="_blank" rel="noreferrer" underline="hover" color="inherit">
                      {s.name}
                    </Link>
                  </React.Fragment>
                ))}
              </Typography>
            </Box>
            {onImportedFeed && <ExistingFeeds key={d.place.query} place={d.place.query} onImported={onImportedFeed} disabled={busy} />}
            {d.warnings.length > 0 && <Typography sx={{ fontSize: "0.66rem", color: "warning.dark" }}>{t("territory.partial", { count: d.warnings.length })}</Typography>}
          </Box>
        </Collapse>
      )}
    </Box>
  );
}
