import mongoose from 'mongoose';
import { log } from '../utils/logger.js';

let lastDbError = null;

export const isDbConnected = () => mongoose.connection.readyState === 1;
export const getLastDbError = () => lastDbError;

export const connectDB = async () => {
  mongoose.set('strictQuery', true);
  mongoose.set('sanitizeFilter', true);
  if (String(process.env.NODE_ENV || '').trim().toLowerCase() === 'production') {
    mongoose.set('autoIndex', false);
  }

  if (!process.env.MONGODB_URI) {
    const error = new Error('MONGODB_URI is not set.');
    lastDbError = error;
    throw error;
  }

  const mongoUri = String(process.env.MONGODB_URI || '').trim();

  const shouldDisableRetryWrites = (uri) => {
    if (!uri) return false;
    const normalized = uri.toLowerCase();
    if (normalized.includes('retrywrites=')) return false;
    const isLocal = normalized.includes('mongodb://localhost') || normalized.includes('mongodb://127.0.0.1');
    if (!isLocal) return false;
    return !normalized.includes('replicaset=');
  };

  try {
    const conn = await mongoose.connect(mongoUri, {
      serverSelectionTimeoutMS: 5000,
      ...(shouldDisableRetryWrites(mongoUri) ? { retryWrites: false } : {}),
    });
    lastDbError = null;
    log(`[DB] MongoDB Connected: ${conn.connection.host}`);
    return conn;
  } catch (error) {
    lastDbError = error;
    console.error(`[DB] Error: ${error.message}`);
    throw error;
  }
};
