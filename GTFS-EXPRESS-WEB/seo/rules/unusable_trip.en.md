---
title: "unusable_trip: trip with fewer than two stops"
description: A trip in trips.txt has fewer than two rows in stop_times.txt. Nobody can ride it and journey planners ignore it. Common causes and how to fix the feed.
updated: 2026-10-21
---

## What this rule means

A trip in `trips.txt` describes a journey from one stop to another: it needs at least two calls in `stop_times.txt`, one to board and one to alight. When a trip has a single row in `stop_times.txt`, or none, the validator raises this notice. Severity: **warning**.

## Why it matters

A warning does not block a delivery in GTFS Express. But such a trip is unusable: nobody can travel on it, and journey planners drop it. The service it was meant to represent is missing for riders, with nothing in the apps to say so. For reusers, it skews the number of trips on a line.

## Common causes

- Stops were deleted from `stop_times.txt` without removing the trip that used them.
- A feed was cut down to an area or a period, leaving one call of the trip or none.
- The export lost part of `stop_times.txt`, for example a truncated file.
- A trip was created in `trips.txt` and its times were never entered.

## How to fix it

Find out what the trip was meant to do. If it really runs, complete its calls in `stop_times.txt`: at least the first and last stops, with `arrival_time` and `departure_time`, and increasing `stop_sequence` values. If it no longer exists, delete it from `trips.txt` together with any row left in `stop_times.txt` and its rows in `frequencies.txt` if there are any.

In GTFS Express, the validation report lists the trips involved and "Fix one by one" opens each in the editor; the line's timetable shows what is missing next to the neighbouring trips. Each addition or deletion is a retouch in the draft, then "Re-validate" runs the check again.

## Example

Trip `T9_014` has only one call left:

```
trip_id,arrival_time,departure_time,stop_id,stop_sequence
T9_013,17:00:00,17:00:00,STATION,1
T9_013,17:12:00,17:12:00,COLLEGE,2
T9_014,17:30:00,17:30:00,STATION,1
```

Completed from the printed timetable:

```
trip_id,arrival_time,departure_time,stop_id,stop_sequence
T9_014,17:30:00,17:30:00,STATION,1
T9_014,17:42:00,17:42:00,COLLEGE,2
```

See also the guide [Modify a GTFS feed](/en/guides/modify-a-gtfs-feed) and the [list of rules](/en/rules/).
