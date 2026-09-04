import { maskBody, maskPhone } from './masking';

describe('maskPhone', () => {
  it('keeps the prefix and last four digits, masking the middle', () => {
    expect(maskPhone('+14155552671')).toBe('+1415***2671');
  });

  it('masks a plain (no plus) number of sufficient length', () => {
    expect(maskPhone('14155552671')).toBe('14155***2671');
  });

  it('trims surrounding whitespace before masking', () => {
    expect(maskPhone('  +14155552671  ')).toBe('+1415***2671');
  });

  it('returns a placeholder for a number that is too short to mask safely', () => {
    expect(maskPhone('+1415')).toBe('[redacted-phone]');
  });

  it('returns a placeholder for an empty string', () => {
    expect(maskPhone('')).toBe('[redacted-phone]');
  });

  it('returns a placeholder for undefined', () => {
    expect(maskPhone(undefined)).toBe('[redacted-phone]');
  });

  it('returns a placeholder for null', () => {
    expect(maskPhone(null)).toBe('[redacted-phone]');
  });

  it('returns a placeholder for non-string input', () => {
    expect(maskPhone(14155552671)).toBe('[redacted-phone]');
  });

  it('never reveals the middle digits', () => {
    const masked = maskPhone('+14155552671');
    expect(masked).not.toContain('5555');
  });
});

describe('maskBody', () => {
  it('returns a length-only descriptor for a normal body', () => {
    expect(maskBody('hello')).toBe('[body len=5]');
  });

  it('returns length zero for an empty string', () => {
    expect(maskBody('')).toBe('[body len=0]');
  });

  it('returns length zero for undefined', () => {
    expect(maskBody(undefined)).toBe('[body len=0]');
  });

  it('returns length zero for null', () => {
    expect(maskBody(null)).toBe('[body len=0]');
  });

  it('returns length zero for non-string input', () => {
    expect(maskBody({ message: 'secret' })).toBe('[body len=0]');
  });

  it('never includes the body content', () => {
    expect(maskBody('super secret code 123456')).not.toContain('123456');
  });
});
