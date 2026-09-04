import { createCipheriv, createDecipheriv, randomBytes } from 'node:crypto';

import { Injectable, OnModuleInit } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';

const algorithm = 'aes-256-gcm';
const keyLengthBytes = 32;
const ivLengthBytes = 12;
const authTagLengthBytes = 16;

/**
 * AES-256-GCM encryption of message bodies at rest.
 *
 * The key is a base64-encoded 32-byte secret provided via `ENCRYPTION_KEY`.
 * Environment validation already asserts the key decodes to 32 bytes; this
 * service re-validates at startup so a misconfigured key fails fast rather
 * than at the first encrypt call.
 *
 * `encrypt` produces a self-contained base64 token laying out
 * `iv (12 bytes) | authTag (16 bytes) | ciphertext`, so `decrypt` needs no
 * side-channel state to reverse it.
 */
@Injectable()
export class EncryptionService implements OnModuleInit {
  private readonly key: Buffer;

  constructor(configService: ConfigService) {
    const encodedKey = configService.getOrThrow<string>('ENCRYPTION_KEY');
    this.key = Buffer.from(encodedKey, 'base64');
  }

  onModuleInit(): void {
    if (this.key.length !== keyLengthBytes) {
      throw new Error(
        `ENCRYPTION_KEY must decode to ${keyLengthBytes} bytes, received ${this.key.length}`,
      );
    }
  }

  encrypt(plaintext: string): string {
    const iv = randomBytes(ivLengthBytes);
    const cipher = createCipheriv(algorithm, this.key, iv);
    const ciphertext = Buffer.concat([cipher.update(plaintext, 'utf8'), cipher.final()]);
    const authTag = cipher.getAuthTag();

    return Buffer.concat([iv, authTag, ciphertext]).toString('base64');
  }

  decrypt(token: string): string {
    const payload = Buffer.from(token, 'base64');
    if (payload.length < ivLengthBytes + authTagLengthBytes) {
      throw new Error('Encrypted token is malformed');
    }

    const iv = payload.subarray(0, ivLengthBytes);
    const authTag = payload.subarray(ivLengthBytes, ivLengthBytes + authTagLengthBytes);
    const ciphertext = payload.subarray(ivLengthBytes + authTagLengthBytes);

    const decipher = createDecipheriv(algorithm, this.key, iv);
    decipher.setAuthTag(authTag);

    return Buffer.concat([decipher.update(ciphertext), decipher.final()]).toString('utf8');
  }
}
