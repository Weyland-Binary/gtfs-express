---
title: "stop_time_timepoint_without_times: exact timepoint with no time"
description: A stop time in stop_times.txt is flagged as an exact timepoint but has neither an arrival nor a departure time. Why it happens and how to fix it.
updated: 2026-10-21
---

## What this rule means

The `timepoint` field of `stop_times.txt` says whether a stop time's times are exact (`1`) or approximate (`0`). A stop time flagged as exact must carry its times: `arrival_time` and `departure_time`. The rule fires on a stop time with `timepoint=1` and no time. The GTFS Express catalogue also treats an empty `timepoint` as exact.

Severity: **error**.

## Why it matters

A timepoint without a time contradicts itself: the feed promises a scheduled time at that stop and does not give it. Tools that interpolate times at intermediate stops rely on the timed points; an empty one removes an anchor, and some consumers drop the trip.

## Common causes

- An export that sets `timepoint` to `1` on every stop time by default, although only some stops have a time.
- Times deleted at intermediate stops to let interpolation work, without setting `timepoint` to `0`.
- A stop inserted into a trip without a time, with the `timepoint` value copied from a neighbouring row.

## How to fix it

There are two possible fixes, depending on what is true on the street. If the stop is a timing point, fill in `arrival_time` and `departure_time` from the timetable. If it is not, set `timepoint` to `0` and leave the times empty: consumers interpolate them between the timed points. The first and last stops of a trip must always have their times (see [missing_trip_edge](/en/rules/missing_trip_edge)).

In GTFS Express, each occurrence in the report names the stop time and the field. "Fix one by one" opens the stop time in the editor; each correction is a retouche in the draft, and "Re-validate" runs the validator again.

## Example

```
trip_id,arrival_time,departure_time,stop_id,stop_sequence,timepoint
T501,07:00:00,07:00:00,S100,1,1
T501,,,S110,2,1
T501,07:12:00,07:12:00,S120,3,1
```

Fixed, stop `S110` not being a timing point:

```
trip_id,arrival_time,departure_time,stop_id,stop_sequence,timepoint
T501,07:00:00,07:00:00,S100,1,1
T501,,,S110,2,0
T501,07:12:00,07:12:00,S120,3,1
```

See also the [list of validation rules](/en/rules/).
