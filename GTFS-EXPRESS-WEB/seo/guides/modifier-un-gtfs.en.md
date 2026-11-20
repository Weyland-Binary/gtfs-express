---
title: How to modify a GTFS feed without breaking it, step by step
description: Which files a change touches, keeping ids stable, consistent calendars and stop_times, shapes, and validating the feed before you deliver a new version.
updated: 2026-10-21
slug: modify-a-gtfs-feed
---

To modify a GTFS feed, work on a copy, change the rows of the files involved while keeping the existing ids, then run the validator before you deliver a new version. Most problems come from three places: references broken between files, inconsistent times in `stop_times.txt`, and calendars changed beyond the dates you meant to change.

## The files a change touches

A GTFS feed is a ZIP archive of CSV files linked by ids. A service change nearly always touches several of them:

- `routes.txt`: the routes, with `route_short_name`, `route_long_name`, `route_type` and colours.
- `trips.txt`: the trips, each tied to a route (`route_id`), a service (`service_id`), usually a shape (`shape_id`), and a direction (`direction_id`).
- `stop_times.txt`: each trip's calls, ordered by `stop_sequence`, with `arrival_time` and `departure_time`.
- `stops.txt`: stops, platforms and stations.
- `calendar.txt` and `calendar_dates.txt`: the days each service runs.
- `shapes.txt`: the path the trips follow.
- `frequencies.txt`, when some lines are described by a headway rather than by timetables.
- `feed_info.txt`: the publisher, the version and the period the feed covers.

Before writing anything, list the rows the change will touch. Shifting the times of one line means hundreds of `stop_times.txt` rows; changing a service in `calendar.txt` changes every trip that uses it, often on several lines.

## Work on a copy

Keep the original archive untouched and edit a copy. You can then compare before and after, and go back.

Be careful with spreadsheets. A CSV opened and saved again in a spreadsheet often loses the leading zeros of ids (`0042` becomes `42`), turns `25:10:00` into a date or a duration, rewrites `20261102` in a local date format and changes the encoding. GTFS expects UTF-8 and values left as they are: edit with a tool that treats every column as text.

## Keep ids stable

Ids (`stop_id`, `route_id`, `trip_id`, `service_id`, `shape_id`) are case-sensitive text. Journey planners and realtime feeds rely on them from one version to the next.

- To rename a stop, change `stop_name`, not `stop_id`.
- A new row gets a new id in the network's own style (same prefix, same separator).
- Never reuse the id of a deleted row for another object.
- When you delete a trip, also delete its `stop_times`, its `frequencies` and the `transfers` that name it. Otherwise the validator reports a [broken reference](/en/rules/foreign_key_violation).

## Calendars: change only the dates you mean

One service usually carries many trips. Before you touch a row of `calendar.txt`, count the trips that use it, route by route. If the change concerns only some trips or some dates, do not edit the service in place:

1. Create a service that runs exactly on the changed dates.
2. Copy the trips concerned onto it, with new `trip_id` values and their `stop_times`.
3. Take those dates out of the old service (an `exception_type` 2 row in `calendar_dates.txt`, or an earlier `end_date` when the change runs to the end).
4. Edit the copies.

For a change "from 4 January", the old service stops on the 3rd:

```
service_id,monday,tuesday,wednesday,thursday,friday,saturday,sunday,start_date,end_date
WKDAY,1,1,1,1,1,0,0,20260901,20270103
WKDAY_JAN,1,1,1,1,1,0,0,20270104,20270703
```

Carry over to the new service the old one's exceptions that fall after the switch date (public holidays, school holidays).

## Keep stop_times consistent

- Times are written `HH:MM:SS`. A trip after midnight keeps its day's service and goes past `24:00:00`: 00:30 after a Friday is `24:30:00` on the Friday service.
- Along a trip, in `stop_sequence` order, times never go back, and at each call `arrival_time` is less than or equal to `departure_time`.
- The first and last calls always carry their times.
- `stop_sequence` must increase along the trip; it does not have to be consecutive.
- To shift a trip, shift all its times by the same number of seconds, dwell times included.
- If the feed fills `block_id`, two trips of the same vehicle must not overlap in time.

Some feeds write the hour with one digit (`7:05:00`): sort and compare times in seconds, never as text.

## Shapes

A shape in `shapes.txt` is often shared by several trips. If you change the path of only some of them, copy the shape under a new `shape_id` before moving its points. When the feed fills `shape_dist_traveled`, values grow along the trip, in the same unit in `shapes.txt` and in `stop_times.txt`. A stop far from its shape raises the [stop_too_far_from_shape](/en/rules/stop_too_far_from_shape) warning.

## Validate before you deliver

Run the MobilityData validator on the modified feed and compare its report with the original feed's. For a change, what matters are the new errors: a broken reference, a [duplicate key](/en/rules/duplicate_key), times going backwards, a service that no longer runs on any day. Look at new warnings too, such as a shape left unused after a variant was removed.

Then check the result as a rider would: one line's timetable on a weekday, a Saturday and a public holiday, before and after.

## Deliver a version

Every delivered feed is a version: update `feed_info.feed_version` and, if they change, `feed_start_date` and `feed_end_date`. Keep the previous version so you can return to it, and record what changed and who decided it.

In GTFS Express, every change happens in a draft kept apart from the working network: "Before" shows the network as it is, "After" shows the draft. Applying the draft creates a new version (v1, v2...) that can be undone, and a new validator error blocks the delivery.

## Further reading

- [Add a stop to a GTFS feed](/en/guides/add-a-stop-to-a-gtfs-feed)
- [School holidays and public holidays in GTFS](/en/guides/school-holidays-and-public-holidays-in-gtfs)
- [Validate a GTFS feed](/en/guides/validate-a-gtfs-feed)
