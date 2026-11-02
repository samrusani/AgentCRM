import http from 'node:http';
import type { AddressInfo } from 'node:net';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { AgentmailError, listMessages, sendMessage, validateKey } from '../src/providers/agentmail.js';

// A server that redirects every request to a second server, which records whether anything reached it.
let redirector: http.Server;
let target: http.Server;
let targetHits: { authorization: string | undefined }[] = [];
let previousBase: string | undefined;

function listen(server: http.Server): Promise<number> {
  return new Promise((resolve) => server.listen(0, '127.0.0.1', () => resolve((server.address() as AddressInfo).port)));
}

beforeAll(async () => {
  target = http.createServer((request, response) => {
    targetHits.push({ authorization: request.headers.authorization });
    response.writeHead(200, { 'content-type': 'application/json' });
    response.end(JSON.stringify({ message_id: 'msg_x', thread_id: 'thr_x', messages: [] }));
  });
  const targetPort = await listen(target);
  redirector = http.createServer((_request, response) => {
    response.writeHead(307, { location: `http://127.0.0.1:${targetPort}/elsewhere` });
    response.end();
  });
  const redirectorPort = await listen(redirector);
  previousBase = process.env.AGENTCRM_AGENTMAIL_BASE;
  process.env.AGENTCRM_AGENTMAIL_BASE = `http://127.0.0.1:${redirectorPort}/v0`;
});

afterAll(async () => {
  if (previousBase === undefined) delete process.env.AGENTCRM_AGENTMAIL_BASE;
  else process.env.AGENTCRM_AGENTMAIL_BASE = previousBase;
  redirector.closeAllConnections();
  target.closeAllConnections();
  await Promise.all([new Promise((resolve) => redirector.close(resolve)), new Promise((resolve) => target.close(resolve))]);
});

describe('agentmail provider requests', () => {
  it('never follows a redirect, so the API key goes to one host only', async () => {
    targetHits = [];
    await expect(validateKey('am_secret_key')).rejects.toBeInstanceOf(AgentmailError);
    await expect(listMessages('am_secret_key', 'inbox@stub-mail.invalid')).rejects.toBeInstanceOf(AgentmailError);
    const send = sendMessage('am_secret_key', { inboxId: 'inbox@stub-mail.invalid', idempotencyKey: 'snd_1', to: 'a@b.invalid', subject: 'Hi', text: 'Body' });
    await expect(send).rejects.toMatchObject({ kind: 'network', outcomeUnknown: true, definitive: false });
    expect(targetHits).toEqual([]);
  });
});
