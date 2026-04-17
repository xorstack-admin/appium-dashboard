const express = require('express');
const { auth } = require('../middleware/auth');
const Report = require('../models/Report');
const Scenario = require('../models/Scenario');

const router = express.Router();

router.use(auth);

const VALID_ENVS = ['staging', 'production'];
const VALID_PLATFORMS = ['ios', 'android'];

function validateEP(req, res, next) {
  const { env, platform } = req.params;
  if (!VALID_ENVS.includes(env)) return res.status(400).json({ error: `Invalid env "${env}"` });
  if (!VALID_PLATFORMS.includes(platform)) return res.status(400).json({ error: `Invalid platform "${platform}"` });
  next();
}

// Overview — latest pass rate for all 4 combos
router.get('/overview', async (req, res) => {
  try {
    const result = {};
    for (const env of VALID_ENVS) {
      result[env] = {};
      for (const platform of VALID_PLATFORMS) {
        const latest = await Report.findOne({ env, platform })
          .select('version label passRate totalPassed totalFailed totalScenarios createdAt runDate')
          .sort({ createdAt: -1 });
        const totalReports = await Report.countDocuments({ env, platform });
        if (!latest) { result[env][platform] = null; continue; }
        result[env][platform] = {
          version: latest.version, label: latest.label,
          savedAt: latest.createdAt, runDate: latest.runDate,
          passRate: latest.passRate, passed: latest.totalPassed,
          failed: latest.totalFailed, totalReports,
        };
      }
    }
    res.json(result);
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// Versions list
router.get('/:env/:platform/versions', validateEP, async (req, res) => {
  try {
    const { env, platform } = req.params;
    const reports = await Report.find({ env, platform })
      .select('version label notes createdAt runDate passRate totalPassed totalFailed totalScenarios')
      .sort({ createdAt: -1 });
    const versions = reports.map(r => ({
      version: r.version, label: r.label, notes: r.notes || '', savedAt: r.createdAt,
      runDate: r.runDate, passRate: r.passRate,
      passed: r.totalPassed, failed: r.totalFailed,
    }));
    res.json({ versions });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// Full report
router.get('/:env/:platform/report/:version', validateEP, async (req, res) => {
  try {
    const { env, platform, version } = req.params;
    const report = await Report.findOne({ env, platform, version });
    if (!report) return res.status(404).json({ error: `Version "${version}" not found` });

    const scenarioDoc = await Scenario.findOne({ platform });
    const byCategory = rollupByCategory(
      report.scenarios.flatMap(r => r.subScenarios || []),
      scenarioDoc || { categories: [] }
    );

    res.json({ report: report.scenarios, byCategory, files: report.files });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// Scenarios master list
router.get('/:env/:platform/scenarios', validateEP, async (req, res) => {
  try {
    const doc = await Scenario.findOne({ platform: req.params.platform });
    res.json(doc || { platform: req.params.platform, categories: [], totalActive: 0 });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// Daily trend
router.get('/:env/:platform/daily', validateEP, async (req, res) => {
  try {
    const { env, platform } = req.params;
    const { from, to } = req.query;
    const filter = { env, platform };
    if (from || to) {
      filter.runDate = {};
      if (from) filter.runDate.$gte = new Date(from);
      if (to) filter.runDate.$lte = new Date(to + 'T23:59:59Z');
    }

    const reports = await Report.find(filter)
      .select('version label createdAt runDate passRate totalPassed totalFailed totalScenarios scenarios')
      .sort({ createdAt: 1 });

    const byDate = new Map();
    for (const r of reports) {
      const dateKey = r.runDate ? r.runDate.toISOString().slice(0, 10) : r.createdAt.toISOString().slice(0, 10);
      if (!byDate.has(dateKey)) byDate.set(dateKey, []);
      byDate.get(dateKey).push(r);
    }

    const days = [];
    for (const [date, builds] of byDate) {
      const last = builds[builds.length - 1];
      const allSubs = last.scenarios.flatMap(r => r.subScenarios || []);
      const p = allSubs.filter(s => s.overall === 'Passed').length;
      const f = allSubs.filter(s => s.overall === 'Failed').length;
      const t = allSubs.length;

      const progression = builds.map(b => ({
        version: b.version, savedAt: b.createdAt,
        passRate: b.passRate,
      }));

      const first = progression[0]?.passRate ?? null;
      const lastRate = progression[progression.length - 1]?.passRate ?? null;

      days.push({
        date, buildCount: builds.length,
        firstVersion: builds[0].version, lastVersion: last.version,
        improvement: (first !== null && lastRate !== null) ? parseFloat((lastRate - first).toFixed(1)) : null,
        endOfDay: { passed: p, failed: f, total: t, passRate: t > 0 ? parseFloat(((p / t) * 100).toFixed(1)) : 0 },
        progression,
      });
    }
    days.sort((a, b) => b.date.localeCompare(a.date));
    res.json({ days, total: days.length });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

function rollupByCategory(subs, master) {
  const map = new Map();
  for (const cat of master.categories || []) {
    map.set(cat.id, { categoryId: cat.id, categoryName: cat.name,
      masterTotal: (cat.scenarios || []).length, run: 0, passed: 0, failed: 0, notRun: 0, passRate: null, subScenarios: [] });
  }
  map.set(0, { categoryId: 0, categoryName: 'Uncategorized', masterTotal: 0, run: 0, passed: 0, failed: 0, notRun: 0, passRate: null, subScenarios: [] });

  for (const sub of subs) {
    const cid = sub.categoryId || 0;
    if (!map.has(cid)) map.set(cid, { categoryId: cid, categoryName: sub.categoryName || 'Uncategorized', masterTotal: 0, run: 0, passed: 0, failed: 0, notRun: 0, passRate: null, subScenarios: [] });
    const e = map.get(cid);
    e.run++;
    e.subScenarios.push(sub);
    if (sub.overall === 'Passed') e.passed++; else e.failed++;
  }

  for (const cat of master.categories || []) {
    const e = map.get(cat.id);
    if (e) {
      e.notRun = Math.max(0, e.masterTotal - e.run);
      e.passRate = e.run > 0 ? parseFloat(((e.passed / e.run) * 100).toFixed(1)) : null;
    }
  }
  if (map.get(0)?.run === 0) map.delete(0);
  return [...map.values()];
}

module.exports = router;
