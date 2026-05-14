/**
 * Migration: add `audience` to existing Report docs and drop the old
 * unique index on {env, platform, version}.
 *
 * Run once after deploying the new schema:
 *   node scripts/add-audience.js
 *
 * Safe to re-run: idempotent.
 */
require('dotenv').config();
const mongoose = require('mongoose');

async function run() {
  if (!process.env.MONGO_URI) {
    console.error('ERROR: MONGO_URI is not set.');
    process.exit(1);
  }

  await mongoose.connect(process.env.MONGO_URI);
  const Report = require('../models/Report');
  const coll = Report.collection;

  // 1) Backfill audience='consumer' on any doc that doesn't have it
  const r = await coll.updateMany(
    { audience: { $exists: false } },
    { $set: { audience: 'consumer' } }
  );
  console.log(`Set audience='consumer' on ${r.modifiedCount} document(s).`);

  // 2) Drop the old unique index if present
  try {
    const indexes = await coll.indexes();
    const old = indexes.find(i =>
      i.name === 'env_1_platform_1_version_1' ||
      (i.key && i.key.env === 1 && i.key.platform === 1 && i.key.version === 1 && i.unique)
    );
    if (old) {
      await coll.dropIndex(old.name);
      console.log(`Dropped old unique index "${old.name}".`);
    } else {
      console.log('Old unique index not found — nothing to drop.');
    }
  } catch (e) {
    console.error('Index drop failed (continuing):', e.message);
  }

  // 3) Ensure new indexes exist (mongoose will also create on next model use)
  await Report.syncIndexes();
  console.log('Indexes synced.');

  await mongoose.disconnect();
  console.log('Done.');
}

run().catch(err => {
  console.error('Migration failed:', err);
  process.exit(1);
});
