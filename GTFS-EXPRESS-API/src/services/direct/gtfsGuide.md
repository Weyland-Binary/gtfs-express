# GTFS guide

What a GTFS feed means and how a change is written in it, for the feed loaded here: one SQLite table per GTFS file, with that file's own columns. A name in backticks is a table of this database, or one of its columns written table.column. Each section says who reads it: the agent that changes the feed, the reviewer that measures the change, or both.

## Reading the feed
<!-- agent reviewer -->
- Ids are text and case-sensitive: compare them exactly, never by number. Every reference must resolve: `trips.route_id` → `routes`, `trips.service_id` → `calendar` or `calendar_dates`, `trips.shape_id` → `shapes`, `stop_times.trip_id` → `trips`, `stop_times.stop_id` → `stops`, `stops.parent_station` → `stops`, `routes.agency_id` → `agency`, `frequencies.trip_id` → `trips`, the stops, routes and trips of `transfers`, `pathways.from_stop_id` and `pathways.to_stop_id` → `stops`, the zones of `fare_rules` → `stops.zone_id`, `stop_areas` → `areas` and `stops`, `route_networks` → `networks` and `routes`.
- What a person calls « la ligne 5 » is `routes.route_short_name` (or `routes.route_long_name` when the network has no short names), not `routes.route_id`; one public line may be several `routes` rows (two agencies, a school variant): query by name and look at all of them. A published long name that lists termini (« Gare <> Hôpital ») is a name, not a statement about where the trips go: the trips' first and last calls say that.
- A stop name usually covers several `stops` rows: one platform per direction, a station with its platforms (`stops.location_type` 1 and its children by `stops.parent_station`). « L'arrêt Gare » on a line is the rows of that name the line's trips call at, in the direction concerned: find them through `stop_times`, never by the first row of that name.
- Read a value before you rely on it: the line's directions, its patterns, its services, its first and last departures, the dates its services run. The overview gives the lines; everything else is a query away.

## Service days and calendars
<!-- agent reviewer -->
- A trip runs on a date when its service is active that day. A service is active on date D when a `calendar` row has D between `calendar.start_date` and `calendar.end_date` (both included) with the weekday's column at 1, and no `calendar_dates` row (that service, D, `calendar_dates.exception_type` 2) removes it; or when a `calendar_dates` row (that service, D, type 1) adds it. A service with no `calendar` row runs only on its type 1 dates. Dates are YYYYMMDD text.
- The services active on a date, for D = 20270104 (its weekday read by SQLite, never computed in your head: `strftime('%w', '2027-01-04')` gives 0 for Sunday to 6 for Saturday):
  SELECT service_id FROM calendar WHERE start_date <= '20270104' AND end_date >= '20270104' AND monday = 1 AND service_id NOT IN (SELECT service_id FROM calendar_dates WHERE date = '20270104' AND exception_type = 2) UNION SELECT service_id FROM calendar_dates WHERE date = '20270104' AND exception_type = 1
