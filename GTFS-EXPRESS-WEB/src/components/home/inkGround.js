import { alpha, darken } from "@mui/material";

// Home's width: it is read on a wide desktop screen, its sections take 1360 px.
export const HOME_WIDTH = 1360;

// The head is wider than the sections, so the computer's screen beside the finder reads at a useful size.
export const HERO_WIDTH = 1600;

// The deep end of Home's blue bands.
export const INK = "#0B2447";

/** The head's blue band: the guarantees' blue in light, the night's ink in dark. */
export const heroBandOf = (theme) =>
  theme.palette.mode === "dark"
    ? `radial-gradient(900px 520px at 80% 20%, ${alpha(theme.palette.primary.main, 0.16)}, transparent 70%), linear-gradient(135deg, ${darken(theme.palette.background.default, 0.35)} 0%, ${INK} 55%, ${darken(theme.palette.primary.dark, 0.5)} 100%)`
    : `radial-gradient(900px 520px at 80% 20%, ${alpha(theme.palette.primary.light, 0.35)}, transparent 70%), linear-gradient(135deg, ${INK} 0%, ${theme.palette.primary.dark} 55%, ${theme.palette.primary.main} 100%)`;

// Home's ground between its blue bands: a neutral cool grey in light (the blue bands alone carry the colour, the white
// cards stand out on it), the theme's own ground in dark.
export const homeGroundOf = (theme) => (theme.palette.mode === "dark" ? theme.palette.background.default : "#EEF0F3");
