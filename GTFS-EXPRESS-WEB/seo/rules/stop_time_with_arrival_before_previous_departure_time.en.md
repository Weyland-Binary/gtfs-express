---
title: "stop_time_with_arrival_before_previous_departure_time: time goes back"
description: Within a trip, the arrival time at a stop is earlier than the departure time from the previous stop. Why this GTFS error appears and how to fix the times.
updated: 2026-10-21
---

## What this rule means

In `stop_times.txt`, the stop times of a trip are ordered by `stop_sequence`. A vehicle cannot reach a stop before leaving the previous one: the `arrival_time` of a stop time must be greater than or equal to the `departure_time` of the one before it. The rule fires when it is strictly smaller. Stop times without times (untimed intermediate stops) are skipped: the comparison is made with the last stop time that has one.

Severity: **error**.

## Why it matters

A negative running time makes the trip incoherent. Journey planners may offer impossible connections, show times out of order or drop the trip. In the report, this error often comes with other notices on the same trip.

## Common causes

- Times after midnight written `00:10:00` instead of `24:10:00` on a trip that started the evening before.
- A `stop_sequence` that does not follow the real order of calls, for instance after a stop was inserted.
- A typing error on a time (`08:15` entered as `07:15`).
- A trip shifted by hand on only part of its stops.

## How to fix it

Look at the whole trip in `stop_times.txt`, sorted by `stop_sequence`, and find where the times go backwards. Correct the wrong time, or put `stop_sequence` back into the real order if the stops are the ones out of place. For a trip that runs past midnight, every time after midnight goes beyond 24.

In GTFS Express, each occurrence in the report names the trip and the stop time. "Fix one by one" opens the stop time in the editor with the field flagged. Each correction is a retouche in the draft, and "Re-validate" confirms the result.

## Example

```
trip_id,arrival_time,departure_time,stop_id,stop_sequence
T2240,23:52:00,23:52:00,S100,1
T2240,23:58:00,23:58:00,S110,2
T2240,00:04:00,00:04:00,S120,3
```

Fixed:

```
trip_id,arrival_time,departure_time,stop_id,stop_sequence
T2240,23:52:00,23:52:00,S100,1
T2240,23:58:00,23:58:00,S110,2
T2240,24:04:00,24:04:00,S120,3
```

See also the [list of validation rules](/en/rules/).
