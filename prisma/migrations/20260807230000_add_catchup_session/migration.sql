-- CreateEnum
CREATE TYPE "CatchupTier" AS ENUM ('QUICK_FIX', 'FULL_BACKLOG', 'VIP_DEFENSE');

-- CreateEnum
CREATE TYPE "CatchupPaymentStatus" AS ENUM ('PENDING', 'PAID');

-- CreateTable
CREATE TABLE "CatchupSession" (
    "id" TEXT NOT NULL,
    "userId" INTEGER NOT NULL,
    "tierSelected" "CatchupTier" NOT NULL,
    "totalDuration" INTEGER NOT NULL,
    "currentBlock" INTEGER NOT NULL DEFAULT 1,
    "startDate" TIMESTAMP(3) NOT NULL,
    "contextDump" JSONB,
    "paymentStatus" "CatchupPaymentStatus" NOT NULL DEFAULT 'PENDING',
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "CatchupSession_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "CatchupSession_userId_createdAt_idx" ON "CatchupSession"("userId", "createdAt");

-- AddForeignKey
ALTER TABLE "CatchupSession" ADD CONSTRAINT "CatchupSession_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
