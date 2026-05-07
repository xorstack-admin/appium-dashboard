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
    email: 'admin@vyapy.com',
    password: 'admin123',
    role: 'admin',
  });

  console.log(`Admin created: ${admin.email}`);
  console.log('Default password: admin123 — change it after first login!');
  process.exit(0);
}

seed().catch(err => { console.error(err); process.exit(1); });
