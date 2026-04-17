const mongoose = require('mongoose');

const alertSchema = new mongoose.Schema({
  type:      { type: String, enum: ['pass_rate_drop', 'new_report'], required: true },
  condition: { type: mongoose.Schema.Types.Mixed, default: {} },
  enabled:   { type: Boolean, default: true },
  createdBy: { type: mongoose.Schema.Types.ObjectId, ref: 'User' },
}, { timestamps: true });

module.exports = mongoose.model('Alert', alertSchema);
