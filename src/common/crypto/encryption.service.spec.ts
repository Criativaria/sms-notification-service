import { ConfigService } from '@nestjs/config';

import { EncryptionService } from './encryption.service';

function createService(key: Buffer = randomKey()): EncryptionService {
  const configService = {
    getOrThrow: jest.fn(() => key.toString('base64')),
  } as unknown as ConfigService;

  const service = new EncryptionService(configService);
  service.onModuleInit();
  return service;
}

function randomKey(): Buffer {
  const key = Buffer.alloc(32);
  for (let index = 0; index < key.length; index += 1) {
    key[index] = (index * 7 + 3) % 256;
  }
  return key;
}

describe('EncryptionService', () => {
  it('round-trips plaintext through encrypt and decrypt', () => {
    const service = createService();
    const plaintext = 'Your verification code is 123456';

    const token = service.encrypt(plaintext);

    expect(token).not.toContain(plaintext);
    expect(service.decrypt(token)).toBe(plaintext);
  });

  it('produces a distinct token per call because of a random iv', () => {
    const service = createService();

    const first = service.encrypt('same message');
    const second = service.encrypt('same message');

    expect(first).not.toBe(second);
    expect(service.decrypt(first)).toBe('same message');
    expect(service.decrypt(second)).toBe('same message');
  });

  it('rejects a tampered token via the authentication tag', () => {
    const service = createService();
    const token = service.encrypt('sensitive');
    const bytes = Buffer.from(token, 'base64');
    const lastIndex = bytes.length - 1;
    bytes.writeUInt8(bytes.readUInt8(lastIndex) ^ 0xff, lastIndex);

    expect(() => service.decrypt(bytes.toString('base64'))).toThrow();
  });

  it('rejects a malformed token that is too short', () => {
    const service = createService();

    expect(() => service.decrypt(Buffer.alloc(4).toString('base64'))).toThrow(
      'Encrypted token is malformed',
    );
  });

  it('fails fast at startup when the key is not 32 bytes', () => {
    expect(() => createService(Buffer.alloc(16))).toThrow(/must decode to 32 bytes/);
  });
});
