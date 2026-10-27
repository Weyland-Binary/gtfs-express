---
title: "missing_recommended_file: recommended file missing"
description: The GTFS feed has no feed_info.txt, a file that is optional but recommended. What it gives reusers and how to write one in a few lines of CSV.
updated: 2026-10-21
---

## What this rule means

The GTFS reference sorts files into required, conditionally required and optional. Some optional files are strongly recommended. In the GTFS Express catalogue this rule concerns `feed_info.txt`: when it is missing, the validator raises this notice. Severity: **warning**.

`feed_info.txt` even becomes required as soon as the feed contains `translations.txt`.

## Why it matters

A warning does not block a delivery in GTFS Express. But without `feed_info.txt`, whoever receives the feed cannot tell who published it, in which language, or what period it covers. They cannot tell two successive versions apart, nor know where to report a mistake. Apps that watch for data expiry have no `feed_end_date` to read.

## Common causes

- The tool producing the feed writes only the required files.
- The file was dropped when datasets were split or merged.
- The feed was put together by hand from a few spreadsheets.
- The file exists under another name, such as `feedinfo.txt` or `feed_info.csv`, so it is not recognised.

## How to fix it

Create `feed_info.txt` with its three required fields: `feed_publisher_name`, `feed_publisher_url` and `feed_lang` (a language code such as `en`). Add the recommended ones: `feed_start_date` and `feed_end_date` matching the calendars, `feed_version` to identify the release, `feed_contact_email` or `feed_contact_url` for reports.

In GTFS Express, the editor lets you fill in `feed_info.txt` in the draft like any other file of the feed, and the entry becomes a retouch. "Re-validate" then confirms the warning is gone and that the declared dates hold.

## Example

A minimal yet complete `feed_info.txt`:

```
feed_publisher_name,feed_publisher_url,feed_lang,feed_start_date,feed_end_date,feed_version,feed_contact_email
Example Transit,https://transit.example.org,en,20260901,20270704,2026-09-v3,data@transit.example.org
```

See also the guide [Validate a GTFS feed](/en/guides/validate-a-gtfs-feed) and the [list of rules](/en/rules/).
