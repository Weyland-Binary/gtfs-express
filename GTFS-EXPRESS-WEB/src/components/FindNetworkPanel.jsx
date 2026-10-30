/**
 * Where a network is found: a town's published GTFS feeds or the person's own zip. On Home (`intent` "home")
 * each one is explored or modified, the search's wait and answer handed to `aside(screen)` (Home's computer
 * screen); in a modify project's first step (`intent` "modify") one is chosen as v0.
 * A catalogue feed is opened as it is, every trip, variant and calendar exception kept.
 */

import React, { useCallback, useEffect, useRef, useState } from "react";
import { Box, Button, ButtonBase, CircularProgress, IconButton, InputBase, LinearProgress, Link, Tooltip, Typography, alpha, useMediaQuery, useTheme } from "@mui/material";
import { keyframes } from "@mui/system";
import OpenInNewRoundedIcon from "@mui/icons-material/OpenInNewRounded";
import SearchIcon from "@mui/icons-material/Search";
import HistoryRoundedIcon from "@mui/icons-material/HistoryRounded";
import CloseRoundedIcon from "@mui/icons-material/CloseRounded";
import DirectionsBusFilledOutlinedIcon from "@mui/icons-material/DirectionsBusFilledOutlined";
import TrainOutlinedIcon from "@mui/icons-material/TrainOutlined";
import CloudUploadOutlinedIcon from "@mui/icons-material/CloudUploadOutlined";
import ArrowForwardRoundedIcon from "@mui/icons-material/ArrowForwardRounded";
import ShieldOutlinedIcon from "@mui/icons-material/ShieldOutlined";
import TravelExploreOutlinedIcon from "@mui/icons-material/TravelExploreOutlined";
import { useLanguage } from "../contexts/LanguageContext";
import { countWords } from "../utils/countWords";
import { fetchCatalog, openCatalogFeed } from "../utils/catalogApi";
import ErrorNotice from "./common/ErrorNotice";
import useElapsed from "./common/useElapsed";
import { Tag } from "./common/Tag";
import { visuallyHidden } from "./common/StatusBar";
import { tokensOf } from "./studio/studioTheme";
import { feedDetail, feedTitle, isRailFeed, licenceOf, validityOf } from "../utils/feedInfo";
import { beginOpening, useNetworkOpening } from "../utils/networkOpening";

// The places searched lately, offered as chips; the field itself starts empty.
const PLACES_KEY = "gtfs:find-network-places";
const MAX_RECENT = 5;
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
    localStorage.setItem(PLACES_KEY, JSON.stringify(recent));
  } catch {
    /* storage disabled */
  }
  return recent;
};
const forgetPlace = (place) => {
  const recent = readRecent().filter((p) => p.toLowerCase() !== String(place).toLowerCase());
  try {
    localStorage.setItem(PLACES_KEY, JSON.stringify(recent));
  } catch {
    /* storage disabled */
  }
  return recent;
};


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

// What Home draws in white on the head's blue: the card in glass, its drop zone, its buttons.
const glassOf = (theme) => {
  const dark = theme.palette.mode === "dark";
  const white = theme.palette.common.white;
  const shadow = theme.palette.common.black;
  return {
    white,
    soft: alpha(white, 0.92),
    ring: { outline: `2px solid ${white}`, outlineOffset: 2 },
    card: { backgroundColor: alpha(white, dark ? 0.06 : 0.1), border: `1px solid ${alpha(white, dark ? 0.16 : 0.26)}`, backdropFilter: "blur(10px)", boxShadow: `0 24px 50px ${alpha(shadow, dark ? 0.4 : 0.28)}` },
    disc: { borderRadius: "50%", display: "flex", alignItems: "center", justifyContent: "center", flexShrink: 0, color: dark ? theme.palette.primary.contrastText : theme.palette.primary.main, backgroundColor: dark ? theme.palette.primary.main : white, boxShadow: `0 6px 16px ${alpha(shadow, 0.25)}` },
    solid: { color: dark ? theme.palette.primary.contrastText : theme.palette.primary.dark, backgroundColor: dark ? theme.palette.primary.main : white, "&:hover": { backgroundColor: dark ? theme.palette.primary.light : alpha(white, 0.9) } },
    outlined: { color: white, borderColor: alpha(white, 0.6), "&:hover": { borderColor: white, backgroundColor: alpha(white, 0.1) } },
  };
};

