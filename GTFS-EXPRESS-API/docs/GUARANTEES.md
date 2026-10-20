# Delivery guarantees (G1–G6)

The code and the tests name six guarantees by their number. They hold on every path that hands a GTFS out of the
server (a change committed, the GTFS export, a share and its new versions, a network built, a project version's
package), whatever the client or the model says. Each is proved by a level-0 suite under
`GTFS-EXPRESS-API/src/__tests__/guarantees/`, with the wrong inputs it must reject.

A change of an existing network is delivered in one of two ways: **with a brief** (the direct mode,
`services/direct`: an agent changes a working copy, the engine states the facts, an independent reviewer reports each
demand of the brief, the person decides on that report) or **by hand** (each retouche an operation of the draft,
applied on the person's named act); the reader's assistant also applies its typed plans. A network designed in the
Network Studio is delivered under its contract (the objectives decided at ②). G2–G5 say how each holds.

| | Guarantee | What the server does | Code · suites |
|---|---|---|---|
| **G1** | No delivery without the validator | The MobilityData canonical validator runs on the feed as it will be delivered. A validator missing, crashed or unverified refuses (`503 VALIDATOR_UNAVAILABLE`, `VALIDATOR_FAILED`); an error the feed did not carry when it was loaded refuses (`VALIDATION_NEW_ERRORS`), a creation must carry none (`VALIDATION_ERRORS`). No bypass, no acknowledgement lifts it. Errors the loaded feed already had are delivered announced. | `validatorGate`, `transform/engine.commitPreview` · `deliveryPaths`, `g1ChangeStudio`, `g1Exits` |
| **G2** | Every change traces to its source | With a brief, a change traces to a demand of the reviewer's report, or the reviewer lists it as not asked: it goes back to the agent, and what stays is shown to the person and kept in the record of the delivery. A typed operation applies a verified quote of the brief or the person's own hand; an unverified quote holds the commit (`SOURCES_UNVERIFIED`) until a named person accepts it. | `direct/workflow` (findings), `direct/reviewer`, `transform/quotes` · `directModeGuarantees`, `g2Sources`, `g2PdfText` |
| **G3** | The facts and the measures are the engine's | What a change does (the rows per table, the semantic diff, the validator's new errors) and every measure (the judge's clause kinds) are computed by the server, never taken from a model; with a brief the verdict per demand is the reviewer's — another model that reads only the brief and those facts and proves each demand by a measure or a query — never the agent's own account. In the Network Studio the verdict is the engine's, and a sentence of the model that contradicts it is flagged. | `direct/facts`, `direct/measure`, `judge`, `verdict` · `directModeGuarantees`, `g3ServerVerdict`, `g3ServerVerdictNetwork` |
| **G4** | Nothing delivered without a named decision | A change is applied on the person's one named decision: the report accepted as shown (`acknowledge.direct`; `DIRECT_REPORT_UNACCEPTED` without it) or the change by hand applied as listed (`acknowledge.hand`), recorded with the edit; a new validator error, broken integrity or a feed changed since the preview still refuse it, and the reference feed's own errors are accepted by name. A must clause of a plan or of the Network Studio's contract failing or not measurable is delivered only under a named acknowledgement (`CLAUSES_FAILING`, `CLAUSES_UNKNOWN`); a model never drops, loosens or waives a clause a person decided. Nothing is acknowledged anonymously (`ACKNOWLEDGEMENT_UNNAMED`). | `acknowledgement`, `transform/engine` (the gate), `deliveryProof` · `directModeGuarantees`, `g4ChangeStudio`, `g4NetworkGate`, `g4RequirementsProtectionNetwork` |
| **G5** | Every demand of the brief has its verdict | With a brief, each demand of the brief and its documents has its verdict in the reviewer's report — done, not done or unproven, with its evidence — and a review that ends without its report is said incomplete. In the Network Studio, each requirement sentence is answered by an objective that quotes it, a wish to check by hand, or a named dismissal; an uncovered sentence holds the build, and the detector is deterministic. | `direct/reviewer` (`reportOf`), `contract/coverage` · `directModeGuarantees`, `g5Coverage`, `g5CoverageGateNetwork` |
| **G6** | Nothing changes outside the change list | Every table a change writes is diffed, the commit replays exactly the previewed changeset, and the change list shows everything it touches. | `transform/changeset`, `transform/engine` · `g6Perimeter` |

Measurement is not delivery: previewing or evaluating a plan replays it on an in-memory copy, writes nothing and
needs no acknowledgement.
