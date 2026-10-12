/**
 * FindNetworkPanel — ① of a project that modifies a network, before any
 * network is open (target design §5 B1; Lot H, 2026-10-05): one question,
 * « Quel réseau voulez-vous faire évoluer ? », asked in the middle of the
 * page. The brief comes right after, beside the open network (one decision
 * at a time).
 *
 *   the search        a town: the published GTFS feeds covering it, straight
 *                     from the catalogues (GET /network/catalog?place=…&light=1
 *                     — the place alone, no territory dossier, so it answers
 *                     in seconds); the last places searched in this browser
 *                     come back as chips (`find-network-recent`), a click
 *                     searching again
 *   the networks      one card each (`find-network-row`): its scope,
 *                     provider, size and validity (an expired feed is
 *                     flagged); « Choisir ce réseau » (`find-network-open`)
 *                     opens the feed AS IT IS (POST /network/catalog/open:
 *                     every trip, variant and calendar exception kept): it
 *                     becomes the project's reference v0, frozen as a zip
 *                     with the project so that « Reprendre » never downloads
 *                     it again (D46)
 *   the person's file a drop zone (`find-network-upload`): a GTFS zip dropped
 *                     on it (`onDropFile`) or chosen from the disk
 *                     (`onUploadInstead`, the app's file picker)
 *   the way           the four steps of the journey, one line each, under
 *                     the rest (`journey-how`)
 *
 * Home hosts it too (2026-10-08: modifying a network is what people come
 * for): its question is then the page's first heading (`headingLevel`
 * "h1"), the field never takes the focus by itself (the skip link comes
 * first), and a network chosen or dropped there opens a new modify project. On Home it is a card beside the
 * explorer (`layout` "card", 2026-10-08): its words aligned on the left, the journey's steps shorter.
 *
 * On Home the finder serves both intents (2026-10-08: « choisir un GTFS existant de la même façon » to read it): one
 * way to find a network, the intent chosen on the network itself — each network found is « Modifier ce réseau »
 * (`find-network-open`) or « Consulter » (`find-network-read`, `onConsult`: the reader, free), and the person's
 * file is dropped on « Le modifier » (`find-network-upload`) or « Le consulter » (`find-network-upload-read`,
 * `onReadFile` / `onReadPick`). At ① the intent is known: one action, « Choisir ce réseau ».
 *
 * The wait says what is being queried and for how long, and can be
 * cancelled; failures read in plain words with a retry (humanError). The
 * test ids of the former dialog are kept (`find-network`,
 * `find-network-query`, `find-network-search`, `find-network-row`,
 * `find-network-open`, …).
 */

import React, { useCallback, useEffect, useRef, useState } from "react";
import { Box, Button, ButtonBase, CircularProgress, InputBase, Link, Typography, alpha, useTheme } from "@mui/material";
import SearchIcon from "@mui/icons-material/Search";
import HistoryRoundedIcon from "@mui/icons-material/HistoryRounded";
import CloseRoundedIcon from "@mui/icons-material/CloseRounded";
import DirectionsBusFilledOutlinedIcon from "@mui/icons-material/DirectionsBusFilledOutlined";
import TrainOutlinedIcon from "@mui/icons-material/TrainOutlined";
import CloudUploadOutlinedIcon from "@mui/icons-material/CloudUploadOutlined";
import ArrowForwardRoundedIcon from "@mui/icons-material/ArrowForwardRounded";
import ShieldOutlinedIcon from "@mui/icons-material/ShieldOutlined";
import ChevronRightRoundedIcon from "@mui/icons-material/ChevronRightRounded";
import EditRoadOutlinedIcon from "@mui/icons-material/EditRoadOutlined";
import VisibilityOutlinedIcon from "@mui/icons-material/VisibilityOutlined";
import { useLanguage } from "../contexts/LanguageContext";
import { fetchCatalog, openCatalogFeed } from "../utils/networkStudioApi";
import ErrorNotice from "./common/ErrorNotice";
import useElapsed from "./common/useElapsed";
import { Tag } from "./network/StudioUI";
import { tokensOf } from "./studio/studioTheme";
import FileUploadRoundedIcon from "@mui/icons-material/FileUploadRounded";
import { feedDetail, feedTitle, isRailFeed, validityOf } from "./network/feedInfo";

