# Wisa — All User-Facing Messages

Every message the bot sends to a user, grouped by flow.  
Dynamic values (names, dates, counts) are shown in `{curly braces}`.

---

## 1. Onboarding

### /start — new user
> Hey {firstName}! 👋 I'm **Wisa** - your personal SIWES logbook assistant.
>
> I'll remind you to write your daily industrial training log and help you make it shine ✨
>
> Let's get you set up in under a minute!

**Button:** `Ready?` → `Let's go! 🚀`

---

### /start — returning (fully onboarded) user
> Welcome back, {firstName}! 👋

---

### Step 2 — Frequency selection (scene2)
> How often do you want to write your log? 📅

> Pick your log frequency:

**Buttons:** `Every day` · `Every 2 days` · `Every 3 days` · `Once a week`

---

### Step 3 — Time picker (scene3)
> What time should I remind you to write your log? ⏰

> Pick your daily reminder time:

*(Time-picker keyboard, 06:00 – 22:00 in 30-min steps)*

---

### Step 4 — Onboarding complete (scene4)
> You're all set! 🎉
>
> 📅 **Frequency:** {Every day / Every 2 days / …}
> ⏰ **Reminder time:** {HH:MM}
>
> Let's start logging your journey! 🚀

> What would you like to do first?

**Buttons:** `📖 See my logs` · `✍️ Write today's log`

> Your main menu is ready 👇

---

## 2. Logging

### Already logged — same day
> 📝 **You already logged {today / Monday, Mar 4}!**
>
> {first 200 chars of log…}
>
> Want to add more or start fresh?

**Buttons:** `➕ Add to this log` · `📱 View in calendar` · `🏠 Menu`

---

### Start logging (scene7)
> I'm listening 👂
>
> Tell me what you worked on {for today / for **Monday, Mar 4**}. Send as many messages as you like — I'll put it all together.
>
> Tap **Done ✅** when you're finished.
>
> You can also send a voice message instead of typing! Just hit the mic button and talk — Wisa transcribes it automatically 🎤

> Go ahead — I'm all ears 👇

**Button:** `Done ✅`

---

### No log in progress (Done tapped with nothing started)
> No log in progress. Tap **✍️ Write today's log** to start.

---

### Nothing typed yet (Done tapped before any message)
> You haven't written anything yet! Send me your log first, then tap **Done ✅**.

---

### Log too long (> 1,500 words)
> ⚠️ Your log was over 1,500 words, so I've trimmed it to ~10,000 characters. You can edit it afterwards if needed.

---

### Log saved (scene8)
> Log saved! 📖✨
>
> Great work documenting your day. Keep it up — your future self will thank you 🙌

> What would you like to do next?{voice hint if free user with tries left}

**Voice hint (free users with remaining free voice logs):**
> 💡 **Tip:** Did you know you can send a **voice message** instead of typing? Just hit the mic button and talk — Wisa transcribes it automatically! You have **{N} free voice log(s)** left 🎤

**Buttons:** `✨ Refine with AI` · `📖 View logs` · `🏠 Menu`

---

### Error saving log
> Something went wrong saving your log. Please try again 😢

---

### Edit mode
> ✏️ **Edit mode**
>
> **⚠️ Whatever you type next will completely replace the current log.**
>
> Current log ({N} words):
>
> {first 300 chars of log…}

---

### Log not found (edit)
> Couldn't find that log entry.

---

### Edit saved
> Updated! ✅ Looking good 👌

**Buttons:** `✨ Refine with AI` · `🏠 Menu`

---

### Error saving edit
> Couldn't save your edit. Please try again 😢

---

### Past-log calendar header
> 🗓️ **{Month Year}**
>
> ✅ = logged  ⭐ = missed  Tap a day to write a past log.

---

### Account not found
> Couldn't find your account. Try /start.

---

## 3. AI Refinement

### Free quota exhausted
> ✨ You've used all your free AI refinements!
>
> Upgrade to **Pro** to unlock unlimited AI refinements, voice logs, and more 🚀

