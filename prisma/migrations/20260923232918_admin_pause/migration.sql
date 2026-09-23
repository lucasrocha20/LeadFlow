-- Enum additions only (they can't share a transaction with statements that use them).
-- IF NOT EXISTS keeps this safe to re-apply after a partial failure.

-- AlterEnum
ALTER TYPE "EnrollmentStatus" ADD VALUE IF NOT EXISTS 'paused';

-- AlterEnum
ALTER TYPE "LeadEventType" ADD VALUE IF NOT EXISTS 'sequence_paused';
ALTER TYPE "LeadEventType" ADD VALUE IF NOT EXISTS 'sequence_resumed';
