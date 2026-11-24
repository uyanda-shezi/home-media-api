import { test } from 'node:test';
import assert from 'node:assert/strict';
import http, { type ClientRequest } from 'node:http';
import { createDb } from '../src/db/connection.js';
import { loadConfig } from '../src/config.js';
import { createSyncWorker } from '../src/sync/worker.js';
import { handleSyncWebhook } from '../src/sync/webhook.js';

test('webhook HTTP ingress authenticates raw headers, bounds bodies and rechecks shutdown', async t => {
  const db = createDb(':memory:');
  const secret = 'local-webhook-fixture-key'.repeat(2);
  const enabled = loadConfig({ SYNC_ENABLED: 'true', SYNC_WEBHOOK_SECRET: secret });
  let config = { ...enabled, syncEnabled: false };
  let stopped = false;
  let hints = 0;
  let parsing: (() => void) | undefined;
  const worker = {
    available: (source: string) => source === 'seerr' && !stopped,
    accept: () => { hints++; return !stopped; },
    stop: async () => { stopped = true; },
  } satisfies ReturnType<typeof createSyncWorker>;
  const server = http.createServer(async (req, res) => {
    if (parsing) req.once('data', parsing);
    if (!await handleSyncWebhook(req, res, config, worker)) res.writeHead(404).end();
  });
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
  t.after(async () => {
    server.closeAllConnections();
    await new Promise<void>(resolve => server.close(() => resolve()));
    db.close();
  });
  const address = server.address();
  assert.ok(address && typeof address !== 'string');
  const auth = 'Bearer ' + secret;
  const call = (headers: string[], send: (req: ClientRequest) => void, path = 'seerr', method = 'POST') =>
    new Promise<{ status: number | undefined; json: unknown; cache: string | undefined }>((resolve, reject) => {
      const req = http.request({ host: '127.0.0.1', port: address.port, path: '/api/v1/sync/webhooks/' + path,
        method, headers: ['Host', 'localhost', ...headers], agent: false }, res => {
        let body = '';
        res.setEncoding('utf8');
        res.on('data', chunk => { body += chunk; });
        res.on('end', () => {
          assert.ok(!body.includes(secret));
          resolve({ status: res.statusCode, json: body ? JSON.parse(body) : null, cache: res.headers['cache-control'] });
          req.destroy();
        });
        res.on('error', reject);
      });
      req.on('error', reject);
      req.setTimeout(2000, () => req.destroy(new Error('webhook test timed out')));
      send(req);
    });
  const headers = ['Authorization', auth, 'Content-Type', 'application/json'];
  const event = (name: string) => (req: ClientRequest) => req.end(JSON.stringify({ notification_type: name }));
  assert.equal((await call(headers, event('MEDIA_AVAILABLE'))).status, 404);
  config = { ...enabled, syncEnabled: true, syncWebhookSecret: undefined };
  assert.equal((await call(headers, event('MEDIA_AVAILABLE'))).status, 404);
  config = { ...enabled, syncEnabled: true };
  assert.equal((await call(headers, event('MEDIA_AVAILABLE'), 'other')).status, 404);
  assert.equal((await call(headers, event('MEDIA_AVAILABLE'), 'seerr', 'GET')).status, 404);
  const incomplete = (req: ClientRequest) => req.flushHeaders();
  assert.equal((await call(['Content-Length', '100'], incomplete)).status, 401);
  assert.equal((await call([...headers, 'authorization', auth, 'Content-Length', '100'], incomplete)).status, 401);
  assert.equal((await call(['Authorization', auth], req => req.end())).status, 415);
  assert.equal((await call(headers, req => req.end('{'))).status, 400);
  assert.equal((await call(headers, event('UNKNOWN'))).status, 400);
  assert.equal((await call(headers, req => req.end('{"NotificationType":"PlaybackStop"}'), 'jellyfin')).status, 503);
  assert.equal((await call(headers, event('TEST_NOTIFICATION'))).status, 202);
  assert.equal(hints, 0);
  const accepted = await call(headers, event('MEDIA_AVAILABLE'));
  assert.deepEqual(accepted, { status: 202, json: { status: 'accepted' }, cache: 'no-store' });
  assert.equal(hints, 1);
  const large = await call([...headers, 'Transfer-Encoding', 'chunked'], req => {
    req.write('x'.repeat(32768));
    req.write('y'.repeat(32769));
    req.end();
  });
  assert.deepEqual(large, { status: 413, json: { error: 'Request body too large' }, cache: 'no-store' });
  const during = await call(headers, req => {
    parsing = () => {
      stopped = true;
      req.end('MEDIA_PENDING"}');
    };
    req.write('{"notification_type":"');
  });
  assert.equal(during.status, 503);
  assert.equal(hints, 1);
});
