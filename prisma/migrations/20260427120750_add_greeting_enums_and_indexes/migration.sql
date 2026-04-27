-- AlterTable
ALTER TABLE "ReminderJob" ADD COLUMN     "bucketSent" TEXT,
ADD COLUMN     "convertedAt" TIMESTAMP(3);

-- RenameIndex
ALTER INDEX "User_logFrequency_onboardingDone_botBlocked_lastGreetingSentAt_" RENAME TO "User_logFrequency_onboardingDone_botBlocked_lastGreetingSen_idx";
