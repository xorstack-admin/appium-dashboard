/**
 * workflowService.js — Tier 5 Smart Workflows
 *
 * 17. Auto-generated Bug Tickets (for each regression)
 * 18. Owner/Tags routing (rule-based auto-assignment)
 * 19. Flaky Quarantine List
 * 20. Historical Multi-Version Compare
 */

const Report = require('../models/Report');

// ── Helpers ──────────────────────────────────────────────────────────────────
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

// ── 18. Auto-tag scenarios by owner (rule-based, client-configurable) ───────
// Tags are derived from category/scenario name keywords. Teams map to tags.
const TAG_RULES = [
  { tag: '@payments-team', keywords: ['payment', 'vat', 'checkout', 'billing', 'invoice'] },
  { tag: '@auth-team', keywords: ['login', 'logout', 'signup', 'auth', 'register', 'password'] },
  { tag: '@cart-team', keywords: ['cart', 'ordering', 'basket', 'order', 'item', 'pre-order', 'moreitems'] },
  { tag: '@events-team', keywords: ['event', 'booking', 'book', 'host', 'participant', 'invitee'] },
  { tag: '@filters-team', keywords: ['filter', 'search', 'sort'] },
  { tag: '@user-team', keywords: ['profile', 'account', 'user', 'settings', 'contact'] },
  { tag: '@backend-team', keywords: ['api', 'network', 'server', 'backend'] },
  { tag: '@ui-team', keywords: ['ui', 'layout', 'screen', 'modal', 'button', 'text'] },
];

function autoTag(name, category) {
  const combined = ((name || '') + ' ' + (category || '')).toLowerCase();
  const tags = [];
  for (const rule of TAG_RULES) {
    for (const kw of rule.keywords) {
      if (combined.includes(kw)) { tags.push(rule.tag); break; }
    }
  }
  return tags.length ? tags : ['@unassigned'];
}

// ── 17. Auto-generate Bug Tickets for regressions ────────────────────────────
async function generateBugTickets(env, platform, v1, v2) {
  const [r1, r2] = await Promise.all([
    Report.findOne({ env, platform, version: v1 }),
    Report.findOne({ env, platform, version: v2 }),
  ]);
  if (!r1 || !r2) throw new Error('Versions not found');

  const scen1 = new Map();
  for (const s of flatten(r1)) scen1.set(s.name, s);
  const scen2 = flatten(r2);

  // Group regressions by failure signature to batch similar bugs
  const regressions = [];
  for (const s of scen2) {
    if (s.overall !== 'Failed') continue;
    const prev = scen1.get(s.name);
    if (!prev || prev.overall !== 'Passed') continue; // only regressions (was passing, now failing)

    const failInfo = s.failed[0] || {};
    regressions.push({
      name: s.name,
      category: s.category,
      duration: s.duration,
      failedStep: failInfo.step || null,
      failureReason: (failInfo.name || '').trim(),
      tags: autoTag(s.name, s.category),
    });
  }

  // Group by (category, failure reason signature)
  const sig = r => {
    const msg = (r.failureReason || '').toLowerCase()
      .replace(/<[^>]*>/g, ' ')
      .replace(/'[^']{0,200}'/g, '')
      .replace(/"[^"]{0,200}"/g, '')
      .replace(/\d+/g, '')
      .replace(/\s+/g, ' ')
      .trim()
      .slice(0, 100);
    return `${r.category}|${msg}`;
  };
  const groups = new Map();
  for (const r of regressions) {
    const k = sig(r);
    if (!groups.has(k)) groups.set(k, []);
    groups.get(k).push(r);
  }

  // Build bug tickets
  const tickets = [];
  for (const [key, items] of groups) {
    const first = items[0];
    const count = items.length;
    const severity = count >= 10 ? 'Critical' : count >= 5 ? 'High' : count >= 2 ? 'Medium' : 'Low';
    const allTags = [...new Set(items.flatMap(i => i.tags))];
    const affectedCategories = [...new Set(items.map(i => i.category))];
    const sampleName = count > 1 ? `${first.category} - ${count} scenarios` : first.name;

    tickets.push({
      title: `[REGRESSION] ${sampleName} failing in ${v2}`,
      severity,
      priority: severity,
      count,
      category: first.category,
      tags: allTags,
      expected: `Pass (all were passing in ${v1})`,
      actual: first.failureReason || 'Tests are now failing',
      failedStep: first.failedStep,
      scenarios: items.slice(0, 20).map(i => ({ name: i.name, reason: i.failureReason, step: i.failedStep })),
      affectedCategories,
      // Pre-formatted text for Jira/GitHub
      jira: buildJiraText(v1, v2, env, platform, items, severity),
      github: buildGithubMd(v1, v2, env, platform, items, severity),
    });
  }

  tickets.sort((a, b) => b.count - a.count);
  return { tickets, total: tickets.length, totalRegressions: regressions.length, v1, v2 };
}

