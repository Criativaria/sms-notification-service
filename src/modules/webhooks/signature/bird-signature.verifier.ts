import { createHmac, timingSafeEqual } from 'crypto';

/**
 * Computes a Bird webhook signature as `hex(HMAC-SHA256(signingKey, rawBody))`.
 *
 * ASSUMPTION: Bird's real signing scheme and header name are not documented in a form we
 * can validate here (no live Bird credentials). We standardise on HMAC-SHA256 over the RAW
 * request body, hex-encoded, delivered in the `X-Bird-Signature` header. Swap the digest
 * encoding / header here if real Bird docs prescribe otherwise; the controller and service
 * are decoupled from this choice.
 */
export function computeBirdSignature(signingKey: string, rawBody: Buffer): string {
  return createHmac('sha256', signingKey).update(rawBody).digest('hex');
}

/**
 * Constant-time verification of a Bird webhook signature header against the HMAC of the
 * raw body. Pure function so it can be unit-tested in isolation. Returns false for a
 * missing body/header or any length or content mismatch.
 */
export function verifyBirdSignature(
  signingKey: string,
  rawBody: Buffer | undefined | null,
  signatureHeader: string | undefined | null,
): boolean {
  if (!rawBody || !signatureHeader) {
    return false;
  }

  const expected = Buffer.from(computeBirdSignature(signingKey, rawBody), 'utf-8');
  const provided = Buffer.from(signatureHeader.trim(), 'utf-8');

  if (expected.length !== provided.length) {
    return false;
  }

  return timingSafeEqual(expected, provided);
}
