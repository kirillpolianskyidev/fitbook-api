import pino from 'pino';

import {env, isTest} from '../config/env.js';

export const logger = pino({
  level: isTest && !process.env.TEST_LOGS ? 'silent' : env.LOG_LEVEL,
  ...(env.NODE_ENV === 'development' && {
    transport: {target: 'pino-pretty', options: {colorize: true, translateTime: 'HH:MM:ss'}},
  }),
});
