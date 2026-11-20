/**
 * Home's computer screen growing into the page (utils/immersion): a layer drawn at the window's size, the reader's
 * first screen in outline (its bar and tabs, the network's name and figures, the map and the side column), first
 * scaled and cut to the screen's rectangle, then grown to the window in one composited animation; it fades away
 * once the reader is drawn underneath.
 */

import React, { useLayoutEffect, useRef } from "react";
import { Box, Typography, alpha, useTheme } from "@mui/material";
import { keyframes } from "@mui/system";
import LogoSvg from "../../assets/LogoSvg";
import { useLanguage } from "../../contexts/LanguageContext";
import { LEAVE_MS, ZOOM_MS, useImmersion } from "../../utils/immersion";
import { INK } from "../home/inkGround";

const shimmer = keyframes`
  from { background-position: -600px 0; }
  to   { background-position: 600px 0; }
`;

function ReaderOutline({ name }) {
  const theme = useTheme();
  const { t } = useLanguage();
  const dark = theme.palette.mode === "dark";
  const line = theme.palette.divider;
  const bar = { backgroundColor: theme.palette.background.paper, borderColor: line };
  const block = (sx) => ({
    borderRadius: 1,
    backgroundColor: alpha(theme.palette.text.primary, dark ? 0.08 : 0.06),
    backgroundImage: `linear-gradient(90deg, transparent, ${alpha(theme.palette.common.white, dark ? 0.06 : 0.5)}, transparent)`,
    backgroundSize: "600px 100%",
    backgroundRepeat: "no-repeat",
    animation: `${shimmer} 1.4s linear infinite`,
    "@media (prefers-reduced-motion: reduce)": { animation: "none" },
    ...sx,
  });
  return (
    <Box sx={{ position: "absolute", inset: 0, display: "flex", flexDirection: "column", backgroundColor: theme.palette.background.default, color: theme.palette.text.primary }}>
      <Box sx={{ ...bar, height: 58, flexShrink: 0, display: "flex", alignItems: "center", gap: 4, px: 4.5, borderBottom: "1px solid" }}>
        <LogoSvg aria-hidden="true" style={{ width: 160, height: "auto", display: "block", color: dark ? theme.palette.common.white : theme.palette.text.primary }} />
        <Box sx={{ display: "flex", alignItems: "stretch", alignSelf: "stretch", gap: 3, ml: 2 }}>
          {[t("explorer.overview"), t("header.tabSchedules"), t("header.tabSheets")].map((label, i) => (
            <Box key={label} sx={{ display: "flex", alignItems: "center", fontSize: "0.95rem", fontWeight: i === 0 ? 600 : 500, color: i === 0 ? theme.palette.primary.main : theme.palette.text.secondary, borderBottom: `2px solid ${i === 0 ? theme.palette.primary.main : "transparent"}` }}>
              {label}
            </Box>
          ))}
        </Box>
        <Box sx={{ flex: 1 }} />
        <Box sx={block({ width: 110, height: 34, borderRadius: 2 })} />
        <Box sx={{ width: 84, height: 36, borderRadius: 2, backgroundColor: theme.palette.primary.main }} />
        <Box sx={block({ width: 120, height: 34, borderRadius: 2 })} />
      </Box>
      <Box sx={{ ...bar, height: 70, flexShrink: 0, display: "flex", alignItems: "center", borderBottom: "1px solid" }}>
        <Box sx={{ width: 380, flexShrink: 0, px: 3, borderRight: `1px solid ${line}`, alignSelf: "stretch", display: "flex", flexDirection: "column", justifyContent: "center", gap: 0.75 }}>
          {name ? (
            <Typography noWrap sx={{ fontSize: "1.45rem", fontWeight: 700, letterSpacing: "-0.01em" }}>
              {name}
            </Typography>
          ) : (
            <Box sx={block({ width: 240, height: 24 })} />
          )}
          <Box sx={block({ width: 190, height: 12 })} />
        </Box>
        {[0, 1, 2, 3, 4].map((i) => (
          <Box key={i} sx={{ flex: 1, alignSelf: "stretch", display: "flex", alignItems: "center", gap: 2, px: 3, borderRight: i < 4 ? `1px solid ${line}` : "none" }}>
            <Box sx={{ width: 36, height: 36, borderRadius: 2, backgroundColor: alpha(theme.palette.primary.main, 0.1) }} />
            <Box sx={{ display: "flex", flexDirection: "column", gap: 0.75 }}>
              <Box sx={block({ width: 54, height: 20 })} />
              <Box sx={block({ width: 64, height: 11 })} />
            </Box>
          </Box>
        ))}
      </Box>
      <Box sx={{ flex: 1, minHeight: 0, display: "flex" }}>
        <Box sx={block({ flex: 1, borderRadius: 0, backgroundColor: alpha(theme.palette.text.primary, dark ? 0.04 : 0.025) })} />
        <Box sx={{ ...bar, width: 390, flexShrink: 0, borderLeft: "1px solid", p: 2, display: "flex", flexDirection: "column", gap: 1.5 }}>
          <Box sx={block({ width: 150, height: 12 })} />
          <Box sx={block({ height: 52, borderRadius: 2 })} />
          <Box sx={block({ height: 84, borderRadius: 2 })} />
          <Box sx={block({ width: 100, height: 12, mt: 2 })} />
          {[0, 1, 2, 3, 4, 5].map((i) => (
            <Box key={i} sx={{ display: "flex", alignItems: "center", gap: 1.5 }}>
              <Box sx={{ width: 38, height: 22, borderRadius: 1, backgroundColor: alpha(theme.palette.primary.main, 0.18 + i * 0.08) }} />
              <Box sx={block({ flex: 1, height: 12 })} />
            </Box>
          ))}
        </Box>
      </Box>
      <Box sx={{ ...bar, height: 36, flexShrink: 0, borderTop: "1px solid" }} />
    </Box>
  );
}

