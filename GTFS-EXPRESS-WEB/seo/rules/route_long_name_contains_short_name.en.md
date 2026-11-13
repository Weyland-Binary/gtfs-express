---
title: "route_long_name_contains_short_name: long name repeats the number"
description: In routes.txt, route_long_name repeats route_short_name, for instance "Route 4 Station - Hospital" for line 4. Why it is redundant and how to correct it.
updated: 2026-10-21
---

## What this rule means

A route in `routes.txt` has two names. `route_short_name` is the label riders read on the bus or the map, short and often a number (`4`, `C2`, `N`). `route_long_name` describes the line, usually by its termini or the area it serves. The GTFS reference asks that the long name does not repeat the short one. When `route_long_name` contains `route_short_name` as a word of its own, the validator raises this notice. Severity: **warning**.

## Why it matters

A warning does not block a delivery in GTFS Express. But most apps show both fields side by side: a "4" badge followed by "Route 4 Station - Hospital" repeats itself, takes room on small screens, and a screen reader says it twice. The long name also stops doing its job, which is to say where the line goes.

## Common causes

- The long name was filled with the full public name, number included.
- The feed comes from a system with a single name field, copied into both columns.
- A word like "Route" or "Bus" was put in front of the number to make the long name read better.

## How to fix it

Remove the number, and the word that goes with it, from `route_long_name`, keeping only the description: termini, corridor or area served. Keep the number in `route_short_name`. If a route has no number, `route_long_name` alone is enough, and the other way round.

In GTFS Express, the validation report lists the routes involved and "Fix one by one" opens each in the editor with `route_long_name` flagged. Each corrected name is a retouch in the draft, and "Re-validate" confirms the result.

## Example

```
route_id,route_short_name,route_long_name,route_type
L4,4,Route 4 Station - Hospital,3
LC2,C2,C2 Centre - Campus,3
```

Corrected:

```
route_id,route_short_name,route_long_name,route_type
L4,4,Station - Hospital,3
LC2,C2,Centre - Campus,3
```

See also the guide [Modify a GTFS feed](/en/guides/modify-a-gtfs-feed) and the [list of rules](/en/rules/).
