import Fastify, { type FastifyInstance } from 'fastify';
import { ZodError } from 'zod';
import type { Db } from '../db.js';
import { AppError } from '../errors.js';
import type { EventBus } from '../events.js';
import { registerRoutes } from './routes.js';

export interface AppOptions {
  db: Db;
  bus: EventBus;
  databasePath: string;
  logLevel?: string;
  // Tests replace the clock so jobs and timestamps follow a fake time.
  now?: () => string;
}

// Exact match: a loopback name, optionally followed by a colon and a port of one to five digits.
const loopbackHost = /^(?:127\.0\.0\.1|localhost|::1|\[::1\])(?::\d{1,5})?$/;

function envelope(code: string, message: string, extra: Record<string, unknown> = {}) {
  return { error: { code, message, ...extra } };
}

export function buildApp(options: AppOptions): FastifyInstance {
  const app = Fastify({
    logger: { level: options.logLevel ?? process.env.AGENTCRM_LOG_LEVEL ?? 'warn' },
    bodyLimit: 1_048_576,
  });

  app.addHook('onRequest', async (request, reply) => {
    if (!loopbackHost.test(request.headers.host ?? '')) {
      return reply.status(403).send(envelope('validation', 'Requests must use a loopback host name.'));
    }
    return undefined;
  });

  app.setNotFoundHandler((request, reply) => {
    reply.status(404).send(envelope('not_found', `No route matches ${request.method} ${request.url.split('?')[0]}.`));
  });

  app.setErrorHandler((error, request, reply) => {
    if (error instanceof AppError) {
      const extra = error.current !== undefined ? { current: error.current } : {};
      return reply.status(error.status).send(envelope(error.code, error.message, extra));
    }
    if (error instanceof ZodError) {
      return reply.status(400).send(envelope('validation', error.issues[0]?.message ?? 'The request is not valid.'));
    }
    const status = (error as { statusCode?: number }).statusCode;
    if (typeof status === 'number' && status >= 400 && status < 500) {
      const message = error instanceof Error ? error.message : 'The request is not valid.';
      return reply.status(status === 404 ? 404 : 400).send(envelope(status === 404 ? 'not_found' : 'validation', message));
    }
    request.log.error(error);
    return reply.status(500).send(envelope('internal', 'Something went wrong on the server.'));
  });

  registerRoutes(app, options);
  return app;
}
