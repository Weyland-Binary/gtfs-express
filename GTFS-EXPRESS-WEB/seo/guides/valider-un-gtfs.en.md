---
title: Validate a GTFS feed with the MobilityData validator
description: What the MobilityData GTFS validator checks, its three severities, how to read its report, the typical errors, and when to fix a notice or accept it.
updated: 2026-10-21
slug: validate-a-gtfs-feed
---

The MobilityData GTFS validator reads a feed and lists every departure from the specification as rules, each classed as an error, a warning or an info. Before delivering, fix the errors you introduced, look at the new warnings, and compare the report with the previous version's.

## The reference validator

The MobilityData validator is open source. It runs from the command line (Java) or from an application, and produces an HTML report and a JSON file. MobilityData presents it as the canonical GTFS validator. Each rule carries a code, such as `foreign_key_violation`, which names the rule in the report.

## What it checks

- **Structure.** Required files, columns, required fields ([missing_required_field](/en/rules/missing_required_field)), unique keys ([duplicate_key](/en/rules/duplicate_key)), value formats: times ([invalid_time](/en/rules/invalid_time)), colours ([invalid_color](/en/rules/invalid_color)), dates.
- **References between files.** Every `route_id`, `service_id`, `stop_id`, `trip_id` or `shape_id` that is cited must exist ([foreign_key_violation](/en/rules/foreign_key_violation)).
- **Timetable consistency.** Times that never go back along a trip, a timed first and last call ([missing_trip_edge](/en/rules/missing_trip_edge)), distances that increase, trips of one `block_id` that do not overlap.
- **Calendars.** A service that never runs, an expired calendar, a feed about to expire.
- **Plausibility.** A stop far from its shape, an impossible speed between two stops.
- **Quality.** The case of names, the contrast of route colours, objects never used, a recommended file missing.

## Three severities

- **Error**: the feed breaks the specification. A consumer may reject it or misread it. Errors get fixed.
- **Warning**: the feed is valid, but something is probably wrong or degrades rider information. Warnings get examined.
- **Info**: an observation, with no action expected.

Some rules depend on thresholds, such as the distance between a stop and its shape or the expiry date. Their values come from the validator's configuration.

## Reading the report

For each rule, the report gives the number of occurrences and then, for each one, the file, row, field and value involved.

Start with the errors, then sort by number of occurrences. One cause often produces hundreds of occurrences: a stop deleted while trips still call at it gives one `foreign_key_violation` per `stop_times.txt` row that names it. Fix the cause, not each row.

For a change, then compare the report with the original feed's. Errors that were already there say nothing about the change; new ones say what it broke.

## Typical errors and their causes

- [foreign_key_violation](/en/rules/foreign_key_violation): a deleted trip whose `stop_times` remain, a mistyped `service_id`.
- [duplicate_key](/en/rules/duplicate_key): a row copied without a new id, two exceptions for the same service on the same date.
- [stop_time_with_arrival_before_previous_departure_time](/en/rules/stop_time_with_arrival_before_previous_departure_time): one call shifted without the following ones, a stop inserted at the wrong `stop_sequence`.
- [invalid_time](/en/rules/invalid_time): `07:05` without seconds, or a time converted by a spreadsheet.
- [invalid_color](/en/rules/invalid_color): `#E30613` instead of `E30613`.
- [service_without_service_days](/en/rules/service_without_service_days): a service whose days have all been removed.
- [block_trips_with_overlapping_stop_times](/en/rules/block_trips_with_overlapping_stop_times): a shifted trip that overlaps the next trip of the same vehicle.
- [start_and_end_range_out_of_order](/en/rules/start_and_end_range_out_of_order): a range that ends before it starts, for example an `end_time` earlier than its `start_time` in `frequencies.txt`.

Warnings that often follow a change: [unused_shape](/en/rules/unused_shape) when a removed variant leaves its shape behind, [stop_without_stop_time](/en/rules/stop_without_stop_time) for a stop no longer served, [unusable_trip](/en/rules/unusable_trip) for a trip cut down to a single call, [fast_travel_between_consecutive_stops](/en/rules/fast_travel_between_consecutive_stops) for running times that are too short.

## Fix or accept

- **A new error introduced by your change**: fix it before delivering.
- **An error already in the reference feed**: it can be delivered knowingly, provided someone decides so explicitly. Fix it if it is simple, otherwise report it to the producer.
- **A warning**: case by case. [stop_too_far_from_shape](/en/rules/stop_too_far_from_shape) is checked on a map (wrong coordinates or an outdated shape). [expired_calendar](/en/rules/expired_calendar) on an old service with no trips has no effect on riders but clutters the feed. [feed_expiration_date_30_days](/en/rules/feed_expiration_date_30_days) says a new version is due. [mixed_case_recommended_field](/en/rules/mixed_case_recommended_field) shows on riders' screens.
- **An info**: nothing to do, unless it reveals an intent that was written wrongly.

## In GTFS Express

The validator's report (version 8.0.0) can be read free and without an account, along with a diagnostic that goes beyond the validator. It lists rules by severity with their occurrences; "Fix one by one" opens each offending row in the editor with the field flagged, then "Re-validate" runs the validator again. When you modify a network, a new error blocks the delivery, and errors already in the reference feed are accepted by name.

## Further reading

- [All validation rules](/en/rules/)
- [How to modify a GTFS feed](/en/guides/modify-a-gtfs-feed)
- [Add a stop to a GTFS feed](/en/guides/add-a-stop-to-a-gtfs-feed)
