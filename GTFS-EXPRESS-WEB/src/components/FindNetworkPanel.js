/**
 * FindNetworkPanel — where a network is found: Home's question, « Quel réseau
 * voulez-vous explorer ou modifier ? », and ① of a modify project before any
 * network is open, « Quel réseau voulez-vous faire évoluer ? ».
 *
 *   the search        a town: the published GTFS feeds covering it, straight
 *                     from the catalogues (GET /network/catalog?place=…&light=1
 *                     — the place alone, no territory dossier, so it answers
 *                     in seconds); the last places searched in this browser
 *                     come back as chips (`find-network-recent`), a click
 *                     searching again
 *   the networks      one card each (`find-network-row`): its scope,
 *                     provider, size and validity (an expired feed is
 *                     flagged). A network is opened AS IT IS (POST
 *                     /network/catalog/open: every trip, variant and calendar
 *                     exception kept)
 *   the person's file a GTFS zip dropped or chosen from the disk
 *
 * Home (`intent` "home"): the head of the page — Home's question (`heading`,
 * the title that labels the section, `labelledBy`), one card with the search,
 * « ou », the person's file, the promises (`trust`) under it and the reader's
 * picture beside it (`aside`); the networks found in a panel under the head. Every network found, and the file once chosen, offers the
 * same two actions: « Explorer » (`find-network-read`,
 * `find-network-file-explore`: the reader, free) and « Modifier »
 * (`find-network-open`, `find-network-file-modify`: a new modify project,
 * behind the licence — `beforeModify(resume)` opens the offer first and
 * `resume` carries on once the licence runs; `modifyLocked` shows the lock).
 * The field never takes the focus by itself there (the skip link comes first).
 *
 * ① (`intent` "modify"): one action, « Choisir ce réseau »
 * (`find-network-open`), the network becoming the project's reference v0,
 * frozen as a zip with the project so that « Reprendre » never downloads it
 * again; the file is dropped on `find-network-upload` (`onDropFile`) or chosen
 * by the app's picker (`onUploadInstead`); the three steps of the journey
 * close the page (`journey-how`).
 *
 * The wait says what is being queried and for how long, and can be
 * cancelled; failures read in plain words with a retry (humanError). The
 * tests rely on its test ids (`find-network`, `find-network-query`,
 * `find-network-search`, `find-network-row`, `find-network-open`, …).
 */

import React, { useCallback, useEffect, useRef, useState } from "react";
import { Box, Button, ButtonBase, CircularProgress, IconButton, InputBase, LinearProgress, Link, Typography, alpha, useTheme } from "@mui/material";
import OpenInNewRoundedIcon from "@mui/icons-material/OpenInNewRounded";
import SearchIcon from "@mui/icons-material/Search";
import HistoryRoundedIcon from "@mui/icons-material/HistoryRounded";
import CloseRoundedIcon from "@mui/icons-material/CloseRounded";
import DirectionsBusFilledOutlinedIcon from "@mui/icons-material/DirectionsBusFilledOutlined";
import TrainOutlinedIcon from "@mui/icons-material/TrainOutlined";
import CloudUploadOutlinedIcon from "@mui/icons-material/CloudUploadOutlined";
import ArrowForwardRoundedIcon from "@mui/icons-material/ArrowForwardRounded";
import ShieldOutlinedIcon from "@mui/icons-material/ShieldOutlined";
import VisibilityOutlinedIcon from "@mui/icons-material/VisibilityOutlined";
import InsertDriveFileOutlinedIcon from "@mui/icons-material/InsertDriveFileOutlined";
import LockOutlinedIcon from "@mui/icons-material/LockOutlined";
import EditRoadOutlinedIcon from "@mui/icons-material/EditRoadOutlined";
import { useLanguage } from "../contexts/LanguageContext";
import { fetchCatalog, openCatalogFeed } from "../utils/networkStudioApi";
import ErrorNotice from "./common/ErrorNotice";
import useElapsed from "./common/useElapsed";
import { Tag } from "./network/StudioUI";
import { tokensOf } from "./studio/studioTheme";
import { feedDetail, feedTitle, isRailFeed, licenceOf, validityOf } from "./network/feedInfo";

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


