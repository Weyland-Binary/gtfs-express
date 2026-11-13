---
title: "fast_travel_between_consecutive_stops: implausible speed"
description: Between two consecutive stops of a trip, the distance and the times imply a speed the mode cannot reach. Common causes and the fix in stop_times.txt.
updated: 2026-10-21
---

## What this rule means

For each trip, the validator takes two consecutive stops in `stop_times.txt`, measures the distance between their positions in `stops.txt` and divides it by the time between the departure from the first and the arrival at the second. If the resulting speed exceeds the plausible limit for the route's mode (`route_type`), for example more than 150 km/h for a bus, it raises this notice. Severity: **warning**.

The limits depend on the mode: a train may run far faster than a tram. The report gives the computed speed and the two stops involved.

## Why it matters

A warning does not block a delivery in GTFS Express, but an impossible speed nearly always points to wrong data. Riders get an unrealistic travel time, and a journey planner may offer a connection that does not work on the street.

## Common causes

- A stop with wrong coordinates, placed in another town or at latitude zero.
- A typo in a time, `08:05:00` instead of `08:50:00`.
- Two distant stops sharing the same time, because a stop in between was removed or times were rounded to the minute.
- Times shifted by one hour on part of the trip.

## How to fix it

Check the position of both stops first (`stop_lat`, `stop_lon`). If they are right, correct `arrival_time` or `departure_time` in `stop_times.txt` so that the running time matches the real distance.

In GTFS Express, the validation report lists each occurrence with its trip and its two stops. "Fix one by one" opens the `stop_times.txt` row in the editor with the field flagged, and the trip's timetable helps spot the odd value. The correction becomes a retouch in the draft, then "Re-validate" runs the check again.

## Example

Stops `STATION` and `NORTH_PARK` are 9 km apart, yet the trip takes one minute:

```
trip_id,arrival_time,departure_time,stop_id,stop_sequence
T12,08:04:00,08:05:00,STATION,5
T12,08:06:00,08:06:00,NORTH_PARK,6
```

The real time was `08:16:00`:

```
trip_id,arrival_time,departure_time,stop_id,stop_sequence
T12,08:04:00,08:05:00,STATION,5
T12,08:16:00,08:16:00,NORTH_PARK,6
```

See also the guide [Validate a GTFS feed](/en/guides/validate-a-gtfs-feed) and the [list of rules](/en/rules/).
