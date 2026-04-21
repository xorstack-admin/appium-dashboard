/**
 * predictiveService.js — Tier 2 Predictive Analytics
 *
 * 1. Trend Forecasting — simple linear regression over last N versions
 * 2. Risk Score per Scenario — weighted risk combining failure rate, recency, flakiness
 * 3. Anomaly Detection — flag versions deviating >2σ from mean
 * 4. Expected vs Actual Pass Rate — based on historical median
 */

const Report = require('../models/Report');

// ── 1. Trend Forecasting — simple linear regression ─────────────────────────
function linearRegression(points) {
  // points: [{ x, y }]
  const n = points.length;
  if (n < 2) return null;
  const sumX = points.reduce((s, p) => s + p.x, 0);
  const sumY = points.reduce((s, p) => s + p.y, 0);
  const sumXY = points.reduce((s, p) => s + p.x * p.y, 0);
  const sumX2 = points.reduce((s, p) => s + p.x * p.x, 0);
  const meanX = sumX / n;
  const meanY = sumY / n;
  const denom = sumX2 - n * meanX * meanX;
  if (denom === 0) return { slope: 0, intercept: meanY };
  const slope = (sumXY - n * meanX * meanY) / denom;
  const intercept = meanY - slope * meanX;
  // R² — coefficient of determination
  const ssTot = points.reduce((s, p) => s + (p.y - meanY) ** 2, 0);
  const ssRes = points.reduce((s, p) => s + (p.y - (slope * p.x + intercept)) ** 2, 0);
  const r2 = ssTot === 0 ? 1 : Math.max(0, 1 - ssRes / ssTot);
  return { slope, intercept, r2 };
}

function forecastTrend(reports) {
  // reports: newest first → use last N reversed for regression
  const N = Math.min(10, reports.length);
  const recent = reports.slice(0, N).reverse(); // oldest → newest
  const points = recent.map((r, i) => ({ x: i, y: r.passRate || 0, version: r.version }));
  if (points.length < 2) {
    return { available: false, reason: 'Need at least 2 versions to forecast' };
  }
  const lr = linearRegression(points);
  const currentY = points[points.length - 1].y;
  const nextX = points.length;
  const predicted = Math.max(0, Math.min(100, lr.slope * nextX + lr.intercept));
  const trend = lr.slope > 0.5 ? 'improving' : lr.slope < -0.5 ? 'declining' : 'stable';

  // Forecast 3 versions ahead
  const forecasts = [1, 2, 3].map(offset => ({
    step: offset,
    predictedPassRate: parseFloat(Math.max(0, Math.min(100, lr.slope * (nextX + offset - 1) + lr.intercept)).toFixed(1)),
  }));

  return {
    available: true,
    samplesUsed: points.length,
    trend,
    slope: parseFloat(lr.slope.toFixed(3)),
    confidence: parseFloat((lr.r2 * 100).toFixed(1)),
    currentPassRate: currentY,
    predictedNext: parseFloat(predicted.toFixed(1)),
    forecasts,
    historicalPoints: points,
  };
}

// ── 2. Risk Score per Scenario ──────────────────────────────────────────────
function calculateRiskScores(reports) {
  // reports: newest → oldest, already limited to recent N
  const scenarioStats = new Map(); // name → { runs, passed, failed, transitions, lastStatus, lastSeenIdx, category }

  reports.forEach((r, reportIdx) => {
    for (const run of r.scenarios || []) {
      for (const sub of run.subScenarios || []) {
        if (!sub.name) continue;
        const name = String(sub.name).trim();
        if (!scenarioStats.has(name)) {
          scenarioStats.set(name, {
            name,
            category: sub.category || sub.categoryName || 'Uncategorized',
            runs: 0, passed: 0, failed: 0, transitions: 0,
            lastStatus: null, lastSeenIdx: null, firstSeenIdx: reportIdx,
          });
        }
        const s = scenarioStats.get(name);
        s.runs++;
        if (sub.overall === 'Passed') s.passed++; else s.failed++;
        if (s.lastStatus !== null && s.lastStatus !== sub.overall) s.transitions++;
        s.lastStatus = sub.overall;
        s.lastSeenIdx = reportIdx;
      }
    }
  });

  const totalReports = reports.length;
  const risks = [];
  for (const s of scenarioStats.values()) {
    if (s.runs < 2) continue;
    const failureRate = s.failed / s.runs; // 0-1
    const recencyWeight = 1 - (s.lastSeenIdx / Math.max(1, totalReports)); // more recent = higher
    const flakiness = s.transitions / Math.max(1, s.runs - 1); // 0-1
    const currentlyFailing = s.lastStatus === 'Failed' ? 1 : 0;
    // Weighted risk score (0-100)
    const risk = Math.round(
      (failureRate * 0.4 + flakiness * 0.25 + currentlyFailing * 0.25 + recencyWeight * 0.1) * 100
    );
    risks.push({
      name: s.name,
      category: s.category,
      runs: s.runs,
      passed: s.passed,
      failed: s.failed,
      failureRate: parseFloat((failureRate * 100).toFixed(1)),
      flakiness: parseFloat((flakiness * 100).toFixed(1)),
      currentlyFailing: !!currentlyFailing,
      riskScore: risk,
    });
  }
  risks.sort((a, b) => b.riskScore - a.riskScore);
  return risks.slice(0, 20);
}

