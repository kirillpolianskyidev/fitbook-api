import {Router, type Request, type RequestHandler} from 'express';
import type {z} from 'zod';

import {UserModel, type UserDoc} from '../models/user.js';
import {AppError, ERROR_STATUS, type ErrorCode} from './errors.js';
import {verifyAccessToken} from './jwt.js';
import {registry} from './openapi.js';
import {ErrorResponseSchema} from './schemas.js';

export const API_PREFIX = '/api/v1';

/** Router that receives every API route defined with `route()`. Mounted at /api/v1. */
export const apiRouter = Router();

export type AuthLevel = 'public' | 'user' | 'coach' | 'client';
type Method = 'get' | 'post' | 'put' | 'patch' | 'delete';

export type RouteContext<TBody, TQuery, TParams> = {
  body: TBody;
  query: TQuery;
  params: TParams;
  /** The authenticated user. Throws UNAUTHORIZED when accessed on a public route without a token. */
  readonly user: UserDoc;
  req: Request;
  /** Overrides the success status for this response (must be listed in `alsoStatus`). */
  setStatus: (status: 200 | 201) => void;
};

type Empty = z.ZodType<undefined>;

type RouteConfig<
  TBody extends z.ZodType,
  TQuery extends z.ZodType,
  TParams extends z.ZodType,
  TRes extends z.ZodType,
> = {
  method: Method;
  path: string;
  tags: string[];
  summary: string;
  description?: string;
  auth: AuthLevel;
  /** Social accounts without role/homeArea may call this route. */
  allowNotOnboarded?: boolean;
  body?: TBody;
  query?: TQuery;
  params?: TParams;
  /** 204 routes have no response schema. */
  status?: 200 | 201 | 204;
  /** Another success status the handler may choose with ctx.setStatus (e.g. 201 created vs 200 updated). */
  alsoStatus?: 200 | 201;
  response?: TRes;
  errors?: ErrorCode[];
  middleware?: RequestHandler[];
  handler: (
    ctx: RouteContext<z.output<TBody>, z.output<TQuery>, z.output<TParams>>,
  ) => Promise<z.input<TRes>> | z.input<TRes>;
};

async function authenticate(req: Request): Promise<UserDoc | null> {
  const header = req.headers.authorization;
  if (!header?.startsWith('Bearer ')) {
    return null;
  }
  const payload = verifyAccessToken(header.slice('Bearer '.length).trim());
  const user = await UserModel.findById(payload.sub);
  if (!user) {
    throw new AppError('UNAUTHORIZED');
  }
  return user;
}

function zodFields(error: z.ZodError) {
  const fields: Record<string, string> = {};
  for (const issue of error.issues) {
    const key = issue.path.join('.') || '_';
    fields[key] ??= issue.message;
  }
  return fields;
}

function parseOrThrow<T extends z.ZodType>(schema: T | undefined, value: unknown): z.output<T> {
  if (!schema) {
    return undefined as z.output<T>;
  }
  const result = schema.safeParse(value);
  if (!result.success) {
    throw new AppError('VALIDATION_ERROR', undefined, {fields: zodFields(result.error)});
  }
  return result.data;
}

const toOpenApiPath = (path: string) => API_PREFIX + path.replace(/:(\w+)/g, '{$1}');

function errorResponses(codes: ErrorCode[], auth: AuthLevel) {
  const all = new Set<ErrorCode>(codes);
  all.add('VALIDATION_ERROR');
  if (auth !== 'public') {
    all.add('UNAUTHORIZED');
    all.add('TOKEN_EXPIRED');
  }
  if (auth === 'coach' || auth === 'client') {
    all.add('FORBIDDEN');
  }
  const byStatus = new Map<number, ErrorCode[]>();
  for (const code of all) {
    const status = ERROR_STATUS[code];
    byStatus.set(status, [...(byStatus.get(status) ?? []), code]);
  }
  return Object.fromEntries(
    [...byStatus.entries()].map(([status, list]) => [
      String(status),
      {
        description: list.join(', '),
        content: {'application/json': {schema: ErrorResponseSchema}},
      },
    ]),
  );
}

/** Defines an API route: auth + role checks, zod validation, typed handler, OpenAPI registration. */
export function route<
  TBody extends z.ZodType = Empty,
  TQuery extends z.ZodType = Empty,
  TParams extends z.ZodType = Empty,
  TRes extends z.ZodType = Empty,
>(config: RouteConfig<TBody, TQuery, TParams, TRes>) {
  const status = config.status ?? (config.method === 'post' ? 201 : 200);

  registry.registerPath({
    method: config.method,
    path: toOpenApiPath(config.path),
    tags: config.tags,
    summary: config.summary,
    description: config.description,
    // Public routes declare an empty security list explicitly (valid OpenAPI, no auth needed).
    security: config.auth === 'public' ? [] : [{bearerAuth: []}],
    'x-auth': config.auth,
    request: {
      ...(config.params && {params: config.params as unknown as z.ZodObject}),
      ...(config.query && {query: config.query as unknown as z.ZodObject}),
      ...(config.body && {body: {content: {'application/json': {schema: config.body}}}}),
    },
    responses: {
      [String(status)]:
        status === 204 || !config.response
          ? {description: 'No content'}
          : {description: 'Success', content: {'application/json': {schema: config.response}}},
      ...(config.alsoStatus &&
        config.response && {
          [String(config.alsoStatus)]: {
            description: config.alsoStatus === 201 ? 'Created' : 'Success',
            content: {'application/json': {schema: config.response}},
          },
        }),
      ...errorResponses(config.errors ?? [], config.auth),
    },
  });

  const handler: RequestHandler = async (req, res) => {
    const user = await authenticate(req);
    if (config.auth !== 'public') {
      if (!user) {
        throw new AppError('UNAUTHORIZED');
      }
      if (!user.onboardingCompleted && !config.allowNotOnboarded) {
        throw new AppError('ONBOARDING_REQUIRED');
      }
      if ((config.auth === 'coach' || config.auth === 'client') && user.role !== config.auth) {
        throw new AppError('FORBIDDEN', `This action is available to ${config.auth}s only.`);
      }
    }

    let responseStatus: number = status;
    const ctx = {
      setStatus: (next: 200 | 201) => {
        if (next !== status && next !== config.alsoStatus) {
          throw new Error(`Status ${next} is not declared for ${config.method} ${config.path}`);
        }
        responseStatus = next;
      },
      body: parseOrThrow(config.body, req.body),
      query: parseOrThrow(config.query, req.query),
      params: parseOrThrow(config.params, req.params),
      req,
      get user(): UserDoc {
        if (!user) {
          throw new AppError('UNAUTHORIZED');
        }
        return user;
      },
    };

    const result = await config.handler(ctx);
    if (status === 204 || !config.response) {
      res.status(204).end();
      return;
    }
    // Responses are parsed with their schema: unknown fields are stripped and the contract is enforced.
    const parsed = config.response.safeParse(result);
    if (!parsed.success) {
      throw new Error(
        `Response does not match schema for ${config.method.toUpperCase()} ${config.path}: ${parsed.error.message}`,
      );
    }
    res.status(responseStatus).json(parsed.data);
  };

  apiRouter[config.method](config.path, ...(config.middleware ?? []), handler);
}
