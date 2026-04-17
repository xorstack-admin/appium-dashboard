# VYA QA Platform v4 — Implementation Plan

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Transform the existing flat-file Appium dashboard into a full QA platform with Admin + User dashboards, MongoDB storage, Cloudinary file hosting, JWT auth, and real-time Socket.io updates.

**Architecture:** Express backend with Mongoose ODM for MongoDB Atlas, Cloudinary SDK for file/screenshot storage, JWT + bcrypt for auth, Socket.io for real-time push, Multer for upload handling. Two separate frontend dashboards (admin + user) served as static HTML from `/public/admin/` and `/public/dashboard/`.

**Tech Stack:** Node.js, Express, MongoDB (Mongoose), Cloudinary, Socket.io, JWT (jsonwebtoken), bcrypt, Multer

---

## Phase 1: Foundation — Dependencies, Config, Database Models

### Task 1: Install all new dependencies

**Files:**
- Modify: `package.json`

**Step 1: Install production dependencies**

Run:
```bash
npm install mongoose cloudinary multer jsonwebtoken bcryptjs dotenv socket.io
```

**Step 2: Verify package.json updated**

Run:
```bash
node -e "const p=require('./package.json');console.log(Object.keys(p.dependencies).sort().join(', '))"
```
Expected: `bcryptjs, cloudinary, cors, dotenv, express, jsonwebtoken, mongoose, multer, socket.io, xlsx`

**Step 3: Commit**

```bash
git add package.json package-lock.json
git commit -m "chore: add MongoDB, Cloudinary, auth, and Socket.io dependencies"
```

---

### Task 2: Create environment config file

**Files:**
- Create: `.env`
- Modify: `.gitignore`

**Step 1: Create .env file**

```env
# MongoDB Atlas
MONGO_URI=mongodb+srv://<user>:<pass>@cluster.mongodb.net/vya-dashboard?retryWrites=true&w=majority

# Cloudinary
CLOUDINARY_CLOUD_NAME=your_cloud_name
CLOUDINARY_API_KEY=your_api_key
CLOUDINARY_API_SECRET=your_api_secret

# JWT
JWT_SECRET=your-super-secret-key-change-this
JWT_EXPIRES_IN=24h

# Server
PORT=3000
```

**Step 2: Create .gitignore (or append)**

```
node_modules/
.env
```

**Step 3: Commit**

```bash
git add .gitignore
git commit -m "chore: add .gitignore with .env exclusion"
```

---

### Task 3: Create database connection config

**Files:**
- Create: `config/db.js`

**Step 1: Write db.js**

```javascript
const mongoose = require('mongoose');

async function connectDB() {
  try {
    const conn = await mongoose.connect(process.env.MONGO_URI);
    console.log(`MongoDB connected: ${conn.connection.host}`);
  } catch (err) {
    console.error('MongoDB connection error:', err.message);
    process.exit(1);
  }
}

module.exports = connectDB;
```

**Step 2: Commit**

```bash
git add config/db.js
git commit -m "feat: add MongoDB connection config"
```

---

### Task 4: Create Cloudinary config

**Files:**
- Create: `config/cloudinary.js`

**Step 1: Write cloudinary.js**

```javascript
const cloudinary = require('cloudinary').v2;

cloudinary.config({
  cloud_name: process.env.CLOUDINARY_CLOUD_NAME,
  api_key: process.env.CLOUDINARY_API_KEY,
  api_secret: process.env.CLOUDINARY_API_SECRET,
});

module.exports = cloudinary;
```

**Step 2: Commit**

```bash
git add config/cloudinary.js
git commit -m "feat: add Cloudinary config"
```

---

### Task 5: Create all Mongoose models

**Files:**
- Create: `models/User.js`
- Create: `models/Report.js`
- Create: `models/Scenario.js`
- Create: `models/ActivityLog.js`
- Create: `models/Setting.js`
- Create: `models/Alert.js`

**Step 1: Write User.js**

```javascript
const mongoose = require('mongoose');
const bcrypt = require('bcryptjs');

const userSchema = new mongoose.Schema({
  name:      { type: String, required: true, trim: true },
  email:     { type: String, required: true, unique: true, lowercase: true, trim: true },
  password:  { type: String, required: true, minlength: 6 },
  role:      { type: String, enum: ['admin', 'viewer'], default: 'viewer' },
  createdBy: { type: mongoose.Schema.Types.ObjectId, ref: 'User', default: null },
  lastLogin: { type: Date, default: null },
}, { timestamps: true });

userSchema.pre('save', async function (next) {
  if (!this.isModified('password')) return next();
  this.password = await bcrypt.hash(this.password, 10);
  next();
});

userSchema.methods.comparePassword = async function (candidate) {
  return bcrypt.compare(candidate, this.password);
};

userSchema.methods.toJSON = function () {
  const obj = this.toObject();
  delete obj.password;
  return obj;
};

module.exports = mongoose.model('User', userSchema);
```

**Step 2: Write Report.js**

```javascript
const mongoose = require('mongoose');

const failedStepSchema = new mongoose.Schema({
  step: Number, name: String, status: String, time: Number,
}, { _id: false });

const subScenarioSchema = new mongoose.Schema({
  name: String,
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
  version:   { type: String, required: true },
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
reportSchema.index({ env: 1, platform: 1, version: 1 }, { unique: true });

module.exports = mongoose.model('Report', reportSchema);
```

**Step 3: Write Scenario.js**

```javascript
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
```

**Step 4: Write ActivityLog.js**

