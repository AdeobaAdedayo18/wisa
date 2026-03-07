WISA OFFICIAL TELEGRAM BOT PLAN

This is everything I need. Let me now write the full implementation plan — this will be long and specific, by design, because a coding agent needs zero ambiguity.

---

# SIWES LogBot — Full Implementation Plan

## Tech Stack

- **Runtime:** Node.js (v20+)
- **Bot Framework:** `grammy` (modern, TypeScript-friendly Telegram bot framework, better than node-telegram-bot-api)
- **Database:** PostgreSQL on Railway (provisioned as a Railway service)
- **ORM:** Prisma (for schema management, migrations, and type-safe queries)
- **Job Scheduler:** `node-cron` + a persistent jobs table in PostgreSQL (so scheduled reminders survive server restarts)
- **AI:** OpenAI SDK — `whisper-1` for transcription, `gpt-4o` for log refinement
- **Payments:** Paystack Node SDK
- **Hosting:** Railway (one service for the bot, one for PostgreSQL)
- **Environment management:** `.env` with Railway's environment variables UI

---

## Database Schema (Prisma)

```prisma
model User {
  id               Int       @id @default(autoincrement())
  telegramId       BigInt    @unique
  firstName        String
  username         String?
  logFrequency     String    // "daily" | "bi-daily" | "every-3-days" | "weekly"
  reminderTime     String    // "HH:MM" in 24hr format, user's chosen time
  timezone         String    @default("Africa/Lagos")
  isPro            Boolean   @default(false)
  freeAiRefinements Int      @default(3)
  onboardingDone   Boolean   @default(false)
  createdAt        DateTime  @default(now())
  logs             Log[]
  subscription     Subscription?
}

model Log {
  id          Int       @id @default(autoincrement())
  userId      Int
  user        User      @relation(fields: [userId], references: [id])
  content     String    // raw log content, max ~10,000 chars (approx 1500 words)
  refinedContent String? // AI refined version, stored separately
  logDate     DateTime  // the date this log is FOR (not when it was written)
  isVoice     Boolean   @default(false)
  createdAt   DateTime  @default(now())
  updatedAt   DateTime  @updatedAt
}

model Subscription {
  id              Int       @id @default(autoincrement())
  userId          Int       @unique
  user            User      @relation(fields: [userId], references: [id])
  paystackRef     String    @unique
  status          String    // "active" | "cancelled" | "expired"
  startDate       DateTime
  endDate         DateTime
  createdAt       DateTime  @default(now())
}

model ReminderJob {
  id           Int       @id @default(autoincrement())
  userId       Int
  telegramId   BigInt
  scheduledFor DateTime
  status       String    // "pending" | "sent" | "snoozed" | "skipped"
  snoozeCount  Int       @default(0)
  createdAt    DateTime  @default(now())
}
```

---

## Project File Structure

```
logbot/
├── prisma/
│   └── schema.prisma
├── src/
│   ├── bot/
│   │   ├── index.ts              # bot instance + middleware setup
│   │   ├── onboarding.ts         # onboarding conversation flow
│   │   ├── logging.ts            # write/edit/view log flows
│   │   ├── reminders.ts          # reminder message handlers
│   │   ├── calendar.ts           # calendar navigation UI
│   │   ├── aiFeatures.ts         # refine + transcribe handlers
│   │   └── payments.ts           # paystack flow
│   ├── services/
│   │   ├── scheduler.ts          # cron job that checks ReminderJob table
│   │   ├── openai.ts             # whisper + gpt-4o wrappers
│   │   ├── paystack.ts           # paystack API wrapper
│   │   └── userActivity.ts       # "keep bot active" nudge logic
│   ├── utils/
│   │   ├── dateHelpers.ts
│   │   └── constants.ts          # image URLs, text templates
│   └── index.ts                  # entry point
├── .env
├── package.json
└── railway.toml
```

---

## Onboarding Flow (Step by Step)

**Step 1 — First /start**

Bot sends an image (Scene 1 — see images section below) with this message:

