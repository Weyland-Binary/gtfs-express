---
title: "feed_expiration_date_30_days: feed expires within 30 days"
description: The feed_end_date in feed_info.txt falls within the next 30 days. What it signals for rider apps and journey planners, and how to respond in time.
updated: 2026-10-21
---

## What this rule means

`feed_info.txt` can state the period a feed covers with `feed_start_date` and `feed_end_date`. When `feed_end_date` is less than 30 days after the validation date, the validator raises this notice. It has a sibling notice for an even closer end, within 7 days. Severity: **warning**.

The rule does not say the data is wrong today. It says the data will soon stop covering the service.

## Why it matters

A warning does not block a delivery in GTFS Express. But after `feed_end_date`, apps and journey planners have no timetable left to offer: the network drops out of their results, and some reusers set aside a feed they consider stale. Best practice is to publish a feed covering at least the next 30 days, ideally the whole period already known.

## Common causes

- Next season's feed has not been produced or published yet.
- `feed_end_date` was left at an old value although the calendars were extended.
- Calendars stop at the end of a school term while the next term's timetable is pending.

## How to fix it

The real fix is to publish data covering the coming period: extend or add services in `calendar.txt` and `calendar_dates.txt`, then align `feed_end_date` with the last service date. Do not push `feed_end_date` back on its own: the date must reflect the calendars, otherwise the file promises timetables it does not hold.

In GTFS Express, the validation report shows the date involved and "Fix one by one" opens `feed_info.txt` in the editor. New services are prepared in a draft, each change being a retouch, and "Re-validate" then checks the result.

## Example

Validated on 21 October 2026, this feed expires on 2 November:

```
feed_publisher_name,feed_publisher_url,feed_lang,feed_start_date,feed_end_date
Example Transit,https://transit.example.org,en,20260901,20261102
```

After adding the next period's services:

```
feed_publisher_name,feed_publisher_url,feed_lang,feed_start_date,feed_end_date
Example Transit,https://transit.example.org,en,20260901,20270704
```

See also the guide [Modify a GTFS feed](/en/guides/modify-a-gtfs-feed) and the [list of rules](/en/rules/).