/** The journey of a modification, one line per step, numbered as the project shows them: where ①'s page leads. */
function JourneyHow({ k, t }) {
  const steps = [
    { n: 1, title: t("step.1.modify.title"), body: t("journey.modify.1") },
    { n: 2, title: t("step.3.modify.title"), body: t("journey.modify.3") },
    { n: 3, title: t("step.5.title"), body: t("journey.modify.4") },
  ];
  return (
    <Box component="section" aria-labelledby="journey-how-title" data-testid="journey-how" sx={{ pt: 2.5, borderTop: `1px solid ${k.line}` }}>
      <Typography id="journey-how-title" component="h3" sx={{ fontSize: "0.69rem", fontWeight: 600, letterSpacing: "0.06em", textTransform: "uppercase", color: k.ink3, mb: 1.5 }}>
        {t("journey.how")}
      </Typography>
      <Box component="ol" sx={{ listStyle: "none", m: 0, p: 0, display: "grid", gridTemplateColumns: { xs: "1fr", sm: "repeat(2, minmax(0, 1fr))", md: "repeat(3, minmax(0, 1fr))" }, gap: 2 }}>
        {steps.map((s) => (
          <Box component="li" key={s.n} sx={{ display: "flex", gap: 1.1, alignItems: "flex-start" }}>
            <Box aria-hidden sx={{ width: 22, height: 22, flexShrink: 0, borderRadius: "50%", display: "flex", alignItems: "center", justifyContent: "center", fontSize: "0.7rem", fontWeight: 600, color: s.n === 1 ? k.onAccent : k.ink2, backgroundColor: s.n === 1 ? k.accent : "transparent", border: s.n === 1 ? "none" : `1.5px solid ${k.lineStrong}` }}>
              {s.n}
            </Box>
            <Box sx={{ minWidth: 0 }}>
              <Typography sx={{ fontSize: "0.8rem", fontWeight: 600, color: k.ink, lineHeight: 1.35 }}>{s.title}</Typography>
              <Typography sx={{ fontSize: "0.74rem", color: k.ink2, lineHeight: 1.45 }}>{s.body}</Typography>
            </Box>
          </Box>
        ))}
      </Box>
    </Box>
  );
}

const isZip = (file) => /\.zip$/i.test(file?.name || "");
const sizeOf = (bytes, language) => {
  const mb = (Number(bytes) || 0) / (1024 * 1024);
  try {
    return new Intl.NumberFormat(language, { style: "unit", unit: "megabyte", unitDisplay: "short", maximumFractionDigits: mb < 10 ? 1 : 0 }).format(mb);
  } catch {
    return `${mb.toFixed(1)} MB`;
  }
};

/** ①'s target for the person's GTFS: a zip dropped on it, or chosen from the disk (`onPick`, the app's picker). */
function FileDrop({ onPick, onDrop, disabled, k, t }) {
  const [over, setOver] = useState(false);
  const [refused, setRefused] = useState(false);
  const accept = (file) => {
    if (!file) return;
    setRefused(!isZip(file));
    if (isZip(file)) onDrop?.(file);
  };
  return (
    <Box>
      <ButtonBase
        onClick={onPick || undefined}
        disabled={disabled || !onPick}
        data-testid="find-network-upload"
        data-over={over ? "true" : undefined}
        onDragOver={(e) => {
          if (!onDrop || disabled) return;
          e.preventDefault();
          setOver(true);
        }}
        onDragLeave={() => setOver(false)}
        onDrop={(e) => {
          if (!onDrop || disabled) return;
          e.preventDefault();
          setOver(false);
          accept(e.dataTransfer?.files?.[0] || null);
        }}
        sx={{ width: "100%", display: "flex", alignItems: "center", gap: 1.5, px: 2, py: 1.75, borderRadius: "14px", border: `1.5px dashed ${over ? k.accent : k.lineStrong}`, backgroundColor: over ? k.accentSoft : "transparent", textAlign: "left", transition: "border-color .15s, background-color .15s", "&:hover": { borderColor: k.accent, backgroundColor: k.hover }, "&.Mui-focusVisible": { outline: `2px solid ${k.accent}`, outlineOffset: 2 } }}
      >
        <Box aria-hidden sx={{ width: 36, height: 36, flexShrink: 0, borderRadius: "10px", display: "flex", alignItems: "center", justifyContent: "center", backgroundColor: k.subtle, color: k.ink2 }}>
          <CloudUploadOutlinedIcon sx={{ fontSize: 20 }} />
        </Box>
        <Box sx={{ minWidth: 0 }}>
          <Typography sx={{ fontSize: "0.86rem", fontWeight: 600, color: k.ink }}>{over ? t("findNetwork.drop.active") : t("findNetwork.drop.title")}</Typography>
          <Typography sx={{ fontSize: "0.76rem", color: k.ink2, lineHeight: 1.45 }}>{t("findNetwork.drop.body")}</Typography>
        </Box>
      </ButtonBase>
      {refused && (
        <Typography role="alert" data-testid="find-network-upload-refused" sx={{ mt: 0.75, fontSize: "0.76rem", color: "error.main" }}>
          {t("findNetwork.drop.notZip")}
        </Typography>
      )}
    </Box>
  );
}

