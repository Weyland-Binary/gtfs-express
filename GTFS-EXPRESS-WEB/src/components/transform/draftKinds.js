/**
 * draftKinds — the colour of each way of modifying, the same wherever the way is named (« Modifier »'s menu, the
 * draft's first screen, its bar and its button): by hand the edit mode's orange, with a brief the assistant's colour.
 */

export const kindToneOf = (theme, kind) => (kind === "hand" ? theme.palette.warning.main : theme.palette.ai?.main || theme.palette.secondary.main);

/**
 * The tone as text on its own tint (the kind's chip): the tone's main reads under 4.5:1 there in both modes, so the
 * text takes the dark shade in light mode and the light shade in dark mode (`textToneOf`, shared by the state pills).
 */
export const textToneOf = (theme, palette) => (palette ? (theme.palette.mode === "dark" ? palette.light || palette.main : palette.dark || palette.main) : theme.palette.text.primary);
export const kindTextToneOf = (theme, kind) => textToneOf(theme, kind === "hand" ? theme.palette.warning : theme.palette.ai || theme.palette.secondary);