**Button:** `Go Pro 👑`

---

### Log not found
> Couldn't find that log. 🤔

---

### Loading (while calling OpenAI)
> Let me cook 🍳✨ *(this may take a few seconds…)*

---

### Refined result
> ✨ **Here's the refined version:**
>
> {refined text}

**Buttons:** `✅ Use this version` · `Keep original 📝`

---

### Refinement error
> Something went wrong while refining your log 😢 Please try again.

---

### Session expired (use refined)
> Session expired — please tap ✨ Refine again.

---

### Refined version saved
> ✅ **Refined version saved!** Your log is looking legendary 👑
>
> {refined text}

> Refined log saved! 💾

**Buttons:** `📅 View calendar` · `🏠 Menu`

---

### Error saving refined version
> Couldn't save the refined log. Please try again. 😢

---

### Keep original chosen
> Okay, keeping the original! 📝 Your words, your style 💪

---

## 4. Voice Logs

### Free voice quota exhausted
> 🎤 You've used all 3 of your free voice logs!
>
> Voice logging is **so** much faster than typing — upgrade to **Pro** for unlimited voice-to-log transcription ✨

**Button:** `Go Pro 👑`

---

### Processing voice note
> 🎤 Got your voice note! Transcribing… *(hang tight)*

---

### Transcription result
> 🎤 **Here's what I heard:**
>
> {transcription}
>
> *{N} free voice log(s) remaining — upgrade to Pro for unlimited 🚀*
> *(or: "This was your last free voice log! Upgrade to Pro for unlimited 🚀")*

**Buttons:** `✅ Save this log` · `✏️ Edit before saving` · `🔄 Re-record`

---

### Voice transcription error
> Something went wrong while transcribing your voice note 😢 Please try again.

---

### Session expired (voice save/edit)
> Session expired — please send your voice message again.

---

### Saving voice log
> Saving your voice log… 🎙️

*(Then scene8 + "What would you like to do next?" — same as text log saved)*

---

### Voice log save error
> Couldn't save the log. Please try again. 😢

---

### Edit before saving (voice)
> ✏️ Here's your transcription pre-filled. You can send additional messages to add more, then tap **Done ✅** when you're ready.

**Button:** `Done ✅`

---

### Re-record
> No problem! 🔄 Send me another voice message whenever you're ready 🎤

---

## 5. Payments & Pro

### Go Pro overview
> 👑 **Wisa Pro — Unlimited Potential**
>
> Here's what Pro unlocks for you:
>
> ✨ **Unlimited AI refinements** — polish every log entry
> 🎙️ **Voice logs** — speak your log, we transcribe it
> 📊 **Priority support** — we've got your back
>
> **Price: ₦5,000 / month**
>
> Ready to level up your logbook? 👇

**Buttons:** `🏦 Pay via Bank Transfer` · `Maybe later 👋`

---

### Already Pro
> You're already on Pro! 👑 Keep slaying those logs 🔥

---

### Generating Paystack link
> Generating your payment link, one sec... ⏳

---

### Paystack link ready
> Here's your secure payment link 🔐
>
> Reference: `{reference}`

**Buttons:** `Pay ₦5,000 💳` (URL) · `I've paid ✅` · `Cancel ❌`

---

### Paystack error
> Oops! Couldn't generate a payment link right now. Please try again in a moment 🙏

---

### Check payment — already Pro
> You're already Pro! 👑 Your logbook is about to be legendary ✨

---

### Check payment — not confirmed yet
> We haven't received your payment confirmation yet 🔄
>
> Paystack will notify us automatically once your payment is confirmed. If you completed the payment, it should reflect within a minute. If you're stuck, reach out for support 🙏

---

### Bank transfer details
> 🏦 **Bank Transfer Payment**
>
> Please transfer **₦5,000** to the account below:
>
> 🏛 **Bank:** Guaranty Trust Bank
> 💳 **Account Number:** `0865852964`
> 👤 **Account Name:** ADEOBA ADEDAYO JAMES
>
> Once you've sent the money, tap the button below and we'll verify it manually ⬇️

