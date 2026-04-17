/**
 * parser.js — Parse Appium Studio HTML reports (both formats)
 *
 * Format 1: Individual test report (step-by-step with "Send text" markers)
 * Format 2: Summary Report (table of test runs with #, Name, Status, Duration, etc.)
 */

// Format 1: Step-by-step pattern
const STEP_PATTERN = /<h3 class="page-header">(.*?)<\/h3>\s*(?:<div class="alert alert-danger"[^>]*>.*?<\/div>)?\s*.*?<div class="panel panel-(success|danger)">\s*<div class="panel-heading">\s*<span[^>]*><\/span>(Passed|Failed)\s*<\/div>.*?Total Time:\s*([\d.]+)\s*Seconds/gs;

// Format 2: Summary Report row pattern
// Each row: <tr> → <td>#</td> <td><span href='testXXXX'>Name</span></td> <td class='text-success|text-danger'>Status</td> <td>Date</td> <td>Duration</td> <td>Failed Step</td> <td>Error</td>
const SUMMARY_ROW = /<tr>\s*<td[^>]*>\s*<span>(\d+)<span>\s*<\/td>\s*<td>\s*<span[^>]*>(.*?)<\/span>\s*<\/td>\s*(?:.*?)<td class='(text-success|text-danger)'>\s*.*?<span>(Passed|Failed)<\/span>\s*<\/td>\s*(?:.*?)<td>\s*<span>(.*?)<\/span>\s*<\/td>\s*<td>\s*<span>(.*?)<\/span>\s*<\/td>\s*<td>\s*<span>(.*?)<\/span>\s*<\/td>\s*<td>\s*<span[^>]*>(.*?)<\/span>\s*<\/td>/gs;

function detectFormat(content) {
  // Summary Report has a table with headers: #, Name, Status, Run Started, Duration, Failed Step, Error
  if (content.includes('Test Reports') && content.includes("text-success") && /<td[^>]*>\s*<span>\d+<span>/.test(content)) {
    return 'summary';
  }
  // Individual report has page-header steps with panel-success/panel-danger
  if (STEP_PATTERN.test(content)) {
    STEP_PATTERN.lastIndex = 0;
    return 'individual';
  }
  // Try summary as fallback
  return 'summary';
}

function parseSummaryReport(content, filename) {
  let mainName = filename.replace(/\.html$/i, '');
  const titleMatch = content.match(/<title>(.*?)<\/title>/);
  if (titleMatch && !['summary report', 'untitled'].includes(titleMatch[1].trim().toLowerCase())) {
    mainName = titleMatch[1].trim().replace(/&amp;/g, '&');
  }

  // Extract rows from the summary table
  const subScenarios = [];
  let totalDuration = 0;
  let firstRunDate = '';

  // Use a more robust regex that handles multiline and varying whitespace
  const rowPattern = /<tr>\s*<td[^>]*>\s*<span>(\d+)<span>\s*<\/td>\s*<td>\s*<span[^>]*>([\s\S]*?)<\/span>\s*<\/td>\s*[\s\S]*?<td\s+class='(text-success|text-danger)'>\s*[\s\S]*?<span>(Passed|Failed)<\/span>\s*<\/td>\s*[\s\S]*?<td>\s*<span>([\s\S]*?)<\/span>\s*<\/td>\s*<td>\s*<span>([\s\S]*?)<\/span>\s*<\/td>\s*<td>\s*<span>([\s\S]*?)<\/span>\s*<\/td>\s*<td>\s*<span[^>]*>([\s\S]*?)<\/span>\s*<\/td>/g;

  let match;
  while ((match = rowPattern.exec(content)) !== null) {
    const num = parseInt(match[1]);
    const name = match[2].trim().replace(/&amp;/g, '&') || `Test #${num}`;
    const status = match[4].trim(); // Passed or Failed
    const runStarted = match[5].trim();
    const durationStr = match[6].trim();
    const failedStep = match[7].trim();
    const errorMsg = match[8].trim();

    if (!firstRunDate && runStarted) firstRunDate = runStarted;

    // Parse duration
    const durMatch = durationStr.match(/([\d.]+)\s*Seconds/i);
    const duration = durMatch ? parseFloat(durMatch[1]) : 0;
    totalDuration += duration;

    const isFailed = status === 'Failed';
    const isSlow = duration > 4;

    const failed = [];
    const slow = [];

    if (isFailed && failedStep) {
      failed.push({
        step: num,
        name: failedStep.replace(/<[^>]*>/g, '').trim(),
        status: 'Failed',
        time: duration,
      });
    }

    if (isSlow) {
      slow.push({
        step: num,
        name: name,
        status: status,
        time: duration,
      });
    }

    subScenarios.push({
      name: name === 'Untitled' ? `${mainName} - Test #${num}` : name,
      totalSteps: 1,
      passedSteps: isFailed ? 0 : 1,
      failedSteps: isFailed ? 1 : 0,
      slowSteps: isSlow ? 1 : 0,
      overall: status,
      failed,
      slow,
    });
  }

  const passedCount = subScenarios.filter(s => s.overall === 'Passed').length;
  const failedCount = subScenarios.filter(s => s.overall === 'Failed').length;
  const hasAnyFailed = failedCount > 0;

  return {
    scenario: mainName,
    device: '',
    runStarted: firstRunDate,
    totalTime: `${Math.round(totalDuration)} seconds`,
    overall: hasAnyFailed ? 'Failed' : 'Passed',
    totalSteps: subScenarios.length,
    passedSteps: passedCount,
    failedSteps: failedCount,
    slowSteps: subScenarios.filter(s => s.slowSteps > 0).length,
    subScenarios,
  };
}

