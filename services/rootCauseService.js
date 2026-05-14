/**
 * rootCauseService.js — Tier 1 Root Cause Analytics
 *
 * Features:
 * 1. Failure Cluster Analysis — groups similar error messages
 * 2. Failure Pattern Detection — classifies failures (UI / Network / Assertion / Crash / Timeout)
 * 3. Error Location Heatmap — which step number has the most failures
 * 4. Blame Graph — which version INTRODUCED each persistent failure
 *
 * Bonus: Explicit App Crash detection (separate category — requested by client)
 */

const Report = require('../models/Report');
const { audienceMatch } = require('./audienceFilter');

// ── Pattern classification rules ─────────────────────────────────────────────
const PATTERN_RULES = [
  {
    type: 'crash',
    label: 'App Crash',
    color: '#dc2626',
    priority: 1, // check first — crashes take precedence
    matchers: [
      /app\s*crash/i,
      /application\s*crash/i,
      /process\s*(died|crashed|terminated)/i,
      /sigkill|sigabrt|sigsegv/i,
      /ANR\b|application\s*not\s*responding/i,
      /fatal\s*(exception|error|signal)/i,
      /stopped\s*working/i,
      /crashed\s+with/i,
      /\bNSInvalidArgumentException\b/i,
      /\bNullPointerException\b/i,
    ],
  },
  {
    type: 'timeout',
    label: 'Timeout / Performance',
    color: '#f59e0b',
    priority: 2,
    matchers: [
      /timeout/i,
      /timed\s*out/i,
      /exceeded\s*(wait|timeout)/i,
      /took\s*too\s*long/i,
      /slow\s*response/i,
    ],
  },
  {
    type: 'element',
    label: 'UI / Broken Selector',
    color: '#6366f1',
    priority: 3,
    matchers: [
      /element\s*(not\s*found|was\s*not\s*identified|not\s*visible|not\s*on\s*screen)/i,
      /cannot\s*click/i,
      /cannot\s*find\s*(element|button|text)/i,
      /no\s*such\s*element/i,
      /element\s*not\s*interactable/i,
      /failed\s*to\s*click/i,
      /failed\s*to\s*tap/i,
      /stale\s*element/i,
      /xpath.*not\s*found/i,
    ],
  },
  {
    type: 'network',
    label: 'Network / API',
    color: '#3b82f6',
    priority: 4,
    matchers: [
      /network\s*error/i,
      /connection\s*(refused|reset|timed)/i,
      /api\s*(error|failed)/i,
      /http\s*(4\d\d|5\d\d)/i,
      /request\s*failed/i,
      /socket\s*(hang|closed)/i,
      /dns/i,
      /unreachable/i,
      /\beconnreset\b|\beconnrefused\b|\betimedout\b|\benotfound\b/i,
    ],
  },
  {
    type: 'assertion',
    label: 'Assertion / Logic',
    color: '#ec4899',
    priority: 5,
    matchers: [
      /expected\s+.*\s+got/i,
      /expected\s+.*\s+to\s+(be|equal|match)/i,
      /assert(ion)?\s*(failed|error)/i,
      /diff\s*[+\-]/i,
      /mismatch/i,
      /does\s*not\s*(match|equal)/i,
      /should\s*(be|equal|have)/i,
    ],
  },
];

function classifyFailure(message) {
  if (!message) return { type: 'unknown', label: 'Unknown', color: '#94a3b8' };
  const sorted = [...PATTERN_RULES].sort((a, b) => a.priority - b.priority);
  for (const rule of sorted) {
    for (const m of rule.matchers) {
      if (m.test(message)) return { type: rule.type, label: rule.label, color: rule.color };
    }
  }
  return { type: 'other', label: 'Other Failure', color: '#64748b' };
}

