import mongoose from 'mongoose';
import { env } from './env.js';

export const connectDbIfConfigured = async () => {
  if (!env.mongoUri) return false;
  await mongoose.connect(env.mongoUri);
  return true;
};
