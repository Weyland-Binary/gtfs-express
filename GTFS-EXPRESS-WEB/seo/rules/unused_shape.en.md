---
title: "unused_shape: shape that no trip uses"
description: A shape_id in shapes.txt is referenced by no trip in trips.txt. An orphan geometry to remove, or the sign that a trip has lost the shape it should have.
updated: 2026-10-21
---

## What this rule means

`shapes.txt` describes shapes, each identified by a `shape_id` and made of a sequence of points (`shape_pt_lat`, `shape_pt_lon`, `shape_pt_sequence`). A trip attaches to one through the `shape_id` field of `trips.txt`. When a shape is used by no trip, the validator raises this notice. Severity: **warning**.

## Why it matters

A warning does not block a delivery in GTFS Express. An orphan shape shows in no app, but it makes the file heavier, often by thousands of points, and misleads reusers: a shape in the feed suggests a path that is served. More to the point, it can reveal the opposite problem: a trip that should use it points to another shape, or has none.

## Common causes

- A route variant was removed with its trips, but not its shape.
- A shape was redrawn under a new `shape_id` and the old one stayed.
- An export tool writes every shape in its database, including past periods'.
- Trips in one direction were attached by mistake to the other direction's shape.

## How to fix it

First find out what the shape is: show it on a map and compare it with the route's trips. If a trip should have used it, set that trip's `shape_id` in `trips.txt`. Otherwise, delete every row of `shapes.txt` carrying that `shape_id`.

In GTFS Express, the validation report lists the shapes involved, and the reader's map lets you look at each one before deciding. The deletion or the new link is made in the draft, each change being a retouch, and "Re-validate" then runs the validator again.

## Example

Shape `SH_7_OLD` remained after route 7 was redrawn:

```
shape_id,shape_pt_lat,shape_pt_lon,shape_pt_sequence
SH_7_OLD,49.8941,2.2958,1
SH_7_OLD,49.8950,2.2981,2
SH_7,49.8941,2.2958,1
```

```
route_id,service_id,trip_id,shape_id
L7,WEEK,T7_001,SH_7
L7,WEEK,T7_002,SH_7
```

No trip cites `SH_7_OLD`, so its points are deleted.

See also the guide [Modify a GTFS feed](/en/guides/modify-a-gtfs-feed) and the [list of rules](/en/rules/).
