import mongoose from 'mongoose';

import {mongoUri} from '../config/env.js';
import {logger} from '../lib/logger.js';

mongoose.set('strictQuery', true);

export async function connectDb(uri: string = mongoUri) {
  await mongoose.connect(uri, {serverSelectionTimeoutMS: 5000});
  logger.info({uri: uri.replace(/\/\/.*@/, '//***@')}, 'MongoDB connected');
  return mongoose.connection;
}

export async function disconnectDb() {
  await mongoose.disconnect();
}

export const isDbUp = () => mongoose.connection.readyState === 1;