> Hey [firstname]! 👋✨ Welcome to LogBot — your digital SIWES logbook bestie 📓 No more rough pages, no more stress. You type here, we keep it safe, you write it once and slay your logbook presentation 💅 Ready to set things up? It'll take 2 minutes, I promise 🤞
> 
> [Let's go! 🚀] ← single inline button

**Step 2 — Frequency**

Bot sends image (Scene 2) with:

> Okay so first things first 📅 How often do you want to log your work days?

Inline keyboard:

```
[Every day 📆]      [Every 2 days 🗓️]
[Every 3 days 📅]   [Once a week 🗒️]
```

**Step 3 — Time picker**

Bot sends image (Scene 3) with:

> Nice choice! 🙌 Now what time should I remind you? Pick the time that works best for you 👇

Inline keyboard (a grid of times from 6:00 AM to 10:00 PM in 30-minute increments, displayed as):

```
[6:00 AM] [6:30 AM] [7:00 AM] [7:30 AM]
[8:00 AM] [8:30 AM] [9:00 AM] [9:30 AM]
... and so on until 10:00 PM
```

**Step 4 — Confirmation**

Bot sends image (Scene 4) with:

> You're all set [firstname]! 🎉 Here's your setup: 📅 Logging: [frequency] ⏰ Reminder: [time]
> 
> I'll ping you when it's time to log. And trust me, future you will thank present you 😌💛
> 
> [See my logs 📖] [Write today's log ✍️]

This triggers `onboardingDone = true`, creates their first batch of `ReminderJob` entries, and saves user to DB.

---

## Reminder Flow

**When the scheduled reminder fires:**

Bot sends image (Scene 5) with:

> Hey [firstname]! ⏰ It's log time~ What did you get up to today at work? 👀
> 
> [Write my log ✍️] [Remind me in 30 mins ⏳] [Skip today 🙈]

**If they click "Remind me in 30 mins":**

- Update `ReminderJob.snoozeCount += 1`
- If `snoozeCount < 3`: schedule a new reminder 30 mins later, same message
- If `snoozeCount === 3`: send a final nudge with image (Scene 6):

> Okay okay last call [firstname] 😅 I'll leave you alone after this one I promise [Write my log ✍️] [Skip today 🙈]

**If they click "Skip today":**

- Mark job as skipped
- Bot sends: "No wahala! 😊 See you next time 👋"

**If no response after initial reminder:** auto-snooze once after 30 mins (same as clicking snooze), max 3 times, then silent.

---

## Writing a Log Flow

Triggered either from reminder or from main menu "Write a log ✍️":

**Step 1:** Bot sends image (Scene 7):

> I'm listening 👂✨ Tell me everything — what did you do today? Take your time, no rush 🌿 _(You have up to 1,500 words)_
> 
> When you're done, just click **Done ✅**

Bot enters "waiting for text" state for this user (store `awaitingLog: true` in a session map in memory or Redis-lite via PostgreSQL).

User types freely across multiple messages if they want (bot collects and concatenates). When they click **Done ✅**:

- Word count check: if over 1,500 words (~10,000 chars), trim and warn
- Save to `Log` table with `logDate = today`
- Bot sends image (Scene 8):

> Logged! 🎉 That's going in the vault 🔐 [date] ✅
> 
> [View this log 👀] [AI refine it ✨] [Back to menu 🏠]

---

## Calendar / View Logs Flow

User clicks "My Logs 📖" from main menu.

Bot sends a calendar keyboard. Implementation:

- Generate an inline keyboard that shows the current month as a grid
- Days that have logs: shown as `✅ 14`
- Days with no log: shown as `14`
- Navigation buttons: `[◀️ Nov]` and `[Dec ▶️]` at the top
- Below calendar: `[◀️ Back]` to go to previous month

When user taps a day with a log:

Bot sends the log content with these buttons underneath:

```
[✏️ Edit this log]   [🗑️ Delete]
[✨ Refine with AI]   [🏠 Menu]
```

---

## Editing a Log

When user clicks "✏️ Edit this log":

> Here's what you wrote 📝 Just send me the updated version and I'll replace it ✨ _(You can also just add to it)_
> 
> [Cancel ❌]

User sends new text → bot replaces `Log.content`, updates `updatedAt`.

Bot confirms: "Updated! ✅ Looking good 👌"

---

## Writing a Log for a Past Date

From main menu, user can click "Write a past log 🕰️". Bot shows the calendar, but highlights days that are missing logs (within their logging schedule). User picks a day → bot enters the same log writing flow but saves with `logDate = selected date`.

---

## AI Refinement Flow

When user clicks "✨ Refine with AI":

**Free users:** Check `freeAiRefinements` count.

- If `> 0`: proceed, decrement count, show remaining after ("You have X free refinements left 🎁")
- If `=== 0`:

> You've used your 3 free refinements 😮‍💨 But don't worry — go Pro for ₦5,000/month and get unlimited AI-powered log glow-ups ✨ [Go Pro 👑] [Maybe later]

**When refinement runs:**

1. Bot sends: "Let me cook 🍳✨" with a loading-style message
2. Call GPT-4o with this system prompt:

```
You are helping a Nigerian university student refine their SIWES (industrial training) logbook entry. 
The student did real work today — your job is to make their log entry sound professional, well-structured, 
and impressive to an academic supervisor, while keeping it truthful and grounded in what they actually wrote.
Expand abbreviations, improve grammar, add professional vocabulary where appropriate, 
and structure it with a brief intro, body of activities, and a short reflective closing sentence.
Keep it between 200-400 words. Return only the refined log, no commentary.
```

3. Stream the response if possible, or use edit-message animation: send a message with `░░░░░░ Refining...` then edit it to the refined content once done
4. Show buttons: `[✅ Use this version]` `[Keep original 📝]`
5. If they accept: update `Log.refinedContent`, mark as refined

---

## Voice Log Flow (Pro only)

From main menu or reminder: "🎙️ Voice log"

> Just send me a voice message and I'll transcribe it for you 🎙️✨ Talk naturally — tell me what you did today!

User sends a Telegram voice message → bot downloads the OGG file → sends to Whisper API with this prompt context:

```
This is a Nigerian university student describing their daily industrial training (SIWES) work activities. 
Transcribe accurately, preserving their descriptions of technical tasks, tools used, and workplace experiences.
```

Bot gets transcription → displays it → asks:

> Here's what I heard 👇 [transcription text]
> 
> [✅ Save this log] [✏️ Edit before saving] [🔄 Re-record]

---

## Paystack Pro Subscription Flow

User clicks "Go Pro 👑":

> You're about to unlock the full LogBot experience 🔥
> 
> 👑 **Pro Plan — ₦5,000/month** ✅ Unlimited AI log refinements ✅ Voice-to-text logging (powered by Whisper AI) ✅ Priority support
> 
> [Pay with Paystack 💳] [Not now]

On clicking Pay:

1. Call Paystack Initialize Transaction API with `amount: 500000` (kobo), `email: [telegramId]@logbot.app` (synthetic email since we're not collecting real emails), `metadata: { telegramId }`
2. Send user the Paystack payment link as a button: `[Complete Payment 🔗]`
3. Set up a Paystack webhook endpoint at `/webhook/paystack` that listens for `charge.success` events
4. On success: update `User.isPro = true`, create `Subscription` record, send confirmation message:

> You're in! Welcome to the Pro squad 👑✨ [firstname], your logbook is about to be legendary.

---

## Keep Bot Active Strategy

The challenge: Telegram stops delivering messages from bots if users haven't interacted in a while. Strategy:

1. **Monthly "check-in" prompt:** On the 1st of every month, send all users:

> Hey [firstname]! 👋 New month, new logs 📅 Just tap below so I know you're still here 😊 [I'm here! 👋]

2. **After every log submission:** always end with an inline button in the confirmation so user taps something (keeps the chat "warm")
    
3. **Onboarding instruction:** At the end of onboarding, tell users:
    

> Quick tip: Pin this chat so you never miss a reminder 📌 Telegram sometimes mutes bots if you go quiet for too long!

4. **Engagement loop:** Every 7 days of no interaction (even if they've been logging), send:

> Psst [firstname] 👀 Still here? Tap below so I don't lose you! [Still here! 👋]

---

## Main Menu

The bot's persistent reply keyboard (shown at all times after onboarding):

```
[✍️ Write today's log]   [📖 My logs]
[🕰️ Past log]            [⚙️ Settings]
[👑 Go Pro]  ← hidden if already Pro
```

Settings menu:

```
[⏰ Change reminder time]
[📅 Change log frequency]  
[👑 Manage subscription]
[❓ How this works]
```

---

## Ghibli Image Scenes — Descriptions & Generation Prompts

All images: Studio Ghibli art style, female character with messy bun, warm lighting, soft colors. Generate at 1024x1024, save as JPG, host as Telegram file_id after first send (cache the file_id in constants so you're not re-uploading).

---

**Scene 1 — Welcome** _Context: First greeting, warm and exciting_ Prompt: `Studio Ghibli style illustration, young woman with a messy bun sitting at a cozy wooden desk, looking up from a open notebook with a warm excited smile, soft warm lamplight, surrounded by plants and stationery, welcoming atmosphere, pastel colors, highly detailed, anime art style`

**Scene 2 — Asking about frequency** _Context: Asking user to make a choice_ Prompt: `Studio Ghibli style illustration, young woman with a messy bun holding a small calendar and looking thoughtfully at the viewer with a gentle curious expression, cozy bedroom setting, soft daylight through window, pastel colors, anime art style`

**Scene 3 — Time picker** _Context: User is picking a time_ Prompt: `Studio Ghibli style illustration, young woman with a messy bun looking at a large vintage clock on a wall, tapping her chin thoughtfully, cozy warm room, afternoon sunlight, soft pastel colors, anime art style`

**Scene 4 — Setup complete** _Context: Onboarding done, celebratory_ Prompt: `Studio Ghibli style illustration, young woman with a messy bun raising both arms in celebration, big happy smile, confetti falling around her, cozy room setting, bright warm lighting, pastel colors, anime art style`

**Scene 5 — Reminder / It's log time** _Context: Daily reminder, gentle nudge_ Prompt: `Studio Ghibli style illustration, young woman with a messy bun peeking around a door frame with a playful smile, holding a small notepad, soft evening light, cozy warm tones, anime art style`

**Scene 6 — Final snooze nudge** _Context: Last reminder, slightly playful urgency_ Prompt: `Studio Ghibli style illustration, young woman with a messy bun with a playfully exasperated expression, hands on hips, looking at viewer with one eyebrow raised and a smile, warm lit room, pastel anime art style`

**Scene 7 — I'm listening** _Context: User is about to type their log_ Prompt: `Studio Ghibli style illustration, young woman with a messy bun sitting cross-legged on a floor cushion, leaning forward attentively with both hands on her knees and a warm listening expression, cozy dimly lit room, soft lamp light, anime art style`

**Scene 8 — Log saved** _Context: Log successfully submitted_ Prompt: `Studio Ghibli style illustration, young woman with a messy bun sitting at a desk, just finished writing, capping a pen with a satisfied and proud smile, notebook in front of her, warm evening light, pastel colors, anime art style`

---

## Scheduler Logic

Every minute, the `scheduler.ts` cron job runs:

```
SELECT * FROM ReminderJob 
WHERE status = 'pending' 
AND scheduledFor <= NOW()
```

For each job found: send the reminder message, update status to 'sent', schedule next recurring job based on user's frequency.

Snooze jobs are created in the DB too (new ReminderJob with `scheduledFor = NOW() + 30 mins`).

---

## Environment Variables

```
TELEGRAM_BOT_TOKEN=
DATABASE_URL=
OPENAI_API_KEY=
PAYSTACK_SECRET_KEY=
PAYSTACK_WEBHOOK_SECRET=
PORT=3000
```

---

## Railway Deployment Config (`railway.toml`)

```toml
[build]
builder = "nixpacks"

[deploy]
startCommand = "npx prisma migrate deploy && node dist/index.js"
restartPolicyType = "always"
```

---

## Key NPM Dependencies

```json
{
  "grammy": "^1.x",
  "@grammyjs/conversations": "^1.x",
  "@prisma/client": "^5.x",
  "prisma": "^5.x",
  "openai": "^4.x",
  "node-cron": "^3.x",
  "axios": "^1.x",
  "dotenv": "^16.x"
}
```

---

That's the full plan. A coding agent can take this document and build the entire bot end-to-end with no guesswork. The only thing you need to do before handing it off is generate the 8 Ghibli images using the prompts above (Midjourney or any image gen tool works), then give those image files to the agent to upload and cache. Everything else is in here.