export default function Immersion() {
  const theme = useTheme();
  const state = useImmersion();
  const layerRef = useRef(null);
  const veilRef = useRef(null);

  useLayoutEffect(() => {
    if (state?.phase !== "zoom") return undefined;
    const layer = layerRef.current;
    const veil = veilRef.current;
    if (!layer || typeof layer.animate !== "function") {
      state.done?.();
      return undefined;
    }
    const { rect } = state;
    const W = window.innerWidth;
    const H = window.innerHeight;
    // Scaled by the width, the window's outline is cut to the screen's height: the screen shows its top.
    const k = rect.width / W;
    const cut = Math.max(0, H - rect.height / k);
    const radius = 6 / k;
    const small = { transform: `translate(${rect.left}px, ${rect.top}px) scale(${k})`, clipPath: `inset(0px 0px ${cut}px 0px round ${radius}px)` };
    // The outline first takes the screen's place, then grows: each step its own easing.
    const grow = layer.animate(
      [
        { ...small, opacity: 0, offset: 0, easing: "linear" },
        { ...small, opacity: 1, offset: 0.14, easing: "cubic-bezier(.65, 0, .25, 1)" },
        { transform: "translate(0px, 0px) scale(1)", clipPath: "inset(0px 0px 0px 0px round 0px)", opacity: 1, offset: 1 },
      ],
      { duration: ZOOM_MS, fill: "forwards" },
    );
    veil?.animate([{ opacity: 0 }, { opacity: 1 }], { duration: ZOOM_MS, easing: "ease-in", fill: "forwards" });
    let finished = false;
    const finish = () => {
      if (finished) return;
      finished = true;
      state.done?.();
    };
    grow.onfinish = finish;
    // A tab in the background runs no animation frame: the page never stays behind the layer.
    const guard = setTimeout(finish, ZOOM_MS + 400);
    return () => clearTimeout(guard);
  }, [state]);

  useLayoutEffect(() => {
    if (state?.phase !== "leave" || !layerRef.current || typeof layerRef.current.animate !== "function") return;
    layerRef.current.animate([{ opacity: 1 }, { opacity: 0 }], { duration: LEAVE_MS, easing: "ease-out", fill: "forwards" });
  }, [state?.phase]);

  if (!state) return null;
  return (
    <Box data-testid="immersion" data-phase={state.phase} aria-hidden sx={{ position: "fixed", inset: 0, zIndex: theme.zIndex.modal + 10, pointerEvents: state.phase === "leave" ? "none" : "auto" }}>
      {/* Under the grown screen the page needs no veil: the reader shows through the screen alone as it fades. */}
      {state.phase === "zoom" && <Box ref={veilRef} sx={{ position: "absolute", inset: 0, opacity: 0, backgroundColor: alpha(INK, 0.5) }} />}
      <Box ref={layerRef} sx={{ position: "absolute", left: 0, top: 0, width: "100vw", height: "100vh", transformOrigin: "0 0", willChange: "transform, clip-path, opacity", opacity: state.phase === "zoom" ? 0 : 1, overflow: "hidden" }}>
        <ReaderOutline name={state.name} />
      </Box>
    </Box>
  );
}
