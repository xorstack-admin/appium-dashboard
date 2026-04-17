/**
 * VYA QA Platform v4
 *
 * New routes (MongoDB-backed):
 *   /api/auth/*         → Login, register, JWT tokens
 *   /api/admin/*        → Upload, manage, settings (admin only)
 *   /api/dashboard/*    → Read-only report data (any role)
 *   /api/export/*       → CSV/Excel downloads
 *
 * Legacy routes (flat-file, kept for backward compat):
 *   /api/overview
 *   /api/:env/:platform/versions
 *   /api/:env/:platform/report/:version
 *   /api/:env/:platform/daily
 *   /api/:env/:platform/scenarios
 *   /api/:env/:platform/export/*
 *   /health
 */
require('dotenv').config();
const express = require('express');
const http    = require('http');
const fs      = require('fs');
const path    = require('path');
const cors    = require('cors');
const { Server } = require('socket.io');
let XLSX; try { XLSX = require('xlsx'); } catch(_) { XLSX = null; }

const app    = express();
const server = http.createServer(app);
const io     = new Server(server, { cors: { origin: '*' } });

const PORT   = process.env.PORT || 3000;
const ROOT   = __dirname;
const PUBLIC = path.join(ROOT, 'public');

// Store io on app for route access
app.set('io', io);

// Middleware
app.use(cors());
app.use(express.json({ limit: '50mb' }));
app.use(express.static(PUBLIC));

// ── MongoDB routes ───────────────────────────────────────────────────────────
let dbConnected = false;

// Mount routes immediately (they handle auth internally)
app.use('/api/auth', require('./routes/auth'));
app.use('/api/admin', require('./routes/admin'));
app.use('/api/dashboard', require('./routes/dashboard'));
app.use('/api/export', require('./routes/export'));

async function connectDB() {
  const connectFn = require('./config/db');
  await connectFn();
  dbConnected = true;
}

// ── Legacy flat-file routes (kept for backward compatibility) ────────────────
const VALID_ENVS      = ['staging', 'production'];
const VALID_PLATFORMS  = ['ios', 'android'];

function reportsDir(env, platform) {
  return path.join(ROOT, 'reports', env, platform);
}
function scenariosFile(platform) {
  return path.join(ROOT, `scenarios_${platform}.json`);
}

function validateEnvPlatform(req, res, next) {
  const { env, platform } = req.params;
  if (!VALID_ENVS.includes(env))      return res.status(400).json({ error: `Invalid env "${env}". Use: staging | production` });
  if (!VALID_PLATFORMS.includes(platform)) return res.status(400).json({ error: `Invalid platform "${platform}". Use: ios | android` });
  next();
}

function loadMaster(platform) {
  const f = scenariosFile(platform);
  if (!fs.existsSync(f)) return { categories: [] };
  return JSON.parse(fs.readFileSync(f, 'utf8'));
}

