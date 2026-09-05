import { plainToInstance } from 'class-transformer';
import { validateSync } from 'class-validator';

import { MAX_METADATA_BYTES, SendSmsDto } from './send-sms.dto';

function validate(payload: Record<string, unknown>): string[] {
  const instance = plainToInstance(SendSmsDto, payload);
  return validateSync(instance, { whitelist: true }).flatMap((error) =>
    Object.keys(error.constraints ?? {}),
  );
}

describe('SendSmsDto', () => {
  it('accepts a valid E.164 recipient with a message', () => {
    expect(validate({ to: '+14155552671', message: 'hello' })).toEqual([]);
  });

  it('accepts optional object metadata', () => {
    expect(validate({ to: '+14155552671', message: 'hi', metadata: { purpose: 'OTP' } })).toEqual(
      [],
    );
  });

  it('rejects a non-E.164 phone number', () => {
    expect(validate({ to: '14155552671', message: 'hi' })).toContain('matches');
    expect(validate({ to: '+0155552671', message: 'hi' })).toContain('matches');
  });

  it('rejects an empty message', () => {
    expect(validate({ to: '+14155552671', message: '' })).toContain('isNotEmpty');
  });

  it('rejects metadata that is not an object', () => {
    expect(validate({ to: '+14155552671', message: 'hi', metadata: 'nope' })).toContain('isObject');
  });

  it('accepts metadata at exactly the size limit', () => {
    // `{"k":"aaa...a"}` — pad so the serialized object lands exactly at the byte limit.
    const overhead = '{"k":""}'.length;
    const metadata = { k: 'a'.repeat(MAX_METADATA_BYTES - overhead) };
    expect(Buffer.byteLength(JSON.stringify(metadata), 'utf-8')).toBe(MAX_METADATA_BYTES);

    expect(validate({ to: '+14155552671', message: 'hi', metadata })).toEqual([]);
  });

  it('rejects metadata one byte over the size limit', () => {
    const overhead = '{"k":""}'.length;
    const metadata = { k: 'a'.repeat(MAX_METADATA_BYTES - overhead + 1) };
    expect(Buffer.byteLength(JSON.stringify(metadata), 'utf-8')).toBe(MAX_METADATA_BYTES + 1);

    expect(validate({ to: '+14155552671', message: 'hi', metadata })).toContain(
      'isBoundedMetadata',
    );
  });

  it('rejects an oversized metadata array the same way as an oversized object', () => {
    const metadata = Array.from({ length: 2000 }, (_, i) => i);
    expect(validate({ to: '+14155552671', message: 'hi', metadata })).toContain('isObject');
  });
});
