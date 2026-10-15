/**
 * draftKinds — the colour of each way of modifying, the same wherever the way is named (« Modifier »'s menu, the
 * draft's first screen, its bar and its button): by hand the edit mode's orange, with a brief the assistant's colour.
 */

export const kindToneOf = (theme, kind) => (kind === "hand" ? theme.palette.warning.main : theme.palette.ai?.main || theme.palette.secondary.main);
