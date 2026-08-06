-- CreateEnum
CREATE TYPE "TransactionStatus" AS ENUM ('PENDING', 'SUCCESS', 'FAILED');

-- AlterTable
ALTER TABLE "PaymentTransaction" ADD COLUMN "status" "TransactionStatus" NOT NULL DEFAULT 'PENDING';

-- AlterTable
ALTER TABLE "PaymentTransaction" ALTER COLUMN "paidAt" DROP NOT NULL;

-- Backfill: every row that existed before this migration was only ever written
-- on a confirmed charge, so it is SUCCESS. Without this the default would mark
-- all historical revenue as PENDING and zero out the dashboard.
UPDATE "PaymentTransaction" SET "status" = 'SUCCESS' WHERE "paidAt" IS NOT NULL;

-- CreateIndex
CREATE INDEX "PaymentTransaction_status_idx" ON "PaymentTransaction"("status");
