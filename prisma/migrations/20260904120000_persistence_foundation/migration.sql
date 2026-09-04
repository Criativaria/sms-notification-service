CREATE TYPE "SmsMessageStatus" AS ENUM (
  'QUEUED',
  'PROCESSING',
  'RETRY_SCHEDULED',
  'SENT',
  'DELIVERED',
  'UNDELIVERED',
  'REJECTED',
  'FATAL_FAILURE'
);

CREATE TYPE "SmsAttemptOutcome" AS ENUM ('ACCEPTED', 'FAILED', 'TIMEOUT');

CREATE TABLE "sms_messages" (
  "id" UUID NOT NULL,
  "idempotencyKey" TEXT NOT NULL,
  "recipientPhone" TEXT NOT NULL,
  "encryptedMessage" TEXT NOT NULL,
  "metadata" JSONB,
  "status" "SmsMessageStatus" NOT NULL DEFAULT 'QUEUED',
  "selectedProvider" TEXT,
  "providerMessageId" TEXT,
  "lastError" TEXT,
  "deliveryAttempts" INTEGER NOT NULL DEFAULT 0,
  "retryRounds" INTEGER NOT NULL DEFAULT 0,
  "retentionExpiresAt" TIMESTAMP(3) NOT NULL,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMP(3) NOT NULL,
  CONSTRAINT "sms_messages_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "sms_idempotency_keys" (
  "key" TEXT NOT NULL,
  "smsMessageId" UUID NOT NULL,
  "expiresAt" TIMESTAMP(3) NOT NULL,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "sms_idempotency_keys_pkey" PRIMARY KEY ("key"),
  CONSTRAINT "sms_idempotency_keys_smsMessageId_key" UNIQUE ("smsMessageId")
);

CREATE TABLE "sms_attempts" (
  "id" UUID NOT NULL,
  "smsMessageId" UUID NOT NULL,
  "provider" TEXT NOT NULL,
  "providerMessageId" TEXT,
  "outcome" "SmsAttemptOutcome" NOT NULL,
  "isRetryable" BOOLEAN NOT NULL,
  "isAmbiguous" BOOLEAN NOT NULL DEFAULT false,
  "httpStatus" INTEGER,
  "errorCode" TEXT,
  "errorMessage" TEXT,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "sms_attempts_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "outbox_events" (
  "id" UUID NOT NULL,
  "aggregateType" TEXT NOT NULL,
  "aggregateId" UUID NOT NULL,
  "eventType" TEXT NOT NULL,
  "payload" JSONB NOT NULL,
  "publishedAt" TIMESTAMP(3),
  "retryCount" INTEGER NOT NULL DEFAULT 0,
  "lastError" TEXT,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMP(3) NOT NULL,
  CONSTRAINT "outbox_events_pkey" PRIMARY KEY ("id")
);

CREATE INDEX "sms_messages_idempotencyKey_idx" ON "sms_messages"("idempotencyKey");
CREATE INDEX "sms_messages_providerMessageId_idx" ON "sms_messages"("providerMessageId");
CREATE INDEX "sms_messages_retentionExpiresAt_idx" ON "sms_messages"("retentionExpiresAt");
CREATE INDEX "sms_idempotency_keys_expiresAt_idx" ON "sms_idempotency_keys"("expiresAt");
CREATE INDEX "sms_attempts_smsMessageId_createdAt_idx" ON "sms_attempts"("smsMessageId", "createdAt");
CREATE INDEX "sms_attempts_provider_providerMessageId_idx" ON "sms_attempts"("provider", "providerMessageId");
CREATE INDEX "outbox_events_publishedAt_createdAt_idx" ON "outbox_events"("publishedAt", "createdAt");
CREATE INDEX "outbox_events_aggregateType_aggregateId_idx" ON "outbox_events"("aggregateType", "aggregateId");

ALTER TABLE "sms_idempotency_keys"
  ADD CONSTRAINT "sms_idempotency_keys_smsMessageId_fkey"
  FOREIGN KEY ("smsMessageId") REFERENCES "sms_messages"("id") ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE "sms_attempts"
  ADD CONSTRAINT "sms_attempts_smsMessageId_fkey"
  FOREIGN KEY ("smsMessageId") REFERENCES "sms_messages"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

ALTER TABLE "outbox_events"
  ADD CONSTRAINT "outbox_events_aggregateId_fkey"
  FOREIGN KEY ("aggregateId") REFERENCES "sms_messages"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
