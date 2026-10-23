---
title: Making stop timetable sheets from a GTFS feed
description: What a timetable posted at a stop must show, how GTFS gives it (day types, notes, periods, no boarding) and the pitfalls that make a sheet wrong.
updated: 2026-10-22
slug: stop-timetable-sheets-from-a-gtfs-feed
---

A timetable posted at a stop shows, for one line and one direction, the departures from that stop over a period. Everything it says is in the GTFS feed: the times in `stop_times.txt`, the days in `calendar.txt` and `calendar_dates.txt`, the direction in `trips.txt`. The work is to group that data the way a rider reads it, without losing any of it.

## What a sheet must show

- The line and its direction, named by its usual terminus.
- The stop's name, and its code if the pole shows one.
- One column or band per day type: Monday to Friday in school term, Monday to Friday in school holidays, Saturday, Sunday and public holidays.
- The departures by hour, with a note on each departure that does not run every day of its column.
- The period the sheet is valid for.
- The line's path, with the stop marked and the time to reach the stops after it.

## From dates to day types

GTFS has no day types: it has services, each running on some dates. To fill a column, take every date of the period that belongs to that day type, then the departures whose service runs on at least one of those dates.

School and public holidays are not in the GTFS feed. You need them to tell a school week from a holiday week; the guide [School holidays and public holidays in a GTFS feed](/en/guides/school-holidays-and-public-holidays-in-gtfs) explains how a network writes them.

Two columns with exactly the same departures make one: « Monday to Saturday » reads better than two identical columns.

## Notes

A departure that does not run every day of its column carries a letter, and the letter points to a sentence at the foot of the sheet. The sentence must be exact and short:

- « Wednesdays only » when the departure runs on some weekdays only.
- « Except 11 November » when a few dates are missing.
- « Only from 2 to 6 November » when it runs on a few dates only.
- « Terminates at Station » when it ends before the usual terminus.
- « On booking only » when `pickup_type` is 2.

Two pitfalls come back often. A network sometimes publishes a Monday-to-Thursday service and a Friday one with the same times: they are the same departures and deserve no note. And when nearly every departure of a column shares the same exception, it is better written once beside the column's title than as a letter on every minute.

## What is not a departure

- A trip's last stop: riders get off there, they do not board.
- A stop where `pickup_type` is 1: boarding is not allowed there.
- An empty time between two timepoints: estimate it or flag it, never make it up.

## Validity periods

A sheet valid « until the end of the season » often covers several regimes: a period of roadworks, a Christmas market, a summer service. There are two ways to handle them: one sheet per period, without notes, or one sheet for the season with the exceptions as notes. To choose, you need to know where the network's timetable changes for good, which you read by comparing, for each weekday and each day type, the services that run from one week to the next.

## Headways

When departures follow each other at a steady interval for several hours, « every 8 min » usefully replaces a column of minutes. Departures carrying a note must stay visible: only fold the whole hours where every departure keeps the same rhythm.

## Before printing

Read each sheet as a rider would: a stop with no departure over the period, the same departure twice (two identical trips in the feed), calls without a time. Each of these points to data to fix before posting, and [validating the GTFS feed](/en/guides/validate-a-gtfs-feed) finds most of them.

## With GTFS Express

In the reader, the « Stop sheets » tab prepares a line's sheets, one per stop and direction: a column per day type, notes worked out from the calendars, detected periods, the line's path, school holidays, a QR code per stop. Anyone can look at them for free; printing them, one sheet a page, is part of the licence. On a draft, the stops whose sheet changes are known before the change is applied.
