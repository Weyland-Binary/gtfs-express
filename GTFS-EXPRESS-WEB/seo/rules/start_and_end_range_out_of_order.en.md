---
title: "start_and_end_range_out_of_order: range that starts after it ends"
description: In frequencies.txt, the start_time of a frequency range is equal to or later than its end_time. What this GTFS error reports and how to correct it.
updated: 2026-10-21
---

## What this rule means

`frequencies.txt` describes frequency-based trips rather than fixed times: for a `trip_id`, a range from `start_time` to `end_time` and a `headway_secs` interval between departures. A range must start before it ends. The GTFS Express catalogue describes the `frequencies.txt` case: the rule fires when `start_time` is greater than or equal to `end_time`. The MobilityData validator uses the same code for date ranges whose start comes after their end, in `calendar.txt` and `feed_info.txt`.

Severity: **error**.

## Why it matters

A reversed or empty range produces no departures. The trips the frequency was meant to generate are missing from the timetable, or the consuming tool rejects the row. On a high-frequency line, a whole part of the day often disappears.

## Common causes

- A range running past midnight written `22:00:00` to `01:00:00` instead of `22:00:00` to `25:00:00`.
- The two columns swapped during entry or conversion.
- An end time equal to the start time, when a range was shortened to nothing without being deleted.
- A time mangled by a spreadsheet (see [invalid_time](/en/rules/invalid_time)).

## How to fix it

In `frequencies.txt`, correct `start_time` or `end_time` so that the range starts before it ends. A range that runs past midnight keeps times beyond 24 on the same service day. An empty range that has no purpose left should be deleted. While you are there, check that the ranges of one `trip_id` do not overlap.

In GTFS Express, each occurrence in the report names the `frequencies.txt` row concerned. "Fix one by one" opens it in the editor with the field flagged; the correction becomes a retouche in the draft, and "Re-validate" runs the validator again.

## Example

```
trip_id,start_time,end_time,headway_secs
T_EVENING,20:00:00,22:00:00,900
T_NIGHT,22:00:00,01:00:00,1800
```

Fixed:

```
trip_id,start_time,end_time,headway_secs
T_EVENING,20:00:00,22:00:00,900
T_NIGHT,22:00:00,25:00:00,1800
```

See also the [list of validation rules](/en/rules/).
