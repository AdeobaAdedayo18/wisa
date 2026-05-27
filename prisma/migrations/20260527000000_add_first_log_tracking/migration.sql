-- AlterTable
ALTER TABLE "User" ADD COLUMN "firstLogPromptSent" BOOLEAN NOT NULL DEFAULT false;
ALTER TABLE "User" ADD COLUMN "firstLogCompletedInOnboarding" BOOLEAN NOT NULL DEFAULT false;
