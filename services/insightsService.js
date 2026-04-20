/**
 * insightsService.js — Rule-based insights generator (no external AI)
 * Combines current report data, previous report, platform stats, and flaky info
 * to produce a list of actionable insights.
 */

const SLOW_DURATION_THRESHOLD = 4; // seconds

function generateInsights({ currentReport, previousReport, platformStats, flakyData, slowThreshold }) {
  const insights = [];
  const slow = slowThreshold || SLOW_DURATION_THRESHOLD;
  const verLabel = currentReport?.version || 'this version';

  // Rule 1: Pass Rate change vs previous
  if (currentReport && previousReport) {
    const prev = previousReport.passRate || 0;
    const curr = currentReport.passRate || 0;
    const diff = parseFloat((curr - prev).toFixed(1));
    if (diff <= -10) {
      insights.push({ type: 'warning', message: `Significant quality drop: pass rate fell by ${Math.abs(diff)}% in ${verLabel} (vs ${previousReport.version})` });
    } else if (diff >= 10) {
      insights.push({ type: 'success', message: `Quality improved: pass rate rose by ${diff}% in ${verLabel} (vs ${previousReport.version})` });
    } else if (diff < 0) {
      insights.push({ type: 'warning', message: `Pass rate dropped by ${Math.abs(diff)}% in ${verLabel}` });
    } else if (diff > 0) {
      insights.push({ type: 'success', message: `Pass rate improved by ${diff}% in ${verLabel}` });
    } else {
      insights.push({ type: 'info', message: `Pass rate unchanged from ${previousReport.version}` });
    }
  }

  // Rule 2: Failure concentration — find category with most failures
  if (currentReport) {
    const catFailures = {};
    for (const run of currentReport.scenarios || []) {
      for (const sub of run.subScenarios || []) {
        const cat = sub.category || sub.categoryName || 'Uncategorized';
        if (!catFailures[cat]) catFailures[cat] = { total: 0, failed: 0 };
        catFailures[cat].total++;
        if (sub.overall === 'Failed') catFailures[cat].failed++;
      }
    }
    const cats = Object.entries(catFailures).map(([name, v]) => ({
      name, total: v.total, failed: v.failed,
      failRate: v.total > 0 ? parseFloat(((v.failed / v.total) * 100).toFixed(1)) : 0,
    })).filter(c => c.total >= 2).sort((a, b) => b.failRate - a.failRate);
    if (cats.length > 0 && cats[0].failRate >= 30) {
      insights.push({
        type: 'warning',
        message: `Most failing module: ${cats[0].name} (${cats[0].failRate}% fail rate, ${cats[0].failed}/${cats[0].total})`,
      });
    }
  }

  // Rule 3: Platform comparison (only if not filtered to one platform)
  if (platformStats && platformStats.ios?.total > 0 && platformStats.android?.total > 0) {
    const diff = platformStats.ios.passRate - platformStats.android.passRate;
    if (diff > 5) {
      insights.push({ type: 'info', message: `iOS more stable than Android (${platformStats.ios.passRate}% vs ${platformStats.android.passRate}%)` });
    } else if (diff < -5) {
      insights.push({ type: 'info', message: `Android more stable than iOS (${platformStats.android.passRate}% vs ${platformStats.ios.passRate}%)` });
    }
  }

  // Rule 4: Slow tests (performance issue)
  if (currentReport) {
    let slowCount = 0;
    for (const run of currentReport.scenarios || []) {
      for (const sub of run.subScenarios || []) {
        if (typeof sub.duration === 'number' && sub.duration > slow) slowCount++;
      }
    }
    if (slowCount >= 5) {
      insights.push({ type: 'warning', message: `Performance issue: ${slowCount} scenarios exceed ${slow}s threshold` });
    }
  }

  // Rule 5: Flaky test count
  if (flakyData && flakyData.flakyTests && flakyData.flakyTests.length > 0) {
    insights.push({
      type: 'warning',
      message: `${flakyData.flakyTests.length} flaky test${flakyData.flakyTests.length !== 1 ? 's' : ''} detected (${flakyData.flakyPercentage}% of scenarios show alternating pass/fail)`,
    });
  }

  // Rule 6: All passed celebration
  if (currentReport && currentReport.totalFailed === 0 && currentReport.totalScenarios > 0) {
    insights.push({ type: 'success', message: `All ${currentReport.totalScenarios} scenarios passed in ${verLabel}` });
  }

  // Rule 7: High absolute failures
  if (currentReport && currentReport.totalFailed >= 100) {
    const failRate = currentReport.passRate != null ? (100 - currentReport.passRate).toFixed(1) : '';
    insights.push({ type: 'warning', message: `${currentReport.totalFailed} scenarios failed in ${verLabel} (${failRate}%)` });
  }

  if (insights.length === 0) {
    insights.push({ type: 'info', message: `No significant issues in ${verLabel}. System is stable.` });
  }

  return insights;
}

module.exports = { generateInsights };
