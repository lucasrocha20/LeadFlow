-- AlterTable
ALTER TABLE "Lead" ADD COLUMN     "crmSyncError" TEXT,
ADD COLUMN     "crmSyncFailedAt" TIMESTAMP(3),
ADD COLUMN     "crmSyncedEventId" TEXT,
ADD COLUMN     "crmSyncedThrough" TIMESTAMP(3);
