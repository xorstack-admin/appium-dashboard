const mongoose = require('mongoose');

const failedStepSchema = new mongoose.Schema({
  step: Number, name: String, status: String, time: Number,
  stepCounter: String,
  screenshots: [String], // filenames, e.g. ["93.PNG"]
  screenshotUrls: [String], // Cloudinary URLs after upload
}, { _id: false });

const subScenarioSchema = new mongoose.Schema({
  name: String,
  category: { type: String, default: 'Uncategorized' },
  app: { type: String, default: '' },
  validationSummary: { type: String, default: '' },
  duration: { type: Number, default: 0 },
  totalSteps: { type: Number, default: 0 },
  passedSteps: { type: Number, default: 0 },
  failedSteps: { type: Number, default: 0 },
  slowSteps: { type: Number, default: 0 },
  overall: { type: String, enum: ['Passed', 'Failed'] },
  categoryId: { type: Number, default: null },
  categoryName: { type: String, default: 'Uncategorized' },
  scenarioId: { type: String, default: null },
  sourceFile: { type: String, default: null },
  failed: [failedStepSchema],
  slow: [failedStepSchema],
}, { _id: false });

const scenarioRunSchema = new mongoose.Schema({
  scenario: String,
  device: String,
  runStarted: String,
  totalTime: String,
  overall: { type: String, enum: ['Passed', 'Failed'] },
  totalSteps: { type: Number, default: 0 },
  passedSteps: { type: Number, default: 0 },
  failedSteps: { type: Number, default: 0 },
  slowSteps: { type: Number, default: 0 },
  subScenarios: [subScenarioSchema],
}, { _id: false });

const fileRefSchema = new mongoose.Schema({
  type: { type: String, enum: ['raw_report', 'screenshot', 'attachment'] },
  url: String,
  publicId: String,
  originalName: String,
  size: Number,
}, { _id: false });

const reportSchema = new mongoose.Schema({
  env:       { type: String, enum: ['staging', 'production'], required: true },
  platform:  { type: String, enum: ['ios', 'android'], required: true },
  audience:  { type: String, enum: ['consumer', 'business'], required: true, default: 'consumer' },
  // `version` is the CONSUMER-facing version label. Kept under this name for
  // backward compatibility with existing services/routes that read `report.version`.
  version:         { type: String, required: true },
  // Admin enters a separate label for the BUSINESS-facing dashboard side.
  // Optional in the schema so legacy docs without it still load — at read time
  // we fall back to `version` when this isn't set.
  businessVersion: { type: String },
  label:     { type: String },
  notes:     { type: String, default: '' },
  scenarios: [scenarioRunSchema],
  passRate:       { type: Number, default: null },
  totalPassed:    { type: Number, default: 0 },
  totalFailed:    { type: Number, default: 0 },
  totalScenarios: { type: Number, default: 0 },
  files: [fileRefSchema],
  uploadedBy: { type: mongoose.Schema.Types.ObjectId, ref: 'User' },
  runDate:    { type: Date },
}, { timestamps: true });

reportSchema.index({ env: 1, platform: 1, createdAt: -1 });
reportSchema.index({ env: 1, platform: 1, version: 1, createdAt: -1 });
reportSchema.index({ env: 1, platform: 1, businessVersion: 1, createdAt: -1 });

module.exports = mongoose.model('Report', reportSchema);
