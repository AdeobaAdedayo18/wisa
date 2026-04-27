DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_type WHERE typname = 'GreetingType') THEN
    CREATE TYPE "GreetingType" AS ENUM ('MORNING', 'AFTERNOON');
  END IF;
END $$;

ALTER TABLE "User"
ALTER COLUMN "lastGreetingType" TYPE "GreetingType"
USING (
  CASE
    WHEN "lastGreetingType" IS NULL THEN NULL
    WHEN LOWER("lastGreetingType"::text) = 'morning' THEN 'MORNING'::"GreetingType"
    WHEN LOWER("lastGreetingType"::text) = 'afternoon' THEN 'AFTERNOON'::"GreetingType"
    ELSE NULL
  END
);

CREATE INDEX IF NOT EXISTS "User_logFrequency_onboardingDone_botBlocked_lastGreetingSentAt_idx"
ON "User"("logFrequency", "onboardingDone", "botBlocked", "lastGreetingSentAt");

CREATE INDEX IF NOT EXISTS "User_lastGreetingType_idx"
ON "User"("lastGreetingType");
