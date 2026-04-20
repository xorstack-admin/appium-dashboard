/**
 * flakyService.js — Flaky Test Detection
 * A test is flaky if its status alternates (passes then fails or vice-versa)
 * across multiple versions for the same env/platform.
 */

const Report = require('../models/Report');

function flatten(report) {
  const map = new Map();
  for (const run of report.scenarios || []) {
    for (const sub of run.subScenarios || []) {
      if (!sub.name) continue;
      const name = String(sub.name).trim();
      if (!name) continue;
      // If duplicates within same report, prefer Failed (worst case)
      const prev = map.get(name);
      if (!prev || sub.overall === 'Failed') {
        map.set(name, {
          name,
          category: sub.category || sub.categoryName || 'Uncategorized',
          status: sub.overall,
        });
      }
    }
  }
  return [...map.values()];
}

async function detectFlakyTests(env, platform, opts = {}) {
  const limit = opts.limit || 30; // last N versions
  const reports = await Report.find({ env, platform })
    .select('version createdAt scenarios')
    .sort({ createdAt: -1 })
    .limit(limit);

  if (reports.length < 2) {
    return { flakyTests: [], flakyPercentage: 0, totalScenarios: 0, totalReportsAnalyzed: reports.length };
  }

  // Build history map: name → [{ version, status }]
  const historyMap = new Map();
  // Iterate oldest to newest so history is chronological
  for (const r of [...reports].reverse()) {
    const subs = flatten(r);
    for (const s of subs) {
      if (!historyMap.has(s.name)) {
        historyMap.set(s.name, { name: s.name, category: s.category, history: [] });
      }
      historyMap.get(s.name).history.push({ version: r.version, status: s.status });
    }
  }

  const flakyTests = [];
  let totalAppearedMultipleTimes = 0;

  for (const entry of historyMap.values()) {
    if (entry.history.length < 2) continue;
    totalAppearedMultipleTimes++;

    // Detect alternation: count transitions between Passed/Failed
    let transitions = 0;
    let lastStatus = null;
    let passedCount = 0, failedCount = 0;
    for (const h of entry.history) {
      if (h.status === 'Passed') passedCount++;
      else if (h.status === 'Failed') failedCount++;
      if (lastStatus !== null && lastStatus !== h.status) transitions++;
      lastStatus = h.status;
    }

    // Flaky if at least one transition AND has both passed and failed runs
    if (transitions >= 1 && passedCount > 0 && failedCount > 0) {
      const failureRate = parseFloat(((failedCount / entry.history.length) * 100).toFixed(1));
      flakyTests.push({
        name: entry.name,
        category: entry.category,
        failureRate,
        passedCount,
        failedCount,
        transitions,
        runs: entry.history.length,
        history: entry.history,
      });
    }
  }

  // Sort by failure rate desc, then by transitions desc
  flakyTests.sort((a, b) => b.failureRate - a.failureRate || b.transitions - a.transitions);

  const flakyPercentage = totalAppearedMultipleTimes > 0
    ? parseFloat(((flakyTests.length / totalAppearedMultipleTimes) * 100).toFixed(1))
    : 0;

  return {
    flakyTests,
    flakyPercentage,
    totalScenarios: totalAppearedMultipleTimes,
    totalReportsAnalyzed: reports.length,
  };
}

module.exports = { detectFlakyTests };
