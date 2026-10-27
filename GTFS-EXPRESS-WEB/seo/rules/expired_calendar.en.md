---
title: "expired_calendar: service whose period has ended"
description: A service in calendar.txt has an end_date already in the past. What it means for the trips that use it and how to clean the GTFS feed up safely.
updated: 2026-10-21
---

## What this rule means

Each service in `calendar.txt` runs from `start_date` to `end_date`. When a service's end date is earlier than the validation date, the validator raises this notice: the service will never run again. Exceptions in `calendar_dates.txt` count too, an addition (`exception_type` = 1) on a future date keeps the service alive. Severity: **warning**.

## Why it matters

A warning does not block a delivery in GTFS Express. Trips of an expired service show in no app, but they make the feed heavier and mislead anyone reusing the data: a line looks served when it no longer is. If every service has expired, the feed no longer describes any timetable at all.

## Common causes

- The new season's feed was built by adding services without removing the previous season's.
- A service for past school holidays was left in the file.
- The end date was mistyped, `20250630` instead of `20260630`.
- The file is simply old and was never republished.

## How to fix it

If the service still runs, correct `end_date` in `calendar.txt`. If it has ended, delete it together with the trips in `trips.txt` that reference its `service_id`, their rows in `stop_times.txt` and its rows in `calendar_dates.txt`. Deleting the service alone would leave trips pointing to a missing `service_id`, which is an error.

In GTFS Express, the validation report lists the services involved. "Fix one by one" opens each `calendar.txt` row in the editor with the date flagged. Each change is a retouch in the draft, and "Re-validate" confirms the warning is gone without a new error.

## Example

Service `WINTER_25` stopped in March 2026:

```
service_id,monday,tuesday,wednesday,thursday,friday,saturday,sunday,start_date,end_date
WINTER_25,1,1,1,1,1,0,0,20250901,20260315
WEEK_26,1,1,1,1,1,0,0,20260316,20270705
```

Its trips no longer run. Remove `WINTER_25` and its trips, keep `WEEK_26`.

See also the guide [School holidays and public holidays in GTFS](/en/guides/school-holidays-and-public-holidays-in-gtfs) and the [list of rules](/en/rules/).