function buildJiraText(v1, v2, env, platform, items, severity) {
  const first = items[0];
  const lines = [];
  lines.push(`h2. [REGRESSION] ${first.category} failing in ${v2}`);
  lines.push('');
  lines.push(`*Environment:* ${env}`);
  lines.push(`*Platform:* ${platform}`);
  lines.push(`*Severity:* ${severity}`);
  lines.push(`*Affected scenarios:* ${items.length}`);
  lines.push(`*Previous version (passing):* ${v1}`);
  lines.push(`*Current version (failing):* ${v2}`);
  lines.push('');
  lines.push('h3. Expected');
  lines.push(`All scenarios should pass (they were passing in ${v1}).`);
  lines.push('');
  lines.push('h3. Actual');
  lines.push(`${items.length} scenario${items.length !== 1 ? 's' : ''} failing with:`);
  lines.push('{code}');
  lines.push(first.failureReason || 'See scenario list');
  lines.push('{code}');
  lines.push('');
  lines.push('h3. Affected scenarios');
  for (const i of items.slice(0, 15)) {
    lines.push(`* ${i.name}${i.failedStep ? ` (failed at step ${i.failedStep})` : ''}`);
  }
  if (items.length > 15) lines.push(`* _...and ${items.length - 15} more_`);
  return lines.join('\n');
}

function buildGithubMd(v1, v2, env, platform, items, severity) {
  const first = items[0];
  const lines = [];
  lines.push(`## [REGRESSION] ${first.category} failing in ${v2}`);
  lines.push('');
  lines.push(`**Environment:** ${env} · **Platform:** ${platform}`);
  lines.push(`**Severity:** ${severity} · **Affected:** ${items.length} scenarios`);
  lines.push(`**Regressed from:** ${v1} → ${v2}`);
  lines.push('');
  lines.push('### Expected');
  lines.push(`All scenarios should pass (they were passing in \`${v1}\`).`);
  lines.push('');
  lines.push('### Actual');
  lines.push(`${items.length} scenario${items.length !== 1 ? 's' : ''} failing with:`);
  lines.push('```');
  lines.push(first.failureReason || 'See scenario list');
  lines.push('```');
  lines.push('');
  lines.push('### Affected scenarios');
  for (const i of items.slice(0, 15)) {
    lines.push(`- \`${i.name}\`${i.failedStep ? ` _(step ${i.failedStep})_` : ''}`);
  }
  if (items.length > 15) lines.push(`- _...and ${items.length - 15} more_`);
  return lines.join('\n');
}