- Never trust a service's name (« LMMJV-SCOL », « VAC ») over its dates: query the dates it runs.
- One service usually serves many trips, often of several lines. Before changing a service (its dates, its days), list who uses it: SELECT route_id, COUNT(*) FROM trips WHERE service_id = '…' GROUP BY route_id. Changing it changes every one of those trips.
- Day words: « en semaine », « du lundi au vendredi » = Monday to Friday, school holidays included unless the brief says « en période scolaire »; « jours ouvrables » = Monday to Saturday and « jours ouvrés » = Monday to Friday, public holidays excepted in both; « samedi », « dimanche », « dimanches et fêtes » (DF) = Sundays and public holidays; « LMMJV » / « LàV » = Monday to Friday, « LMJV » = Wednesday excepted; « petites vacances » = the school holidays but summer, « vacances d'été » / « grandes vacances » = summer; « jours fériés » = public holidays. A date range « du 4 au 8 » includes both ends.
- School holidays, school days and public holidays are not in GTFS: get their dates with period_dates (the school zone is the session's, or the one the brief names: zone A, B or C in France). A feed often runs its Sunday service on public holidays: a type 2 exception on the weekday service and a type 1 on the Sunday service, for each holiday — read how this feed does it before adding a date.
- A feed's validity is its services' dates, and `feed_info.feed_start_date` / `feed_info.feed_end_date` when given. Extending the validity is extending the services' end dates (and their exceptions over the new dates, holidays included) and `feed_info.feed_end_date`; nothing runs past the last service date.

## Times
<!-- agent reviewer -->
- `stop_times.arrival_time` and `stop_times.departure_time` are HH:MM:SS on the trip's service day: a trip after midnight keeps its day's service and goes past 24:00:00 (00:30 after Friday is 24:30:00 on the Friday service). « Le vendredi soir jusqu'à 1h » is the Friday service up to 25:00:00, not Saturday's.
- Some feeds write the hour on one digit (7:05:00): compare and sort times by their seconds, never as text. Seconds of a time t: (CAST(substr(t, 1, instr(t, ':') - 1) AS INTEGER) * 3600 + CAST(substr(t, instr(t, ':') + 1, 2) AS INTEGER) * 60 + CAST(substr(t, -2) AS INTEGER)); back to a time: printf('%02d:%02d:%02d', s / 3600, (s % 3600) / 60, s % 60).
- Along a trip, by `stop_times.stop_sequence`, times never go back, and at each call arrival ≤ departure. The first and the last calls carry both times; a call between may be left without times only when the feed does so (`stop_times.timepoint` 0, times interpolated by consumers).
- A trip's departure is its first call's departure; « le premier / dernier départ » of a line is at its departure terminus in the direction concerned, unless the brief names a stop.
- Keep the feed's precision: to the minute when every time ends in :00, else as it publishes.

## Trips, directions and patterns
<!-- agent reviewer -->
- `trips.direction_id` (0 or 1) splits a line into its two directions, with the same meaning across its trips; « direction X », « vers X » is the trips whose last call is X (or whose `trips.trip_headsign` says X): read it from the trips, not from the id.
- A pattern is the ordered list of stops a trip calls at. A line usually has several: variants, short workings, school extensions. A demand about « la ligne » concerns all its trips in the direction and on the days it names; when the variants make the demand read two ways, that is a question.
- `trips.trip_headsign` is the destination passengers read; `stop_times.stop_headsign` overrides it at a call. `trips.trip_short_name` is a public trip number (rail). `trips.block_id` chains the trips one vehicle runs: trips of a block must not overlap in time.
- `frequencies` turns a trip into a template: from `frequencies.start_time` to `frequencies.end_time`, a departure every `frequencies.headway_secs`, its calls timed like the template trip's own; `frequencies.exact_times` 1 means those exact departures, 0 an announced headway only. On a line run by frequencies, a change of headway or of span is a change of its `frequencies` rows, not of `stop_times`.

## Stops and stations
<!-- agent reviewer -->
- `stops.location_type`: 0 or empty a stop or platform (the only kind a trip calls at), 1 a station, 2 an entrance or exit, 3 a generic node, 4 a boarding area. A platform's `stops.parent_station` is its station; a station has none.
- `stops.stop_code` is the code shown to passengers; `stops.zone_id` the fare zone; `stops.platform_code` the platform's number; `stops.tts_stop_name` how it is spoken; `stops.wheelchair_boarding` 0 unknown (a platform then takes its station's), 1 accessible, 2 not.
- Inside stations: `levels` and `pathways` (`pathways.pathway_mode` 1 walkway, 2 stairs, 3 moving sidewalk, 4 escalator, 5 elevator, 6 fare gate, 7 exit gate; `pathways.is_bidirectional`).

## Routes and agencies
<!-- agent reviewer -->
- `routes.route_type`: 0 tram, 1 metro, 2 rail, 3 bus, 4 ferry, 5 cable tram, 6 aerial lift, 7 funicular, 11 trolleybus, 12 monorail; some feeds use the extended types (from 100: 100 rail, 200 coach, 700 bus, 900 tram…): keep the feed's style. `routes.route_color` and `routes.route_text_color` are six hexadecimal digits without « # », readable together.
- `routes.continuous_pickup` / `routes.continuous_drop_off` (and the same columns of `stop_times`): 0 anywhere along the route, 1 or empty not, 2 by phoning the agency, 3 by arrangement with the driver.
- Every agency of a feed shares one `agency.agency_timezone`. `agency.agency_email` and the contact fields are the organisation's, never a person's.

## Shapes
<!-- agent reviewer -->
- A shape is its points in `shapes.shape_pt_sequence` order; `shapes.shape_dist_traveled` and `stop_times.shape_dist_traveled`, when the feed gives them, grow along the trip in the same unit. Many trips share one shape: a change for some of them works on a copy.
- A trip's shape must pass by its stops: the validator flags a stop too far from its trip's shape.

