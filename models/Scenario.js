const mongoose = require('mongoose');

const scenarioItemSchema = new mongoose.Schema({
  id: String,
  name: String,
  originalMarker: String,
  sourceFile: String,
  status: { type: String, enum: ['active', 'blocked', 'deprecated'], default: 'active' },
}, { _id: false });

const categorySchema = new mongoose.Schema({
  id: Number,
  name: String,
  scenarios: [scenarioItemSchema],
}, { _id: false });

const scenarioSchema = new mongoose.Schema({
  platform:    { type: String, enum: ['ios', 'android'], required: true, unique: true },
  totalActive: { type: Number, default: 0 },
  categories:  [categorySchema],
  updatedBy:   { type: mongoose.Schema.Types.ObjectId, ref: 'User' },
}, { timestamps: true });

module.exports = mongoose.model('Scenario', scenarioSchema);
