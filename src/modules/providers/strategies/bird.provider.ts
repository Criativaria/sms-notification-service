import { HttpService } from '@nestjs/axios';
import { Injectable } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { firstValueFrom } from 'rxjs';

import { normalizeProviderError } from '../errors/provider-error';
import { ISmsProvider, SendSmsOptions, SendSmsResult } from '../interfaces/sms-provider.interface';
import { resolveProviderTimeoutMs } from '../provider-timeout';

interface BirdMessageResponse {
  id?: string;
}

@Injectable()
export class BirdProvider implements ISmsProvider {
  public readonly providerName = 'bird';

  private readonly apiKey: string;
  private readonly workspaceId: string;
  private readonly channelId: string;
  private readonly timeoutMs: number;
  private readonly baseUrl: string;

  constructor(
    private readonly httpService: HttpService,
    configService: ConfigService,
  ) {
    this.apiKey = configService.getOrThrow<string>('BIRD_API_KEY');
    this.workspaceId = configService.getOrThrow<string>('BIRD_WORKSPACE_ID');
    this.channelId = configService.getOrThrow<string>('BIRD_CHANNEL_ID');
    this.timeoutMs = resolveProviderTimeoutMs(configService);
    this.baseUrl = (
      configService.get<string>('BIRD_API_BASE_URL') ?? 'https://api.bird.com'
    ).replace(/\/+$/, '');
  }

  async sendSms(options: SendSmsOptions): Promise<SendSmsResult> {
    const url = `${this.baseUrl}/workspaces/${this.workspaceId}/channels/${this.channelId}/messages`;
    const payload = {
      receiver: { contacts: [{ identifierValue: options.to }] },
      body: { type: 'text', text: { text: options.body } },
      reference: options.referenceId,
    };

    try {
      const response = await firstValueFrom(
        this.httpService.post<BirdMessageResponse>(url, payload, {
          headers: {
            Authorization: `AccessKey ${this.apiKey}`,
            'Content-Type': 'application/json',
          },
          timeout: this.timeoutMs,
        }),
      );

      return {
        success: true,
        providerMessageId: response.data.id,
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
