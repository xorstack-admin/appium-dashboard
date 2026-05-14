/**
 * comparisonService.js — Version Comparison Engine (Premium)
 * Compares two reports scenario-by-scenario and produces a rich diff:
 * verdict, health scores, category heatmap, stability scores, etc.
 */

const Report = require('../models/Report');
const { audienceMatch } = require('./audienceFilter');

function flattenScenarios(report) {
  const out = [];
  for (const run of report.scenarios || []) {
    for (const sub of run.subScenarios || []) {
      if (!sub.name) continue;
      const name = String(sub.name).trim();
      if (!name) continue;
      out.push({
        name,
        category: sub.category || sub.categoryName || 'Uncategorized',
        status: sub.overall,
        duration: sub.duration || 0,
        failed: sub.failed || [],
      });
    }
  }
  return out;
}

// Health Score (0-100): weighted blend of pass rate, low failure count, recent stability
function calcHealthScore(report) {
  if (!report || !report.totalScenarios) return 0;
  const passRate = report.passRate || 0;
  const failBurden = report.totalFailed > 0
    ? Math.max(0, 100 - Math.min(100, (report.totalFailed / report.totalScenarios) * 100))
    : 100;
  // 70% weight to pass rate, 30% weight to fail burden
  return Math.round(passRate * 0.7 + failBurden * 0.3);
}

// Determine verdict from change counts
function buildVerdict(s) {
  const noRegressions = s.regressed === 0;
  const someImprovements = s.improved > 0;
  const passRateUp = s.passRateDiff > 0;
  const passRateDown = s.passRateDiff < 0;

  if (s.regressed >= 5 || s.passRateDiff <= -10) {
    return {
      level: 'critical',
      title: 'Critical Regressions',
      message: `${s.regressed} test${s.regressed !== 1 ? 's' : ''} regressed${someImprovements ? `, ${s.improved} fix${s.improved !== 1 ? 'es' : ''}` : ''} — review before shipping`,
      action: 'NEEDS REVIEW',
    };
  }
  if (noRegressions && someImprovements && passRateUp) {
    return {
      level: 'good',
      title: 'Ready to Ship',
      message: `${s.improved} fix${s.improved !== 1 ? 'es' : ''}, 0 regressions${s.passRateDiff > 0 ? `, +${s.passRateDiff}% pass rate` : ''}`,
      action: 'READY',
    };
  }
  if (s.regressed > 0 && s.improved > 0) {
    return {
      level: 'mixed',
      title: 'Mixed Results',
      message: `${s.improved} fix${s.improved !== 1 ? 'es' : ''}, ${s.regressed} regression${s.regressed !== 1 ? 's' : ''} — review needed`,
      action: 'REVIEW',
    };
  }
  if (s.regressed > 0 || passRateDown) {
    return {
      level: 'warning',
      title: 'Quality Decline',
      message: `${s.regressed} regression${s.regressed !== 1 ? 's' : ''}${s.passRateDiff < 0 ? `, ${s.passRateDiff}% pass rate` : ''}`,
      action: 'REVIEW',
    };
  }
  return {
    level: 'stable',
    title: 'Stable',
    message: `No significant changes between versions`,
    action: 'OK',
  };
}

// Compute stability score per scenario across recent history (0-100)
async function computeStabilityMap(env, platform, opts = {}, limit = 15) {
  const filter = { env, platform };
  if (opts.audience) filter.audience = audienceMatch(opts.audience);
  const reports = await Report.find(filter)
    .select('version scenarios createdAt')
    .sort({ createdAt: -1 })
    .limit(limit);

  const statsMap = new Map(); // name -> { passed, failed, runs }
  for (const r of reports) {
    for (const run of r.scenarios || []) {
      for (const sub of run.subScenarios || []) {
        if (!sub.name) continue;
        const name = String(sub.name).trim();
        if (!statsMap.has(name)) statsMap.set(name, { passed: 0, failed: 0, runs: 0 });
        const s = statsMap.get(name);
        s.runs++;
        if (sub.overall === 'Passed') s.passed++; else s.failed++;
      }
    }
  }

  const stability = new Map(); // name -> { score, runs }
  for (const [name, s] of statsMap) {
    if (s.runs === 0) continue;
    // Stability = 100 if always passed, lower if mix, 0 if always failed
    // More runs = higher confidence
    const passRate = s.passed / s.runs;
    const confidence = Math.min(1, s.runs / 5);
    const score = Math.round(passRate * 100 * confidence + (1 - confidence) * 50);
    stability.set(name, { score, runs: s.runs, passed: s.passed, failed: s.failed });
  }
  return stability;
}

