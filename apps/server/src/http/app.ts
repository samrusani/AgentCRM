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

const readMethods = new Set(['GET', 'HEAD', 'OPTIONS']);

// Browsers attach an Origin header to cross site requests. A request without one comes from the CLI,
// MCP, curl, or a same origin GET, and passes. A web origin must be a loopback host; a browser
// extension origin (chrome-extension: and friends) passes because extensions hold their own
// credentials and permissions. "null" (sandboxed frames, file: pages) is refused.
function originAllowed(origin: string): boolean {
  let url: URL;
  try {
    url = new URL(origin);
  } catch {
    return false;
  }
  if (url.protocol.endsWith('-extension:')) return true;
  return (url.protocol === 'http:' || url.protocol === 'https:') && loopbackHost.test(url.hostname);
}

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
    // A cross site page can fire a POST at routes that take no body without triggering a CORS
    // preflight (it cannot read the answer, but it could rotate the capture token out from under
    // the extension). Any state changing request carrying a non loopback web Origin is refused.
    if (!readMethods.has(request.method)) {
      const origin = request.headers.origin;
      if (typeof origin === 'string' && origin !== '' && !originAllowed(origin)) {
        return reply
          .status(403)
          .send(envelope('validation', 'State changing requests from web pages on other origins are not accepted.'));
      }
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
