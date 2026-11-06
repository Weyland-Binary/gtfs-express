---
title: From a brief to a delivered GTFS feed
description: What a good brief must say so a GTFS feed can be changed without guessing, how GTFS Express turns it into a change, and what to check before you deliver.
updated: 2026-10-21
slug: from-a-brief-to-a-gtfs-feed
---

A brief becomes a delivered GTFS feed when every demand translates, without guessing, into rows of files: which lines, which directions, which days, from which date, at what times, at which stops. Each demand is then checked on the modified network, along with everything that was not meant to move, before a new version is delivered.

## What a good brief says

- **The lines**, by their public name (the one in `route_short_name`), and the variants concerned: short workings, school trips, extra peak trips. "Line 5" covers all its trips; if only some are meant, the brief has to say so.
- **The direction**, by its destination: "towards Station" is clear, "outbound" is not always.
- **The days.** "Monday to Friday" includes school holidays unless the brief says "in term time". In French briefs, « jours ouvrables » means Monday to Saturday and « jours ouvrés » Monday to Friday, public holidays excluded in both. "Sundays and public holidays" covers the holidays.
- **The period.** A start date ("from 4 January 2027") and an end date, or "until further notice". If holidays matter, the school zone.
- **The times.** Exact times, or a headway with its span and its starting point: "every 15 minutes from 07:00 to 09:00 departing Station". "At peak times" is not enough without the hours.
- **The stops.** Existing stops by name and the direction concerned; for a new stop, its position (coordinates, or a location that cannot be mistaken) and its neighbours on the line.
- **The current state, if quoted.** "The first departure is currently at 06:10" will be compared with the existing feed: if it is wrong, that is a question to settle, not a detail.

Attached timetables help, provided the brief says which line, direction and days they apply to.

## Sentences that read two ways

- "Extra trips on Saturdays and in the evening": Saturday evenings, or Saturdays plus every evening. The two readings change different trips.
- "Extend line 3 to the Park": every trip, or only some (every other one, the peak trips).
- "Remove the Town Hall stop": for this line only, or from the whole network.
- "Last departure at 23:00": at the departure terminus, or at the central stop named earlier.

One precise sentence saves a round trip.

## How GTFS Express turns a brief into a change

The brief is given as text or as documents (PDF, Word, Excel). The change happens in a draft kept apart from the working network:

1. An AI agent changes a copy of the network.
2. The engine states the facts of the change: what changed, table by table, and the validator's new errors.
3. An independent review, run by another model, checks each demand of the brief on that copy and reports it done, not done or unproven, with its evidence, along with the changes nobody asked for.
4. When a demand can be read two ways or data is missing (the position of a new stop, for example), the agent asks a question instead of guessing.
5. The person decides, under their own name.

"Before" shows the network as it is, "After" shows the draft. Applying the draft creates a new version (v1, v2...), which can be undone. A new validator error blocks the delivery. Names and e-mail addresses are masked before anything is sent to the AI model.

## Check before you deliver

Whether a tool made the change or someone typed it by hand, the checks are the same.

- **Each demand, measured.** For "last departure at 23:00 on weekdays from 4 January", look at the departures of the line and direction concerned on a weekday after 4 January, and on the same weekday before that date, which must be unchanged.
- **A day concerned and a day that is not.** A Saturday, a school holiday, a public holiday.
- **What was not asked.** The other lines, the other direction, the other dates, the other files. A service shared by several lines is the most frequent cause of unintended changes.
- **The validator.** No new error compared with the original feed, and every new warning explained.
- **Validity.** `feed_info.feed_version`, plus `feed_start_date` and `feed_end_date` if the period changes.
- **The timetable.** The timetable of a changed line, read as a rider will read it.

## Deliver

The package GTFS Express delivers holds the GTFS feed and its validation report, and records the person's decision. The previous version stays available: if a problem shows up after delivery, you can go back.

## Further reading

- [How to modify a GTFS feed](/en/guides/modify-a-gtfs-feed)
- [School holidays and public holidays in GTFS](/en/guides/school-holidays-and-public-holidays-in-gtfs)
- [Choosing a tool to modify a GTFS feed](/en/guides/choosing-a-tool-to-modify-a-gtfs-feed)