/**
 * Home's own target for the person's GTFS, one row in the finder's card: dropped or chosen there; once the file is
 * there, its name and size with the same two actions as a network found — « Explorer » (the reader) or « Modifier »
 * (a new modify project, behind the licence).
 */
function HomeFile({ onExplore, onModify, modifyLocked, disabled, k, t, language }) {
  const theme = useTheme();
  const inputRef = useRef(null);
  const [over, setOver] = useState(false);
  const [file, setFile] = useState(null);
  const [refused, setRefused] = useState(false);
  const take = (f) => {
    if (!f) return;
    setRefused(!isZip(f));
    if (isZip(f)) setFile(f);
  };
  const dark = theme.palette.mode === "dark";
  const row = { width: "100%", minHeight: 64, display: "flex", alignItems: "center", gap: 1.5, px: 1.5, py: 1.25, borderRadius: "14px", textAlign: "left" };
  return (
    <Box data-testid="find-network-file">
      <input ref={inputRef} type="file" hidden accept=".zip,application/zip" data-testid="find-network-file-input" onChange={(e) => { take(e.target.files?.[0] || null); e.target.value = ""; }} />
      {file ? (
        <Box data-testid="find-network-file-chosen" sx={{ ...row, flexWrap: "wrap", border: `1px solid ${k.accentLine}`, backgroundColor: alpha(theme.palette.primary.main, dark ? 0.1 : 0.04) }}>
          <Box aria-hidden sx={{ width: 40, height: 40, flexShrink: 0, borderRadius: "11px", display: "flex", alignItems: "center", justifyContent: "center", color: k.accent, backgroundColor: k.accentSoft }}>
            <InsertDriveFileOutlinedIcon sx={{ fontSize: 21 }} />
          </Box>
          <Box sx={{ flex: "1 1 140px", minWidth: 0 }}>
            <Typography title={file.name} sx={{ fontSize: "0.9rem", fontWeight: 600, color: k.ink, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{file.name}</Typography>
            <Typography sx={{ fontSize: "0.74rem", color: k.ink2 }}>{sizeOf(file.size, language)}</Typography>
          </Box>
          <Box sx={{ display: "flex", alignItems: "center", gap: 0.75, ml: "auto" }}>
            <IconButton size="small" onClick={() => setFile(null)} aria-label={t("findNetwork.file.clear")} title={t("findNetwork.file.clear")} data-testid="find-network-file-clear">
              <CloseRoundedIcon sx={{ fontSize: 18 }} />
            </IconButton>
            <Button variant="outlined" disabled={disabled} startIcon={<VisibilityOutlinedIcon />} onClick={() => onExplore?.(file)} data-testid="find-network-file-explore" sx={{ textTransform: "none", fontWeight: 600, borderRadius: "10px" }}>
              {t("findNetwork.explore")}
            </Button>
            <Button variant="contained" disableElevation disabled={disabled} startIcon={modifyLocked ? <LockOutlinedIcon /> : <EditRoadOutlinedIcon />} onClick={() => onModify?.(file)} data-testid="find-network-file-modify" sx={{ textTransform: "none", fontWeight: 600, borderRadius: "10px" }}>
              {t("findNetwork.modify")}
            </Button>
          </Box>
        </Box>
      ) : (
        <ButtonBase
          onClick={() => inputRef.current?.click()}
          disabled={disabled}
          data-testid="find-network-upload"
          data-over={over ? "true" : undefined}
          onDragOver={(e) => {
            if (disabled) return;
            e.preventDefault();
            setOver(true);
          }}
          onDragLeave={() => setOver(false)}
          onDrop={(e) => {
            if (disabled) return;
            e.preventDefault();
            setOver(false);
            take(e.dataTransfer?.files?.[0] || null);
          }}
          sx={{
            ...row,
            border: `1.5px ${over ? "solid" : "dashed"} ${over ? k.accent : alpha(theme.palette.primary.main, dark ? 0.6 : 0.5)}`,
            backgroundColor: over ? k.accentSoft : alpha(theme.palette.primary.main, dark ? 0.16 : 0.09),
            transition: "border-color .15s, background-color .15s",
            "@media (hover: hover)": { "&:hover": { borderColor: k.accent, backgroundColor: k.accentSoft } },
            "&.Mui-focusVisible": { outline: `2px solid ${k.accent}`, outlineOffset: 2 },
          }}
        >
          <Box aria-hidden sx={{ width: 40, height: 40, flexShrink: 0, borderRadius: "11px", display: "flex", alignItems: "center", justifyContent: "center", color: theme.palette.primary.contrastText, backgroundColor: theme.palette.primary.main }}>
            <CloudUploadOutlinedIcon sx={{ fontSize: 21 }} />
          </Box>
          <Box sx={{ minWidth: 0 }}>
            <Typography sx={{ fontSize: "0.92rem", fontWeight: 650, color: k.ink }}>{over ? t("findNetwork.drop.active") : t("findNetwork.drop.home")}</Typography>
            {!over && <Typography sx={{ fontSize: "0.76rem", color: k.ink2 }}>{t("findNetwork.drop.hint")}</Typography>}
          </Box>
        </ButtonBase>
      )}
      {refused && (
        <Typography role="alert" data-testid="find-network-upload-refused" sx={{ mt: 0.75, fontSize: "0.76rem", color: "error.main" }}>
          {t("findNetwork.drop.notZip")}
        </Typography>
      )}
    </Box>
  );
}

// A network found on Home: a tinted field like the search's, white and lifted under the pointer or while it opens.
const homeRowSx = (theme, k, opening) => {
  const blue = theme.palette.primary.main;
  const dark = theme.palette.mode === "dark";
  const lifted = { backgroundColor: k.surface, borderColor: k.accentLine, boxShadow: k.float };
  return {
    border: `1px solid ${alpha(blue, dark ? 0.28 : 0.14)}`,
    backgroundColor: alpha(blue, dark ? 0.1 : 0.04),
    ...(opening ? { ...lifted, borderColor: k.accent } : {}),
    "@media (hover: hover)": { "&:hover": lifted },
  };
};

export default function FindNetworkPanel({ onOpened, onConsult = null, beforeModify = null, intent = "modify", modifyLocked = false, onUploadInstead = null, onDropFile = null, onExploreFile = null, onModifyFile = null, autoFocus = true, labelledBy = null, heading = null, aside = null, trust = null, fileFoot = null, sx = {} }) {
  // Home: each network found is explored or modified (the intent chosen on the network); ① chooses one to modify.
  const home = intent === "home";
  const { t, language } = useLanguage();
  const theme = useTheme();
  const k = tokensOf(theme);
  const [query, setQuery] = useState(readPlace);
  const [recent, setRecent] = useState(readRecent);
  const [search, setSearch] = useState({ status: "idle", place: "", feeds: [], sources: null, error: null }); // idle | loading | done | error
  const [opening, setOpening] = useState(null); // { url, intent } — the feed being opened, to explore or to modify
  const [openError, setOpenError] = useState(null); // { url, error }
  const abortRef = useRef(null);
  const resultsRef = useRef(null);
  const searchSeconds = useElapsed(search.status === "loading");
  const openSeconds = useElapsed(Boolean(opening));

  // Leaving the page cancels a search in flight.
  useEffect(() => () => abortRef.current?.abort(), []);
  // Home: the networks found come into view under the head (only as far as needed).
  const found = search.status === "done" ? search.feeds.length : 0;
  useEffect(() => {
    if (home && found) resultsRef.current?.scrollIntoView?.({ behavior: "smooth", block: "nearest" });
  }, [home, found, search.place]);

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

  const openFeed = async (feed, want = "modify") => {
    if (opening) return;
    // Modifying needs the licence: `beforeModify` says so before the network is loaded (the offer opens at once, and
    // `resume` opens this network once the licence runs). Exploring needs nothing.
    if (want === "modify" && beforeModify && !beforeModify(() => openFeed(feed, "modify"))) return;
    setOpening({ url: feed.url, intent: want });
    setOpenError(null);
    try {
      const r = await openCatalogFeed(feed.url, { name: feedTitle(feed) || null, place: search.place || null });
      if (want === "read") onConsult?.({ ...r, openedFeed: { name: feedTitle(feed) } });
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

  const question = (
    <Box sx={{ textAlign: "center", display: "flex", flexDirection: "column", alignItems: "center", gap: 1 }}>
      <Typography id="find-network-title" component="h2" sx={{ fontSize: { xs: "1.35rem", md: "1.7rem" }, fontWeight: 650, letterSpacing: "-0.02em", lineHeight: 1.2, color: k.ink }}>
        {t("findNetwork.hero.title")}
      </Typography>
      <Typography sx={{ maxWidth: 600, fontSize: "0.92rem", color: k.ink2, lineHeight: 1.55 }}>{t("findNetwork.subtitle")}</Typography>
    </Box>
  );

  const searchBlock = (
    <Box sx={{ display: "flex", flexDirection: "column", gap: 1 }}>
      <Box component="form" role="search" onSubmit={(e) => { e.preventDefault(); run(); }} sx={{ display: "flex", alignItems: "center", gap: 1, pl: 2, pr: 0.75, height: home ? { xs: 54, xl: 60 } : 58, borderRadius: home ? "14px" : "16px", backgroundColor: home ? alpha(theme.palette.primary.main, theme.palette.mode === "dark" ? 0.12 : 0.06) : k.surface, border: `1px solid ${home ? alpha(theme.palette.primary.main, theme.palette.mode === "dark" ? 0.35 : 0.2) : k.line}`, boxShadow: home ? "none" : k.float, transition: "border-color 120ms, box-shadow 120ms, background-color 120ms", "&:focus-within": { backgroundColor: k.surface, borderColor: k.accent, boxShadow: `${k.float}, 0 0 0 4px ${alpha(theme.palette.primary.main, 0.14)}` } }}>
        <SearchIcon aria-hidden sx={{ fontSize: 22, color: home ? "primary.main" : k.ink3 }} />
        <InputBase autoFocus={autoFocus} fullWidth value={query} onChange={(e) => setQuery(e.target.value.slice(0, 200))} placeholder={t("findNetwork.placeholder")} inputProps={{ "data-testid": "find-network-query", "aria-label": t("findNetwork.placeholder") }} sx={{ fontSize: { xs: "1rem", xl: "1.06rem" }, color: k.ink }} />
        <Button type="submit" variant="contained" disableElevation disabled={query.trim().length < 2 || search.status === "loading"} startIcon={<SearchIcon />} data-testid="find-network-search" sx={{ height: { xs: 40, xl: 44 }, px: { xs: 2.25, xl: 2.75 }, borderRadius: "11px", textTransform: "none", fontWeight: 600, flexShrink: 0, ...(home ? { "&.Mui-disabled": { backgroundColor: alpha(theme.palette.primary.main, 0.45), color: theme.palette.primary.contrastText } } : {}) }}>
          {t("findNetwork.search")}
        </Button>
      </Box>
      {chips.length > 0 && (
        <Box data-testid="find-network-recent" sx={{ display: "flex", alignItems: "center", flexWrap: "wrap", gap: 0.75, justifyContent: home ? "flex-start" : "center" }}>
          <Typography component="span" sx={{ display: "inline-flex", alignItems: "center", gap: 0.5, fontSize: "0.76rem", color: k.ink3 }}>
            <HistoryRoundedIcon aria-hidden sx={{ fontSize: 15 }} />
            {t("findNetwork.recent")}
          </Typography>
          {chips.map((p) => (
            <Box key={p} data-testid="find-network-recent-chip" sx={{ display: "inline-flex", alignItems: "center", height: 30, borderRadius: 999, border: `1px solid ${k.line}`, backgroundColor: k.surface, overflow: "hidden", "&:hover": { borderColor: k.accent } }}>
              <ButtonBase onClick={() => run(p)} disabled={search.status === "loading" || busy} data-testid="find-network-recent-place" sx={{ height: "100%", pl: 1.25, pr: 0.5, fontSize: "0.8rem", color: k.ink, "&:hover": { color: k.accent } }}>
                {p}
              </ButtonBase>
              {/* Forgets this search (this browser only). */}
              <ButtonBase onClick={() => setRecent(forgetPlace(p))} aria-label={t("findNetwork.recentForget", { place: p })} title={t("findNetwork.recentForget", { place: p })} data-testid="find-network-recent-forget" sx={{ height: "100%", px: 0.75, color: k.ink3, "&:hover": { color: k.ink } }}>
                <CloseRoundedIcon sx={{ fontSize: 14 }} />
              </ButtonBase>
            </Box>
          ))}
        </Box>
      )}
      {search.status === "idle" && !chips.length && <Typography sx={{ textAlign: home ? "left" : "center", fontSize: "0.76rem", color: k.ink3, lineHeight: 1.5, pl: home ? 0.5 : 0 }}>{t(home ? "findNetwork.hintShort" : "findNetwork.hint")}</Typography>}
    </Box>
  );

  const status = (
    <>
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
        <Typography data-testid="find-network-none" sx={{ textAlign: home ? "left" : "center", fontSize: "0.84rem", color: k.ink2, lineHeight: 1.55, px: home ? 0 : 2 }}>
          {t("findNetwork.none", { place: search.place })}
        </Typography>
      )}
    </>
  );

  const results = search.status === "done" && search.feeds.length > 0 && (
    <Box sx={{ display: "flex", flexDirection: "column", gap: 1 }}>
      <Typography sx={{ fontSize: "0.78rem", fontWeight: 600, color: k.ink2 }}>{t("findNetwork.found", { count: search.feeds.length, place: search.place })}</Typography>
      <Box sx={{ display: "grid", gridTemplateColumns: { xs: "1fr", md: search.feeds.length > 1 ? "repeat(2, minmax(0, 1fr))" : "1fr", [home ? "lg" : "xl"]: search.feeds.length > 2 ? "repeat(3, minmax(0, 1fr))" : search.feeds.length > 1 ? "repeat(2, minmax(0, 1fr))" : "1fr" }, gap: 1.25 }}>
        {search.feeds.map((f) => {
          const title = feedTitle(f);
          const detail = feedDetail(f, t, language);
          const valid = validityOf(f, t, language);
          const licence = licenceOf(f);
          const Icon = isRailFeed(f) ? TrainOutlinedIcon : DirectionsBusFilledOutlinedIcon;
          const isOpening = Boolean(opening) && opening.url === f.url;
          const failed = openError?.url === f.url ? openError.error : null;
          return (
            <Box key={f.id || f.url} data-testid="find-network-row" data-status={f.status || ""} aria-busy={isOpening || undefined} sx={{ position: "relative", overflow: "hidden", p: 1.75, borderRadius: "14px", display: "flex", flexDirection: "column", gap: 1.25, transition: "border-color .15s, box-shadow .15s, background-color .15s", ...(home ? homeRowSx(theme, k, isOpening) : { border: `1px solid ${isOpening ? k.accent : k.line}`, backgroundColor: k.surface, boxShadow: isOpening ? k.float : k.raise, "&:hover": { borderColor: k.accentLine, boxShadow: k.float } }) }}>
              {/* The opening's progress runs along the card's top edge: the card keeps its layout while it waits. */}
              {isOpening && <LinearProgress aria-hidden sx={{ position: "absolute", top: 0, left: 0, right: 0, height: 3 }} />}
              <Box sx={{ display: "flex", alignItems: "flex-start", gap: 1.25 }}>
                <Box aria-hidden sx={{ width: 36, height: 36, flexShrink: 0, borderRadius: "10px", display: "flex", alignItems: "center", justifyContent: "center", color: home ? theme.palette.primary.contrastText : k.accent, backgroundColor: home ? theme.palette.primary.main : k.accentSoft }}>
                  <Icon sx={{ fontSize: 19 }} />
                </Box>
                {home && f.page_url && (
                  <IconButton component="a" href={f.page_url} target="_blank" rel="noreferrer" size="small" aria-label={t("feeds.page")} title={t("feeds.page")} data-testid="find-network-page" sx={{ order: 1, mt: -0.5, mr: -0.5, color: k.ink3, "&:hover": { color: k.accent } }}>
                    <OpenInNewRoundedIcon sx={{ fontSize: 17 }} />
                  </IconButton>
                )}
                <Box sx={{ flex: 1, minWidth: 0 }}>
                  <Typography sx={{ fontSize: "0.92rem", fontWeight: 600, color: k.ink, lineHeight: 1.3 }} title={`${title}${f.provider && f.provider !== title ? ` — ${f.provider}` : ""}`}>
                    {title}
                  </Typography>
                  {f.provider && f.provider !== title && <Typography sx={{ fontSize: "0.76rem", color: k.ink2 }}>{f.provider}</Typography>}
                  <Box sx={{ display: "flex", alignItems: "center", gap: 0.5, flexWrap: "wrap", mt: 0.5 }}>
                    {f.scope && <Tag>{t(`feeds.scope.${f.scope}`)}</Tag>}
                    {valid?.expired && <Tag color={theme.palette.warning.dark}>{t("feeds.expiredTag")}</Tag>}
                    {/* The reuse terms travel with the network: a modified network delivered stays under them. */}
                    {licence && (
                      <Tag color={k.ink2}>
                        <Link href={licence.url} target="_blank" rel="noopener noreferrer" underline="hover" color="inherit" title={licence.name ? t("feeds.licence.title", { name: licence.name }) : t("feeds.licence.termsTitle")} data-testid="find-network-licence">
                          {!licence.name ? t("feeds.licence.terms") : /^licen/i.test(licence.name) ? licence.name : t("feeds.licence.tag", { name: licence.name })}
                        </Link>
                      </Tag>
                    )}
                  </Box>
                </Box>
              </Box>
              <Box sx={{ display: "flex", flexDirection: "column", gap: 0.25 }}>
                {detail && <Typography title={home ? detail : undefined} sx={{ fontSize: "0.76rem", color: k.ink2, ...(home ? { display: "-webkit-box", WebkitLineClamp: 2, WebkitBoxOrient: "vertical", overflow: "hidden" } : {}) }}>{detail}</Typography>}
                {valid && (
                  <Typography data-testid="find-network-validity" sx={{ fontSize: "0.76rem", color: valid.color, fontWeight: valid.expired ? 600 : 400 }}>
                    {valid.text}
                    {valid.expired ? ` — ${t("findNetwork.expiredHint")}` : ""}
                  </Typography>
                )}
              </Box>
              {failed && <ErrorNotice error={failed} onRetry={() => openFeed(f, opening?.intent || (home ? "read" : "modify"))} testid="find-network-open-error" />}
              {/* One row that never moves: the page's link, or the opening's short status, takes what the buttons leave;
                  the button chosen keeps its look and shows its spinner, the other waits. */}
              <Box sx={{ display: "flex", alignItems: "center", gap: 1, mt: "auto", minHeight: 36 }}>
                <Box sx={{ flex: home && !isOpening ? 0 : 1, minWidth: 0 }}>
                  {isOpening ? (
                    <Typography role="status" title={t("findNetwork.opening", { seconds: openSeconds })} data-testid="find-network-opening" sx={{ fontSize: "0.76rem", fontWeight: 600, color: k.accent, whiteSpace: "nowrap", overflow: "hidden", textOverflow: "ellipsis" }}>
                      {t("findNetwork.openingShort", { seconds: openSeconds })}
                    </Typography>
                  ) : (
                    !home &&
                    f.page_url && (
                      <Link href={f.page_url} target="_blank" rel="noreferrer" underline="hover" sx={{ fontSize: "0.74rem", color: k.ink2, whiteSpace: "nowrap" }}>
                        {t("feeds.page")}
                      </Link>
                    )
                  )}
                </Box>
                {home && (
                  <Button
                    variant="outlined"
                    disabled={busy && !(isOpening && opening.intent === "read")}
                    aria-disabled={busy || undefined}
                    onClick={() => openFeed(f, "read")}
                    startIcon={isOpening && opening.intent === "read" ? <CircularProgress size={14} color="inherit" /> : <VisibilityOutlinedIcon sx={{ fontSize: "17px !important" }} />}
                    data-testid="find-network-read"
                    sx={{ flex: "1 1 0", minWidth: 0, textTransform: "none", fontWeight: 600, borderRadius: "10px", px: 1.5, whiteSpace: "nowrap", backgroundColor: k.surface }}
                  >
                    {t("findNetwork.explore")}
                  </Button>
                )}
                <Button
                  variant="contained"
                  disableElevation
                  disabled={busy && !(isOpening && opening.intent === "modify")}
                  aria-disabled={busy || undefined}
                  onClick={() => openFeed(f, "modify")}
                  startIcon={home ? (isOpening && opening.intent === "modify" ? <CircularProgress size={14} color="inherit" /> : modifyLocked ? <LockOutlinedIcon sx={{ fontSize: "17px !important" }} /> : <EditRoadOutlinedIcon sx={{ fontSize: "17px !important" }} />) : undefined}
                  endIcon={home ? undefined : isOpening ? <CircularProgress size={14} color="inherit" /> : <ArrowForwardRoundedIcon sx={{ fontSize: "17px !important" }} />}
                  data-testid="find-network-open"
                  sx={{ ...(home ? { flex: "1 1 0", minWidth: 0 } : { flexShrink: 0 }), textTransform: "none", fontWeight: 600, borderRadius: "10px", px: 1.75, whiteSpace: "nowrap" }}
                >
                  {t(home ? "findNetwork.modify" : "findNetwork.choose")}
                </Button>
              </Box>
            </Box>
          );
        })}
      </Box>
      {sources.length > 0 && <Typography sx={{ fontSize: "0.68rem", color: k.ink3 }}>{t("feeds.sources", { sources: sources.join(" · ") })}</Typography>}
    </Box>
  );

  if (home) {
    // Home's head: its question (`heading`) over one card — the town's search, « ou », the person's file (its reading
    // under it, `fileFoot`) —, the reader's picture beside them (`aside`), the promises (`trust`) under both; the
    // networks found under the head, in a panel of their own brought into view.
    return (
      <Box component="section" aria-labelledby={labelledBy || undefined} data-testid="find-network" data-intent="home" sx={{ width: "100%", display: "flex", flexDirection: "column", gap: { xs: 3, md: 4 }, ...sx }}>
        {/* The card and the picture's frame end on one line (the picture's caption hangs under it, in the room kept below). */}
        <Box sx={{ display: "grid", gridTemplateColumns: { xs: "minmax(0, 1fr)", md: "minmax(0, 0.95fr) minmax(0, 1.05fr)" }, columnGap: { md: 5, xl: 8 }, rowGap: 4, alignItems: "end", pb: { md: 7 } }}>
          <Box sx={{ display: "flex", flexDirection: "column", gap: { xs: 2.5, md: 3 }, minWidth: 0 }}>
            {heading}
            <Box data-testid="home-find-card" sx={{ display: "flex", flexDirection: "column", gap: 1.5, p: { xs: 2, md: 2.5 }, borderRadius: "22px", backgroundColor: theme.palette.background.paper, border: `1px solid ${theme.palette.mode === "dark" ? alpha("#fff", 0.1) : "transparent"}`, boxShadow: "0 30px 70px rgba(2, 8, 23, 0.35), 0 2px 6px rgba(2, 8, 23, 0.12)" }}>
              {searchBlock}
              {status}
              <Box aria-hidden sx={{ display: "flex", alignItems: "center", gap: 1.5, color: k.ink3, fontSize: "0.74rem", my: 0.25, "&::before, &::after": { content: '""', flex: 1, height: "1px", backgroundColor: theme.palette.mode === "dark" ? alpha(theme.palette.text.primary, 0.14) : k.line } }}>
                {t("findNetwork.or")}
              </Box>
              <HomeFile onExplore={onExploreFile} onModify={onModifyFile} modifyLocked={modifyLocked} disabled={busy} k={k} t={t} language={language} />
              {fileFoot}
            </Box>
          </Box>
          <Box sx={{ minWidth: 0 }}>{aside}</Box>
        </Box>
        {trust}
        {results && (
          <Box ref={resultsRef} data-testid="find-network-results" sx={{ scrollMarginTop: 88, p: { xs: 2, md: 2.5 }, borderRadius: "22px", backgroundColor: theme.palette.background.paper, boxShadow: "0 30px 70px rgba(2, 8, 23, 0.3)" }}>
            {results}
          </Box>
        )}
      </Box>
    );
  }

  return (
    <Box component="section" aria-labelledby="find-network-title" data-testid="find-network" sx={{ width: "100%", maxWidth: 880, mx: "auto", pt: { xs: 2, md: "clamp(16px, 7vh, 72px)" }, pb: 4, display: "flex", flexDirection: "column", gap: 2.5, ...sx }}>
      {question}
      {searchBlock}
      {status}
      {results}
      {(onUploadInstead || onDropFile) && (
        <Box sx={{ display: "flex", flexDirection: "column", gap: 1.25 }}>
          <Box aria-hidden sx={{ display: "flex", alignItems: "center", gap: 1.5, color: k.ink3, fontSize: "0.74rem", "&::before, &::after": { content: '""', flex: 1, height: "1px", backgroundColor: theme.palette.mode === "dark" ? alpha(theme.palette.text.primary, 0.16) : k.line } }}>
            {t("findNetwork.or")}
          </Box>
          <FileDrop onPick={onUploadInstead} onDrop={onDropFile} disabled={busy} k={k} t={t} />
        </Box>
      )}
      {/* What the person can count on, and where this leads */}
      <Box sx={{ display: "flex", alignItems: "flex-start", justifyContent: "center", gap: 0.75, color: k.ink2 }}>
        <ShieldOutlinedIcon aria-hidden sx={{ fontSize: 16, mt: "1px", color: k.success }} />
        <Typography sx={{ fontSize: "0.76rem", lineHeight: 1.5 }}>
          {t("findNetwork.asIs")} {t("findNetwork.briefLater")}
        </Typography>
      </Box>
      <JourneyHow k={k} t={t} />
    </Box>
  );
}
