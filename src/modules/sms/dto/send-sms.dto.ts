import {
  IsNotEmpty,
  IsObject,
  IsOptional,
  IsString,
  Matches,
  registerDecorator,
} from 'class-validator';

/**
 * Maximum serialized size of `metadata`, in bytes. Fixed rather than configurable: unlike
 * the message-length limit, the PRD does not call for an operator-tunable value here, just
 * a bound that keeps an accepted request small — so a static decorator is appropriate.
 */
export const MAX_METADATA_BYTES = 4096;

/**
 * Rejects a `metadata` object whose JSON-serialized size exceeds {@link MAX_METADATA_BYTES}.
 * Runs only when `@IsObject` has already confirmed the value is a plain object (or the
 * field is absent), so it never has to re-validate the type itself.
 */
function IsBoundedMetadata() {
  return function (target: object, propertyKey: string) {
    registerDecorator({
      name: 'isBoundedMetadata',
      target: target.constructor,
      propertyName: propertyKey,
      validator: {
        validate(value: unknown): boolean {
          if (value === undefined || typeof value !== 'object' || value === null) {
            return true;
          }
          return Buffer.byteLength(JSON.stringify(value), 'utf-8') <= MAX_METADATA_BYTES;
        },
        defaultMessage(): string {
          return `metadata must serialize to at most ${MAX_METADATA_BYTES} bytes`;
        },
      },
    });
  };
}

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
  @Matches(/^\+[1-9]\d{1,14}$/, { message: 'Recipient phone number must be a valid E.164 number' })
  to!: string;

  @IsString()
  @IsNotEmpty()
  message!: string;

  @IsObject()
  @IsOptional()
  @IsBoundedMetadata()
  metadata?: Record<string, unknown>;
}
