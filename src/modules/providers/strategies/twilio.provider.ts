import { HttpService } from '@nestjs/axios';
import { Injectable } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { firstValueFrom } from 'rxjs';

import { normalizeProviderError } from '../errors/provider-error';
import { ISmsProvider, SendSmsOptions, SendSmsResult } from '../interfaces/sms-provider.interface';
import { resolveProviderTimeoutMs } from '../provider-timeout';

interface TwilioMessageResponse {
  sid?: string;
}

@Injectable()
export class TwilioProvider implements ISmsProvider {
  public readonly providerName = 'twilio';

  private readonly accountSid: string;
  private readonly authToken: string;
  private readonly fromNumber: string;
  private readonly timeoutMs: number;
  private readonly baseUrl: string;

  constructor(
    private readonly httpService: HttpService,
    configService: ConfigService,
  ) {
    this.accountSid = configService.getOrThrow<string>('TWILIO_ACCOUNT_SID');
    this.authToken = configService.getOrThrow<string>('TWILIO_AUTH_TOKEN');
    this.fromNumber = configService.getOrThrow<string>('TWILIO_FROM_NUMBER');
    this.timeoutMs = resolveProviderTimeoutMs(configService);
    this.baseUrl = (
      configService.get<string>('TWILIO_API_BASE_URL') ?? 'https://api.twilio.com'
    ).replace(/\/+$/, '');
  }

  async sendSms(options: SendSmsOptions): Promise<SendSmsResult> {
    const url = `${this.baseUrl}/2010-04-01/Accounts/${this.accountSid}/Messages.json`;
    const form = new URLSearchParams({
      To: options.to,
      From: this.fromNumber,
      Body: options.body,
    });

    try {
      const response = await firstValueFrom(
        this.httpService.post<TwilioMessageResponse>(url, form.toString(), {
          auth: { username: this.accountSid, password: this.authToken },
          headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
          timeout: this.timeoutMs,
        }),
      );

      return {
        success: true,
        providerMessageId: response.data.sid,
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
