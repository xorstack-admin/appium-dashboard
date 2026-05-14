const express = require('express');
const { auth } = require('../middleware/auth');
const Report = require('../models/Report');
let XLSX; try { XLSX = require('xlsx'); } catch (_) { XLSX = null; }
const { audienceMatch } = require('../services/audienceFilter');

const router = express.Router();
router.use(auth);

function buildCSV(rows) {
  const hdr = ['Environment','Platform','Audience','Build Version','Run Date','Category','Scenario ID','Scenario Name','Status','Total Steps','Passed Steps','Failed Steps','Slow Steps'];
  const lines = [hdr.join(',')];
  for (const r of rows) {
    lines.push([
      `"${r.env||''}"`, `"${r.platform||''}"`, `"${r.audience||''}"`, `"${r.version||''}"`, `"${r.runDate||''}"`,
      `"${r.category||''}"`, `"${r.scenarioId||''}"`, `"${(r.name||'').replace(/"/g,'""')}"`,
      `"${r.status||''}"`, r.totalSteps||0, r.passedSteps||0, r.failedSteps||0, r.slowSteps||0
    ].join(','));
  }
  return lines.join('\r\n');
}

function buildXLSX(rows, sheetName) {
  if (!XLSX) return null;
  const headers = ['Environment','Platform','Audience','Build Version','Run Date','Category','Scenario ID','Scenario Name','Status','Total Steps','Passed Steps','Failed Steps','Slow Steps'];
  const data = [headers, ...rows.map(r => [r.env, r.platform, r.audience, r.version, r.runDate, r.category, r.scenarioId, r.name, r.status, r.totalSteps||0, r.passedSteps||0, r.failedSteps||0, r.slowSteps||0])];
  const wb = XLSX.utils.book_new();
  const ws = XLSX.utils.aoa_to_sheet(data);
  ws['!cols'] = [12,10,12,16,12,28,12,48,10,12,14,14,12].map(w => ({ wch: w }));
  XLSX.utils.book_append_sheet(wb, ws, sheetName || 'Results');
  return XLSX.write(wb, { type: 'buffer', bookType: 'xlsx' });
}

function toRows(report) {
  const rows = [];
  const runDate = report.runDate ? report.runDate.toISOString().slice(0, 10) : '';
  const audience = report.audience || 'consumer';
  for (const sc of report.scenarios || []) {
    for (const sub of sc.subScenarios || []) {
      rows.push({
        env: report.env, platform: report.platform, audience, version: report.version, runDate,
        category: sub.categoryName || 'Uncategorized', scenarioId: sub.scenarioId || '',
        name: sub.name, status: sub.overall,
        totalSteps: sub.totalSteps, passedSteps: sub.passedSteps,
        failedSteps: sub.failedSteps, slowSteps: sub.slowSteps,
      });
    }
  }
  return rows;
}

// Parse optional ?audience= filter for export endpoints.
function exportAudience(q) {
  const a = String(q.audience || '').toLowerCase();
  return ['consumer','business'].includes(a) ? a : null;
}

// Resolve a single report: prefer ?runId=, else look up by either label.
async function findOneReport(req) {
  const runId = String(req.query.runId || '').trim();
  if (runId && runId.match(/^[a-f0-9]{24}$/i)) {
    return Report.findById(runId);
  }
  const { env, platform, version } = req.params;
  // The URL path's "version" may be a consumer or business label.
  const filter = { env, platform, $or: [{ version }, { businessVersion: version }] };
  const a = exportAudience(req.query);
  if (a) filter.audience = audienceMatch(a);
  return Report.findOne(filter).sort({ createdAt: -1 });
}

function fileSuffix(report) {
  const a = report.audience || 'consumer';
  return `${report.env}-${report.platform}-${a}-${report.version}`;
}

// CSV single
router.get('/:env/:platform/:version/csv', async (req, res) => {
  try {
    const report = await findOneReport(req);
    if (!report) return res.status(404).json({ error: 'Not found' });
    res.setHeader('Content-Type', 'text/csv');
    res.setHeader('Content-Disposition', `attachment; filename="${fileSuffix(report)}.csv"`);
    res.send(buildCSV(toRows(report)));
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// XLSX single
router.get('/:env/:platform/:version/xlsx', async (req, res) => {
  if (!XLSX) return res.status(500).json({ error: 'xlsx not installed' });
  try {
    const report = await findOneReport(req);
    if (!report) return res.status(404).json({ error: 'Not found' });
    const buf = buildXLSX(toRows(report), report.version.slice(0, 31));
    res.setHeader('Content-Type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
    res.setHeader('Content-Disposition', `attachment; filename="${fileSuffix(report)}.xlsx"`);
    res.send(buf);
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// CSV range
router.get('/:env/:platform/range/csv', async (req, res) => {
  try {
    const { env, platform } = req.params;
    const { from, to } = req.query;
    const filter = { env, platform };
    const a = exportAudience(req.query);
    if (a) filter.audience = audienceMatch(a);
    if (from || to) { filter.runDate = {}; if (from) filter.runDate.$gte = new Date(from); if (to) filter.runDate.$lte = new Date(to + 'T23:59:59Z'); }
    const reports = await Report.find(filter).sort({ createdAt: -1 });
    const allRows = reports.flatMap(r => toRows(r));
    const audPart = a ? `-${a}` : '';
    const name = (from && to) ? `${env}-${platform}${audPart}-${from}-to-${to}` : `${env}-${platform}${audPart}-all`;
    res.setHeader('Content-Type', 'text/csv');
    res.setHeader('Content-Disposition', `attachment; filename="${name}.csv"`);
    res.send(buildCSV(allRows));
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// XLSX range
router.get('/:env/:platform/range/xlsx', async (req, res) => {
  if (!XLSX) return res.status(500).json({ error: 'xlsx not installed' });
  try {
    const { env, platform } = req.params;
    const { from, to } = req.query;
    const filter = { env, platform };
    const a = exportAudience(req.query);
    if (a) filter.audience = audienceMatch(a);
    if (from || to) { filter.runDate = {}; if (from) filter.runDate.$gte = new Date(from); if (to) filter.runDate.$lte = new Date(to + 'T23:59:59Z'); }
    const reports = await Report.find(filter).sort({ createdAt: -1 });
    const allRows = reports.flatMap(r => toRows(r));
    const sheetName = (from && to) ? `${from} to ${to}`.slice(0, 31) : `${env}-${platform}${a ? '-' + a : ''}`;
    const audPart = a ? `-${a}` : '';
    const name = (from && to) ? `${env}-${platform}${audPart}-${from}-to-${to}` : `${env}-${platform}${audPart}-all`;
    const buf = buildXLSX(allRows, sheetName);
    res.setHeader('Content-Type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
    res.setHeader('Content-Disposition', `attachment; filename="${name}.xlsx"`);
    res.send(buf);
  } catch (err) { res.status(500).json({ error: err.message }); }
});

module.exports = router;
