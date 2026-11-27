---
title: "stop_without_stop_time: stop that no trip serves"
description: A stop in stops.txt appears in no row of stop_times.txt. Why a stop without departures misleads riders, and how to remove it or have trips serve it.
updated: 2026-10-21
---

## What this rule means

A stop or platform in `stops.txt` (`location_type` empty or 0) only makes sense if at least one trip calls there, that is if its `stop_id` appears in `stop_times.txt`. When no row of `stop_times.txt` cites it, the validator raises this notice. Stations, entrances and generic nodes (`location_type` 1 to 4) are out of scope: trips never call at them directly. Severity: **warning**.

## Why it matters

A warning does not block a delivery in GTFS Express. But a stop with no departures shows on app maps without any timetable, and a journey planner may walk a rider to it to wait for a bus that never comes. For reusers, it skews the count of stops served.

## Common causes

- A route was removed or shortened and its end stops stayed.
- A stop was replaced by a new `stop_id` when it moved.
- Stops of a temporary diversion stayed after the works ended.
- Stops were created ahead of a service that has not started yet.

## How to fix it

If the stop is no longer served, delete it from `stops.txt`. Check first that no other file cites it, `transfers.txt` or `pathways.txt` for instance, otherwise the deletion creates a foreign key error. If the stop should be served, add it to the relevant trips in `stop_times.txt`, with its times and a `stop_sequence` in the right place.

In GTFS Express, the validation report lists the stops involved and "Fix one by one" opens each in the editor; the reader's map shows where it lies relative to the lines. Each deletion or addition is a retouch in the draft, then "Re-validate" runs the check again.

## Example

Stop `POOL_TEMP` served a diversion that has ended:

```
stop_id,stop_name,stop_lat,stop_lon,location_type
POOL,Swimming Pool,49.8812,2.3104,0
POOL_TEMP,Swimming Pool (temporary),49.8818,2.3121,0
```

No trip cites it in `stop_times.txt` and no other file references it, so its row is deleted.

See also the guide [Add a stop to a GTFS feed](/en/guides/add-a-stop-to-a-gtfs-feed) and the [list of rules](/en/rules/).
