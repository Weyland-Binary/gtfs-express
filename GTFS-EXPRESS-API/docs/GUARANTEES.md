# Delivery guarantees (G1–G6)

The code and the tests name six guarantees by their number. They hold on every path that hands a GTFS out of the
server (a change committed, the GTFS export, a share and its new versions, a network built, a project version's
package), whatever the client or the model says. Each is proved by a level-0 suite under
`GTFS-EXPRESS-API/src/__tests__/guarantees/`, with the wrong inputs it must reject.

| | Guarantee | What the server does |
|---|---|---|
| **G1** | No delivery without the validator | The MobilityData canonical validator runs on the feed as it will be delivered. A validator missing, crashed or unverified refuses (`503 VALIDATOR_UNAVAILABLE`, `VALIDATOR_FAILED`); an error the feed did not carry when it was loaded refuses (`VALIDATION_NEW_ERRORS`), a creation must carry none (`VALIDATION_ERRORS`). No bypass, no acknowledgement lifts it. Errors the loaded feed already had are delivered announced. |
| **G2** | Every change traces to its source | An operation applies a verified quote of the brief, an answer of the person, or an assumption a named person validated. An unverified quote or an unvalidated assumption holds the commit (`SOURCES_UNVERIFIED`, `ASSUMPTIONS_UNVALIDATED`) until a named person accepts it. |
| **G3** | The verdict is the engine's | Whether the brief's objectives are met is computed by the server from its measures, never taken from the model; a sentence of the model that contradicts it is flagged. |
| **G4** | The objectives are protected, the acknowledgements named | The model can add or refine an objective, never drop, loosen or waive one a person decided. A must objective failing or not measurable is delivered only under a named acknowledgement (`CLAUSES_FAILING`, `CLAUSES_UNKNOWN`, `ACKNOWLEDGEMENT_UNNAMED`), recorded with the delivery. |
| **G5** | Every requirement of the brief is covered | Each requirement sentence of the brief and its documents is answered by an objective that quotes it, a wish to check by hand, or a named dismissal; an uncovered sentence holds the delivery. The detector is deterministic. |
| **G6** | Nothing changes outside the change list | Every table a change writes is diffed, the commit replays exactly the previewed changeset, and the change list shows everything it touches. |

Measurement is not delivery: previewing or evaluating a plan replays it on an in-memory copy, writes nothing and
needs no acknowledgement.
