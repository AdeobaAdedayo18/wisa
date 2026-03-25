# Wisa — Full Monetization Plan

### "Storage Full" Model — March 2026

---

## The Core Concept

Wisa is free until it isn't — and when it stops being free, the reason feels completely natural.

After 15 logs, the user hits a "storage full" wall. Not a paywall. Not a subscription prompt. A storage limit — the most universally understood constraint on any device. They've been using the product for roughly 3 weeks by this point, their logs are all sitting there, and they are not walking away from that over ₦1,000.

Once they pay, they get:

- 📦 Unlimited storage (logs never blocked again that month)
- 🎙️ Unlimited voice logs
- ✨ Unlimited AI refinements

They pay once. They don't get asked again until their renewal is due the following month.

---

## The Numbers

||Detail|
|---|---|
|Free logs before wall|15 logs|
|Monthly price|₦1,000|
|What they get|Unlimited storage + voice logs + AI refinements|
|Free AI refinements (before wall)|3|
|Free voice logs (before wall)|3|
|Renewal|Monthly, reminded once when due|
|Old logs if unpaid|Always readable, never locked|
|New logs if unpaid|Blocked until payment|

---

## The Full User Journey

### Phase 1 — Free (Logs 1 to 15)

User writes freely. No mention of payment, no countdown, no pressure. They are building a habit and building dependency. The product just works.


---


---

### Phase 3 — The Wall (Log 15 saved, then blocked on log 16 attempt)

Log 15 saves normally. Show the usual save confirmation, then immediately after:

> 🎉 Log saved! You're on a roll — 15 logs and counting 💪
> 
> ---
> 
> 📦 **Your free storage is now full.**
> 
> I really want to keep storing your logs — you've built something worth keeping here.
> 
> To keep going, unlock more storage for just **₦1,000/month** and I'll also throw in: 🎙️ Unlimited voice logs ✨ Unlimited AI refinements
> 
> That's everything. No hidden charges, no tiers. Just ₦1,000 and Wisa is fully yours 🙏

**Buttons:** `🔓 Unlock storage — ₦1,000`

---
**If they close it and try to write log 16:**

> 📦 **Storage full, {firstName}.**
> 
> I've got everything you've written so far — all 15 logs are safe and you can read them anytime.
> 
> But I can't store today's log until you unlock more storage.
> 
> It's ₦1,000 for the whole month — and honestly for what you get, it's a steal 🙏

**Button:** `🔓 Unlock storage — ₦1,000`

**WHY:** "All 15 logs are safe and you can read them anytime" is the most important sentence in this whole flow. It removes the fear that they're losing something. Fear of loss is what makes paywalls feel hostile — kill that fear immediately and the conversion becomes a simple transaction.

---

### Phase 4 — Payment Flow

User taps "Unlock storage":

> 🔓 **Unlock Wisa Storage**
> 
> ₦1,000 / month ✅ Unlimited log storage 🎙️ Unlimited voice logs ✨ Unlimited AI refinements
> 
> How would you like to pay?

**Buttons:** `💳 Pay with Paystack`

**Paystack flow:**

- Initialize transaction: amount `100000` kobo (₦1,000), for the email we just quickly ask them for their email and we also save it in the db
- Send payment link as button
- On `charge.success` webhook: set `isPro = true`, set `storageUnlocked = true`, set `nextRenewalDate = today + 30 days`, send confirmation
---

### Phase 5 — Payment Confirmed

> 🎉 **Storage unlocked, {firstName}!**
> 
> You're all set for the next 30 days 🔓
> 
> Your logs are flowing again — plus you've got unlimited voice logs and AI refinements now. Go make today's log count 💪

**Button:** `✍️ Write today's log`

---

### Phase 6 — Monthly Renewal

On the renewal date, send this at 8PM:

> Hey {firstName} 👋
> 
> Your Wisa storage renews today — just ₦1,000 to keep everything going for another month 🗓️
> 
> Your 15+ logs are still safe. Just tap below to keep the streak alive 🙏

**Buttons:** `🔓 Renew — ₦1,000` · `I'll do it later`

If they don't pay within 24 hours, send one follow-up:

> 📦 Hey {firstName}, just a reminder — your Wisa storage expired yesterday.
> 
> Your logs are all still there and readable. But new ones can't be saved until you renew 🙏
> 
> ₦1,000 gets you another full month.

**Button:** `🔓 Renew now`

No more messages after that second one. Two reminders maximum — never spam a renewal.

---

### Phase 7 — Lapsed users (didn't renew)

If a lapsed user tries to write a log:

> 📦 **Storage is full, {firstName}.**
> 
> Your logs from before are all still here — nothing was deleted 📂
> 
> Renew for ₦1,000 to start logging again 🙏

**Buttons:** `🔓 Renew — ₦1,000` · `Read my logs 📖`

---

## Revenue Projections

|Users paying|Monthly revenue|
|---|---|
|20|₦20,000|
|50|₦50,000|
|100|₦100,000|
|200|₦200,000|

At 164 current users with ~79 onboarded, converting 30% of active users = roughly 24 paying users = ₦24,000/month to start. As the user base grows through the MTMI partnership and group campaigns, this scales directly.

The model is also self-reinforcing — the more logs a user stores, the harder it is to leave, so churn stays low naturally.

---

## What Changes in the Codebase

**Database:**

- Add `logCount` field to User model (increment on every log save)
- Add `storageUnlocked` boolean (default false)
- Add `nextRenewalDate` datetime (nullable)
- Remove `freeAiRefinements` and `freeVoiceLogs` counters — these become irrelevant once storage is the gate

**Logic:**

- On every log save attempt: check `logCount >= 15 AND storageUnlocked = false` → block and show wall
- On payment confirmed: set `storageUnlocked = true`, set `nextRenewalDate`
- Scheduler: daily check for users where `nextRenewalDate = today` → send renewal reminder
- Scheduler: daily check for users where `nextRenewalDate = yesterday AND storageUnlocked = true` → set `storageUnlocked = false`, send lapsed message

**Voice and AI refinement:**

- Free users: 3 free uses each, same as before, until they hit the storage wall
- Once storage is unlocked (paid): unlimited voice and AI — no separate counter needed

---

## The One-Line Pitch to Yourself

> First 15 logs free. Then ₦1,000/month for unlimited everything — and by the time they hit 15, they're not going anywhere.

---

_Wisa Monetization Plan — drafted March 2026_