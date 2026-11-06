---
title: "route_color_contrast: route text hard to read on its colour"
description: The contrast between route_color and route_text_color in routes.txt is below 4.5:1. A line badge some riders cannot read, and how to correct it in the feed.
updated: 2026-10-21
---

## What this rule means

In `routes.txt`, `route_color` gives a route's background colour and `route_text_color` the colour of the text drawn on it, both as six-character hexadecimal values. The validator computes the contrast ratio between them with the WCAG formula (relative luminance of sRGB colours). When the ratio is below 4.5:1, the WCAG threshold for normal-size text, it raises this notice. Severity: **warning**.

Only routes where both colours are filled in are checked.

## Why it matters

A warning does not block a delivery in GTFS Express. But apps show the line's number (`route_short_name`) in a badge of the route's colour, with the text colour the feed provides. With poor contrast the number is hard to read in sunlight, on a dim screen, and for people with low vision or colour vision deficiency.

## Common causes

- White text on a light colour (yellow, light green, pale orange) taken from the brand guidelines.
- `route_text_color` left at an old value after `route_color` changed.
- A route colour copied from a printed map designed for black text.

## How to fix it

Change `route_text_color` to whichever colour contrasts best, usually `000000` on a light colour and `FFFFFF` on a dark one. If the brand fixes the text colour, darken or lighten `route_color` until the ratio exceeds 4.5:1.

In GTFS Express, the validation report lists the routes involved. "Fix one by one" opens each `routes.txt` row in the editor with the field flagged; the change is a retouch in the draft, and "Re-validate" confirms the new contrast.

## Example

```
route_id,route_short_name,route_color,route_text_color
L12,12,FFD700,FFFFFF
L5,5,0055A4,000000
```

White on yellow gives about 1.4:1, black on blue about 2.8:1. Corrected:

```
route_id,route_short_name,route_color,route_text_color
L12,12,FFD700,000000
L5,5,0055A4,FFFFFF
```

See also the guide [Validate a GTFS feed](/en/guides/validate-a-gtfs-feed) and the [list of rules](/en/rules/).
