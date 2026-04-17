const mongoose = require('mongoose');

const activityLogSchema = new mongoose.Schema({
  action:   { type: String, enum: ['upload', 'delete', 'edit', 'login', 'settings_change', 'user_create', 'user_delete', 'scenario_update'], required: true },
  user:     { type: mongoose.Schema.Types.ObjectId, ref: 'User' },
  userName: { type: String },
  target:   { type: String },
  details:  { type: mongoose.Schema.Types.Mixed, default: {} },
}, { timestamps: true });

activityLogSchema.index({ createdAt: -1 });

module.exports = mongoose.model('ActivityLog', activityLogSchema);
