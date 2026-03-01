import "dotenv/config";
import crypto from "crypto";
import { bot } from "./bot/index";
import { startScheduler } from "./services/scheduler";
import { startUserActivity } from "./services/userActivity";
import express from "express";
import { prisma } from "./lib/prisma";

const app = express();
app.use(express.json());

// Paystack webhook endpoint
app.post("/webhook/paystack", async (req, res) => {
  const hash = crypto
    .createHmac("sha512", process.env.PAYSTACK_WEBHOOK_SECRET!)
    .update(JSON.stringify(req.body))
    .digest("hex");

  if (hash !== req.headers["x-paystack-signature"]) {
    return res.sendStatus(401);
  }

  if (req.body.event === "charge.success") {
    const telegramId = BigInt(req.body.data.metadata.telegramId);
    const ref: string = req.body.data.reference;

    await prisma.user.update({
      where: { telegramId },
      data: { isPro: true },
    });

    const user = await prisma.user.findUnique({ where: { telegramId } });
    if (user) {
      await prisma.subscription.create({
        data: {
          userId: user.id,
          paystackRef: ref,
          status: "active",
          startDate: new Date(),
          endDate: new Date(Date.now() + 30 * 24 * 60 * 60 * 1000), // +30 days
        },
      });
    }

    await bot.api.sendMessage(
      Number(telegramId),
      `You're in! Welcome to the Pro squad 👑✨ Your logbook is about to be legendary.`
    );
  }

  return res.sendStatus(200);
});

async function main() {
  await prisma.$connect();
  startScheduler(bot);
  startUserActivity(bot);
  bot.start();
  app.listen(process.env.PORT || 3000, () =>
    console.log(`Server running on port ${process.env.PORT || 3000}`)
  );
}

main();