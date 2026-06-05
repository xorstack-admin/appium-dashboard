const express = require('express');
const fs = require('fs');
const fsp = require('fs').promises;
const { auth, adminOnly } = require('../middleware/auth');
const upload = require('../middleware/upload');
const { uploadErrorHandler } = require('../middleware/upload');
const Report = require('../models/Report');
const Scenario = require('../models/Scenario');
const User = require('../models/User');
const ActivityLog = require('../models/ActivityLog');
const Setting = require('../models/Setting');
const Alert = require('../models/Alert');
const { parseHTML, parseXML } = require('../services/parser');
const yauzl = require('yauzl');
const { uploadBuffer, uploadStream, deleteFile } = require('../services/cloudinaryService');
const { checkAlerts } = require('../services/alertService');

// ── yauzl helpers ────────────────────────────────────────────────────────────
// Streaming zip access: yauzl reads the central directory once (~tiny) and lets
// us pull each entry's bytes on demand. We never hold the whole zip in heap,
// which is critical on 512MB Render instances.
function openZip(filePath) {
  return new Promise((resolve, reject) => {
    yauzl.open(filePath, { lazyEntries: true, autoClose: false }, (err, zipfile) => {
      if (err) return reject(err);
      resolve(zipfile);
    });
  });
}

function listZipEntries(zipfile) {
  return new Promise((resolve, reject) => {
    const entries = [];
    zipfile.on('entry', (entry) => {
      entries.push(entry);
      zipfile.readEntry();
    });
    zipfile.on('end', () => resolve(entries));
    zipfile.on('error', reject);
    zipfile.readEntry();
  });
}

function openEntryStream(zipfile, entry) {
  return new Promise((resolve, reject) => {
    zipfile.openReadStream(entry, (err, readStream) => {
      if (err) reject(err);
      else resolve(readStream);
    });
  });
}

async function entryToBuffer(zipfile, entry) {
  const readStream = await openEntryStream(zipfile, entry);
  return new Promise((resolve, reject) => {
    const chunks = [];
    readStream.on('data', (c) => chunks.push(c));
    readStream.on('end', () => resolve(Buffer.concat(chunks)));
    readStream.on('error', reject);
  });
}

const router = express.Router();

// All admin routes require auth + admin role
router.use(auth, adminOnly);