```javascript
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
```

**Step 5: Write Setting.js**

```javascript
const mongoose = require('mongoose');

const settingSchema = new mongoose.Schema({
  key:       { type: String, required: true, unique: true },
  value:     { type: mongoose.Schema.Types.Mixed, required: true },
  updatedBy: { type: mongoose.Schema.Types.ObjectId, ref: 'User' },
}, { timestamps: true });

module.exports = mongoose.model('Setting', settingSchema);
```

**Step 6: Write Alert.js**

```javascript
const mongoose = require('mongoose');

const alertSchema = new mongoose.Schema({
  type:      { type: String, enum: ['pass_rate_drop', 'new_report'], required: true },
  condition: { type: mongoose.Schema.Types.Mixed, default: {} },
  enabled:   { type: Boolean, default: true },
  createdBy: { type: mongoose.Schema.Types.ObjectId, ref: 'User' },
}, { timestamps: true });

module.exports = mongoose.model('Alert', alertSchema);
```

**Step 7: Commit**

```bash
git add models/
git commit -m "feat: add all Mongoose models (User, Report, Scenario, ActivityLog, Setting, Alert)"
```

---

## Phase 2: Auth System — Middleware, Routes, Seed Script

### Task 6: Create auth middleware

**Files:**
- Create: `middleware/auth.js`

**Step 1: Write auth.js with JWT verify + role check**

```javascript
const jwt = require('jsonwebtoken');
const User = require('../models/User');

async function auth(req, res, next) {
  const header = req.headers.authorization;
  if (!header || !header.startsWith('Bearer '))
    return res.status(401).json({ error: 'No token provided' });

  try {
    const decoded = jwt.verify(header.split(' ')[1], process.env.JWT_SECRET);
    const user = await User.findById(decoded.id).select('-password');
    if (!user) return res.status(401).json({ error: 'User not found' });
    req.user = user;
    next();
  } catch (err) {
    return res.status(401).json({ error: 'Invalid token' });
  }
}

function adminOnly(req, res, next) {
  if (req.user.role !== 'admin')
    return res.status(403).json({ error: 'Admin access required' });
  next();
}

module.exports = { auth, adminOnly };
```

**Step 2: Commit**

```bash
git add middleware/auth.js
git commit -m "feat: add JWT auth and adminOnly middleware"
```

---

### Task 7: Create upload middleware

**Files:**
- Create: `middleware/upload.js`

**Step 1: Write upload.js with Multer memory storage**

```javascript
const multer = require('multer');

const storage = multer.memoryStorage();

const upload = multer({
  storage,
  limits: { fileSize: 25 * 1024 * 1024 }, // 25MB per file
  fileFilter(req, file, cb) {
    const allowed = ['.html', '.xml', '.json', '.png', '.jpg', '.jpeg', '.gif', '.webp'];
    const ext = '.' + file.originalname.split('.').pop().toLowerCase();
    if (allowed.includes(ext)) cb(null, true);
    else cb(new Error(`File type ${ext} not allowed`));
  },
});

module.exports = upload;
```

**Step 2: Commit**

```bash
git add middleware/upload.js
git commit -m "feat: add Multer upload middleware with memory storage"
```

---

### Task 8: Create auth routes

**Files:**
- Create: `routes/auth.js`

**Step 1: Write auth routes (login, register, me)**

```javascript
const express = require('express');
const jwt = require('jsonwebtoken');
const User = require('../models/User');
const ActivityLog = require('../models/ActivityLog');
const { auth, adminOnly } = require('../middleware/auth');

const router = express.Router();

// POST /api/auth/login
router.post('/login', async (req, res) => {
  try {
    const { email, password } = req.body;
    if (!email || !password)
      return res.status(400).json({ error: 'Email and password required' });

    const user = await User.findOne({ email: email.toLowerCase().trim() });
    if (!user || !(await user.comparePassword(password)))
      return res.status(401).json({ error: 'Invalid credentials' });

    user.lastLogin = new Date();
    await user.save();

    const token = jwt.sign({ id: user._id, role: user.role }, process.env.JWT_SECRET,
      { expiresIn: process.env.JWT_EXPIRES_IN || '24h' });

    await ActivityLog.create({
      action: 'login', user: user._id, userName: user.name, target: user.email,
    });

    res.json({ token, user: user.toJSON() });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// POST /api/auth/register (admin only)
router.post('/register', auth, adminOnly, async (req, res) => {
  try {
    const { name, email, password, role } = req.body;
    if (!name || !email || !password)
      return res.status(400).json({ error: 'Name, email, and password required' });

    const exists = await User.findOne({ email: email.toLowerCase().trim() });
    if (exists) return res.status(409).json({ error: 'Email already registered' });

    const user = await User.create({
      name, email, password, role: role || 'viewer', createdBy: req.user._id,
    });

    await ActivityLog.create({
      action: 'user_create', user: req.user._id, userName: req.user.name,
      target: `${user.name} (${user.email})`, details: { role: user.role },
    });

    res.status(201).json({ user: user.toJSON() });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// GET /api/auth/me
router.get('/me', auth, (req, res) => {
  res.json({ user: req.user });
});

module.exports = router;
```

**Step 2: Commit**

```bash
git add routes/auth.js
git commit -m "feat: add auth routes (login, register, me)"
```

---

### Task 9: Create admin seed script

**Files:**
- Create: `scripts/seed_admin.js`

**Step 1: Write seed_admin.js**

