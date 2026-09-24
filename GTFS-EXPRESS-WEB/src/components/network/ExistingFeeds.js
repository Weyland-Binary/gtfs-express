/**
 * ExistingFeeds — the network that already runs: the public GTFS feeds of
 * the Mobility Database catalog covering the territory, and one click to
 * load the most relevant one as the plan's baseline (reverse-compiled:
 * lines with their dominant stop sequence, stops, calendars, departures)
 * with its design score, so the assistant improves rather than reinvents.
 */

import React, { useCallback, useState } from "react";
import { Box, Button, Chip, CircularProgress, Link, Tooltip, Typography, alpha, useTheme } from "@mui/material";
import CloudDownloadOutlinedIcon from "@mui/icons-material/CloudDownloadOutlined";
import SearchIcon from "@mui/icons-material/Search";
import { useLanguage } from "../../contexts/LanguageContext";
import { fetchCatalog, importCatalogFeed } from "../../utils/networkStudioApi";

export default function ExistingFeeds({ place, onImported, disabled = false }) {
  const { t } = useLanguage();
  const theme = useTheme();
  const [state, setState] = useState({ status: "idle", feeds: [] }); // idle | loading | done | error
  const [importing, setImporting] = useState(null); // url
  const [error, setError] = useState(null);

  const search = useCallback(async () => {
    setState({ status: "loading", feeds: [] });
    setError(null);
    try {
      const r = await fetchCatalog(place);
      setState({ status: "done", feeds: r.feeds || [] });
    } catch (err) {
      setState({ status: "error", feeds: [], error: err.message });
    }
  }, [place]);

  const importFeed = async (feed) => {
    setImporting(feed.url);
    setError(null);
    try {
      const r = await importCatalogFeed(feed.url, place);
      onImported(r, feed);
    } catch (err) {
      setError(err.message);
    } finally {
      setImporting(null);
    }
  };

  return (
    <Box data-testid="existing-feeds" sx={{ display: "flex", flexDirection: "column", gap: 0.6 }}>
      {state.status === "idle" && (
        <Button size="small" variant="text" startIcon={<SearchIcon sx={{ fontSize: 15 }} />} onClick={search} disabled={disabled} data-testid="feeds-search" sx={{ alignSelf: "flex-start", textTransform: "none", fontWeight: 600, px: 0.5 }}>
          {t("feeds.search")}
        </Button>
      )}
      {state.status === "loading" && (
        <Typography sx={{ fontSize: "0.72rem", color: "text.secondary", display: "flex", alignItems: "center", gap: 0.6 }}>
          <CircularProgress size={12} /> {t("feeds.loading")}
        </Typography>
      )}
      {state.status === "error" && <Typography sx={{ fontSize: "0.72rem", color: "warning.dark" }}>{t("feeds.unavailable")}</Typography>}
      {state.status === "done" && state.feeds.length === 0 && <Typography sx={{ fontSize: "0.72rem", color: "text.secondary" }}>{t("feeds.none")}</Typography>}
      {state.status === "done" && state.feeds.length > 0 && (
        <Box sx={{ display: "flex", flexDirection: "column", gap: 0.4 }}>
          <Typography sx={{ fontSize: "0.7rem", fontWeight: 700, color: "text.secondary", textTransform: "uppercase", letterSpacing: 0.3 }}>{t("feeds.title", { count: state.feeds.length })}</Typography>
          {state.feeds.slice(0, 5).map((f) => (
            <Box key={f.id || f.url} data-testid="feed-row" sx={{ display: "flex", alignItems: "center", gap: 0.75, px: 1, py: 0.5, borderRadius: 1.5, border: `1px solid ${alpha(theme.palette.divider, 1)}`, background: f.covers_centre ? alpha(theme.palette.primary.main, 0.04) : "transparent" }}>
              <Box sx={{ flex: 1, minWidth: 0 }}>
                <Typography sx={{ fontSize: "0.74rem", fontWeight: 700 }} noWrap title={`${f.provider}${f.name ? ` — ${f.name}` : ""}`}>
                  {f.provider}
                  {f.name ? <span style={{ fontWeight: 400, color: theme.palette.text.secondary }}>{` — ${f.name}`}</span> : null}
                </Typography>
                <Typography sx={{ fontSize: "0.64rem", color: "text.secondary" }} noWrap>
                  {[f.municipality || f.region, f.country].filter(Boolean).join(", ")}
                  {f.license ? (
                    <>
                      {" · "}
                      <Link href={f.license} target="_blank" rel="noreferrer" underline="hover" color="inherit">
                        {t("feeds.license")}
                      </Link>
                    </>
                  ) : null}
                </Typography>
              </Box>
              {f.covers_centre && <Chip size="small" label={t("feeds.local")} color="primary" variant="outlined" sx={{ height: 18, fontSize: "0.6rem" }} />}
              <Tooltip title={t("feeds.importHint")}>
                <span>
                  <Button size="small" variant="outlined" disabled={disabled || Boolean(importing)} onClick={() => importFeed(f)} startIcon={importing === f.url ? <CircularProgress size={12} color="inherit" /> : <CloudDownloadOutlinedIcon sx={{ fontSize: 14 }} />} data-testid="feed-import" sx={{ textTransform: "none", fontWeight: 600, whiteSpace: "nowrap", flexShrink: 0 }}>
                    {importing === f.url ? t("feeds.importing") : t("feeds.import")}
                  </Button>
                </span>
              </Tooltip>
            </Box>
          ))}
          {error && <Typography sx={{ fontSize: "0.72rem", color: "error.main" }}>{error}</Typography>}
        </Box>
      )}
    </Box>
  );
}
