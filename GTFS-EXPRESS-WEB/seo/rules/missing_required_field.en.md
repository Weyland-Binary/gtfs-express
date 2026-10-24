---
title: "missing_required_field: required field left empty in a GTFS file"
description: A field the GTFS specification makes required is empty on a row of the file. What missing_required_field reports and how to fill the gap correctly.
updated: 2026-10-21
---

## What this rule means

The column is present in the file, but one or more rows leave it empty although the GTFS Schedule reference requires a value. Examples: `agency_name` in `agency.txt`, `stop_id` in `stops.txt`, `route_id` or `trip_id` in `trips.txt`, `stop_sequence` in `stop_times.txt`. Some fields are only conditionally required: `stop_lat` and `stop_lon` are required for stops and stations (`location_type` 0 or 1, or empty), not for a generic node.

Severity: **error**.

## Why it matters

A required field carries information the object makes no sense without: a trip without `route_id` belongs to no route, a stop time without `stop_sequence` cannot be ordered, a stop without coordinates cannot be placed on a map. Feed consumers often drop the whole row.

## Common causes

- An export that writes the column header but no values, for instance when the source system does not hold that information.
- A spreadsheet that empties a cell (a deleted formula, a partial paste).
- A row added by hand with a field forgotten.
- A conditional field misread, for example a `location_type` changed without adding coordinates.

## How to fix it

Fill in the missing value on each reported row, in the file and field given. If the value is not known, get it from the operator's source data rather than typing something that merely passes validation. If the whole row is a leftover with no purpose, delete it along with whatever depends on it.

In GTFS Express, each occurrence in the report gives the file, the row and the empty field. "Fix one by one" opens the row in the editor with the field flagged; typing the value creates a retouche in the draft. "Re-validate" then checks that no occurrence is left.

## Example

The second trip has no `route_id`:

```
route_id,service_id,trip_id,direction_id
L1,WKD,T1001,0
,WKD,T1002,1
```

Fixed:

```
route_id,service_id,trip_id,direction_id
L1,WKD,T1001,0
L1,WKD,T1002,1
```

See also the guide [Validate a GTFS feed](/en/guides/validate-a-gtfs-feed).