```javascript
require('dotenv').config();
const mongoose = require('mongoose');
const User = require('../models/User');

async function seed() {
  await mongoose.connect(process.env.MONGO_URI);

  const existing = await User.findOne({ role: 'admin' });
  if (existing) {
    console.log(`Admin already exists: ${existing.email}`);
    process.exit(0);
  }

  const admin = await User.create({
    name: 'Admin',
    email: 'admin@carpacsoft.com',
    password: 'admin123',
    role: 'admin',
  });

  console.log(`Admin created: ${admin.email}`);
  console.log('Default password: admin123 — change it after first login!');
  process.exit(0);
}

seed().catch(err => { console.error(err); process.exit(1); });
```

**Step 2: Commit**

```bash
git add scripts/seed_admin.js
git commit -m "feat: add admin seed script"
```

---

## Phase 3: Services — Parser, Cloudinary, Alerts

### Task 10: Create Cloudinary upload service

**Files:**
- Create: `services/cloudinaryService.js`

**Step 1: Write cloudinaryService.js**

```javascript
const cloudinary = require('../config/cloudinary');

async function uploadBuffer(buffer, options = {}) {
  return new Promise((resolve, reject) => {
    const stream = cloudinary.uploader.upload_stream(
      {
        folder: options.folder || 'vya-reports',
        resource_type: options.resourceType || 'auto',
        public_id: options.publicId,
      },
      (err, result) => {
        if (err) reject(err);
        else resolve({ url: result.secure_url, publicId: result.public_id, size: result.bytes });
      }
    );
    stream.end(buffer);
  });
}

async function deleteFile(publicId, resourceType = 'raw') {
  return cloudinary.uploader.destroy(publicId, { resource_type: resourceType });
}

module.exports = { uploadBuffer, deleteFile };
```

**Step 2: Commit**

```bash
git add services/cloudinaryService.js
git commit -m "feat: add Cloudinary upload/delete service"
```

---

### Task 11: Port the Python HTML parser to Node.js

**Files:**
- Create: `services/parser.js`

**Step 1: Write parser.js — direct port of save_report.py parsing logic**

```javascript
const STEP_PATTERN = /<h3 class="page-header">(.*?)<\/h3>\s*(?:<div class="alert alert-danger"[^>]*>.*?<\/div>)?\s*.*?<div class="panel panel-(success|danger)">\s*<div class="panel-heading">\s*<span[^>]*><\/span>(Passed|Failed)\s*<\/div>.*?Total Time:\s*([\d.]+)\s*Seconds/gs;

function parseHTML(content, filename) {
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

  // Group into sub-scenarios by "Send text" markers
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

module.exports = { parseHTML };
```

**Step 2: Commit**

```bash
git add services/parser.js
git commit -m "feat: port Python HTML report parser to Node.js"
```

---

### Task 12: Create alert service

**Files:**
- Create: `services/alertService.js`

**Step 1: Write alertService.js**

```javascript
const Alert = require('../models/Alert');
const Setting = require('../models/Setting');

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
```

**Step 2: Commit**

```bash
git add services/alertService.js
git commit -m "feat: add alert checking service"
```

---

## Phase 4: Admin API Routes

### Task 13: Create admin routes — upload, reports CRUD

**Files:**
- Create: `routes/admin.js`

**Step 1: Write admin.js with all admin endpoints**

