import { createHmac, timingSafeEqual } from 'crypto';

/**
 * Computes a Twilio request signature using Twilio's official algorithm:
 * `base64(HMAC-SHA1(authToken, url + concat(sort(key + value))))`.
 *
 * The full request URL Twilio posted to is prepended, then every POST parameter is
 * appended as `key + value` (no separators) with keys sorted lexicographically.
 */
export function computeTwilioSignature(
  authToken: string,
  url: string,
  params: Record<string, string>,
): string {
  const payload = Object.keys(params)
    .sort()
    .reduce((acc, key) => acc + key + params[key], url);

  return createHmac('sha1', authToken).update(Buffer.from(payload, 'utf-8')).digest('base64');
}

/**
 * Constant-time verification of an `X-Twilio-Signature` header against a freshly computed
 * signature. Pure function so it can be unit-tested without HTTP plumbing. Returns false
 * for a missing/empty header or any length or content mismatch.
 */
export function verifyTwilioSignature(
  authToken: string,
  url: string,
  params: Record<string, string>,
  signatureHeader: string | undefined | null,
): boolean {
  if (!signatureHeader) {
    return false;
  }

  const expected = Buffer.from(computeTwilioSignature(authToken, url, params), 'utf-8');
  const provided = Buffer.from(signatureHeader, 'utf-8');

  if (expected.length !== provided.length) {
    return false;
  }

  return timingSafeEqual(expected, provided);
}
