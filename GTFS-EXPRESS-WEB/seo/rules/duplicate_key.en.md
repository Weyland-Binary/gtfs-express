---
title: "duplicate_key: duplicate primary key in a GTFS file"
description: Two rows of the same GTFS file share one primary key. What duplicate_key means, where duplicates usually come from and how to remove them from the feed.
updated: 2026-10-21
---

## What this rule means

Every GTFS file has a primary key that must be unique: `stop_id` in `stops.txt`, `route_id` in `routes.txt`, `trip_id` in `trips.txt`, `service_id` in `calendar.txt`. Some files have a key made of several fields: `trip_id` and `stop_sequence` in `stop_times.txt`, `service_id` and `date` in `calendar_dates.txt`, `shape_id` and `shape_pt_sequence` in `shapes.txt`. The rule fires when two rows share the same key.

Severity: **error**.

## Why it matters

A reference to a duplicated key is ambiguous: a trip with `route_id` `L3` does not say which of the two `L3` routes it follows. Consumers usually keep the first or the last row and drop the other without telling anyone. In `stop_times.txt`, two stop times with the same `stop_sequence` leave the order of stops undefined.

## Common causes

- Two exports appended together (two periods, two operators) without renumbering.
- A row copied to create a variant, with its identifier left unchanged.
- A `stop_sequence` retyped by hand after a stop was inserted.
- An exception in `calendar_dates.txt` entered twice for the same date, sometimes with two contradictory `exception_type` values.

## How to fix it

Compare the duplicated rows. If they are identical, delete one. If they describe two different things, give one of them a new identifier and update every reference that should point to it (`trips.txt`, `stop_times.txt`...). In `stop_times.txt`, renumber `stop_sequence` in the real order of calls. In `calendar_dates.txt`, keep the exception that matches the service intended that day.

In GTFS Express, the validation report lists each occurrence with its file and row. "Fix one by one" opens the rows concerned in the editor; each change becomes a retouche in the draft, and "Re-validate" confirms the duplicate is gone.

## Example

Two different stops share one `stop_id`:

```
stop_id,stop_name,stop_lat,stop_lon
S100,Station,49.8920,2.3070
S100,Town Hall,49.8945,2.2990
```

After the fix, the second gets an unused identifier and the stop times that serve it are updated:

```
stop_id,stop_name,stop_lat,stop_lon
S100,Station,49.8920,2.3070
S101,Town Hall,49.8945,2.2990
```

See also the [list of validation rules](/en/rules/).
