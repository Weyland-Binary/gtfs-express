# Delivery guarantees (G1–G6)

The code and the tests name six guarantees by their number. They hold on every path that hands a GTFS out of the
server (a change committed, the GTFS export, a share and its new versions, a project version's package), whatever the client or the model says. Each is proved by a level-0 suite, with the wrong inputs it must
reject (among them `g1Gate`, the gate's refusals, and `g1ExportSnapshot`, the export streaming the read snapshot it
validated, a write landing during the validation never reaching the archive); the suites are kept with the evaluation
corpus in the private repository, and the published source carries none. Every suite the column « Code · suites » names
lives in that private development repository and is not published: the README says what it holds, section « Tests and
evaluation ».

What the server enforces and what a model judges are not the same thing, and the table says which is which: the
validator (G1), the replay of the previewed change (G6), the named decision (G4) are the server's; with a brief, the
verdict per demand (G3, G5) is the independent reviewer's — a model, kept apart from the agent and held to evidence,
whose report the person accepts or not. A plan's clauses (G4) are the ones the client sends with it: a plan sent
without clauses has none to fail.

A change of an existing network is delivered in one of two ways: **with a brief** (the direct mode,
`services/direct`: an agent changes a working copy, the engine states the facts, an independent reviewer reports each
demand of the brief, the person decides on that report) or **by hand** (each retouche an operation of the draft,
applied on the person's named act); the reader's assistant also applies its typed plans. G2–G5 say how each holds.

| | Guarantee | What the server does | Code · suites |
|---|---|---|---|
| **G1** | No delivery without the validator | The MobilityData canonical validator runs on the feed as it will be delivered. A validator missing, crashed or unverified refuses (`503 VALIDATOR_UNAVAILABLE`, `VALIDATOR_FAILED`), as does a report that is not one (no notices, no validator version) or a rule that crashed (`system_errors.json`); an error the feed did not carry when it was loaded refuses (`VALIDATION_NEW_ERRORS`), a feed without a reference must carry none (`VALIDATION_ERRORS`). No bypass, no acknowledgement lifts it. Errors the loaded feed already had are delivered announced. | `validatorGate`, `transform/engine.commitPreview` · `deliveryPaths`, `g1ChangeStudio`, `g1Exits` |
| **G2** | Every change traces to its source | With a brief, a change traces to a demand of the reviewer's report, or the reviewer lists it as not asked: it goes back to the agent, and what stays is shown to the person and kept in the record of the delivery. A typed operation applies a verified quote of the brief or the person's own hand; an unverified quote holds the commit (`SOURCES_UNVERIFIED`) until a named person accepts it. | `direct/workflow` (findings), `direct/reviewer`, `transform/quotes` · `directModeGuarantees`, `g2Sources`, `g2PdfText` |
| **G3** | The facts and the measures are the engine's | What a change does (the rows per table, the semantic diff, the validator's new errors) and every measure (the judge's clause kinds) are computed by the server, never taken from a model; with a brief the verdict per demand is the reviewer's — another model that reads only the brief and those facts and proves each demand by a measure or a query — never the agent's own account. The changes nobody asked for are, with a brief, the reviewer's judgement (its report's changes not asked), while on the typed operations' path the server computes them from the plan's clauses and holds the commit on them (`CHANGES_NOT_ASKED`). | `direct/facts`, `direct/measure`, `judge`, `judge/changeAccounting`, `verdict` · `directModeGuarantees`, `g3ServerVerdict` |
| **G4** | Nothing delivered without a named decision | A change is applied on the person's one named decision: the report accepted as shown (`acknowledge.direct`; `DIRECT_REPORT_UNACCEPTED` without it) or the change by hand applied as listed (`acknowledge.hand`), recorded with the edit; a new validator error, broken integrity or a feed changed since the preview still refuse it, and the reference feed's own errors are accepted by name (`BASELINE_ERRORS`, read against the loaded feed's baseline), the errors a hand edit left in the working copy before the plan being named apart as their own item (`current_errors`, `CURRENT_ERRORS`) so the record never calls them the reference's. A must clause of a plan failing or not measurable is delivered only under a named acknowledgement (`CLAUSES_FAILING`, `CLAUSES_UNKNOWN`); a model never drops, loosens or waives a clause a person decided. Nothing is acknowledged anonymously (`ACKNOWLEDGEMENT_UNNAMED`). | `acknowledgement`, `transform/engine` (the gate), `deliveryProof` · `directModeGuarantees`, `g4ChangeStudio` |
| **G5** | Every demand of the brief has its verdict | With a brief, each demand of the brief and its documents has its verdict in the reviewer's report — done, not done or unproven, with its evidence. A reviewer that ends without its report is asked for it once; a review still incomplete makes the change undeliverable (`REVIEW_INCOMPLETE` at the commit) until the review, run again on its own (`POST /transform/direct/review`), concludes. The agent spends at most its share of the turn's AI ceiling, the rest being the review's. The report is kept by the server with the edit it allowed (the commit's named record), and a draft reopened from that edit takes that report back, never one the client sends; an edit without one reopens a draft without a report, applied again by hand. | `direct/reviewer` (`reportOf`), `direct/workflow` (`runReview`, `reviewAgain`), `transform/draftJournal` (`directReportOf`) · `directModeGuarantees`, `directMode`, `draftDirect` |
| **G6** | Nothing changes outside the change list | Every table a change writes is diffed, the commit replays exactly the previewed changeset, and the change list shows everything it touches. | `transform/changeset`, `transform/engine` · `g6Perimeter` |

Measurement is not delivery: previewing or evaluating a plan replays it on an in-memory copy, writes nothing and
needs no acknowledgement.
