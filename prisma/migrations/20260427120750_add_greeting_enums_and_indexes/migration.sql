-- AlterTable
ALTER TABLE "ReminderJob" ADD COLUMN     "bucketSent" TEXT,
ADD COLUMN     "convertedAt" TIMESTAMP(3);

-- RenameIndex (safe on shadow/new DBs)
DO $$
BEGIN
	IF EXISTS (
		SELECT 1 FROM pg_class WHERE relname = 'User_logFrequency_onboardingDone_botBlocked_lastGreetingSentAt_'
	) THEN
		ALTER INDEX "User_logFrequency_onboardingDone_botBlocked_lastGreetingSentAt_"
		RENAME TO "User_logFrequency_onboardingDone_botBlocked_lastGreetingSen_idx";
	END IF;
END $$;
