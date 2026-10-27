---
title: "decreasing_or_equal_stop_time_distance: distance not increasing"
description: In stop_times.txt, shape_dist_traveled does not increase from one stop to the next on a trip. What this GTFS error reports and how to correct it.
updated: 2026-10-21
---

## What this rule means

The optional `shape_dist_traveled` field of `stop_times.txt` gives, for each stop time, the distance travelled from the start of the trip's shape (`shapes.txt`). It is a cumulative distance, so it must increase strictly from one stop time to the next in `stop_sequence` order. The rule fires when a stop time's value is lower than or equal to the previous one. Stop times where the field is empty are not compared.

Severity: **error**.

## Why it matters

Feed consumers use `shape_dist_traveled` to place each stop on the shape, especially when a route passes close to the same point twice (a loop, both directions on the same road). A distance that goes back or stands still puts the stop in the wrong place: the shape drawn between two stops is wrong, and real-time vehicle positions can be misread.

## Common causes

- Distances in different units across trips or files (metres in one place, kilometres in another).
- A stop inserted or moved in the trip without the distances being recomputed.
- Two consecutive stops given the same value because the distance was rounded to the kilometre.
- A `stop_sequence` that does not follow the real order of calls.
- Distances computed on a different shape from the trip's `shape_id`.

## How to fix it

Recompute the trip's `shape_dist_traveled` by projecting each stop onto its shape, in `stop_sequence` order, in the same unit as `shapes.txt`. If the distances cannot be recomputed reliably, empty the field for the whole trip: it is optional, and a missing value is better than a wrong one. If the order of stops is what is wrong, correct `stop_sequence`.

In GTFS Express, each occurrence in the report names the trip and the stop time. "Fix one by one" opens the stop time in the editor with the field flagged; each correction is a retouche in the draft, and "Re-validate" runs the validator again.

## Example

```
trip_id,stop_id,stop_sequence,shape_dist_traveled
T310,S100,1,0
T310,S110,2,1250
T310,S120,3,1.9
T310,S130,4,2600
```

The third stop time is in kilometres. Fixed:

```
trip_id,stop_id,stop_sequence,shape_dist_traveled
T310,S100,1,0
T310,S110,2,1250
T310,S120,3,1900
T310,S130,4,2600
```

See also the [list of validation rules](/en/rules/).
