/**
 * A network opening, as Home's computer screen shows it (utils/networkOpening): its name, three steps (the file
 * sent, the feed downloaded or the demo prepared; the MobilityData check; the data loaded) with what the server
 * really counts, a bar in three parts, then « Réseau prêt » before the screen grows into the reader.
 */

import React, { useEffect, useState } from "react";
import { Box, Typography, alpha, useTheme } from "@mui/material";
import { keyframes } from "@mui/system";
import CheckRoundedIcon from "@mui/icons-material/CheckRounded";
import CloudUploadOutlinedIcon from "@mui/icons-material/CloudUploadOutlined";
import TravelExploreOutlinedIcon from "@mui/icons-material/TravelExploreOutlined";
import DirectionsBusFilledOutlinedIcon from "@mui/icons-material/DirectionsBusFilledOutlined";
import { useLanguage } from "../../contexts/LanguageContext";
import { tokensOf } from "../studio/studioTheme";
import { visuallyHidden } from "../common/StatusBar";

const sweep = keyframes`
  from { transform: translateX(-100%); }
  to   { transform: translateX(250%); }
`;
const pop = keyframes`
  from { transform: scale(.6); opacity: 0; }
  to   { transform: none; opacity: 1; }
`;
const still = { "@media (prefers-reduced-motion: reduce)": { animation: "none" } };

const ICON = { file: CloudUploadOutlinedIcon, feed: TravelExploreOutlinedIcon, demo: DirectionsBusFilledOutlinedIcon };
// Of the three steps, where a stage of the server stands, and how far into it when the server counts.
const placeOf = (o) => {
  if (o.state === "ready" || o.stage === "done") return { step: 3, fraction: 1 };
  const counted = Number.isFinite(o.done) && Number(o.total) > 0 ? o.done / o.total : null;
  switch (o.stage) {
    case "send":
      return { step: 0, fraction: o.sent };
    case "download":
      return { step: 0, fraction: counted };
    case "prepare":
      return { step: 0, fraction: null };
    case "unpack":
      return o.kind === "demo" ? { step: 0, fraction: null } : { step: 1, fraction: null };
    case "validate":
      return { step: 1, fraction: null };
    case "queue":
      return { step: 2, fraction: 0, queued: true };
    case "read":
      return { step: 2, fraction: counted == null ? null : 0.3 * counted };
    case "write":
      return { step: 2, fraction: counted == null ? null : 0.3 + 0.7 * counted };
    default:
      return { step: 0, fraction: null };
  }
};

const useSeconds = (since, running) => {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    if (!running) return undefined;
    const id = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(id);
  }, [running]);
  return Math.max(0, Math.round((now - since) / 1000));
};

