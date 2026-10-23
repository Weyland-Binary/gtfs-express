---
title: "foreign_key_violation: reference to a row missing from another file"
description: An identifier used in one GTFS file does not exist in the file it points to. What foreign_key_violation means, its usual causes and how to fix it.
updated: 2026-10-21
---

## What this rule means

A field that refers to another file's primary key holds a value that file does not contain. For example, `trips.txt` uses a `route_id` that is not in `routes.txt`, `stop_times.txt` uses a `stop_id` that is not in `stops.txt`, or a `service_id` in `trips.txt` appears in neither `calendar.txt` nor `calendar_dates.txt`. The same check covers `agency_id`, `shape_id`, `parent_station`, `fare_id` and the other references the specification defines.

Severity: **error**. The MobilityData validator reports it under the same code.

## Why it matters

A broken reference makes the data unusable at that point. A journey planner cannot attach a trip with an unknown `route_id` to a line, nor place a stop time whose stop does not exist. Depending on the consumer, the offending row is dropped silently or the whole feed is rejected.

## Common causes

- A stop, route or service deleted from one file without cleaning up the files that refer to it.
- An identifier renamed on one side only.
- Files exported at different dates and then zipped together.
- An invisible difference: a trailing space, different case (`L1` and `l1`), a leading zero lost in a spreadsheet (`0042` turned into `42`).

## How to fix it

For each occurrence, decide which side is wrong. If the target was removed by mistake, recreate the missing row in the target file (`routes.txt`, `stops.txt`, `calendar.txt`...). If the reference is wrong, replace it with an identifier that exists. If the referring row no longer has a purpose, delete it together with its dependants (a deleted trip takes its `stop_times` with it).

In GTFS Express, open the validation report: each occurrence gives the file, row, field and value. "Fix one by one" opens each offending row in the editor with the field flagged. Each correction is a retouche in the draft, and "Re-validate" runs the validator again.

## Example

`trips.txt` refers to route `L7`, which `routes.txt` does not define:

```
route_id,service_id,trip_id
L1,WKD,T1001
L7,WKD,T7001
```

```
route_id,route_short_name,route_type
L1,1,3
L2,2,3
```

If the trip actually belongs to line 2, the fix goes into `trips.txt`:

```
route_id,service_id,trip_id
L1,WKD,T1001
L2,WKD,T7001
```

See also the guide [Validate a GTFS feed](/en/guides/validate-a-gtfs-feed).
