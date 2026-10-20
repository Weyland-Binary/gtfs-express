// The ground of ink: the head's blue, in the light and the dark theme — Home's whole page (one blue ground from the
// head to the foot), or « Le lecteur »'s band when LearnMore stands alone.
// Home's column, one edge for the head, the panels and the presentation (its width stays: the first screen grows in
// height, Home.js FIRST_SCREEN).
export const HOME_WIDTH = 1280;

export const inkGroundOf = (theme) =>
  theme.palette.mode === "dark"
    ? "radial-gradient(1200px 500px at 20% 0%, rgba(99,102,241,0.22), transparent 60%), linear-gradient(160deg, #07142b 0%, #0d2a52 60%, #0b1f3d 100%)"
    : "radial-gradient(1200px 500px at 20% 0%, rgba(129,140,248,0.4), transparent 60%), linear-gradient(160deg, #0b2447 0%, #10336b 60%, #1655b8 100%)";
