# Audience (Consumer / Business) + Multi-Run Per Version

Date: 2026-05-13

## Goals

1. Add an **audience** dimension to every report: `consumer | business`. The same env+platform now serves two parallel buckets keyed by audience.
2. Allow **multiple reports under one version** (add / edit / delete each independently).

## Schema

`models/Report.js`:
- New field: `audience: { type: String, enum: ['consumer','business'], required: true, default: 'consumer' }`
- Old unique index on `{env, platform, version}` removed (allows multiple runs per version).
- New non-unique indexes for query speed: `{env, platform, audience, createdAt}`, `{env, platform, audience, version, createdAt}`.

Migration: `scripts/add-audience.js`
- `updateMany({audience: {$exists:false}}, {$set: {audience:'consumer'}})`
- Drop index `env_1_platform_1_version_1` if it exists.

## Backend API

All routes additive — old calls work without audience (no filter). New calls pass audience.

- `POST /api/admin/upload` — accepts `audience` in body, validates enum, **removes 409 duplicate check** (multi-run).
- `GET /api/admin/reports?env=&platform=&audience=` — adds audience filter.
- `GET /api/dashboard/:env/:platform/versions?audience=X` — when audience given, groups by version and embeds `runs: [{id, label, savedAt, runDate, passRate, ...}]`; latest run's metadata at the top level.
- `GET /api/dashboard/run/:id` — NEW: fetch a single report by Mongo _id (same shape as today's report endpoint).
- `GET /api/dashboard/:env/:platform/report/:version?audience=X&runId=Y` — backward compat: picks `runId` if given, else latest run of that audience+version.
- Other endpoints (`compare`, `flaky`, `insights`, `daily`, `analytics`, root-cause, predictive, failure-intel, forensics, workflow/*) — accept optional `audience`.
- `GET /api/export/...` — accepts optional `audience`, includes it in filename + CSV column.

## Services

Each service that filters `Report.find({env, platform, ...})` gets an optional `audience` argument; when truthy, append to the Mongo filter.

## Admin UI (`public/admin/index.html`)

- Upload form: add Audience `<select>` (Consumer | Business) next to Platform.
- Reports filter: add Audience filter dropdown.
- Reports table: add Audience column with chip.

## User dashboard

`public/dashboard/index.html` (landing): **unchanged**. Cards still navigate `report.html?env=X&platform=Y`. The audience choice happens on the report page itself. Card stats roll up both audiences combined.

`public/dashboard/report.html` (analytics page):
- Replace the single Build/Version dropdown with two side-by-side audience tracks:
  - `Consumer  [Version ▾]  [Run ▾]`
  - `Business  [Version ▾]  [Run ▾]`
- Run dropdown is hidden when the version has only 1 run.
- Picking a value on either side becomes the "active" track; the other dims. URL gets `&audience=X&runId=Y`.
- Active selection drives all downstream calls (analytics, compare, exports, flaky).
- Compare modal continues to compare within active audience.

## Defaults

- Existing reports → audience defaults to `consumer`.
- Multi-run version → default to latest run.

## Out of scope

Auth, scenarios, users, alerts, parser, Cloudinary, socket.io, legacy `server.js` flat-file routes, landing page styling.
