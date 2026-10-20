/**
 * ExistingFeeds — the networks that already run on the territory: the
 * public GTFS feeds serving it, most relevant first (in France the National
 * Access Point — the local network, then the département, the région,
 * the neighbours and the national operators with stops here — then the
 * Mobility Database), each with its validity and size.
 *
 * Two ways to use one, never presented as equals:
 *   Modify this network (primary)  the feed opened as it is in the
 *             application (every trip, variant, calendar exception and
 *             shape), changed with the Change Studio — the faithful path;
 *   Compare a redesign (secondary) the feed reverse-compiled into a
 *             SIMPLIFIED plan (one route per line and direction) to redesign
 *             it here and compare the scores. What it loses (`losses`) is
 *             shown first, and the plan loads only once confirmed; it is
 *             labelled "Simplified baseline — comparison only" everywhere.
 */

import React, { useCallback, useState } from "react";
import { Box, Button, CircularProgress, Link, Tooltip, Typography, alpha, useTheme } from "@mui/material";
import SearchIcon from "@mui/icons-material/Search";
import DirectionsBusFilledOutlinedIcon from "@mui/icons-material/DirectionsBusFilledOutlined";
import TrainOutlinedIcon from "@mui/icons-material/TrainOutlined";
import EditRoadOutlinedIcon from "@mui/icons-material/EditRoadOutlined";
import { useLanguage } from "../../contexts/LanguageContext";
import { fetchCatalog, importCatalogFeed, openCatalogFeed } from "../../utils/networkStudioApi";
import ErrorNotice from "../common/ErrorNotice";
import useElapsed from "../common/useElapsed";
import { QuietButton, SectionHeader, Tag, soft } from "./StudioUI";
import { feedDetail, feedTitle, isRailFeed, validityOf } from "./feedInfo";
import { BaselineTag, SimplifiedBaselineDialog } from "./SimplifiedBaseline";

const VISIBLE = 4;

