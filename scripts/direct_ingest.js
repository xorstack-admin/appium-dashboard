/**
 * direct_ingest.js — Ingest a local folder of HTML + _files/*.PNG directly to DB/Cloudinary.
 * Usage: node scripts/direct_ingest.js <folder> <env> <platform> <version> [label]
 */
require('dotenv').config();
const fs = require('fs');
const path = require('path');
const mongoose = require('mongoose');
const Report = require('../models/Report');
const Scenario = require('../models/Scenario');
const { parseHTML } = require('../services/parser');
const { uploadBuffer } = require('../services/cloudinaryService');

function norm(s) {
  return String(s).toLowerCase().replace(/['’`]/g, '').replace(/[^a-z0-9]+/g, ' ').trim();
}
function buildIndex(master) {
  const idx = new Map();
  for (const cat of master?.categories || []) {
    for (const sc of cat.scenarios || []) {
      const e = { categoryId: cat.id, categoryName: cat.name, scenarioId: sc.id, scenarioName: sc.name, sourceFile: sc.sourceFile };
      idx.set(norm(sc.name), e);
      if (sc.originalMarker) idx.set(norm(sc.originalMarker), e);
    }
  }
  return idx;
}
function match(name, idx) {
  const key = norm(name);
  if (idx.has(key)) return idx.get(key);
  const stripped = key.replace(/^\d+\.?\s+/, '');
  if (idx.has(stripped)) return idx.get(stripped);
  return null;
}

async function main() {
  const [folderArg, env, platform, version, labelArg] = process.argv.slice(2);
  if (!folderArg || !env || !platform || !version) {
    console.error('Usage: node scripts/direct_ingest.js <folder> <env> <platform> <version> [label]');
    process.exit(1);
  }
  const folder = path.resolve(folderArg);
  if (!fs.existsSync(folder)) { console.error('Folder not found:', folder); process.exit(1); }
  const label = labelArg || version;

  console.log('Connecting to MongoDB...');
  await mongoose.connect(process.env.MONGO_URI);
  console.log('Connected.');

  // Remove existing if present
  const existing = await Report.findOne({ env, platform, version });
  if (existing) {
    console.log(`Removing existing ${env}/${platform}/${version}...`);
    await Report.deleteOne({ _id: existing._id });
  }

  // Find all HTML files at the folder root
  const htmlFiles = fs.readdirSync(folder)
    .filter(f => /\.html?$/i.test(f))
    .map(f => ({ name: f, path: path.join(folder, f) }));
  console.log(`Found ${htmlFiles.length} HTML file(s)`);

  // Parse each HTML and build screenshot map
  const scenarioRuns = [];
  const allScreenshots = []; // { filename, buffer, htmlBase }

  for (const hf of htmlFiles) {
    console.log(`\nParsing ${hf.name}...`);
    const content = fs.readFileSync(hf.path, 'utf-8');
    const parsed = parseHTML(content, hf.name);
    console.log(`  subScenarios: ${parsed.subScenarios.length} | overall: ${parsed.overall}`);
    scenarioRuns.push(parsed);

    // Find matching _files folder
    const base = hf.name.replace(/\.html?$/i, '');
    const filesFolder = path.join(folder, `${base}_files`);
    if (!fs.existsSync(filesFolder)) {
      console.log(`  No _files folder — skipping screenshots`);
      continue;
    }

    // Collect which screenshots are referenced by FAILED steps
    const neededShots = new Set();
    for (const sub of parsed.subScenarios || []) {
      for (const f of sub.failed || []) {
        for (const s of f.screenshots || []) {
          neededShots.add(s.toLowerCase());
        }
      }
    }
    console.log(`  Need to upload ${neededShots.size} failure screenshots`);

    // Only upload the needed screenshots
    const filesInFolder = fs.readdirSync(filesFolder);
    for (const fname of filesInFolder) {
      if (!neededShots.has(fname.toLowerCase())) continue;
      const fpath = path.join(filesFolder, fname);
      const buffer = fs.readFileSync(fpath);
      allScreenshots.push({
        filename: fname,
        buffer,
        size: buffer.length,
        htmlBase: base,
      });
    }
  }

  console.log(`\nTotal screenshots to upload: ${allScreenshots.length}`);

  // Upload to Cloudinary in parallel (10 at a time)
  const CONCURRENCY = 10;
  const screenshotMap = new Map(); // filename (lower) -> URL
  const fileRefs = [];

  async function upOne(s, idx) {
    try {
      const result = await uploadBuffer(s.buffer, {
        folder: `vya-reports/${env}/${platform}/${version}/${s.htmlBase}`,
        resourceType: 'image',
        publicId: s.filename.replace(/\.[^.]+$/, ''),
      });
      screenshotMap.set(s.filename.toLowerCase(), result.url);
      fileRefs.push({
        type: 'screenshot',
        url: result.url,
        publicId: result.publicId,
        originalName: s.filename,
        size: result.size,
      });
      if ((idx + 1) % 20 === 0 || idx + 1 === allScreenshots.length) {
        console.log(`  Uploaded ${idx + 1}/${allScreenshots.length}`);
      }
    } catch (e) {
      console.error(`  Failed to upload ${s.filename}: ${e.message}`);
    }
  }
  for (let i = 0; i < allScreenshots.length; i += CONCURRENCY) {
    const batch = allScreenshots.slice(i, i + CONCURRENCY);
    await Promise.all(batch.map((s, bIdx) => upOne(s, i + bIdx)));
  }

  // Attach Cloudinary URLs to failed step screenshots
  for (const run of scenarioRuns) {
    for (const sub of run.subScenarios || []) {
      for (const f of sub.failed || []) {
        if (f.screenshots && f.screenshots.length) {
          f.screenshotUrls = f.screenshots
            .map(n => screenshotMap.get(String(n).toLowerCase()))
            .filter(Boolean);
        }
      }
    }
  }

  // Enrich with master scenario categories
  const scenarioDoc = await Scenario.findOne({ platform });
  const idx = scenarioDoc ? buildIndex(scenarioDoc) : new Map();
  for (const run of scenarioRuns) {
    for (const sub of run.subScenarios || []) {
      const m = match(sub.name, idx);
      if (m) {
        sub.categoryId = m.categoryId;
        sub.scenarioId = m.scenarioId;
        sub.sourceFile = m.sourceFile;
      }
    }
  }

  // Compute totals
  const allSubs = scenarioRuns.flatMap(r => r.subScenarios || []);
  const totalPassed = allSubs.filter(s => s.overall === 'Passed').length;
  const totalFailed = allSubs.filter(s => s.overall === 'Failed').length;
  const totalScenarios = allSubs.length;
  const passRate = totalScenarios > 0 ? parseFloat(((totalPassed / totalScenarios) * 100).toFixed(1)) : null;

  // Upload HTML files too (for attachments section)
  console.log('\nUploading HTML files...');
  for (const hf of htmlFiles) {
    try {
      const buffer = fs.readFileSync(hf.path);
      const result = await uploadBuffer(buffer, {
        folder: `vya-reports/${env}/${platform}/${version}`,
        resourceType: 'raw',
        publicId: hf.name.replace(/\.[^.]+$/, ''),
      });
      fileRefs.push({
        type: 'raw_report',
        url: result.url,
        publicId: result.publicId,
        originalName: hf.name,
        size: result.size,
      });
      console.log(`  Uploaded ${hf.name}`);
    } catch (e) {
      console.error(`  HTML upload failed for ${hf.name}: ${e.message}`);
    }
  }

  // Save report
  console.log('\nSaving report to MongoDB...');
  const report = await Report.create({
    env, platform, version,
    label,
    notes: '',
    scenarios: scenarioRuns,
    passRate, totalPassed, totalFailed, totalScenarios,
    files: fileRefs,
    runDate: scenarioRuns[0]?.runStarted ? new Date(scenarioRuns[0].runStarted) : new Date(),
  });

  console.log(`\n✓ Saved report ${env}/${platform}/${version}`);
  console.log(`  Pass rate: ${passRate}%`);
  console.log(`  Passed: ${totalPassed}, Failed: ${totalFailed}, Total: ${totalScenarios}`);
  console.log(`  Files uploaded: ${fileRefs.length}`);
  console.log(`  Failure screenshots: ${screenshotMap.size}`);

  process.exit(0);
}

main().catch(e => { console.error('FATAL:', e); process.exit(1); });