// ── helpers (same fuzzy-match logic as original server.js) ───────────────────
function norm(s) {
  return String(s).toLowerCase().replace(/['\u2019`]/g, '').replace(/[^a-z0-9]+/g, ' ').trim();
}

function buildScenarioIndex(master) {
  const idx = new Map();
  for (const cat of master.categories || []) {
    for (const sc of cat.scenarios || []) {
      const entry = { categoryId: cat.id, categoryName: cat.name, scenarioId: sc.id, scenarioName: sc.name, sourceFile: sc.sourceFile };
      idx.set(norm(sc.name), entry);
      if (sc.originalMarker) idx.set(norm(sc.originalMarker), entry);
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

// ── Upload Report ────────────────────────────────────────────────────────────
router.post('/upload', (req, res, next) => {
  upload.array('files', 20)(req, res, (err) => {
    if (err) return uploadErrorHandler(err, req, res, next);
    next();
  });
}, async (req, res) => {
  // Disable Node's request/response timeouts — large zips can take minutes to
  // process. (Render's HTTP proxy still has its own timeout, but at least we
  // don't add our own on top.)
  if (req.setTimeout) req.setTimeout(0);
  if (res.setTimeout) res.setTimeout(0);

  const tmpFilesToCleanup = [];
  const zipfilesToClose = [];
  try {
    const { env, platform, version, label, notes } = req.body;
    const businessVersion = String(req.body.businessVersion || '').trim();
    if (!env || !platform || !version)
      return res.status(400).json({ error: 'env, platform, and version (consumer) are required' });
    if (!businessVersion)
      return res.status(400).json({ error: 'businessVersion is required' });

    // Single upload now carries BOTH version labels — one Report doc serves
    // both Consumer (via `version`) and Business (via `businessVersion`) tracks
    // on the user dashboard. Files/scenarios are shared.

    const rawFiles = req.files || [];
    for (const f of rawFiles) { if (f.path) tmpFilesToCleanup.push(f.path); }

    // Build a list of "sources" — lightweight metadata only. Each source knows
    // how to stream its bytes from disk on demand (yauzl entry stream for zip
    // contents, or fs.createReadStream for direct uploads). We never load the
    // full zip into memory.
    const sources = [];
    // source: { originalname, size, getStream(): Readable, getBuffer(): Buffer }

    for (const file of rawFiles) {
      if (file.originalname.toLowerCase().endsWith('.zip')) {
        let zipfile;
        try {
          zipfile = await openZip(file.path);
        } catch (zipErr) {
          return res.status(400).json({ error: `Failed to open zip "${file.originalname}": ${zipErr.message}` });
        }
        zipfilesToClose.push(zipfile);

        let entries;
        try {
          entries = await listZipEntries(zipfile);
        } catch (zipErr) {
          return res.status(400).json({ error: `Failed to read zip entries in "${file.originalname}": ${zipErr.message}` });
        }

        for (const entry of entries) {
          if (/\/$/.test(entry.fileName)) continue; // directory entry
          const name = entry.fileName.split('/').pop();
          if (!name || name.startsWith('.')) continue;
          sources.push({
            originalname: name,
            size: entry.uncompressedSize,
            getStream: () => openEntryStream(zipfile, entry),
            getBuffer: () => entryToBuffer(zipfile, entry),
          });
        }
      } else {
        sources.push({
          originalname: file.originalname,
          size: file.size,
          getStream: async () => fs.createReadStream(file.path),
          getBuffer: () => fsp.readFile(file.path),
        });
      }
    }

    const htmlSources = sources.filter(s => /\.(html|htm)$/i.test(s.originalname));
    const xmlSources  = sources.filter(s => /\.xml$/i.test(s.originalname));
    const jsonSources = sources.filter(s => /\.json$/i.test(s.originalname));

    // Parse HTML reports — these need to be materialized as strings to parse,
    // but they're typically small (a few MB at most), and there are usually
    // only a handful.
    const scenarioRuns = [];
    const parseWarnings = []; // [{ file, reason }]
    for (const src of htmlSources) {
      try {
        const buf = await src.getBuffer();
        const content = buf.toString('utf-8');
        const parsed = parseHTML(content, src.originalname);
        scenarioRuns.push(parsed);
        if (!parsed.subScenarios || parsed.subScenarios.length === 0) {
          parseWarnings.push({ file: src.originalname, reason: 'No scenarios extracted — unrecognized HTML format' });
        }
      } catch (parseErr) {
        console.error(`Warning: failed to parse ${src.originalname}:`, parseErr.message);
        parseWarnings.push({ file: src.originalname, reason: `Parse error: ${parseErr.message}` });
      }
    }

    // Parse XML files (Appium test definitions — extracts scenario names only)
    for (const src of xmlSources) {
      try {
        const buf = await src.getBuffer();
        const content = buf.toString('utf-8');
        const parsed = parseXML(content, src.originalname);
        if (parsed.subScenarios && parsed.subScenarios.length > 0) {
          scenarioRuns.push(parsed);
        } else {
          parseWarnings.push({ file: src.originalname, reason: 'No scenarios extracted from XML' });
        }
      } catch (xmlErr) {
        console.error(`Warning: failed to parse ${src.originalname}:`, xmlErr.message);
        parseWarnings.push({ file: src.originalname, reason: `XML parse error: ${xmlErr.message}` });
      }
    }

    // Parse JSON reports — handles multiple formats
    for (const src of jsonSources) {
      try {
        const buf = await src.getBuffer();
        const raw = JSON.parse(buf.toString('utf-8'));
        const arr = Array.isArray(raw) ? raw : [raw];
        for (const item of arr) {
          // Format 1: already-parsed scenario run (has subScenarios)
          if (item.subScenarios && Array.isArray(item.subScenarios)) {
            scenarioRuns.push(item);
            continue;
          }
          // Format 2: array of test results [{name, status, duration}, ...]
          if (item.tests && Array.isArray(item.tests)) {
            const subs = item.tests.map(t => ({
              name: t.name || t.title || 'Unknown',
              category: require('../services/parser').categorize(t.name || t.title || ''),
              duration: parseFloat(t.duration || t.time || 0),
              totalSteps: 1,
              passedSteps: (t.status || t.state || '').toLowerCase() === 'passed' ? 1 : 0,
              failedSteps: (t.status || t.state || '').toLowerCase() === 'failed' ? 1 : 0,
              slowSteps: 0,
              overall: (t.status || t.state || '').toLowerCase() === 'failed' ? 'Failed' : 'Passed',
              failed: [], slow: [],
            }));
            scenarioRuns.push({
              scenario: item.name || src.originalname.replace(/\.json$/i, ''),
              device: item.device || '', runStarted: item.runStarted || '', totalTime: item.totalTime || '',
              overall: subs.some(s => s.overall === 'Failed') ? 'Failed' : 'Passed',
              totalSteps: subs.length,
              passedSteps: subs.filter(s => s.overall === 'Passed').length,
              failedSteps: subs.filter(s => s.overall === 'Failed').length,
              slowSteps: 0,
              subScenarios: subs,
            });
            continue;
          }
          // Format 3: single test {name, status, duration}
          if (item.name && (item.status || item.overall)) {
            const isFailed = (item.status || item.overall || '').toLowerCase() === 'failed';
            scenarioRuns.push({
              scenario: src.originalname.replace(/\.json$/i, ''),
              device: '', runStarted: '', totalTime: '',
              overall: isFailed ? 'Failed' : 'Passed',
              totalSteps: 1, passedSteps: isFailed ? 0 : 1, failedSteps: isFailed ? 1 : 0, slowSteps: 0,
              subScenarios: [{
                name: item.name,
                category: require('../services/parser').categorize(item.name),
                duration: parseFloat(item.duration || 0),
                totalSteps: 1, passedSteps: isFailed ? 0 : 1, failedSteps: isFailed ? 1 : 0, slowSteps: 0,
                overall: isFailed ? 'Failed' : 'Passed',
                failed: [], slow: [],
              }],
            });
          }
        }
      } catch (jsonErr) {
        console.error(`Warning: failed to parse ${src.originalname}:`, jsonErr.message);
        parseWarnings.push({ file: src.originalname, reason: `JSON parse error: ${jsonErr.message}` });
      }
    }

    // Upload sources to Cloudinary by streaming each entry directly from disk
    // (via yauzl) into Cloudinary's upload_stream — no buffering of binary data
    // in the JS heap. Concurrency is the bottleneck for completion time, not
    // memory, so we run a healthy parallel batch.
    const CONCURRENCY = 15;
    const fileRefs = new Array(sources.length);

    async function uploadOne(src, idx) {
      const isImage = /\.(png|jpg|jpeg|gif|webp)$/i.test(src.originalname);
      try {
        const readable = await src.getStream();
        const result = await uploadStream(readable, {
          folder: `vya-reports/${env}/${platform}/${version}`,
          resourceType: isImage ? 'image' : 'raw',
          publicId: src.originalname.replace(/\.[^.]+$/, '') + '-' + Date.now(),
        });
        fileRefs[idx] = {
          type: isImage ? 'screenshot' : src.originalname.match(/\.(xml|json)$/i) ? 'attachment' : 'raw_report',
          url: result.url,
          publicId: result.publicId,
          originalName: src.originalname,
          size: result.size,
        };
      } catch (uploadErr) {
        console.error(`Warning: failed to upload ${src.originalname}:`, uploadErr.message);
        fileRefs[idx] = {
          type: isImage ? 'screenshot' : 'raw_report',
          url: null,
          publicId: null,
          originalName: src.originalname,
          size: src.size || 0,
        };
      }
    }

    for (let i = 0; i < sources.length; i += CONCURRENCY) {
      const batch = sources.slice(i, i + CONCURRENCY);
      await Promise.all(batch.map((s, bIdx) => uploadOne(s, i + bIdx)));
    }

    // Build a map of uploaded screenshot filename → Cloudinary URL
    // so we can link failed steps to their screenshots
    const screenshotMap = new Map();
    for (const ref of fileRefs) {
      if (ref.type === 'screenshot' && ref.url && ref.originalName) {
        // Case-insensitive match on filename
        screenshotMap.set(ref.originalName.toLowerCase(), ref.url);
      }
    }

    // Attach Cloudinary URLs to failed steps' screenshots
    for (const run of scenarioRuns) {
      for (const sub of run.subScenarios || []) {
        for (const f of sub.failed || []) {
          if (f.screenshots && f.screenshots.length) {
            f.screenshotUrls = f.screenshots
              .map(name => screenshotMap.get(String(name).toLowerCase()))
              .filter(Boolean);
          }
        }
      }
    }

    // Enrich with scenario categories
    const scenarioDoc = await Scenario.findOne({ platform });
    const idx = scenarioDoc ? buildScenarioIndex(scenarioDoc) : new Map();

    for (const run of scenarioRuns) {
      for (const sub of run.subScenarios || []) {
        const match = matchScenario(sub.name, idx);
        if (match) {
          sub.categoryId = match.categoryId;
          sub.categoryName = match.categoryName;
          sub.scenarioId = match.scenarioId;
          sub.sourceFile = match.sourceFile;
        }
      }
    }

    // Calculate totals
    const allSubs = scenarioRuns.flatMap(r => r.subScenarios || []);
    const totalPassed = allSubs.filter(s => s.overall === 'Passed').length;
    const totalFailed = allSubs.filter(s => s.overall === 'Failed').length;
    const totalScenarios = allSubs.length;
    const passRate = totalScenarios > 0
      ? parseFloat(((totalPassed / totalScenarios) * 100).toFixed(1))
      : null;

    const report = await Report.create({
      env, platform, version, businessVersion,
      label: label || version,
      notes: notes || '',
      scenarios: scenarioRuns,
      passRate, totalPassed, totalFailed, totalScenarios,
      files: fileRefs,
      uploadedBy: req.user._id,
      runDate: scenarioRuns[0]?.runStarted ? new Date(scenarioRuns[0].runStarted) : new Date(),
    });

    await ActivityLog.create({
      action: 'upload', user: req.user._id, userName: req.user.name,
      target: `${env}/${platform}/${version} ↔ ${businessVersion}`,
      details: { passRate, totalPassed, totalFailed, totalScenarios },
    });

    // Emit real-time update + check alerts
    const io = req.app.get('io');
    if (io) io.emit('new-report', { id: report._id, env, platform, version, businessVersion, passRate, label: report.label });
    await checkAlerts(report, io);

    res.status(201).json({ report, parseWarnings });
  } catch (err) {
    res.status(500).json({ error: err.message });
  } finally {
    // Close any yauzl file handles we opened.
    for (const zf of zipfilesToClose) {
      try { zf.close(); } catch (_) {}
    }
    // Clean up temp upload files written by multer disk storage. Best-effort —
    // ignore failures (file already gone, container restarted, etc.).
    for (const p of tmpFilesToCleanup) {
      fsp.unlink(p).catch(() => {});
    }
  }
});

// ── Reports CRUD ─────────────────────────────────────────────────────────────
router.get('/reports', async (req, res) => {
  try {
    const { env, platform } = req.query;
    const filter = {};
    if (env) filter.env = env;
    if (platform) filter.platform = platform;
    const reports = await Report.find(filter).select('-scenarios').sort({ createdAt: -1 }).populate('uploadedBy', 'name email');
    res.json({ reports });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

router.put('/reports/:id', async (req, res) => {
  try {
    const { label, notes } = req.body;
    const report = await Report.findByIdAndUpdate(req.params.id, { label, notes }, { new: true }).select('-scenarios');
    if (!report) return res.status(404).json({ error: 'Report not found' });

    await ActivityLog.create({
      action: 'edit', user: req.user._id, userName: req.user.name,
      target: `${report.env}/${report.platform}/${report.version}${report.businessVersion ? ' ↔ ' + report.businessVersion : ''}`,
    });

    res.json({ report });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

router.delete('/reports/:id', async (req, res) => {
  try {
    const report = await Report.findById(req.params.id);
    if (!report) return res.status(404).json({ error: 'Report not found' });

    // Delete the Mongo doc FIRST so the UI sees the report gone instantly.
    // Cloudinary cleanup is hundreds-to-thousands of API calls for large
    // reports — too slow to do inside the request (Render's proxy times out
    // at ~100s, leaving the doc undeleted and the UI looking broken).
    await Report.findByIdAndDelete(req.params.id);

    await ActivityLog.create({
      action: 'delete', user: req.user._id, userName: req.user.name,
      target: `${report.env}/${report.platform}/${report.version}${report.businessVersion ? ' ↔ ' + report.businessVersion : ''}`,
    });

    const io = req.app.get('io');
    if (io) io.emit('report-deleted', { id: report._id, env: report.env, platform: report.platform, version: report.version, businessVersion: report.businessVersion });

    res.json({ success: true });

    // Fire-and-forget Cloudinary cleanup. Errors are logged but don't affect
    // the user — the DB record is already gone, and orphaned Cloudinary files
    // are a much smaller problem than a UI that won't delete.
    const files = report.files || [];
    setImmediate(async () => {
      const CLEANUP_CONCURRENCY = 10;
      for (let i = 0; i < files.length; i += CLEANUP_CONCURRENCY) {
        const batch = files.slice(i, i + CLEANUP_CONCURRENCY);
        await Promise.all(batch.map(file => {
          if (!file.publicId) return Promise.resolve();
          const resourceType = file.type === 'screenshot' ? 'image' : 'raw';
          return deleteFile(file.publicId, resourceType).catch(err => {
            console.error(`Cloudinary cleanup failed for ${file.publicId}:`, err.message);
          });
        }));
      }
    });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// ── Scenario Management ──────────────────────────────────────────────────────
router.get('/scenarios/:platform', async (req, res) => {
  try {
    const doc = await Scenario.findOne({ platform: req.params.platform });
    res.json(doc || { platform: req.params.platform, categories: [], totalActive: 0 });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

router.put('/scenarios/:platform', async (req, res) => {
  try {
    const { categories } = req.body;
    const totalActive = categories.reduce((sum, cat) =>
      sum + (cat.scenarios || []).filter(s => s.status !== 'deprecated').length, 0);

    const doc = await Scenario.findOneAndUpdate(
      { platform: req.params.platform },
      { categories, totalActive, updatedBy: req.user._id },
      { new: true, upsert: true }
    );

    await ActivityLog.create({
      action: 'scenario_update', user: req.user._id, userName: req.user.name,
      target: `${req.params.platform} scenarios`, details: { totalActive },
    });

    res.json(doc);
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// ── User Management ──────────────────────────────────────────────────────────
router.get('/users', async (req, res) => {
  try {
    const users = await User.find().select('-password').sort({ createdAt: -1 });
    res.json({ users });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

router.put('/users/:id', async (req, res) => {
  try {
    const { name, role } = req.body;
    const update = {};
    if (name) update.name = name;
    if (role) update.role = role;
    const user = await User.findByIdAndUpdate(req.params.id, update, { new: true }).select('-password');
    if (!user) return res.status(404).json({ error: 'User not found' });
    res.json({ user });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

router.delete('/users/:id', async (req, res) => {
  try {
    if (req.params.id === req.user._id.toString())
      return res.status(400).json({ error: 'Cannot delete yourself' });

    const user = await User.findByIdAndDelete(req.params.id);
    if (!user) return res.status(404).json({ error: 'User not found' });

    await ActivityLog.create({
      action: 'user_delete', user: req.user._id, userName: req.user.name,
      target: `${user.name} (${user.email})`,
    });

    res.json({ success: true });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// ── Activity Logs ────────────────────────────────────────────────────────────
router.get('/logs', async (req, res) => {
  try {
    const limit = parseInt(req.query.limit) || 100;
    const logs = await ActivityLog.find().sort({ createdAt: -1 }).limit(limit);
    res.json({ logs });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// ── Settings ─────────────────────────────────────────────────────────────────
router.get('/settings', async (req, res) => {
  try {
    const settings = await Setting.find();
    const obj = {};
    settings.forEach(s => { obj[s.key] = s.value; });
    res.json(obj);
  } catch (err) { res.status(500).json({ error: err.message }); }
});

router.put('/settings', async (req, res) => {
  try {
    const entries = Object.entries(req.body);
    for (const [key, value] of entries) {
      await Setting.findOneAndUpdate({ key }, { value, updatedBy: req.user._id }, { upsert: true });
    }
    await ActivityLog.create({
      action: 'settings_change', user: req.user._id, userName: req.user.name,
      target: 'System settings', details: req.body,
    });
    res.json({ success: true });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// ── Alerts ───────────────────────────────────────────────────────────────────
router.get('/alerts', async (req, res) => {
  try {
    const alerts = await Alert.find().sort({ createdAt: -1 });
    res.json({ alerts });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

router.post('/alerts', async (req, res) => {
  try {
    const alert = await Alert.create({ ...req.body, createdBy: req.user._id });
    res.status(201).json({ alert });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

router.put('/alerts/:id', async (req, res) => {
  try {
    const alert = await Alert.findByIdAndUpdate(req.params.id, req.body, { new: true });
    if (!alert) return res.status(404).json({ error: 'Alert not found' });
    res.json({ alert });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

router.delete('/alerts/:id', async (req, res) => {
  try {
    await Alert.findByIdAndDelete(req.params.id);
    res.json({ success: true });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

module.exports = router;