## Accessibility and vehicles
<!-- agent reviewer -->
- `trips.wheelchair_accessible`, `trips.bikes_allowed` and `trips.cars_allowed`: 0 or empty unknown, 1 yes, 2 no. A stop's accessibility is `stops.wheelchair_boarding`.

## How calls are served, on-demand transport
<!-- agent reviewer -->
- `stop_times.pickup_type` and `stop_times.drop_off_type`: 0 regular, 1 none, 2 by phoning the agency, 3 by arrangement with the driver. On demand (TAD, « sur réservation », « à la demande ») is 2 on both; « descente seulement » is pickup 1; « montée seulement » is drop-off 1. Some feeds forbid the drop-off at a trip's first call and the pickup at its last: keep what the feed does there.
- Zonal on-demand service (GTFS-Flex): a call made in a zone instead of at a stop names `stop_times.location_group_id` (`location_groups` with their stops in `location_group_stops`) or `stop_times.location_id` (a feature of `locations_geojson`), with `stop_times.start_pickup_drop_off_window` and `stop_times.end_pickup_drop_off_window` instead of arrival and departure times. `booking_rules` say how to book: `booking_rules.booking_type` 0 in real time, 1 the same day with `booking_rules.prior_notice_duration_min` (minutes), 2 days before with `booking_rules.prior_notice_last_day` and `booking_rules.prior_notice_last_time`; `booking_rules.phone_number`, `booking_rules.info_url`, `booking_rules.booking_url`, `booking_rules.message`. This feed's calls hold no booking rule of their own: a rule cannot be attached to calls here.

## Transfers
<!-- agent reviewer -->
- `transfers.transfer_type`: 0 recommended point, 1 timed (the departing vehicle waits), 2 a minimum time (`transfers.min_transfer_time` in seconds), 3 not possible, 4 stay on board to the next trip, 5 get off and board again (the trips of 4 and 5 in `transfers.from_trip_id` / `transfers.to_trip_id`). A transfer names its stops, and may name routes or trips: what it names must exist.

## Fares
<!-- agent reviewer -->
- A feed prices in fares v1 or fares v2 (sometimes both): read which tables hold rows and change the system it uses.
- Fares v1: `fare_attributes` (`fare_attributes.price`, `fare_attributes.currency_type` ISO 4217 such as EUR, `fare_attributes.payment_method` 0 on board / 1 before boarding, `fare_attributes.transfers` 0, 1, 2 or empty for unlimited, `fare_attributes.transfer_duration` in seconds, `fare_attributes.agency_id`) and `fare_rules`, which say where a fare applies (`fare_rules.route_id`, `fare_rules.origin_id`, `fare_rules.destination_id` and `fare_rules.contains_id` are values of `stops.zone_id`). A fare with no rule applies to every journey. Free travel on some lines is a fare at price 0 whose rules name those lines; a fare other lines also use is never edited for one of them: add a fare.
- Fares v2: what is sold is `fare_products` (`fare_products.amount` in `fare_products.currency`, per `fare_products.rider_category_id` and `fare_products.fare_media_id`: one product may have several rows); `rider_categories` (`rider_categories.is_default_fare_category` on the category a product applies to by default: one per product); `fare_media` (`fare_media.fare_media_type` 0 none, 1 paper ticket, 2 transit card, 3 contactless bank card, 4 mobile app). Where a product applies: `fare_leg_rules` (by `fare_leg_rules.network_id` — the networks are `networks` with their routes in `route_networks`, or `routes.network_id`, never both —, by `fare_leg_rules.from_area_id` / `fare_leg_rules.to_area_id` — `areas` with their stops in `stop_areas` —, by time with `timeframes` (`timeframes.timeframe_group_id`, `timeframes.start_time`, `timeframes.end_time`, `timeframes.service_id`), `fare_leg_rules.rule_priority` choosing among matches, `fare_leg_rules.leg_group_id` naming the leg for transfers). `fare_leg_join_rules` joins legs into one. `fare_transfer_rules`: from one leg group to another, `fare_transfer_rules.transfer_count` (-1 unlimited; empty when both leg groups differ), `fare_transfer_rules.duration_limit` in seconds with `fare_transfer_rules.duration_limit_type` (0 departure of the first leg to arrival of the next, 1 departure to departure, 2 arrival to departure, 3 arrival to arrival), `fare_transfer_rules.fare_transfer_type` (0 first leg + transfer, 1 first leg + transfer + next leg, 2 transfer only), `fare_transfer_rules.fare_product_id` the transfer's own price.
- A rider category the brief names (« jeunes », « seniors », « solidaire ») is a `rider_categories` row and the products' rows for it.

