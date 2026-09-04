import { plainToInstance } from 'class-transformer';
import { validateSync } from 'class-validator';

import { SendSmsDto } from './send-sms.dto';

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
});