function norm(s) {
  return String(s).toLowerCase().replace(/['\u2019`]/g,'').replace(/[^a-z0-9]+/g,' ').trim();
}

function buildScenarioIndex(master) {
  const idx = new Map();
  for (const cat of master.categories || []) {
    for (const sc of cat.scenarios || []) {
      idx.set(norm(sc.name), { categoryId: cat.id, categoryName: cat.name, scenarioId: sc.id, scenarioName: sc.name, sourceFile: sc.sourceFile });
      if (sc.originalMarker) idx.set(norm(sc.originalMarker), { categoryId: cat.id, categoryName: cat.name, scenarioId: sc.id, scenarioName: sc.name, sourceFile: sc.sourceFile });
    }
  }
  return idx;
}

function matchScenario(name, idx) {
  const key = norm(name);
  if (idx.has(key)) return idx.get(key);
  const stripped = key.replace(/^\d+\.?\s+/, '');
  if (idx.has(stripped)) return idx.get(stripped);
  let best = null, bestScore = 0;
  for (const [k, v] of idx) {
    const words = stripped.split(' ').filter(w => w.length > 3);
    if (!words.length) continue;
    const score = words.filter(w => k.includes(w)).length / words.length;
    if (score > bestScore && score > 0.5) { best = v; bestScore = score; }
  }
  return best;
}

function getVersions(env, platform) {
  const dir = reportsDir(env, platform);
  if (!fs.existsSync(dir)) return [];
  return fs.readdirSync(dir, { withFileTypes: true })
    .filter(e => e.isDirectory())
    .map(e => {
      const dataFile = path.join(dir, e.name, 'data.json');
      const metaFile = path.join(dir, e.name, 'meta.json');
      if (!fs.existsSync(dataFile)) return null;
      let meta = {};
      try { if (fs.existsSync(metaFile)) meta = JSON.parse(fs.readFileSync(metaFile,'utf8')); } catch(_) {}
      const stat    = fs.statSync(dataFile);
      const savedAt = meta.savedAt || stat.mtime.toISOString();
      return { version: e.name, label: meta.label || e.name, savedAt,
        runDate: meta.runDate || savedAt.slice(0,10),
        totalSteps: meta.totalSteps, passed: meta.passed, failed: meta.failed,
        passRate: meta.passRate || null };
    })
    .filter(Boolean)
    .sort((a,b) => new Date(b.savedAt) - new Date(a.savedAt));
}

function loadReport(env, platform, version) {
  const file = path.join(reportsDir(env, platform), version, 'data.json');
  if (!fs.existsSync(file)) return null;
  return JSON.parse(fs.readFileSync(file, 'utf8'));
}

function enrichReport(data, idx, master) {
  return data.map(s => ({
    ...s,
    subScenarios: (s.subScenarios || []).map(sub => {
      const m = matchScenario(sub.name, idx);
      return { ...sub, categoryId: m?.categoryId||null, categoryName: m?.categoryName||'Uncategorized',
        scenarioId: m?.scenarioId||null, sourceFile: m?.sourceFile||null };
    })
  }));
}

function rollupByCategory(subs, master) {
  const map = new Map();
  for (const cat of master.categories || []) {
    const catScenarios = cat.scenarios || [];
    map.set(cat.id, { categoryId: cat.id, categoryName: cat.name,
      masterTotal: catScenarios.length, run: 0, passed: 0, failed: 0, notRun: 0, passRate: null, subScenarios: [] });
  }
  map.set(0, { categoryId:0, categoryName:'Uncategorized', masterTotal:0, run:0, passed:0, failed:0, notRun:0, passRate:null, subScenarios:[] });

  for (const sub of subs) {
    const cid = sub.categoryId || 0;
    if (!map.has(cid)) map.set(cid, { categoryId:cid, categoryName:sub.categoryName||'Uncategorized',
      masterTotal:0, run:0, passed:0, failed:0, notRun:0, passRate:null, subScenarios:[] });
    const e = map.get(cid);
    e.run++;
    e.subScenarios.push(sub);
    if (sub.overall === 'Passed') e.passed++; else e.failed++;
  }

  for (const cat of master.categories || []) {
    const e = map.get(cat.id);
    if (e) {
      e.notRun = Math.max(0, e.masterTotal - e.run);
      e.passRate = e.run > 0 ? parseFloat(((e.passed/e.run)*100).toFixed(1)) : null;
    }
  }
  if (map.get(0)?.run === 0) map.delete(0);
  return [...map.values()];
}

function buildCSV(rows) {
  const hdr = ['Environment','Platform','Build Version','Run Date','Category','Scenario ID','Scenario Name','Status','Total Steps','Passed Steps','Failed Steps','Slow Steps'];
  const lines = [hdr.join(',')];
  for (const r of rows) {
    lines.push([
      `"${r.env||''}"`, `"${r.platform||''}"`, `"${r.version||''}"`, `"${r.runDate||''}"`,
      `"${r.category||''}"`, `"${r.scenarioId||''}"`, `"${(r.name||'').replace(/"/g,'""')}"`,
      `"${r.status||''}"`, r.totalSteps||0, r.passedSteps||0, r.failedSteps||0, r.slowSteps||0
    ].join(','));
  }
  return lines.join('\r\n');
}

function toCSVRows(env, platform, version, runDate, enriched) {
  const rows = [];
  for (const sc of enriched) {
    for (const sub of sc.subScenarios || []) {
      rows.push({ env, platform, version, runDate,
        category: sub.categoryName||'Uncategorized', scenarioId: sub.scenarioId||'',
        name: sub.name, status: sub.overall, totalSteps: sub.totalSteps,
        passedSteps: sub.passedSteps, failedSteps: sub.failedSteps, slowSteps: sub.slowSteps });
    }
  }
  return rows;
}

// ── Legacy API routes ──────────────���─────────────────────────────────────────
app.get('/api/overview', (_,res) => {
  try {
    const result = {};
    for (const env of VALID_ENVS) {
      result[env] = {};
      for (const platform of VALID_PLATFORMS) {
        const versions = getVersions(env, platform);
        if (!versions.length) { result[env][platform] = null; continue; }
        const latest = versions[0];
        result[env][platform] = {
          version: latest.version, label: latest.label, savedAt: latest.savedAt,
          runDate: latest.runDate, passRate: latest.passRate, passed: latest.passed,
          failed: latest.failed, totalReports: versions.length,
        };
      }
    }
    res.json(result);
  } catch(e) { res.status(500).json({ error: e.message }); }
});

app.get('/api/:env/:platform/versions', validateEnvPlatform, (req,res) => {
  try { res.json({ versions: getVersions(req.params.env, req.params.platform) }); }
  catch(e) { res.status(500).json({ error: e.message }); }
});

app.get('/api/:env/:platform/scenarios', validateEnvPlatform, (req,res) => {
  try { res.json(loadMaster(req.params.platform)); }
  catch(e) { res.status(500).json({ error: e.message }); }
});

app.get('/api/:env/:platform/report/:version', validateEnvPlatform, (req,res) => {
  const { env, platform, version } = req.params;
  const data = loadReport(env, platform, version);
  if (!data) return res.status(404).json({ error: `Version "${version}" not found.` });
  try {
    const master   = loadMaster(platform);
    const idx      = buildScenarioIndex(master);
    const enriched = enrichReport(data, idx, master);
    const allSubs  = enriched.flatMap(r => r.subScenarios||[]);
    res.json({ report: enriched, byCategory: rollupByCategory(allSubs, master) });
  } catch(e) { res.status(500).json({ error: e.message }); }
});

app.get('/api/:env/:platform/daily', validateEnvPlatform, (req,res) => {
  try {
    const { env, platform } = req.params;
    const { from, to } = req.query;
    let versions = getVersions(env, platform);
    if (from) versions = versions.filter(v => v.runDate >= from);
    if (to)   versions = versions.filter(v => v.runDate <= to);

    const byDate = new Map();
    for (const v of versions) {
      if (!byDate.has(v.runDate)) byDate.set(v.runDate, []);
      byDate.get(v.runDate).push(v);
    }

    const master = loadMaster(platform);
    const idx    = buildScenarioIndex(master);
    const days   = [];

    for (const [date, builds] of byDate) {
      const sorted    = [...builds].sort((a,b) => new Date(a.savedAt)-new Date(b.savedAt));
      const lastBuild = sorted[sorted.length-1];
      const lastData  = loadReport(env, platform, lastBuild.version);
      let eod = { passed:0, failed:0, total:0, passRate:0, byCategory:[] };
      if (lastData) {
        const enriched  = enrichReport(lastData, idx, master);
        const allSubs   = enriched.flatMap(r => r.subScenarios||[]);
        const p = allSubs.filter(s=>s.overall==='Passed').length;
        const f = allSubs.filter(s=>s.overall==='Failed').length;
        const t = allSubs.length;
        eod = { passed:p, failed:f, total:t, passRate: t>0?parseFloat(((p/t)*100).toFixed(1)):0,
          byCategory: rollupByCategory(allSubs, master) };
      }
      const progression = sorted.map(b => {
        const d = loadReport(env, platform, b.version);
        if (!d) return { version:b.version, savedAt:b.savedAt, passRate:null };
        const subs = d.flatMap(r=>r.subScenarios||[]);
        const p = subs.filter(s=>s.overall==='Passed').length;
        const t = subs.length;
        return { version:b.version, savedAt:b.savedAt, passRate: t>0?parseFloat(((p/t)*100).toFixed(1)):0 };
      });
      const first = progression[0]?.passRate ?? null;
      const last  = progression[progression.length-1]?.passRate ?? null;
      days.push({ date, buildCount:sorted.length, firstVersion:sorted[0].version, lastVersion:lastBuild.version,
        improvement: (first!==null&&last!==null)?parseFloat((last-first).toFixed(1)):null, endOfDay:eod, progression });
    }
    days.sort((a,b) => b.date.localeCompare(a.date));
    res.json({ days, total:days.length });
  } catch(e) { res.status(500).json({ error: e.message }); }
});

app.get('/api/:env/:platform/export/range', validateEnvPlatform, (req,res) => {
  const { env, platform } = req.params;
  const { from, to } = req.query;
  try {
    let versions = getVersions(env, platform);
    if (from) versions = versions.filter(v => v.runDate >= from);
    if (to)   versions = versions.filter(v => v.runDate <= to);
    const master = loadMaster(platform);
    const idx    = buildScenarioIndex(master);
    const allRows = [];
    for (const v of versions) {
      const data = loadReport(env, platform, v.version);
      if (!data) continue;
      allRows.push(...toCSVRows(env, platform, v.version, v.runDate, enrichReport(data, idx, master)));
    }
    const name = (from&&to)?`${env}-${platform}-${from}-to-${to}`:`${env}-${platform}-all`;
    res.setHeader('Content-Type','text/csv');
    res.setHeader('Content-Disposition',`attachment; filename="${name}.csv"`);
    res.send(buildCSV(allRows));
  } catch(e) { res.status(500).json({ error: e.message }); }
});

app.get('/api/:env/:platform/export/:version', validateEnvPlatform, (req,res) => {
  const { env, platform, version } = req.params;
  const data = loadReport(env, platform, version);
  if (!data) return res.status(404).json({ error: 'Not found.' });
  try {
    const master   = loadMaster(platform);
    const idx      = buildScenarioIndex(master);
    const enriched = enrichReport(data, idx, master);
    const versions = getVersions(env, platform);
    const meta     = versions.find(v=>v.version===version)||{ runDate:'unknown' };
    res.setHeader('Content-Type','text/csv');
    res.setHeader('Content-Disposition',`attachment; filename="${env}-${platform}-${version}.csv"`);
    res.send(buildCSV(toCSVRows(env, platform, version, meta.runDate, enriched)));
  } catch(e) { res.status(500).json({ error: e.message }); }
});

// XLSX exports (legacy)
function buildXLSXLegacy(rows, sheetName) {
  if (!XLSX) return null;
  const headers = ['Environment','Platform','Build Version','Run Date','Category','Scenario ID','Scenario Name','Status','Total Steps','Passed Steps','Failed Steps','Slow Steps'];
  const data = [headers, ...rows.map(r => [
    r.env||'', r.platform||'', r.version||'', r.runDate||'',
    r.category||'', r.scenarioId||'', r.name||'', r.status||'',
    r.totalSteps||0, r.passedSteps||0, r.failedSteps||0, r.slowSteps||0
  ])];
  const wb = XLSX.utils.book_new();
  const ws = XLSX.utils.aoa_to_sheet(data);
  ws['!cols'] = [12,10,16,12,28,12,48,10,12,14,14,12].map(w => ({ wch: w }));
  XLSX.utils.book_append_sheet(wb, ws, sheetName || 'Results');
  return XLSX.write(wb, { type: 'buffer', bookType: 'xlsx' });
}

app.get('/api/:env/:platform/export-xlsx/:version', validateEnvPlatform, (req,res) => {
  if (!XLSX) return res.status(500).json({ error: 'xlsx package not installed.' });
  const { env, platform, version } = req.params;
  const data = loadReport(env, platform, version);
  if (!data) return res.status(404).json({ error: 'Not found.' });
  try {
    const master   = loadMaster(platform);
    const idx      = buildScenarioIndex(master);
    const enriched = enrichReport(data, idx, master);
    const versions = getVersions(env, platform);
    const meta     = versions.find(v=>v.version===version)||{ runDate:'unknown' };
    const rows     = toCSVRows(env, platform, version, meta.runDate, enriched);
    const buf      = buildXLSXLegacy(rows, version.slice(0,31));
    res.setHeader('Content-Type','application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
    res.setHeader('Content-Disposition',`attachment; filename="${env}-${platform}-${version}.xlsx"`);
    res.send(buf);
  } catch(e) { res.status(500).json({ error: e.message }); }
});

app.get('/api/:env/:platform/export-xlsx/range', validateEnvPlatform, (req,res) => {
  if (!XLSX) return res.status(500).json({ error: 'xlsx package not installed.' });
  const { env, platform } = req.params;
  const { from, to } = req.query;
  try {
    let versions = getVersions(env, platform);
    if (from) versions = versions.filter(v => v.runDate >= from);
    if (to)   versions = versions.filter(v => v.runDate <= to);
    const master  = loadMaster(platform);
    const idx     = buildScenarioIndex(master);
    const allRows = [];
    for (const v of versions) {
      const data = loadReport(env, platform, v.version);
      if (!data) continue;
      allRows.push(...toCSVRows(env, platform, v.version, v.runDate, enrichReport(data, idx, master)));
    }
    const sheetName = (from && to) ? `${from} to ${to}`.slice(0,31) : `${env}-${platform}`;
    const buf  = buildXLSXLegacy(allRows, sheetName);
    const name = (from&&to)?`${env}-${platform}-${from}-to-${to}`:`${env}-${platform}-all`;
    res.setHeader('Content-Type','application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
    res.setHeader('Content-Disposition',`attachment; filename="${name}.xlsx"`);
    res.send(buf);
  } catch(e) { res.status(500).json({ error: e.message }); }
});

app.get('/health', (_,res) => {
  const summary = {};
  for (const env of VALID_ENVS) {
    summary[env] = {};
    for (const p of VALID_PLATFORMS) summary[env][p] = getVersions(env,p).length;
  }
  res.json({ status:'ok', dbConnected, reports: summary });
});

// ── Socket.io ────────────────────────────────────────────────────────────────
io.on('connection', (socket) => {
  console.log('Client connected:', socket.id);
  socket.on('disconnect', () => console.log('Client disconnected:', socket.id));
});

// ── Start ────────────────────────────────────────────────────────────────────
async function start() {
  // Check required env vars
  if (!process.env.MONGO_URI) {
    console.error('ERROR: MONGO_URI environment variable is not set!');
    console.error('Set it in Render dashboard → Environment → Add Environment Variable');
    process.exit(1);
  }
  if (!process.env.JWT_SECRET) {
    console.error('ERROR: JWT_SECRET environment variable is not set!');
    process.exit(1);
  }

  try {
    await connectDB();
  } catch (err) {
    console.error('Failed to connect to MongoDB:', err.message);
    process.exit(1);
  }

  server.listen(PORT, () => {
    console.log(`\nVYA QA Platform v4 running on port ${PORT}`);
    console.log(`  MongoDB: connected`);
    console.log(`  Cloudinary: ${process.env.CLOUDINARY_CLOUD_NAME || 'not configured'}\n`);
  });
}

start();
