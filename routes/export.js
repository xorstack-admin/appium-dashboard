const express = require('express');
const { auth } = require('../middleware/auth');
const Report = require('../models/Report');
let XLSX; try { XLSX = require('xlsx'); } catch (_) { XLSX = null; }

const router = express.Router();
router.use(auth);

function buildCSV(rows) {
  const hdr = ['Environment','Platform','Build Version','Run Date','Category','Scenario ID','Scenario Name','Status','Total Steps','Passed Steps','Failed Steps','Slow Steps'];
  const lines = [hdr.join(',')];
  for (const r of rows) {
    lines.push([
      `"${r.env||''}"`, `"${r.platform||''}"`, `"${r.version||''}"`, `"${r.runDate||''}"`,
      `"${r.category||''}"`, `"${r.scenarioId||''}"`, `"${(r.name||'').replace(/"/g,'""')}"`,
      `"${r.status||''}"`, r.totalSteps||0, r.passedSteps||0, r.failedSteps||0, r.slowSteps||0
    ].join(','));
  }
  return lines.join('\r\n');
}

function buildXLSX(rows, sheetName) {
  if (!XLSX) return null;
  const headers = ['Environment','Platform','Build Version','Run Date','Category','Scenario ID','Scenario Name','Status','Total Steps','Passed Steps','Failed Steps','Slow Steps'];
  const data = [headers, ...rows.map(r => [r.env, r.platform, r.version, r.runDate, r.category, r.scenarioId, r.name, r.status, r.totalSteps||0, r.passedSteps||0, r.failedSteps||0, r.slowSteps||0])];
  const wb = XLSX.utils.book_new();
  const ws = XLSX.utils.aoa_to_sheet(data);
  ws['!cols'] = [12,10,16,12,28,12,48,10,12,14,14,12].map(w => ({ wch: w }));
  XLSX.utils.book_append_sheet(wb, ws, sheetName || 'Results');
  return XLSX.write(wb, { type: 'buffer', bookType: 'xlsx' });
}

function toRows(report) {
  const rows = [];
  const runDate = report.runDate ? report.runDate.toISOString().slice(0, 10) : '';
  for (const sc of report.scenarios || []) {
    for (const sub of sc.subScenarios || []) {
      rows.push({
        env: report.env, platform: report.platform, version: report.version, runDate,
        category: sub.categoryName || 'Uncategorized', scenarioId: sub.scenarioId || '',
        name: sub.name, status: sub.overall,
        totalSteps: sub.totalSteps, passedSteps: sub.passedSteps,
        failedSteps: sub.failedSteps, slowSteps: sub.slowSteps,
      });
    }
  }
  return rows;
}

// CSV single
router.get('/:env/:platform/:version/csv', async (req, res) => {
  try {
    const report = await Report.findOne(req.params);
    if (!report) return res.status(404).json({ error: 'Not found' });
    res.setHeader('Content-Type', 'text/csv');
    res.setHeader('Content-Disposition', `attachment; filename="${report.env}-${report.platform}-${report.version}.csv"`);
    res.send(buildCSV(toRows(report)));
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// XLSX single
router.get('/:env/:platform/:version/xlsx', async (req, res) => {
  if (!XLSX) return res.status(500).json({ error: 'xlsx not installed' });
  try {
    const report = await Report.findOne(req.params);
    if (!report) return res.status(404).json({ error: 'Not found' });
    const buf = buildXLSX(toRows(report), report.version.slice(0, 31));
    res.setHeader('Content-Type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
    res.setHeader('Content-Disposition', `attachment; filename="${report.env}-${report.platform}-${report.version}.xlsx"`);
    res.send(buf);
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// CSV range
router.get('/:env/:platform/range/csv', async (req, res) => {
  try {
    const { env, platform } = req.params;
    const { from, to } = req.query;
    const filter = { env, platform };
    if (from || to) { filter.runDate = {}; if (from) filter.runDate.$gte = new Date(from); if (to) filter.runDate.$lte = new Date(to + 'T23:59:59Z'); }
    const reports = await Report.find(filter).sort({ createdAt: -1 });
    const allRows = reports.flatMap(r => toRows(r));
    const name = (from && to) ? `${env}-${platform}-${from}-to-${to}` : `${env}-${platform}-all`;
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
    if (from || to) { filter.runDate = {}; if (from) filter.runDate.$gte = new Date(from); if (to) filter.runDate.$lte = new Date(to + 'T23:59:59Z'); }
    const reports = await Report.find(filter).sort({ createdAt: -1 });
    const allRows = reports.flatMap(r => toRows(r));
    const sheetName = (from && to) ? `${from} to ${to}`.slice(0, 31) : `${env}-${platform}`;
    const name = (from && to) ? `${env}-${platform}-${from}-to-${to}` : `${env}-${platform}-all`;
    const buf = buildXLSX(allRows, sheetName);
    res.setHeader('Content-Type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
    res.setHeader('Content-Disposition', `attachment; filename="${name}.xlsx"`);
    res.send(buf);
  } catch (err) { res.status(500).json({ error: err.message }); }
});

module.exports = router;
