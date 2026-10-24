---
title: "mixed_case_recommended_field: name written in all caps"
description: A name shown to riders (stop_name, route_long_name, trip_headsign) is written all upper case or all lower case. Why it matters and how to correct it.
updated: 2026-10-21
---

## What this rule means

Some GTFS fields are read as they are by riders: a stop's name (`stop_name`), a route's long name (`route_long_name`), a trip's displayed destination (`trip_headsign`). Best practice asks for mixed case in these fields, upper and lower case letters as in ordinary text. When one of them is entirely upper case or entirely lower case, the validator raises this notice. Severity: **warning**.

## Why it matters

A warning does not block a delivery in GTFS Express. The cost falls on riders: capitals read more slowly on an app screen or a passenger information display, and some text-to-speech engines spell out an upper-case word instead of saying it, which gets in the way of people using a screen reader. Reusers cannot restore the right case automatically without damaging acronyms.

## Common causes

- Names come from an older scheduling system that only accepted capitals.
- Stops were entered for an on-board display with a limited character set.
- A file conversion turned all the text into capitals.

## How to fix it

Rewrite each value in mixed case in the file concerned, keeping acronyms in capitals (`NHS`, `UK`, `A38`) and the language's own conventions. An automatic conversion to Title Case is a fair start, but review the result: it turns `NHS` into `Nhs`.

In GTFS Express, the validation report lists each value with its file and row. "Fix one by one" opens each row in the editor with the field flagged, and each rewritten name becomes a retouch in the draft. "Re-validate" then checks that nothing is left.

## Example

```
stop_id,stop_name,stop_lat,stop_lon
STN,RAILWAY STATION,51.4520,-2.5810
HOSP,NHS GENERAL HOSPITAL,51.4580,-2.5960
```

Corrected:

```
stop_id,stop_name,stop_lat,stop_lon
STN,Railway Station,51.4520,-2.5810
HOSP,NHS General Hospital,51.4580,-2.5960
```

See also the guide [Validate a GTFS feed](/en/guides/validate-a-gtfs-feed) and the [list of rules](/en/rules/).