```javascript
const express = require('express');
const { auth, adminOnly } = require('../middleware/auth');
const upload = require('../middleware/upload');
const Report = require('../models/Report');
const Scenario = require('../models/Scenario');
const User = require('../models/User');
const ActivityLog = require('../models/ActivityLog');
const Setting = require('../models/Setting');
const Alert = require('../models/Alert');
const { parseHTML } = require('../services/parser');
const { uploadBuffer, deleteFile } = require('../services/cloudinaryService');
const { checkAlerts } = require('../services/alertService');

const router = express.Router();

// All admin routes require auth + admin role
router.use(auth, adminOnly);

// ── Upload Report ────────────────────────────────────────────────────────────
router.post('/upload', upload.array('files', 20), async (req, res) => {
  try {
    const { env, platform, version, label, notes } = req.body;
    if (!env || !platform || !version)
      return res.status(400).json({ error: 'env, platform, and version are required' });

    const existing = await Report.findOne({ env, platform, version });
    if (existing)
      return res.status(409).json({ error: `Report ${env}/${platform}/${version} already exists` });

    const files = req.files || [];
    const htmlFiles = files.filter(f => f.originalname.endsWith('.html'));
    const otherFiles = files.filter(f => !f.originalname.endsWith('.html'));

    // Parse HTML reports
    const scenarioRuns = [];
    for (const file of htmlFiles) {
      const content = file.buffer.toString('utf-8');
      scenarioRuns.push(parseHTML(content, file.originalname));
    }

    // Upload all files to Cloudinary
    const fileRefs = [];
    for (const file of files) {
      const isImage = /\.(png|jpg|jpeg|gif|webp)$/i.test(file.originalname);
      const result = await uploadBuffer(file.buffer, {
        folder: `vya-reports/${env}/${platform}/${version}`,
        resourceType: isImage ? 'image' : 'raw',
        publicId: file.originalname.replace(/\.[^.]+$/, ''),
      });
      fileRefs.push({
        type: isImage ? 'screenshot' : 'raw_report',
        url: result.url,
        publicId: result.publicId,
        originalName: file.originalname,
        size: result.size,
      });
    }

    // Enrich with scenario categories
    const scenarioDoc = await Scenario.findOne({ platform });
    const idx = scenarioDoc ? buildScenarioIndex(scenarioDoc) : new Map();

    for (const run of scenarioRuns) {
      for (const sub of run.subScenarios || []) {
        const match = matchScenario(sub.name, idx);
        if (match) {
          sub.categoryId = match.categoryId;
          sub.categoryName = match.categoryName;
          sub.scenarioId = match.scenarioId;
          sub.sourceFile = match.sourceFile;
        }
      }
    }

    // Calculate totals
    const allSubs = scenarioRuns.flatMap(r => r.subScenarios || []);
    const totalPassed = allSubs.filter(s => s.overall === 'Passed').length;
    const totalFailed = allSubs.filter(s => s.overall === 'Failed').length;
    const totalScenarios = allSubs.length;
    const passRate = totalScenarios > 0
      ? parseFloat(((totalPassed / totalScenarios) * 100).toFixed(1))
      : null;

    const report = await Report.create({
      env, platform, version,
      label: label || version,
      notes: notes || '',
      scenarios: scenarioRuns,
      passRate, totalPassed, totalFailed, totalScenarios,
      files: fileRefs,
      uploadedBy: req.user._id,
      runDate: scenarioRuns[0]?.runStarted ? new Date(scenarioRuns[0].runStarted) : new Date(),
    });

    await ActivityLog.create({
      action: 'upload', user: req.user._id, userName: req.user.name,
      target: `${env}/${platform}/${version}`,
      details: { passRate, totalPassed, totalFailed, totalScenarios },
    });

    // Emit real-time update + check alerts
    const io = req.app.get('io');
    if (io) io.emit('new-report', { id: report._id, env, platform, version, passRate, label: report.label });
    await checkAlerts(report, io);

    res.status(201).json({ report });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ── Reports CRUD ─────────────────────────────────────────────────────────────
router.get('/reports', async (req, res) => {
  try {
    const { env, platform } = req.query;
    const filter = {};
    if (env) filter.env = env;
    if (platform) filter.platform = platform;
    const reports = await Report.find(filter).select('-scenarios').sort({ createdAt: -1 }).populate('uploadedBy', 'name email');
    res.json({ reports });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

router.put('/reports/:id', async (req, res) => {
  try {
    const { label, notes } = req.body;
    const report = await Report.findByIdAndUpdate(req.params.id, { label, notes }, { new: true }).select('-scenarios');
    if (!report) return res.status(404).json({ error: 'Report not found' });

    await ActivityLog.create({
      action: 'edit', user: req.user._id, userName: req.user.name,
      target: `${report.env}/${report.platform}/${report.version}`,
    });

    res.json({ report });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

router.delete('/reports/:id', async (req, res) => {
  try {
    const report = await Report.findById(req.params.id);
    if (!report) return res.status(404).json({ error: 'Report not found' });

    // Delete Cloudinary files
    for (const file of report.files || []) {
      const resourceType = file.type === 'screenshot' ? 'image' : 'raw';
      await deleteFile(file.publicId, resourceType).catch(() => {});
    }

    await Report.findByIdAndDelete(req.params.id);

    await ActivityLog.create({
      action: 'delete', user: req.user._id, userName: req.user.name,
      target: `${report.env}/${report.platform}/${report.version}`,
    });

    const io = req.app.get('io');
    if (io) io.emit('report-deleted', { id: report._id, env: report.env, platform: report.platform, version: report.version });

    res.json({ success: true });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// ── Scenario Management ──────────────────────────────────────────────────────
router.get('/scenarios/:platform', async (req, res) => {
  try {
    const doc = await Scenario.findOne({ platform: req.params.platform });
    res.json(doc || { platform: req.params.platform, categories: [], totalActive: 0 });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

router.put('/scenarios/:platform', async (req, res) => {
  try {
    const { categories } = req.body;
    const totalActive = categories.reduce((sum, cat) =>
      sum + (cat.scenarios || []).filter(s => s.status !== 'deprecated').length, 0);

    const doc = await Scenario.findOneAndUpdate(
      { platform: req.params.platform },
      { categories, totalActive, updatedBy: req.user._id },
      { new: true, upsert: true }
    );

    await ActivityLog.create({
      action: 'scenario_update', user: req.user._id, userName: req.user.name,
      target: `${req.params.platform} scenarios`, details: { totalActive },
    });

    res.json(doc);
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// ── User Management ──────────────────────────────────────────────────────────
router.get('/users', async (req, res) => {
  try {
    const users = await User.find().select('-password').sort({ createdAt: -1 });
    res.json({ users });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

router.put('/users/:id', async (req, res) => {
  try {
    const { name, role } = req.body;
    const update = {};
    if (name) update.name = name;
    if (role) update.role = role;
    const user = await User.findByIdAndUpdate(req.params.id, update, { new: true }).select('-password');
    if (!user) return res.status(404).json({ error: 'User not found' });
    res.json({ user });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

router.delete('/users/:id', async (req, res) => {
  try {
    if (req.params.id === req.user._id.toString())
      return res.status(400).json({ error: 'Cannot delete yourself' });

    const user = await User.findByIdAndDelete(req.params.id);
    if (!user) return res.status(404).json({ error: 'User not found' });

    await ActivityLog.create({
      action: 'user_delete', user: req.user._id, userName: req.user.name,
      target: `${user.name} (${user.email})`,
    });

    res.json({ success: true });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// ── Activity Logs ────────────────────────────────────────────────────────────
router.get('/logs', async (req, res) => {
  try {
    const limit = parseInt(req.query.limit) || 100;
    const logs = await ActivityLog.find().sort({ createdAt: -1 }).limit(limit);
    res.json({ logs });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// ── Settings ─────────────────────────────────────────────────────────────────
router.get('/settings', async (req, res) => {
  try {
    const settings = await Setting.find();
    const obj = {};
    settings.forEach(s => { obj[s.key] = s.value; });
    res.json(obj);
  } catch (err) { res.status(500).json({ error: err.message }); }
});

router.put('/settings', async (req, res) => {
  try {
    const entries = Object.entries(req.body);
    for (const [key, value] of entries) {
      await Setting.findOneAndUpdate({ key }, { value, updatedBy: req.user._id }, { upsert: true });
    }
    await ActivityLog.create({
      action: 'settings_change', user: req.user._id, userName: req.user.name,
      target: 'System settings', details: req.body,
    });
    res.json({ success: true });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// ── Alerts ───────────────────────────────────────────────────────────────────
router.get('/alerts', async (req, res) => {
  try {
    const alerts = await Alert.find().sort({ createdAt: -1 });
    res.json({ alerts });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

router.post('/alerts', async (req, res) => {
  try {
    const alert = await Alert.create({ ...req.body, createdBy: req.user._id });
    res.status(201).json({ alert });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

router.put('/alerts/:id', async (req, res) => {
  try {
    const alert = await Alert.findByIdAndUpdate(req.params.id, req.body, { new: true });
    if (!alert) return res.status(404).json({ error: 'Alert not found' });
    res.json({ alert });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

router.delete('/alerts/:id', async (req, res) => {
  try {
    await Alert.findByIdAndDelete(req.params.id);
    res.json({ success: true });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// ── Helpers (same logic as server.js) ────────────────────────────────────────
function norm(s) {
  return String(s).toLowerCase().replace(/[''`]/g, '').replace(/[^a-z0-9]+/g, ' ').trim();
}

