# VYA QA Platform v4 — Architecture Design

**Date**: 2026-04-17
**Status**: Approved

## Decision Summary

Transform existing Appium dashboard (flat-file JSON + Express) into a full QA platform with:
- **Admin Dashboard** — upload, manage reports, scenarios, users, settings, alerts
- **User Dashboard** — read-only view with charts, trends, exports
- **MongoDB Atlas** — structured data (users, reports, scenarios, logs, settings)
- **Cloudinary** — screenshots, raw HTML/XML reports, large file storage
- **Socket.io** — real-time dashboard updates on upload/delete
- **JWT auth** — admin and viewer roles

## Storage Strategy

| Data | Storage | Reason |
|---|---|---|
| Users, auth, roles | MongoDB | Structured queries |
| Report metadata + parsed results | MongoDB | JSON-native |
| Scenarios, categories | MongoDB | Relational lookups |
| Activity logs, settings, alerts | MongoDB | Small documents |
| Screenshots, images | Cloudinary | 10GB free, CDN |
| Raw HTML/XML reports | Cloudinary | 25MB/file, raw upload |

## Project Structure

```
appium-dashboard/
├── server.js
├── .env
├── config/          → db.js, cloudinary.js, socket.js
├── models/          → User, Report, Scenario, ActivityLog, Setting, Alert
├── middleware/       → auth.js, adminOnly.js, upload.js
├── routes/          → auth.js, admin.js, dashboard.js, export.js
├── services/        → parser.js, cloudinaryService.js, alertService.js
├── public/
│   ├── index.html   → Login
│   ├── admin/       → Admin dashboard
│   └── dashboard/   → User dashboard
├── scripts/         → seed_admin.js
└── reports/         → Legacy (migration)
```

## API Routes

- `/api/auth/*` — login, register, profile
- `/api/admin/*` — upload, manage reports/scenarios/users/settings/alerts (admin only)
- `/api/dashboard/*` — read-only report data (any authenticated role)
- `/api/export/*` — CSV/Excel downloads

## Data Flow

Admin upload → Multer → Cloudinary (files) → Parser → MongoDB (data) → Socket.io broadcast → User dashboard auto-updates

## Auth Flow

JWT tokens (24h), bcrypt passwords, seed script for first admin, role-based middleware.
