---
title: "invalid_color: malformed route colour in routes.txt"
description: route_color or route_text_color is not a six-character hexadecimal code. The formats invalid_color rejects and how to correct them in routes.txt.
updated: 2026-10-21
---

## What this rule means

The GTFS colour fields, `route_color` and `route_text_color` in `routes.txt`, take exactly six hexadecimal characters (`0` to `9`, `A` to `F`, upper or lower case) with no hash sign. `E2001A` and `e2001a` are valid; `#E2001A`, `F00`, `red` and `E2001` are not.

Severity: **error**.

## Why it matters

Rider apps and maps use these colours so that people recognise a line. A malformed value is usually ignored and the line is drawn in a default colour that matches neither the network map nor the vehicles. For `route_text_color`, the text can end up unreadable on the line's background.

## Common causes

- The hash sign copied from a brand guide or a stylesheet (`#00A0E2`).
- The three-character short form (`F60`) or a colour name.
- A spreadsheet reading the value as a number: `000000` becomes `0`, `009900` becomes `9900`.
- A trailing space or an invisible character.

## How to fix it

In `routes.txt`, replace each reported value with the six-character code of the intended colour: drop the hash, expand a short form (`F60` gives `FF6600`), convert a name into a code. If the colour is not known, leave the field empty: it is optional, and empty means white for `route_color` and black for `route_text_color`. Then check the contrast between the two colours, which the warning [route_color_contrast](/en/rules/route_color_contrast) covers.

In GTFS Express, the validation report lists each offending row with its value. "Fix one by one" opens the row in the editor with the field flagged; the correction becomes a retouche in the draft, and "Re-validate" runs the check again.

## Example

```
route_id,route_short_name,route_type,route_color,route_text_color
L1,1,3,#E2001A,FFFFFF
L2,2,3,F60,000000
L3,3,3,0,FFFFFF
```

Fixed:

```
route_id,route_short_name,route_type,route_color,route_text_color
L1,1,3,E2001A,FFFFFF
L2,2,3,FF6600,000000
L3,3,3,000000,FFFFFF
```

See also the [list of validation rules](/en/rules/).
