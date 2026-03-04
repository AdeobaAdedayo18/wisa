-- CreateTable
CREATE TABLE "ReplayEvent" (
    "id" SERIAL NOT NULL,
    "telegramId" BIGINT NOT NULL,
    "eventType" TEXT NOT NULL,
    "direction" TEXT NOT NULL,
    "payload" TEXT NOT NULL,
    "timestamp" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "ReplayEvent_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "ReplayEvent_telegramId_timestamp_idx" ON "ReplayEvent"("telegramId", "timestamp" DESC);

-- CreateIndex
CREATE INDEX "ReplayEvent_timestamp_idx" ON "ReplayEvent"("timestamp");
