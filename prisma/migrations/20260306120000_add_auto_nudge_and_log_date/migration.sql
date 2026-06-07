-- AlterTable
ALTER TABLE "ReminderJob" ADD COLUMN "autoNudgeCount" INTEGER NOT NULL DEFAULT 0;
ALTER TABLE "ReminderJob" ADD COLUMN "logDate" TEXT;
