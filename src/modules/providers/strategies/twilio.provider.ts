import { Injectable } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
// The Twilio SDK ships as `export = TwilioSDK` (no ES `default`), and this project doesn't set
// `esModuleInterop`, so a plain `import Twilio from 'twilio'` compiles to a broken `.default`
// access at runtime. `import ... = require(...)` compiles to a direct `require('twilio')` call,
// matching the module's actual CommonJS shape.
// eslint-disable-next-line @typescript-eslint/no-require-imports -- only import form that matches the SDK's `export =` shape without `esModuleInterop` (see comment above)
import Twilio = require('twilio');

import { normalizeProviderError } from '../errors/provider-error';
import { ISmsProvider, SendSmsOptions, SendSmsResult } from '../interfaces/sms-provider.interface';
import { resolveProviderTimeoutMs } from '../provider-timeout';

@Injectable()
export class TwilioProvider implements ISmsProvider {
  public readonly providerName = 'twilio';

  private readonly fromNumber: string;
  private readonly client: Twilio.Twilio;

  constructor(configService: ConfigService) {
    const accountSid = configService.getOrThrow<string>('TWILIO_ACCOUNT_SID');
    const authToken = configService.getOrThrow<string>('TWILIO_AUTH_TOKEN');
    this.fromNumber = configService.getOrThrow<string>('TWILIO_FROM_NUMBER');
    const timeoutMs = resolveProviderTimeoutMs(configService);

    this.client = Twilio(accountSid, authToken, { timeout: timeoutMs });

    const baseUrl = configService.get<string>('TWILIO_API_BASE_URL');
    if (baseUrl) {
      // The Twilio SDK hardcodes `https://api.twilio.com` as the `api` domain's base URL
      // (see `ApiBase` in the SDK) and exposes no constructor option to override it — `edge`/
      // `region` only rewrite the hostname prefix, they don't replace the whole origin. This
      // mutates the (public, settable) `baseUrl` on the already-constructed domain object,
      // which is the only way to redirect requests to a local mock/sandbox target. It is an
      // undocumented but stable seam (a plain property read on every request), kept solely to
      // preserve the existing `TWILIO_API_BASE_URL` override behavior used by the sandbox/tests.
      this.client.api.baseUrl = baseUrl.replace(/\/+$/, '');
    }
  }

  async sendSms(options: SendSmsOptions): Promise<SendSmsResult> {
    try {
      const message = await this.client.messages.create({
        to: options.to,
        from: this.fromNumber,
        body: options.body,
      });

      return {
        success: true,
        providerMessageId: message.sid,
        isRetryable: false,
      };
    } catch (error) {
      const normalized = normalizeProviderError(error, this.providerName);
      return {
        success: false,
        error: normalized.message,
        isRetryable: normalized.isRetryable,
        isAmbiguous: normalized.kind !== 'http',
      };
    }
  }
}