/**
 * Home's card: the search, then the person's zip, dropped anywhere on the card or chosen with « Parcourir », and opened
 * at once. `blocked`: a network is opening in the screen; a second one would race it, so the file is refused, said why.
 */
function HomeCard({ search, foot, onExplore, disabled, blocked = false, t }) {
  const theme = useTheme();
  const g = glassOf(theme);
  const dark = theme.palette.mode === "dark";
  const inputRef = useRef(null);
  const [over, setOver] = useState(false);
  const [refused, setRefused] = useState(null); // null | "zip" | "busy"
  const take = (f) => {
    if (!f) return;
    if (blocked) return setRefused("busy");
    setRefused(isZip(f) ? null : "zip");
    if (isZip(f)) onExplore?.(f);
  };
  useEffect(() => {
    if (!blocked) setRefused((r) => (r === "busy" ? null : r));
  }, [blocked]);
  const why = blocked ? t("home.opening.busy") : "";
  // A disabled control gets no pointer events: its reason is held by the span around it.
  const said = (control, block = false) => (
    <Tooltip title={why} disableInteractive>
      <Box component="span" sx={{ display: block ? "block" : "inline-flex", width: block ? "100%" : undefined }}>
        {control}
      </Box>
    </Tooltip>
  );
  const row = { width: "100%", minHeight: 64, boxSizing: "border-box", display: "flex", alignItems: "center", gap: 1.75, pl: 1.5, pr: 1.25, py: 1, borderRadius: "14px", textAlign: "left" };
  return (
    <Box
      data-testid="home-find-card"
      data-over={over ? "true" : undefined}
      onDragOver={(e) => {
        // Text dragged from the field is no file to open.
        if (disabled || (e.dataTransfer?.types && !Array.from(e.dataTransfer.types).includes("Files"))) return;
        // Held even while blocked: a file dropped on a page that does not take it is opened by the browser.
        e.preventDefault();
        if (!blocked) setOver(true);
      }}
      onDragLeave={(e) => {
        if (!e.currentTarget.contains(e.relatedTarget)) setOver(false);
      }}
      onDrop={(e) => {
        if (disabled) return;
        e.preventDefault();
        setOver(false);
        take(e.dataTransfer?.files?.[0] || null);
      }}
      data-blocked={blocked ? "true" : undefined}
      sx={{ position: "relative", p: { xs: 2, md: 2.25 }, borderRadius: "20px", ...g.card }}
    >
      <Box sx={{ display: "flex", flexDirection: "column", gap: 1.5, visibility: over ? "hidden" : "visible" }}>
        {search}
        <input ref={inputRef} type="file" hidden accept=".zip,application/zip" data-testid="find-network-file-input" onChange={(e) => { take(e.target.files?.[0] || null); e.target.value = ""; }} />
        {said(
          <ButtonBase
            onClick={() => inputRef.current?.click()}
            disabled={disabled || blocked}
            data-testid="find-network-upload"
            sx={{
              ...row,
              border: `2px dashed ${alpha(g.white, dark ? 0.45 : 0.62)}`,
              backgroundColor: alpha(g.white, dark ? 0.04 : 0.07),
              transition: "border-color .15s, background-color .15s",
              "@media (hover: hover)": { "&:hover": { borderColor: g.white, backgroundColor: alpha(g.white, 0.12) } },
              "&.Mui-focusVisible": g.ring,
            }}
          >
            <Box aria-hidden sx={{ ...g.disc, width: 40, height: 40 }}>
              <CloudUploadOutlinedIcon sx={{ fontSize: 22 }} />
            </Box>
            <Typography sx={{ flex: 1, minWidth: 0, fontSize: "0.97rem", color: g.white }}>
              <Box component="span" sx={{ color: g.soft }}>
                {t("findNetwork.or")}{" "}
              </Box>
              <Box component="strong" sx={{ fontWeight: 700 }}>
                {t("findNetwork.drop.homeOr")}
              </Box>
            </Typography>
            <Box component="span" sx={{ flexShrink: 0, height: 38, display: "inline-flex", alignItems: "center", px: 1.75, borderRadius: "10px", fontSize: "0.875rem", fontWeight: 700, ...g.solid }}>
              {t("findNetwork.drop.browse")}
            </Box>
          </ButtonBase>,
          true,
        )}
        {refused && (
          <Typography role="alert" data-testid="find-network-upload-refused" data-reason={refused} sx={{ alignSelf: "flex-start", px: 1.25, py: 0.5, borderRadius: "8px", fontSize: "0.78rem", fontWeight: 600, color: refused === "busy" ? theme.palette.warning.contrastText : theme.palette.error.contrastText, backgroundColor: refused === "busy" ? theme.palette.warning.main : theme.palette.error.main }}>
            {refused === "busy" ? t("home.opening.busy") : t("findNetwork.drop.notZip")}
          </Typography>
        )}
        {foot}
      </Box>
      {over && (
        <Box aria-hidden data-testid="find-network-drop-target" sx={{ position: "absolute", inset: 0, borderRadius: "inherit", border: `2.5px dashed ${g.white}`, backgroundColor: alpha(g.white, 0.16), boxShadow: `0 0 0 8px ${alpha(g.white, 0.08)}`, display: "flex", flexDirection: "column", alignItems: "center", justifyContent: "center", gap: 1.5, pointerEvents: "none" }}>
          <Box sx={{ ...g.disc, width: 66, height: 66 }}>
            <CloudUploadOutlinedIcon sx={{ fontSize: 32 }} />
          </Box>
          <Typography sx={{ fontSize: "1.2rem", fontWeight: 700, color: g.white }}>{t("findNetwork.drop.active")}</Typography>
        </Box>
      )}
    </Box>
  );
}