// The last place searched (the field's value on return) and the few before it (the chips).
const PLACE_KEY = "gtfs:find-network-place";
const PLACES_KEY = "gtfs:find-network-places";
const MAX_RECENT = 5;
const readPlace = () => {
  try {
    return localStorage.getItem(PLACE_KEY) || "";
  } catch {
    return "";
  }
};
const readRecent = () => {
  try {
    const list = JSON.parse(localStorage.getItem(PLACES_KEY) || "[]");
    return Array.isArray(list) ? list.filter((p) => typeof p === "string" && p.trim()).slice(0, MAX_RECENT) : [];
  } catch {
    return [];
  }
};
const savePlace = (place) => {
  const recent = [place, ...readRecent().filter((p) => p.toLowerCase() !== place.toLowerCase())].slice(0, MAX_RECENT);
  try {
    localStorage.setItem(PLACE_KEY, place);
    localStorage.setItem(PLACES_KEY, JSON.stringify(recent));
  } catch {
    /* storage disabled */
  }
  return recent;
};
/** The recent searches without `place` (its × on the chip), kept the same way. */
const forgetPlace = (place) => {
  const recent = readRecent().filter((p) => p.toLowerCase() !== String(place).toLowerCase());
  try {
    localStorage.setItem(PLACES_KEY, JSON.stringify(recent));
  } catch {
    /* storage disabled */
  }
  return recent;
};

/**
 * The journey of a modification, one line per step: where this page leads. `compact` (Home's card): the four steps
 * on one line, each one's words in its tooltip and said to a screen reader.
 */
function JourneyHow({ k, t, compact = false }) {
  const steps = [
    { n: 1, title: t("step.1.title"), body: t("journey.modify.1") },
    { n: 2, title: t("step.2.modify.title"), body: t("journey.modify.2") },
    { n: 3, title: t("step.3.modify.title"), body: t("journey.modify.3") },
    { n: 4, title: t("step.5.title"), body: t("journey.modify.4") },
  ];
  return (
    <Box component="section" aria-labelledby="journey-how-title" data-testid="journey-how" sx={{ pt: compact ? 2 : 2.5, borderTop: `1px solid ${k.line}` }}>
      <Typography id="journey-how-title" component="h3" sx={{ fontSize: "0.69rem", fontWeight: 600, letterSpacing: "0.06em", textTransform: "uppercase", color: k.ink3, mb: 1.5 }}>
        {t("journey.how")}
      </Typography>
      <Box component="ol" sx={compact ? { listStyle: "none", m: 0, p: 0, display: "flex", flexWrap: "wrap", alignItems: "center", columnGap: 0.75, rowGap: 1 } : { listStyle: "none", m: 0, p: 0, display: "grid", gridTemplateColumns: { xs: "1fr", sm: "repeat(2, minmax(0, 1fr))", md: "repeat(4, minmax(0, 1fr))" }, gap: 2 }}>
        {steps.map((s, i) => (
          <Box component="li" key={s.n} title={compact ? s.body : undefined} sx={{ display: "flex", gap: compact ? 0.75 : 1.1, alignItems: compact ? "center" : "flex-start" }}>
            <Box aria-hidden sx={{ width: 22, height: 22, flexShrink: 0, borderRadius: "50%", display: "flex", alignItems: "center", justifyContent: "center", fontSize: "0.7rem", fontWeight: 600, color: s.n === 1 ? k.onAccent : k.ink2, backgroundColor: s.n === 1 ? k.accent : "transparent", border: s.n === 1 ? "none" : `1.5px solid ${k.lineStrong}` }}>
              {s.n}
            </Box>
            <Box sx={{ minWidth: 0 }}>
              <Typography sx={{ fontSize: "0.8rem", fontWeight: 600, color: k.ink, lineHeight: 1.35, whiteSpace: compact ? "nowrap" : undefined }}>{s.title}</Typography>
              {compact ? (
                <span className="visually-hidden">{s.body}</span>
              ) : (
                <Typography sx={{ fontSize: "0.74rem", color: k.ink2, lineHeight: 1.45 }}>{s.body}</Typography>
              )}
            </Box>
            {compact && i < steps.length - 1 && <ChevronRightRoundedIcon aria-hidden sx={{ fontSize: 18, color: k.ink3 }} />}
          </Box>
        ))}
      </Box>
    </Box>
  );
}