**Buttons:** `✅ I've sent it!` · `Cancel ❌`

---

### Payment already pending review
> ⏳ Your payment is already being reviewed. We'll notify you once it's approved. Hang tight!

---

### Ask for sender account name
> ✅ **Transfer recorded!**
>
> One quick thing — what is the **account name** on the account you sent the money from?
>
> *(e.g. "John Doe")*

---

### Payment details received
> 🙏 **We've got your details!**
>
> Your payment is now being reviewed. You'll get a message here as soon as it's approved ✅

---

### Payment approved (admin action → user)
> 🎉 **You're now on Wisa Pro!**
>
> Your bank transfer has been confirmed. Welcome to the Pro club 👑
>
> Enjoy unlimited AI refinements, voice logs, and more!

---

### Payment rejected (admin action → user)
> ❌ **Payment Not Confirmed**
>
> We couldn't verify your transfer of ₦5,000.
>
> Please double-check the account details and try again, or reach out if you think this is a mistake 🙏

---

### Generic error
> Something went wrong. Please try again 🙏

---

## 6. Settings

### Settings menu
> ⚙️ **Settings**
>
> What would you like to change?

**Buttons:** `⏰ Change reminder time` · `📅 Change log frequency` · `👑 Manage subscription` · `❓ How this works` · `🏠 Back to menu`

---

### Change reminder time
> ⏰ Pick your new reminder time:

*(Time-picker keyboard)*

---

### Reminder time updated
> Done! ✅ Your reminder time is now **{HH:MM}** ⏰
>
> New reminder schedule created 🗓️

---

### Settings update error
> Couldn't update your settings. Please try again 😢

---

### Change log frequency
> 📅 How often do you want to log?

**Buttons:** `Every day` · `Every 2 days` · `Every 3 days` · `Once a week`

---

### Log frequency updated
> Done! ✅ Log frequency updated to **{Every day / …}** 📅
>
> New reminder schedule created 🗓️

---

### Subscription status — free plan
> 👑 **Subscription Status**
>
> You're currently on the **Free** plan.
>
> Free users get:
> • 3 AI log refinements
> • Text logs only
>
> Upgrade to **Pro** for:
> • Unlimited AI refinements ✨
> • Voice-to-log transcription 🎙️
> • ₦5,000/month

**Buttons:** `👑 Upgrade to Pro` · `🏠 Menu`

---

### Subscription status — Pro plan
> 👑 **Subscription Status**
>
> Plan: **Pro**
> Status: ✅ Active *(or 🚫 Cancelled / ❌ Expired)*
> Renews / Access until: **{date}**
> Reference: `{paystackRef}`

**Buttons (active):** `❌ Cancel subscription` · `🏠 Menu`
**Buttons (expired):** `🔄 Renew Pro` · `🏠 Menu`

---

### Cancel subscription prompt
> ⚠️ Are you sure you want to cancel your Pro subscription?
>
> You'll keep Pro access until the end of your current billing period, then revert to Free.

**Buttons:** `Yes, cancel ❌` · `Keep Pro 👑`

---

### Subscription cancelled
> Your Pro subscription has been cancelled 😢
>
> You'll retain Pro access until the end of your current billing period. We hope to see you back soon — your logs will be waiting! 🙏

---

### How Wisa works
> ❓ **How Wisa Works**
>
> Wisa is your personal SIWES logbook assistant 📓
>
> **✍️ Writing logs**
> Tap "Write today's log", type your work activities (send as many messages as you like), then tap **Done ✅**. Wisa saves everything automatically.
>
> **⏰ Reminders**
> Wisa nudges you at your chosen time to write your log. Snooze up to 3 times — on the 3rd you get the final push 😄
>
> **✨ AI Refinement**
> After saving a log, tap "Refine with AI" to polish your entry into professional, supervisor-ready language. Free users get 3 refinements; Pro users get unlimited.
>
> **🎙️ Voice logs (Pro only)**
> Send a voice message and Wisa transcribes it and saves it as a log entry.
>
> **📅 Calendar**
> Browse all your logs by day. Tap any marked day to view, edit, delete, or refine a log.
>
> **👑 Pro plan — ₦5,000/month**
> Unlimited AI refinements + voice-to-log transcription.
>
> Questions? We're always here 🙏

