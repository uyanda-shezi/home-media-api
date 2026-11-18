import { describe, it, afterEach } from 'node:test';
import assert from 'node:assert';
import http from 'node:http';
import {
  authenticateWithJellyfin,
  validateJellyfinToken,
} from '../src/auth/jellyfin-auth.js';

describe('Jellyfin Authentication Client', () => {
  const activeServers: http.Server[] = [];

  afterEach(async () => {
    while (activeServers.length > 0) {
      const s = activeServers.pop();
      if (s) {
        await new Promise<void>((resolve) => s.close(() => resolve()));
      }
    }
  });

  it('forwards credentials with X-Emby-Authorization header and { Username, Pw } body, extracting profile', async () => {
    let capturedHeaders: http.IncomingHttpHeaders | null = null;
    let capturedBody: any = null;

    const mockServer = http.createServer((req, res) => {
      capturedHeaders = req.headers;
      let body = '';
      req.on('data', (c) => (body += c));
      req.on('end', () => {
        capturedBody = JSON.parse(body);
        if (req.url === '/Users/AuthenticateByName' && req.method === 'POST') {
          res.writeHead(200, { 'Content-Type': 'application/json' });
          res.end(
            JSON.stringify({
              User: {
                Id: 'jf-user-12345',
                Name: 'Alice',
                Policy: {
                  IsAdministrator: true,
                },
              },
              AccessToken: 'secret-jellyfin-token-xyz',
            })
          );
        } else {
          res.writeHead(404).end();
        }
      });
    });

    await new Promise<void>((r) => mockServer.listen(0, '127.0.0.1', () => r()));
    activeServers.push(mockServer);

    const port = (mockServer.address() as { port: number }).port;
    const url = `http://127.0.0.1:${port}`;

    const result = await authenticateWithJellyfin(url, 'Alice', 'password123');

    assert.strictEqual(result.ok, true);
    if (result.ok) {
      assert.strictEqual(result.data.userId, 'jf-user-12345');
      assert.strictEqual(result.data.username, 'Alice');
      assert.strictEqual(result.data.isAdministrator, true);
      assert.strictEqual(result.data.accessToken, 'secret-jellyfin-token-xyz');
    }

    assert.ok(capturedHeaders);
    assert.strictEqual(capturedHeaders['content-type'], 'application/json');
    const authHeader = capturedHeaders['x-emby-authorization'] as string;
    assert.ok(authHeader);
    assert.ok(authHeader.includes('Client="HomeMedia"'));
    assert.deepStrictEqual(capturedBody, {
      Username: 'Alice',
      Pw: 'password123',
    });
  });

  it('returns 401 error when Jellyfin returns 401 Unauthorized', async () => {
    const mockServer = http.createServer((req, res) => {
      res.writeHead(401, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ message: 'Invalid user or password' }));
    });

    await new Promise<void>((r) => mockServer.listen(0, '127.0.0.1', () => r()));
    activeServers.push(mockServer);

    const port = (mockServer.address() as { port: number }).port;
    const url = `http://127.0.0.1:${port}`;

    const result = await authenticateWithJellyfin(url, 'WrongUser', 'badpassword');
    assert.strictEqual(result.ok, false);
    if (!result.ok) {
      assert.strictEqual(result.error.statusCode, 401);
      assert.strictEqual(result.error.message, 'Invalid username or password');
    }
  });

  it('returns 502 Bad Gateway when Jellyfin server is unreachable', async () => {
    // Non-routable or unused port on localhost
    const result = await authenticateWithJellyfin('http://127.0.0.1:1', 'Alice', 'pwd');
    assert.strictEqual(result.ok, false);
    if (!result.ok) {
      assert.strictEqual(result.error.statusCode, 502);
      assert.strictEqual(result.error.message, 'Identity provider (Jellyfin) unreachable');
    }
  });

  it('returns 502 Bad Gateway when JELLYFIN_URL is omitted or undefined', async () => {
    const result = await authenticateWithJellyfin(undefined, 'Alice', 'pwd');
    assert.strictEqual(result.ok, false);
    if (!result.ok) {
      assert.strictEqual(result.error.statusCode, 502);
      assert.strictEqual(result.error.message, 'Identity provider (Jellyfin) unconfigured');
    }
  });

  it('validateJellyfinToken queries /Users/Me with X-Emby-Token and returns valid profile', async () => {
    let capturedHeaders: http.IncomingHttpHeaders | null = null;

    const mockServer = http.createServer((req, res) => {
      capturedHeaders = req.headers;
      if (req.url === '/Users/Me' && req.method === 'GET') {
        if (req.headers['x-emby-token'] === 'valid-token-123') {
          res.writeHead(200, { 'Content-Type': 'application/json' });
          res.end(
            JSON.stringify({
              Id: 'user-guid-abc',
              Name: 'Bob',
              Policy: { IsAdministrator: false },
            })
          );
        } else {
          res.writeHead(401, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ message: 'Unauthorized' }));
        }
      } else {
        res.writeHead(404).end();
      }
    });

    await new Promise<void>((r) => mockServer.listen(0, '127.0.0.1', () => r()));
    activeServers.push(mockServer);

    const port = (mockServer.address() as { port: number }).port;
    const url = `http://127.0.0.1:${port}`;

    const validResult = await validateJellyfinToken(url, 'valid-token-123');
    assert.strictEqual(validResult.ok, true);
    if (validResult.ok) {
      assert.strictEqual(validResult.data.valid, true);
      assert.strictEqual(validResult.data.jellyfinUserId, 'user-guid-abc');
      assert.strictEqual(validResult.data.username, 'Bob');
      assert.strictEqual(validResult.data.isAdministrator, false);
    }
    assert.strictEqual(capturedHeaders?.['x-emby-token'], 'valid-token-123');

    // Invalid token returns 401
    const invalidResult = await validateJellyfinToken(url, 'bad-token');
    assert.strictEqual(invalidResult.ok, false);
    if (!invalidResult.ok) {
      assert.strictEqual(invalidResult.error.statusCode, 401);
      assert.strictEqual(invalidResult.error.message, 'Invalid or expired Jellyfin token');
    }

    // Missing token returns 401
    const emptyResult = await validateJellyfinToken(url, '');
    assert.strictEqual(emptyResult.ok, false);
    if (!emptyResult.ok) {
      assert.strictEqual(emptyResult.error.statusCode, 401);
      assert.strictEqual(emptyResult.error.message, 'Token is required');
    }

    // Unconfigured URL returns 502
    const unconfResult = await validateJellyfinToken(undefined, 'valid-token-123');
    assert.strictEqual(unconfResult.ok, false);
    if (!unconfResult.ok) {
      assert.strictEqual(unconfResult.error.statusCode, 502);
    }

    // Unreachable URL returns 502
    const unreachResult = await validateJellyfinToken('http://127.0.0.1:1', 'valid-token-123');
    assert.strictEqual(unreachResult.ok, false);
    if (!unreachResult.ok) {
      assert.strictEqual(unreachResult.error.statusCode, 502);
      assert.strictEqual(unreachResult.error.message, 'Identity provider (Jellyfin) unreachable');
    }
  });
});
