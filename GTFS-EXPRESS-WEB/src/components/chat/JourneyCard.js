/**
 * JourneyCard — a simulated passenger journey (plan_journey tool): the
 * itinerary as a vertical timeline of legs (route pill, stops, times,
 * walks, transfers), or the diagnosis when no itinerary exists.
 */

import React from "react";
import { Box, Chip, Typography, alpha, useTheme } from "@mui/material";
import DirectionsWalkIcon from "@mui/icons-material/DirectionsWalk";
import RouteIcon from "@mui/icons-material/Route";
import ReportProblemOutlinedIcon from "@mui/icons-material/ReportProblemOutlined";
import ScheduleIcon from "@mui/icons-material/Schedule";
import SwapHorizIcon from "@mui/icons-material/SwapHoriz";
import { useLanguage } from "../../contexts/LanguageContext";

const hhmm = (t) => (typeof t === "string" ? t.slice(0, 5) : "");
const fmtDate = (ymd) => (ymd && ymd.length === 8 ? `${ymd.slice(0, 4)}-${ymd.slice(4, 6)}-${ymd.slice(6, 8)}` : ymd || "");
const minutes = (secs) => Math.max(1, Math.round((secs || 0) / 60));

const readableColor = (hex, fallback) => {
  if (!hex || !/^[0-9a-f]{6}$/i.test(hex)) return fallback;
  return `#${hex}`;
};

function RoutePill({ leg }) {
  const theme = useTheme();
  const bg = readableColor(leg.route_color, theme.palette.primary.main);
  const fg = readableColor(leg.route_text_color, theme.palette.getContrastText(bg));
  return (
    <Box
      component="span"
      sx={{
        display: "inline-flex",
        alignItems: "center",
        px: 0.8,
        height: 20,
        borderRadius: 1,
        background: bg,
        color: fg,
        fontSize: "0.7rem",
        fontWeight: 800,
        letterSpacing: 0.2,
        whiteSpace: "nowrap",
      }}
    >
      {leg.route_short_name || leg.route_id}
    </Box>
  );
}

