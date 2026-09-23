-- Step timing is now an offset from enrollment instead of a delay after the previous step.
ALTER TABLE "SequenceStep" RENAME COLUMN "delayMinutes" TO "offsetMinutes";

-- AlterTable
ALTER TABLE "Sequence" ADD COLUMN     "finalWaitMinutes" INTEGER NOT NULL DEFAULT 4320;
