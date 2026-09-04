import { IsNotEmpty, IsObject, IsOptional, IsString, Matches } from 'class-validator';

/**
 * Body of `POST /api/v1/sms/send`.
 *
 * `to` is validated with a strict E.164 regex (`@Matches`) rather than
 * `@IsPhoneNumber` for deterministic, dependency-free behavior.
 *
 * The message length limit is configurable via `MAX_MESSAGE_LENGTH`.
 * class-validator decorators are static and cannot read runtime config, so the
 * configurable limit is enforced in `SmsService` against `ConfigService`
 * instead of a static `@MaxLength` here — keeping a single source of truth and
 * avoiding a decorator that would wrongly reject messages when the configured
 * limit is raised above a hard-coded value.
 */
export class SendSmsDto {
  @Matches(/^\+[1-9]\d{1,14}$/, { message: 'to must be a valid E.164 phone number' })
  to!: string;

  @IsString()
  @IsNotEmpty()
  message!: string;

  @IsObject()
  @IsOptional()
  metadata?: Record<string, unknown>;
}
