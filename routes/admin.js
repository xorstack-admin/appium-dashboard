const express = require('express');
const { auth, adminOnly } = require('../middleware/auth');
const upload = require('../middleware/upload');
const Report = require('../models/Report');
const Scenario = require('../models/Scenario');
const User = require('../models/User');
const ActivityLog = require('../models/ActivityLog');
const Setting = require('../models/Setting');
const Alert = require('../models/Alert');
const { parseHTML, parseXML } = require('../services/parser');
const AdmZip = require('adm-zip');
const { uploadBuffer, deleteFile } = require('../services/cloudinaryService');
const { checkAlerts } = require('../services/alertService');

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
router.post('/upload', upload.array('files', 20), async (req, res) => {
  try {
    const { env, platform, version, label, notes } = req.body;
    if (!env || !platform || !version)
      return res.status(400).json({ error: 'env, platform, and version are required' });

    const existing = await Report.findOne({ env, platform, version });
    if (existing)
      return res.status(409).json({ error: `Report ${env}/${platform}/${version} already exists` });

    const rawFiles = req.files || [];

    // Extract zip files into individual files
    const files = [];
    for (const file of rawFiles) {
      if (file.originalname.toLowerCase().endsWith('.zip')) {
        try {
          const zip = new AdmZip(file.buffer);
          const entries = zip.getEntries();
          for (const entry of entries) {
            if (entry.isDirectory) continue;
            const name = entry.entryName.split('/').pop(); // get filename only
            if (!name || name.startsWith('.')) continue; // skip hidden files
            files.push({
              originalname: name,
              buffer: entry.getData(),
              size: entry.header.size,
              mimetype: 'application/octet-stream',
            });
          }
        } catch (zipErr) {
          return res.status(400).json({ error: `Failed to extract zip "${file.originalname}": ${zipErr.message}` });
        }
      } else {
        files.push(file);
      }
    }

    const htmlFiles = files.filter(f => /\.(html|htm)$/i.test(f.originalname));
    const xmlFiles = files.filter(f => /\.xml$/i.test(f.originalname));
    const jsonFiles = files.filter(f => /\.json$/i.test(f.originalname));

    // Parse HTML reports
    const scenarioRuns = [];
    for (const file of htmlFiles) {
      try {
        const content = file.buffer.toString('utf-8');
        scenarioRuns.push(parseHTML(content, file.originalname));
      } catch (parseErr) {
        console.error(`Warning: failed to parse ${file.originalname}:`, parseErr.message);
      }
    }

    // Parse XML files (Appium test definitions — extracts scenario names only)
    for (const file of xmlFiles) {
      try {
        const content = file.buffer.toString('utf-8');
        const parsed = parseXML(content, file.originalname);
        if (parsed.subScenarios && parsed.subScenarios.length > 0) {
          scenarioRuns.push(parsed);
        }
      } catch (xmlErr) {
        console.error(`Warning: failed to parse ${file.originalname}:`, xmlErr.message);
      }
    }

    // Parse JSON reports — handles multiple formats
    for (const file of jsonFiles) {
      try {
        const raw = JSON.parse(file.buffer.toString('utf-8'));
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
              scenario: item.name || file.originalname.replace(/\.json$/i, ''),
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
              scenario: file.originalname.replace(/\.json$/i, ''),
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
        console.error(`Warning: failed to parse ${file.originalname}:`, jsonErr.message);
      }
    }

    // Upload all files to Cloudinary (each wrapped in try/catch)
    const fileRefs = [];
    for (const file of files) {
      try {
        const isImage = /\.(png|jpg|jpeg|gif|webp)$/i.test(file.originalname);
        const result = await uploadBuffer(file.buffer, {
          folder: `vya-reports/${env}/${platform}/${version}`,
          resourceType: isImage ? 'image' : 'raw',
          publicId: file.originalname.replace(/\.[^.]+$/, ''),
        });
        fileRefs.push({
          type: isImage ? 'screenshot' : file.originalname.match(/\.(xml|json)$/i) ? 'attachment' : 'raw_report',
          url: result.url,
          publicId: result.publicId,
          originalName: file.originalname,
          size: result.size,
        });
      } catch (uploadErr) {
        console.error(`Warning: failed to upload ${file.originalname} to Cloudinary:`, uploadErr.message);
        // Still track the file even if Cloudinary fails
        fileRefs.push({
          type: /\.(png|jpg|jpeg|gif|webp)$/i.test(file.originalname) ? 'screenshot' : 'raw_report',
          url: null,
          publicId: null,
          originalName: file.originalname,
          size: file.size || file.buffer?.length || 0,
        });
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
      env, platform, version,
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
      target: `${env}/${platform}/${version}`,
      details: { passRate, totalPassed, totalFailed, totalScenarios },
    });

    // Emit real-time update + check alerts
    const io = req.app.get('io');
    if (io) io.emit('new-report', { id: report._id, env, platform, version, passRate, label: report.label });
    await checkAlerts(report, io);

    res.status(201).json({ report });
  } catch (err) {
    res.status(500).json({ error: err.message });
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
      target: `${report.env}/${report.platform}/${report.version}`,
    });

    res.json({ report });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

router.delete('/reports/:id', async (req, res) => {
  try {
    const report = await Report.findById(req.params.id);
    if (!report) return res.status(404).json({ error: 'Report not found' });

    // Delete Cloudinary files
    for (const file of report.files || []) {
      const resourceType = file.type === 'screenshot' ? 'image' : 'raw';
      await deleteFile(file.publicId, resourceType).catch(() => {});
    }

    await Report.findByIdAndDelete(req.params.id);

    await ActivityLog.create({
      action: 'delete', user: req.user._id, userName: req.user.name,
      target: `${report.env}/${report.platform}/${report.version}`,
    });

    const io = req.app.get('io');
    if (io) io.emit('report-deleted', { id: report._id, env: report.env, platform: report.platform, version: report.version });

    res.json({ success: true });
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
