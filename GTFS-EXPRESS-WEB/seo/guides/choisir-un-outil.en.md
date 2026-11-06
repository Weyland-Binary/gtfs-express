---
title: Choosing a tool to modify a GTFS feed, the criteria that matter
description: Criteria for choosing a GTFS editing tool (scope, proof, validation, versions, data, briefs, who decides) and how GTFS Express answers each of them.
updated: 2026-10-21
slug: choosing-a-tool-to-modify-a-gtfs-feed
---

A tool for modifying GTFS feeds is judged on what it lets you change, on how it shows that a change is right, and on what it does with your data. The criteria below apply to any tool; for each one, GTFS Express's answer is given as it stands, without comparison.

## What the tool can change

A service change rarely touches a single file. Adding a stop means `stops.txt`, `stop_times.txt` and often `shapes.txt`; a period of works means `calendar_dates.txt` and copied trips. A tool limited to timetables forces you to finish the job elsewhere, with the risk of references broken between the two.

What to check: which files and fields can be changed, whether objects can be created and deleted, how calendars, shapes and ids are handled.

GTFS Express: by hand, in the reader, stops, timetables, shapes and any field; or from a brief, changed by an AI agent on a copy of the network.

## How it proves the change is right

A plausible line on a map does not prove that the brief is met. What proves it is a measurement: the demand checked on the modified network, on a date it concerns and on a date it does not, plus the list of what changed without being asked for.

What to check: what the tool shows after a change (a before and after comparison, table by table), and whether it reports unintended changes.

GTFS Express: the engine states the facts of the change (what changed per table, the validator's new errors); an independent review, run by a different model from the one that made the change, checks each demand on the copy and reports it done, not done or unproven, with its evidence and the changes nobody asked for.

## Validation

What to check: which validator, which version, when it runs, and whether the tool separates the errors a change creates from those that were already there.

GTFS Express: the canonical GTFS validator, version 8.0.0. A new error blocks the delivery; errors already in the reference feed are accepted by name. The catalogue lists 178 rules (117 errors, 54 warnings, 7 infos), and the report opens each occurrence in the editor with the field flagged. See [Validate a GTFS feed](/en/guides/validate-a-gtfs-feed).

## Versions and undo

A modified network must be comparable with its previous state, and a delivered change must be reversible.

What to check: where the change is made (on the published network or on a copy), how you compare, how you undo.

GTFS Express: every change happens in a draft kept apart from the working network. "Before" shows the network as it is, "After" shows the draft. Applying creates a new version (v1, v2...), and every version can be undone. Two versions can be compared.

## Data and confidentiality

A GTFS feed is public, but a brief often contains names, e-mail addresses and internal details. If the tool calls an AI model, the question is what gets sent to it.

What to check: what leaves for an external service, and what is masked first.

GTFS Express: names and e-mail addresses are masked before anything is sent to the AI model.

## Brief formats

A brief rarely arrives as plain text: a letter as a PDF, a Word memo, timetables in a spreadsheet.

What to check: which formats are read, and what the tool does when a demand is ambiguous or incomplete.

GTFS Express: the brief is given as text or as documents (PDF, Word, Excel). When a demand can be read two ways or data is missing, such as the position of a new stop, the agent asks a question instead of guessing.

## Who decides

A tool proposes; someone has to decide, and that decision should stay attached to what was delivered.

What to check: who approves the change, and whether the decision is recorded with the delivered feed.

GTFS Express: the person decides under their own name. The delivered package holds the GTFS feed and its report, and records the decision.

## Reading before modifying

Before any change, you need to read the network: its lines, its timetables, its errors. A tool that lets you read without commitment helps you decide whether a change is worth making.

GTFS Express: reading is free and needs no account (map, lines, timetables day by day, the validator's report, a diagnostic beyond the validator, comparing two versions, sharing by a link). Modifying needs a licence.

## Further reading

- [From a brief to a GTFS feed](/en/guides/from-a-brief-to-a-gtfs-feed)
- [How to modify a GTFS feed](/en/guides/modify-a-gtfs-feed)
- [Validate a GTFS feed](/en/guides/validate-a-gtfs-feed)
