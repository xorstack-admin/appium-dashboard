const express = require('express');
const { auth } = require('../middleware/auth');
const Report = require('../models/Report');
const Scenario = require('../models/Scenario');
const { categorize } = require('../services/parser');
const { compareVersions } = require('../services/comparisonService');
const { detectFlakyTests } = require('../services/flakyService');
const { generateInsights } = require('../services/insightsService');
const { rootCauseAnalysis } = require('../services/rootCauseService');

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

// ── Helper: extract clean scenarios from a report ────────────────────────────
function isInvalidName(name) {
  if (!name) return true;
  if (/^untitled$/i.test(name)) return true;
  if (/^test\s*#?\d+$/i.test(name)) return true;
  // Legacy fallback pattern: "<Something> - Test #N" (filter old junk data)
  if (/\s-\s*Test\s*#?\d+\s*$/i.test(name)) return true;
  return false;
}

function cleanScenarios(report) {
  const out = [];
  for (const run of report.scenarios || []) {
    for (const sub of run.subScenarios || []) {
      if (!sub.name) continue;
      const name = String(sub.name).trim();
      if (isInvalidName(name)) continue;
      // Prefer the stored category (set from source filename). Fall back to name-based categorize.
      const storedCategory = sub.category || sub.categoryName;
      const category = storedCategory && storedCategory !== 'Uncategorized'
        ? storedCategory
        : categorize(name);
      out.push({
        name,
        category,
        app: sub.app || '',
        validationSummary: sub.validationSummary || '',
        overall: sub.overall,
        duration: sub.duration != null ? sub.duration : (sub.totalSteps > 0 ? null : 0),
        failed: (sub.failed || []).map(f => ({ step: f.step, name: f.name, time: f.time })),
      });
    }
  }
  return out;
}

// ── Overview — average pass rate across all versions for each combo ─────────
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

        // Compute average pass rate across ALL versions (weighted by total scenarios)
        const allReports = await Report.find({ env, platform })
          .select('passRate totalPassed totalFailed totalScenarios');
        let sumPassed = 0, sumFailed = 0, sumTotal = 0;
        for (const r of allReports) {
          sumPassed += r.totalPassed || 0;
          sumFailed += r.totalFailed || 0;
          sumTotal += r.totalScenarios || 0;
        }
        const avgPassRate = sumTotal > 0
          ? parseFloat(((sumPassed / sumTotal) * 100).toFixed(1))
          : null;

        result[env][platform] = {
          version: latest.version, label: latest.label,
          savedAt: latest.createdAt, runDate: latest.runDate,
          passRate: avgPassRate, passed: sumPassed,
          failed: sumFailed, totalReports,
        };
      }
    }
    res.json(result);
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// ── Versions list ────────────────────────────────────────────────────────────
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