// ── 18. Owners / Tags summary — aggregate failures by team tag ──────────────
async function ownerRouting(env, platform, version) {
  const report = version
    ? await Report.findOne({ env, platform, version })
    : await Report.findOne({ env, platform }).sort({ createdAt: -1 });
  if (!report) return { byOwner: [], totalScenarios: 0, totalFailures: 0 };

  const scenarios = flatten(report);
  const byOwner = {};

  for (const s of scenarios) {
    const tags = autoTag(s.name, s.category);
    for (const tag of tags) {
      if (!byOwner[tag]) byOwner[tag] = { tag, total: 0, passed: 0, failed: 0, scenarios: [] };
      byOwner[tag].total++;
      if (s.overall === 'Passed') byOwner[tag].passed++;
      else {
        byOwner[tag].failed++;
        if (byOwner[tag].scenarios.length < 15) {
          byOwner[tag].scenarios.push({
            name: s.name,
            category: s.category,
            reason: (s.failed[0]?.name || '').slice(0, 150),
          });
        }
      }
    }
  }

  const result = Object.values(byOwner)
    .map(o => ({ ...o, failRate: o.total > 0 ? parseFloat(((o.failed / o.total) * 100).toFixed(1)) : 0 }))
    .sort((a, b) => b.failed - a.failed || b.total - a.total);

  return {
    byOwner: result,
    totalScenarios: scenarios.length,
    totalFailures: scenarios.filter(s => s.overall === 'Failed').length,
    version: report.version,
  };
}

// ── 19. Flaky Quarantine List ────────────────────────────────────────────────
async function flakyQuarantine(env, platform, versionsLimit = 15) {
  const reports = await Report.find({ env, platform })
    .select('version scenarios createdAt')
    .sort({ createdAt: -1 })
    .limit(versionsLimit);

  if (reports.length < 3) return { candidates: [], metricsImpact: null, samplesAnalyzed: reports.length };

  // Per scenario: count pass/fail, transitions
  const stats = new Map();
  for (const r of [...reports].reverse()) { // oldest → newest for transition tracking
    for (const run of r.scenarios || []) {
      for (const sub of run.subScenarios || []) {
        if (!sub.name) continue;
        const name = String(sub.name).trim();
        if (!stats.has(name)) stats.set(name, {
          name, category: sub.category || sub.categoryName || 'Uncategorized',
          runs: 0, passed: 0, failed: 0, transitions: 0, lastStatus: null,
          history: [],
        });
        const s = stats.get(name);
        s.runs++;
        s.history.push({ version: r.version, status: sub.overall });
        if (sub.overall === 'Passed') s.passed++; else s.failed++;
        if (s.lastStatus !== null && s.lastStatus !== sub.overall) s.transitions++;
        s.lastStatus = sub.overall;
      }
    }
  }

  const candidates = [];
  for (const s of stats.values()) {
    if (s.runs < 3) continue;
    if (s.transitions < 2) continue; // need alternating behavior
    if (s.passed === 0 || s.failed === 0) continue;
    const flakyScore = (s.transitions / Math.max(1, s.runs - 1)) * 100;
    candidates.push({
      name: s.name,
      category: s.category,
      runs: s.runs,
      passed: s.passed,
      failed: s.failed,
      transitions: s.transitions,
      flakyScore: parseFloat(flakyScore.toFixed(1)),
      tags: autoTag(s.name, s.category),
      history: s.history.slice(-10),
      recommendation: flakyScore >= 50 ? 'Quarantine immediately' : flakyScore >= 30 ? 'Monitor closely' : 'Keep watching',
    });
  }
  candidates.sort((a, b) => b.flakyScore - a.flakyScore);

  // Impact: what would metrics look like if we quarantined these?
  const latest = reports[0];
  const latestScenarios = flatten(latest);
  const quarantineNames = new Set(candidates.filter(c => c.flakyScore >= 50).map(c => c.name));
  const rawPassed = latestScenarios.filter(s => s.overall === 'Passed').length;
  const rawFailed = latestScenarios.filter(s => s.overall === 'Failed').length;
  const rawRate = rawPassed + rawFailed > 0 ? (rawPassed / (rawPassed + rawFailed)) * 100 : 0;
  const qPassed = latestScenarios.filter(s => s.overall === 'Passed' && !quarantineNames.has(s.name)).length;
  const qFailed = latestScenarios.filter(s => s.overall === 'Failed' && !quarantineNames.has(s.name)).length;
  const qRate = qPassed + qFailed > 0 ? (qPassed / (qPassed + qFailed)) * 100 : 0;

  return {
    candidates: candidates.slice(0, 20),
    totalFlaky: candidates.length,
    samplesAnalyzed: reports.length,
    metricsImpact: {
      current: { passed: rawPassed, failed: rawFailed, passRate: parseFloat(rawRate.toFixed(1)) },
      afterQuarantine: { passed: qPassed, failed: qFailed, passRate: parseFloat(qRate.toFixed(1)), quarantined: quarantineNames.size },
      passRateImprovement: parseFloat((qRate - rawRate).toFixed(1)),
    },
  };
}

