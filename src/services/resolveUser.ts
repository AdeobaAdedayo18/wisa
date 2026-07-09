import { prisma } from "../lib/prisma";


export async function resolveUser(payload: any) {
  // a. metadata.telegramId (fast path)
  const rawTelegramId = payload?.data?.metadata?.telegramId;
  if (rawTelegramId) {
    try {
      const user = await prisma.user.findUnique({
        where: { telegramId: BigInt(rawTelegramId) },
      });
      if (user) return user;
    } catch {
      // malformed telegramId — fall through to the next strategy
    }
  }

  // b. customer.email — paymentEmail is not unique, so require an unambiguous
  // single match. If more than one user shares the email, refuse to guess.
  const email: string | undefined = payload?.data?.customer?.email;
  if (email) {
    const matches = await prisma.user.findMany({ where: { paymentEmail: email } });
    if (matches.length === 1) return matches[0];
    if (matches.length > 1) {
      console.warn(
        `[resolveUser] Ambiguous email resolution — ${matches.length} users share paymentEmail=${email}; refusing to guess.`,
      );
      return null;
    }
  }

  // c. subscription_code (invoice.* carries it under data.subscription)
  // UNVERIFIED payload shape — confirm against a real invoice.* event in C2
  // before trusting. Inert until C2 backfills Subscription.subscriptionCode.
  const subscriptionCode: string | undefined =
    payload?.data?.subscription_code ?? payload?.data?.subscription?.subscription_code;
  if (subscriptionCode) {
    const sub = await prisma.subscription.findUnique({
      where: { subscriptionCode },
      include: { user: true },
    });
    if (sub?.user) return sub.user;
  }

  return null;
}
