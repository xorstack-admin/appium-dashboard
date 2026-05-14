/**
 * forensicsService.js — Tier 6 Failure Forensics
 *
 * 21. Failure Fingerprinting — unique hash for (scenario + step + error signature)
 * 22. Time-to-Resolution — for each still-failing test, track how long it's been broken
 * 23. Drill-Down Step Analysis — full historical view of a single scenario
 * 24. Diff Viewer — word-level diff between error messages across versions
 */

const crypto = require('crypto');
const Report = require('../models/Report');
const { audienceMatch } = require('./audienceFilter');

// ── Shared helpers ───────────────────────────────────────────────────────────
function flatten(report) {
  const out = [];
  for (const run of report.scenarios || []) {
    for (const sub of run.subScenarios || []) {
      if (!sub.name) continue;
      const name = String(sub.name).trim();
      if (!name) continue;
      out.push({
        name,
        category: sub.category || sub.categoryName || 'Uncategorized',
        overall: sub.overall,
        duration: sub.duration || 0,
        failed: sub.failed || [],
      });
    }
  }
  return out;
}

function normalize(msg) {
  if (!msg) return '';
  return String(msg).toLowerCase()
    .replace(/<[^>]*>/g, ' ')
    .replace(/'[^']{0,200}'/g, '')
    .replace(/"[^"]{0,200}"/g, '')
    .replace(/[€$£¥]\s*[\d.,]+/g, '')
    .replace(/[-+]?\d+\.\d+/g, '')
    .replace(/\b\d{2,}\b/g, '')
    .replace(/[^a-z0-9\s]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

function fingerprint(scenarioName, stepNum, errorMsg) {
  const norm = normalize(errorMsg);
  const key = `${(scenarioName || '').trim().toLowerCase()}|step:${stepNum || 0}|${norm}`;
  return crypto.createHash('sha1').update(key).digest('hex').slice(0, 12);
}

// ── 21. Failure Fingerprinting ───────────────────────────────────────────────
async function failureFingerprints(env, platform, opts = {}, versionsLimit = 20) {
  const filter = { env, platform };
  if (opts.audience) filter.audience = audienceMatch(opts.audience);
  const reports = await Report.find(filter)
    .select('version scenarios createdAt')
    .sort({ createdAt: -1 })
    .limit(versionsLimit);

  if (!reports.length) return { fingerprints: [], totalFingerprints: 0, versionsAnalyzed: 0 };

  const fps = new Map(); // fp -> { fingerprint, scenario, step, sampleError, category, versions: [], firstSeen, lastSeen, count }

  for (const r of reports) {
    for (const run of r.scenarios || []) {
      for (const sub of run.subScenarios || []) {
        if (sub.overall !== 'Failed') continue;
        const name = String(sub.name || '').trim();
        if (!name) continue;
        const step = sub.failed?.[0]?.step || null;
        const err = sub.failed?.[0]?.name || '';
        const fp = fingerprint(name, step, err);
        if (!fps.has(fp)) {
          fps.set(fp, {
            fingerprint: fp,
            scenario: name,
            category: sub.category || sub.categoryName || 'Uncategorized',
            step,
            sampleError: err.slice(0, 250),
            versions: [],
            count: 0,
          });
        }
        const entry = fps.get(fp);
        entry.count++;
        entry.versions.push({ version: r.version, savedAt: r.createdAt });
      }
    }
  }

  // Mark recurring (count >= 2)
  const recurring = [...fps.values()]
    .filter(f => f.count >= 2)
    .map(f => {
      const sorted = [...f.versions].sort((a, b) => new Date(a.savedAt) - new Date(b.savedAt));
      return {
        ...f,
        firstSeen: sorted[0].version,
        lastSeen: sorted[sorted.length - 1].version,
        versionsList: [...new Set(f.versions.map(v => v.version))],
      };
    })
    .sort((a, b) => b.count - a.count);

  return {
    fingerprints: recurring.slice(0, 25),
    totalFingerprints: fps.size,
    recurringCount: recurring.length,
    versionsAnalyzed: reports.length,
  };
}

// ── 22. Time-to-Resolution Tracking ──────────────────────────────────────────
async function timeToResolution(env, platform, opts = {}, versionsLimit = 30) {
  const filter = { env, platform };
  if (opts.audience) filter.audience = audienceMatch(opts.audience);
  const reports = await Report.find(filter)
    .select('version scenarios createdAt')
    .sort({ createdAt: -1 })
    .limit(versionsLimit);

  if (reports.length < 2) return { broken: [], samplesAnalyzed: reports.length };

  // For each scenario, track when it first started failing (chronological pass)
  const chrono = [...reports].reverse(); // oldest → newest
  const tracking = new Map(); // name -> { category, firstBrokenAt, firstBrokenVersion, failingStreak, currentStatus, lastStatus, failStreakVersions }

  for (const r of chrono) {
    for (const sub of flatten(r)) {
      if (!tracking.has(sub.name)) {
        tracking.set(sub.name, {
          name: sub.name,
          category: sub.category,
          firstBrokenAt: null,
          firstBrokenVersion: null,
          currentStatus: null,
          failStreak: 0,
          maxFailStreak: 0,
          failStreakVersions: [],
          totalRuns: 0,
          sampleError: '',
        });
      }
      const t = tracking.get(sub.name);
      t.totalRuns++;
      if (sub.overall === 'Failed') {
        if (t.currentStatus !== 'Failed') {
          // Just broke (or first time seeing it failed)
          t.firstBrokenAt = r.createdAt;
          t.firstBrokenVersion = r.version;
          t.failStreak = 1;
          t.failStreakVersions = [r.version];
        } else {
          t.failStreak++;
          t.failStreakVersions.push(r.version);
        }
        t.maxFailStreak = Math.max(t.maxFailStreak, t.failStreak);
        t.sampleError = (sub.failed?.[0]?.name || t.sampleError || '').slice(0, 200);
      } else {
        // Passed — reset streak
        t.failStreak = 0;
        t.failStreakVersions = [];
      }
      t.currentStatus = sub.overall;
    }
  }

  // Keep only currently-failing tests
  const now = Date.now();
  const broken = [];
  for (const t of tracking.values()) {
    if (t.currentStatus !== 'Failed') continue;
    if (!t.firstBrokenAt) continue;
    const brokenMs = now - new Date(t.firstBrokenAt).getTime();
    const days = Math.floor(brokenMs / (1000 * 60 * 60 * 24));
    const hours = Math.floor((brokenMs / (1000 * 60 * 60)) % 24);
    broken.push({
      name: t.name,
      category: t.category,
      firstBrokenVersion: t.firstBrokenVersion,
      firstBrokenAt: t.firstBrokenAt,
      failStreak: t.failStreak,
      failStreakVersions: t.failStreakVersions,
      daysBroken: days,
      hoursBroken: hours,
      durationLabel: days >= 1
        ? `${days} day${days !== 1 ? 's' : ''}${hours > 0 ? ` ${hours}h` : ''}`
        : `${hours} hour${hours !== 1 ? 's' : ''}`,
      versionsAffected: t.failStreakVersions.length,
      sampleError: t.sampleError,
      severity: days >= 14 ? 'critical' : days >= 7 ? 'high' : days >= 3 ? 'medium' : 'low',
    });
  }

  broken.sort((a, b) => b.daysBroken - a.daysBroken || b.failStreak - a.failStreak);
  return {
    broken: broken.slice(0, 25),
    totalBroken: broken.length,
    samplesAnalyzed: reports.length,
  };
}

// ── 23. Drill-Down Step Analysis ─────────────────────────────────────────────
// Get complete historical trace of a single scenario across all versions
async function scenarioHistory(env, platform, scenarioName, opts = {}) {
  const filter = { env, platform };
  if (opts.audience) filter.audience = audienceMatch(opts.audience);
  const reports = await Report.find(filter)
    .select('version scenarios createdAt')
    .sort({ createdAt: -1 })
    .limit(50);

  const history = [];
  for (const r of reports) {
    for (const run of r.scenarios || []) {
      for (const sub of run.subScenarios || []) {
        if (String(sub.name || '').trim() !== String(scenarioName).trim()) continue;
        const failInfo = sub.failed?.[0] || {};
        history.push({
          version: r.version,
          savedAt: r.createdAt,
          status: sub.overall,
          duration: sub.duration || 0,
          totalSteps: sub.totalSteps || 0,
          failedStep: failInfo.step || null,
          failureMessage: failInfo.name || '',
          failureTime: failInfo.time || 0,
        });
      }
    }
  }

  if (history.length === 0) throw new Error('Scenario not found in any version');

  // Compute per-step failure distribution
  const stepFailCount = {};
  for (const h of history) {
    if (h.status === 'Failed' && h.failedStep != null) {
      stepFailCount[h.failedStep] = (stepFailCount[h.failedStep] || 0) + 1;
    }
  }
  const stepDistribution = Object.entries(stepFailCount)
    .map(([step, count]) => ({ step: parseInt(step), count }))
    .sort((a, b) => b.count - a.count);

  // Stability stats
  const passed = history.filter(h => h.status === 'Passed').length;
  const failed = history.filter(h => h.status === 'Failed').length;
  const total = history.length;
  const passRate = total > 0 ? parseFloat(((passed / total) * 100).toFixed(1)) : 0;

  return {
    scenario: scenarioName,
    totalRuns: total,
    passed,
    failed,
    passRate,
    history,
    stepDistribution,
    mostCommonFailStep: stepDistribution[0] || null,
  };
}

// ── 24. Diff Viewer — word-level diff between two error messages ─────────────
function wordDiff(a, b) {
  // Simple LCS-based word diff
  const wordsA = (a || '').split(/(\s+)/);
  const wordsB = (b || '').split(/(\s+)/);

  // LCS table
  const m = wordsA.length, n = wordsB.length;
  const dp = Array.from({ length: m + 1 }, () => new Array(n + 1).fill(0));
  for (let i = 1; i <= m; i++) {
    for (let j = 1; j <= n; j++) {
      if (wordsA[i - 1] === wordsB[j - 1]) dp[i][j] = dp[i - 1][j - 1] + 1;
      else dp[i][j] = Math.max(dp[i - 1][j], dp[i][j - 1]);
    }
  }

  // Backtrack to produce diff operations
  const ops = [];
  let i = m, j = n;
  while (i > 0 && j > 0) {
    if (wordsA[i - 1] === wordsB[j - 1]) {
      ops.unshift({ type: 'same', word: wordsA[i - 1] });
      i--; j--;
    } else if (dp[i - 1][j] >= dp[i][j - 1]) {
      ops.unshift({ type: 'removed', word: wordsA[i - 1] });
      i--;
    } else {
      ops.unshift({ type: 'added', word: wordsB[j - 1] });
      j--;
    }
  }
  while (i > 0) { ops.unshift({ type: 'removed', word: wordsA[i - 1] }); i--; }
  while (j > 0) { ops.unshift({ type: 'added', word: wordsB[j - 1] }); j--; }
  return ops;
}

async function errorDiff(env, platform, v1, v2, scenarioName, opts = {}) {
  const f1 = { env, platform, $or: [{ version: v1 }, { businessVersion: v1 }] };
  const f2 = { env, platform, $or: [{ version: v2 }, { businessVersion: v2 }] };
  if (opts.audience) { const m = audienceMatch(opts.audience); f1.audience = m; f2.audience = m; }
  const [r1, r2] = await Promise.all([
    Report.findOne(f1).sort({ createdAt: -1 }),
    Report.findOne(f2).sort({ createdAt: -1 }),
  ]);
  if (!r1 || !r2) throw new Error('Versions not found');

  function findError(report, name) {
    for (const run of report.scenarios || []) {
      for (const sub of run.subScenarios || []) {
        if (String(sub.name || '').trim() === String(name).trim()) {
          return {
            status: sub.overall,
            errorMessage: sub.failed?.[0]?.name || '',
            step: sub.failed?.[0]?.step || null,
            duration: sub.duration || 0,
          };
        }
      }
    }
    return null;
  }

  const e1 = findError(r1, scenarioName);
  const e2 = findError(r2, scenarioName);
  if (!e1 || !e2) throw new Error('Scenario not found in one or both versions');

  const diff = wordDiff(e1.errorMessage, e2.errorMessage);
  return {
    scenario: scenarioName,
    v1: { version: v1, ...e1 },
    v2: { version: v2, ...e2 },
    diff,
  };
}

// Main entry — load all forensics for a given version
async function forensics(env, platform, opts = {}) {
  const [fps, ttr] = await Promise.all([
    failureFingerprints(env, platform, opts),
    timeToResolution(env, platform, opts),
  ]);
  return { fingerprints: fps, timeToResolution: ttr };
}

module.exports = {
  forensics,
  scenarioHistory,
  errorDiff,
  failureFingerprints,
  timeToResolution,
};
