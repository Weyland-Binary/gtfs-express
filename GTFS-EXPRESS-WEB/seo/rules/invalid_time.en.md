---
title: "invalid_time: time value in the wrong format in a GTFS feed"
description: A time field does not follow the GTFS HH:MM:SS format. The values invalid_time rejects, how times after midnight are written and how to fix them.
updated: 2026-10-21
---

## What this rule means

GTFS times are written `HH:MM:SS` in the network's local time, counted from the start of the service day: `08:05:00`. Before 10 o'clock the hour may have a single digit (`8:05:00`). The fields concerned are mainly `arrival_time` and `departure_time` in `stop_times.txt`, and `start_time` and `end_time` in `frequencies.txt`. The rule fires when a value does not follow that format.

A time past `24:00:00` is valid and expected: a trip leaving at 23:50 and arriving at 00:20 the next morning is written `23:50:00` then `24:20:00`, on the same service day.

Severity: **error**.

## Why it matters

A time that cannot be read cannot be placed in the day. The stop time is dropped, or the whole trip is discarded by the tools that build journeys and printed timetables.

## Common causes

- A spreadsheet saving `8:05` without seconds, or a fraction of a day (`0.3368`) instead of the time.
- A 12-hour notation (`8:05 PM`) or another separator (`8h05`, `08.05.00`).
- Times after midnight written `00:20:00` instead of `24:20:00`: the format is valid, but the time then falls at the start of the day, which other rules report.
- A stray space or comma in the cell.

## How to fix it

Rewrite each reported value as `HH:MM:SS`, adding the seconds where needed, and carry times after midnight past 24 when the trip belongs to the previous service day. If the file comes out of a spreadsheet, format the column as text before exporting so the problem does not come back.

In GTFS Express, the report lists each occurrence with the file, row, field and offending value. "Fix one by one" opens the stop time in the editor; each correction is a retouche in the draft, and "Re-validate" runs the validator again.

## Example

```
trip_id,arrival_time,departure_time,stop_id,stop_sequence
T2301,23:50,23:50,S100,1
T2301,0:05:00,0:05:00,S205,2
```

Fixed:

```
trip_id,arrival_time,departure_time,stop_id,stop_sequence
T2301,23:50:00,23:50:00,S100,1
T2301,24:05:00,24:05:00,S205,2
```

See also the guide [Validate a GTFS feed](/en/guides/validate-a-gtfs-feed).