// ── Normalize error messages for clustering ──────────────────────────────────
// Replaces dynamic values (numbers, IDs, quoted text) with placeholders
function normalizeError(msg) {
  if (!msg) return '';
  return String(msg)
    .toLowerCase()
    // Strip HTML
    .replace(/<[^>]*>/g, ' ')
    // Replace quoted strings
    .replace(/'[^']{0,200}'/g, '<VALUE>')
    .replace(/"[^"]{0,200}"/g, '<VALUE>')
    // Replace monetary values
    .replace(/[€$£¥]\s*[\d.,]+/g, '<MONEY>')
    // Replace decimals / numbers
    .replace(/[-+]?\d+\.\d+/g, '<NUM>')
    .replace(/\b\d{3,}\b/g, '<NUM>')
    // Collapse whitespace
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, 300);
}

// Extract a concise "signature" — first 6-10 meaningful words
function signature(msg) {
  const norm = normalizeError(msg);
  const words = norm.split(/\s+/).slice(0, 10);
  return words.join(' ');
}

// ── Main: Root-cause analysis for a single version ───────────────────────────
async function analyzeVersion(env, platform, version, opts = {}) {
  const filter = { env, platform, $or: [{ version }, { businessVersion: version }] };
  if (opts.audience) filter.audience = audienceMatch(opts.audience);
  const report = await Report.findOne(filter).sort({ createdAt: -1 });
  if (!report) throw new Error(`Report not found: ${version}`);

  const failedItems = [];
  for (const run of report.scenarios || []) {
    for (const sub of run.subScenarios || []) {
      if (sub.overall !== 'Failed') continue;
      const failMsg = (sub.failed && sub.failed[0] && sub.failed[0].name) || sub.validationSummary || '';
      const stepNum = (sub.failed && sub.failed[0] && sub.failed[0].step) || null;
      const classification = classifyFailure(failMsg);
      failedItems.push({
        scenarioName: sub.name,
        category: sub.category || sub.categoryName || 'Uncategorized',
        app: sub.app || '',
        rawError: failMsg,
        normalizedError: normalizeError(failMsg),
        signature: signature(failMsg),
        type: classification.type,
        typeLabel: classification.label,
        typeColor: classification.color,
        stepNum,
      });
    }
  }

  // ── 1. Failure Clusters ───────────────────────────────────────────────────
  const clusterMap = new Map();
  for (const f of failedItems) {
    const key = f.signature || '(empty)';
    if (!clusterMap.has(key)) {
      clusterMap.set(key, {
        signature: key,
        sampleError: f.rawError.slice(0, 200),
        type: f.type,
        typeLabel: f.typeLabel,
        typeColor: f.typeColor,
        count: 0,
        affectedScenarios: [],
        categories: {},
      });
    }
    const c = clusterMap.get(key);
    c.count++;
    c.affectedScenarios.push(f.scenarioName);
    c.categories[f.category] = (c.categories[f.category] || 0) + 1;
  }
  const clusters = [...clusterMap.values()]
    .filter(c => c.count >= 2) // only clusters with 2+ failures
    .map(c => ({
      ...c,
      categoriesArr: Object.entries(c.categories).map(([name, count]) => ({ name, count })).sort((a, b) => b.count - a.count),
    }))
    .sort((a, b) => b.count - a.count);

  // ── 2. Pattern Distribution ───────────────────────────────────────────────
  const patternCounts = {};
  for (const f of failedItems) {
    if (!patternCounts[f.type]) {
      patternCounts[f.type] = { type: f.type, label: f.typeLabel, color: f.typeColor, count: 0 };
    }
    patternCounts[f.type].count++;
  }
  const totalFails = failedItems.length;
  const patterns = Object.values(patternCounts).map(p => ({
    ...p,
    percentage: totalFails > 0 ? parseFloat(((p.count / totalFails) * 100).toFixed(1)) : 0,
  })).sort((a, b) => b.count - a.count);

  // ── 3. Error Location Heatmap (step numbers) ──────────────────────────────
  const stepMap = {};
  for (const f of failedItems) {
    if (f.stepNum == null) continue;
    stepMap[f.stepNum] = (stepMap[f.stepNum] || 0) + 1;
  }
  const stepHeatmap = Object.entries(stepMap).map(([step, count]) => ({
    step: parseInt(step),
    count,
    percentage: totalFails > 0 ? parseFloat(((count / totalFails) * 100).toFixed(1)) : 0,
  })).sort((a, b) => b.count - a.count);

  // ── 4. App Crash summary (explicit call-out) ─────────────────────────────
  const crashes = failedItems.filter(f => f.type === 'crash');
  const crashSummary = {
    count: crashes.length,
    percentage: totalFails > 0 ? parseFloat(((crashes.length / totalFails) * 100).toFixed(1)) : 0,
    categories: {},
    samples: crashes.slice(0, 5).map(c => ({ scenario: c.scenarioName, error: c.rawError.slice(0, 200) })),
  };
  for (const c of crashes) {
    crashSummary.categories[c.category] = (crashSummary.categories[c.category] || 0) + 1;
  }
  crashSummary.categoriesArr = Object.entries(crashSummary.categories)
    .map(([name, count]) => ({ name, count }))
    .sort((a, b) => b.count - a.count);

  return {
    totalFails,
    clusters: clusters.slice(0, 10),
    patterns,
    stepHeatmap: stepHeatmap.slice(0, 15),
    crashSummary,
  };
}

