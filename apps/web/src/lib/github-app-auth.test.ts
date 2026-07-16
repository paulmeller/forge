import { generateKeyPairSync, createVerify } from 'node:crypto';

import { describe, expect, it } from 'vitest';

import { signGithubAppJwt } from './github-app-auth';

function testKeyPair() {
  const { privateKey, publicKey } = generateKeyPairSync('rsa', {
    modulusLength: 2048,
    publicKeyEncoding: { type: 'spki', format: 'pem' },
    privateKeyEncoding: { type: 'pkcs1', format: 'pem' },
  });
  return { privateKey, publicKey };
}

function decodeSegment(segment: string): unknown {
  const padded = segment.replace(/-/g, '+').replace(/_/g, '/');
  return JSON.parse(Buffer.from(padded, 'base64').toString('utf8'));
}

describe('signGithubAppJwt', () => {
  it('produces a JWT with the correct header, claims, and a verifiable RS256 signature', () => {
    const { privateKey, publicKey } = testKeyPair();
    const nowMs = new Date('2026-01-01T00:00:00.000Z').getTime();

    const jwt = signGithubAppJwt('app_123', privateKey, nowMs);
    const [headerSeg, payloadSeg, signatureSeg] = jwt.split('.');

    expect(decodeSegment(headerSeg!)).toEqual({ alg: 'RS256', typ: 'JWT' });

    const payload = decodeSegment(payloadSeg!) as { iat: number; exp: number; iss: string };
    const nowSec = Math.floor(nowMs / 1000);
    expect(payload.iss).toBe('app_123');
    expect(payload.iat).toBe(nowSec - 60);
    expect(payload.exp).toBe(nowSec - 60 + 600);

    const signature = Buffer.from(
      signatureSeg!.replace(/-/g, '+').replace(/_/g, '/'),
      'base64',
    );
    const verifier = createVerify('RSA-SHA256');
    verifier.update(`${headerSeg}.${payloadSeg}`);
    verifier.end();
    expect(verifier.verify(publicKey, signature)).toBe(true);
  });

  it('rejects verification against a signature produced by a different key', () => {
    const { privateKey } = testKeyPair();
    const { publicKey: otherPublicKey } = testKeyPair();
    const jwt = signGithubAppJwt('app_123', privateKey);
    const [headerSeg, payloadSeg, signatureSeg] = jwt.split('.');

    const signature = Buffer.from(
      signatureSeg!.replace(/-/g, '+').replace(/_/g, '/'),
      'base64',
    );
    const verifier = createVerify('RSA-SHA256');
    verifier.update(`${headerSeg}.${payloadSeg}`);
    verifier.end();
    expect(verifier.verify(otherPublicKey, signature)).toBe(false);
  });

  it('defaults to the real clock when nowMs is omitted', () => {
    const { privateKey } = testKeyPair();
    const before = Math.floor(Date.now() / 1000);
    const jwt = signGithubAppJwt('app_123', privateKey);
    const payload = decodeSegment(jwt.split('.')[1]!) as { iat: number };
    expect(payload.iat).toBeGreaterThanOrEqual(before - 61);
    expect(payload.iat).toBeLessThanOrEqual(before + 1);
  });
});