/**
 * One target for the person's GTFS: a zip dropped on it, or chosen from the disk (`onPick`).
 *
 * `tall` (Home's two targets, 2026-10-08: « pas très visibles »): a tinted card in its intent's colour — the main
 * one (`primary`, « Le modifier ») a little stronger —, its icon in a disc with an upload badge, its title and one
 * hint line (« Glissez un .zip ou cliquez »); the pointer over it deepens the tint, a file dragged over it turns the
 * dashes solid and says « Relâchez… ». No zoom. The compact target keeps its single line.
 */
function DropTarget({ onPick, onDrop, disabled, k, compact, testid, icon: Icon, title, overTitle, body, accent, onRefused, tall = false, primary = false, hint = null }) {
  const theme = useTheme();
  const dark = theme.palette.mode === "dark";
  // The studio's line tokens are drawn for its own surfaces: on Home's cards, in dark mode, the dashes and the icon's
  // square need more contrast to be seen.
  const dash = dark ? alpha(theme.palette.text.primary, 0.42) : k.lineStrong;
  const [over, setOver] = useState(false);
  const accept = (file) => {
    if (!file) return;
    if (!/\.zip$/i.test(file.name || "")) {
      onRefused(true);
      return;
    }
    onRefused(false);
    onDrop?.(file);
  };
  const color = accent || k.ink2;
  const handlers = {
    onClick: onPick || undefined,
    disabled: disabled || !onPick,
    "data-testid": testid,
    "data-over": over ? "true" : undefined,
    onDragOver: (e) => {
      if (!onDrop || disabled) return;
      e.preventDefault();
      setOver(true);
    },
    onDragLeave: () => setOver(false),
    onDrop: (e) => {
      if (!onDrop || disabled) return;
      e.preventDefault();
      setOver(false);
      accept(e.dataTransfer?.files?.[0] || null);
    },
  };
  if (tall) {
    const rest = dark ? (primary ? 0.14 : 0.1) : primary ? 0.075 : 0.045;
    return (
      <ButtonBase
        {...handlers}
        sx={{
          width: "100%",
          height: "100%",
          minHeight: { xs: 112, xl: 140 },
          display: "flex",
          flexDirection: "column",
          alignItems: "center",
          justifyContent: "center",
          gap: 0.9,
          px: 2,
          py: 1.75,
          borderRadius: "16px",
          textAlign: "center",
          border: `1.5px ${over ? "solid" : "dashed"} ${over ? color : alpha(color, dark ? 0.62 : primary ? 0.55 : 0.45)}`,
          background: over ? alpha(color, dark ? 0.22 : 0.13) : `linear-gradient(180deg, ${alpha(color, rest)} 0%, ${alpha(color, rest / 2.5)} 100%)`,
          transition: "border-color .15s, background .15s, box-shadow .2s, transform .2s",
          "@media (hover: hover)": { "&:hover": { borderColor: color, background: alpha(color, dark ? 0.18 : 0.1), boxShadow: `0 10px 24px ${alpha(color, dark ? 0.22 : 0.14)}`, transform: "translateY(-1px)" } },
          "&.Mui-focusVisible": { outline: `2px solid ${color}`, outlineOffset: 2 },
          "@media (prefers-reduced-motion: reduce)": { transition: "none", "&:hover": { transform: "none" } },
        }}
      >
        <Box aria-hidden sx={{ position: "relative", width: { xs: 46, xl: 56 }, height: { xs: 46, xl: 56 }, borderRadius: "50%", display: "flex", alignItems: "center", justifyContent: "center", color, backgroundColor: alpha(color, dark ? 0.24 : 0.14) }}>
          <Icon sx={{ fontSize: 24 }} />
          <Box sx={{ position: "absolute", right: -3, bottom: -3, width: 20, height: 20, borderRadius: "50%", display: "flex", alignItems: "center", justifyContent: "center", color: "#fff", backgroundColor: color, boxShadow: `0 0 0 2px ${theme.palette.background.paper}` }}>
            <FileUploadRoundedIcon sx={{ fontSize: 13 }} />
          </Box>
        </Box>
        <Box sx={{ minWidth: 0 }}>
          <Typography sx={{ fontSize: { xs: "0.94rem", xl: "1.08rem" }, fontWeight: 700, color: k.ink, lineHeight: 1.3 }}>{over ? overTitle : title}</Typography>
          {!over && hint && <Typography sx={{ fontSize: { xs: "0.75rem", xl: "0.85rem" }, color: k.ink2, lineHeight: 1.45, mt: 0.25 }}>{hint}</Typography>}
        </Box>
      </ButtonBase>
    );
  }
  return (
    <ButtonBase
      {...handlers}
      sx={{ width: "100%", height: "100%", display: "flex", alignItems: "center", gap: 1.5, px: 2, py: compact ? 1.25 : 1.75, borderRadius: "14px", border: `1.5px dashed ${over ? k.accent : dash}`, backgroundColor: over ? k.accentSoft : "transparent", textAlign: "left", transition: "border-color .15s, background-color .15s", "&:hover": { borderColor: k.accent, backgroundColor: k.hover }, "&.Mui-focusVisible": { outline: `2px solid ${k.accent}`, outlineOffset: 2 } }}
    >
      <Box aria-hidden sx={{ width: 36, height: 36, flexShrink: 0, borderRadius: "10px", display: "flex", alignItems: "center", justifyContent: "center", backgroundColor: dark ? alpha(color, 0.16) : k.subtle, color }}>
        <Icon sx={{ fontSize: 20 }} />
      </Box>
      <Box sx={{ minWidth: 0 }}>
        <Typography sx={{ fontSize: "0.86rem", fontWeight: 600, color: k.ink }}>{over ? overTitle : title}</Typography>
        {body && <Typography sx={{ fontSize: "0.76rem", color: k.ink2, lineHeight: 1.45 }}>{body}</Typography>}
      </Box>
    </ButtonBase>
  );
}