// ── 20. Historical Multi-Version Compare ─────────────────────────────────────
async function multiVersionCompare(env, platform, versions) {
  if (!versions || versions.length < 2) throw new Error('Need at least 2 versions');
  const reports = await Report.find({ env, platform, version: { $in: versions } })
    .select('version passRate totalScenarios totalPassed totalFailed createdAt scenarios');

  // Preserve requested order
  const byVer = new Map();
  for (const r of reports) byVer.set(r.version, r);
  const sorted = versions.map(v => byVer.get(v)).filter(Boolean);
  if (sorted.length < 2) throw new Error('Some versions not found');

  // Collect union of all scenario names
  const allNames = new Set();
  const perVersion = sorted.map(r => {
    const map = new Map();
    for (const s of flatten(r)) {
      map.set(s.name, s.overall);
      allNames.add(s.name);
    }
    return { version: r.version, passRate: r.passRate, total: r.totalScenarios, passed: r.totalPassed, failed: r.totalFailed, savedAt: r.createdAt, statusMap: map };
  });

  // Evolution row per scenario
  const evolution = [];
  for (const name of allNames) {
    const row = { name, category: '', history: [] };
    for (const pv of perVersion) {
      const status = pv.statusMap.get(name);
      row.history.push({ version: pv.version, status: status || 'missing' });
    }
    // Determine category from first appearance
    for (const r of sorted) {
      for (const s of flatten(r)) {
        if (s.name === name) { row.category = s.category; break; }
      }
      if (row.category) break;
    }
    // Compute change type across history
    const statuses = row.history.map(h => h.status);
    const hasFail = statuses.includes('Failed');
    const hasPass = statuses.includes('Passed');
    if (!hasFail) row.trend = 'always-passing';
    else if (!hasPass) row.trend = 'always-failing';
    else {
      // Look at first vs last non-missing
      const firstActual = statuses.find(s => s !== 'missing');
      const lastActual = [...statuses].reverse().find(s => s !== 'missing');
      if (firstActual === 'Passed' && lastActual === 'Failed') row.trend = 'regressed';
      else if (firstActual === 'Failed' && lastActual === 'Passed') row.trend = 'improved';
      else row.trend = 'unstable';
    }
    evolution.push(row);
  }
  // Sort: always-failing, regressed, unstable, improved, always-passing
  const trendOrder = { 'always-failing': 1, 'regressed': 2, 'unstable': 3, 'improved': 4, 'always-passing': 5 };
  evolution.sort((a, b) => (trendOrder[a.trend] || 99) - (trendOrder[b.trend] || 99) || a.name.localeCompare(b.name));

  const summary = {
    versions: perVersion.map(v => ({ version: v.version, passRate: v.passRate, total: v.total, passed: v.passed, failed: v.failed, savedAt: v.savedAt })),
    alwaysPassing: evolution.filter(e => e.trend === 'always-passing').length,
    alwaysFailing: evolution.filter(e => e.trend === 'always-failing').length,
    regressed: evolution.filter(e => e.trend === 'regressed').length,
    improved: evolution.filter(e => e.trend === 'improved').length,
    unstable: evolution.filter(e => e.trend === 'unstable').length,
  };

  return { summary, evolution: evolution.slice(0, 200) };
}

module.exports = {
  generateBugTickets,
  ownerRouting,
  flakyQuarantine,
  multiVersionCompare,
  autoTag,
};