function buildScenarioIndex(master) {
  const idx = new Map();
  for (const cat of master.categories || []) {
    for (const sc of cat.scenarios || []) {
      const entry = { categoryId: cat.id, categoryName: cat.name, scenarioId: sc.id, scenarioName: sc.name, sourceFile: sc.sourceFile };
      idx.set(norm(sc.name), entry);
      if (sc.originalMarker) idx.set(norm(sc.originalMarker), entry);
    }
  }
  return idx;
}

function matchScenario(name, idx) {
  const key = norm(name);
  if (idx.has(key)) return idx.get(key);
  const stripped = key.replace(/^\d+\.?\s+/, '');
  if (idx.has(stripped)) return idx.get(stripped);
  let best = null, bestScore = 0;
  for (const [k, v] of idx) {
    const words = stripped.split(' ').filter(w => w.length > 3);
    if (!words.length) continue;
    const score = words.filter(w => k.includes(w)).length / words.length;
    if (score > bestScore && score > 0.5) { best = v; bestScore = score; }
  }
  return best;
}

module.exports = router;
```

**Step 2: Commit**

```bash
git add routes/admin.js
git commit -m "feat: add admin routes (upload, reports CRUD, scenarios, users, settings, alerts, logs)"
```

---

## Phase 5: Dashboard API Routes + Export

### Task 14: Create dashboard (user-facing) routes

**Files:**
- Create: `routes/dashboard.js`

**Step 1: Write dashboard.js — read-only routes pulling from MongoDB**

```javascript
const express = require('express');
const { auth } = require('../middleware/auth');
const Report = require('../models/Report');
const Scenario = require('../models/Scenario');

const router = express.Router();

router.use(auth);

const VALID_ENVS = ['staging', 'production'];
const VALID_PLATFORMS = ['ios', 'android'];

function validateEP(req, res, next) {
  const { env, platform } = req.params;
  if (!VALID_ENVS.includes(env)) return res.status(400).json({ error: `Invalid env "${env}"` });
  if (!VALID_PLATFORMS.includes(platform)) return res.status(400).json({ error: `Invalid platform "${platform}"` });
  next();
}