// ── 3. Anomaly Detection ─────────────────────────────────────────────────────
function detectAnomalies(reports) {
  const passRates = reports.map(r => r.passRate || 0).filter(x => x > 0);
  if (passRates.length < 3) return { available: false, reason: 'Need at least 3 reports for anomaly detection' };
  const mean = passRates.reduce((s, x) => s + x, 0) / passRates.length;
  const variance = passRates.reduce((s, x) => s + (x - mean) ** 2, 0) / passRates.length;
  const stdDev = Math.sqrt(variance);
  const anomalies = reports.map(r => {
    const pr = r.passRate || 0;
    const deviation = stdDev > 0 ? (pr - mean) / stdDev : 0;
    return {
      version: r.version,
      passRate: pr,
      deviation: parseFloat(deviation.toFixed(2)),
      isAnomaly: Math.abs(deviation) >= 2,
      type: deviation <= -2 ? 'negative' : deviation >= 2 ? 'positive' : 'normal',
      savedAt: r.createdAt,
    };
  }).filter(a => a.isAnomaly);

  return {
    available: true,
    mean: parseFloat(mean.toFixed(1)),
    stdDev: parseFloat(stdDev.toFixed(2)),
    samplesAnalyzed: passRates.length,
    anomalies,
    totalAnomalies: anomalies.length,
  };
}

// ── 4. Expected vs Actual Pass Rate ──────────────────────────────────────────
function expectedVsActual(reports, currentVersion) {
  const all = reports.filter(r => r.passRate != null);
  if (all.length < 3) return { available: false, reason: 'Need at least 3 reports for baseline' };

  // Use all except current as baseline
  const currentReport = currentVersion ? reports.find(r => r.version === currentVersion) : reports[0];
  if (!currentReport) return { available: false, reason: 'Current version not found' };

  const baselineReports = reports.filter(r => r.version !== currentReport.version && r.passRate != null);
  const rates = baselineReports.map(r => r.passRate).sort((a, b) => a - b);
  const n = rates.length;
  const median = n % 2 === 0 ? (rates[n / 2 - 1] + rates[n / 2]) / 2 : rates[Math.floor(n / 2)];
  const mean = rates.reduce((s, x) => s + x, 0) / n;
  // Percentiles
  const p25 = rates[Math.floor(n * 0.25)];
  const p75 = rates[Math.floor(n * 0.75)];

  const actual = currentReport.passRate || 0;
  const gap = parseFloat((actual - median).toFixed(1));
  const verdict = gap <= -10 ? 'below expectations' : gap >= 10 ? 'exceeds expectations' : 'within expected range';

  return {
    available: true,
    version: currentReport.version,
    expectedMedian: parseFloat(median.toFixed(1)),
    expectedMean: parseFloat(mean.toFixed(1)),
    expectedP25: parseFloat(p25.toFixed(1)),
    expectedP75: parseFloat(p75.toFixed(1)),
    actual,
    gap,
    verdict,
    samplesUsed: n,
  };
}

// ── Main entry ───────────────────────────────────────────────────────────────
async function predictiveAnalysis(env, platform, currentVersion) {
  const reports = await Report.find({ env, platform })
    .select('version passRate totalScenarios totalPassed totalFailed scenarios createdAt')
    .sort({ createdAt: -1 })
    .limit(30);

  if (reports.length === 0) {
    return {
      forecast: { available: false, reason: 'No reports yet' },
      risks: [],
      anomalies: { available: false, reason: 'No reports yet' },
      expectedVsActual: { available: false, reason: 'No reports yet' },
    };
  }

  return {
    forecast: forecastTrend(reports),
    risks: calculateRiskScores(reports),
    anomalies: detectAnomalies(reports),
    expectedVsActual: expectedVsActual(reports, currentVersion),
    totalReports: reports.length,
  };
}

module.exports = { predictiveAnalysis };
