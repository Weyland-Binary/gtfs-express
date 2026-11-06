# Demo brief

A fictive brief for the demo network (`../sample`, « New York City Demo Transit », a synthetic feed): the change it
asks is the one the Home's screenshots show, and anyone can drop it at ① to see the change built, checked and
decided. It names nothing real and holds no personal data.

| File | What |
|---|---|
| `note-offre-novembre-2026.fr.docx` | The brief in French, as a Word note (built from the `.fr.md` beside it) |
| `service-change-note-november-2026.en.docx` | The same in English (built from the `.en.md`) |
| `expected.md` | What the change must be, for whoever checks the result — never dropped into the app |
| `build-docx.js` | `node build-docx.js` rebuilds both Word files from their `.md` |

## What it asks

1. Route B2 no longer serves Madison Sq (stop `MAD`), both directions, every day; S1 keeps serving it; B2's times
   elsewhere unchanged.
2. Ferry F1 on Sundays starts at 9:00 in each direction: the 7:30, 8:00 and 8:30 Sunday departures are withdrawn.
3. Route B1 towards Chelsea Market: the headsign becomes « Chelsea Market via Grand Central ».
4. No other route changes.
