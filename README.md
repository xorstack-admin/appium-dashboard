# Appium Studio — Live Test Dashboard

A **versioned, live web dashboard** for Appium Studio iOS test reports.  
Every test run is saved with a build version tag, and your team can select any version from the dropdown to view results.

---

## How it works

```
Appium Studio run
      │
      ▼
Export HTML report from Appium Studio
      │
      ▼
python3 scripts/save_report.py --version v1.2.0 --report report.html
      │
      ├── Parses the HTML report
      ├── Saves → reports/v1.2.0/data.json
      ├── Saves → reports/v1.2.0/meta.json
      └── git commit + push to GitHub
                    │
                    ▼
          Node.js server reads reports/
                    │
                    ▼
          Team opens dashboard URL
          Selects any build version
          from the dropdown
```

---

## Prerequisites

| Tool | Version | Purpose |
|------|---------|---------|
| Node.js | ≥ 16 | Run the server |
| npm | ≥ 8 | Install dependencies |
| Python | ≥ 3.9 | Parse reports & save script |
| Git | any | Push reports to GitHub |

---

## Setup

### 1. Clone & install

```bash
git clone https://github.com/YOUR_ORG/appium-dashboard.git
cd appium-dashboard
npm install
```

### 2. Start the server

```bash
npm start
# Server running at http://localhost:3000
```

Open **http://localhost:3000** in your browser — you should see the dashboard.

---

## Saving a test report

### Step 1 — Export from Appium Studio
After a test run, go to **Test Results → Export → HTML** in Appium Studio.  
Save the `.html` file somewhere accessible.

### Step 2 — Save with version tag

```bash
# Single HTML report:
python3 scripts/save_report.py --version v1.2.0 --report ~/Downloads/MyTest.html

# Folder of HTML reports (all merged into one dashboard):
python3 scripts/save_report.py --version v1.2.0 --report ~/Downloads/reports/

# Already have a data.json? Save that directly:
python3 scripts/save_report.py --version v1.2.0 --report reports_export/data.json

# Save locally without pushing to GitHub:
python3 scripts/save_report.py --version v1.2.0 --report report.html --no-push

# Use a custom label:
python3 scripts/save_report.py --version build-42 --label "Sprint 4 - Regression" --report report.html
```

### Step 3 — Team refreshes the dashboard
The dashboard auto-loads the latest version on open.  
Team members click **⟳ Refresh** or select a version from the dropdown.

---

## Folder structure

```
appium-dashboard/
├── server.js               ← Node.js / Express backend
├── package.json
├── public/
│   └── index.html          ← Live dashboard (served at /)
├── scripts/
│   ├── save_report.py      ← Save + version + push script
│   └── build_dashboard.py  ← Parse HTML → data.json only
├── reports/
│   ├── v1.0.0/
│   │   ├── data.json
│   │   └── meta.json
│   └── v1.1.0/
│       ├── data.json
│       └── meta.json
└── .github/
    └── workflows/
        └── deploy.yml      ← CI/CD (optional)
```

---

## API reference

The server exposes these endpoints:

| Method | Path | Description |
|--------|------|-------------|
| GET | `/api/versions` | List all saved build versions |
| GET | `/api/report/:version` | Get report data for a version |
| GET | `/api/latest` | Get the most recent version's data |
| GET | `/health` | Health check |

---

## Deploying so the whole team can access it

### Option A: Render.com (free, easy)

1. Create account at [render.com](https://render.com)
2. **New → Web Service → Connect GitHub repo**
3. Set:
   - **Build command**: `npm install`
   - **Start command**: `node server.js`
   - **Environment variable**: `PORT=10000`
4. Click Deploy. You'll get a public URL like `https://appium-dashboard.onrender.com`

> **Important:** Render's free tier has no persistent disk. Reports stored in `reports/` will reset on each redeploy. To fix this, use Render's **Persistent Disk** (paid), or use **Option B**.

### Option B: Railway.app (recommended, free tier available)

```bash
npm install -g @railway/cli
railway login
railway init
railway up
```

Railway gives you persistent storage and a public URL automatically.

### Option C: Self-hosted VPS (most control)

```bash
# On your server:
git clone https://github.com/YOUR_ORG/appium-dashboard.git
cd appium-dashboard
npm install
npm install -g pm2
pm2 start server.js --name appium-dashboard
pm2 save

# Set up nginx to proxy port 3000 → your domain
```

---

## CI/CD integration (optional)

If you run tests in a CI pipeline (Jenkins, GitHub Actions, GitLab CI), add this step after the test run:

```yaml
# GitHub Actions example:
- name: Save test report
  run: |
    pip install -r requirements.txt   # no extra deps needed, stdlib only
    python3 scripts/save_report.py \
      --version "${{ github.run_number }}" \
      --label "CI Build ${{ github.run_number }}" \
      --report test-output/report.html

# Or read version from your app's Info.plist / build config:
- name: Save test report
  env:
    BUILD_VERSION: ${{ env.APP_VERSION }}
  run: python3 scripts/save_report.py --report test-output/report.html
```

---

## Dashboard features

- **Build version selector** — dropdown showing all saved versions, newest first
- **Comparison mode** — select two versions to see deltas (↑ / ↓ on pass rate, failed count, etc.)
- **Overall pass/fail badge**
- **Stat cards**: sub-scenarios, passed, failed, slow steps (>4s), step pass rate
- **Donut chart**: pass/fail breakdown
- **Bar chart**: per-scenario passed vs failed sub-scenarios
- **Scenario blocks**: expandable tables with failed step details
- **Refresh button**: re-fetches versions from server without page reload