function parseIndividualReport(content, filename) {
  const titleMatch = content.match(/<title>(.*?)<\/title>/);
  let mainName = titleMatch ? titleMatch[1].trim().replace(/&amp;/g, '&') : '';
  if (!mainName || ['untitled', 'summary report'].includes(mainName.toLowerCase())) {
    mainName = filename.replace(/\.html$/i, '');
  }

  let runStarted = '', totalTime = '', device = '';
  let m = content.match(/Run Started.*?<td>(.*?)<\/td>/s);
  if (m) runStarted = m[1].trim();
  m = content.match(/Total Time.*?<td>(.*?)<\/td>/s);
  if (m) totalTime = m[1].trim();
  m = content.match(/Device Information.*?<small>\((.*?)\)<\/small>/s);
  if (m) device = m[1].trim();

  const overall = /alert-danger.*?Failed/s.test(content) ? 'Failed' : 'Passed';

  const allSteps = [];
  let stepMatch;
  let stepNum = 0;
  STEP_PATTERN.lastIndex = 0;
  while ((stepMatch = STEP_PATTERN.exec(content)) !== null) {
    stepNum++;
    allSteps.push({
      step: stepNum,
      name: stepMatch[1].trim(),
      status: stepMatch[3].trim(),
      time: parseFloat(stepMatch[4]),
    });
  }

  const subScenarios = [];
  let currentSub = null;
  for (const s of allSteps) {
    const sendMatch = s.name.match(/^Send text '(\d+\.?\s*.+)'$/);
    if (sendMatch) {
      if (currentSub) subScenarios.push(currentSub);
      currentSub = { name: sendMatch[1].replace(/&amp;/g, '&').trim(), steps: [] };
    }
    if (currentSub) currentSub.steps.push(s);
  }
  if (currentSub) subScenarios.push(currentSub);

  const subs = subScenarios.map(sub => {
    const failed = sub.steps.filter(s => s.status === 'Failed');
    const passed = sub.steps.filter(s => s.status === 'Passed');
    const slow = sub.steps.filter(s => s.time > 4);
    return {
      name: sub.name,
      totalSteps: sub.steps.length,
      passedSteps: passed.length,
      failedSteps: failed.length,
      slowSteps: slow.length,
      overall: failed.length > 0 ? 'Failed' : 'Passed',
      failed,
      slow,
    };
  });

  return {
    scenario: mainName,
    device,
    runStarted,
    totalTime,
    overall,
    totalSteps: subs.reduce((a, s) => a + s.totalSteps, 0),
    passedSteps: subs.reduce((a, s) => a + s.passedSteps, 0),
    failedSteps: subs.reduce((a, s) => a + s.failedSteps, 0),
    slowSteps: subs.reduce((a, s) => a + s.slowSteps, 0),
    subScenarios: subs,
  };
}

function parseHTML(content, filename) {
  const format = detectFormat(content);
  if (format === 'summary') {
    return parseSummaryReport(content, filename);
  }
  return parseIndividualReport(content, filename);
}

module.exports = { parseHTML };
