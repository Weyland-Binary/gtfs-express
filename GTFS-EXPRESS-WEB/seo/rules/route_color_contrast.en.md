---
title: "route_color_contrast: route text hard to read on its colour"
description: The route_color and route_text_color of a route in routes.txt are too close in brightness. A line badge some riders cannot read, and how to correct it in the feed.
updated: 2026-11-13
---

## What this rule means

In `routes.txt`, `route_color` gives a route's background colour and `route_text_color` the colour of the text drawn on it, both as six-character hexadecimal values. The validator computes the brightness of each colour, its luma by the Rec. 601 recommendation (0.30 × red + 0.59 × green + 0.11 × blue, from 0 to 255), and compares the two. When they differ by less than 72, it raises this notice. Severity: **warning**.

Only routes where both colours are filled in are checked.

## Why it matters

A warning does not block a delivery in GTFS Express. But apps show the line's number (`route_short_name`) in a badge of the route's colour, with the text colour the feed provides. With poor contrast the number is hard to read in sunlight, on a dim screen, and for people with low vision or colour vision deficiency.

## Common causes

- White text on a light colour (yellow, light green, pale orange) taken from the brand guidelines.
- `route_text_color` left at an old value after `route_color` changed.
- A route colour copied from a printed map designed for black text.

## How to fix it

Change `route_text_color` to whichever colour contrasts best, usually `000000` on a light colour and `FFFFFF` on a dark one. If the brand fixes the text colour, darken or lighten `route_color` until the two brightness values differ by 72 or more.

In GTFS Express, the validation report lists the routes involved. "Fix one by one" opens each `routes.txt` row in the editor with the field flagged; the change is a retouch in the draft, and "Re-validate" confirms the new contrast.

## Example

```
route_id,route_short_name,route_color,route_text_color
L12,12,FFD700,FFFFFF
L5,5,0055A4,000000
```

The yellow has a brightness of 203 and white 255: 52 apart. The blue has 68 and black 0: 68 apart. Both are under 72. Corrected:

```
route_id,route_short_name,route_color,route_text_color
L12,12,FFD700,000000
L5,5,0055A4,FFFFFF
```

See also the guide [Validate a GTFS feed](/en/guides/validate-a-gtfs-feed) and the [list of rules](/en/rules/).
