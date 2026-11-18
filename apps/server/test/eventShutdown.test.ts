import { expect, it, vi } from 'vitest';
import { createTestEnvironment } from './helpers.js';
import { buildApp } from '../src/http/app.js';

it('finishes closing the API while a browser event stream is still open', async () => {
  const env = createTestEnvironment();
  const app = buildApp({ db: env.db, bus: env.bus, databasePath: env.databasePath });
  const controller = new AbortController();
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    const address = await app.listen({ host: '127.0.0.1', port: 0 });
    const response = await fetch(`${address}/api/events`, { signal: controller.signal });
    const reader = response.body!.getReader();
    const decoder = new TextDecoder();
    let opening = '';
    while (!opening.includes('event: ready')) {
      const frame = await reader.read();
      if (frame.done) throw new Error('The stream closed before the ready event.');
      opening += decoder.decode(frame.value, { stream: true });
    }

    const timeout = new Promise<never>((_, reject) => {
      timer = setTimeout(() => reject(new Error('The event stream blocked API shutdown.')), 2000);
    });
    await Promise.race([app.close(), timeout]);
    expect(controller.signal.aborted).toBe(false);
    expect((await reader.read()).done).toBe(true);
  } finally {
    clearTimeout(timer);
    controller.abort();
    await app.close();
    env.cleanup();
  }
});


it('ends the stream before Fastify waits for the HTTP server to drain', async () => {
  const env = createTestEnvironment();
  const app = buildApp({ db: env.db, bus: env.bus, databasePath: env.databasePath });
  let markSubscribed!: () => void;
  const subscribed = new Promise<void>((resolve) => { markSubscribed = resolve; });
  const subscribe = env.bus.subscribe.bind(env.bus);
  const subscription = vi.spyOn(env.bus, 'subscribe').mockImplementation((listener) => {
    const cleanup = subscribe(listener);
    markSubscribed();
    return cleanup;
  });
  let allowCleanup!: () => void;
  const cleanup = new Promise<void>((resolve) => { allowCleanup = resolve; });
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    await app.ready();
    const stream = app.inject({ url: '/api/events', headers: { host: '127.0.0.1' } }).then((response) => response);
    await subscribed;
    const close = app.server.close.bind(app.server);
    vi.spyOn(app.server, 'close').mockImplementation((callback) => {
      // Model Node waiting for an open HTTP request before calling the close callback.
      void Promise.race([stream, cleanup]).then(() => close(callback));
      return app.server;
    });
    const timeout = new Promise<never>((_, reject) => {
      timer = setTimeout(() => reject(new Error('Fastify waited for an event stream that was still open.')), 1000);
    });
    await Promise.race([app.close(), timeout]);
    expect(subscription).toHaveBeenCalledOnce();
    expect((await stream).body).toContain('event: ready');
  } finally {
    clearTimeout(timer);
    allowCleanup();
    await app.close();
    env.cleanup();
  }
});
