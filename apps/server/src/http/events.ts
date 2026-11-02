import type { FastifyReply, FastifyRequest } from 'fastify';
import type { EventBus } from '../events.js';

const heartbeatMilliseconds = 15_000;

// Holds the response open and writes one SSE frame per domain event.
export function openEventStream(
  request: FastifyRequest,
  reply: FastifyReply,
  bus: EventBus,
  openStreams: Set<() => void>,
): void {
  reply.hijack();
  const raw = reply.raw;
  raw.writeHead(200, {
    'content-type': 'text/event-stream; charset=utf-8',
    'cache-control': 'no-cache, no-transform',
    connection: 'keep-alive',
    'x-accel-buffering': 'no',
  });
  raw.write('retry: 2000\n');
  raw.write('event: ready\ndata: {}\n\n');

  const unsubscribe = bus.subscribe((event) => {
    raw.write(`event: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`);
  });
  const heartbeat = setInterval(() => {
    raw.write(': keep-alive\n\n');
  }, heartbeatMilliseconds);

  const close = (): void => {
    openStreams.delete(close);
    clearInterval(heartbeat);
    unsubscribe();
    if (!raw.writableEnded) raw.end();
  };
  request.raw.on('close', close);
  raw.on('error', close);
  openStreams.add(close);
}
