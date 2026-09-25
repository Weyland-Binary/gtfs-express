/**
 * TerritoryPanel — the ground the network is designed on: type a town or an
 * area, the server assembles the public-data dossier (OpenStreetMap stops,
 * lines and trip generators, Wikidata population, holidays, timezone) and
 * the panel shows it as a few key figures, the generators by kind, the
 * coverage of the plan, and the existing network to start from. The map
 * layers live on the map; the sources sit behind an info button.
 */

import React, { useCallback, useState } from "react";
import { Box, CircularProgress, Collapse, IconButton, InputBase, Link, Popover, Tooltip, Typography, alpha, useTheme } from "@mui/material";
import SearchIcon from "@mui/icons-material/Search";
import InfoOutlinedIcon from "@mui/icons-material/InfoOutlined";
import ReportGmailerrorredOutlinedIcon from "@mui/icons-material/ReportGmailerrorredOutlined";
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
import RouteOutlinedIcon from "@mui/icons-material/RouteOutlined";
import AddLocationAltOutlinedIcon from "@mui/icons-material/AddLocationAltOutlined";
import AutoFixHighOutlinedIcon from "@mui/icons-material/AutoFixHighOutlined";
import ConstructionOutlinedIcon from "@mui/icons-material/ConstructionOutlined";
import ApartmentOutlinedIcon from "@mui/icons-material/ApartmentOutlined";
import TramOutlinedIcon from "@mui/icons-material/TramOutlined";
import AddRoadOutlinedIcon from "@mui/icons-material/AddRoadOutlined";
import { useLanguage } from "../../contexts/LanguageContext";
import { fetchTerritory } from "../../utils/networkStudioApi";
import ExistingFeeds from "./ExistingFeeds";
import { Meter, QuietButton, SectionHeader, Stat, compactNumber, soft } from "./StudioUI";

export const CATEGORY_ICON = { school: SchoolOutlinedIcon, college: SchoolOutlinedIcon, hospital: LocalHospitalOutlinedIcon, civic: AccountBalanceOutlinedIcon, market: StorefrontOutlinedIcon, station: TrainOutlinedIcon, leisure: StadiumOutlinedIcon, work: FactoryOutlinedIcon };
export const CATEGORY_COLOR = { school: "#F9A825", college: "#F57F17", hospital: "#D32F2F", civic: "#5E35B1", market: "#00897B", station: "#1E88E5", leisure: "#43A047", work: "#6D4C41" };
export const WORK_COLOR = "#EF6C00";
export const WORK_ICON = { development: ApartmentOutlinedIcon, transit: TramOutlinedIcon, rail: TrainOutlinedIcon, road: AddRoadOutlinedIcon, site: ConstructionOutlinedIcon };

// Localised short weekday name for "mon" … "sun" (1 January 2024 was a Monday).
const DAY_INDEX = { mon: 0, tue: 1, wed: 2, thu: 3, fri: 4, sat: 5, sun: 6 };
const dayName = (d, locale) => {
  try {
    return new Intl.DateTimeFormat(locale, { weekday: "short", timeZone: "UTC" }).format(new Date(Date.UTC(2024, 0, 1 + (DAY_INDEX[d] ?? 0))));
  } catch {
    return d;
  }
};

// Language name in the reader's language ("fr" → "français"), the code when unsupported.
const languageName = (code, locale) => {
  try {
    return new Intl.DisplayNames([locale], { type: "language" }).of(code) || code;
  } catch {
    return code;
  }
};

function Sources({ sources }) {
  const { t } = useLanguage();
  const [anchor, setAnchor] = useState(null);
  if (!sources?.length) return null;
  return (
    <>
      <Tooltip title={t("territory.sourcesTitle")}>
        <IconButton size="small" onClick={(e) => setAnchor(e.currentTarget)} aria-label={t("territory.sourcesTitle")} data-testid="territory-sources" sx={{ color: "text.secondary" }}>
          <InfoOutlinedIcon sx={{ fontSize: 17 }} />
        </IconButton>
      </Tooltip>
      <Popover open={Boolean(anchor)} anchorEl={anchor} onClose={() => setAnchor(null)} anchorOrigin={{ vertical: "bottom", horizontal: "right" }} transformOrigin={{ vertical: "top", horizontal: "right" }} slotProps={{ paper: { sx: { p: 1.5, maxWidth: 300, borderRadius: 2 } } }}>
        <Typography sx={{ fontSize: "0.72rem", fontWeight: 700, mb: 0.75 }}>{t("territory.sourcesTitle")}</Typography>
        {sources.map((s) => (
          <Box key={s.id} sx={{ fontSize: "0.74rem", lineHeight: 1.6 }}>
            <Link href={s.url} target="_blank" rel="noreferrer" underline="hover">
              {s.name}
            </Link>
            {s.license ? <Box component="span" sx={{ color: "text.secondary" }}>{` · ${s.license}`}</Box> : null}
          </Box>
        ))}
      </Popover>
    </>
  );
}

