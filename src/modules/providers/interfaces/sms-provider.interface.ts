export interface SendSmsOptions {
  to: string;
  body: string;
  referenceId: string;
}

export interface SendSmsResult {
  success: boolean;
  providerMessageId?: string;
  error?: string;
  isRetryable: boolean;
  /**
   * True when the outcome is unconfirmed (timeout, network error, or no response) — we do
   * not know whether the provider accepted the message. An ambiguous result must never
   * trigger an automatic retry or failover to another provider; only an audited operator
   * resolution or a provider callback may advance it. Omitted/false means the provider gave
   * a definitive answer (a success or a clean HTTP error response).
   */
  isAmbiguous?: boolean;
}

export interface ISmsProvider {
  readonly providerName: string;
  sendSms(options: SendSmsOptions): Promise<SendSmsResult>;
}
