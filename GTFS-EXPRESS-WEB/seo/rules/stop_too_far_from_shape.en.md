---
title: "stop_too_far_from_shape: stop too far from its shape"
description: A stop served by a trip lies more than 100 m from that trip's shape in shapes.txt. What causes it, what it breaks for riders, and how to fix it.
updated: 2026-10-21
---

## What this rule means

The validator compares the position of every stop a trip serves (`stop_lat`, `stop_lon` in `stops.txt`) with the shape the trip references through its `shape_id`. When a stop lies further from the shape than the threshold, 100 m by default, it raises this notice. Severity: **warning**.

Only trips that carry a `shape_id` are checked. A trip without a shape is out of scope.

## Why it matters

A warning does not block a delivery in GTFS Express, but the gap is visible. Rider apps draw the line from `shapes.txt` and place stops from `stops.txt`, so the stop shows up beside the line, sometimes in the next street. Journey planners that cut the shape between two stops produce wrong segments, and distances measured along the shape stop making sense.

## Common causes

- The shape was drawn for another variant of the route (a different terminus, one loop fewer).
- The trip points at the wrong `shape_id`, often the one of the opposite direction.
- The stop's coordinates are wrong: latitude and longitude swapped, truncated decimals, a stop moved without an update.
- An old shape was kept after a diversion became permanent.

## How to fix it

First decide which side is right. If the stop is correctly placed, redraw the shape in `shapes.txt` so that it passes the stop, or attach the trip to the right `shape_id` in `trips.txt`. If the shape is right, correct the stop's `stop_lat` and `stop_lon`.

In GTFS Express, open the validation report: the rule lists its occurrences with the stop and trip involved. "Fix one by one" opens each offending row in the editor, and the map shows the stop and the shape together. Each correction is a retouch in the draft, then "Re-validate" runs the validator again.

## Example

Stop `TOWN_HALL` sits about 450 m north of shape `SH_4_OUT`:

```
stop_id,stop_name,stop_lat,stop_lon
TOWN_HALL,Town Hall,49.8985,2.2950
```

After checking on site, the corrected coordinates put it back on the street the route follows:

```
stop_id,stop_name,stop_lat,stop_lon
TOWN_HALL,Town Hall,49.8945,2.2952
```

See also the guide [Add a stop to a GTFS feed](/en/guides/add-a-stop-to-a-gtfs-feed) and the [list of rules](/en/rules/).
