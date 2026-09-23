-- AlterEnum
ALTER TYPE "LeadEventType" ADD VALUE 'rep_notified';

-- AlterTable
ALTER TABLE "Template" ADD COLUMN     "locale" TEXT;
