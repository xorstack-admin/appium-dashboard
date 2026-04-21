/**
 * failureIntelService.js — Tier 3 Deep Failure Intelligence
 *
 * 9.  Failed Step Timeline per Scenario
 * 10. Error Message Similarity (Jaccard clustering)
 * 11. Mean Time to Failure for flaky tests
 * 12. Failure Co-occurrence Matrix
 */

const Report = require('../models/Report');

// ── Shared helpers ───────────────────────────────────────────────────────────
function flattenFailed(report) {
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
        totalSteps: sub.totalSteps || 0,
        passedSteps: sub.passedSteps || 0,
        failedSteps: sub.failedSteps || 0,
      });
    }
  }
  return out;
}

// Normalize error message for similarity comparison
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

// Jaccard similarity between two sets of words
function jaccard(a, b) {
  if (!a.size || !b.size) return 0;
  let intersection = 0;
  for (const x of a) if (b.has(x)) intersection++;
  const union = a.size + b.size - intersection;
  return union === 0 ? 0 : intersection / union;
}

function toWordSet(msg) {
  return new Set(normalize(msg).split(' ').filter(w => w.length > 2));
}

// ── 9. Failed Step Timeline — per scenario ───────────────────────────────────
async function getScenarioTimeline(env, platform, version, scenarioName) {
  const report = await Report.findOne({ env, platform, version });
  if (!report) throw new Error('Report not found');

  // Find scenario in report
  for (const run of report.scenarios || []) {
    for (const sub of run.subScenarios || []) {
      if (!sub.name || String(sub.name).trim() !== String(scenarioName).trim()) continue;
      // Build timeline
      const failedStepNum = sub.failed && sub.failed[0] ? sub.failed[0].step : null;
      const totalSteps = sub.totalSteps || (failedStepNum ? failedStepNum + 4 : 10);
      const steps = [];
      for (let i = 1; i <= totalSteps; i++) {
        let status = 'passed';
        let name = '', time = null;
        if (failedStepNum && i === failedStepNum) {
          status = 'failed';
          name = sub.failed[0].name || '';
          time = sub.failed[0].time || null;
        } else if (failedStepNum && i > failedStepNum) {
          status = 'skipped';
        }
        steps.push({ step: i, status, name, time });
      }
      return {
        name: sub.name,
        category: sub.category || sub.categoryName || 'Uncategorized',
        overall: sub.overall,
        totalSteps,
        failedStepNum,
        failureReason: failedStepNum && sub.failed[0] ? sub.failed[0].name : '',
        steps,
      };
    }
  }
  throw new Error('Scenario not found in this report');
}

// Get list of failed scenarios for a version (for picker)
async function getFailedScenariosList(env, platform, version) {
  const report = await Report.findOne({ env, platform, version });
  if (!report) return [];
  const subs = flattenFailed(report).filter(s => s.overall === 'Failed');
  return subs.map(s => ({
    name: s.name,
    category: s.category,
    failedStepNum: s.failed?.[0]?.step || null,
    failureReason: (s.failed?.[0]?.name || '').slice(0, 120),
  }));
}

// ── 10. Error Message Similarity — cluster with Jaccard ──────────────────────
async function errorSimilarity(env, platform, versionsLimit = 10) {
  const reports = await Report.find({ env, platform })
    .select('version createdAt scenarios')
    .sort({ createdAt: -1 })
    .limit(versionsLimit);

  if (reports.length === 0) return { clusters: [], totalFailures: 0, versionsAnalyzed: 0 };

  // Collect all failures across versions
  const failures = [];
  for (const r of reports) {
    for (const run of r.scenarios || []) {
      for (const sub of run.subScenarios || []) {
        if (sub.overall !== 'Failed') continue;
        const msg = sub.failed?.[0]?.name || sub.validationSummary || '';
        if (!msg) continue;
        failures.push({
          version: r.version,
          scenario: String(sub.name || '').trim(),
          category: sub.category || sub.categoryName || 'Uncategorized',
          message: msg,
          words: toWordSet(msg),
        });
      }
    }
  }

  // Cluster with Jaccard threshold 0.7 (very similar)
  const SIM_THRESHOLD = 0.7;
  const clusters = []; // { representative: msg, wordSet, items: [{version, scenario, message}] }

  for (const f of failures) {
    let matched = false;
    for (const c of clusters) {
      if (jaccard(f.words, c.wordSet) >= SIM_THRESHOLD) {
        c.items.push(f);
        c.versionsSet.add(f.version);
        matched = true;
        break;
      }
    }
    if (!matched) {
      clusters.push({
        representative: f.message.slice(0, 300),
        wordSet: f.words,
        items: [f],
        versionsSet: new Set([f.version]),
      });
    }
  }

  // Format
  const result = clusters
    .filter(c => c.items.length >= 2)
    .map(c => ({
      representative: c.representative,
      count: c.items.length,
      versionsSeen: [...c.versionsSet],
      versionsCount: c.versionsSet.size,
      affectedScenarios: [...new Set(c.items.map(i => i.scenario))].slice(0, 10),
      affectedCategories: [...new Set(c.items.map(i => i.category))],
      firstSeen: c.items[c.items.length - 1].version, // reports were sorted newest→oldest, last item is earliest
      latestSeen: c.items[0].version,
    }))
    .sort((a, b) => b.count - a.count);

  return {
    clusters: result.slice(0, 15),
    totalFailures: failures.length,
    totalClusters: result.length,
    versionsAnalyzed: reports.length,
  };
}

