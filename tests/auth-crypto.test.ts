import { describe, it } from 'node:test';
import assert from 'node:assert';
import { signToken, verifyToken } from '../src/auth/crypto.js';

describe('Token Cryptography & Verification', () => {
  const secret = 'test_secret_key_at_least_32_chars_long_12345';

  it('correctly signs and verifies a valid token payload', () => {
    const payload = {
      sid: 'session-uuid-1',
      uid: 'user-uuid-1',
      exp: Date.now() + 60_000,
    };

    const token = signToken(payload, secret);
    assert.ok(typeof token === 'string');
    assert.strictEqual(token.split('.').length, 2);

    const verified = verifyToken(token, secret);
    assert.ok(verified !== null);
    assert.strictEqual(verified.sid, payload.sid);
    assert.strictEqual(verified.uid, payload.uid);
    assert.strictEqual(verified.exp, payload.exp);
  });

  it('tampered payload fails verification', () => {
    const payload = {
      sid: 'session-uuid-1',
      uid: 'user-uuid-1',
      exp: Date.now() + 60_000,
    };

    const token = signToken(payload, secret);
    const [payloadB64, sig] = token.split('.');

    // Tamper with the payload string
    const tamperedPayloadB64 = Buffer.from(
      JSON.stringify({ sid: 'session-uuid-1', uid: 'attacker-uuid', exp: payload.exp })
    ).toString('base64url');

    const tamperedToken = `${tamperedPayloadB64}.${sig}`;
    const result = verifyToken(tamperedToken, secret);
    assert.strictEqual(result, null);
  });

  it('tampered signature fails verification', () => {
    const payload = {
      sid: 'session-uuid-1',
      uid: 'user-uuid-1',
      exp: Date.now() + 60_000,
    };

    const token = signToken(payload, secret);
    const [payloadB64, sig] = token.split('.');

    // Change one character in signature
    const flippedChar = sig.endsWith('a') ? 'b' : 'a';
    const tamperedSig = sig.slice(0, -1) + flippedChar;

    const tamperedToken = `${payloadB64}.${tamperedSig}`;
    const result = verifyToken(tamperedToken, secret);
    assert.strictEqual(result, null);
  });

  it('mismatched signature byte length does NOT throw RangeError and returns null', () => {
    const payload = {
      sid: 'session-uuid-1',
      uid: 'user-uuid-1',
      exp: Date.now() + 60_000,
    };

    const token = signToken(payload, secret);
    const [payloadB64] = token.split('.');

    // Shorter signature (10 chars instead of standard HMAC-SHA256 43 chars)
    const shortToken = `${payloadB64}.short_sig`;
    assert.doesNotThrow(() => {
      const result = verifyToken(shortToken, secret);
      assert.strictEqual(result, null);
    });

    // Longer signature
    const longToken = `${payloadB64}.very_long_signature_that_exceeds_standard_hmac_length_by_many_bytes_1234567890`;
    assert.doesNotThrow(() => {
      const result = verifyToken(longToken, secret);
      assert.strictEqual(result, null);
    });
  });

  it('malformed token strings fail cleanly', () => {
    assert.strictEqual(verifyToken('', secret), null);
    assert.strictEqual(verifyToken('nodotsinthisstring', secret), null);
    assert.strictEqual(verifyToken('too.many.dots.here', secret), null);
    assert.strictEqual(verifyToken('.missingpayload', secret), null);
    assert.strictEqual(verifyToken('missingsig.', secret), null);
    assert.strictEqual(verifyToken('not_json_payload.fake_sig', secret), null);
    assert.strictEqual(verifyToken(null as unknown as string, secret), null);
    assert.strictEqual(verifyToken(undefined as unknown as string, secret), null);
  });

  it('expired tokens fail verification', () => {
    const expiredPayload = {
      sid: 'session-uuid-1',
      uid: 'user-uuid-1',
      exp: Date.now() - 5000, // expired 5 seconds ago
    };

    const token = signToken(expiredPayload, secret);
    const result = verifyToken(token, secret);
    assert.strictEqual(result, null);
  });
});
