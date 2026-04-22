/**
 * parser.js — Parse Appium Studio HTML reports (both formats)
 *
 * Format 1: Individual test report (step-by-step with "Send text" markers)
 * Format 2: Summary Report (table of test runs with #, Name, Status, Duration, etc.)
 */

// Format 1: Step-by-step pattern
const STEP_PATTERN = /<h3 class="page-header">(.*?)<\/h3>\s*(?:<div class="alert alert-danger"[^>]*>.*?<\/div>)?\s*.*?<div class="panel panel-(success|danger)">\s*<div class="panel-heading">\s*<span[^>]*><\/span>(Passed|Failed)\s*<\/div>.*?Total Time:\s*([\d.]+)\s*Seconds/gs;

// ── Category Mapping (rule-based) ─────────────────────────────────────────────
const CATEGORY_RULES = [
  { keywords: ['login', 'logout', 'signin', 'sign-in', 'signup', 'sign-up', 'auth', 'register'], category: 'Authentication' },
  { keywords: ['payment', 'pay', 'checkout', 'billing', 'invoice', 'transaction'], category: 'Payments' },
  { keywords: ['cart', 'basket', 'order'], category: 'Cart' },
  { keywords: ['profile', 'account', 'user', 'settings'], category: 'User' },
  { keywords: ['event', 'booking', 'book'], category: 'Events' },
  { keywords: ['contact', 'wallet'], category: 'Contacts & Wallet' },
  { keywords: ['filter', 'search'], category: 'Filters' },
  { keywords: ['cancel', 'void', 'refund'], category: 'Cancellations' },
  { keywords: ['pdf', 'receipt', 'document'], category: 'Documents' },
  { keywords: ['status', 'verify'], category: 'Status Verification' },
];

function categorize(name) {
  if (!name) return 'Uncategorized';
  const lower = name.toLowerCase();
  for (const rule of CATEGORY_RULES) {
    for (const kw of rule.keywords) {
      if (lower.includes(kw)) return rule.category;
    }
  }
  return 'Uncategorized';
}

// ── Name cleaning ─────────────────────────────────────────────────────────────
function cleanName(rawName) {
  if (!rawName) return null;
  // Strip HTML tags
  let name = rawName.replace(/<[^>]*>/g, '').trim();
  // Decode HTML entities
  name = name.replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&#39;/g, "'");
  name = name.trim();
  // Filter out invalid names
  if (!name || /^untitled$/i.test(name) || /^summary report$/i.test(name) || /^test\s*#?\d+$/i.test(name)) {
    return null;
  }
  return name;
}

function detectFormat(content) {
  // Vya Mobile Automation custom format (Test Case | App | Status | Total Validation | Failed At)
  if (/Test Case.*?App.*?Status.*?Total Validation.*?Failed At/s.test(content) ||
      (content.includes('Vya Mobile Automation') && content.includes('Test Case'))) {
    return 'vya';
  }
  // Summary Report has a table with headers: #, Name, Status, Run Started, Duration, Failed Step, Error
  if (content.includes('Test Reports') && content.includes("text-success") && /<td[^>]*>\s*<span>\d+<span>/.test(content)) {
    return 'summary';
  }
  // Individual report has page-header steps with panel-success/panel-danger
  if (STEP_PATTERN.test(content)) {
    STEP_PATTERN.lastIndex = 0;
    return 'individual';
  }
  return 'summary';
}

