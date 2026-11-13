---
title: "service_without_service_days: service that never runs"
description: A calendar.txt service has every weekday set to 0 and no date added in calendar_dates.txt, so its trips never run. Common causes and how to fix it.
updated: 2026-10-21
---

## What this rule means

In `calendar.txt`, each `service_id` states the days of the week it runs (`monday` to `sunday`, `1` or `0`) between `start_date` and `end_date`. Exceptions in `calendar_dates.txt` add a date (`exception_type` = `1`) or remove one (`exception_type` = `2`). The rule fires when a service has all seven days set to `0` and no exception adds a date to it: it runs on no day at all.

Severity: **error**.

## Why it matters

Every trip in `trips.txt` carrying that `service_id` disappears from the published timetable. If those trips are meant to run (a public holiday service, a school holiday service), the real service is incomplete; if not, the feed holds dead data that gets in the way of reading and maintaining it.

## Common causes

- A service defined only by its dates, whose exceptions in `calendar_dates.txt` were lost or attached to another `service_id`.
- A service switched off by setting its days to `0` instead of deleting it.
- A public holiday or school holiday service whose dates were not carried over to the new year.
- A difference in case or a stray space between the `service_id` in `calendar.txt` and the one in `calendar_dates.txt`.

## How to fix it

Decide whether the service should run. If it should, set the right days in `calendar.txt` or add its dates to `calendar_dates.txt` with `exception_type` = `1`. If it is no longer used, delete it from `calendar.txt` together with the trips that use it (and their `stop_times`), or move those trips to a service that runs. A service defined only by dates can also live without a row in `calendar.txt`, in `calendar_dates.txt` alone.

In GTFS Express, the validation report names the `service_id` concerned. "Fix one by one" opens its row of `calendar.txt` in the editor; each change is a retouche in the draft, and "Re-validate" confirms that the service runs.

## Example

```
service_id,monday,tuesday,wednesday,thursday,friday,saturday,sunday,start_date,end_date
HOLIDAY,0,0,0,0,0,0,0,20260901,20270831
```

There is no `HOLIDAY` row in `calendar_dates.txt`. Adding the public holidays of the period fixes the error:

```
service_id,date,exception_type
HOLIDAY,20261101,1
HOLIDAY,20261111,1
HOLIDAY,20261225,1
```

See also the guide [School holidays and public holidays in GTFS](/en/guides/school-holidays-and-public-holidays-in-gtfs).
