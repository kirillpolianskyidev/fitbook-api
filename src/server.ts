import http from 'node:http';

import {createApp} from './app.js';
import {env} from './config/env.js';
import {connectDb, disconnectDb} from './db/connect.js';
import {runMigrations} from './db/migrations.js';
import './jobs/bookingJobs.js';
import {startJobs} from './jobs/index.js';
import {logger} from './lib/logger.js';
import {attachRealtime} from './realtime/socket.js';

async function main() {
  await connectDb();
  await runMigrations();
  const app = createApp();
  const server = http.createServer(app);
  attachRealtime(server);
  const stopJobs = startJobs();

  server.listen(env.PORT, () => {
    logger.info(
      `FitBook API on http://localhost:${env.PORT}  (docs: http://localhost:${env.PORT}/docs)`,
    );
  });

  const shutdown = async (signal: string) => {
    logger.info({signal}, 'Shutting down');
    stopJobs();
    server.close();
    await disconnectDb();
    process.exit(0);
  };
  process.on('SIGINT', () => void shutdown('SIGINT'));
  process.on('SIGTERM', () => void shutdown('SIGTERM'));
}

main().catch(error => {
  logger.fatal({err: error}, 'Failed to start');
  process.exit(1);
});
