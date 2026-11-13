---
title: "block_trips_with_overlapping_stop_times: overlapping trips in a block"
description: Two trips with the same block_id overlap in time on a common day, which one vehicle cannot do. Why it happens and how to fix it in trips.txt.
updated: 2026-10-21
---

## What this rule means

The `block_id` field of `trips.txt` groups the trips one vehicle runs in sequence. A vehicle runs one trip at a time, so two trips of the same block must not overlap. The rule fires when two trips sharing a `block_id` run on the same day (their `service_id` values have at least one date in common) and the span from the first to the last time of one trip overlaps the span of the other.

Severity: **error**.

## Why it matters

Feed consumers use `block_id` to tell riders they can stay on board from one trip to the next, and to match real-time data to the right vehicle. An impossible block breaks both: "stay on board" connections announced wrongly, vehicle positions attached to the wrong trip.

## Common causes

- A trip moved in time without its block being reviewed.
- `block_id` values reused from one period to the next while the two periods' calendars overlap.
- Two services (weekday and Saturday, for example) carrying the same `block_id` and sharing dates because of an exception in `calendar_dates.txt`.
- A `block_id` filled in by mistake with the route number or a commercial service code.

## How to fix it

For each reported pair, first check the two trips' times in `stop_times.txt`: if one is wrong, correct it. If the times are right, the block is wrong: give one of the trips the `block_id` of the vehicle that actually runs it, or empty the field if that information is not known (it is optional). If the two trips were not meant to run on the same day, the calendar is what needs fixing.

In GTFS Express, the validation report names the trips involved. "Fix one by one" opens the row concerned in the editor; each correction is a retouche in the draft, and "Re-validate" checks that the block now holds.

## Example

Trip `T2` leaves before `T1` arrives, with the same vehicle:

```
trip_id,arrival_time,departure_time,stop_id,stop_sequence
T1,07:00:00,07:00:00,S100,1
T1,07:40:00,07:40:00,S200,2
T2,07:30:00,07:30:00,S200,1
T2,08:10:00,08:10:00,S100,2
```

```
route_id,service_id,trip_id,block_id
L1,WKD,T1,B12
L1,WKD,T2,B12
```

If `T2` is run by another vehicle, it gets another block:

```
route_id,service_id,trip_id,block_id
L1,WKD,T1,B12
L1,WKD,T2,B14
```

See also the [list of validation rules](/en/rules/).