export default function JourneyCard({ journey }) {
  const { t } = useLanguage();
  const theme = useTheme();
  const ok = Boolean(journey.reachable && journey.itinerary);
  const accent = ok ? theme.palette.success.main : theme.palette.warning.main;
  const it = journey.itinerary;
  const tight = (journey.diagnostics || []).filter((d) => d.startsWith("tight_connection:"));

  return (
    <Box
      data-testid="chat-journey"
      sx={{
        mt: 1,
        borderRadius: 1.5,
        overflow: "hidden",
        border: `1px solid ${alpha(accent, 0.45)}`,
        background: alpha(accent, 0.04),
      }}
    >
      <Box sx={{ px: 1.5, py: 1, display: "flex", alignItems: "flex-start", gap: 1 }}>
        <RouteIcon sx={{ fontSize: 18, color: accent, mt: 0.1 }} />
        <Box sx={{ flex: 1, minWidth: 0 }}>
          <Typography sx={{ fontSize: "0.8rem", fontWeight: 700, lineHeight: 1.35 }}>
            {journey.from?.stop_name} → {journey.to?.stop_name}
          </Typography>
          <Typography sx={{ fontSize: "0.72rem", color: "text.secondary" }}>
            {t("chat.journey.when", { date: fmtDate(journey.date), time: hhmm(journey.time) })}
          </Typography>
          {ok && (
            <Box sx={{ display: "flex", gap: 0.5, flexWrap: "wrap", mt: 0.6 }}>
              <Chip size="small" icon={<ScheduleIcon sx={{ fontSize: 13 }} />} label={`${hhmm(it.departure)} → ${hhmm(it.arrival)}`} sx={{ height: 20, fontSize: "0.66rem", fontWeight: 700, fontFamily: "monospace" }} />
              <Chip size="small" label={t("chat.journey.duration", { minutes: minutes(it.duration_secs) })} sx={{ height: 20, fontSize: "0.66rem" }} />
              <Chip size="small" icon={<SwapHorizIcon sx={{ fontSize: 13 }} />} label={t("chat.journey.transfers", { count: it.transfers })} sx={{ height: 20, fontSize: "0.66rem" }} />
              {it.wait_before_secs > 0 && <Chip size="small" variant="outlined" label={t("chat.journey.wait", { minutes: minutes(it.wait_before_secs) })} sx={{ height: 20, fontSize: "0.66rem" }} />}
            </Box>
          )}
        </Box>
      </Box>

      {ok ? (
        <Box sx={{ px: 1.5, pb: 1.1, display: "flex", flexDirection: "column" }}>
          {it.legs.map((leg, i) => (
            <Box key={i} sx={{ display: "grid", gridTemplateColumns: "44px 14px 1fr", columnGap: 0.75, alignItems: "stretch" }}>
              <Box sx={{ fontFamily: "monospace", fontSize: "0.68rem", color: "text.secondary", pt: 0.25, textAlign: "right" }}>
                {leg.type === "ride" ? hhmm(leg.from.time) : ""}
              </Box>
              <Box sx={{ display: "flex", flexDirection: "column", alignItems: "center" }}>
                <Box sx={{ width: 9, height: 9, mt: 0.45, borderRadius: "50%", border: `2px solid ${leg.type === "walk" ? theme.palette.text.disabled : readableColor(leg.route_color, theme.palette.primary.main)}`, background: theme.palette.background.paper, flexShrink: 0 }} />
                <Box sx={{ flex: 1, width: 3, minHeight: 14, background: leg.type === "walk" ? `repeating-linear-gradient(${theme.palette.text.disabled} 0 3px, transparent 3px 6px)` : readableColor(leg.route_color, theme.palette.primary.main), opacity: 0.8 }} />
              </Box>
              <Box sx={{ pb: 1, minWidth: 0 }}>
                {leg.type === "walk" ? (
                  <Typography sx={{ fontSize: "0.72rem", color: "text.secondary", display: "flex", alignItems: "center", gap: 0.4 }}>
                    <DirectionsWalkIcon sx={{ fontSize: 14 }} />
                    {t("chat.journey.walk", { minutes: minutes(leg.duration_secs), to: leg.to.stop_name })}
                  </Typography>
                ) : (
                  <>
                    <Box sx={{ display: "flex", alignItems: "center", gap: 0.6, flexWrap: "wrap" }}>
                      <RoutePill leg={leg} />
                      <Typography sx={{ fontSize: "0.76rem", fontWeight: 600 }} noWrap>
                        {leg.headsign || leg.route_long_name}
                      </Typography>
                    </Box>
                    <Typography sx={{ fontSize: "0.72rem", color: "text.secondary", mt: 0.2 }}>
                      {leg.from.stop_name} → {leg.to.stop_name} · {t("chat.journey.stops", { count: leg.stops })} · {minutes(leg.duration_secs)} min
                    </Typography>
                    <Typography sx={{ fontSize: "0.66rem", color: "text.disabled", fontFamily: "monospace" }}>
                      {hhmm(leg.to.time)} · {leg.trip_id}
                    </Typography>
                  </>
                )}
              </Box>
            </Box>
          ))}
          <Box sx={{ display: "grid", gridTemplateColumns: "44px 14px 1fr", columnGap: 0.75, alignItems: "center" }}>
            <Box sx={{ fontFamily: "monospace", fontSize: "0.68rem", fontWeight: 700, textAlign: "right" }}>{hhmm(it.arrival)}</Box>
            <Box sx={{ display: "flex", justifyContent: "center" }}>
              <Box sx={{ width: 9, height: 9, borderRadius: "50%", background: accent }} />
            </Box>
            <Typography sx={{ fontSize: "0.76rem", fontWeight: 700 }}>{journey.to?.stop_name}</Typography>
          </Box>
          {tight.length > 0 && (
            <Typography sx={{ mt: 0.6, fontSize: "0.7rem", color: "warning.dark", display: "flex", alignItems: "center", gap: 0.4 }}>
              <ReportProblemOutlinedIcon sx={{ fontSize: 14 }} />
              {t("chat.journey.tight", { count: tight.length })}
            </Typography>
          )}
        </Box>
      ) : (
        <Box sx={{ px: 1.5, pb: 1.1, display: "flex", flexDirection: "column", gap: 0.4 }}>
          <Typography sx={{ fontSize: "0.76rem", fontWeight: 700, color: "warning.dark", display: "flex", alignItems: "center", gap: 0.5 }}>
            <ReportProblemOutlinedIcon sx={{ fontSize: 15 }} />
            {t("chat.journey.unreachable")}
          </Typography>
          {(journey.diagnostics || [])
            .filter((d) => !d.startsWith("tight_connection:") && d !== "frequencies_expanded")
            .map((d) => (
              <Typography key={d} sx={{ fontSize: "0.72rem", color: "text.secondary" }}>
                • {t(`chat.journey.diag.${d}`)}
              </Typography>
            ))}
        </Box>
      )}
    </Box>
  );
}