export default function OpeningScreen({ opening }) {
  const theme = useTheme();
  const k = tokensOf(theme);
  const { t, language } = useLanguage();
  const place = placeOf(opening);
  const ready = place.step === 3;
  const seconds = useSeconds(opening.stageAt, place.step === 1);
  const Icon = ICON[opening.kind] || CloudUploadOutlinedIcon;
  const percent = (f) => new Intl.NumberFormat(language, { style: "percent", maximumFractionDigits: 0 }).format(f);
  const size = Number(opening.size) > 0 ? new Intl.NumberFormat(language, { style: "unit", unit: "megabyte", unitDisplay: "short", maximumFractionDigits: 1 }).format(opening.size / (1024 * 1024)) : null;
  const firstKey = { file: "send", feed: "download", demo: "prepare" }[opening.kind] || "prepare";
  const steps = [t(`home.opening.step.${firstKey}`), t("home.opening.step.check"), t("home.opening.step.load")];
  const title = opening.kind === "demo" ? t("home.opening.demo") : opening.name || t(`home.opening.kind.${opening.kind}`);
  const sub = [opening.kind === "demo" ? null : t(`home.opening.kind.${opening.kind}`), size].filter(Boolean).join(" · ");
  const green = theme.palette.success.main;

  return (
    <Box data-testid="home-opening" data-step={place.step} sx={{ width: "min(84%, 460px)", boxSizing: "border-box", display: "flex", flexDirection: "column", gap: 2, color: k.ink }}>
      {/* Said once per step and at the end; the counts beside the steps change too often to be read out. */}
      <Box role="status" aria-live="polite" aria-atomic="true" data-testid="home-opening-announce" sx={visuallyHidden}>
        {ready ? t("home.opening.ready") : steps[place.step]}
      </Box>
      <Box sx={{ display: "flex", alignItems: "center", gap: 1.5, minWidth: 0 }}>
        <Box aria-hidden sx={{ width: 40, height: 40, flexShrink: 0, borderRadius: "50%", display: "flex", alignItems: "center", justifyContent: "center", color: ready ? theme.palette.success.contrastText : theme.palette.primary.contrastText, backgroundColor: ready ? green : theme.palette.primary.main, transition: "background-color .3s" }}>
          {ready ? <CheckRoundedIcon key="ready" sx={{ fontSize: 22, animation: `${pop} .3s ease-out both`, ...still }} /> : <Icon sx={{ fontSize: 21 }} />}
        </Box>
        <Box sx={{ minWidth: 0 }}>
          <Typography noWrap title={title} sx={{ fontSize: "0.98rem", fontWeight: 700 }}>
            {ready ? t("home.opening.ready") : title}
          </Typography>
          <Typography noWrap sx={{ fontSize: "0.78rem", color: k.ink2 }}>
            {ready ? title : sub}
          </Typography>
        </Box>
      </Box>
      <Box aria-hidden sx={{ display: "flex", gap: 0.5 }}>
        {steps.map((label, i) => {
          const done = i < place.step;
          const active = i === place.step;
          const fill = done ? 1 : active && Number.isFinite(place.fraction) ? place.fraction : 0;
          return (
            <Box key={label} sx={{ position: "relative", flex: i === 2 ? 1.4 : 1, height: 6, borderRadius: 3, overflow: "hidden", backgroundColor: alpha(theme.palette.primary.main, 0.14) }}>
              <Box sx={{ position: "absolute", inset: 0, width: `${fill * 100}%`, borderRadius: 3, backgroundColor: ready ? green : theme.palette.primary.main, transition: "width .3s ease-out, background-color .3s" }} />
              {active && !Number.isFinite(place.fraction) && <Box sx={{ position: "absolute", top: 0, bottom: 0, width: "40%", borderRadius: 3, backgroundColor: theme.palette.primary.main, animation: `${sweep} 1.2s ease-in-out infinite`, ...still }} />}
            </Box>
          );
        })}
      </Box>
      <Box component="ol" sx={{ listStyle: "none", m: 0, p: 0, display: "flex", flexDirection: "column", gap: 1.1 }}>
        {steps.map((label, i) => {
          const done = i < place.step;
          const active = i === place.step;
          const detail = !active ? null : place.queued ? t("home.opening.queue") : i === 1 ? t("home.opening.seconds", { seconds }) : Number.isFinite(place.fraction) ? percent(place.fraction) : null;
          return (
            <Box component="li" key={label} data-state={done ? "done" : active ? "active" : "next"} sx={{ display: "flex", alignItems: "center", gap: 1.25, fontSize: "0.86rem", color: done || active ? k.ink : k.ink3 }}>
              <Box aria-hidden sx={{ width: 20, height: 20, flexShrink: 0, borderRadius: "50%", display: "flex", alignItems: "center", justifyContent: "center", border: done ? "none" : `2px solid ${active ? theme.palette.primary.main : k.lineStrong}`, backgroundColor: done ? green : "transparent", color: theme.palette.success.contrastText }}>
                {done && <CheckRoundedIcon sx={{ fontSize: 14, animation: `${pop} .25s ease-out both`, ...still }} />}
              </Box>
              <Box component="span" sx={{ flex: 1, minWidth: 0, fontWeight: active ? 600 : 500 }}>
                {label}
              </Box>
              {detail && (
                <Box component="span" aria-hidden={i === 1 ? "true" : undefined} sx={{ flexShrink: 0, fontSize: "0.78rem", fontVariantNumeric: "tabular-nums", color: k.ink2 }}>
                  {detail}
                </Box>
              )}
            </Box>
          );
        })}
      </Box>
    </Box>
  );
}
