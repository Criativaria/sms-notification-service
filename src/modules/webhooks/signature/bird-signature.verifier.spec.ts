import { computeBirdSignature, verifyBirdSignature } from './bird-signature.verifier';

describe('bird-signature.verifier', () => {
  const signingKey = 'test-bird-webhook-key';
  const rawBody = Buffer.from(JSON.stringify({ id: 'bird-msg-1', status: 'delivered' }), 'utf-8');

  it('accepts a signature produced by the same algorithm', () => {
    const signature = computeBirdSignature(signingKey, rawBody);

    expect(verifyBirdSignature(signingKey, rawBody, signature)).toBe(true);
  });

  it('rejects a tampered signature', () => {
    const signature = computeBirdSignature(signingKey, rawBody);

    expect(verifyBirdSignature(signingKey, rawBody, `${signature.slice(0, -1)}0`)).toBe(false);
  });

  it('rejects when the raw body was altered after signing', () => {
    const signature = computeBirdSignature(signingKey, rawBody);
    const tampered = Buffer.from(JSON.stringify({ id: 'bird-msg-1', status: 'failed' }), 'utf-8');

    expect(verifyBirdSignature(signingKey, tampered, signature)).toBe(false);
  });

  it('rejects a signature computed with a different signing key', () => {
    const signature = computeBirdSignature('other-key', rawBody);

    expect(verifyBirdSignature(signingKey, rawBody, signature)).toBe(false);
  });

  it('rejects a missing body or header', () => {
    const signature = computeBirdSignature(signingKey, rawBody);

    expect(verifyBirdSignature(signingKey, undefined, signature)).toBe(false);
    expect(verifyBirdSignature(signingKey, rawBody, undefined)).toBe(false);
    expect(verifyBirdSignature(signingKey, rawBody, '')).toBe(false);
  });
});
