/**
 * engineNotes — the change engine's notes on a clause it could not measure,
 * in the reader's words.
 *
 * The checker writes its notes in English (services/judge,
 * services/judge/unchangedClauses): shown as they are, a person reading
 * the verdict, or accepting a clause under their name at delivery, would
 * read « non mesurée : an operation of the plan has no time window (from /
 * to)… ». The notes the reader meets most have a sentence here; any other one stays the engine's
 * own words (never hidden). A headway asked at a stop the trips only end at
 * (a band written on a timetable's terminus row) is one of them: nothing
 * leaves there to measure, and the clause waits for the person's word.
 *
 *   engineNote(note, t) → the sentence, or the note itself, or "—"
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
