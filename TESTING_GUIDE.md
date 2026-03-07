# Wisa — Testing Guide for Recent Changes

> **Scope:** Snooze fix, correct-date logging, auto-nudge rewrite, auto-save for idle logs, weekend skip, and cleanup script update.
>
> **Pre-requisites:** Deploy the new migration (`npx prisma migrate deploy`) and restart the bot.

---

## 0. Pre-Deployment Checklist

| Step | Command / Action | Expected |
|------|-----------------|----------|
| Run migration | `npx prisma migrate deploy` | Migration `20260306120000_add_auto_nudge_and_log_date` applied successfully |
| Verify schema | `npx prisma studio` → open `ReminderJob` table | New columns `autoNudgeCount` (Int, default 0) and `logDate` (String, nullable) visible |
| Build | `npx tsc --noEmit` | 0 errors |
| Start bot | `npm start` (or your deploy command) | Console shows `[scheduler] Reminder cron jobs started.` |

---

## 1. Snooze ("Remind me in 30 mins") Actually Fires

### What was broken
`scheduleNextJob` created a next-day pending job immediately after a reminder fired. The snooze handler then checked for *any* pending job and found the next-day one, so it never created the 30-minute snooze job.

### What was fixed
- `scheduleNextJob` now only blocks if there's a pending job **> 4 hours** away (next-day type).
- `handleSnooze` only checks for pending jobs **within 2 hours** before creating a snooze job.
- Snooze jobs carry forward the original `logDate`.

### How to test

1. **Set a reminder to fire soon.** Update your test user's `reminderTime` to ~2 minutes from now:
   ```sql
   UPDATE "User" SET "reminderTime" = '14:30' WHERE "telegramId" = <YOUR_ID>;
   ```
2. Wait for the reminder to fire (scene 5 image + 3 buttons).
3. Tap **⏳ Remind me in 30 mins**.
4. Verify you get: `⏳ Got it! I'll remind you again in 30 minutes.`
5. Check the database:
   ```sql
   SELECT id, status, "snoozeCount", "scheduledFor", "logDate"
   FROM "ReminderJob"
   WHERE "userId" = <USER_ID>
   ORDER BY id DESC LIMIT 5;
   ```
   You should see:
   - The original job → status `snoozed`, `autoNudgeCount = 3`
   - A new job → status `pending`, `scheduledFor` ≈ now + 30 min, `snoozeCount = 1`, same `logDate`
   - A next-day job → status `pending`, `scheduledFor` ≈ tomorrow at your reminder time
6. **Wait 30 minutes** (or fast-forward by updating `scheduledFor`):
   ```sql
   UPDATE "ReminderJob" SET "scheduledFor" = NOW() - INTERVAL '1 minute'
   WHERE "userId" = <USER_ID> AND status = 'pending' AND "snoozeCount" > 0;
   ```
7. **Within 1 minute**, the snooze reminder should fire — same scene 5 image with buttons.
8. **Snooze 2 more times** (total 3). On the 3rd snooze:
   - You should see Scene 6 image.
   - Followed by a message with **✍️ Write my log** and **🙈 Skip today** buttons.
   - No further snooze option.

**Pass criteria:** Snooze fires at 30-minute intervals. 3rd snooze shows final nudge with Write button.

---

## 2. "Write my log" Button Logs for the Correct Date

### What was broken
The `write_log` callback had no date info — it always defaulted to today's date. If a user got a Wednesday reminder but tapped "Write my log" on Thursday, the log would be for Thursday.

### What was fixed
- Callback format changed to `write_log_<jobId>_<YYYY-MM-DD>`.
- `handleWriteFromReminder` parses the date and passes it to `startLogging(ctx, logDate)`.
- `logDate` is computed and stored on every `ReminderJob`.

### How to test

1. **Let a reminder fire** (or use step 1 above).
2. Don't tap the button right away — wait until the next calendar day if possible. (Or test quickly by checking what date it shows.)
3. Tap **✍️ Write my log**.
4. You should see: `Tell me what you worked on for *<date label>*` — the date should match the *reminder's* date, NOT today.
5. Write a log entry and tap **Done ✅**.
6. Check the log in the database:
   ```sql
   SELECT id, "logDate", content FROM "Log"
   WHERE "userId" = <USER_ID>
   ORDER BY id DESC LIMIT 1;
   ```
7. `logDate` should match the reminder's original date (the YYYY-MM-DD in the button callback).

**Quick test (same day):** Even if you test same-day, confirm the scene 7 message says `for today` (meaning the date is today, which is correct when the reminder fires today).

**Pass criteria:** Log's `logDate` matches the reminder date, not the current date.

---

## 3. Auto-Nudge (3 Follow-Ups at 30-min Intervals)

### What was broken
Auto-nudge used the same broken "create new pending jobs" pattern and was blocked by the same guard as snooze.

### What was fixed
Complete rewrite. Auto-nudge now tracks `autoNudgeCount` on the original "sent" job. No new jobs created. Fires at `scheduledFor + (N+1) * 30 min`. After 3rd nudge, job retires to "snoozed".