/**
 * The person's own GTFS: a zip dropped here, or chosen from the disk. With `onReadPick` / `onReadDrop` (Home) the
 * zone is two targets side by side — to modify the file, or to consult it — the intent chosen where the file lands.
 */
function FileDrop({ onPick, onDrop, onReadPick = null, onReadDrop = null, disabled, k, t, compact = false, bare = false }) {
  const theme = useTheme();
  const [refused, setRefused] = useState(false);
  const both = Boolean(onReadPick || onReadDrop);
  const refusedLine = refused && (
    <Typography role="alert" data-testid="find-network-upload-refused" sx={{ mt: 0.75, fontSize: "0.76rem", color: "error.main" }}>
      {t("findNetwork.drop.notZip")}
    </Typography>
  );
  if (both) {
    return (
      <Box data-testid="find-network-files" sx={bare ? { flex: 1, display: "flex", flexDirection: "column" } : undefined}>
        {!bare && <Typography sx={{ fontSize: "0.8rem", fontWeight: 600, color: k.ink, mb: 0.75 }}>{t("findNetwork.drop.both")}</Typography>}
        <Box sx={{ display: "grid", gridTemplateColumns: { xs: "1fr", sm: "repeat(2, minmax(0, 1fr))" }, gap: 1, ...(bare ? { flex: 1, gridAutoRows: "1fr" } : {}) }}>
          <DropTarget onPick={onPick} onDrop={onDrop} disabled={disabled} k={k} compact={compact} testid="find-network-upload" icon={EditRoadOutlinedIcon} accent={k.accent} title={t("findNetwork.drop.modify")} overTitle={t("findNetwork.drop.active")} body={bare ? null : t("findNetwork.drop.modifyBody")} hint={t("findNetwork.drop.hint")} onRefused={setRefused} tall={bare} primary />
          <DropTarget onPick={onReadPick} onDrop={onReadDrop} disabled={disabled} k={k} compact={compact} testid="find-network-upload-read" icon={VisibilityOutlinedIcon} accent={theme.palette.success.main} title={t("findNetwork.drop.read")} overTitle={t("findNetwork.drop.active")} body={bare ? null : t("findNetwork.drop.readBody")} hint={t("findNetwork.drop.hint")} onRefused={setRefused} tall={bare} />
        </Box>
        {refusedLine}
      </Box>
    );
  }
  return (
    <Box>
      <DropTarget onPick={onPick} onDrop={onDrop} disabled={disabled} k={k} compact={compact} testid="find-network-upload" icon={CloudUploadOutlinedIcon} title={t("findNetwork.drop.title")} overTitle={t("findNetwork.drop.active")} body={t("findNetwork.drop.body")} onRefused={setRefused} />
      {refusedLine}
    </Box>
  );
}

