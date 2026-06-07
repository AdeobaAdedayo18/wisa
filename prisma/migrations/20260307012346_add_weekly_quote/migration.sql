-- CreateTable
CREATE TABLE "WeeklyQuote" (
    "id" SERIAL NOT NULL,
    "weekNumber" INTEGER NOT NULL,
    "quote" TEXT NOT NULL,
    "attribution" TEXT,

    CONSTRAINT "WeeklyQuote_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "WeeklyQuote_weekNumber_key" ON "WeeklyQuote"("weekNumber");
