---
title: "missing_trip_edge: first or last stop of a trip without a time"
description: The first or last stop time of a trip in stop_times.txt has no time, although a trip's ends must always be timed. Common causes and how to fix it.
updated: 2026-10-21
---

## What this rule means

In `stop_times.txt`, a trip's intermediate stops may be left without times: consumers then interpolate them between the timed stops. The two ends, however, must carry `arrival_time` and `departure_time`. The rule fires when the first or last stop time of a trip (by `stop_sequence`) lacks its times.

Severity: **error**.

## Why it matters

Without a departure time at the origin or an arrival time at the terminus, the trip has no start or end in time. Interpolating the intermediate stops becomes impossible, the trip cannot be placed in the day, and most tools that consume the feed drop it.

## Common causes

- A stop added at the start or end of a trip (a line extended) without its times.
- An export that keeps times only at timing points, while the terminus is not one in the source system.
- A `stop_sequence` out of order, so that an untimed intermediate stop ends up first or last.
- The first or last stop deleted, leaving an untimed intermediate stop in its place.

## How to fix it

For each reported trip, fill in `arrival_time` and `departure_time` on the first and last stop times, from the timetable or the real running time. If the stop ended up first or last because of an ordering mistake, correct `stop_sequence` to put the stop times back in their real order. Keep the times consistent with the neighbouring stop times, or other rules will report them.

In GTFS Express, each occurrence in the report names the trip and the stop time concerned. "Fix one by one" opens the stop time in the editor with the field flagged; each correction is a retouche in the draft, and "Re-validate" runs the validator again.

## Example

Trip `T720` was extended to stop `S300` without a time:

```
trip_id,arrival_time,departure_time,stop_id,stop_sequence
T720,08:00:00,08:00:00,S100,1
T720,08:14:00,08:14:00,S200,2
T720,,,S300,3
```

Fixed:

```
trip_id,arrival_time,departure_time,stop_id,stop_sequence
T720,08:00:00,08:00:00,S100,1
T720,08:14:00,08:14:00,S200,2
T720,08:21:00,08:21:00,S300,3
```

See also the guide [Add a stop to a GTFS feed](/en/guides/add-a-stop-to-a-gtfs-feed).
