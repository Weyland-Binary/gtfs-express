/**
 * ExistingFeeds — the network that already runs: the public GTFS feeds of
 * the Mobility Database catalog covering the territory (the most relevant
 * first), and one click to load one as the plan's baseline (reverse-compiled:
 * lines with their dominant stop sequence, stops, calendars, departures)
 * with its design score, so the assistant improves rather than reinvents.
 * Once a baseline is loaded the list folds into one line.
 */

import React, { useCallback, useState } from "react";
import { Box, CircularProgress, Link, Tooltip, Typography, alpha, useTheme } from "@mui/material";
import SearchIcon from "@mui/icons-material/Search";
import DirectionsBusFilledOutlinedIcon from "@mui/icons-material/DirectionsBusFilledOutlined";
import CheckCircleRoundedIcon from "@mui/icons-material/CheckCircleRounded";
import { useLanguage } from "../../contexts/LanguageContext";
import { fetchCatalog, importCatalogFeed } from "../../utils/networkStudioApi";
import { QuietButton, SectionHeader, Tag, soft } from "./StudioUI";

const VISIBLE = 3;

const isLocal = (f) => (f.scope ? f.scope === "local" : Boolean(f.covers_centre));

export default function ExistingFeeds({ place, onImported, disabled = false }) {
  const { t } = useLanguage();
  const theme = useTheme();
  const [state, setState] = useState({ status: "idle", feeds: [] }); // idle | loading | done | error
  const [importing, setImporting] = useState(null); // url
  const [imported, setImported] = useState(null); // feed
  const [expanded, setExpanded] = useState(false);
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
      setImported(feed);
    } catch (err) {
      setError(err.message);
    } finally {
      setImporting(null);
    }
  };

  const feeds = state.feeds;
  const shown = expanded ? feeds : feeds.slice(0, VISIBLE);

  return (
    <Box data-testid="existing-feeds" sx={{ pt: 1.25, borderTop: `1px solid ${theme.palette.divider}` }}>
      <SectionHeader label={t("feeds.section")} right={state.status === "done" && feeds.length > 0 && !imported ? <Typography sx={{ fontSize: "0.7rem", color: "text.secondary" }}>{feeds.length}</Typography> : null} />

      {imported ? (
        <Box data-testid="feeds-base" sx={{ display: "flex", alignItems: "center", gap: 0.75, mt: 0.5 }}>
          <CheckCircleRoundedIcon sx={{ fontSize: 16, color: "success.main" }} />
          <Typography sx={{ flex: 1, minWidth: 0, fontSize: "0.78rem" }} noWrap title={imported.provider}>
            {t("feeds.base", { provider: imported.provider })}
          </Typography>
          <QuietButton onClick={() => setImported(null)} disabled={disabled}>
            {t("feeds.change")}
          </QuietButton>
        </Box>
      ) : (
        <>
          {state.status === "idle" && (
            <QuietButton startIcon={<SearchIcon sx={{ fontSize: "16px !important" }} />} onClick={search} disabled={disabled} data-testid="feeds-search" sx={{ ml: -1, mt: 0.25 }}>
              {t("feeds.search")}
            </QuietButton>
          )}
          {state.status === "loading" && (
            <Typography sx={{ mt: 0.5, fontSize: "0.72rem", color: "text.secondary", display: "flex", alignItems: "center", gap: 0.75 }}>
              <CircularProgress size={12} /> {t("feeds.loading")}
            </Typography>
          )}
          {state.status === "error" && <Typography sx={{ mt: 0.5, fontSize: "0.72rem", color: "text.secondary" }}>{t("feeds.unavailable")}</Typography>}
          {state.status === "done" && feeds.length === 0 && <Typography sx={{ mt: 0.5, fontSize: "0.72rem", color: "text.secondary" }}>{t("feeds.none")}</Typography>}
          {state.status === "done" && feeds.length > 0 && (
            <Box sx={{ mt: 0.25, display: "flex", flexDirection: "column" }}>
              {shown.map((f) => (
                <Box key={f.id || f.url} data-testid="feed-row" sx={{ display: "flex", alignItems: "center", gap: 1, px: 1, py: 0.75, mx: -1, borderRadius: 1.5, transition: "background 120ms", "&:hover": { background: soft(theme) } }}>
                  <Box sx={{ width: 28, height: 28, flexShrink: 0, borderRadius: "8px", display: "flex", alignItems: "center", justifyContent: "center", color: "primary.main", background: alpha(theme.palette.primary.main, theme.palette.mode === "dark" ? 0.16 : 0.08) }}>
                    <DirectionsBusFilledOutlinedIcon sx={{ fontSize: 16 }} />
                  </Box>
                  <Box sx={{ flex: 1, minWidth: 0 }}>
                    <Box sx={{ display: "flex", alignItems: "center", gap: 0.75, minWidth: 0 }}>
                      <Typography sx={{ fontSize: "0.8rem", fontWeight: 700, minWidth: 0 }} noWrap title={`${f.provider}${f.name ? ` — ${f.name}` : ""}`}>
                        {f.provider}
                      </Typography>
                      {isLocal(f) && <Tag>{t("feeds.local")}</Tag>}
                    </Box>
                    <Typography sx={{ fontSize: "0.7rem", color: "text.secondary" }} noWrap>
                      {[f.name, f.municipality || f.region].filter(Boolean).join(" · ")}
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
                  <Tooltip title={t("feeds.importHint")}>
                    <span>
                      <QuietButton disabled={disabled || Boolean(importing)} onClick={() => importFeed(f)} data-testid="feed-import">
                        {importing === f.url ? <CircularProgress size={13} color="inherit" /> : t("feeds.import")}
                      </QuietButton>
                    </span>
                  </Tooltip>
                </Box>
              ))}
              {feeds.length > VISIBLE && (
                <QuietButton onClick={() => setExpanded((v) => !v)} data-testid="feeds-more" sx={{ alignSelf: "flex-start", ml: -1, color: "text.secondary" }}>
                  {expanded ? t("feeds.less") : t("feeds.more", { count: feeds.length - VISIBLE })}
                </QuietButton>
              )}
            </Box>
          )}
          {error && <Typography sx={{ mt: 0.5, fontSize: "0.72rem", color: "error.main" }}>{error}</Typography>}
        </>
      )}
    </Box>
  );
}
