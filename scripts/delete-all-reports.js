/**
 * One-shot: delete every Report doc and its Cloudinary attachments.
 * Same behavior as DELETE /api/admin/reports/:id, applied in bulk.
 *
 *   node scripts/delete-all-reports.js
 */
require('dotenv').config();
const mongoose = require('mongoose');

async function run() {
  if (!process.env.MONGO_URI) { console.error('MONGO_URI not set'); process.exit(1); }
  await mongoose.connect(process.env.MONGO_URI);
  const Report = require('../models/Report');
  const { deleteFile } = require('../services/cloudinaryService');

  const reports = await Report.find().select('_id env platform version files');
  console.log(`Found ${reports.length} reports.`);

  let cloudDeleted = 0, cloudFailed = 0;
  for (const r of reports) {
    for (const file of r.files || []) {
      if (!file.publicId) continue;
      const resourceType = file.type === 'screenshot' ? 'image' : 'raw';
      try { await deleteFile(file.publicId, resourceType); cloudDeleted++; }
      catch (e) { cloudFailed++; }
    }
  }
  console.log(`Cloudinary: ${cloudDeleted} deleted, ${cloudFailed} failed.`);

  const del = await Report.deleteMany({});
  console.log(`Mongo: ${del.deletedCount} report doc(s) deleted.`);

  await mongoose.disconnect();
  console.log('Done.');
}

run().catch(err => { console.error('FAILED:', err); process.exit(1); });
