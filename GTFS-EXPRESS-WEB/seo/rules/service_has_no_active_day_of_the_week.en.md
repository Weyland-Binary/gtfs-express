---
title: "service_has_no_active_day_of_the_week: service with no weekday"
description: A calendar.txt service has all seven days of the week set to 0. What the validator reports, when it is intended, and how to fix it.
updated: 2026-11-13
---

## What this rule means

In `calendar.txt`, each `service_id` states the days of the week it runs (`monday` to `sunday`, `1` or `0`) between `start_date` and `end_date`. The rule fires when a row of `calendar.txt` has all seven days set to `0`: by its days of the week, the service never runs.

For this rule the validator reads `calendar.txt` alone. It reports the row even when `calendar_dates.txt` adds dates to the service (`exception_type` = `1`).

Severity: **warning**.

## Why it matters

A warning does not block a delivery in GTFS Express. But if no date is added to the service in `calendar_dates.txt`, every trip in `trips.txt` carrying that `service_id` disappears from the published timetable. And if the service lives by its dates only, its row in `calendar.txt` adds nothing and leaves a doubt for whoever reads the file next.

## Common causes

- A service switched off by setting its days to `0` instead of deleting it.
- A service defined by its dates (public holidays, school holidays) that kept a row without a day in `calendar.txt`.
- A service whose dates in `calendar_dates.txt` were lost or attached to another `service_id`.

## How to fix it

Decide whether the service should run. If it runs on some days of the week, set those days to `1` in `calendar.txt`. If it runs on given dates only, keep its dates in `calendar_dates.txt` and delete its row from `calendar.txt`: a service can exist by its dates alone. If it is no longer used, delete it together with the trips that use it (and their `stop_times`), or move those trips to a service that runs.

In GTFS Express, the validation report names the `service_id` concerned. "Fix one by one" opens its row of `calendar.txt` in the editor; each change is a retouche in the draft, and "Re-validate" runs the validator again.

## Example

```
service_id,monday,tuesday,wednesday,thursday,friday,saturday,sunday,start_date,end_date
HOLIDAY,0,0,0,0,0,0,0,20260901,20270831
```

The `HOLIDAY` service runs on public holidays, which `calendar_dates.txt` gives:

```
service_id,date,exception_type
HOLIDAY,20261101,1
HOLIDAY,20261111,1
HOLIDAY,20261225,1
```

These dates are enough to define the service. Once the `HOLIDAY` row is deleted from `calendar.txt`, the warning goes and the service runs on the same dates.

See also the guide [School holidays and public holidays in GTFS](/en/guides/school-holidays-and-public-holidays-in-gtfs).
