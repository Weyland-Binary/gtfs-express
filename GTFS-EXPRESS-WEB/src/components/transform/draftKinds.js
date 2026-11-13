/** The colour of each way of modifying, the same wherever it is named: by hand the edit mode's, with a brief the assistant's, an aggregate the secondary tone. */

export const kindToneOf = (theme, kind) => (kind === "hand" ? theme.palette.warning.main : kind === "aggregate" ? theme.palette.secondary.main : theme.palette.ai?.main || theme.palette.secondary.main);

/**
 * The tone as text on its own tint: the main shade reads under 4.5:1 there in both modes, so the text takes the dark
 * shade in light mode and the light shade in dark mode.
 */
export const textToneOf = (theme, palette) => (palette ? (theme.palette.mode === "dark" ? palette.light || palette.main : palette.dark || palette.main) : theme.palette.text.primary);
export const kindTextToneOf = (theme, kind) => textToneOf(theme, kind === "hand" ? theme.palette.warning : kind === "aggregate" ? theme.palette.secondary : theme.palette.ai || theme.palette.secondary);
