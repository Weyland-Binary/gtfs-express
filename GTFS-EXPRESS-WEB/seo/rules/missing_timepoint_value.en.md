---
title: "missing_timepoint_value: timepoint left empty"
description: A row of stop_times.txt leaves the timepoint field empty. Why to set 0 or 1 explicitly, and how to tell exact times from approximate ones in a feed.
updated: 2026-10-21
---

## What this rule means

The `timepoint` field of `stop_times.txt` says whether a call's time is held exactly (`1`) or only approximate (`0`). It is optional, but the GTFS reference recommends filling it on every row that carries times. When a row leaves it empty, the validator raises this notice. Severity: **warning**.

Without a value, the reference treats times as exact.

## Why it matters

A warning does not block a delivery in GTFS Express. The risk is announcing as guaranteed a time that is not. Many networks only hold the timetable at a few timing points and estimate the calls in between. If `timepoint` is empty everywhere, an app cannot tell the difference and presents every minute as a promise; a rider who reaches an intermediate stop on the dot may find the bus already gone.

## Common causes

- The export tool does not write the column, or writes it empty.
- Intermediate times were interpolated without marking them as approximate.
- The column was filled for a few trips only.

## How to fix it

Fill `timepoint` on every row of `stop_times.txt`: `1` at the stops where the time is held (often the termini and the timing points), `0` elsewhere. A row with neither `arrival_time` nor `departure_time` should carry `0`: `1` without times is an error, described by the rule [stop_time_timepoint_without_times](/en/rules/stop_time_timepoint_without_times).

In GTFS Express, the validation report lists the rows involved and "Fix one by one" opens each in the editor with the field flagged. When the rule covers a whole bus line, it is quicker to fill the column for all its trips in the draft; each change is a retouch, then "Re-validate" runs the check again.

## Example

```
trip_id,arrival_time,departure_time,stop_id,stop_sequence,timepoint
T3,07:30:00,07:30:00,STATION,1,
T3,07:34:00,07:34:00,SCHOOL,2,
T3,07:41:00,07:41:00,HOSPITAL,3,
```

Corrected, the time being held only at both ends:

```
trip_id,arrival_time,departure_time,stop_id,stop_sequence,timepoint
T3,07:30:00,07:30:00,STATION,1,1
T3,07:34:00,07:34:00,SCHOOL,2,0
T3,07:41:00,07:41:00,HOSPITAL,3,1
```

See also the [list of rules](/en/rules/).
