/**
 * PII masking helpers for structured logs.
 *
 * These are the only sanctioned way to reference a phone number or a message
 * body in a log line. They are pure and never throw: any unexpected input
 * collapses to a safe placeholder so a logging call can never crash a request.
 */

const PHONE_PLACEHOLDER = '[redacted-phone]';

/**
 * Minimum length required to mask a phone number without the revealed prefix
 * (first 5 chars) overlapping the revealed suffix (last 4 chars).
 */
const MIN_MASKABLE_PHONE_LENGTH = 9;

/**
 * Masks the middle digits of a phone number, keeping the country/area prefix
 * and the last four digits.
 *
 * @example
 * maskPhone('+14155552671') // '+1415***2671'
 */
export function maskPhone(value: unknown): string {
  if (typeof value !== 'string') {
    return PHONE_PLACEHOLDER;
  }

  const trimmed = value.trim();
  if (trimmed.length < MIN_MASKABLE_PHONE_LENGTH) {
    return PHONE_PLACEHOLDER;
  }

  const prefix = trimmed.slice(0, 5);
  const suffix = trimmed.slice(-4);
  return `${prefix}***${suffix}`;
}

/**
 * Returns a length-only descriptor for a message body so the content itself
 * never reaches the logs.
 *
 * @example
 * maskBody('hello') // '[body len=5]'
 */
export function maskBody(value: unknown): string {
  const length = typeof value === 'string' ? value.length : 0;
  return `[body len=${length}]`;
}
