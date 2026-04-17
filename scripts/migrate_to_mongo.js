/**
 * migrate_to_mongo.js — Migrate existing flat-file reports + scenarios into MongoDB
 *
 * Usage: node scripts/migrate_to_mongo.js
 *
 * Reads:
 *   reports/{env}/{platform}/{version}/data.json + meta.json
 *   scenarios_ios.json, scenarios_android.json
 *
 * Writes to MongoDB collections: reports, scenarios, settings
 */
require('dotenv').config();
const mongoose = require('mongoose');
const fs = require('fs');
const path = require('path');

const Report = require('../models/Report');
const Scenario = require('../models/Scenario');
const Setting = require('../models/Setting');

const ROOT = path.dirname(__dirname);
const ENVS = ['staging', 'production'];
const PLATFORMS = ['ios', 'android'];

async function migrateScenarios() {
  console.log('\n--- Migrating Scenarios ---');
  for (const platform of PLATFORMS) {
    const file = path.join(ROOT, `scenarios_${platform}.json`);
    if (!fs.existsSync(file)) {
      console.log(`  Skipping ${platform}: no scenarios file found`);
      continue;
    }
    const data = JSON.parse(fs.readFileSync(file, 'utf8'));
    const categories = (data.categories || []).map(cat => ({
      ...cat,
      scenarios: (cat.scenarios || []).map(sc => ({ ...sc, status: 'active' })),
    }));
    const totalActive = categories.reduce((sum, cat) =>
      sum + (cat.scenarios || []).length, 0);

    await Scenario.findOneAndUpdate(
      { platform },
      { platform, categories, totalActive },
      { upsert: true, new: true }
    );
    console.log(`  ${platform}: ${totalActive} scenarios across ${categories.length} categories`);
  }
}

async function migrateReports() {
  console.log('\n--- Migrating Reports ---');
  let total = 0;
  let skipped = 0;

  for (const env of ENVS) {
    for (const platform of PLATFORMS) {
      const dir = path.join(ROOT, 'reports', env, platform);
      if (!fs.existsSync(dir)) continue;

      const versions = fs.readdirSync(dir, { withFileTypes: true })
        .filter(e => e.isDirectory())
        .map(e => e.name);

      for (const version of versions) {
        const dataFile = path.join(dir, version, 'data.json');
        const metaFile = path.join(dir, version, 'meta.json');
        if (!fs.existsSync(dataFile)) continue;

        // Check if already exists
        const exists = await Report.findOne({ env, platform, version });
        if (exists) {
          skipped++;
          continue;
        }

        const scenarios = JSON.parse(fs.readFileSync(dataFile, 'utf8'));
        let meta = {};
        try {
          if (fs.existsSync(metaFile))
            meta = JSON.parse(fs.readFileSync(metaFile, 'utf8'));
        } catch (_) {}

        // Calculate stats from data
        const allSubs = (Array.isArray(scenarios) ? scenarios : [scenarios])
          .flatMap(r => r.subScenarios || []);
        const totalPassed = allSubs.filter(s => s.overall === 'Passed').length;
        const totalFailed = allSubs.filter(s => s.overall === 'Failed').length;
        const totalScenarios = allSubs.length;
        const passRate = totalScenarios > 0
          ? parseFloat(((totalPassed / totalScenarios) * 100).toFixed(1))
          : null;

        const stat = fs.statSync(dataFile);

        await Report.create({
          env, platform, version,
          label: meta.label || version,
          notes: '',
          scenarios: Array.isArray(scenarios) ? scenarios : [scenarios],
          passRate: meta.passRate || passRate,
          totalPassed: meta.passed || totalPassed,
          totalFailed: meta.failed || totalFailed,
          totalScenarios,
          files: [],
          runDate: meta.savedAt ? new Date(meta.savedAt) : stat.mtime,
          createdAt: meta.savedAt ? new Date(meta.savedAt) : stat.mtime,
        });

        total++;
        console.log(`  ${env}/${platform}/${version} — ${passRate}% pass rate`);
      }
    }
  }
  console.log(`\n  Migrated: ${total} reports, Skipped: ${skipped} (already exist)`);
}

async function seedSettings() {
  console.log('\n--- Seeding Default Settings ---');
  const defaults = {
    passRateThreshold: 90,
    slowStepThreshold: 4,
    autoRefreshInterval: 300,
  };
  for (const [key, value] of Object.entries(defaults)) {
    await Setting.findOneAndUpdate({ key }, { key, value }, { upsert: true });
  }
  console.log('  Default settings seeded');
}

async function main() {
  console.log('VYA QA Platform — Data Migration');
  console.log('================================');

  if (!process.env.MONGO_URI) {
    console.error('Error: MONGO_URI not set in .env');
    process.exit(1);
  }

  await mongoose.connect(process.env.MONGO_URI);
  console.log('Connected to MongoDB');

  await migrateScenarios();
  await migrateReports();
  await seedSettings();

  console.log('\nMigration complete!');
  process.exit(0);
}

main().catch(err => {
  console.error('Migration failed:', err);
  process.exit(1);
});
