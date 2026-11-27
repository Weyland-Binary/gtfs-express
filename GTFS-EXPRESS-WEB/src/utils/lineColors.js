/**
 * A line's colours as every screen shows them: the feed's route_color and route_text_color, the specification's
 * defaults where the feed gives none or writes something that is no colour (a white line, a black text), and a text
 * that reads: below the floor the text is black or white, whichever reads better on the line's colour.
 */

// Below 3:1 a number cannot be read on its colour (the diagnostic's low_color_contrast).
export const MIN_CONTRAST = 3;
const WHITE = "#FFFFFF";
const BLACK = "#000000";

/** "#RRGGBB" for six hexadecimal digits, with or without the "#"; null for anything else. */
export const hexColor = (value) => {
  const m = /^#?([0-9a-f]{6})$/i.exec(String(value ?? "").trim());
  return m ? `#${m[1]}` : null;
};

const channel = (v) => {
  const s = v / 255;
  return s <= 0.03928 ? s / 12.92 : ((s + 0.055) / 1.055) ** 2.4;
};
const luminance = (hex) => 0.2126 * channel(parseInt(hex.slice(1, 3), 16)) + 0.7152 * channel(parseInt(hex.slice(3, 5), 16)) + 0.0722 * channel(parseInt(hex.slice(5, 7), 16));

/** The WCAG contrast ratio of two "#RRGGBB" colours, 1 to 21. */
export const contrastOf = (a, b) => {
  const [light, dark] = [luminance(a), luminance(b)].sort((x, y) => y - x);
  return (light + 0.05) / (dark + 0.05);
};

/** `wanted` when it reads on `ground` ("#RRGGBB" both), else black or white, whichever reads better. */
export const readableOn = (ground, wanted) => {
  if (contrastOf(ground, wanted) >= MIN_CONTRAST) return wanted;
  return contrastOf(ground, BLACK) >= contrastOf(ground, WHITE) ? BLACK : WHITE;
};

/** { bg, fg } of a line's badge, from a route row (route_color, route_text_color) or an engine's line (color, text_color). */
export const lineBadgeColors = (route) => {
  const bg = hexColor(route?.route_color) || hexColor(route?.color) || WHITE;
  return { bg, fg: readableOn(bg, hexColor(route?.route_text_color) || hexColor(route?.text_color) || BLACK) };
};
