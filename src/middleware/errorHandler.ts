import type {ErrorRequestHandler, RequestHandler} from 'express';

import {AppError} from '../lib/errors.js';
import {logger} from '../lib/logger.js';

export const notFoundHandler: RequestHandler = (_req, _res, next) => {
  next(new AppError('NOT_FOUND', 'Route not found.'));
};

export const errorHandler: ErrorRequestHandler = (error, req, res, _next) => {
  let appError: AppError;
  if (error instanceof AppError) {
    appError = error;
  } else if (error instanceof SyntaxError && 'body' in error) {
    appError = new AppError('VALIDATION_ERROR', 'Malformed JSON body.');
  } else if (error?.name === 'CastError') {
    appError = new AppError('NOT_FOUND');
  } else {
    logger.error({err: error, method: req.method, url: req.originalUrl}, 'Unhandled error');
    appError = new AppError('INTERNAL');
  }
  res.status(appError.status).json({
    error: {
      code: appError.code,
      message: appError.message,
      ...(appError.details && {details: appError.details}),
    },
  });
};
