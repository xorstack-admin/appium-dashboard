const mongoose = require('mongoose');

async function connectDB() {
  try {
    const conn = await mongoose.connect(process.env.MONGO_URI);
    console.log(`MongoDB connected: ${conn.connection.host}`);
  } catch (err) {
    throw new Error('MongoDB connection failed: ' + err.message);
  }
}

module.exports = connectDB;