export default function FindNetworkPanel({ onOpened, onConsult = null, onUploadInstead = null, onDropFile = null, onReadPick = null, onReadFile = null, beforeModify = null, autoFocus = true, headingLevel = "h2", footnote = null, layout = "page", sx = {} }) {
  const card = layout === "card";
  // Home: each network found is modified or consulted (the intent chosen on the network, not before).
  const both = Boolean(onConsult);
  const { t, language } = useLanguage();
  const theme = useTheme();
  const k = tokensOf(theme);
  const [query, setQuery] = useState(readPlace);
  const [recent, setRecent] = useState(readRecent);
  const [search, setSearch] = useState({ status: "idle", place: "", feeds: [], sources: null, error: null }); // idle | loading | done | error
  const [opening, setOpening] = useState(null); // { url, intent } — the feed being opened, to modify or to read
  const [openError, setOpenError] = useState(null); // { url, error }
  const abortRef = useRef(null);
  const searchSeconds = useElapsed(search.status === "loading");
  const openSeconds = useElapsed(Boolean(opening));

  // Leaving the step cancels a search in flight.
  useEffect(() => () => abortRef.current?.abort(), []);

  const run = useCallback(
    async (placeArg) => {
      const place = String(placeArg ?? query).trim();
      if (place.length < 2) return;
      abortRef.current?.abort();
      const abort = new AbortController();
      abortRef.current = abort;
      setQuery(place);
      setRecent(savePlace(place));
      setOpenError(null);
      setSearch({ status: "loading", place, feeds: [], sources: null, error: null });
      try {
        const r = await fetchCatalog(place, { light: true, signal: abort.signal });
        if (abort.signal.aborted) return;
        setSearch({ status: "done", place, feeds: r.feeds || [], sources: r.sources || null, error: null });
      } catch (err) {
        if (err.code === "ABORTED") setSearch({ status: "idle", place: "", feeds: [], sources: null, error: null });
        else setSearch({ status: "error", place, feeds: [], sources: null, error: err });
      }
    },
    [query],
  );
  const cancel = () => abortRef.current?.abort();

  const openFeed = async (feed, intent = "modify") => {
    if (opening) return;
    // Modifying needs the licence: `beforeModify` says so before the network is loaded (the offer opens at once,
    // and `resume` opens this network once the licence runs). Consulting needs nothing.
    if (intent === "modify" && beforeModify && !beforeModify(() => openFeed(feed, "modify"))) return;
    setOpening({ url: feed.url, intent });
    setOpenError(null);
    try {
      const r = await openCatalogFeed(feed.url, { name: feedTitle(feed) || null, place: search.place || null });
      if (intent === "read") onConsult({ ...r, openedFeed: { name: feedTitle(feed) } });
      else onOpened({ ...r, openedFeed: { name: feedTitle(feed) }, openChangeStudio: true });
    } catch (err) {
      setOpenError({ url: feed.url, error: err });
    } finally {
      setOpening(null);
    }
  };

  const sources = search.sources ? [search.sources.pan?.ok ? t("feeds.pan") : null, search.sources.mdb?.ok ? t("feeds.mdb") : null].filter(Boolean) : [];
  const chips = recent.filter((p) => p.toLowerCase() !== search.place.toLowerCase() || search.status === "idle");
  const busy = Boolean(opening);

  return (
    <Box component="section" aria-labelledby="find-network-title" data-testid="find-network" sx={{ width: "100%", maxWidth: 880, mx: "auto", pt: { xs: 2, md: "clamp(16px, 7vh, 72px)" }, pb: 4, display: "flex", flexDirection: "column", gap: 2.5, ...(card ? { maxWidth: "none", mx: 0, pt: 0, pb: 0, gap: 2, flex: 1 } : {}), ...sx }}>
      {/* The question */}
      <Box sx={{ textAlign: card ? "left" : "center", display: "flex", flexDirection: "column", alignItems: card ? "flex-start" : "center", gap: card ? 0.75 : 1 }}>
        <Typography id="find-network-title" component={headingLevel} sx={{ fontSize: card ? { xs: "1.25rem", md: "1.5rem", xl: "1.8rem" } : { xs: "1.35rem", md: "1.7rem" }, fontWeight: card ? 750 : 650, letterSpacing: "-0.02em", lineHeight: 1.2, color: k.ink }}>
          {t("findNetwork.hero.title")}
        </Typography>
        {!card && <Typography sx={{ maxWidth: 600, fontSize: "0.92rem", color: k.ink2, lineHeight: 1.55 }}>{t(both ? "findNetwork.subtitleBoth" : "findNetwork.subtitle")}</Typography>}
      </Box>

      {/* The search */}
      <Box sx={{ display: "flex", flexDirection: "column", gap: 1 }}>
        <Box component="form" role="search" onSubmit={(e) => { e.preventDefault(); run(); }} sx={{ display: "flex", alignItems: "center", gap: 1, pl: 2, pr: 0.75, height: card ? { xs: 52, xl: 60 } : 58, borderRadius: card ? "14px" : "16px", backgroundColor: k.surface, border: `1px solid ${k.line}`, boxShadow: k.float, transition: "border-color 120ms, box-shadow 120ms", "&:focus-within": { borderColor: k.accent, boxShadow: `${k.float}, 0 0 0 4px ${alpha(theme.palette.primary.main, 0.14)}` } }}>
          <SearchIcon aria-hidden sx={{ fontSize: 22, color: k.ink3 }} />
          <InputBase autoFocus={autoFocus} fullWidth value={query} onChange={(e) => setQuery(e.target.value.slice(0, 200))} placeholder={t("findNetwork.placeholder")} inputProps={{ "data-testid": "find-network-query", "aria-label": t("findNetwork.placeholder") }} sx={{ fontSize: { xs: "1rem", xl: "1.1rem" }, color: k.ink }} />
          <Button type="submit" variant="contained" disableElevation disabled={query.trim().length < 2 || search.status === "loading"} data-testid="find-network-search" sx={{ height: { xs: 42, xl: 48 }, px: { xs: 2.25, xl: 3 }, fontSize: { xl: "1rem" }, borderRadius: "11px", textTransform: "none", fontWeight: 600, flexShrink: 0 }}>
            {t("findNetwork.search")}
          </Button>
        </Box>
        {chips.length > 0 && (
          <Box data-testid="find-network-recent" sx={{ display: "flex", alignItems: "center", flexWrap: "wrap", gap: 0.75, justifyContent: card ? "flex-start" : "center" }}>
            <Typography component="span" sx={{ display: "inline-flex", alignItems: "center", gap: 0.5, fontSize: { xs: "0.74rem", xl: "0.84rem" }, color: k.ink3 }}>
              <HistoryRoundedIcon aria-hidden sx={{ fontSize: 15 }} />
              {t("findNetwork.recent")}
            </Typography>
            {chips.map((p) => (
              <Box key={p} data-testid="find-network-recent-chip" sx={{ display: "inline-flex", alignItems: "center", height: { xs: 28, xl: 34 }, borderRadius: 999, border: `1px solid ${k.line}`, backgroundColor: k.surface, overflow: "hidden", "&:hover": { borderColor: k.accent } }}>
                <ButtonBase onClick={() => run(p)} disabled={search.status === "loading" || busy} data-testid="find-network-recent-place" sx={{ height: "100%", pl: { xs: 1.25, xl: 1.5 }, pr: 0.5, fontSize: { xs: "0.78rem", xl: "0.88rem" }, color: k.ink, "&:hover": { color: k.accent } }}>
                  {p}
                </ButtonBase>
                {/* Forgets this search (this browser only). */}
                <ButtonBase onClick={() => setRecent(forgetPlace(p))} aria-label={t("findNetwork.recentForget", { place: p })} title={t("findNetwork.recentForget", { place: p })} data-testid="find-network-recent-forget" sx={{ height: "100%", px: 0.75, color: k.ink3, "&:hover": { color: k.ink } }}>
                  <CloseRoundedIcon sx={{ fontSize: { xs: 14, xl: 16 } }} />
                </ButtonBase>
              </Box>
            ))}
          </Box>
        )}
        {search.status === "idle" && !chips.length && !card && <Typography sx={{ textAlign: card ? "left" : "center", fontSize: "0.76rem", color: k.ink3, lineHeight: 1.5 }}>{t("findNetwork.hint")}</Typography>}
      </Box>

      {/* What is happening */}
      {search.status === "loading" && (
        <Box data-testid="find-network-loading" role="status" sx={{ display: "flex", alignItems: "center", gap: 1.25, px: 2, py: 1.5, borderRadius: "14px", border: `1px solid ${k.line}`, backgroundColor: k.surface }}>
          <CircularProgress size={18} sx={{ flexShrink: 0 }} />
          <Box sx={{ flex: 1, minWidth: 0 }}>
            <Typography sx={{ fontSize: "0.84rem", fontWeight: 600, color: k.ink }}>{t("findNetwork.loading", { place: search.place, seconds: searchSeconds })}</Typography>
            <Typography sx={{ fontSize: "0.74rem", color: k.ink2, mt: 0.25 }}>{t("findNetwork.loadingSources", { sources: `${t("feeds.pan")} · ${t("feeds.mdb")}` })}</Typography>
          </Box>
          <Button size="small" onClick={cancel} data-testid="find-network-cancel" sx={{ textTransform: "none", fontWeight: 600, flexShrink: 0 }}>
            {t("findNetwork.cancel")}
          </Button>
        </Box>
      )}
      {search.status === "error" && <ErrorNotice error={search.error} onRetry={() => run(search.place)} testid="find-network-error" />}
      {search.status === "done" && search.feeds.length === 0 && (
        <Typography data-testid="find-network-none" sx={{ textAlign: "center", fontSize: "0.84rem", color: k.ink2, lineHeight: 1.55, px: 2 }}>
          {t("findNetwork.none", { place: search.place })}
        </Typography>
      )}

      {/* The networks */}
      {search.status === "done" && search.feeds.length > 0 && (
        <Box sx={{ display: "flex", flexDirection: "column", gap: 1 }}>
          <Typography sx={{ fontSize: "0.78rem", fontWeight: 600, color: k.ink2 }}>{t("findNetwork.found", { count: search.feeds.length, place: search.place })}</Typography>
          <Box sx={{ display: "grid", gridTemplateColumns: { xs: "1fr", md: search.feeds.length > 1 ? "repeat(2, minmax(0, 1fr))" : "1fr" }, gap: 1.25 }}>
            {search.feeds.map((f) => {
              const title = feedTitle(f);
              const detail = feedDetail(f, t, language);
              const valid = validityOf(f, t, language);
              const Icon = isRailFeed(f) ? TrainOutlinedIcon : DirectionsBusFilledOutlinedIcon;
              const isOpening = Boolean(opening) && opening.url === f.url;
              const failed = openError?.url === f.url ? openError.error : null;
              return (
                <Box key={f.id || f.url} data-testid="find-network-row" data-status={f.status || ""} sx={{ p: 1.75, borderRadius: "14px", border: `1px solid ${isOpening ? k.accent : k.line}`, backgroundColor: k.surface, boxShadow: k.raise, display: "flex", flexDirection: "column", gap: 1.25, transition: "border-color .15s, box-shadow .15s", "&:hover": { borderColor: k.accentLine, boxShadow: k.float } }}>
                  <Box sx={{ display: "flex", alignItems: "flex-start", gap: 1.25 }}>
                    <Box aria-hidden sx={{ width: 36, height: 36, flexShrink: 0, borderRadius: "10px", display: "flex", alignItems: "center", justifyContent: "center", color: k.accent, backgroundColor: k.accentSoft }}>
                      <Icon sx={{ fontSize: 19 }} />
                    </Box>
                    <Box sx={{ flex: 1, minWidth: 0 }}>
                      <Typography sx={{ fontSize: "0.92rem", fontWeight: 600, color: k.ink, lineHeight: 1.3 }} title={`${title}${f.provider && f.provider !== title ? ` — ${f.provider}` : ""}`}>
                        {title}
                      </Typography>
                      {f.provider && f.provider !== title && <Typography sx={{ fontSize: "0.76rem", color: k.ink2 }}>{f.provider}</Typography>}
                      <Box sx={{ display: "flex", alignItems: "center", gap: 0.5, flexWrap: "wrap", mt: 0.5 }}>
                        {f.scope && <Tag>{t(`feeds.scope.${f.scope}`)}</Tag>}
                        {valid?.expired && <Tag color={theme.palette.warning.dark}>{t("feeds.expiredTag")}</Tag>}
                      </Box>
                    </Box>
                  </Box>
                  <Box sx={{ display: "flex", flexDirection: "column", gap: 0.25 }}>
                    {detail && <Typography sx={{ fontSize: "0.76rem", color: k.ink2 }}>{detail}</Typography>}
                    {valid && (
                      <Typography data-testid="find-network-validity" sx={{ fontSize: "0.76rem", color: valid.color, fontWeight: valid.expired ? 600 : 400 }}>
                        {valid.text}
                        {valid.expired ? ` — ${t("findNetwork.expiredHint")}` : ""}
                      </Typography>
                    )}
                  </Box>
                  {failed && <ErrorNotice error={failed} onRetry={() => openFeed(f)} testid="find-network-open-error" />}
                  <Box sx={{ display: "flex", alignItems: "center", gap: 1, flexWrap: "wrap", mt: "auto" }}>
                    <Button variant="contained" disableElevation disabled={busy} onClick={() => openFeed(f)} endIcon={isOpening && opening.intent === "modify" ? <CircularProgress size={14} color="inherit" /> : <ArrowForwardRoundedIcon sx={{ fontSize: "17px !important" }} />} data-testid="find-network-open" sx={{ textTransform: "none", fontWeight: 600, borderRadius: "10px", px: both ? 1.5 : 1.75 }}>
                      {both ? t("findNetwork.modify") : t("findNetwork.choose")}
                    </Button>
                    {both && (
                      <Button variant="outlined" disabled={busy} onClick={() => openFeed(f, "read")} startIcon={isOpening && opening.intent === "read" ? <CircularProgress size={14} color="inherit" /> : <VisibilityOutlinedIcon sx={{ fontSize: "17px !important" }} />} data-testid="find-network-read" sx={{ textTransform: "none", fontWeight: 600, borderRadius: "10px", px: 1.25 }}>
                        {t("findNetwork.consult")}
                      </Button>
                    )}
                    {isOpening && (
                      <Typography sx={{ fontSize: "0.74rem", color: k.ink2 }} data-testid="find-network-opening">
                        {t("findNetwork.opening", { seconds: openSeconds })}
                      </Typography>
                    )}
                    {!isOpening && f.page_url && (
                      <Link href={f.page_url} target="_blank" rel="noreferrer" underline="hover" sx={{ fontSize: "0.74rem", color: k.ink2, ml: "auto" }}>
                        {t("feeds.page")}
                      </Link>
                    )}
                  </Box>
                </Box>
              );
            })}
          </Box>
          {sources.length > 0 && <Typography sx={{ fontSize: "0.68rem", color: k.ink3 }}>{t("feeds.sources", { sources: sources.join(" · ") })}</Typography>}
        </Box>
      )}

      {/* The person's own file */}
      {(onUploadInstead || onDropFile) && (
        <Box sx={{ display: "flex", flexDirection: "column", gap: card ? 1 : 1.25, ...(card ? { flex: 1 } : {}) }}>
          <Box aria-hidden sx={{ display: "flex", alignItems: "center", gap: 1.5, color: k.ink3, fontSize: "0.74rem", "&::before, &::after": { content: '""', flex: 1, height: "1px", backgroundColor: theme.palette.mode === "dark" ? alpha(theme.palette.text.primary, 0.16) : k.line } }}>
            {t(card ? "findNetwork.orFile" : "findNetwork.or")}
          </Box>
          <FileDrop onPick={onUploadInstead} onDrop={onDropFile} onReadPick={onReadPick} onReadDrop={onReadFile} disabled={busy} k={k} t={t} compact={card} bare={card} />
        </Box>
      )}

      {/* What the person can count on, and where this leads (the page only: Home's card stays bare) */}
      {!card && (
        <Box sx={{ display: "flex", alignItems: "flex-start", justifyContent: "center", gap: 0.75, color: k.ink2 }}>
          <ShieldOutlinedIcon aria-hidden sx={{ fontSize: 16, mt: "1px", color: k.success }} />
          <Typography sx={{ fontSize: "0.76rem", lineHeight: 1.5 }}>
            {t("findNetwork.asIs")} {t("findNetwork.briefLater")}
          </Typography>
        </Box>
      )}
      {footnote}
      {!card && <JourneyHow k={k} t={t} />}
    </Box>
  );
}
