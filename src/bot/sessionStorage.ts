import type { StorageAdapter } from "grammy";
import { PrismaAdapter } from "@grammyjs/storage-prisma";
import { prisma } from "../lib/prisma";
import type { SessionData } from "./types";

/**
 * Session storage that survives out-of-band writes.
 *
 * grammY loads the session blob at the start of an update and writes its whole
 * in-memory copy back at the end. Fulfilment triggered by the Paystack webhook
 * runs outside that cycle and can take a minute (OpenAI), so a user message that
 * started before the webhook landed would write its stale snapshot over the
 * webhook's patch — leaving the user parked on the old catch-up step.
 *
 * Two mechanisms fix that:
 *
 *  1. `catchupRev` travels inside the session object, so the value being written
 *     carries the revision it was read at. If the stored revision is newer, the
 *     catch-up keys from storage win and everything else in the update is kept.
 *  2. The write itself is a compare-and-swap on the exact stored string, so a
 *     patch landing between the re-read and the write is not lost either — it
 *     just costs a retry.
 *
 * Note the deliberate precedence: when both sides touched the catch-up state,
 * the out-of-band writer wins, because it always represents the later event
 * (payment confirmed, block fulfilled) and is the one the user cannot redo.
 */

const CAS_ATTEMPTS = 3;

/** Keys owned by the out-of-band writers and guarded by `catchupRev`. */
function adoptCatchupKeys(target: SessionData, source: Partial<SessionData>): SessionData {
  return {
    ...target,
    catchup: source.catchup,
    catchupSessionId: source.catchupSessionId,
    catchupRev: source.catchupRev,
  };
}

export function createSessionStorage(): StorageAdapter<SessionData> {
  const inner = new PrismaAdapter<SessionData>(prisma.session);

  return {
    read: (key) => inner.read(key),
    delete: (key) => inner.delete(key),

    async write(key, value) {
      for (let attempt = 0; attempt < CAS_ATTEMPTS; attempt++) {
        const row = await prisma.session.findUnique({ where: { key }, select: { value: true } });

        // First write for this key — nothing to merge against.
        if (!row?.value) return inner.write(key, value);

        let stored: Partial<SessionData>;
        try {
          stored = JSON.parse(row.value) as Partial<SessionData>;
        } catch {
          return inner.write(key, value); // unreadable row: last good write wins
        }

        const storedRev = stored.catchupRev ?? 0;
        const ourRev = value.catchupRev ?? 0;
        const merged = storedRev > ourRev ? adoptCatchupKeys(value, stored) : value;

        // CAS: only overwrite the exact blob we just read.
        const result = await prisma.session.updateMany({
          where: { key, value: row.value },
          data: { value: JSON.stringify(merged) },
        });

        if (result.count > 0) return;
      }

      console.warn(`[session] CAS write for ${key} lost ${CAS_ATTEMPTS} races — falling back to blind write.`);
      return inner.write(key, value);
    },
  };
}

/**
 * Merges a patch into a stored session's catch-up state from outside the grammY
 * update cycle, bumping `catchupRev` so an in-flight update cannot clobber it.
 * Returns true when the patch was written.
 */
export async function patchStoredSessionCatchup(
  key: string,
  mutate: (session: Record<string, any>) => void,
): Promise<boolean> {
  for (let attempt = 0; attempt < CAS_ATTEMPTS; attempt++) {
    const row = await prisma.session.findUnique({ where: { key }, select: { value: true } });
    if (!row?.value) return false;

    let sessionData: Record<string, any>;
    try {
      sessionData = JSON.parse(row.value);
    } catch {
      return false;
    }

    mutate(sessionData);
    sessionData.catchupRev = (sessionData.catchupRev ?? 0) + 1;

    const result = await prisma.session.updateMany({
      where: { key, value: row.value },
      data: { value: JSON.stringify(sessionData) },
    });

    if (result.count > 0) return true;
  }

  console.warn(`[session] Catch-up patch for ${key} lost ${CAS_ATTEMPTS} races — giving up.`);
  return false;
}
