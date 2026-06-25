# Contributing to GTFS Express

Thank you for your interest in contributing to GTFS Express.

> **Language note:** Code, variable names, commit messages, and i18n keys must be in **English**. Discussions, PR descriptions, and issue comments may be in French or English.

---

## Contributor License Agreement (CLA)

**Signing the CLA is required before any pull request can be merged.**

GTFS Express is published under a dual-license model (AGPL v3 + Commercial License). To preserve Weyland Binary's ability to maintain this model, all contributors must assign their economic rights via the [CLA](CLA.md).

The CLA Assistant bot will automatically prompt you to sign on your first pull request. You can also read the full [CLA](CLA.md) in advance.

---

## Development Setup

### Prerequisites

- Node.js 24+
- Docker + Docker Compose (optional, for full-stack testing)

### Running locally

```bash
# Backend (port 3004)
cd GTFS-EXPRESS-API
npm install
npm run dev

# Frontend (port 3000)
cd GTFS-EXPRESS-WEB
npm install
npm start
```

See [README.md](README.md) for Docker setup and environment variables.

---

## Contribution Workflow

1. **Fork** the repository and create a feature branch from `main`
2. **Write your changes** — see conventions below
3. **Run tests** before opening a PR:
   ```bash
   cd GTFS-EXPRESS-API && npm test
   ```
4. **Open a pull request** against `main` — the CLA Assistant bot will ask you to sign if you haven't already

---

## Conventions

### Commit messages (Conventional Commits)

```
feat(edit): add platform_code field to stop edit dialog
fix(validator): correct shape_dist_traveled range check
perf(sql): add index on stop_times(trip_id)
docs: update deployment variables table
```

Prefixes: `feat`, `fix`, `perf`, `refactor`, `test`, `docs`, `chore`

### Frontend

- All API calls via `fetchWithSession()` — never raw `fetch()`
- `recordEdit()` after every mutation
- `dataVersion` in `useEffect` dependency arrays for editable data
- Hooks before any early return (React rules-of-hooks)
- Colors via `theme.palette.*` only — never hardcoded
- MUI for dialogs/forms, PrimeReact for dense DataTables, recharts for charts

### Backend

- New edit handlers in `services/edit/{entity}EditService.js`, re-exported through `services/editService.js` (façade rule)
- Field-level validation via `utils/fieldValidators.js` — never re-implement validators locally
- `logEdit()` after every mutation (undo/redo ops required)
- `syncCacheEntry()` after every mutation
- Prepared statements only — never concatenate user values into SQL

### i18n

- Every visible UI string must have a key in all 8 languages simultaneously (EN, FR, ES, DE, PT, ZH, AR, HI)
- Add the EN key first, then translate — never merge with keys missing in any language
- GTFS spec terms are never translated (`stop_id`, `trip_headsign`, etc.)
- Verify with `npm run i18n:check` from the frontend directory

---

## What to Contribute

Good first issues are labeled `good first issue` on GitHub.

High-value areas:
- Additional GTFS validation rules (aligned with [MobilityData Canonical Validator](https://gtfs-validator.mobilitydata.org/rules.html))
- New language translations
- Performance improvements on large feeds (>100k stop_times)
- Accessibility improvements

Please open an issue before starting significant work, to align on scope and approach.

---

## Questions

Open a [GitHub Discussion](../../discussions) or email weylandbinary@gmail.com.
