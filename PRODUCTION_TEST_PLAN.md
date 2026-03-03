# Wisa Production Test Plan

Run through each section after deploying. Use your own account + a test account if possible.

---

## 1. Reminder Deduplication

### 1a. Single reminder per time slot
- [ ] Wait for your next scheduled reminder time (e.g. 6:30 PM)
- [ ] Verify you receive **exactly 1** reminder message — not 2, 3, or 9
- [ ] Check DB: `SELECT COUNT(*) FROM "ReminderJob" WHERE status = 'pending'` should show **≤ 1 per user**

### 1b. No duplicate creation after reminder fires
- [ ] After receiving the reminder, check DB: the user should have **exactly 1 new pending job** for the next day
- [ ] Run `npx tsx scripts/cleanup-reminders.ts` — should report **0 jobs to DELETE**

### 1c. Snooze creates only 1 job
- [ ] Tap "⏳ Remind me in 30 mins" on a reminder
- [ ] Check DB: user should have **exactly 1 pending job** 30 mins from now
- [ ] Wait for the snoozed reminder — should arrive **once**, not multiple times

### 1d. Auto-snooze (no interaction)
- [ ] Receive a reminder and **don't tap anything** for 35 minutes
- [ ] Should receive **exactly 1** auto-snooze follow-up
- [ ] Repeat: ignore for another 35 mins → should get **exactly 1** more follow-up
- [ ] After 3rd snooze: should get the "last reminder" message **once** with no snooze button

### 1e. Skip works cleanly
- [ ] Tap "🙈 Skip today" on a reminder
- [ ] Should NOT get any more reminders for the rest of the day
- [ ] Next day's reminder should still fire at the correct time

### 1f. Already logged today
- [ ] Write a log entry, then wait for reminder time
- [ ] Should NOT receive a reminder (scheduler skips silently)
- [ ] Check DB: job should be marked "sent" and a new pending job exists for next day

---

## 2. Cron Race Condition Protection

### 2a. Re-entry lock
- [ ] Check Railway logs during a reminder tick — should NOT see two "[scheduler]" log lines for the same minute
- [ ] If the bot was slow (API delays), you should see: `"Reminder cron still running from previous tick — skipping"`

---

## 3. Settings Changes

### 3a. Change reminder time
- [ ] Go to ⚙️ Settings → ⏰ Change reminder time → pick a new time
- [ ] Check DB: old pending + sent jobs for your user should be **deleted**
- [ ] Check DB: **exactly 1** new pending job at the new time
- [ ] Wait for the new time — reminder should arrive correctly

### 3b. Change log frequency
- [ ] Go to ⚙️ Settings → 📅 Change log frequency → pick a different frequency
- [ ] Check DB: old pending + sent jobs deleted, **1** new pending job at the correct interval
- [ ] Verify the next reminder fires at the right day and time

---

## 4. Flow Switching (Session Management)

### 4a. Feedback → Log
- [ ] Tap "💬 Leave feedback" (you should see "I'm all ears")
- [ ] **Don't send any text** — instead tap "✍️ Write today's log"
- [ ] The log flow should open normally
- [ ] Type your log text and tap Done ✅ — it should save correctly
- [ ] The feedback flow should be dead (no text gets captured by it)

### 4b. Log → Feedback
- [ ] Tap "✍️ Write today's log"
- [ ] Type one message (should get 👍 reaction)
- [ ] Now tap "💬 Leave feedback"
- [ ] Type a feedback message — should be forwarded to the creator
- [ ] The log flow should be dead (the pending log parts are cleared)

### 4c. Edit → Log
- [ ] Open an existing log and tap "➕ Add to this log" (edit mode)
- [ ] **Don't send edit text** — tap "✍️ Write today's log" instead
- [ ] The edit mode should cancel; log writing should work normally

### 4d. Payment → Log
- [ ] Start the manual payment flow (Go Pro → Bank Transfer → Manual Sent)
- [ ] When asked for "account name", tap "✍️ Write today's log" instead
- [ ] Log flow should work; payment sender name flow should be dead

---

## 5. Auto-Expiry (1 Hour Timeout)

### 5a. Log expires after 1 hour
- [ ] Tap "✍️ Write today's log"
- [ ] Type one message (get 👍)
- [ ] **Wait 1 hour** (or temporarily change `FLOW_TIMEOUT_MS` to 2 minutes for testing)
- [ ] Type another message — should NOT be captured by the log flow (it expired)
- [ ] Tap Done ✅ — should say "No log in progress"

### 5b. Feedback expires after 1 hour
- [ ] Tap "💬 Leave feedback"
- [ ] Wait 1 hour
- [ ] Type a message — should NOT get forwarded as feedback

---

## 6. DB Health Check

Run these queries after 24 hours of production usage:

```sql
-- Total jobs should be reasonable (roughly: users × 3-5)
SELECT COUNT(*) FROM "ReminderJob";

-- Every user should have at most 1 pending job
SELECT "userId", COUNT(*) as cnt
FROM "ReminderJob"
WHERE status = 'pending'
GROUP BY "userId"
HAVING COUNT(*) > 1;
-- ^ This should return 0 rows

-- No orphaned sent jobs older than 2 hours (auto-snooze should have processed them)
SELECT COUNT(*) FROM "ReminderJob"
WHERE status = 'sent'
AND "scheduledFor" < NOW() - INTERVAL '2 hours'
AND "snoozeCount" < 3;
-- ^ Should be 0 or very small
```

Or run the cleanup script:
```bash
npx tsx scripts/cleanup-reminders.ts
```
Should report **0 jobs to DELETE** if everything is healthy.

---

## 7. Multi-User Verification

- [ ] Ask 2-3 beta testers to confirm they receive **exactly 1** reminder at their set time
- [ ] Ask them to snooze once and confirm the follow-up arrives **once** 30 mins later
- [ ] Ask them to confirm no 1 AM / 2 AM spam

---

## Quick Smoke Test (5 minutes)

If you're short on time, do just these:

1. [ ] Check DB: `npx tsx scripts/cleanup-reminders.ts` → 0 deletions, 1 pending per user
2. [ ] Wait for your reminder → exactly 1 message
3. [ ] Snooze → exactly 1 follow-up 30 mins later
4. [ ] Start feedback, then switch to log writing → log saves correctly
5. [ ] Check Railway logs for any `[scheduler]` errors