// ── Clean report (for user dashboard table) ──────────────────────────────────
router.get('/:env/:platform/report/:version', validateEP, async (req, res) => {
  try {
    const { env, platform, version } = req.params;
    const report = await Report.findOne({ env, platform, version });
    if (!report) return res.status(404).json({ error: `Version "${version}" not found` });

    const scenarios = cleanScenarios(report);

    // Group by category for chart
    const byCategory = {};
    for (const s of scenarios) {
      const c = s.category || 'Uncategorized';
      if (!byCategory[c]) byCategory[c] = { category: c, total: 0, passed: 0, failed: 0 };
      byCategory[c].total++;
      if (s.overall === 'Passed') byCategory[c].passed++; else byCategory[c].failed++;
    }
    const categories = Object.values(byCategory).map(c => ({
      ...c,
      passRate: c.total > 0 ? parseFloat(((c.passed / c.total) * 100).toFixed(1)) : 0,
    })).sort((a, b) => b.total - a.total);

    const total = scenarios.length;
    const passed = scenarios.filter(s => s.overall === 'Passed').length;
    const failed = scenarios.filter(s => s.overall === 'Failed').length;
    const durations = scenarios.map(s => s.duration).filter(d => typeof d === 'number');
    const avgDuration = durations.length > 0 ? parseFloat((durations.reduce((a, b) => a + b, 0) / durations.length).toFixed(2)) : 0;

    res.json({
      scenarios,
      categories,
      stats: {
        total, passed, failed,
        passRate: total > 0 ? parseFloat(((passed / total) * 100).toFixed(1)) : 0,
        avgDuration,
      },
      meta: {
        version: report.version,
        label: report.label,
        notes: report.notes || '',
        runDate: report.runDate,
        savedAt: report.createdAt,
      },
      files: report.files || [],
    });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// ── Scenarios master list ────────────────────────────────────────────────────
router.get('/:env/:platform/scenarios', validateEP, async (req, res) => {
  try {
    const doc = await Scenario.findOne({ platform: req.params.platform });
    res.json(doc || { platform: req.params.platform, categories: [], totalActive: 0 });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// ── Daily trend (kept for compat) ────────────────────────────────────────────
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
      .select('version label createdAt runDate passRate totalPassed totalFailed totalScenarios')
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
      const progression = builds.map(b => ({ version: b.version, savedAt: b.createdAt, passRate: b.passRate }));
      days.push({
        date, buildCount: builds.length,
        firstVersion: builds[0].version, lastVersion: last.version,
        endOfDay: {
          passed: last.totalPassed, failed: last.totalFailed,
          total: last.totalScenarios, passRate: last.passRate || 0,
        },
        progression,
      });
    }
    days.sort((a, b) => b.date.localeCompare(a.date));
    res.json({ days, total: days.length });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// ── Analytics endpoint — supports optional env/platform/version filters ─────
router.get('/analytics', async (req, res) => {
  try {
    const { env, platform, version } = req.query;
    const filter = {};
    if (env && VALID_ENVS.includes(env)) filter.env = env;
    if (platform && VALID_PLATFORMS.includes(platform)) filter.platform = platform;

    const reports = await Report.find(filter)
      .select('env platform version label passRate totalPassed totalFailed totalScenarios createdAt runDate scenarios')
      .sort({ createdAt: -1 })
      .limit(100);

    // Find index of current version in the list (if specified)
    let currentIdx = -1;
    if (version) {
      currentIdx = reports.findIndex(r => r.version === version);
    }

    // KPIs
    const totalReports = reports.length;
    const totalTests = reports.reduce((a, r) => a + (r.totalScenarios || 0), 0);
    const totalPassed = reports.reduce((a, r) => a + (r.totalPassed || 0), 0);
    const totalFailed = reports.reduce((a, r) => a + (r.totalFailed || 0), 0);
    const passRate = totalTests > 0 ? parseFloat(((totalPassed / totalTests) * 100).toFixed(1)) : 0;

    // Avg duration across all scenarios
    let durationSum = 0, durationCount = 0;
    for (const r of reports) {
      for (const run of r.scenarios || []) {
        for (const sub of run.subScenarios || []) {
          if (typeof sub.duration === 'number') { durationSum += sub.duration; durationCount++; }
        }
      }
    }
    const avgDuration = durationCount > 0 ? parseFloat((durationSum / durationCount).toFixed(2)) : 0;

    // Pass rate trend over versions (line chart — latest 20)
    const trend = reports.slice(0, 20).reverse().map(r => ({
      version: r.version,
      env: r.env,
      platform: r.platform,
      passRate: r.passRate || 0,
      savedAt: r.createdAt,
    }));

    // iOS vs Android (bar chart)
    const platformStats = { ios: { passed: 0, failed: 0, total: 0 }, android: { passed: 0, failed: 0, total: 0 } };
    for (const r of reports) {
      const p = platformStats[r.platform];
      if (!p) continue;
      p.passed += r.totalPassed || 0;
      p.failed += r.totalFailed || 0;
      p.total += r.totalScenarios || 0;
    }
    for (const k of Object.keys(platformStats)) {
      const p = platformStats[k];
      p.passRate = p.total > 0 ? parseFloat(((p.passed / p.total) * 100).toFixed(1)) : 0;
    }

    // Staging vs Production (bar chart)
    const envStats = { staging: { passed: 0, failed: 0, total: 0 }, production: { passed: 0, failed: 0, total: 0 } };
    for (const r of reports) {
      const e = envStats[r.env];
      if (!e) continue;
      e.passed += r.totalPassed || 0;
      e.failed += r.totalFailed || 0;
      e.total += r.totalScenarios || 0;
    }
    for (const k of Object.keys(envStats)) {
      const e = envStats[k];
      e.passRate = e.total > 0 ? parseFloat(((e.passed / e.total) * 100).toFixed(1)) : 0;
    }

    // ── Insights — scoped to the selected version (or latest if none) ─────────
    // Use: current report vs previous report to compute "changed" insights
    const insightReports = currentIdx >= 0
      ? reports.slice(currentIdx, currentIdx + 1) // just the current
      : reports.slice(0, 1); // just the latest

    const currentReport = insightReports[0];
    const previousReport = currentIdx >= 0 && currentIdx + 1 < reports.length
      ? reports[currentIdx + 1]
      : (reports.length > 1 ? reports[1] : null);

    // Category failures for just this version
    const categoryFailures = {};
    if (currentReport) {
      for (const run of currentReport.scenarios || []) {
        for (const sub of run.subScenarios || []) {
          const cat = sub.category || sub.categoryName || 'Uncategorized';
          if (!categoryFailures[cat]) categoryFailures[cat] = { total: 0, failed: 0 };
          categoryFailures[cat].total++;
          if (sub.overall === 'Failed') categoryFailures[cat].failed++;
        }
      }
    }
    const categoriesArr = Object.entries(categoryFailures).map(([name, v]) => ({
      name,
      total: v.total,
      failed: v.failed,
      failRate: v.total > 0 ? parseFloat(((v.failed / v.total) * 100).toFixed(1)) : 0,
    })).sort((a, b) => b.failRate - a.failRate);

    const insights = [];
    const verLabel = currentReport?.version || 'this version';

    // Insight 1: compare with previous version
    if (currentReport && previousReport) {
      const prev = previousReport.passRate || 0;
      const curr = currentReport.passRate || 0;
      const diff = parseFloat((curr - prev).toFixed(1));
      if (diff < 0) {
        insights.push({ type: 'warning', text: `Pass rate dropped by ${Math.abs(diff)}% in ${verLabel} (vs ${previousReport.version})` });
      } else if (diff > 0) {
        insights.push({ type: 'good', text: `Pass rate improved by ${diff}% in ${verLabel} (vs ${previousReport.version})` });
      } else {
        insights.push({ type: 'info', text: `Pass rate unchanged from ${previousReport.version}` });
      }
    }

    // Insight 2: top failing category in this version
    if (categoriesArr.length > 0 && categoriesArr[0].failRate > 30) {
      insights.push({ type: 'warning', text: `Most failing category in ${verLabel}: ${categoriesArr[0].name} (${categoriesArr[0].failRate}% fail rate)` });
    }

    // Insight 3: absolute fail count if high
    if (currentReport && currentReport.totalFailed > 0) {
      const failRate = currentReport.passRate != null ? (100 - currentReport.passRate).toFixed(1) : '';
      if (currentReport.totalFailed >= 100) {
        insights.push({ type: 'warning', text: `${currentReport.totalFailed} scenarios failed in ${verLabel} (${failRate}%)` });
      }
    }

    // Insight 4: all passed
    if (currentReport && currentReport.totalFailed === 0 && currentReport.totalScenarios > 0) {
      insights.push({ type: 'good', text: `All ${currentReport.totalScenarios} scenarios passed in ${verLabel}` });
    }

    // Insight 5: iOS vs Android (only meaningful when not filtered by platform)
    if (!platform && platformStats.ios.total > 0 && platformStats.android.total > 0) {
      if (platformStats.ios.passRate > platformStats.android.passRate + 5) {
        insights.push({ type: 'info', text: `iOS more stable than Android (${platformStats.ios.passRate}% vs ${platformStats.android.passRate}%)` });
      } else if (platformStats.android.passRate > platformStats.ios.passRate + 5) {
        insights.push({ type: 'info', text: `Android more stable than iOS (${platformStats.android.passRate}% vs ${platformStats.ios.passRate}%)` });
      }
    }

    if (insights.length === 0) {
      insights.push({ type: 'info', text: `No significant issues in ${verLabel}. System is stable.` });
    }

    res.json({
      kpi: { passRate, totalTests, passed: totalPassed, failed: totalFailed, avgDuration, totalReports },
      trend,
      platformStats,
      envStats,
      categoryFailures: categoriesArr.slice(0, 10),
      insights,
    });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// ── Phase 2: Compare two versions ────────────────────────────────────────────
router.get('/compare', async (req, res) => {
  try {
    const { env, platform, v1, v2 } = req.query;
    if (!env || !platform || !v1 || !v2) {
      return res.status(400).json({ error: 'env, platform, v1, v2 are required' });
    }
    if (!VALID_ENVS.includes(env) || !VALID_PLATFORMS.includes(platform)) {
      return res.status(400).json({ error: 'Invalid env or platform' });
    }
    const result = await compareVersions(env, platform, v1, v2);
    res.json(result);
  } catch (err) {
    res.status(err.message?.includes('not found') ? 404 : 500).json({ error: err.message });
  }
});

// ── Phase 2: Export comparison as CSV ────────────────────────────────────────
router.get('/compare/export', async (req, res) => {
  try {
    const { env, platform, v1, v2 } = req.query;
    if (!env || !platform || !v1 || !v2) return res.status(400).json({ error: 'env, platform, v1, v2 are required' });
    const result = await compareVersions(env, platform, v1, v2);
    const headers = ['Scenario', 'Category', `${v1} Status`, `${v2} Status`, 'Change Type', `${v1} Failure`, `${v2} Failure`, 'Same Failure'];
    const rows = result.details.map(r => [
      r.name, r.category, r.v1Status || '-', r.v2Status || '-', r.changeType,
      (r.v1Failure || '').replace(/\n/g, ' ').slice(0, 200),
      (r.v2Failure || '').replace(/\n/g, ' ').slice(0, 200),
      r.sameFailure ? 'Yes' : 'No',
    ]);
    const csv = [headers, ...rows].map(row => row.map(c => `"${String(c).replace(/"/g, '""')}"`).join(',')).join('\r\n');
    res.setHeader('Content-Type', 'text/csv');
    res.setHeader('Content-Disposition', `attachment; filename="comparison-${env}-${platform}-${v1}-vs-${v2}.csv"`);
    res.send(csv);
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// ── Phase 2: Flaky test detection ────────────────────────────────────────────
router.get('/flaky', async (req, res) => {
  try {
    const { env, platform } = req.query;
    if (!env || !platform) return res.status(400).json({ error: 'env and platform are required' });
    if (!VALID_ENVS.includes(env) || !VALID_PLATFORMS.includes(platform)) {
      return res.status(400).json({ error: 'Invalid env or platform' });
    }
    const result = await detectFlakyTests(env, platform);
    res.json(result);
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// ── Phase 2: Smart insights (uses generateInsights service) ──────────────────
router.get('/insights', async (req, res) => {
  try {
    const { env, platform, version } = req.query;
    const filter = {};
    if (env && VALID_ENVS.includes(env)) filter.env = env;
    if (platform && VALID_PLATFORMS.includes(platform)) filter.platform = platform;

    const reports = await Report.find(filter).sort({ createdAt: -1 }).limit(20);
    if (!reports.length) return res.json({ insights: [{ type: 'info', message: 'No reports yet to analyze.' }] });

    let currentReport = reports[0];
    let previousReport = reports[1] || null;
    if (version) {
      const idx = reports.findIndex(r => r.version === version);
      if (idx >= 0) {
        currentReport = reports[idx];
        previousReport = reports[idx + 1] || null;
      }
    }

    // Optional: cross-platform stats for platform comparison rule
    let platformStats = null;
    if (env && !platform) {
      const all = await Report.find({ env });
      const stats = { ios: { passed: 0, failed: 0, total: 0 }, android: { passed: 0, failed: 0, total: 0 } };
      for (const r of all) {
        const p = stats[r.platform];
        if (!p) continue;
        p.passed += r.totalPassed || 0;
        p.failed += r.totalFailed || 0;
        p.total += r.totalScenarios || 0;
      }
      for (const k of Object.keys(stats)) {
        const x = stats[k];
        x.passRate = x.total > 0 ? parseFloat(((x.passed / x.total) * 100).toFixed(1)) : 0;
      }
      platformStats = stats;
    }

    // Optional: flaky data
    let flakyData = null;
    if (env && platform) {
      try { flakyData = await detectFlakyTests(env, platform); } catch (_) {}
    }

    const insights = generateInsights({ currentReport, previousReport, platformStats, flakyData });
    res.json({ insights, currentVersion: currentReport.version, previousVersion: previousReport?.version || null });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// ── Phase 3 Tier 1: Root Cause Analytics ────────────────────────────────────
router.get('/root-cause', async (req, res) => {
  try {
    const { env, platform, version } = req.query;
    if (!env || !platform || !version) return res.status(400).json({ error: 'env, platform, and version are required' });
    if (!VALID_ENVS.includes(env) || !VALID_PLATFORMS.includes(platform)) {
      return res.status(400).json({ error: 'Invalid env or platform' });
    }
    const result = await rootCauseAnalysis(env, platform, version);
    res.json(result);
  } catch (err) {
    res.status(err.message?.includes('not found') ? 404 : 500).json({ error: err.message });
  }
});

module.exports = router;