export default function ExistingFeeds({ place, onImported, onOpened = null, disabled = false }) {
  const { t, language } = useLanguage();
  const theme = useTheme();
  const [state, setState] = useState({ status: "idle", feeds: [], sources: null, error: null }); // idle | loading | done | error
  const [busy, setBusy] = useState(null); // { url, action }
  const [imported, setImported] = useState(null); // feed
  const [pending, setPending] = useState(null); // { result, feed }: a simplified import awaiting confirmation
  const [expanded, setExpanded] = useState(false);
  const [error, setError] = useState(null); // { url, error, retry }
  const openSeconds = useElapsed(busy?.action === "open");

  const search = useCallback(async () => {
    setState({ status: "loading", feeds: [], sources: null, error: null });
    setError(null);
    try {
      const r = await fetchCatalog(place);
      setState({ status: "done", feeds: r.feeds || [], sources: r.sources || null, error: null });
    } catch (err) {
      setState({ status: "error", feeds: [], sources: null, error: err });
    }
  }, [place]);

  // The simplified import: fetched first, loaded only once its losses are accepted.
  const importFeed = async (feed) => {
    setBusy({ url: feed.url, action: "import" });
    setError(null);
    try {
      const r = await importCatalogFeed(feed.url, place);
      setPending({ result: r, feed });
    } catch (err) {
      setError({ url: feed.url, error: err, retry: () => importFeed(feed) });
    } finally {
      setBusy(null);
    }
  };
  const confirmImport = () => {
    if (!pending) return;
    onImported(pending.result, pending.feed);
    setImported(pending.feed);
    setPending(null);
  };

  const openFeed = async (feed) => {
    setBusy({ url: feed.url, action: "open" });
    setError(null);
    try {
      const r = await openCatalogFeed(feed.url, { name: feed.name || feed.provider, place });
      setPending(null);
      onOpened(r, feed);
    } catch (err) {
      setError({ url: feed.url, error: err, retry: () => openFeed(feed) });
    } finally {
      setBusy(null);
    }
  };

  const feeds = state.feeds;
  const shown = expanded ? feeds : feeds.slice(0, VISIBLE);
  const sources = state.sources ? [state.sources.pan?.ok ? t("feeds.pan") : null, state.sources.mdb?.ok ? t("feeds.mdb") : null].filter(Boolean) : [];

  return (
    <Box data-testid="existing-feeds" sx={{ pt: 1.25, borderTop: `1px solid ${theme.palette.divider}` }}>
      <SectionHeader label={t("feeds.section")} right={state.status === "done" && feeds.length > 0 && !imported ? <Typography sx={{ fontSize: "0.7rem", color: "text.secondary" }}>{feeds.length}</Typography> : null} />

      {imported ? (
        <Box data-testid="feeds-base" sx={{ mt: 0.5, display: "flex", flexDirection: "column", gap: 0.5 }}>
          <Box sx={{ display: "flex", alignItems: "center", gap: 0.75 }}>
            <Typography sx={{ flex: 1, minWidth: 0, fontSize: "0.78rem" }} noWrap title={feedTitle(imported)}>
              {t("feeds.base", { provider: feedTitle(imported) })}
            </Typography>
            <QuietButton onClick={() => setImported(null)} disabled={disabled}>
              {t("feeds.change")}
            </QuietButton>
          </Box>
          <BaselineTag />
          {onOpened && (
            <QuietButton startIcon={busy?.action === "open" ? <CircularProgress size={13} color="inherit" /> : <EditRoadOutlinedIcon sx={{ fontSize: "16px !important" }} />} onClick={() => openFeed(imported)} disabled={disabled || Boolean(busy)} data-testid="feeds-base-open-real" sx={{ alignSelf: "flex-start", ml: -1 }}>
              {t("feeds.openReal")}
            </QuietButton>
          )}
          {error && <ErrorNotice error={error.error} onRetry={error.retry} testid="feeds-error" />}
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
          {state.status === "error" && <ErrorNotice error={state.error} onRetry={search} testid="feeds-catalog-error" sx={{ mt: 0.5 }} />}
          {state.status === "done" && feeds.length === 0 && <Typography sx={{ mt: 0.5, fontSize: "0.72rem", color: "text.secondary" }}>{t("feeds.none")}</Typography>}
          {state.status === "done" && feeds.length > 0 && (
            <Box sx={{ mt: 0.25, display: "flex", flexDirection: "column" }}>
              {shown.map((f) => {
                const title = feedTitle(f);
                const Icon = isRailFeed(f) ? TrainOutlinedIcon : DirectionsBusFilledOutlinedIcon;
                const valid = validityOf(f, t, language);
                const detail = feedDetail(f, t, language);
                const isBusy = busy?.url === f.url;
                const failed = error?.url === f.url ? error : null;
                return (
                  <Box key={f.id || f.url} data-testid="feed-row" data-scope={f.scope || ""} data-status={f.status || ""} sx={{ display: "flex", alignItems: "flex-start", gap: 1, px: 1, py: 0.75, mx: -1, borderRadius: 1.5, transition: "background 120ms", "&:hover": { background: soft(theme) } }}>
                    <Box sx={{ width: 28, height: 28, mt: 0.25, flexShrink: 0, borderRadius: "8px", display: "flex", alignItems: "center", justifyContent: "center", color: "primary.main", background: alpha(theme.palette.primary.main, theme.palette.mode === "dark" ? 0.16 : 0.08) }}>
                      <Icon sx={{ fontSize: 16 }} />
                    </Box>
                    <Box sx={{ flex: 1, minWidth: 0 }}>
                      <Box sx={{ display: "flex", alignItems: "center", gap: 0.75, minWidth: 0 }}>
                        <Typography sx={{ fontSize: "0.8rem", fontWeight: 700, minWidth: 0 }} noWrap title={`${title}${f.provider && f.provider !== title ? ` — ${f.provider}` : ""}`}>
                          {title}
                        </Typography>
                        {f.scope && <Tag>{t(`feeds.scope.${f.scope}`)}</Tag>}
                      </Box>
                      {detail && (
                        <Typography sx={{ fontSize: "0.7rem", color: "text.secondary" }} noWrap title={detail}>
                          {detail}
                        </Typography>
                      )}
                      <Typography component="div" sx={{ fontSize: "0.68rem", color: "text.secondary" }} noWrap>
                        {valid && (
                          <Box component="span" data-testid="feed-validity" sx={{ color: valid.color, fontWeight: valid.expired ? 700 : 400 }}>
                            {valid.text}
                          </Box>
                        )}
                        {f.page_url || (f.license && /^https?:/.test(f.license)) ? (
                          <>
                            {valid ? " · " : ""}
                            <Link href={f.page_url || f.license} target="_blank" rel="noreferrer" underline="hover" color="inherit">
                              {f.page_url ? t("feeds.page") : t("feeds.license")}
                            </Link>
                          </>
                        ) : null}
                      </Typography>
                      {failed && <ErrorNotice error={failed.error} onRetry={failed.retry} testid="feeds-error" sx={{ mt: 0.5 }} />}
                      {/* The faithful path first; the simplified redesign is a secondary, explained choice. */}
                      <Box sx={{ display: "flex", alignItems: "center", flexWrap: "wrap", gap: 0.5, mt: 0.6, ml: -0.25 }}>
                        {onOpened && (
                          <Tooltip title={t("feeds.openHint")}>
                            <span>
                              <Button size="small" variant="contained" disableElevation disabled={disabled || Boolean(busy)} onClick={() => openFeed(f)} startIcon={isBusy && busy.action === "open" ? <CircularProgress size={12} color="inherit" /> : <EditRoadOutlinedIcon sx={{ fontSize: "15px !important" }} />} data-testid="feed-open" sx={{ textTransform: "none", fontWeight: 700, fontSize: "0.72rem", lineHeight: 1.3, py: 0.35, px: 1.1, borderRadius: 99, whiteSpace: "nowrap" }}>
                                {t("feeds.open")}
                              </Button>
                            </span>
                          </Tooltip>
                        )}
                        <Tooltip title={t("feeds.importHint")}>
                          <span>
                            <QuietButton disabled={disabled || Boolean(busy)} onClick={() => importFeed(f)} data-testid="feed-import" sx={{ color: onOpened ? "text.secondary" : undefined, fontSize: "0.72rem" }}>
                              {isBusy && busy.action === "import" ? <CircularProgress size={13} color="inherit" /> : t("feeds.import")}
                            </QuietButton>
                          </span>
                        </Tooltip>
                      </Box>
                      {isBusy && busy.action === "open" && (
                        <Typography sx={{ fontSize: "0.68rem", color: "text.secondary", mt: 0.25 }} data-testid="feed-opening">
                          {t("findNetwork.opening", { seconds: openSeconds })}
                        </Typography>
                      )}
                    </Box>
                  </Box>
                );
              })}
              {feeds.length > VISIBLE && (
                <QuietButton onClick={() => setExpanded((v) => !v)} data-testid="feeds-more" sx={{ alignSelf: "flex-start", ml: -1, color: "text.secondary" }}>
                  {expanded ? t("feeds.less") : t("feeds.more", { count: feeds.length - VISIBLE })}
                </QuietButton>
              )}
              {sources.length > 0 && (
                <Typography data-testid="feeds-sources" sx={{ mt: 0.25, fontSize: "0.64rem", color: "text.disabled" }}>
                  {t("feeds.sources", { sources: sources.join(" · ") })}
                </Typography>
              )}
            </Box>
          )}
        </>
      )}
      <SimplifiedBaselineDialog
        open={Boolean(pending)}
        mode="import"
        losses={pending?.result?.losses || null}
        feedName={pending ? feedTitle(pending.feed) : ""}
        busy={busy?.action === "open" ? "open" : null}
        error={pending && error?.url === pending.feed.url ? error.error : null}
        onConfirm={confirmImport}
        onOpenReal={onOpened && pending ? () => openFeed(pending.feed) : null}
        onClose={() => setPending(null)}
      />
    </Box>
  );
}
