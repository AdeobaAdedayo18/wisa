import { prisma } from "../lib/prisma";
import { Prisma } from "../prisma/client";

type RecordTransactionInput = {
  userId: number;
  amount: number;
  currency: string;
  provider: string;
  reference: string;
  metadata?: Prisma.InputJsonValue;
  paidAt: Date;
};

export async function recordSuccessfulTransaction(input: RecordTransactionInput): Promise<void> {
  await prisma.paymentTransaction.upsert({
    where: { reference: input.reference },
    update: {
      userId: input.userId,
      amount: input.amount,
      currency: input.currency,
      provider: input.provider,
      metadata: input.metadata,
      paidAt: input.paidAt,
    },
    create: {
      userId: input.userId,
      amount: input.amount,
      currency: input.currency,
      provider: input.provider,
      reference: input.reference,
      metadata: input.metadata,
      paidAt: input.paidAt,
    },
  });
}
