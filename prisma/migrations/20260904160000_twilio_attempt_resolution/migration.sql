CREATE TYPE "SmsAttemptResolutionType" AS ENUM ('KNOWN_SID', 'UNDELIVERED');

CREATE TYPE "SmsUndeliveredEvidenceCode" AS ENUM ('TWILIO_UNDELIVERED_CONFIRMED');

CREATE TABLE "sms_attempt_resolutions" (
  "id" UUID NOT NULL,
  "smsMessageId" UUID NOT NULL,
  "smsAttemptId" UUID NOT NULL,
  "resolution" "SmsAttemptResolutionType" NOT NULL,
  "providerMessageId" TEXT,
  "evidenceCode" "SmsUndeliveredEvidenceCode",
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "sms_attempt_resolutions_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "sms_attempt_resolutions_smsAttemptId_key" ON "sms_attempt_resolutions"("smsAttemptId");
CREATE INDEX "sms_attempt_resolutions_smsMessageId_createdAt_idx" ON "sms_attempt_resolutions"("smsMessageId", "createdAt");

ALTER TABLE "sms_attempt_resolutions"
  ADD CONSTRAINT "sms_attempt_resolutions_smsMessageId_fkey"
  FOREIGN KEY ("smsMessageId") REFERENCES "sms_messages"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

ALTER TABLE "sms_attempt_resolutions"
  ADD CONSTRAINT "sms_attempt_resolutions_smsAttemptId_fkey"
  FOREIGN KEY ("smsAttemptId") REFERENCES "sms_attempts"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

ALTER TABLE "sms_attempt_resolutions"
  ADD CONSTRAINT "sms_attempt_resolutions_known_sid_check"
  CHECK (
    ("resolution" = 'KNOWN_SID' AND "providerMessageId" IS NOT NULL AND "evidenceCode" IS NULL)
    OR ("resolution" = 'UNDELIVERED' AND "providerMessageId" IS NULL AND "evidenceCode" IS NOT NULL)
  );