## Feed information, translations, attributions
<!-- agent reviewer -->
- `feed_info` holds one row: publisher, `feed_info.feed_lang`, `feed_info.feed_version`, `feed_info.feed_start_date`, `feed_info.feed_end_date`, the contact. `translations` give a field's value in another language, by `translations.table_name`, `translations.field_name`, `translations.language` and either `translations.record_id` (with `translations.record_sub_id`) or `translations.field_value`: renaming a stop or a line whose name is translated leaves the translations on the old name. `attributions` name who produces, operates or commissions a feed, a line or a trip.

## What the canonical validator refuses
<!-- agent reviewer -->
- A delivery is refused on a NEW error of the MobilityData validator. The ones a change most often creates: foreign_key_violation (a reference to a row that does not exist), duplicate_key, missing_required_field, stop_time_with_arrival_before_previous_departure_time and decreasing_stop_time (times going back), stop_time_with_departure_before_arrival_time, stop_time_with_only_arrival_or_departure_time, missing_trip_edge (a first or last call without times), decreasing_or_equal_stop_sequence, start_and_end_range_out_of_order (a calendar ending before it starts), block_trips_with_overlapping_stop_times, invalid_color, invalid_time, invalid_date, route_both_short_and_long_name_missing, decreasing_shape_distance, overlapping_frequency, forbidden_pickup_type, missing_pickup_or_drop_off_window, invalid_currency, fare_transfer_rule_invalid_transfer_count, service_without_service_days (a service that never runs: delete a service whose dates you all removed, when no trip uses it any more).
- Warnings never refuse it, but a change should not create them without a reason: unusable_trip (fewer than two calls), unused_shape, stop_without_stop_time, route_without_trips, unused_trip, fast_travel_between_consecutive_stops and stop_time_travel_speed_too_fast (running times too short for the distance), stop_too_far_from_shape, expired_calendar, feed_expiration_date_30_days, duplicate_route_name, route_color_contrast.

## The words of a brief
<!-- agent reviewer -->
- ligne = a line (`routes`); course, départ, service (a trip) = `trips`; sens = a direction; desserte = the stops a line serves; terminus; amplitude = the span from the first to the last departure; cadence, fréquence, intervalle, « toutes les N minutes » = the headway; renfort = extra trips, usually at the peak; prolongement = the line extended beyond its terminus; limitation, terminus partiel = trips cut short; déviation = a detour (other stops or another path); arrêt provisoire = a temporary stop during works; arrêt supprimé, non desservi = no longer served by the line; fusion = two lines made one; « à partir du », « dès le » = from that date onwards, until the end of the validity unless the brief bounds it; « jusqu'à nouvel ordre » = no end date; « heure de pointe » = the peak, whose times the brief or the person gives (never assume them).
- A brief may state today's network (« actuellement la ligne part à 6h10 »): check it on the feed; when it is false, that is a question, not a change.