---

## 7. Feedback

### Prompt
> 💬 **I'm all ears!**
>
> What's on your mind? A suggestion, a bug, a vibe check - whatever it is, send it and I'll make sure it reaches the creator directly 🙏
>
> *Send your message below* 👇

**Button:** `❌ Cancel`

---

### Submitted
> ✅ **Feedback sent!** Thank you so much 🙏
>
> Your message is on its way to the creator. We read every single one and it helps us make Wisa better for you 💪

---

### Cancelled
> No worries! Back to the main menu 😊

---

## 8. Reminders (sent by the scheduler)

### Reminder message (scene5) — one of four, chosen at random

**Variant 1:**
> 📝 **Time to log your day!**
>
> What did you work on today? Even a few sentences counts. Your future self will thank you 🙌

**Variant 2:**
> ✍️ **Log time!**
>
> Your SIWES diary is waiting. What happened at work today?

**Variant 3:**
> 📖 **Hey, logbook check-in!**
>
> Don't let today's wins go unrecorded. Write your log now 🚀

**Variant 4:**
> 🗒️ **Daily log reminder**
>
> Take 2 minutes to capture today's work activities. You've got this 💪

**Buttons (all variants):** `✍️ Write my log` · `⏳ Remind me in 30 mins` · `🙈 Skip today`

---

### Already logged (snooze tapped)
> You've already logged today — great work! 🎉

---

### Third snooze / final nudge (scene6)
> Okay okay, last reminder for today! 😅
>
> You've snoozed 3 times — just write **something**, even one sentence. Your logbook needs you! 🙏

*(Auto-snooze variant)*
> Okay okay, last reminder for today! 😅
>
> You've been quiet a while — just write **something**, even one sentence. Your logbook needs you! 🙏

**Button:** `✍️ Write my log`

---

### Snooze acknowledged
> ⏳ Got it! I'll remind you again in 30 minutes. Go do your thing 😊

---

### Skip acknowledged
> No wahala! 😊 See you next time 👋

---

### Reminder not found
> Couldn't find that reminder. It may have already been handled.

---

### Onboarding nudge (8 pm daily, sent to users who never finished setup)
> hey {firstName} 👋
> you started setting up your Wisa but never finished 😅
>
> which means right now you have not started taking your logs and your IT days are already going by 👀
>
> it'll take you about 20 seconds to finish. literally just pick how often you want to log and what time you want to be reminded. that's it.
>
> after that the bot handles everything 🙏

**Button:** `Finish my setup ✅`

---

## 9. Calendar — View Logs

### Calendar header
> 🗓️ **{Month Year}**
>
> ✅ = has a log  Tap a day to read it.

---

### Log entry view
> 📖 **Log — {Weekday, Month D YYYY}**
> *({N} words · 🎤 voice)*
>
> {log content / refined content}

**Buttons:** `✏️ Edit this log` · `🗑️ Delete` · `✨ Refine with AI` · `🏠 Menu`

---

### No log for tapped date
> No log found for {Weekday, Mon D}. Want to write one?

**Buttons:** `✍️ Write log` · `🏠 Menu`

---

### Delete confirmation prompt
> Are you sure you want to delete this log? This cannot be undone. 🗑️

**Buttons:** `Yes, delete ❌` · `Cancel`

---

### Log deleted
> Deleted! 🗑️ Log removed successfully.

> Log deleted. 👋

**Buttons:** `📅 View calendar` · `🏠 Menu`

---

### Delete error
> Couldn't delete that log — it may have already been removed.

---

### Deletion cancelled
> No worries — log kept! 👍
