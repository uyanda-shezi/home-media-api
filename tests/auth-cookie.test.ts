import { describe, it } from 'node:test';
import assert from 'node:assert';
import type { IncomingMessage } from 'node:http';
import {
  buildClearSessionCookie,
  buildSessionCookie,
  extractAuthToken,
  extractBearerToken,
  extractSessionCookie,
  parseCookies,
  SESSION_COOKIE_NAME,
} from '../src/auth/middleware.js';

describe('HttpOnly Cookie & Dual-Mode Token Utilities', () => {
  it('parseCookies handles various header formats', () => {
    assert.deepStrictEqual(parseCookies(), {});
    assert.deepStrictEqual(parseCookies(''), {});
    assert.deepStrictEqual(parseCookies('  '), {});

    const single = parseCookies('hm_session=abc123xyz');
    assert.strictEqual(single['hm_session'], 'abc123xyz');

    const multiple = parseCookies('foo=bar; hm_session=token-value; theme=dark');
    assert.strictEqual(multiple['foo'], 'bar');
    assert.strictEqual(multiple['hm_session'], 'token-value');
    assert.strictEqual(multiple['theme'], 'dark');

    // URL encoded values
    const encoded = parseCookies('user=alice%20smith; hm_session=tok%3D123');
    assert.strictEqual(encoded['user'], 'alice smith');
    assert.strictEqual(encoded['hm_session'], 'tok=123');
  });

  it('extractSessionCookie correctly retrieves hm_session cookie', () => {
    const mockReqWithCookie = {
      headers: {
        cookie: 'pref=1; hm_session=valid-session-cookie; other=2',
      },
    } as unknown as IncomingMessage;

    assert.strictEqual(extractSessionCookie(mockReqWithCookie), 'valid-session-cookie');

    const mockReqNoCookie = {
      headers: {},
    } as unknown as IncomingMessage;
    assert.strictEqual(extractSessionCookie(mockReqNoCookie), null);

    const mockReqOtherCookie = {
      headers: {
        cookie: 'something_else=value',
      },
    } as unknown as IncomingMessage;
    assert.strictEqual(extractSessionCookie(mockReqOtherCookie), null);
  });

  it('extractAuthToken prefers Bearer header over cookie but falls back to cookie', () => {
    // 1. Both present: Bearer wins
    const dualReq = {
      headers: {
        authorization: 'Bearer header-token-123',
        cookie: 'hm_session=cookie-token-456',
      },
    } as unknown as IncomingMessage;
    assert.strictEqual(extractAuthToken(dualReq), 'header-token-123');

    // 2. Only Bearer present
    const bearerOnlyReq = {
      headers: {
        authorization: 'Bearer bearer-only-token',
      },
    } as unknown as IncomingMessage;
    assert.strictEqual(extractAuthToken(bearerOnlyReq), 'bearer-only-token');

    // 3. Only Cookie present
    const cookieOnlyReq = {
      headers: {
        cookie: 'hm_session=cookie-only-token',
      },
    } as unknown as IncomingMessage;
    assert.strictEqual(extractAuthToken(cookieOnlyReq), 'cookie-only-token');

    // 4. Neither present
    const emptyReq = {
      headers: {},
    } as unknown as IncomingMessage;
    assert.strictEqual(extractAuthToken(emptyReq), null);
  });

  it('buildSessionCookie generates correct flags and directives', () => {
    const expires = new Date('2026-11-25T12:00:00.000Z');
    const cookieStr = buildSessionCookie('test-token-value', 604800, expires, false);

    assert.ok(cookieStr.includes(`${SESSION_COOKIE_NAME}=test-token-value`));
    assert.ok(cookieStr.includes('Path=/'));
    assert.ok(cookieStr.includes('HttpOnly'));
    assert.ok(cookieStr.includes('SameSite=Lax'));
    assert.ok(cookieStr.includes('Max-Age=604800'));
    assert.ok(cookieStr.includes(`Expires=${expires.toUTCString()}`));
    assert.strictEqual(cookieStr.includes('Secure'), false);

    // With secure = true
    const secureCookieStr = buildSessionCookie('test-token-value', 604800, expires, true);
    assert.ok(secureCookieStr.includes('Secure'));
  });

  it('buildClearSessionCookie produces expired directive to flush client cookie', () => {
    const clearStr = buildClearSessionCookie(false);
    assert.ok(clearStr.includes(`${SESSION_COOKIE_NAME}=`));
    assert.ok(clearStr.includes('Path=/'));
    assert.ok(clearStr.includes('HttpOnly'));
    assert.ok(clearStr.includes('SameSite=Lax'));
    assert.ok(clearStr.includes('Max-Age=0'));
    assert.ok(clearStr.includes('Expires=Thu, 01 Jan 1970 00:00:00 GMT'));
    assert.strictEqual(clearStr.includes('Secure'), false);

    const secureClearStr = buildClearSessionCookie(true);
    assert.ok(secureClearStr.includes('Secure'));
  });
});