// ── 4b. Blame Graph — which version first introduced each still-failing test ─
async function buildBlameGraph(env, platform, opts = {}) {
  const filter = { env, platform };
  if (opts.audience) filter.audience = audienceMatch(opts.audience);
  const reports = await Report.find(filter)
    .select('version createdAt scenarios')
    .sort({ createdAt: 1 }); // oldest → newest

  if (reports.length < 2) return { blameData: [], totalBlamed: 0 };

  // Track first-failure version for each scenario
  const firstFailure = new Map(); // name -> { introducedIn, category, firstError }
  const latestStatus = new Map(); // name -> status

  for (const r of reports) {
    for (const run of r.scenarios || []) {
      for (const sub of run.subScenarios || []) {
        if (!sub.name) continue;
        const name = String(sub.name).trim();
        const status = sub.overall;
        const prevStatus = latestStatus.get(name);

        // Introduced when: status became Failed (and wasn't Failed before, OR first appearance is Failed)
        if (status === 'Failed' && (prevStatus !== 'Failed')) {
          firstFailure.set(name, {
            introducedIn: r.version,
            category: sub.category || sub.categoryName || 'Uncategorized',
            firstError: (sub.failed && sub.failed[0] && sub.failed[0].name) || '',
          });
        }
        // If it passed, clear the "first failure" flag
        if (status === 'Passed') {
          firstFailure.delete(name);
        }
        latestStatus.set(name, status);
      }
    }
  }

  // Group by introducedIn version
  const blameByVersion = {};
  for (const [name, info] of firstFailure) {
    if (latestStatus.get(name) !== 'Failed') continue; // only still-failing tests
    const v = info.introducedIn;
    if (!blameByVersion[v]) blameByVersion[v] = { version: v, stillFailingCount: 0, scenarios: [] };
    blameByVersion[v].stillFailingCount++;
    if (blameByVersion[v].scenarios.length < 20) {
      blameByVersion[v].scenarios.push({ name, category: info.category, firstError: info.firstError.slice(0, 150) });
    }
  }

  const blameData = Object.values(blameByVersion)
    .sort((a, b) => b.stillFailingCount - a.stillFailingCount);

  return {
    blameData,
    totalBlamed: blameData.reduce((sum, b) => sum + b.stillFailingCount, 0),
    versionsAnalyzed: reports.length,
  };
}

async function rootCauseAnalysis(env, platform, version, opts = {}) {
  const [analysis, blame] = await Promise.all([
    analyzeVersion(env, platform, version, opts),
    buildBlameGraph(env, platform, opts),
  ]);
  return { ...analysis, blame };
}

module.exports = { rootCauseAnalysis, classifyFailure, normalizeError };
