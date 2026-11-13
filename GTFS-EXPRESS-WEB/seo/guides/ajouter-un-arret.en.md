---
title: How to add a stop to a line in a GTFS feed
description: Create the stop in stops.txt, insert its call in stop_times with the right sequence and consistent times in both directions, then check shape and validation.
updated: 2026-10-21
slug: add-a-stop-to-a-gtfs-feed
---

Adding a stop to a line means creating the stop in `stops.txt` if it does not exist, then inserting a call in `stop_times.txt` for every trip concerned, with a `stop_sequence` between the neighbouring calls' and times between theirs. Each direction is handled on its own, and the shape must pass close to the new stop.

## Create the stop in stops.txt

A new stop needs at least:

- `stop_id`: a new id in the style of the network's existing ones.
- `stop_name`: the name riders see, written like the others (case, abbreviations).
- `stop_lat` and `stop_lon`: the position in WGS84 decimal degrees.
- `location_type`: 0 or empty for a stop or platform, the only kind a trip can call at.

Copy the attributes the neighbouring stops carry as well: `zone_id` if the network has fare zones, `wheelchair_boarding`, `stop_code` if riders see a code.

Most urban networks have one platform per direction, on each side of the road, grouped under a station (`location_type` 1) through `parent_station`. If the network works that way, do the same:

```
stop_id,stop_name,stop_lat,stop_lon,location_type,parent_station,wheelchair_boarding
TOWNHALL,Town Hall,49.89412,2.29573,1,,
TOWNHALL_O,Town Hall,49.89418,2.29561,0,TOWNHALL,1
TOWNHALL_I,Town Hall,49.89405,2.29586,0,TOWNHALL,1
```

The station has no `parent_station` and no trip calls at it: calls go to the platforms.

## Put the stop in the right place

Coordinates are never made up. They come from a survey, the brief, the works file or the person who knows the street. Place each platform on the side of the road where the vehicle stops in that direction.

A stop too far from its trips' shape raises the [stop_too_far_from_shape](/en/rules/stop_too_far_from_shape) warning, beyond a threshold that depends on the validator's configuration (100 m by default). If the stop is on the current route, the shape does not change. If it means a new path, the shape has to follow (see below).

## Insert the call in stop_times

For each trip of the line that will serve the new stop, find the two neighbouring calls, the one before and the one after, then:

1. Give the new call a `stop_sequence` between theirs. If there is no room (5 and 6), renumber the trip's later calls: the sequence must increase but need not be consecutive.
2. Set its times between the neighbours', in proportion to the distance. If the call before departs at 07:12:00, the call after arrives at 07:16:00 and the new stop sits at 40% of the distance, the call falls at 07:13:36, so 07:14:00 if the network publishes to the minute.
3. Keep `arrival_time` equal to `departure_time` unless the network schedules a dwell time there.

Before:

```
trip_id,arrival_time,departure_time,stop_id,stop_sequence
T101,07:12:00,07:12:00,STATION_O,5
T101,07:16:00,07:16:00,HOSPITAL_O,6
```

After:

```
trip_id,arrival_time,departure_time,stop_id,stop_sequence
T101,07:12:00,07:12:00,STATION_O,5
T101,07:14:00,07:14:00,TOWNHALL_O,6
T101,07:16:00,07:16:00,HOSPITAL_O,7
```

If the network leaves intermediate stops untimed (`timepoint` 0, empty times), you may do the same for the new call. A trip's first and last calls always carry times.

Renumbering has a cost: a realtime feed that refers to `stop_sequence` must follow the same numbering. Tell whoever produces it.

## Both directions and every trip concerned

The return direction is another set of trips (`direction_id`), with another platform, neighbours in reverse order and other times. Treat it as a second change.

A line often has several patterns: short workings, school variants, express trips. List the patterns that run between the two neighbours and decide for each one. A trip that skips one of the neighbours does not have the same insertion point.

Decide the days too. If the stop opens on a given date, or only during works, the trips are not edited in place: create a service for those dates and copy the trips onto it, as described in [How to modify a GTFS feed](/en/guides/modify-a-gtfs-feed).

## shape_dist_traveled and the shape

If the feed fills `stop_times.shape_dist_traveled`, fill it for the new call: the distance along the shape from its start to the stop's projection, in the same unit as `shapes.shape_dist_traveled`. The value must lie strictly between the neighbours' values, or the validator reports [decreasing_or_equal_stop_time_distance](/en/rules/decreasing_or_equal_stop_time_distance).

If the stop requires a detour, the shape changes. If it is shared with trips that do not change, copy it under a new `shape_id`, edit the copy and point the trips concerned at it.

## Check

- Every trip concerned serves the new stop, in both directions and on the right dates. Other trips are unchanged.
- Times never go back: no [stop_time_with_arrival_before_previous_departure_time](/en/rules/stop_time_with_arrival_before_previous_departure_time).
- Running times squeezed around the new stop raise [fast_travel_between_consecutive_stops](/en/rules/fast_travel_between_consecutive_stops).
- A platform created but never served raises [stop_without_stop_time](/en/rules/stop_without_stop_time).
- The validator's report has no new error compared with the original feed.
- On a map the stop sits on the shape; in a weekday timetable its time falls between its neighbours'.

In GTFS Express, the stop is added in a draft, either by hand in the reader or from a brief. In the second case, if the brief does not give the new stop's position, the agent asks rather than guessing it.

## Further reading

- [How to modify a GTFS feed](/en/guides/modify-a-gtfs-feed)
- [Validate a GTFS feed](/en/guides/validate-a-gtfs-feed)
- [From a brief to a GTFS feed](/en/guides/from-a-brief-to-a-gtfs-feed)
