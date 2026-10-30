---
title: School holidays and public holidays in a GTFS feed
description: Write school periods, French holidays by zone A, B or C and public holidays with calendar.txt and calendar_dates.txt, and avoid the most common traps.
updated: 2026-10-21
slug: school-holidays-and-public-holidays-in-gtfs
---

GTFS knows nothing of school holidays or public holidays: it only knows dates. You write them with `calendar.txt`, which gives weekdays over a date range, and `calendar_dates.txt`, which adds or removes single dates. In practice a network has one service per period (school weeks, holiday weeks, Saturday, Sunday and holidays) and one exception per public holiday.

## calendar.txt and calendar_dates.txt

A row of `calendar.txt` describes a service: `service_id`, the seven columns `monday` to `sunday` (1 or 0), and `start_date` and `end_date` in `YYYYMMDD` format, both included. A `service_id` appears only once there: a service has a single date range.

A row of `calendar_dates.txt` changes a service on one date: `exception_type` 1 adds the date, 2 removes it. A service can exist only in `calendar_dates.txt`, each day it runs being a type 1 row.

A service runs on date D when D is in its range, the weekday's column is 1 and no type 2 exception removes D, or when a type 1 exception adds D. Each trip in `trips.txt` has exactly one `service_id`.

## One service per period

Since a service has one date range and a trip has one service, the most common structure is:

- a "school weekday" service over the whole year, Monday to Friday, with a type 2 exception on every holiday weekday;
- a "holiday weekday" service defined only by type 1 dates, the holiday days from Monday to Friday;
- a "Saturday" service, sometimes split the same way;
- a "Sunday and public holiday" service.

```
service_id,monday,tuesday,wednesday,thursday,friday,saturday,sunday,start_date,end_date
SCH,1,1,1,1,1,0,0,20260901,20270703
SAT,0,0,0,0,0,1,0,20260901,20270703
SUN,0,0,0,0,0,0,1,20260901,20270703
```

For one holiday week (example dates), the school service loses each day and the holiday service gains it:

```
service_id,date,exception_type
SCH,20261019,2
HOL,20261019,1
SCH,20261020,2
HOL,20261020,1
```

Splitting the year into several school services (one per term between holidays) is possible, but every trip then has to be duplicated onto each of them. Most networks prefer one service with exceptions.

## French school zones A, B and C

In mainland France the school calendar is set by the Ministry of Education and published as open data. The All Saints', Christmas and summer holidays have the same dates everywhere. The winter and spring holidays are staggered across three zones, A, B and C, assigned by education authority (académie). Corsica and the overseas académies have calendars of their own.

Take the dates of the network's own zone, not a neighbouring one. If the network serves schools in two different zones, each zone's school trips need a service of their own.

The official calendar gives the end of classes and the day classes resume. The holidays are the days in between: the day classes resume is a school day. The calendar also includes an Ascension bridge; check whether your network treats it as a school day or a holiday.

Other countries publish school calendars in their own ways, but the GTFS side is the same: dates, written into services.

## Public holidays

France has eleven public holidays: 1 January, Easter Monday, 1 May, 8 May, Ascension Day, Whit Monday, 14 July, 15 August, 1 November, 11 November and 25 December. Alsace and Moselle add Good Friday and 26 December. Easter, Ascension and Whitsun move every year.

Many networks run their Sunday service on public holidays. For each holiday falling on a weekday, remove the date from the service that would otherwise run and add it to the Sunday service. 11 November 2026 is a Wednesday in term time:

```
service_id,date,exception_type
SCH,20261111,2
SUN,20261111,1
```

Practices vary: some networks run a Saturday service on Whit Monday, others cut service further on 1 May or do not run at all that day. Read what the existing feed does before adding a date. A holiday on a Sunday needs nothing; a holiday on a Saturday is removed from the Saturday service.

## Common traps

- **A public holiday during school holidays.** The date comes out of the holiday service, not the school one. If the holiday service exists only through type 1 dates, delete the type 1 row instead of adding a type 2 row: `service_id` and `date` together are a key, and two rows raise [duplicate_key](/en/rules/duplicate_key).
- **The service's name.** A service called "HOL" proves nothing. Check the dates it actually runs.
- **Trips after midnight.** A trip at 00:30 in the night of 13 to 14 July is written `24:30:00` on the 13th's service: the evening before decides.
- **An emptied service.** A service whose weekday columns are all 0 and that has no type 1 date never runs: [service_without_service_days](/en/rules/service_without_service_days).
- **The end of validity.** A past `end_date` raises [expired_calendar](/en/rules/expired_calendar), and a feed close to its end raises [feed_expiration_date_30_days](/en/rules/feed_expiration_date_30_days). Extending a feed into the next year also means adding that year's holidays and public holidays.
- **"Weekdays".** In a brief, "Monday to Friday" includes school holidays unless it says "in term time".

To check the result, look at one line's timetable on specific dates: a school day, a holiday weekday, a public holiday on a weekday. The GTFS Express reader shows timetables day by day, free and without an account, which makes that check easy before and after a change.

## Further reading

- [How to modify a GTFS feed](/en/guides/modify-a-gtfs-feed)
- [From a brief to a GTFS feed](/en/guides/from-a-brief-to-a-gtfs-feed)
- [Validate a GTFS feed](/en/guides/validate-a-gtfs-feed)
