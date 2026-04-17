const Alert = require('../models/Alert');

async function checkAlerts(report, io) {
  const alerts = await Alert.find({ enabled: true });

  for (const alert of alerts) {
    if (alert.type === 'pass_rate_drop') {
      const threshold = alert.condition?.threshold || 80;
      if (report.passRate !== null && report.passRate < threshold) {
        const message = `Pass rate dropped to ${report.passRate}% (below ${threshold}%) for ${report.env}/${report.platform} ${report.version}`;
        if (io) io.emit('alert', { type: 'pass_rate_drop', message, report: { env: report.env, platform: report.platform, version: report.version, passRate: report.passRate } });
      }
    }

    if (alert.type === 'new_report') {
      const message = `New report uploaded: ${report.env}/${report.platform} ${report.version} — ${report.passRate}% pass rate`;
      if (io) io.emit('alert', { type: 'new_report', message, report: { env: report.env, platform: report.platform, version: report.version, passRate: report.passRate } });
    }
  }
}

module.exports = { checkAlerts };
