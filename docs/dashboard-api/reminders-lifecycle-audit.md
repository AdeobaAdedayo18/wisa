# Reminder Lifecycle Audit for `GET /api/dashboard/reminders`

## Bottom line

Your mental model is close, but the current code does **not** preserve a clean lifecycle history for a reminder cycle.

What the code really has today is:

- one active reminder job per user at a time, sometimes,
- multiple reminder job rows per user over time,
- a mutable `status` field that is reused for both state and workflow control,
- one interaction timestamp `convertedAt`, and
- no immutable event log for send, snooze, skip, or auto-expire events.

So the dashboard can show a current-state snapshot, but it cannot reliably answer “what happened during the last cycle” without extra infrastructure.

## Correcting the assumptions

### 1. It is not one reminder row per user forever

The code does not enforce a single permanent row per user.

`scheduleNextJob()` creates a new `ReminderJob` row when there is no pending job:

```ts
// src/bot/reminders.ts
if (existingJob) {
  ...
  return;
}

await tx.reminderJob.create({
  data: { userId, telegramId, scheduledFor: adjustedScheduledFor, status: "pending", logDate },
});
```

The snooze flow can also create another pending row:

```ts
// src/bot/reminders.ts
if (!existingNearPending) {
  await prisma.reminderJob.create({
    data: {
      userId: job.userId,
      telegramId: job.telegramId,
      scheduledFor: snoozedUntil,
      status: "pending",
      snoozeCount: newSnoozeCount,
      autoNudgeCount: 0,
      logDate: job.logDate,
    },
  });
}
```

So the real invariant is closer to: **one pending job per user at a time**, not one row per user total.

### 2. `sent` is not a final lifecycle bucket

`sent` means the bot successfully delivered the reminder message and the row was updated to `status: "sent"`.

In the main scheduler:

```ts
// src/services/scheduler.ts
await prisma.reminderJob.update({
  where: { id: job.id },
  data: { status: "sent", logDate, bucketSent: bucket },
});
```

But that row can later move to another status:

```ts
// src/bot/reminders.ts
await prisma.reminderJob.update({
  where: { id: jobId },
  data: { status: "skipped" },
});
```

```ts
// src/bot/reminders.ts
await prisma.reminderJob.update({
  where: { id: jobId },
  data: {
    autoNudgeCount: 3,
    convertedAt: job?.convertedAt ? undefined : new Date(),
  },
});
```

That means current dashboard counts are **state snapshots**, not lifecycle totals.

## What actually happens when the user taps actions

### `Remind me in 30 mins`

The callback handler is `handleSnooze()`:

```ts
// src/bot/reminders.ts
export async function handleSnooze(ctx: BotContext): Promise<void> {
  const job = await prisma.reminderJob.findUnique({ where: { id: jobId } });
  ...
  const newSnoozeCount = job.snoozeCount + 1;

  if (newSnoozeCount >= 3) {
    await prisma.reminderJob.update({
      where: { id: jobId },
      data: { snoozeCount: newSnoozeCount, status: "snoozed", autoNudgeCount: 3 },
    });
    ...
  } else {
    const snoozedUntil = new Date(Date.now() + 30 * 60 * 1000);
    ...
    await prisma.reminderJob.update({
      where: { id: jobId },
      data: { snoozeCount: newSnoozeCount, status: "snoozed", autoNudgeCount: 3 },
    });

    if (!existingNearPending) {
      await prisma.reminderJob.create({
        data: {
          userId: job.userId,
          telegramId: job.telegramId,
          scheduledFor: snoozedUntil,
          status: "pending",
          snoozeCount: newSnoozeCount,
          autoNudgeCount: 0,
          logDate: job.logDate,
        },
      });
    }
  }
}
```

What that means in plain English:

- the current job is marked `snoozed`,
- `snoozeCount` increases,
- the bot replies that it will remind the user again,
- and usually a new pending job is created for 30 minutes later.

### `Skip today`

The callback handler is `handleSkip()`:

```ts
// src/bot/reminders.ts
export async function handleSkip(ctx: BotContext): Promise<void> {
  await prisma.reminderJob.update({
    where: { id: jobId },
    data: { status: "skipped" },
  });

  await ctx.editMessageReplyMarkup({ reply_markup: { inline_keyboard: [] } });
  await ctx.reply("No wahala! 😊 See you next time 👋");
}
```

