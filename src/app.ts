import cors from 'cors';
import express from 'express';
import helmet from 'helmet';
import {pinoHttp} from 'pino-http';
import swaggerUi from 'swagger-ui-express';

import {env, isTest} from './config/env.js';
import {logger} from './lib/logger.js';
import {generateOpenApiDocument} from './lib/openapi.js';
import {API_PREFIX, apiRouter} from './lib/route.js';
import {errorHandler, notFoundHandler} from './middleware/errorHandler.js';
import {apiRateLimit} from './middleware/rateLimit.js';
import './modules/index.js';

export function createApp() {
  const app = express();
  app.set('trust proxy', 'loopback');
  app.disable('x-powered-by');

  app.use(helmet({contentSecurityPolicy: false}));
  app.use(
    cors({
      origin: env.CORS_ORIGINS === '*' ? true : env.CORS_ORIGINS.split(',').map(o => o.trim()),
    }),
  );
  app.use(express.json({limit: '100kb'}));
  if (!isTest) {
    app.use(pinoHttp({logger, autoLogging: {ignore: req => req.url === `${API_PREFIX}/health`}}));
  }

  const openApiDocument = generateOpenApiDocument();
  app.get('/openapi.json', (_req, res) => {
    res.json(openApiDocument);
  });
  app.use(
    '/docs',
    swaggerUi.serve,
    swaggerUi.setup(openApiDocument, {customSiteTitle: 'FitBook API'}),
  );
  app.get('/', (_req, res) => {
    res.redirect('/docs');
  });

  app.use(API_PREFIX, apiRateLimit, apiRouter);
  app.use(notFoundHandler);
  app.use(errorHandler);
  return app;
}