// ── 11. Mean Time to Failure ─────────────────────────────────────────────────
async function meanTimeToFailure(env, platform, versionsLimit = 20) {
  const reports = await Report.find({ env, platform })
    .select('version scenarios createdAt')
    .sort({ createdAt: -1 })
    .limit(versionsLimit);

  // name -> { failDurations: [], passDurations: [], transitions }
  const stats = new Map();
  for (const r of reports) {
    for (const run of r.scenarios || []) {
      for (const sub of run.subScenarios || []) {
        if (!sub.name) continue;
        const name = String(sub.name).trim();
        if (!name) continue;
        if (!stats.has(name)) stats.set(name, {
          name, category: sub.category || sub.categoryName || 'Uncategorized',
          failDurations: [], passDurations: [], runs: 0, passed: 0, failed: 0,
        });
        const s = stats.get(name);
        s.runs++;
        const dur = sub.duration || 0;
        if (sub.overall === 'Failed') { s.failed++; if (dur > 0) s.failDurations.push(dur); }
        else { s.passed++; if (dur > 0) s.passDurations.push(dur); }
      }
    }
  }

  const results = [];
  for (const s of stats.values()) {
    if (s.runs < 3) continue;
    if (s.failed === 0) continue; // skip always-passing
    const avgFailTime = s.failDurations.length > 0
      ? s.failDurations.reduce((a, b) => a + b, 0) / s.failDurations.length : 0;
    const avgPassTime = s.passDurations.length > 0
      ? s.passDurations.reduce((a, b) => a + b, 0) / s.passDurations.length : 0;
    const failureRate = s.failed / s.runs;
    // Likely timeout if fail time consistently higher than pass time
    const likelyTimeout = avgFailTime > avgPassTime * 1.3 && avgFailTime > 5;

    results.push({
      name: s.name,
      category: s.category,
      runs: s.runs,
      failed: s.failed,
      failureRate: parseFloat((failureRate * 100).toFixed(1)),
      avgFailTime: parseFloat(avgFailTime.toFixed(2)),
      avgPassTime: parseFloat(avgPassTime.toFixed(2)),
      likelyTimeout,
    });
  }
  results.sort((a, b) => b.failureRate - a.failureRate || b.avgFailTime - a.avgFailTime);
  return { scenarios: results.slice(0, 15), totalAnalyzed: stats.size };
}

// ── 12. Failure Co-occurrence Matrix ─────────────────────────────────────────
async function coOccurrence(env, platform, versionsLimit = 15) {
  const reports = await Report.find({ env, platform })
    .select('version scenarios')
    .sort({ createdAt: -1 })
    .limit(versionsLimit);

  if (reports.length < 3) return { correlations: [], samplesAnalyzed: reports.length };

  // For each report, get which scenarios failed
  const failsByReport = []; // [[scenarioName, ...], ...]
  const allScenarios = new Set();
  for (const r of reports) {
    const failed = new Set();
    for (const run of r.scenarios || []) {
      for (const sub of run.subScenarios || []) {
        if (sub.overall === 'Failed' && sub.name) {
          const n = String(sub.name).trim();
          failed.add(n);
          allScenarios.add(n);
        }
      }
    }
    failsByReport.push(failed);
  }

  // For each pair, calculate correlation
  const scenarioList = [...allScenarios];
  const scenarioFailCount = {};
  for (const s of scenarioList) {
    scenarioFailCount[s] = failsByReport.filter(set => set.has(s)).length;
  }

  const correlations = [];
  for (let i = 0; i < scenarioList.length; i++) {
    const sA = scenarioList[i];
    if (scenarioFailCount[sA] < 2) continue; // need min occurrences
    for (let j = i + 1; j < scenarioList.length; j++) {
      const sB = scenarioList[j];
      if (scenarioFailCount[sB] < 2) continue;
      // Count co-occurrences
      let both = 0;
      for (const set of failsByReport) {
        if (set.has(sA) && set.has(sB)) both++;
      }
      if (both < 2) continue;
      // Probability that B fails given A fails: P(B|A) = both / failsA
      const pBgivenA = (both / scenarioFailCount[sA]) * 100;
      const pAgivenB = (both / scenarioFailCount[sB]) * 100;
      if (pBgivenA < 50 && pAgivenB < 50) continue; // only interesting correlations
      correlations.push({
        scenarioA: sA,
        scenarioB: sB,
        coOccurrences: both,
        failsA: scenarioFailCount[sA],
        failsB: scenarioFailCount[sB],
        pBgivenA: parseFloat(pBgivenA.toFixed(0)),
        pAgivenB: parseFloat(pAgivenB.toFixed(0)),
        strength: Math.max(pBgivenA, pAgivenB),
      });
    }
  }

  correlations.sort((a, b) => b.strength - a.strength || b.coOccurrences - a.coOccurrences);
  return {
    correlations: correlations.slice(0, 20),
    totalScenarios: scenarioList.length,
    samplesAnalyzed: reports.length,
  };
}

// ── Main entry ───────────────────────────────────────────────────────────────
async function failureIntelligence(env, platform, version) {
  const [similarity, mttf, cooc, failedList] = await Promise.all([
    errorSimilarity(env, platform),
    meanTimeToFailure(env, platform),
    coOccurrence(env, platform),
    version ? getFailedScenariosList(env, platform, version) : Promise.resolve([]),
  ]);
  return { similarity, mttf, coOccurrence: cooc, failedList };
}

module.exports = {
  failureIntelligence,
  getScenarioTimeline,
};
