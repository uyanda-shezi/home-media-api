import { createHmac, timingSafeEqual } from 'node:crypto';

export interface SessionTokenPayload {
  sid: string;
  uid: string;
  exp: number;
}

export function signToken(payload: SessionTokenPayload, secret: string): string {
  const payloadJson = JSON.stringify(payload);
  const payloadB64 = Buffer.from(payloadJson, 'utf-8').toString('base64url');

  const signature = createHmac('sha256', secret)
    .update(payloadB64)
    .digest('base64url');

  return `${payloadB64}.${signature}`;
}

export function verifyToken(token: string, secret: string): SessionTokenPayload | null {
  if (typeof token !== 'string' || !token.includes('.')) {
    return null;
  }

  const parts = token.split('.');
  if (parts.length !== 2) {
    return null;
  }

  const [payloadB64, providedSigB64] = parts;
  if (!payloadB64 || !providedSigB64) {
    return null;
  }

  // Compute expected HMAC signature
  const expectedSigB64 = createHmac('sha256', secret)
    .update(payloadB64)
    .digest('base64url');

  const expectedBuf = Buffer.from(expectedSigB64, 'utf-8');
  const providedBuf = Buffer.from(providedSigB64, 'utf-8');

  // Mandatory Guard: timingSafeEqual throws RangeError if byteLengths differ
  if (expectedBuf.byteLength !== providedBuf.byteLength) {
    return null;
  }

  if (!timingSafeEqual(expectedBuf, providedBuf)) {
    return null;
  }

  // Parse and validate payload
  try {
    const rawPayload = Buffer.from(payloadB64, 'base64url').toString('utf-8');
    const parsed = JSON.parse(rawPayload) as Partial<SessionTokenPayload>;

    if (
      typeof parsed.sid !== 'string' ||
      typeof parsed.uid !== 'string' ||
      typeof parsed.exp !== 'number'
    ) {
      return null;
    }

    if (parsed.exp < Date.now()) {
      return null;
    }

    return {
      sid: parsed.sid,
      uid: parsed.uid,
      exp: parsed.exp,
    };
  } catch {
    return null;
  }
}
