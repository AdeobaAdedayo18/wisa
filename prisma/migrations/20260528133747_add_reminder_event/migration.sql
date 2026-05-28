/*
  Warnings:

  - The required column `cycleId` was added to the `ReminderJob` table with a prisma-level default value. This is not possible if the table is not empty. Please add this column as optional, then populate it before making it required.

*/
-- AlterTable
LOCK TABLE "ReminderJob" IN ACCESS EXCLUSIVE MODE;

ALTER TABLE "ReminderJob" ADD COLUMN     "cycleId" TEXT,
ADD COLUMN     "sentAt" TIMESTAMP(3);

ALTER TABLE "ReminderJob" ALTER COLUMN "cycleId" SET DEFAULT CONCAT('cycle_', md5(random()::text || clock_timestamp()::text));

UPDATE "ReminderJob"
SET "cycleId" = COALESCE("cycleId", CONCAT('cycle_', "id"::text))
WHERE "cycleId" IS NULL;

ALTER TABLE "ReminderJob" ALTER COLUMN "cycleId" SET NOT NULL;

-- AlterTable
ALTER TABLE "User" ALTER COLUMN "freeAiRefinements" SET DEFAULT 5,
ALTER COLUMN "freeVoiceLogs" SET DEFAULT 5;

-- CreateTable
CREATE TABLE "ReminderEvent" (
    "id" SERIAL NOT NULL,
    "reminderJobId" INTEGER NOT NULL,
    "eventType" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "metadata" JSONB,

    CONSTRAINT "ReminderEvent_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "ReminderEvent_reminderJobId_createdAt_idx" ON "ReminderEvent"("reminderJobId", "createdAt");

-- CreateIndex
CREATE INDEX "ReminderJob_cycleId_idx" ON "ReminderJob"("cycleId");

-- CreateIndex
CREATE INDEX "ReminderJob_userId_status_scheduledFor_idx" ON "ReminderJob"("userId", "status", "scheduledFor");

-- CreateIndex
CREATE INDEX "ReminderJob_status_scheduledFor_idx" ON "ReminderJob"("status", "scheduledFor");

-- CreateIndex
CREATE INDEX "ReminderJob_status_autoNudgeCount_idx" ON "ReminderJob"("status", "autoNudgeCount");

-- CreateIndex
CREATE INDEX "ReminderJob_sentAt_idx" ON "ReminderJob"("sentAt");

-- AddForeignKey
ALTER TABLE "ReminderJob" ADD CONSTRAINT "ReminderJob_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ReminderEvent" ADD CONSTRAINT "ReminderEvent_reminderJobId_fkey" FOREIGN KEY ("reminderJobId") REFERENCES "ReminderJob"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- RenameIndex
ALTER INDEX "User_logFrequency_onboardingDone_botBlocked_lastGreetingSentAt_" RENAME TO "User_logFrequency_onboardingDone_botBlocked_lastGreetingSen_idx";
