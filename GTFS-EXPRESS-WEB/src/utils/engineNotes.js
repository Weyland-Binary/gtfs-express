/**
 * The judge writes its notes on an unmeasured clause in English; the common ones get a translated sentence here,
 * any other is shown in the engine's own words, never hidden.
 */

const NOTE_SENTENCES = [
  [/unsupported/i, "transform.checks.unsupported"],
  [/no operation yet/i, "verdict.note.noOperation"],
  [/names no line/i, "verdict.note.noLine"],
  [/no time window/i, "verdict.note.noWindow"],
  [/no reference network|compares with the feed before the plan: none here/i, "verdict.note.noReference"],
  [/no headway to measure there/i, "verdict.note.terminus"],
];

export const engineNote = (note, t) => {
  const known = note ? NOTE_SENTENCES.find(([re]) => re.test(note)) : null;
  return known ? t(known[1]) : note || "—";
};
