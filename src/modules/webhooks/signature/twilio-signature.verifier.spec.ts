import { computeTwilioSignature, verifyTwilioSignature } from './twilio-signature.verifier';

describe('twilio-signature.verifier', () => {
  const authToken = 'test-auth-token';
  const url = 'http://localhost:3000/webhooks/twilio';
  const params = {
    MessageStatus: 'delivered',
    MessageSid: 'SM1234567890abcdef',
    AccountSid: 'AC0000000000',
  };

  it('accepts a signature produced by the same algorithm', () => {
    const signature = computeTwilioSignature(authToken, url, params);

    expect(verifyTwilioSignature(authToken, url, params, signature)).toBe(true);
  });

  it('sorts parameters by key regardless of input order', () => {
    const reordered = {
      AccountSid: params.AccountSid,
      MessageSid: params.MessageSid,
      MessageStatus: params.MessageStatus,
    };
    const signature = computeTwilioSignature(authToken, url, reordered);

    expect(verifyTwilioSignature(authToken, url, params, signature)).toBe(true);
  });

  it('rejects a tampered signature', () => {
    const signature = computeTwilioSignature(authToken, url, params);

    expect(verifyTwilioSignature(authToken, url, params, `${signature}x`)).toBe(false);
  });

  it('rejects when a parameter value was altered after signing', () => {
    const signature = computeTwilioSignature(authToken, url, params);
    const tamperedParams = { ...params, MessageStatus: 'failed' };

    expect(verifyTwilioSignature(authToken, url, tamperedParams, signature)).toBe(false);
  });

  it('rejects a signature computed with a different auth token', () => {
    const signature = computeTwilioSignature('other-token', url, params);

    expect(verifyTwilioSignature(authToken, url, params, signature)).toBe(false);
  });

  it('rejects a missing signature header', () => {
    expect(verifyTwilioSignature(authToken, url, params, undefined)).toBe(false);
    expect(verifyTwilioSignature(authToken, url, params, '')).toBe(false);
  });
});