What that means:

- the current job is explicitly marked `skipped`,
- the buttons are removed from the Telegram message,
- and the bot sends a confirmation reply.

### `Write my log`

The callback handler is `handleWriteFromReminder()`:

```ts
// src/bot/reminders.ts
await prisma.reminderJob.update({
  where: { id: jobId },
  data: {
    autoNudgeCount: 3,
    convertedAt: job?.convertedAt ? undefined : new Date(),
  },
});
```

What that means:

- the reminder is counted as converted,
- auto-nudging stops,
- and the log flow starts for the reminder’s date.

This is an **interaction marker**, not proof that a final log row was saved successfully.

## Why your desired dashboard metric is not reliable yet

You want the dashboard to answer something like:

- how many reminder cycles were sent,
- how many of those were skipped,
- how many were snoozed,
- how many converted,
- and which hour converted best over the last day/week/month.

The current code cannot answer that cleanly because:

1. There is no immutable reminder-cycle identifier.
2. There is no `sentAt` field.
3. The `status` field is mutable and reused as control flow.
4. Snooze creates new rows, so one lifecycle can span multiple rows.
5. Auto-nudge can move jobs between `sent`, `snoozed`, and `skipped`.
6. `convertedAt` is the only durable user-action timestamp.

So the endpoint can tell you the current table state, but it cannot reconstruct the full lifecycle of a cycle without guessing.

## What infrastructure already exists

You do already have some useful pieces:

- `status`
- `snoozeCount`
- `autoNudgeCount`
- `bucketSent`
- `convertedAt`
- `scheduledFor`
- `createdAt`

Those are enough for rough analytics, especially by scheduled hour or by reminder bucket, but not enough for exact lifecycle analytics over arbitrary windows.

The current dashboard service already computes an hourly conversion view:

```ts
// src/dashboard/services/remindersService.ts
prisma.$queryRaw<Array<{ hour: number; total: bigint; converted: bigint }>>`
  SELECT
    EXTRACT(HOUR FROM "scheduledFor" AT TIME ZONE 'UTC')::int AS hour,
    COUNT(*)::bigint AS total,
    COUNT(*) FILTER (WHERE "convertedAt" IS NOT NULL)::bigint AS converted
  FROM "ReminderJob"
  GROUP BY hour
  ORDER BY hour
`
```

That is already a valid time-of-day effectiveness chart, but it is lifetime data unless you add a date window filter.

## What you should add if you want truthful lifecycle analytics

### Minimum viable fix

Add immutable timestamps and a stable cycle key:

- `cycleId` or `reminderCycleId`
- `sentAt`
- `skippedAt`
- `snoozedAt`
- `resolvedAt`
- `resolvedBy` or `resolutionType`

That would let one job represent one reminder cycle clearly.

### Better fix

Add an append-only event table:

```prisma
model ReminderEvent {
  id           Int      @id @default(autoincrement())
  reminderJobId Int
  reminderJob   ReminderJob @relation(fields: [reminderJobId], references: [id])
  eventType     String   // sent | snoozed | skipped | converted | auto_nudged
  createdAt     DateTime @default(now())
  metadata      Json?
}
```

Then the lifecycle becomes auditable and you can report exact event counts without losing history when the row status changes.

### Best fit for your goal

If your goal is “for the past day/week/month, which time converted the most people,” you should store:

- the exact send timestamp,
- the exact conversion timestamp,
- and an immutable event record for each action.

Then your query can group by hour and filter by range without relying on mutable row state.

## Recommendation

If you want to keep the current schema for now, I would treat the existing dashboard as a **current-state operational dashboard**, not an analytics dashboard.

If you want the numbers you described to be accurate, I recommend a small schema redesign before trusting the stats:

1. Add a cycle identifier.
2. Add immutable event timestamps.
3. Stop using `status` as both state and history.
4. Optionally add a `ReminderEvent` table.
5. Add a date window to dashboard queries.

## Final answer to your specific question

No, the current code does **not** yet support a clean “last cycle” lifecycle report the way you want it.

It can tell you:

- what status each reminder row currently has,
- whether it was converted,
- and roughly which hour converts more often.

It cannot yet truthfully tell you, for an arbitrary cycle window, the full sequence of send → snooze/skip/convert without ambiguity.

If you want, the next step should be to implement the tracking model rather than trying to infer lifecycle from the current rows.