const rowIn = keyframes`
  from { opacity: 0; transform: translateY(6px); }
  to   { opacity: 1; transform: none; }
`;

/** A network found, as Home's computer screen lists it, explored for free. */
function ScreenRow({ feed: f, index, opening, failed, busy, openSeconds, onOpen, k, t, language }) {
  const theme = useTheme();
  const title = feedTitle(f);
  const detail = feedDetail(f, t, language);
  const valid = validityOf(f, t, language);
  const licence = licenceOf(f);
  const Icon = isRailFeed(f) ? TrainOutlinedIcon : DirectionsBusFilledOutlinedIcon;
  const isOpening = Boolean(opening) && opening.url === f.url;
  const provider = f.provider && f.provider !== title ? f.provider : null;
  const button = { textTransform: "none", fontWeight: 600, borderRadius: "9px", px: 1.25, whiteSpace: "nowrap" };
  const glyph = { fontSize: "16px !important" };
  return (
    <Box
      component="li"
      data-testid="find-network-row"
      data-status={f.status || ""}
      aria-busy={isOpening || undefined}
      sx={{ position: "relative", display: "flex", flexWrap: "wrap", alignItems: "center", columnGap: 1.5, rowGap: 1, px: 2, py: 1.25, borderTop: index ? `1px solid ${k.line}` : "none", animation: `${rowIn} .35s ease-out ${index * 0.07}s both`, "@media (prefers-reduced-motion: reduce)": { animation: "none" } }}
    >
      {isOpening && <LinearProgress aria-hidden sx={{ position: "absolute", top: 0, left: 0, right: 0, height: 3 }} />}
      <Box aria-hidden sx={{ width: 34, height: 34, flexShrink: 0, borderRadius: "9px", display: "flex", alignItems: "center", justifyContent: "center", color: theme.palette.primary.contrastText, backgroundColor: theme.palette.primary.main }}>
        <Icon sx={{ fontSize: 18 }} />
      </Box>
      <Box sx={{ flex: "1 1 220px", minWidth: 0 }}>
        <Box title={[title, provider, detail].filter(Boolean).join(" · ")} sx={{ display: "flex", alignItems: "baseline", gap: 1, minWidth: 0 }}>
          <Typography sx={{ flexShrink: 0, maxWidth: "100%", fontSize: "0.9rem", fontWeight: 700, color: k.ink, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{title}</Typography>
          {provider && <Typography sx={{ minWidth: 0, fontSize: "0.76rem", color: k.ink2, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{provider}</Typography>}
        </Box>
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
          {isOpening ? (
            <Typography role="status" title={t("findNetwork.opening", { seconds: openSeconds })} data-testid="find-network-opening" sx={{ fontSize: "0.74rem", fontWeight: 600, color: k.accent, whiteSpace: "nowrap" }}>
              {t("findNetwork.openingShort", { seconds: openSeconds })}
            </Typography>
          ) : (
            valid && (
              <Typography data-testid="find-network-validity" title={valid.expired ? t("findNetwork.expiredHint") : undefined} sx={{ fontSize: "0.74rem", color: valid.color, fontWeight: valid.expired ? 600 : 500 }}>
                {valid.text}
              </Typography>
            )
          )}
          {f.page_url && (
            <IconButton component="a" href={f.page_url} target="_blank" rel="noreferrer" size="small" aria-label={t("feeds.page")} title={t("feeds.page")} data-testid="find-network-page" sx={{ p: 0.25, color: k.ink3, "&:hover": { color: k.accent } }}>
              <OpenInNewRoundedIcon sx={{ fontSize: 15 }} />
            </IconButton>
          )}
        </Box>
      </Box>
      <Box sx={{ display: "flex", alignItems: "center", gap: 0.75, ml: "auto", flexShrink: 0 }}>
        <Button size="small" variant="contained" disableElevation disabled={busy && !isOpening} aria-disabled={busy || undefined} onClick={() => onOpen(f, "read")} startIcon={isOpening ? <CircularProgress size={14} color="inherit" /> : <TravelExploreOutlinedIcon sx={glyph} />} data-testid="find-network-read" sx={button}>
          {t("findNetwork.explore")}
        </Button>
      </Box>
      {failed && <ErrorNotice error={failed.error} onRetry={() => onOpen(f, failed.intent)} testid="find-network-open-error" sx={{ flexBasis: "100%" }} />}
    </Box>
  );
}

export default function FindNetworkPanel({ onOpened, onConsult = null, intent = "modify", onUploadInstead = null, onDropFile = null, onExploreFile = null, autoFocus = true, labelledBy = null, heading = null, aside = null, trust = null, fileFoot = null, sx = {} }) {
  const home = intent === "home";
  const queryRef = useRef(null);
  const { t, language } = useLanguage();
  const theme = useTheme();
  const k = tokensOf(theme);
  const [query, setQuery] = useState("");
  const [recent, setRecent] = useState(readRecent);
  const [search, setSearch] = useState({ status: "idle", place: "", feeds: [], sources: null, error: null });
  const [opening, setOpening] = useState(null);
  const [openError, setOpenError] = useState(null);
  const abortRef = useRef(null);
  const asideRef = useRef(null);
  const elsewhere = useNetworkOpening();
  const searchSeconds = useElapsed(search.status === "loading");
  const openSeconds = useElapsed(Boolean(opening));
  // Under Home's two columns the screen sits below the card, out of sight: each search's answer is brought to it.
  const stacked = useMediaQuery(theme.breakpoints.down("md"));
  const reducedMotion = useMediaQuery("(prefers-reduced-motion: reduce)");

  useEffect(() => () => abortRef.current?.abort(), []);
  useEffect(() => {
    if (!home || !stacked || (search.status !== "done" && search.status !== "error")) return;
    asideRef.current?.scrollIntoView?.({ block: "nearest", behavior: reducedMotion ? "auto" : "smooth" });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [search]);

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
        // light: the place alone, without the territory dossier, so the search answers in seconds.
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
  // Home: the screen goes back to the product's screens, the field ready for another place.
  const back = () => {
    if (opening) return;
    abortRef.current?.abort();
    setSearch({ status: "idle", place: "", feeds: [], sources: null, error: null });
    setOpenError(null);
    queryRef.current?.focus();
  };

  const openFeed = async (feed, want = "modify") => {
    if (opening) return;
    // On Home the opening shows in the computer's screen; explored, that screen then grows into the reader. Another
    // opening already there keeps it.
    const shown = home ? beginOpening({ kind: "feed", name: feedTitle(feed) || null }) : null;
    if (home && !shown) return;
    setOpening({ url: feed.url, intent: want });
    setOpenError(null);
    try {
      const r = await openCatalogFeed(feed.url, { name: feedTitle(feed) || null, place: search.place || null, headers: shown?.headers || null });
      if (want === "read") {
        shown?.finish();
        onConsult?.({ ...r, openedFeed: { name: feedTitle(feed) } });
      } else {
        shown?.end();
        onOpened({ ...r, openedFeed: { name: feedTitle(feed) }, openChangeStudio: true });
      }
    } catch (err) {
      shown?.end();
      setOpenError({ url: feed.url, intent: want, error: err });
    } finally {
      setOpening(null);
    }
  };

  const sources = search.sources ? [search.sources.pan?.ok ? t("feeds.pan") : null, search.sources.mdb?.ok ? t("feeds.mdb") : null].filter(Boolean) : [];
  // Home keeps every recent place in sight while its screen answers, so the card keeps its height.
  const chips = home ? recent : recent.filter((p) => p.toLowerCase() !== search.place.toLowerCase() || search.status === "idle");
  const busy = Boolean(opening);
  const g = home ? glassOf(theme) : null;
  const shadow = theme.palette.common.black;

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
      <Box component="form" role="search" onSubmit={(e) => { e.preventDefault(); if (query.trim().length < 2) queryRef.current?.focus(); else run(); }} sx={{ display: "flex", alignItems: "center", gap: 1, pl: 2, pr: 0.75, height: home ? { xs: 54, xl: 60 } : 58, borderRadius: home ? "14px" : "16px", backgroundColor: k.surface, transition: "border-color 120ms, box-shadow 120ms, background-color 120ms", ...(home ? { border: "1px solid transparent", boxShadow: `0 10px 24px ${alpha(shadow, 0.22)}`, "&:focus-within": { boxShadow: `0 10px 24px ${alpha(shadow, 0.22)}, 0 0 0 4px ${alpha(g.white, 0.4)}` } } : { border: `1px solid ${k.line}`, boxShadow: k.float, "&:focus-within": { backgroundColor: k.surface, borderColor: k.accent, boxShadow: `${k.float}, 0 0 0 4px ${alpha(theme.palette.primary.main, 0.14)}` } }) }}>
        <SearchIcon aria-hidden sx={{ fontSize: 22, color: home ? k.ink2 : k.ink3 }} />
        <InputBase inputRef={queryRef} autoFocus={autoFocus} fullWidth value={query} onChange={(e) => setQuery(e.target.value.slice(0, 200))} placeholder={t("findNetwork.placeholder")} inputProps={{ "data-testid": "find-network-query", "aria-label": t("findNetwork.placeholder") }} sx={{ fontSize: { xs: "1rem", xl: "1.06rem" }, color: k.ink }} />
        <Button type="submit" variant="contained" disableElevation disabled={search.status === "loading" || (!home && query.trim().length < 2)} startIcon={<SearchIcon />} data-testid="find-network-search" sx={{ height: { xs: 40, xl: 44 }, px: { xs: 2.25, xl: 2.75 }, borderRadius: "11px", textTransform: "none", fontWeight: 600, flexShrink: 0, ...(home ? { "&.Mui-disabled": { backgroundColor: alpha(theme.palette.primary.main, 0.45), color: theme.palette.primary.contrastText } } : {}) }}>
          {t("findNetwork.search")}
        </Button>
      </Box>
      {chips.length > 0 && (
        <Box data-testid="find-network-recent" sx={{ display: "flex", alignItems: "center", flexWrap: "wrap", gap: 0.75, justifyContent: home ? "flex-start" : "center" }}>
          <Typography component="span" sx={{ display: "inline-flex", alignItems: "center", gap: 0.5, fontSize: "0.76rem", color: home ? g.soft : k.ink3 }}>
            <HistoryRoundedIcon aria-hidden sx={{ fontSize: 15 }} />
            {t("findNetwork.recent")}
          </Typography>
          {chips.map((p) => (
            <Box key={p} data-testid="find-network-recent-chip" sx={{ display: "inline-flex", alignItems: "center", height: home ? 32 : 30, borderRadius: 999, overflow: "hidden", ...(home ? { border: `1px solid ${alpha(g.white, 0.3)}`, backgroundColor: alpha(g.white, 0.12), "&:hover": { borderColor: g.white } } : { border: `1px solid ${k.line}`, backgroundColor: k.surface, "&:hover": { borderColor: k.accent } }) }}>
              <ButtonBase onClick={() => run(p)} disabled={search.status === "loading" || busy} data-testid="find-network-recent-place" sx={{ height: "100%", pl: 1.25, pr: 0.5, fontSize: "0.8rem", ...(home ? { fontWeight: 600, color: g.white, "&.Mui-focusVisible": g.ring } : { color: k.ink, "&:hover": { color: k.accent } }) }}>
                {p}
              </ButtonBase>
              <ButtonBase onClick={() => setRecent(forgetPlace(p))} aria-label={t("findNetwork.recentForget", { place: p })} title={t("findNetwork.recentForget", { place: p })} data-testid="find-network-recent-forget" sx={{ height: "100%", px: 0.75, ...(home ? { color: g.soft, "&:hover": { color: g.white }, "&.Mui-focusVisible": g.ring } : { color: k.ink3, "&:hover": { color: k.ink } }) }}>
                <CloseRoundedIcon sx={{ fontSize: 14 }} />
              </ButtonBase>
            </Box>
          ))}
        </Box>
      )}
      {(home || search.status === "idle") && !chips.length && <Typography sx={{ textAlign: home ? "left" : "center", fontSize: "0.76rem", color: home ? g.soft : k.ink3, lineHeight: 1.5, ...(home ? { pl: 0.5, minHeight: 32, display: "flex", alignItems: "center" } : {}) }}>{t(home ? "findNetwork.hintShort" : "findNetwork.hint")}</Typography>}
    </Box>
  );

  const status = !home && (
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
        <Typography data-testid="find-network-none" sx={{ textAlign: "center", fontSize: "0.84rem", color: k.ink2, lineHeight: 1.55, px: 2 }}>
          {t("findNetwork.none", { place: search.place })}
        </Typography>
      )}
    </>
  );

  const found = search.status === "done" ? search.feeds.length : 0;
  const foundWords = found ? countWords(t, "findNetwork.found", found, { place: search.place }) : "";
  const sourcesLine = sources.length > 0 ? t("feeds.sources", { sources: sources.join(" · ") }) : "";

  const results = !home && found > 0 && (
    <Box sx={{ display: "flex", flexDirection: "column", gap: 1 }}>
      <Typography sx={{ fontSize: "0.78rem", fontWeight: 600, color: k.ink2 }}>{foundWords}</Typography>
      <Box sx={{ display: "grid", gridTemplateColumns: { xs: "1fr", md: found > 1 ? "repeat(2, minmax(0, 1fr))" : "1fr", xl: found > 2 ? "repeat(3, minmax(0, 1fr))" : found > 1 ? "repeat(2, minmax(0, 1fr))" : "1fr" }, gap: 1.25 }}>
        {search.feeds.map((f) => {
          const title = feedTitle(f);
          const detail = feedDetail(f, t, language);
          const valid = validityOf(f, t, language);
          const licence = licenceOf(f);
          const Icon = isRailFeed(f) ? TrainOutlinedIcon : DirectionsBusFilledOutlinedIcon;
          const isOpening = Boolean(opening) && opening.url === f.url;
          const failed = openError?.url === f.url ? openError : null;
          return (
            <Box key={f.id || f.url} data-testid="find-network-row" data-status={f.status || ""} aria-busy={isOpening || undefined} sx={{ position: "relative", overflow: "hidden", p: 1.75, borderRadius: "14px", display: "flex", flexDirection: "column", gap: 1.25, transition: "border-color .15s, box-shadow .15s, background-color .15s", border: `1px solid ${isOpening ? k.accent : k.line}`, backgroundColor: k.surface, boxShadow: isOpening ? k.float : k.raise, "&:hover": { borderColor: k.accentLine, boxShadow: k.float } }}>
              {isOpening && <LinearProgress aria-hidden sx={{ position: "absolute", top: 0, left: 0, right: 0, height: 3 }} />}
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
                {detail && <Typography sx={{ fontSize: "0.76rem", color: k.ink2 }}>{detail}</Typography>}
                {valid && (
                  <Typography data-testid="find-network-validity" sx={{ fontSize: "0.76rem", color: valid.color, fontWeight: valid.expired ? 600 : 400 }}>
                    {valid.text}
                    {valid.expired ? ` — ${t("findNetwork.expiredHint")}` : ""}
                  </Typography>
                )}
              </Box>
              {failed && <ErrorNotice error={failed.error} onRetry={() => openFeed(f, failed.intent)} testid="find-network-open-error" />}
              <Box sx={{ display: "flex", alignItems: "center", gap: 1, mt: "auto", minHeight: 36 }}>
                <Box sx={{ flex: 1, minWidth: 0 }}>
                  {isOpening ? (
                    <Typography role="status" title={t("findNetwork.opening", { seconds: openSeconds })} data-testid="find-network-opening" sx={{ fontSize: "0.76rem", fontWeight: 600, color: k.accent, whiteSpace: "nowrap", overflow: "hidden", textOverflow: "ellipsis" }}>
                      {t("findNetwork.openingShort", { seconds: openSeconds })}
                    </Typography>
                  ) : (
                    f.page_url && (
                      <Link href={f.page_url} target="_blank" rel="noreferrer" underline="hover" sx={{ fontSize: "0.74rem", color: k.ink2, whiteSpace: "nowrap" }}>
                        {t("feeds.page")}
                      </Link>
                    )
                  )}
                </Box>
                <Button
                  variant="contained"
                  disableElevation
                  disabled={busy && !isOpening}
                  aria-disabled={busy || undefined}
                  onClick={() => openFeed(f, "modify")}
                  endIcon={isOpening ? <CircularProgress size={14} color="inherit" /> : <ArrowForwardRoundedIcon sx={{ fontSize: "17px !important" }} />}
                  data-testid="find-network-open"
                  sx={{ flexShrink: 0, textTransform: "none", fontWeight: 600, borderRadius: "10px", px: 1.75, whiteSpace: "nowrap" }}
                >
                  {t("findNetwork.choose")}
                </Button>
              </Box>
            </Box>
          );
        })}
      </Box>
      {sourcesLine && <Typography sx={{ fontSize: "0.68rem", color: k.ink3 }}>{sourcesLine}</Typography>}
    </Box>
  );

  if (home) {
    // What the computer beside the card shows while a place is searched, then what the search found.
    const state = search.status === "idle" ? null : search.status === "loading" ? "loading" : search.status === "error" ? "error" : found ? "results" : "none";
    const body =
      state === "loading" ? (
        <Box data-testid="find-network-loading" role="status" sx={{ width: "min(80%, 440px)", boxSizing: "border-box", display: "flex", flexDirection: "column", gap: 1.5, p: 2.5, borderRadius: "14px", color: k.ink, backgroundColor: k.surface, boxShadow: `0 20px 50px ${alpha(shadow, 0.45)}` }}>
          <Typography sx={{ fontSize: "0.95rem", fontWeight: 700 }}>{t("findNetwork.loading", { place: search.place, seconds: searchSeconds })}</Typography>
          <LinearProgress aria-hidden sx={{ height: 6, borderRadius: 3 }} />
          <Box sx={{ display: "flex", alignItems: "center", gap: 1 }}>
            <Typography sx={{ flex: 1, minWidth: 0, fontSize: "0.76rem", color: k.ink2 }}>{t("findNetwork.loadingSources", { sources: `${t("feeds.pan")} · ${t("feeds.mdb")}` })}</Typography>
            <Button size="small" onClick={cancel} data-testid="find-network-cancel" sx={{ textTransform: "none", fontWeight: 600, flexShrink: 0 }}>
              {t("findNetwork.cancel")}
            </Button>
          </Box>
        </Box>
      ) : state === "error" ? (
        <ErrorNotice error={search.error} onRetry={() => run(search.place)} testid="find-network-error" sx={{ width: "min(84%, 460px)", boxSizing: "border-box" }} />
      ) : state === "none" ? (
        <Box sx={{ maxWidth: "80%", display: "flex", flexDirection: "column", alignItems: "center", gap: 1.5 }}>
          <Box aria-hidden sx={{ width: 52, height: 52, borderRadius: "50%", display: "flex", alignItems: "center", justifyContent: "center", color: k.accent, backgroundColor: k.accentSoft }}>
            <TravelExploreOutlinedIcon sx={{ fontSize: 26 }} />
          </Box>
          <Typography data-testid="find-network-none" sx={{ textAlign: "center", fontSize: "0.9rem", color: k.ink2, lineHeight: 1.55 }}>
            {t("findNetwork.none", { place: search.place })}
          </Typography>
        </Box>
      ) : state === "results" ? (
        <Box data-testid="find-network-results" onKeyDown={(e) => e.key === "Escape" && back()} sx={{ alignSelf: "stretch", width: "100%", minHeight: 0, display: "flex", flexDirection: "column", color: k.ink }}>
          <Box sx={{ display: "flex", alignItems: "center", gap: 1.25, minHeight: 40, flexShrink: 0, pl: 2, pr: 0.75, backgroundColor: k.subtle, borderBottom: `1px solid ${k.line}` }}>
            <SearchIcon aria-hidden sx={{ fontSize: 18, color: k.accent }} />
            <Typography component="h3" sx={{ flex: 1, minWidth: 0, fontSize: "0.88rem", fontWeight: 700, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
              {foundWords}
            </Typography>
            <IconButton size="small" onClick={back} disabled={busy} aria-label={t("home.screen.back")} title={t("home.screen.back")} data-testid="find-network-back" sx={{ color: k.ink2 }}>
              <CloseRoundedIcon sx={{ fontSize: 18 }} />
            </IconButton>
          </Box>
          <Box component="ul" sx={{ listStyle: "none", m: 0, p: 0, flex: 1, minHeight: 0, overflowY: "auto" }}>
            {search.feeds.map((f, i) => (
              <ScreenRow key={f.id || f.url} feed={f} index={i} opening={opening} failed={openError?.url === f.url ? openError : null} busy={busy} openSeconds={openSeconds} onOpen={openFeed} k={k} t={t} language={language} />
            ))}
          </Box>
          {sourcesLine && <Typography title={sourcesLine} sx={{ flexShrink: 0, px: 2, py: 0.75, fontSize: "0.68rem", color: k.ink3, borderTop: `1px solid ${k.line}`, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{sourcesLine}</Typography>}
        </Box>
      ) : null;
    const screen = state && { state, body, back, busy };
    const beside = typeof aside === "function";
    return (
      <Box component="section" aria-labelledby={labelledBy || undefined} data-testid="find-network" data-intent="home" sx={{ width: "100%", display: "flex", flexDirection: "column", gap: { xs: 3, md: 4 }, ...sx }}>
        {/* Beside an aside, two columns; alone, one column in the middle of the page. */}
        <Box sx={aside ? { display: "grid", gridTemplateColumns: { xs: "minmax(0, 1fr)", md: "minmax(0, 6fr) minmax(0, 5fr)", lg: "minmax(0, 5fr) minmax(0, 7fr)" }, columnGap: { md: 5, xl: 8 }, rowGap: 4, alignItems: "center" } : { display: "flex", justifyContent: "center" }}>
          <Box sx={{ display: "flex", flexDirection: "column", gap: { xs: 2.5, md: 3 }, minWidth: 0, ...(aside ? {} : { width: "100%", maxWidth: 860 }) }}>
            {heading}
            <HomeCard search={searchBlock} foot={fileFoot} onExplore={onExploreFile} disabled={busy} blocked={Boolean(elsewhere)} t={t} />
            {aside && trust}
          </Box>
          {aside && (
            <Box ref={asideRef} sx={{ minWidth: 0, scrollMarginTop: 72 }}>
              {beside ? aside(screen) : aside}
            </Box>
          )}
        </Box>
        {!aside && trust}
        {/* The screen's answer said to a screen reader, wherever the eyes are. */}
        <Box role="status" aria-live="polite" aria-atomic="true" data-testid="find-network-announce" sx={visuallyHidden}>
          {state === "results" ? foundWords : state === "none" ? t("findNetwork.none", { place: search.place }) : ""}
        </Box>
        {screen && !beside && (
          <Box sx={{ display: "flex", justifyContent: "center", minHeight: 160, p: 2, borderRadius: "22px", backgroundColor: k.surface, boxShadow: `0 30px 70px ${alpha(shadow, 0.3)}` }}>
            {body}
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
