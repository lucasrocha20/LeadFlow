-- CreateEnum
CREATE TYPE "LeadTier" AS ENUM ('hot', 'warm', 'cold', 'disqualified');

-- CreateEnum
CREATE TYPE "LeadStatus" AS ENUM ('new', 'contacted', 'engaged', 'qualified', 'disqualified', 'converted', 'unresponsive', 'do_not_contact');

-- CreateEnum
CREATE TYPE "Channel" AS ENUM ('email', 'whatsapp', 'sms');

-- CreateEnum
CREATE TYPE "LeadEventType" AS ENUM ('captured', 'scored', 'message_sent', 'message_failed', 'reply_received', 'opted_out', 'enrolled', 'sequence_stopped', 'sequence_completed', 'status_changed', 'crm_synced', 'crm_sync_failed');

-- CreateEnum
CREATE TYPE "EnrollmentStatus" AS ENUM ('active', 'stopped', 'completed');

-- CreateTable
CREATE TABLE "Lead" (
    "id" TEXT NOT NULL,
    "firstName" TEXT,
    "lastName" TEXT,
    "email" TEXT,
    "phone" TEXT,
    "company" TEXT,
    "source" TEXT NOT NULL,
    "utm" JSONB,
    "rawPayload" JSONB NOT NULL,
    "score" INTEGER,
    "tier" "LeadTier",
    "status" "LeadStatus" NOT NULL DEFAULT 'new',
    "crmId" TEXT,
    "timezone" TEXT,
    "consentEmail" BOOLEAN NOT NULL DEFAULT false,
    "consentMessaging" BOOLEAN NOT NULL DEFAULT false,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "Lead_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "LeadEvent" (
    "id" TEXT NOT NULL,
    "leadId" TEXT NOT NULL,
    "type" "LeadEventType" NOT NULL,
    "channel" "Channel",
    "payload" JSONB,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "LeadEvent_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Sequence" (
    "id" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "tier" "LeadTier" NOT NULL,
    "active" BOOLEAN NOT NULL DEFAULT true,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "Sequence_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "SequenceStep" (
    "id" TEXT NOT NULL,
    "sequenceId" TEXT NOT NULL,
    "order" INTEGER NOT NULL,
    "delayMinutes" INTEGER NOT NULL,
    "channel" "Channel" NOT NULL,
    "templateId" TEXT NOT NULL,

    CONSTRAINT "SequenceStep_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Enrollment" (
    "id" TEXT NOT NULL,
    "leadId" TEXT NOT NULL,
    "sequenceId" TEXT NOT NULL,
    "currentStep" INTEGER NOT NULL DEFAULT 0,
    "status" "EnrollmentStatus" NOT NULL DEFAULT 'active',
    "nextRunAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "Enrollment_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Template" (
    "id" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "channel" "Channel" NOT NULL,
    "subject" TEXT,
    "body" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "Template_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "Lead_email_idx" ON "Lead"("email");

-- CreateIndex
CREATE INDEX "Lead_phone_idx" ON "Lead"("phone");

-- CreateIndex
CREATE INDEX "Lead_status_idx" ON "Lead"("status");

-- CreateIndex
CREATE INDEX "LeadEvent_leadId_createdAt_idx" ON "LeadEvent"("leadId", "createdAt");

-- CreateIndex
CREATE INDEX "LeadEvent_type_createdAt_idx" ON "LeadEvent"("type", "createdAt");

-- CreateIndex
CREATE UNIQUE INDEX "Sequence_name_key" ON "Sequence"("name");

-- CreateIndex
CREATE UNIQUE INDEX "SequenceStep_sequenceId_order_key" ON "SequenceStep"("sequenceId", "order");

-- CreateIndex
CREATE INDEX "Enrollment_status_nextRunAt_idx" ON "Enrollment"("status", "nextRunAt");

-- CreateIndex
CREATE INDEX "Enrollment_leadId_idx" ON "Enrollment"("leadId");

-- CreateIndex
CREATE UNIQUE INDEX "Template_name_key" ON "Template"("name");

-- AddForeignKey
ALTER TABLE "LeadEvent" ADD CONSTRAINT "LeadEvent_leadId_fkey" FOREIGN KEY ("leadId") REFERENCES "Lead"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "SequenceStep" ADD CONSTRAINT "SequenceStep_sequenceId_fkey" FOREIGN KEY ("sequenceId") REFERENCES "Sequence"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "SequenceStep" ADD CONSTRAINT "SequenceStep_templateId_fkey" FOREIGN KEY ("templateId") REFERENCES "Template"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Enrollment" ADD CONSTRAINT "Enrollment_leadId_fkey" FOREIGN KEY ("leadId") REFERENCES "Lead"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Enrollment" ADD CONSTRAINT "Enrollment_sequenceId_fkey" FOREIGN KEY ("sequenceId") REFERENCES "Sequence"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
