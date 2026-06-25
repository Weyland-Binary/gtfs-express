# Validation profiles

A profile selectively re-classifies the severity of validation findings emitted
by the GTFS validator without changing the rule logic itself. Profiles let a
single validator instance serve different publishers with different
publication policies (international canonical vs. national PAN vs. CI gate vs.
legacy migration) without forking the rule set.

## Available profiles

| File | Name | Use when |
|---|---|---|
| `canonical.json` (default) | MobilityData Canonical | Default, international publication. |
| `strict.json` | Strict | CI gate. Promotes every WARNING to ERROR and INFO to WARNING. |
| `lenient.json` | Lenient | Migrating legacy feeds. Demotes Fares v2 ERRORs to WARNINGs. |
| `countries/fr-datagouv.json` | France — transport.data.gouv.fr | Publishing on the French national PAN. |

## How a profile is applied

A profile is selected via the `profile=` query string on `/edit/validate` and
`/edit/export`, or via `validateGTFSFiles(path, { profile: "strict" })`
programmatically. The validator runs unchanged; the profile is applied to the
collected findings before the report is returned. The `valid` flag is then
re-computed from the post-profile severities.

## Schema

Each profile is a JSON object with these fields:

```json
{
  "name": "profile-id",
  "title": "Human-readable title",
  "description": "What this profile does and when to use it.",
  "promote_warning_to_error": false,
  "promote_info_to_warning": false,
  "overrides": {
    "rule_code": "error" | "warning" | "info"
  }
}
```

- `promote_warning_to_error` / `promote_info_to_warning` are bulk transforms
  applied first.
- `overrides` is a per-rule severity table applied after the bulk transforms
  (so a rule explicitly listed in `overrides` always wins).

## Drift guard

Every rule code referenced in any profile MUST exist in
`src/utils/rules.json`. The drift guard runs at module load and throws if a
profile references an unknown rule, so country-profile contributions stay
honest.

## Contributing a country / agency profile

1. Add a new file under `countries/` with a kebab-case name including the ISO
   3166-1 alpha-2 country code prefix (e.g. `de-mdm.json`, `nl-ndovloket.json`,
   `ca-translink.json`).
2. The `name` field must match the filename without the extension.
3. Justify each override briefly in the description so reviewers can audit.
4. Avoid over-tightening. Profiles should reflect *real* publication
   requirements, not personal preference.
