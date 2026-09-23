-- AlterTable
ALTER TABLE "Lead" ADD COLUMN     "fields" JSONB;

-- AlterTable
ALTER TABLE "LeadEvent" ADD COLUMN     "dedupeKey" TEXT;

-- CreateIndex
CREATE UNIQUE INDEX "LeadEvent_dedupeKey_key" ON "LeadEvent"("dedupeKey");
