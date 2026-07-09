-- AlterTable
ALTER TABLE "Subscription"
ADD COLUMN "subscriptionCode" TEXT,
ADD COLUMN "customerCode" TEXT;

-- CreateIndex
CREATE UNIQUE INDEX "Subscription_subscriptionCode_key" ON "Subscription"("subscriptionCode");
