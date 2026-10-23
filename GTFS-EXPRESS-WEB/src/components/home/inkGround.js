// Home's widths: it is read on a wide desktop screen, its sections take 1360 px, its showcase's screenshots 1520.
export const HOME_WIDTH = 1360;
export const SHOWCASE_WIDTH = 1520;

// Home's ground between its blue bands: a neutral cool grey in light (the blue bands alone carry the colour, the white
// cards stand out on it), the theme's own ground in dark.
export const homeGroundOf = (theme) => (theme.palette.mode === "dark" ? theme.palette.background.default : "#EEF0F3");