### How to test

1. **Let a reminder fire** and **do NOT interact** (don't tap any button).
2. Check the job in DB:
   ```sql
   SELECT id, status, "autoNudgeCount", "scheduledFor"
   FROM "ReminderJob"
   WHERE "userId" = <USER_ID> AND status = 'sent'
   ORDER BY id DESC LIMIT 1;
   ```
3. **Wait 30 minutes** (or fast-forward):
   ```sql
   UPDATE "ReminderJob"
   SET "scheduledFor" = NOW() - INTERVAL '35 minutes'
   WHERE id = <JOB_ID>;
   ```
4. Within 5 minutes (auto-nudge cron runs every 5 min), you should get **Nudge 1** — plain text message with ✍️ Write / 🙈 Skip buttons.
5. DB should show `autoNudgeCount = 1`, status still `sent`.
6. **Don't interact.** Wait another 30 min (or fast-forward to 65 min after original send).
7. **Nudge 2** — another plain text message.
8. **Nudge 3** — Scene 6 image with Write / Skip buttons. After this, status changes to `snoozed`.
9. **No further nudges** should appear.

**Interaction stops nudge:** After nudge 1, tap "Write my log" or "Skip today". Verify no further nudges arrive.

**Pass criteria:** Exactly 3 nudges at ~30-minute intervals. No new ReminderJob rows created. Nudges stop if user interacts.

---

## 4. Auto-Save for Idle Log Sessions

### What was broken (new feature)
Users would start writing a log, send messages (get 👍), but never tap "Done ✅". Their work was stuck in the session and lost.

### What was built
- Session tracks `lastLogMessageAt` (unix ms) on every text message.
- New cron (every 5 min) detects idle sessions.
- **Stage 1 (15 min idle):** Sends prompt — "💾 Save it" / "✏️ I'm still writing".
- **Stage 2 (30 min idle):** Auto-saves the log, clears session, notifies user.

### How to test

#### 4a. Idle prompt at 15 min

1. Start writing a log: tap **✍️ Write today's log**.
2. Send 2–3 messages (get 👍 reactions each time).
3. **Stop typing and wait 15 minutes.** (Or fast-forward — see hack below.)
4. You should receive: `Hey! 👋 Looks like you stopped writing. I've got *X words* so far. Want me to save it, or are you still going?`
5. Buttons: **💾 Save it** and **✏️ I'm still writing**.

**Fast-forward hack:** Manually update the session in the DB:
```sql
-- Find your session
SELECT id, key, value FROM "Session" WHERE key = '<YOUR_CHAT_ID>';

-- The value is JSON. Update lastLogMessageAt to 20 min ago:
-- (you'll need to compute Date.now() - 20*60*1000 as the timestamp)
-- Example: if now is 1741350000000, set lastLogMessageAt to 1741348800000
UPDATE "Session"
SET value = jsonb_set(value::jsonb, '{lastLogMessageAt}', '<TIMESTAMP>')::text
WHERE key = '<YOUR_CHAT_ID>';
```

#### 4b. "Save it" button

1. After receiving the prompt, tap **💾 Save it**.
2. You should see Scene 8 ("Log saved! 📖✨") and follow-up buttons (Refine with AI, View logs, Menu).
3. DB should have a new log entry with the text you wrote.
4. Session's `awaitingLog` should be `false`.

#### 4c. "I'm still writing" button

1. After receiving the prompt, tap **✏️ I'm still writing**.
2. You should see: `No problem, take your time! 😊 Tap *Done ✅* when you're finished.`
3. The Done button reappears.
4. Idle timer resets — you have another 15 min before the prompt fires again.

#### 4d. Full auto-save at 30 min

1. Start a log, send messages, then stop.
2. Wait for the 15-min prompt.
3. **Do not tap any button.** Wait another 15 minutes (30 min total from last message).
4. You should receive: `✅ I went ahead and saved your log — it looked like you were done.` plus a preview of your text.
5. DB should have the log entry.

**Pass criteria:** Prompt at 15 min. Auto-save at 30 min if no response. "Still writing" resets the timer. "Save it" saves immediately.

---

## 5. Weekend Skip for Reminders

### What was broken
Reminders fired on Saturday and Sunday even though nobody works on weekends.

### What was fixed
- `scheduleNextJob` calls `skipWeekend()` — pushes Sat→Mon, Sun→Mon at the same time.
- Reminder cron runtime check: if today is Sat/Sun in user's timezone, skip and schedule next.

### How to test

#### 5a. scheduleNextJob skips weekends

1. Set your user's reminder to a time that would land on Saturday:
   ```sql
   UPDATE "User" SET "reminderTime" = '09:00', "logFrequency" = 'daily'
   WHERE "telegramId" = <YOUR_ID>;
   ```
2. Trigger `scheduleNextJob` (e.g., by having a reminder fire today, Friday).
3. Check the next pending job:
   ```sql
   SELECT id, "scheduledFor", "logDate"
   FROM "ReminderJob"
   WHERE "userId" = <USER_ID> AND status = 'pending'
   ORDER BY "scheduledFor" DESC LIMIT 1;
   ```
4. If today is Friday, the next job should be for **Monday**, not Saturday.
5. `logDate` should show the Monday date.

#### 5b. Runtime weekend skip

If somehow a pending job exists for a weekend date (e.g., created before the fix):

1. Manually create a pending job for Saturday:
   ```sql
   INSERT INTO "ReminderJob" ("userId", "telegramId", "scheduledFor", status, "snoozeCount")
   VALUES (<USER_ID>, <TELEGRAM_ID>, '2026-03-07 08:00:00', 'pending', 0);
   ```
2. Wait for the cron to run (every 1 minute).
3. The job should be **skipped** (status = `skipped`) and a new job created for Monday.
4. Console log: `[scheduler] Skipped reminder for user X — weekend (Sat)`

**Pass criteria:** No reminders fire on Sat or Sun. Next job after Friday is Monday. Onboarding nudge is NOT affected (still fires daily including weekends).

---

## 6. Cleanup Script Compatibility

### What was changed
Script now allows **2** legitimate pending jobs per user (1 near-term within 4h, 1 far-term > 4h). Previously it kept only 1, which would delete the next-day job when a snooze existed.

### How to test

1. Create a scenario where a user has a snooze job (~30 min) and a next-day job:
   ```sql
   -- Snooze job (near-term)
   INSERT INTO "ReminderJob" ("userId", "telegramId", "scheduledFor", status, "snoozeCount")
   VALUES (<USER_ID>, <TELEGRAM_ID>, NOW() + INTERVAL '25 minutes', 'pending', 1);

   -- Next-day job (far-term)
   INSERT INTO "ReminderJob" ("userId", "telegramId", "scheduledFor", status, "snoozeCount")
   VALUES (<USER_ID>, <TELEGRAM_ID>, NOW() + INTERVAL '20 hours', 'pending', 0);
   ```
2. Run the cleanup script:
   ```bash
   npx tsx scripts/cleanup-reminders.ts
   ```
3. Output should show:
   - `Jobs to keep: 2`
   - `Jobs to DELETE: 0`
4. Both jobs should still exist.

5. Now add a **duplicate** near-term job:
   ```sql
   INSERT INTO "ReminderJob" ("userId", "telegramId", "scheduledFor", status, "snoozeCount")
   VALUES (<USER_ID>, <TELEGRAM_ID>, NOW() + INTERVAL '28 minutes', 'pending', 1);
   ```
6. Re-run the cleanup. It should delete the duplicate, keeping 2 (1 near + 1 far).

**Pass criteria:** Snooze + next-day jobs coexist. Only true duplicates are cleaned up.

---

## 7. Edge Cases to Verify

| Scenario | Expected Behavior |
|----------|-------------------|
| User taps "Write my log" then immediately taps "Done ✅" (no text sent) | "You haven't written anything yet!" message |
| User writes a log, gets 👍, then blocks the bot | Auto-save cron will fail to send message; error logged, no crash |
| User gets auto-save prompt, then types more text | `autoSavePromptSent` resets to false; idle timer restarts from latest message |
| User has multiple log parts, auto-save fires | All parts joined with `\n\n`, saved as one log entry |
| Snooze job fires on a weekend | Runtime weekend check catches it, skips to Monday |
| User already logged today, reminder fires | "Already logged" message, reminder silently retired |
| User already logged today, auto-nudge tries to fire | Nudge suppressed, `autoNudgeCount` set to 3 |
| `logDate` is null on old jobs | Falls back to `Intl.DateTimeFormat("en-CA").format(scheduledFor)` |

---

## 8. Monitoring in Production

Watch these console log patterns after deploy:

```
[scheduler] Skipped reminder for user X — weekend (Sat|Sun)   # Weekend skip working
[scheduler] Auto-nudge #1 sent for user X (job Y)             # Auto-nudge firing
[scheduler] Retired N duplicate due jobs                       # Dedup working
[auto-save] Saved log #X for user Y (Z words, idle Nm)        # Auto-save working
[log] Auto-save confirmed: user X, log #Y — Z words           # User tapped "Save it"
```

If you see these in the first few hours, everything is working.

---

## 9. Rollback Plan

If something goes wrong:

1. **Revert the deploy** to the previous commit.
2. The new DB columns (`autoNudgeCount`, `logDate`, `lastLogMessageAt`, `autoSavePromptSent`) have defaults and are nullable — they won't break old code.
3. Old `write_log` callback still works (generic handler is registered after the date-aware one).
4. Run cleanup if needed:
   ```sql
   -- Clear any stuck auto-nudge counts
   UPDATE "ReminderJob" SET "autoNudgeCount" = 0 WHERE "autoNudgeCount" > 0;
   ```

---

*Last updated: March 2026*