// ── Vya custom format parser ─────────────────────────────────────────────────
function parseVyaReport(content, filename) {
  const mainName = filename.replace(/\.html$/i, '').replace(/[_-]/g, ' ').trim();
  const subScenarios = [];

  // Step 1: Isolate <tbody> to skip <thead>, then split on outer <tr> markers
  // Outer scenario rows start with `<tr style="background:#ffffff"` or `<tr style="background:#f8fafc"`
  // Inner (nested) rows have different styles like `<tr style="color:#e74c3c..."` or similar
  const tbodyMatch = content.match(/<tbody[^>]*>([\s\S]*?)<\/tbody>/);
  const body = tbodyMatch ? tbodyMatch[1] : content;

  // Split on the outer <tr> pattern (with specific background styles for alternating rows)
  const outerTrPattern = /<tr\s+style="background:\s*#(?:ffffff|f8fafc)[^"]*"[^>]*>/g;
  const splits = body.split(outerTrPattern);
  // splits[0] is content before first outer <tr> (discard), rest are scenario rows

  for (let i = 1; i < splits.length; i++) {
    const rowContent = splits[i];
    // This now contains everything from one outer tr's start until next outer tr or end

    // Extract test case name (first td — but not the ones inside nested tables)
    // Use pattern: <td style="..font-size:15px..font-weight:500..">...</td>
    const tcMatch = rowContent.match(/<td[^>]*style="[^"]*font-size:\s*15px[^"]*font-weight:\s*500[^"]*"[^>]*>([\s\S]*?)<\/td>/);
    if (!tcMatch) continue;

    // Find status
    const statusMatch = rowContent.match(/<span[^>]*background:\s*#(?:e74c3c|27ae60)[^"]*"[^>]*>(PASSED|FAILED|Passed|Failed)<\/span>/);
    if (!statusMatch) continue;

    // Extract app name (td with class="td-c" that's not the status one)
    const appMatch = rowContent.match(/<td[^>]*class="td-c"[^>]*>([^<]+)<\/td>/);

    // Extract failed-at: look for the td with color:#c0392b
    const failedAtMatch = rowContent.match(/<td[^>]*color:\s*#c0392b[^"]*"[^>]*>([\s\S]*?)<\/td>\s*<\/tr>/);

    // Extract validation: td with class="td-bill"
    const validationMatch = rowContent.match(/<td[^>]*class="td-bill"[^>]*>([\s\S]*?)<\/td>\s*<td[^>]*color:\s*#c0392b/);

    const testCase = tcMatch[1].replace(/<[^>]*>/g, '').replace(/&amp;/g, '&').replace(/&euro;/g, '€').replace(/&#\d+;/g, '').replace(/\s+/g, ' ').trim();
    const app = appMatch ? appMatch[1].trim() : '';
    const statusRaw = statusMatch[1].toLowerCase();
    const validationRaw = validationMatch ? validationMatch[1] : '';
    const failedAtRaw = failedAtMatch ? failedAtMatch[1].replace(/<[^>]*>/g, '').replace(/&amp;/g, '&').replace(/\s+/g, ' ').trim() : '';

    if (!testCase || testCase === 'Test Case') continue; // skip header

    const status = statusRaw === 'passed' ? 'Passed' : 'Failed';

    // Extract a concise summary of validation details (strip inner tables/styles)
    const validationText = validationRaw
      .replace(/<table[\s\S]*?<\/table>/g, '')
      .replace(/<[^>]*>/g, ' ')
      .replace(/&amp;/g, '&').replace(/&euro;/g, '€')
      .replace(/&#\d+;/g, '').replace(/\s+/g, ' ').trim();

    const failed = [];
    if (status === 'Failed' && failedAtRaw) {
      failed.push({
        step: subScenarios.length + 1,
        name: failedAtRaw,
        status: 'Failed',
        time: 0,
      });
    }

    subScenarios.push({
      name: testCase,
      category: mainName, // Use filename as category
      app, // Store app info (Consumer/Business)
      validationSummary: validationText.length > 300 ? validationText.slice(0, 300) + '...' : validationText,
      duration: 0,
      totalSteps: 1,
      passedSteps: status === 'Passed' ? 1 : 0,
      failedSteps: status === 'Failed' ? 1 : 0,
      slowSteps: 0,
      overall: status,
      failed,
      slow: [],
    });
  }

  const passedCount = subScenarios.filter(s => s.overall === 'Passed').length;
  const failedCount = subScenarios.filter(s => s.overall === 'Failed').length;

  return {
    scenario: mainName,
    device: '',
    runStarted: '',
    totalTime: '',
    overall: failedCount > 0 ? 'Failed' : 'Passed',
    totalSteps: subScenarios.length,
    passedSteps: passedCount,
    failedSteps: failedCount,
    slowSteps: 0,
    avgDuration: 0,
    skippedCount: 0,
    subScenarios,
  };
}

function parseSummaryReport(content, filename) {
  let mainName = filename.replace(/\.html$/i, '');
  const titleMatch = content.match(/<title>(.*?)<\/title>/);
  if (titleMatch && !['summary report', 'untitled'].includes(titleMatch[1].trim().toLowerCase())) {
    mainName = titleMatch[1].trim().replace(/&amp;/g, '&');
  }

  const subScenarios = [];
  let totalDuration = 0;
  let firstRunDate = '';
  let skippedCount = 0;

  // Regex captures: rowNum, testId (from href, optional), nameInner, status, runStarted, duration, failedStep, errorMsg
  const rowPattern = /<tr>\s*<td[^>]*>\s*<span>(\d+)<span>\s*<\/td>\s*<td>\s*<span(?:\s+href='([^']*)')?[^>]*>([\s\S]*?)<\/span>\s*<\/td>\s*[\s\S]*?<td\s+class='(text-success|text-danger)'>\s*[\s\S]*?<span>(Passed|Failed)<\/span>\s*<\/td>\s*[\s\S]*?<td>\s*<span>([\s\S]*?)<\/span>\s*<\/td>\s*<td>\s*<span>([\s\S]*?)<\/span>\s*<\/td>\s*<td>\s*<span>([\s\S]*?)<\/span>\s*<\/td>\s*<td>\s*<span[^>]*>([\s\S]*?)<\/span>\s*<\/td>/g;

  const nameCounter = new Map(); // Track duplicates: name -> count

  let match;
  while ((match = rowPattern.exec(content)) !== null) {
    const num = parseInt(match[1]);
    const testId = (match[2] || `row${num}`).trim(); // e.g., "test1445" or fallback "row1"
    const rawName = match[3];
    const status = match[5].trim();
    const runStarted = match[6].trim();
    const durationStr = match[7].trim();
    const failedStep = match[8].trim();

    // Extract a meaningful name:
    // 1. Use the span text if it's a real name (not Untitled/Test #N)
    // 2. Otherwise, derive from failed step description (what the test was actually doing)
    // 3. Fallback: use testId like "test1445"
    let cleanedName = cleanName(rawName);
    if (!cleanedName) {
      // Try to derive name from failed step
      if (failedStep) {
        const stripped = failedStep.replace(/<[^>]*>/g, '').trim();
        // Extract after "N:" prefix: "9:Click 'selectAll'" -> "Click 'selectAll'"
        const stepDesc = stripped.replace(/^\d+:\s*/, '').trim();
        if (stepDesc) {
          // Shorten to ~60 chars
          cleanedName = stepDesc.length > 60 ? stepDesc.slice(0, 60) + '...' : stepDesc;
        }
      }
    }
    // Final fallback: use testId
    if (!cleanedName) {
      cleanedName = mainName + ' (' + testId + ')';
    }

    // Disambiguate duplicates: "Ordering" (repeated) -> "Ordering #1", "Ordering #2"
    const baseName = cleanedName;
    const count = (nameCounter.get(baseName) || 0) + 1;
    nameCounter.set(baseName, count);
    if (count > 1) cleanedName = `${baseName} #${count}`;

    if (!firstRunDate && runStarted) firstRunDate = runStarted;

    const durMatch = durationStr.match(/([\d.]+)\s*Seconds/i);
    const duration = durMatch ? parseFloat(durMatch[1]) : 0;
    totalDuration += duration;

    const isFailed = status === 'Failed';
    const isSlow = duration > 4;

    const failed = [];
    if (isFailed && failedStep) {
      failed.push({
        step: num,
        name: failedStep.replace(/<[^>]*>/g, '').trim(),
        status: 'Failed',
        time: duration,
      });
    }

    subScenarios.push({
      name: cleanedName,
      category: mainName, // Use filename/title as category
      duration,
      totalSteps: 1,
      passedSteps: isFailed ? 0 : 1,
      failedSteps: isFailed ? 1 : 0,
      slowSteps: isSlow ? 1 : 0,
      overall: status,
      failed,
      slow: [],
    });
  }

  const passedCount = subScenarios.filter(s => s.overall === 'Passed').length;
  const failedCount = subScenarios.filter(s => s.overall === 'Failed').length;

  return {
    scenario: mainName,
    device: '',
    runStarted: firstRunDate,
    totalTime: `${Math.round(totalDuration)} seconds`,
    overall: failedCount > 0 ? 'Failed' : 'Passed',
    totalSteps: subScenarios.length,
    passedSteps: passedCount,
    failedSteps: failedCount,
    slowSteps: subScenarios.filter(s => s.slowSteps > 0).length,
    avgDuration: subScenarios.length > 0 ? parseFloat((totalDuration / subScenarios.length).toFixed(2)) : 0,
    skippedCount,
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

  // Pre-extract data-step-counter → screenshot filename mapping
  // Each failed/passed step block has data-step-counter="N" and references a matching N.PNG
  const stepBlockRe = /data-step-counter="(\d+)"[\s\S]*?(?=data-step-counter="|$)/g;
  const stepScreenshotMap = new Map(); // stepCounter -> [screenshot filenames]
  let blockMatch;
  while ((blockMatch = stepBlockRe.exec(content)) !== null) {
    const counter = blockMatch[1];
    const block = blockMatch[0];
    const imgs = [...block.matchAll(/src="[^"]*?\/([^"\/]+\.(?:png|jpg|jpeg|gif|webp))"/gi)]
      .map(m => m[1]);
    if (imgs.length > 0) stepScreenshotMap.set(counter, [...new Set(imgs)]);
  }

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

  // Match each step to its data-step-counter by sequential position
  // (STEP_PATTERN and data-step-counter blocks follow the same order in HTML)
  const counters = [...stepScreenshotMap.keys()];
  allSteps.forEach((s, i) => {
    const counter = counters[i];
    if (counter) {
      s.stepCounter = counter;
      s.screenshots = stepScreenshotMap.get(counter) || [];
    } else {
      s.screenshots = [];
    }
  });

  const subScenariosRaw = [];
  let currentSub = null;
  for (const s of allSteps) {
    const sendMatch = s.name.match(/^Send text '(\d+\.?\s*.+)'$/);
    if (sendMatch) {
      if (currentSub) subScenariosRaw.push(currentSub);
      currentSub = { name: sendMatch[1].replace(/&amp;/g, '&').trim(), steps: [] };
    }
    if (currentSub) currentSub.steps.push(s);
  }
  if (currentSub) subScenariosRaw.push(currentSub);

  let skippedCount = 0;
  const subs = [];
  for (const sub of subScenariosRaw) {
    const cleanedName = cleanName(sub.name);
    if (!cleanedName) { skippedCount++; continue; }
    const failed = sub.steps.filter(s => s.status === 'Failed');
    const passed = sub.steps.filter(s => s.status === 'Passed');
    const slow = sub.steps.filter(s => s.time > 4);
    const duration = sub.steps.reduce((a, s) => a + (s.time || 0), 0);
    subs.push({
      name: cleanedName,
      category: mainName, // Use filename as category
      duration: parseFloat(duration.toFixed(2)),
      totalSteps: sub.steps.length,
      passedSteps: passed.length,
      failedSteps: failed.length,
      slowSteps: slow.length,
      overall: failed.length > 0 ? 'Failed' : 'Passed',
      failed,
      slow,
    });
  }

  const totalDuration = subs.reduce((a, s) => a + (s.duration || 0), 0);

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
    avgDuration: subs.length > 0 ? parseFloat((totalDuration / subs.length).toFixed(2)) : 0,
    skippedCount,
    subScenarios: subs,
  };
}

function parseHTML(content, filename) {
  const format = detectFormat(content);
  if (format === 'vya') {
    return parseVyaReport(content, filename);
  }
  if (format === 'summary') {
    return parseSummaryReport(content, filename);
  }
  return parseIndividualReport(content, filename);
}

// ── XML parsing (Appium Studio test definition files) ────────────────────────
// Extracts scenario names from SendText commands marked with "1.", "2." prefix
function parseXML(content, filename) {
  const mainName = filename.replace(/\.xml$/i, '').replace(/\s+$/, '').trim();
  const subScenarios = [];

  // Match SendText defaultValue="N. name..." (these mark scenario boundaries)
  const pattern = /defaultValue="(\d+\.?\s*[^"]+)"[^>]*description="Text to send"/g;
  const altPattern = /name="SendText\(Text\)".*?defaultValue="(\d+\.?\s*[^"]+)"/gs;

  const matches = new Set();
  let m;
  while ((m = pattern.exec(content)) !== null) matches.add(m[1]);
  altPattern.lastIndex = 0;
  while ((m = altPattern.exec(content)) !== null) matches.add(m[1]);

  const nameCounter = new Map();
  for (const raw of matches) {
    const name = raw.replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>').trim();
    if (!name) continue;
    const baseName = name;
    const count = (nameCounter.get(baseName) || 0) + 1;
    nameCounter.set(baseName, count);
    const finalName = count > 1 ? `${baseName} #${count}` : baseName;

    subScenarios.push({
      name: finalName,
      category: mainName, // Use filename as category (e.g., "filter c-app")
      duration: 0,
      totalSteps: 0,
      passedSteps: 0,
      failedSteps: 0,
      slowSteps: 0,
      overall: 'Passed', // Default — XML is a script definition, no real status available
      failed: [],
      slow: [],
    });
  }

  return {
    scenario: mainName,
    device: '',
    runStarted: '',
    totalTime: '',
    overall: 'Passed',
    totalSteps: 0,
    passedSteps: subScenarios.length,
    failedSteps: 0,
    slowSteps: 0,
    avgDuration: 0,
    skippedCount: 0,
    subScenarios,
  };
}

module.exports = { parseHTML, parseXML, categorize, cleanName };