async function compareVersions(env, platform, v1, v2, opts = {}) {
  // v1 / v2 may be consumer labels (`version`) OR business labels (`businessVersion`).
  const f1 = { env, platform, $or: [{ version: v1 }, { businessVersion: v1 }] };
  const f2 = { env, platform, $or: [{ version: v2 }, { businessVersion: v2 }] };
  if (opts.audience) { const m = audienceMatch(opts.audience); f1.audience = m; f2.audience = m; }
  const [report1, report2, stabilityMap] = await Promise.all([
    Report.findOne(f1).sort({ createdAt: -1 }),
    Report.findOne(f2).sort({ createdAt: -1 }),
    computeStabilityMap(env, platform, opts),
  ]);

  if (!report1 || !report2) {
    throw new Error(`One or both versions not found: ${v1}, ${v2}`);
  }

  const scenarios1 = flattenScenarios(report1);
  const scenarios2 = flattenScenarios(report2);

  const map1 = new Map();
  for (const s of scenarios1) map1.set(s.name, s);
  const map2 = new Map();
  for (const s of scenarios2) map2.set(s.name, s);

  const allNames = new Set([...map1.keys(), ...map2.keys()]);

  const details = [];
  let improved = 0, regressed = 0, stable = 0, stillFailing = 0, newTests = 0, removedTests = 0;
  // Category breakdown for heatmap
  const categoryDiff = {};

  for (const name of allNames) {
    const s1 = map1.get(name);
    const s2 = map2.get(name);
    let changeType, v1Status, v2Status;
    let v1Failure = '', v2Failure = '';

    if (!s1) {
      changeType = 'new';
      v1Status = null; v2Status = s2.status;
      v2Failure = s2.failed?.[0]?.name || '';
      newTests++;
    } else if (!s2) {
      changeType = 'removed';
      v1Status = s1.status; v2Status = null;
      v1Failure = s1.failed?.[0]?.name || '';
      removedTests++;
    } else {
      v1Status = s1.status; v2Status = s2.status;
      v1Failure = s1.failed?.[0]?.name || '';
      v2Failure = s2.failed?.[0]?.name || '';
      if (s1.status === 'Passed' && s2.status === 'Passed') { changeType = 'stable'; stable++; }
      else if (s1.status === 'Failed' && s2.status === 'Passed') { changeType = 'improved'; improved++; }
      else if (s1.status === 'Passed' && s2.status === 'Failed') { changeType = 'regressed'; regressed++; }
      else { changeType = 'stillFailing'; stillFailing++; }
    }

    const category = (s2 || s1).category;
    if (!categoryDiff[category]) categoryDiff[category] = { improved: 0, regressed: 0, stable: 0, stillFailing: 0, new: 0, removed: 0, total: 0 };
    categoryDiff[category][changeType]++;
    categoryDiff[category].total++;

    // Detect "same failure" vs "new failure"
    const sameFailure = v1Failure && v2Failure && v1Failure.trim() === v2Failure.trim();

    const stab = stabilityMap.get(name);
    details.push({
      name,
      category,
      v1Status,
      v2Status,
      changeType,
      v1Failure,
      v2Failure,
      sameFailure,
      durationDiff: s2 && s1 ? parseFloat(((s2.duration || 0) - (s1.duration || 0)).toFixed(2)) : null,
      stability: stab ? stab.score : null,
      stabilityRuns: stab ? stab.runs : 0,
    });
  }

  const order = { regressed: 1, stillFailing: 2, improved: 3, new: 4, removed: 5, stable: 6 };
  details.sort((a, b) => (order[a.changeType] || 99) - (order[b.changeType] || 99));

  const passRateDiff = parseFloat(((report2.passRate || 0) - (report1.passRate || 0)).toFixed(1));

  const summary = {
    totalCompared: stable + improved + regressed + stillFailing,
    improved, regressed, stable, stillFailing, newTests, removedTests,
    passRateDiff,
    v1: {
      version: v1, label: report1.label, notes: report1.notes || '', savedAt: report1.createdAt,
      passRate: report1.passRate, total: report1.totalScenarios,
      passed: report1.totalPassed, failed: report1.totalFailed,
      healthScore: calcHealthScore(report1),
    },
    v2: {
      version: v2, label: report2.label, notes: report2.notes || '', savedAt: report2.createdAt,
      passRate: report2.passRate, total: report2.totalScenarios,
      passed: report2.totalPassed, failed: report2.totalFailed,
      healthScore: calcHealthScore(report2),
    },
  };
  summary.healthScoreDiff = summary.v2.healthScore - summary.v1.healthScore;
  summary.verdict = buildVerdict(summary);

  // Category breakdown sorted by most "regressed"
  const categoryArr = Object.entries(categoryDiff).map(([name, v]) => ({ name, ...v }));
  categoryArr.sort((a, b) => b.regressed - a.regressed || b.total - a.total);

  return { summary, details, categoryBreakdown: categoryArr };
}

module.exports = { compareVersions };