export default function TerritoryPanel({ territory, onTerritory, coverage, onUseExistingStops, onRefineStops = null, canRefine = false, refining = false, onImportedFeed = null, busy = false }) {
  const { t, language } = useLanguage();
  const theme = useTheme();
  const [query, setQuery] = useState(territory?.place?.query || "");
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState(null);
  const [open, setOpen] = useState(true);

  const run = useCallback(
    async (q, force = false) => {
      if (q.length < 2 || loading) return;
      setLoading(true);
      setError(null);
      try {
        const d = await fetchTerritory(q, force);
        onTerritory(d);
        setOpen(true);
      } catch (err) {
        setError(err.code === "PLACE_NOT_FOUND" ? t("territory.notFound") : err.message);
      } finally {
        setLoading(false);
      }
    },
    [loading, onTerritory, t],
  );
  const search = useCallback(() => run(query.trim()), [run, query]);

  const d = territory;
  const cats = d ? Object.entries(d.pois?.categories || {}).sort((a, b) => b[1] - a[1]) : [];
  const grid = d?.population_grid?.cells?.length ? d.population_grid : null;
  const hasNamedStops = Boolean(d && d.existing_stops.some((s) => s.name));
  const meta = d ? [d.timezone, d.population ? t("territory.population", { count: compactNumber(d.population.value, language) }) : null, d.stats?.density_per_km2 ? t("territory.density", { count: compactNumber(d.stats.density_per_km2, language) }) : null, d.elevation_m != null ? `${Math.round(d.elevation_m)} m` : null].filter(Boolean).join(" · ") : "";
  const c = d?.country;
  const countryLine = c ? [c.currency ? `${c.currency.code} ${c.currency.symbol && c.currency.symbol !== c.currency.code ? `(${c.currency.symbol})` : ""}`.trim() : null, c.weekend?.length ? t("territory.weekend", { days: c.weekend.map((x) => dayName(x, language)).join("–") }) : null, c.languages?.length ? c.languages.slice(0, 3).map((l) => languageName(l, language)).join(", ") : null, c.driving_side ? t(`territory.drives.${c.driving_side}`) : null].filter(Boolean).join(" · ") : "";
  const works = d?.works?.items?.length ? d.works : null;

  return (
    <Box data-testid="territory-panel" sx={{ px: 2, pt: 1.5, pb: 1.75 }}>
      <SectionHeader
        label={t("territory.section")}
        open={open}
        onToggle={d ? () => setOpen((v) => !v) : null}
        right={
          d && !open ? (
            <Typography sx={{ fontSize: "0.72rem", color: "text.secondary" }} noWrap>
              {d.place.name} · {t("territory.stops", { count: d.existing_stops.length })}
            </Typography>
          ) : null
        }
      />

      {/* Search */}
      <Box
        sx={{
          mt: 0.75,
          display: "flex",
          alignItems: "center",
          gap: 0.75,
          pl: 1.25,
          pr: 0.5,
          height: 40,
          borderRadius: "10px",
          background: soft(theme),
          border: "1px solid transparent",
          transition: "background 120ms, border-color 120ms, box-shadow 120ms",
          "&:hover": { background: soft(theme, 1.5) },
          "&:focus-within": { background: theme.palette.background.paper, borderColor: alpha(theme.palette.primary.main, 0.55), boxShadow: `0 0 0 3px ${alpha(theme.palette.primary.main, 0.12)}` },
        }}
      >
        <SearchIcon sx={{ fontSize: 18, color: "text.secondary" }} />
        <InputBase
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
          disabled={loading}
          inputProps={{ "data-testid": "territory-query", "aria-label": t("territory.placeholder") }}
          sx={{ fontSize: "0.86rem" }}
        />
        {loading ? (
          <CircularProgress size={16} sx={{ mx: 1, flexShrink: 0 }} />
        ) : (
          <QuietButton onClick={search} disabled={query.trim().length < 2} data-testid="territory-search" sx={{ flexShrink: 0 }}>
            {t("territory.analyzeShort")}
          </QuietButton>
        )}
      </Box>
      {loading && <Typography sx={{ mt: 0.75, fontSize: "0.72rem", color: "text.secondary" }}>{t("territory.loading")}</Typography>}
      {error && <Typography sx={{ mt: 0.75, fontSize: "0.74rem", color: "error.main" }}>{error}</Typography>}
      {!d && !error && !loading && <Typography sx={{ mt: 1, fontSize: "0.74rem", color: "text.secondary", lineHeight: 1.5 }}>{t("territory.hint")}</Typography>}

      {d && (
        <Collapse in={open}>
          <Box data-testid="territory-card" sx={{ mt: 1.5, display: "flex", flexDirection: "column", gap: 1.5 }}>
            {/* Identity */}
            <Box>
              <Box sx={{ display: "flex", alignItems: "center", gap: 0.75, minWidth: 0 }}>
                <Typography sx={{ fontSize: "1.02rem", fontWeight: 800, lineHeight: 1.2 }} noWrap title={d.place.display_name}>
                  {d.place.name}
                </Typography>
                {d.place.country && (
                  <Typography sx={{ fontSize: "0.8rem", color: "text.secondary" }} noWrap>
                    {d.place.country}
                  </Typography>
                )}
                <Box sx={{ flex: 1 }} />
                <Sources sources={d.sources} />
              </Box>
              {meta && <Typography sx={{ fontSize: "0.74rem", color: "text.secondary", mt: 0.25 }}>{meta}</Typography>}
              {countryLine && (
                <Tooltip title={c.gdp_per_capita_usd ? t("territory.countryHint", { gdp: compactNumber(c.gdp_per_capita_usd, language), urban: c.urban_pct ?? "—" }) : ""}>
                  <Typography data-testid="territory-country" sx={{ fontSize: "0.72rem", color: "text.secondary", mt: 0.25 }}>
                    {countryLine}
                  </Typography>
                </Tooltip>
              )}
            </Box>

            {/* Key figures */}
            <Box sx={{ display: "grid", gridTemplateColumns: "repeat(4, minmax(0, 1fr))", gap: 0.75 }}>
              <Stat icon={DirectionsBusFilledOutlinedIcon} value={compactNumber(d.existing_stops.length, language)} label={t("territory.stat.stops")} muted={!d.existing_stops.length} testid="territory-stat-stops" />
              <Stat icon={PlaceOutlinedIcon} value={compactNumber(d.pois.items.length, language)} label={t("territory.stat.pois")} muted={!d.pois.items.length} testid="territory-stat-pois" />
              {grid ? (
                <Stat icon={GroupsOutlinedIcon} value={`${compactNumber(grid.total, language)}${grid.estimated ? " ≈" : ""}`} label={t("territory.stat.residents")} hint={t("territory.layer.populationHint", { km2: grid.residential_km2 })} testid="territory-stat-residents" />
              ) : (
                <Stat icon={RouteOutlinedIcon} value={compactNumber(d.existing_lines.length, language)} label={t("territory.stat.lines")} muted={!d.existing_lines.length} testid="territory-stat-lines" />
              )}
              <Stat icon={EventOutlinedIcon} value={compactNumber(d.holidays.length, language)} label={t("territory.stat.holidays")} hint={d.school_holidays.length ? t("territory.schoolHolidays", { count: d.school_holidays.length }) : null} muted={!d.holidays.length} testid="territory-stat-holidays" />
            </Box>

            {/* Generators by kind */}
            {cats.length > 0 && (
              <Box sx={{ display: "flex", flexWrap: "wrap", columnGap: 1.5, rowGap: 0.5 }}>
                {cats.map(([c, n]) => {
                  const Icon = CATEGORY_ICON[c] || PlaceOutlinedIcon;
                  const label = `${t(`territory.category.${c}`)} ${n}`;
                  return (
                    <Tooltip key={c} title={t(`territory.category.${c}`)}>
                      <Box aria-label={label} sx={{ display: "inline-flex", alignItems: "center", gap: 0.4, fontSize: "0.74rem", color: "text.secondary", fontVariantNumeric: "tabular-nums" }}>
                        <Icon sx={{ fontSize: 15, color: CATEGORY_COLOR[c] || "text.secondary" }} />
                        {n}
                      </Box>
                    </Tooltip>
                  );
                })}
              </Box>
            )}

            {/* Works and projects: where the territory is changing */}
            {works && (
              <Box data-testid="territory-works" sx={{ display: "flex", alignItems: "center", flexWrap: "wrap", columnGap: 1.5, rowGap: 0.5 }}>
                <Typography sx={{ fontSize: "0.74rem", fontWeight: 700, display: "inline-flex", alignItems: "center", gap: 0.5 }}>
                  <ConstructionOutlinedIcon sx={{ fontSize: 15, color: WORK_COLOR }} />
                  {t("territory.works", { count: works.items.length })}
                </Typography>
                {Object.entries(works.counts || {}).map(([k, n]) => {
                  const Icon = WORK_ICON[k] || ConstructionOutlinedIcon;
                  const top = works.items.filter((w) => w.kind === k && w.name).slice(0, 4).map((w) => w.name);
                  return (
                    <Tooltip key={k} title={`${t(`territory.work.${k}`)}${top.length ? ` — ${top.join(", ")}` : ""}`}>
                      <Box aria-label={`${t(`territory.work.${k}`)} ${n}`} sx={{ display: "inline-flex", alignItems: "center", gap: 0.4, fontSize: "0.74rem", color: "text.secondary", fontVariantNumeric: "tabular-nums" }}>
                        <Icon sx={{ fontSize: 15, color: WORK_COLOR }} />
                        {n}
                      </Box>
                    </Tooltip>
                  );
                })}
              </Box>
            )}

            {/* Partial dossier */}
            {d.warnings.length > 0 && (
              <Box sx={{ display: "flex", alignItems: "center", gap: 0.75, pl: 1, pr: 0.25, py: 0.4, borderRadius: 1.5, background: alpha(theme.palette.warning.main, theme.palette.mode === "dark" ? 0.14 : 0.1) }}>
                <ReportGmailerrorredOutlinedIcon sx={{ fontSize: 16, color: "warning.main" }} />
                <Typography sx={{ flex: 1, fontSize: "0.72rem", color: "text.primary" }}>{t("territory.partial", { count: d.warnings.length })}</Typography>
                <QuietButton onClick={() => run(d.place.query, true)} disabled={loading} data-testid="territory-retry" sx={{ color: "warning.dark" }}>
                  {t("territory.retry")}
                </QuietButton>
              </Box>
            )}

            {/* Coverage of the plan */}
            {coverage && (coverage.pois_total > 0 || coverage.population) && (
              <Box data-testid="territory-coverage" sx={{ display: "flex", flexDirection: "column", gap: 0.6 }}>
                <Typography sx={{ fontSize: "0.74rem", fontWeight: 700 }}>{t("territory.coverageTitle")}</Typography>
                {coverage.pois_total > 0 && <Meter label={t("territory.coveragePlaces")} pct={coverage.coverage_pct} />}
                {coverage.population && coverage.population.pct != null && <Meter label={t("territory.coverageResidentsShort")} pct={coverage.population.pct} />}
                <Typography sx={{ fontSize: "0.7rem", color: "text.secondary" }}>
                  {t("territory.reused", { reused: coverage.existing_stops_reused, total: coverage.stops_planned })}
                  {coverage.top_missed?.length ? ` · ${t("territory.missed", { name: coverage.top_missed[0].name })}` : ""}
                </Typography>
              </Box>
            )}

            {/* Actions on the plan */}
            {hasNamedStops && (
              <Box sx={{ display: "flex", flexWrap: "wrap", gap: 0.25, ml: -1 }}>
                <QuietButton startIcon={<AddLocationAltOutlinedIcon sx={{ fontSize: "16px !important" }} />} onClick={() => onUseExistingStops(d)} data-testid="territory-use-stops">
                  {t("territory.useStops")}
                </QuietButton>
                {onRefineStops && canRefine && (
                  <Tooltip title={t("network.refineStopsHint")}>
                    <span>
                      <QuietButton startIcon={refining ? <CircularProgress size={13} color="inherit" /> : <AutoFixHighOutlinedIcon sx={{ fontSize: "16px !important" }} />} disabled={refining} onClick={onRefineStops} data-testid="territory-refine">
                        {t("network.refineStops")}
                      </QuietButton>
                    </span>
                  </Tooltip>
                )}
              </Box>
            )}

            {onImportedFeed && <ExistingFeeds key={d.place.query} place={d.place.query} onImported={onImportedFeed} disabled={busy} />}
          </Box>
        </Collapse>
      )}
    </Box>
  );
}
