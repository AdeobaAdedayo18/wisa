# Audit: `GET /api/dashboard/reminders`

## Verdict

The numbers in `stats` are **not fabricated**, but they are also **not the same thing as user-visible reminder events**. They are lifetime database counts over `ReminderJob` rows, with each field coming from a different rule.

That means:

- `sent`, `skipped`, and `snoozed` are counts of rows whose current `status` matches that value.
- `converted` is a count of rows where `convertedAt` is not null.
- The endpoint does **not** filter by date range, so these are lifetime totals across the table.

So if you see `sent: 593` and `skipped: 8936`, that does **not** mean 8,936 sent reminders were somehow “lost”. It means the database currently contains 8,936 reminder rows whose final recorded state is `skipped`, across all time.

## Where the endpoint lives

The public route is mounted here:

```ts
// src/index.ts
app.use("/api/dashboard", dashboardRouter);
```

and the dashboard router exposes the reminders endpoint here:

```ts
// src/dashboard/routes/index.ts
router.get("/reminders", reminders);
```

So the endpoint you are asking about is `/api/dashboard/reminders`.

## What the dashboard actually counts

The dashboard service is very direct:

```ts
// src/dashboard/services/remindersService.ts
const [
  sent,
  skipped,
  snoozed,
  converted,
  reminderRows,
  timeBuckets,
] = await Promise.all([
  prisma.reminderJob.count({ where: { status: "sent" } }),
  prisma.reminderJob.count({ where: { status: "skipped" } }),
  prisma.reminderJob.count({ where: { status: "snoozed" } }),
  prisma.reminderJob.count({ where: { convertedAt: { not: null } } }),
  ...
]);
```

There is no extra business logic here. The stats are literally counts of rows in the `ReminderJob` table.

The table schema confirms the fields being used:

```prisma
model ReminderJob {
  id             Int       @id @default(autoincrement())
  userId         Int
  user           User      @relation(fields: [userId], references: [id])
  telegramId     BigInt
  scheduledFor   DateTime
  status         String // "pending" | "sent" | "snoozed" | "skipped"
  snoozeCount    Int       @default(0)
  autoNudgeCount Int       @default(0)
  logDate        String? // ISO date "YYYY-MM-DD" the reminder is for (user's local date)
  bucketSent     String?
  convertedAt    DateTime?
  createdAt      DateTime  @default(now())
}
```

## What `skipped` means in code

`skipped` is not inferred from delivery failure or from a user ignoring the reminder. It is only set when the code explicitly updates the row to `status: "skipped"`.

Examples:

```ts
// src/bot/reminders.ts
await prisma.reminderJob.update({
  where: { id: jobId },
  data: { status: "skipped" },
});
```

```ts
// src/services/scheduler.ts
if (duplicateJobIds.length > 0) {
  await prisma.reminderJob.updateMany({
    where: { id: { in: duplicateJobIds } },
    data: { status: "skipped" },
  });
}

if (localDow === 0 || localDow === 6) {
  await prisma.reminderJob.update({ where: { id: job.id }, data: { status: "skipped" } });
  continue;
}

if (daysSinceLastLog > 14) {
  await prisma.reminderJob.update({ where: { id: job.id }, data: { status: "skipped" } });
  continue;
}
```

So `skipped` currently means “the scheduler or user intentionally marked this job as skipped.” It does **not** mean “the user did not respond.”

## What `snoozed` means in code

This one is more subtle.

The code uses `status: "snoozed"` in two different ways:

1. A real user-driven snooze action.
2. A temporary claim state inside the scheduler before the message is actually sent.

User-driven snooze:

```ts
// src/bot/reminders.ts
await prisma.reminderJob.update({
  where: { id: jobId },
  data: { snoozeCount: newSnoozeCount, status: "snoozed", autoNudgeCount: 3 },
});
```

Scheduler claim state before send:

```ts
// src/services/scheduler.ts
const claim = await prisma.reminderJob.updateMany({
  where: { id: job.id, status: "pending" },
  data: { status: "snoozed" },
});
if (claim.count === 0) continue;

await prisma.reminderJob.update({
  where: { id: job.id },
  data: { status: "sent", logDate, bucketSent: bucket },
});
```

That means the dashboard stat `snoozed` is only counting rows that are **currently left in the snoozed state**. It is not a clean count of “how many times people clicked snooze,” and it is not the same as a transient internal claim used during sending.

The more direct snooze metric is actually `snoozeCount`, which is shown per row in the UI:

```ts
// src/dashboard/services/remindersService.ts
snoozeCount: job.snoozeCount,
```

and rendered in the legacy admin view as:

```ts
// src/admin/dashboard.html
<td class="muted">${j.snoozeCount > 0 ? `💤 × ${j.snoozeCount}` : '—'}</td>
```

## What `converted` means in code

There is no `converted` status in the schema. `converted` is a derived metric from the nullable timestamp `convertedAt`.

The only place it is written is when a user taps the reminder’s “Write my log” action:

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

So in this codebase, `converted` means:

- the reminder was delivered, and
- the user clicked through from the reminder into the logging flow.

It does **not** prove that the log was fully completed or saved successfully. It is an interaction marker, not a full funnel completion marker.

## Why the numbers can look strange

The main reasons are:

1. The stats are lifetime counts, not counts for a day or week.
2. `skipped` is a real terminal state used by several scheduler branches, so it can grow large over time.
3. `converted` overlaps with `sent`, because the code marks a sent reminder as converted when the user taps the write action.
4. `snoozed` is a state flag, not a pure event counter.

In other words, the stats are internally consistent, but the labels are a little misleading if you read them as if they were event analytics.

## Audit conclusion

My honest assessment is:

- The counts are probably **accurate as database state snapshots**.
- The counts are **not accurate if you interpret them as unique reminder lifecycle events**.
- `skipped` and `snoozed` are especially easy to misread because they are implementation states, not user-intent analytics.
- `converted` is also only a proxy for user action, not proof of completed logging.

If you want these numbers to be analytically trustworthy, the endpoint should probably be renamed or reworked to report:

- a time-bounded window such as `last 7 days`,
- separate event counts versus current-state counts, and
- a clearer definition of `converted`.

Right now, the data is real, but the meaning is too loose for high-confidence product analytics.