// Overview — latest pass rate for all 4 combos
router.get('/overview', async (req, res) => {
  try {
    const result = {};
    for (const env of VALID_ENVS) {
      result[env] = {};
      for (const platform of VALID_PLATFORMS) {
        const latest = await Report.findOne({ env, platform })
          .select('version label passRate totalPassed totalFailed totalScenarios createdAt runDate')
          .sort({ createdAt: -1 });
        const totalReports = await Report.countDocuments({ env, platform });
        if (!latest) { result[env][platform] = null; continue; }
        result[env][platform] = {
          version: latest.version, label: latest.label,
          savedAt: latest.createdAt, runDate: latest.runDate,
          passRate: latest.passRate, passed: latest.totalPassed,
          failed: latest.totalFailed, totalReports,
        };
      }
    }
    res.json(result);
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// Versions list
router.get('/:env/:platform/versions', validateEP, async (req, res) => {
  try {
    const { env, platform } = req.params;
    const reports = await Report.find({ env, platform })
      .select('version label createdAt runDate passRate totalPassed totalFailed totalScenarios')
      .sort({ createdAt: -1 });
    const versions = reports.map(r => ({
      version: r.version, label: r.label, savedAt: r.createdAt,
      runDate: r.runDate, passRate: r.passRate,
      passed: r.totalPassed, failed: r.totalFailed,
    }));
    res.json({ versions });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// Full report
router.get('/:env/:platform/report/:version', validateEP, async (req, res) => {
  try {
    const { env, platform, version } = req.params;
    const report = await Report.findOne({ env, platform, version });
    if (!report) return res.status(404).json({ error: `Version "${version}" not found` });

    const scenarioDoc = await Scenario.findOne({ platform });
    const byCategory = rollupByCategory(
      report.scenarios.flatMap(r => r.subScenarios || []),
      scenarioDoc || { categories: [] }
    );

    res.json({ report: report.scenarios, byCategory, files: report.files });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// Scenarios master list
router.get('/:env/:platform/scenarios', validateEP, async (req, res) => {
  try {
    const doc = await Scenario.findOne({ platform: req.params.platform });
    res.json(doc || { platform: req.params.platform, categories: [], totalActive: 0 });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// Daily trend
router.get('/:env/:platform/daily', validateEP, async (req, res) => {
  try {
    const { env, platform } = req.params;
    const { from, to } = req.query;
    const filter = { env, platform };
    if (from || to) {
      filter.runDate = {};
      if (from) filter.runDate.$gte = new Date(from);
      if (to) filter.runDate.$lte = new Date(to + 'T23:59:59Z');
    }

    const reports = await Report.find(filter)
      .select('version label createdAt runDate passRate totalPassed totalFailed totalScenarios scenarios')
      .sort({ createdAt: 1 });

    const byDate = new Map();
    for (const r of reports) {
      const dateKey = r.runDate ? r.runDate.toISOString().slice(0, 10) : r.createdAt.toISOString().slice(0, 10);
      if (!byDate.has(dateKey)) byDate.set(dateKey, []);
      byDate.get(dateKey).push(r);
    }

    const days = [];
    for (const [date, builds] of byDate) {
      const last = builds[builds.length - 1];
      const allSubs = last.scenarios.flatMap(r => r.subScenarios || []);
      const p = allSubs.filter(s => s.overall === 'Passed').length;
      const f = allSubs.filter(s => s.overall === 'Failed').length;
      const t = allSubs.length;

      const progression = builds.map(b => ({
        version: b.version, savedAt: b.createdAt,
        passRate: b.passRate,
      }));

      const first = progression[0]?.passRate ?? null;
      const lastRate = progression[progression.length - 1]?.passRate ?? null;

      days.push({
        date, buildCount: builds.length,
        firstVersion: builds[0].version, lastVersion: last.version,
        improvement: (first !== null && lastRate !== null) ? parseFloat((lastRate - first).toFixed(1)) : null,
        endOfDay: { passed: p, failed: f, total: t, passRate: t > 0 ? parseFloat(((p / t) * 100).toFixed(1)) : 0 },
        progression,
      });
    }
    days.sort((a, b) => b.date.localeCompare(a.date));
    res.json({ days, total: days.length });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

function rollupByCategory(subs, master) {
  const map = new Map();
  for (const cat of master.categories || []) {
    map.set(cat.id, { categoryId: cat.id, categoryName: cat.name,
      masterTotal: (cat.scenarios || []).length, run: 0, passed: 0, failed: 0, notRun: 0, passRate: null, subScenarios: [] });
  }
  map.set(0, { categoryId: 0, categoryName: 'Uncategorized', masterTotal: 0, run: 0, passed: 0, failed: 0, notRun: 0, passRate: null, subScenarios: [] });

  for (const sub of subs) {
    const cid = sub.categoryId || 0;
    if (!map.has(cid)) map.set(cid, { categoryId: cid, categoryName: sub.categoryName || 'Uncategorized', masterTotal: 0, run: 0, passed: 0, failed: 0, notRun: 0, passRate: null, subScenarios: [] });
    const e = map.get(cid);
    e.run++;
    e.subScenarios.push(sub);
    if (sub.overall === 'Passed') e.passed++; else e.failed++;
  }

  for (const cat of master.categories || []) {
    const e = map.get(cat.id);
    if (e) {
      e.notRun = Math.max(0, e.masterTotal - e.run);
      e.passRate = e.run > 0 ? parseFloat(((e.passed / e.run) * 100).toFixed(1)) : null;
    }
  }
  if (map.get(0)?.run === 0) map.delete(0);
  return [...map.values()];
}

module.exports = router;
```

**Step 2: Commit**

```bash
git add routes/dashboard.js
git commit -m "feat: add user dashboard read-only routes with MongoDB queries"
```

---

### Task 15: Create export routes

**Files:**
- Create: `routes/export.js`

**Step 1: Write export.js — CSV and XLSX export from MongoDB**

```javascript
const express = require('express');
const { auth } = require('../middleware/auth');
const Report = require('../models/Report');
let XLSX; try { XLSX = require('xlsx'); } catch (_) { XLSX = null; }

const router = express.Router();
router.use(auth);

function buildCSV(rows) {
  const hdr = ['Environment','Platform','Build Version','Run Date','Category','Scenario ID','Scenario Name','Status','Total Steps','Passed Steps','Failed Steps','Slow Steps'];
  const lines = [hdr.join(',')];
  for (const r of rows) {
    lines.push([
      `"${r.env||''}"`, `"${r.platform||''}"`, `"${r.version||''}"`, `"${r.runDate||''}"`,
      `"${r.category||''}"`, `"${r.scenarioId||''}"`, `"${(r.name||'').replace(/"/g,'""')}"`,
      `"${r.status||''}"`, r.totalSteps||0, r.passedSteps||0, r.failedSteps||0, r.slowSteps||0
    ].join(','));
  }
  return lines.join('\r\n');
}

function buildXLSX(rows, sheetName) {
  if (!XLSX) return null;
  const headers = ['Environment','Platform','Build Version','Run Date','Category','Scenario ID','Scenario Name','Status','Total Steps','Passed Steps','Failed Steps','Slow Steps'];
  const data = [headers, ...rows.map(r => [r.env, r.platform, r.version, r.runDate, r.category, r.scenarioId, r.name, r.status, r.totalSteps||0, r.passedSteps||0, r.failedSteps||0, r.slowSteps||0])];
  const wb = XLSX.utils.book_new();
  const ws = XLSX.utils.aoa_to_sheet(data);
  ws['!cols'] = [12,10,16,12,28,12,48,10,12,14,14,12].map(w => ({ wch: w }));
  XLSX.utils.book_append_sheet(wb, ws, sheetName || 'Results');
  return XLSX.write(wb, { type: 'buffer', bookType: 'xlsx' });
}

function toRows(report) {
  const rows = [];
  const runDate = report.runDate ? report.runDate.toISOString().slice(0, 10) : '';
  for (const sc of report.scenarios || []) {
    for (const sub of sc.subScenarios || []) {
      rows.push({
        env: report.env, platform: report.platform, version: report.version, runDate,
        category: sub.categoryName || 'Uncategorized', scenarioId: sub.scenarioId || '',
        name: sub.name, status: sub.overall,
        totalSteps: sub.totalSteps, passedSteps: sub.passedSteps,
        failedSteps: sub.failedSteps, slowSteps: sub.slowSteps,
      });
    }
  }
  return rows;
}

// CSV single
router.get('/:env/:platform/:version/csv', async (req, res) => {
  try {
    const report = await Report.findOne(req.params);
    if (!report) return res.status(404).json({ error: 'Not found' });
    res.setHeader('Content-Type', 'text/csv');
    res.setHeader('Content-Disposition', `attachment; filename="${report.env}-${report.platform}-${report.version}.csv"`);
    res.send(buildCSV(toRows(report)));
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// XLSX single
router.get('/:env/:platform/:version/xlsx', async (req, res) => {
  if (!XLSX) return res.status(500).json({ error: 'xlsx not installed' });
  try {
    const report = await Report.findOne(req.params);
    if (!report) return res.status(404).json({ error: 'Not found' });
    const buf = buildXLSX(toRows(report), report.version.slice(0, 31));
    res.setHeader('Content-Type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
    res.setHeader('Content-Disposition', `attachment; filename="${report.env}-${report.platform}-${report.version}.xlsx"`);
    res.send(buf);
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// CSV range
router.get('/:env/:platform/range/csv', async (req, res) => {
  try {
    const { env, platform } = req.params;
    const { from, to } = req.query;
    const filter = { env, platform };
    if (from || to) { filter.runDate = {}; if (from) filter.runDate.$gte = new Date(from); if (to) filter.runDate.$lte = new Date(to + 'T23:59:59Z'); }
    const reports = await Report.find(filter).sort({ createdAt: -1 });
    const allRows = reports.flatMap(r => toRows(r));
    const name = (from && to) ? `${env}-${platform}-${from}-to-${to}` : `${env}-${platform}-all`;
    res.setHeader('Content-Type', 'text/csv');
    res.setHeader('Content-Disposition', `attachment; filename="${name}.csv"`);
    res.send(buildCSV(allRows));
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// XLSX range
router.get('/:env/:platform/range/xlsx', async (req, res) => {
  if (!XLSX) return res.status(500).json({ error: 'xlsx not installed' });
  try {
    const { env, platform } = req.params;
    const { from, to } = req.query;
    const filter = { env, platform };
    if (from || to) { filter.runDate = {}; if (from) filter.runDate.$gte = new Date(from); if (to) filter.runDate.$lte = new Date(to + 'T23:59:59Z'); }
    const reports = await Report.find(filter).sort({ createdAt: -1 });
    const allRows = reports.flatMap(r => toRows(r));
    const sheetName = (from && to) ? `${from} to ${to}`.slice(0, 31) : `${env}-${platform}`;
    const name = (from && to) ? `${env}-${platform}-${from}-to-${to}` : `${env}-${platform}-all`;
    const buf = buildXLSX(allRows, sheetName);
    res.setHeader('Content-Type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
    res.setHeader('Content-Disposition', `attachment; filename="${name}.xlsx"`);
    res.send(buf);
  } catch (err) { res.status(500).json({ error: err.message }); }
});

module.exports = router;
```

**Step 2: Commit**

```bash
git add routes/export.js
git commit -m "feat: add CSV and XLSX export routes from MongoDB"
```

---

## Phase 6: Rewrite server.js — Wire Everything Together

### Task 16: Rewrite server.js as the main entry point

**Files:**
- Modify: `server.js`

**Step 1: Rewrite server.js to use MongoDB, routes, and Socket.io**

Replace the entire server.js with:

```javascript
require('dotenv').config();
const express = require('express');
const http = require('http');
const path = require('path');
const cors = require('cors');
const { Server } = require('socket.io');
const connectDB = require('./config/db');

const app = express();
const server = http.createServer(app);
const io = new Server(server, { cors: { origin: '*' } });

const PORT = process.env.PORT || 3000;

// Store io on app for route access
app.set('io', io);

// Middleware
app.use(cors());
app.use(express.json({ limit: '50mb' }));

// Static files
app.use(express.static(path.join(__dirname, 'public')));

// Routes
app.use('/api/auth', require('./routes/auth'));
app.use('/api/admin', require('./routes/admin'));
app.use('/api/dashboard', require('./routes/dashboard'));
app.use('/api/export', require('./routes/export'));

// Health check
app.get('/health', (req, res) => res.json({ status: 'ok', time: new Date().toISOString() }));

// SPA fallback — serve login for unknown routes
app.get('*', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

// Socket.io connection
io.on('connection', (socket) => {
  console.log('Client connected:', socket.id);
  socket.on('disconnect', () => console.log('Client disconnected:', socket.id));
});

// Start
async function start() {
  await connectDB();
  server.listen(PORT, () => {
    console.log(`\nVYA QA Platform v4  →  http://localhost:${PORT}\n`);
  });
}

start();
```

**Step 2: Commit**

```bash
git add server.js
git commit -m "feat: rewrite server.js with MongoDB, Socket.io, and route mounting"
```

---

## Phase 7: Login Page UI

### Task 17: Replace index.html with login page

**Files:**
- Modify: `public/index.html`

**Step 1: Rewrite index.html as the login page that redirects by role**

Full login page with:
- Email + password form
- JWT stored in localStorage
- On success: admin → /admin/, viewer → /dashboard/
- Clean dark theme matching existing design

**Step 2: Commit**

```bash
git add public/index.html
git commit -m "feat: replace landing page with auth login page"
```

---

## Phase 8: Admin Dashboard UI

### Task 18: Create admin dashboard HTML

**Files:**
- Create: `public/admin/index.html`

**Step 1: Build admin dashboard with these sections:**

- **Sidebar navigation**: Dashboard, Upload, Reports, Scenarios, Users, Settings, Alerts, Logs
- **Upload section**: Drag-and-drop zone, env/platform/version selectors, file list, upload button
- **Reports section**: Table of all reports with edit/delete actions
- **Scenarios section**: Tree view of categories → scenarios with add/edit/delete
- **Users section**: User list with role management
- **Settings section**: Threshold inputs, refresh interval
- **Alerts section**: Alert rules with enable/disable toggle
- **Logs section**: Activity log table with filters
- **Socket.io listener**: Real-time notification bar

**Step 2: Commit**

```bash
git add public/admin/
git commit -m "feat: add admin dashboard UI with all management sections"
```

---

## Phase 9: User Dashboard UI

### Task 19: Create user dashboard HTML

**Files:**
- Create: `public/dashboard/index.html`

**Step 1: Adapt the existing dashboard.html into /dashboard/index.html**

Changes from original:
- Add JWT token to all API calls (`Authorization: Bearer` header)
- Change API base from `/api/{env}/{platform}` to `/api/dashboard/{env}/{platform}`
- Change export URLs from `/api/{env}/{platform}/export` to `/api/export/{env}/{platform}`
- Add Socket.io client for real-time updates
- Add logout button
- Remove any edit/upload capabilities
- Keep all existing chart/table/category rendering logic intact

**Step 2: Commit**

```bash
git add public/dashboard/
git commit -m "feat: add user dashboard UI with auth and real-time updates"
```

---

## Phase 10: Data Migration + Seed

### Task 20: Create migration script for existing flat-file data

**Files:**
- Create: `scripts/migrate_to_mongo.js`

**Step 1: Write migration script that reads existing reports/ folder and scenarios JSON into MongoDB**

```javascript
// Reads:
//   reports/{env}/{platform}/{version}/data.json + meta.json
//   scenarios_ios.json, scenarios_android.json
// Writes to MongoDB collections
```

**Step 2: Run migration**

```bash
node scripts/migrate_to_mongo.js
```

**Step 3: Commit**

```bash
git add scripts/migrate_to_mongo.js
git commit -m "feat: add data migration script from flat files to MongoDB"
```

---

## Phase 11: Test + Verify

### Task 21: End-to-end verification

**Step 1: Start server**
```bash
npm start
```

**Step 2: Seed admin**
```bash
node scripts/seed_admin.js
```

**Step 3: Verify login**
- Open http://localhost:3000
- Login with admin@carpacsoft.com / admin123
- Should redirect to /admin/

**Step 4: Verify admin upload**
- Upload an HTML report with env=staging, platform=ios, version=v1.0.0
- Verify it appears in report list
- Verify it shows in user dashboard

**Step 5: Verify user dashboard**
- Create a viewer user from admin panel
- Login as viewer
- Should redirect to /dashboard/
- Verify all charts, tables, exports work
- Verify no edit/upload controls visible

**Step 6: Verify real-time**
- Open user dashboard in one tab
- Upload new report from admin in another tab
- User dashboard should show notification banner

**Step 7: Commit all final adjustments**

```bash
git add -A
git commit -m "feat: VYA QA Platform v4 complete — admin + user dashboards with MongoDB and real-time updates"
```

---

## Task Summary

| Phase | Tasks | Description |
|---|---|---|
| 1 | 1-5 | Dependencies, config, database models |
| 2 | 6-9 | Auth system (middleware, routes, seed) |
| 3 | 10-12 | Services (Cloudinary, parser, alerts) |
| 4 | 13 | Admin API routes |
| 5 | 14-15 | Dashboard + export routes |
| 6 | 16 | Rewrite server.js |
| 7 | 17 | Login page UI |
| 8 | 18 | Admin dashboard UI |
| 9 | 19 | User dashboard UI |
| 10 | 20 | Data migration |
| 11 | 21 | End-to-end verification |

**Total: 21 tasks across 11 phases**