## Writing a change
<!-- agent -->
- Work on the trips, services and rows the demand names, and on them only. Count what a statement will touch with a query first, then give that count as the write's expect.
- A change on some dates only (from a date, during works, in the school holidays, on some weekdays) leaves every other date as it runs today. A trip whose service also runs on other dates is never changed in place: (1) create a service that runs exactly the changed dates (a `calendar` row, or `calendar_dates` rows of type 1), (2) copy the trips concerned onto it (new `trips.trip_id`, their `stop_times` and `frequencies` with them), (3) take the changed dates out of the old service — type 2 exceptions on those dates, or its `calendar.end_date` set to the day before when the change runs to the end — and if other lines share the old service, give the trips concerned their own copy of it for the dates that do not change, (4) change the copies. A change « à partir du D » to the end of the validity: the old trips' service ends on D − 1 (keep its exceptions before D), the copies' service starts on D with the old service's weekdays and its exceptions from D on.
- Removing a date from a service: one `calendar_dates` row (that service, that date, type 2); when a type 1 row already adds that date, delete it instead. The pair (service, date) is a key: never two rows.
- New ids are unique and in the feed's own style (look at existing ids: prefix, separator, numbering); never reuse the id of a row you delete for another row; never rename an existing id when a name, a time or a reference can change instead.
- Shifting a trip: shift every arrival and departure of its calls by the same number of seconds (and its `frequencies` rows), keeping its dwell times.
- New trips (a renfort, a later last departure, a new headway): copy a trip of the same line, direction and pattern, the nearest in time of day (running times differ between the peak and the evening), shifted to the new departure; give the copy the service of the days asked. A headway « toutes les 15 minutes de 7h à 9h » is departures at 07:00, 07:15 … at the terminus (or the stop the brief names) — whether 09:00 itself departs is a question only when it matters and the brief does not say.
- Removing trips: delete their `stop_times`, `frequencies`, the `transfers` and `attributions` naming them, then the trips. A trip removed from a `trips.block_id` chain leaves the chain as it is otherwise.
- Adding a stop to a pattern: insert the calls with a `stop_times.stop_sequence` between the neighbours' (sequences need only grow: renumber the trip's later calls when there is no room) and times between the neighbours', in proportion to the distance; fill `stop_times.shape_dist_traveled` when the feed does. A new stop needs `stops.stop_name`, `stops.stop_lat` and `stops.stop_lon` (never invented: from the brief, a document, or the person), and the attributes its neighbours carry (`stops.zone_id`, `stops.wheelchair_boarding`, `stops.parent_station` when the network uses stations).
- Removing a stop from a line: delete that line's calls there; a terminus removed makes the neighbour the terminus, timed, and the headsign follows (`trips.trip_headsign`). The stop row stays unless the brief withdraws it and no other line serves it.
- Extending a line (prolongement): its trips' new calls after the old terminus, timed from a line that already runs there or from the distance, the headsign updated, the shape extended — reuse the points of a shape that already runs between those stops; never draw a path you do not have: say it in finish.
- A detour (déviation): the calls change (stops skipped, temporary stops added) and the shape should follow; on some dates only, it is a change on some dates (above).
- Merging two lines: the trips of one move to the other (`trips.route_id`), the headsigns and directions made consistent, then the emptied route and what names it (`route_networks`, `fare_rules`, `transfers`, `attributions`, `translations`) follow the brief: kept, moved or removed.
- A shape shared by trips you do not change is copied (new `shapes.shape_id`) before you change its points.
- A line created: its `routes` row (agency, names, type, colours in the network's style), its services, its trips with their calls, its shape when you have one.
- Renaming: a stop is `stops.stop_name`, a line `routes.route_short_name` or `routes.route_long_name`; translated names follow in `translations`.

## SQL in this engine
<!-- agent -->
- query runs ONE read-only statement on the copy as it now stands; write runs UPDATE / INSERT / DELETE statements, checked by the engine, and answers with the facts. A write may not contain WITH RECURSIVE, a statement that only reads, a schema statement or a correlated sub-query that scans a table once per row of another (refused as unbounded): read the ids you need with query first (WITH RECURSIVE is allowed there, for instance to list the dates of a range), then write with explicit lists (IN ('…', '…'), INSERT … VALUES …) or with joins on keys.
- INSERT … SELECT copies rows: INSERT INTO trips (trip_id, route_id, service_id, trip_headsign, direction_id, block_id, shape_id, wheelchair_accessible, bikes_allowed) SELECT trip_id || '_X', route_id, 'NEW_SERVICE', trip_headsign, direction_id, block_id, shape_id, wheelchair_accessible, bikes_allowed FROM trips WHERE trip_id IN ('…'); then the same for `stop_times` with the shifted times. Name the columns you copy, every one the feed fills: a column left out of the list is left empty.
- Dates: date('2027-01-04', '+1 day') and strftime('%Y%m%d', …) move between YYYY-MM-DD and YYYYMMDD; strftime('%w', …) gives the weekday.
- A write that takes more than three seconds is refused: split a large change into several writes, line by line.
- Every write is re-simulated over the earlier ones: when a write is refused, nothing of it is kept, and the copy is as before it.

## Measuring a demand
<!-- agent reviewer -->
- A demand is proven by a measure on the feed after the change (measure, with the judge's kind that says it, or a query) compared with the feed before (measure compares the two feeds itself; the reviewer reads the feed before with query_before, the agent through the facts each write returns): « the last departure is 23:00 on weekdays from 4 January » is the departures of that line and direction on a weekday after that date, and the same weekday before it unchanged. Measure on dates the demand concerns and on a date it does not.
- What is not asked is measured too: the other lines, the other dates, the other directions and the other tables stay as they were.
