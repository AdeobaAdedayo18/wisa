# Wisa— Full Technical Execution Plan

> Derived from the official Wisa plan. Every phase is ordered by dependency. Follow each phase sequentially; do not skip ahead.

---

## Phase 0 — Pre-requisites & Environment Setup

### 0.1 — Accounts & Keys

Before writing a single line of code, ensure you have the following credentials ready:

| Service | What you need |
|---|---|
| Telegram | BotFather token — create bot via [@BotFather](https://t.me/BotFather), set name + description |
| Railway | Account at [railway.app](https://railway.app), new Project |
| OpenAI | API key with access to `gpt-4o` and `whisper-1` |
| Paystack | Live + test secret keys from [paystack.com](https://paystack.com) dashboard |

### 0.2 — Local Dev Tools

Ensure the following are installed:

```bash
node -v      # must be >= 20
npm -v
npx -v
```

Install global helpers:

```bash
npm install -g tsx typescript prisma
```

---

## Phase 1 — Project Scaffolding

### 1.1 — Initialize the project

```bash
npm init -y
```

### 1.2 — Install all NPM dependencies

```bash
# Runtime dependencies
npm install grammy @grammyjs/conversations @prisma/client openai node-cron axios dotenv

# Dev dependencies
npm install -D prisma typescript ts-node tsx @types/node nodemon
```

### 1.3 — TypeScript config

Create `tsconfig.json`:

```json
{
  "compilerOptions": {
    "target": "ES2022",
    "module": "commonjs",
    "lib": ["ES2022"],
    "outDir": "dist",
    "rootDir": "src",
    "strict": true,
    "esModuleInterop": true,
    "resolveJsonModule": true,
    "skipLibCheck": true
  },
  "include": ["src/**/*"],
  "exclude": ["node_modules", "dist"]
}
```

### 1.4 — Create the file structure

```bash
mkdir -p src/bot src/services src/utils prisma
touch src/index.ts
touch src/bot/index.ts src/bot/onboarding.ts src/bot/logging.ts
touch src/bot/reminders.ts src/bot/calendar.ts src/bot/aiFeatures.ts src/bot/payments.ts
touch src/services/scheduler.ts src/services/openai.ts
touch src/services/paystack.ts src/services/userActivity.ts
touch src/utils/dateHelpers.ts src/utils/constants.ts
touch .env railway.toml
```

### 1.5 — Create `.env`

```env
TELEGRAM_BOT_TOKEN=
DATABASE_URL=
OPENAI_API_KEY=
PAYSTACK_SECRET_KEY=
PAYSTACK_WEBHOOK_SECRET=
PORT=3000
```

### 1.6 — Create `railway.toml`

```toml
[build]
builder = "nixpacks"

[deploy]
startCommand = "npx prisma migrate deploy && node dist/index.js"
restartPolicyType = "always"
```

### 1.7 — Add npm scripts to `package.json`

```json
"scripts": {
  "dev": "tsx watch src/index.ts",
  "build": "tsc",
  "start": "node dist/index.js",
  "db:migrate": "prisma migrate dev",
  "db:generate": "prisma generate",
  "db:studio": "prisma studio"
}
```

---

## Phase 2 — Database Setup (Prisma + Railway PostgreSQL)

### 2.1 — Provision PostgreSQL on Railway

1. In your Railway project dashboard, click **New Service → Database → PostgreSQL**
2. Copy the `DATABASE_URL` from the Railway service's **Variables** tab
3. Paste it into your local `.env`

### 2.2 — Write the Prisma schema

Create `prisma/schema.prisma`:

```prisma
generator client {
  provider = "prisma-client-js"
}

datasource db {
  provider = "postgresql"
  url      = env("DATABASE_URL")
}

model User {
  id                 Int           @id @default(autoincrement())
  telegramId         BigInt        @unique
  firstName          String
  username           String?
  logFrequency       String        // "daily" | "bi-daily" | "every-3-days" | "weekly"
  reminderTime       String        // "HH:MM" in 24hr format
  timezone           String        @default("Africa/Lagos")
  isPro              Boolean       @default(false)
  freeAiRefinements  Int           @default(3)
  onboardingDone     Boolean       @default(false)
  createdAt          DateTime      @default(now())
  logs               Log[]
  subscription       Subscription?
}

model Log {
  id              Int      @id @default(autoincrement())
  userId          Int
  user            User     @relation(fields: [userId], references: [id])
  content         String
  refinedContent  String?
  logDate         DateTime
  isVoice         Boolean  @default(false)
  createdAt       DateTime @default(now())
  updatedAt       DateTime @updatedAt
}

model Subscription {
  id           Int      @id @default(autoincrement())
  userId       Int      @unique
  user         User     @relation(fields: [userId], references: [id])
  paystackRef  String   @unique
  status       String   // "active" | "cancelled" | "expired"
  startDate    DateTime
  endDate      DateTime
  createdAt    DateTime @default(now())
}

model ReminderJob {
  id           Int      @id @default(autoincrement())
  userId       Int
  telegramId   BigInt
  scheduledFor DateTime
  status       String   // "pending" | "sent" | "snoozed" | "skipped"
  snoozeCount  Int      @default(0)
  createdAt    DateTime @default(now())
}
```

### 2.3 — Run migration

```bash
npx prisma migrate dev --name init
npx prisma generate
```

---

## Phase 3 — Bot Core Setup (`src/bot/index.ts`)

### 3.1 — Initialize grammy Bot instance

```typescript
// src/bot/index.ts
import { Bot, session } from "grammy";
import { conversations, createConversation } from "@grammyjs/conversations";
import { PrismaClient } from "@prisma/client";

export const prisma = new PrismaClient();

export const bot = new Bot(process.env.TELEGRAM_BOT_TOKEN!);

// Session middleware (in-memory for simplicity; swap to DB adapter for production)
bot.use(session({ initial: () => ({ awaitingLog: false, pendingLogParts: [] as string[] }) }));
bot.use(conversations());
```

### 3.2 — Entry point (`src/index.ts`)

```typescript
import "dotenv/config";
import { bot, prisma } from "./bot/index";
import { startScheduler } from "./services/scheduler";
import express from "express";

const app = express();
app.use(express.json());

// Paystack webhook endpoint
app.post("/webhook/paystack", async (req, res) => {
  // See Phase 7 for full implementation
  res.sendStatus(200);
});

async function main() {
  await prisma.$connect();
  startScheduler(bot);
  bot.start();
  app.listen(process.env.PORT || 3000, () =>
    console.log(`Server running on port ${process.env.PORT || 3000}`)
  );
}

main();
```

> **Note:** Install `express` and `@types/express` separately:
> ```bash
> npm install express && npm install -D @types/express
> ```

---

## Phase 4 — Onboarding Flow (`src/bot/onboarding.ts`)

Implement as a `grammy` **conversation** (stateful multi-step flow).

### Steps to implement:

**Step 1 — `/start` handler:**
- Check if user exists in DB with `onboardingDone = true` → if yes, show main menu
- If new user → send Scene 1 image + welcome message with "Let's go! 🚀" inline button
- Register user in DB (without `onboardingDone` yet)

**Step 2 — Frequency selection:**
- After user taps "Let's go!", send Scene 2 image
- Display 4-button inline keyboard: Every day / Every 2 days / Every 3 days / Once a week
- Map button text to DB values: `"daily"` | `"bi-daily"` | `"every-3-days"` | `"weekly"`
- Store selection in conversation context

**Step 3 — Time picker:**
- Send Scene 3 image
- Generate inline keyboard with times from `06:00` to `22:00` in 30-min increments (33 buttons total)
- Display in rows of 4 buttons
- Store selected time in `HH:MM` 24hr format

**Step 4 — Confirmation:**
- Send Scene 4 image with summary message
- Set `onboardingDone = true`, `logFrequency`, `reminderTime` in DB
- Create first batch of `ReminderJob` entries (next 4 due dates based on frequency + chosen time)
- Show 2 buttons: "See my logs 📖" | "Write today's log ✍️"
- Render the persistent reply keyboard (main menu)

```typescript
// Helper: generate first ReminderJob batch
async function createInitialReminderJobs(userId: number, telegramId: bigint, frequency: string, reminderTime: string) {
  const [hour, minute] = reminderTime.split(":").map(Number);
  const intervalDays = { daily: 1, "bi-daily": 2, "every-3-days": 3, weekly: 7 }[frequency] ?? 1;
  const jobs = [];
  for (let i = 0; i < 4; i++) {
    const date = new Date();
    date.setDate(date.getDate() + intervalDays * (i + 1));
    date.setHours(hour, minute, 0, 0);
    jobs.push({ userId, telegramId, scheduledFor: date, status: "pending" });
  }
  await prisma.reminderJob.createMany({ data: jobs });
}
```

---

## Phase 5 — Reminder Flow (`src/bot/reminders.ts` + `src/services/scheduler.ts`)

### 5.1 — Scheduler cron job (`src/services/scheduler.ts`)

```typescript
import cron from "node-cron";
import { Bot } from "grammy";
import { prisma } from "../bot/index";
import { getReminderMessage } from "../bot/reminders";

export function startScheduler(bot: Bot) {
  // Runs every minute
  cron.schedule("* * * * *", async () => {
    const dueJobs = await prisma.reminderJob.findMany({
      where: { status: "pending", scheduledFor: { lte: new Date() } },
    });

    for (const job of dueJobs) {
      try {
        await bot.api.sendMessage(Number(job.telegramId), getReminderMessage(), {
          parse_mode: "Markdown",
          reply_markup: {
            inline_keyboard: [
              [{ text: "✍️ Write my log", callback_data: `write_log` }],
              [{ text: "⏳ Remind me in 30 mins", callback_data: `snooze_${job.id}` }],
              [{ text: "🙈 Skip today", callback_data: `skip_${job.id}` }],
            ],
          },
        });
        await prisma.reminderJob.update({ where: { id: job.id }, data: { status: "sent" } });
        // Schedule next repeat based on user frequency
        await scheduleNextJob(job.userId, job.telegramId);
      } catch (e) {
        console.error(`Failed to send reminder for job ${job.id}`, e);
      }
    }
  });
}
```

### 5.2 — Snooze handler

- On `snooze_<jobId>` callback:
  - Increment `snoozeCount`
  - If `snoozeCount < 3`: Create new `ReminderJob` with `scheduledFor = NOW() + 30 mins`
  - If `snoozeCount === 3`: Send Scene 6 image + final nudge message, no further snooze option

### 5.3 — Skip handler

- On `skip_<jobId>` callback:
  - Update `ReminderJob.status = "skipped"`
  - Send: "No wahala! 😊 See you next time 👋"

### 5.4 — Auto-snooze (no response)

- An additional cron check (runs every 5 mins) looks for `sent` jobs older than 30 mins with `snoozeCount < 3`
- Treats them as if user clicked snooze (creates a new job, increments count)

---

## Phase 6 — Logging Flow (`src/bot/logging.ts`)

### 6.1 — "Write today's log" trigger

Triggered from: reminder callback, main menu keyboard, or `/start` if onboarding complete.

**Flow:**
1. Send Scene 7 image + listening message
2. Set `session.awaitingLog = true`, `session.pendingLogParts = []`
3. All subsequent text messages from this user are appended to `pendingLogParts`
4. Show persistent "Done ✅" inline button

### 6.2 — On "Done ✅" button press

```typescript
const fullText = ctx.session.pendingLogParts.join("\n\n");
const wordCount = fullText.split(/\s+/).length;

if (wordCount > 1500) {
  // Trim to ~10,000 chars and warn user
}

await prisma.log.create({
  data: {
    userId: dbUser.id,
    content: fullText,
    logDate: new Date(),
    isVoice: false,
  },
});

ctx.session.awaitingLog = false;
ctx.session.pendingLogParts = [];
// Send Scene 8 + confirmation buttons
```

### 6.3 — Editing a log

- User taps "✏️ Edit this log" on a viewed log
- Bot enters edit mode for that `Log.id` (store in session)
- Next text message from user replaces `Log.content`, updates `updatedAt`
- Confirm: "Updated! ✅ Looking good 👌"

### 6.4 — Writing a log for a past date

- User taps "🕰️ Past log" from main menu
- Show calendar in **gap-highlight mode** (days missing logs within their schedule are starred)
- User picks a date → same logging flow → save with `logDate = selectedDate`

---

## Phase 7 — Calendar View (`src/bot/calendar.ts`)

### 7.1 — Calendar keyboard generator

```typescript
export function buildCalendarKeyboard(year: number, month: number, logDates: Date[]) {
  // Build a month grid inline keyboard
  // Mark days with logs as "✅ DD", unmarked days as "DD"
  // Top row: navigation ["◀️ Nov", "Jan ▶️"]
  // Return InlineKeyboard object
}
```

> **Tip:** Use the `date-fns` library for date math:
> ```bash
> npm install date-fns
> ```

### 7.2 — Tap a logged day

- Show log text with buttons:
  ```
  [✏️ Edit this log]   [🗑️ Delete]
  [✨ Refine with AI]  [🏠 Menu]
  ```

### 7.3 — Delete confirmation

- On 🗑️ tap: prompt "Are you sure? [Yes, delete ❌] [Cancel]"
- On confirm: `prisma.log.delete({ where: { id: logId } })`

---

## Phase 8 — AI Features (`src/bot/aiFeatures.ts` + `src/services/openai.ts`)

### 8.1 — OpenAI wrapper (`src/services/openai.ts`)

```typescript
import OpenAI from "openai";
export const openai = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });

export async function refineLog(rawLog: string): Promise<string> {
  const completion = await openai.chat.completions.create({
    model: "gpt-4o",
    messages: [
      {
        role: "system",
        content: `You are helping a Nigerian university student refine their SIWES (industrial training) logbook entry. 
The student did real work today your job is to make their log entry sound professional, well-structured, 
and impressive to an academic supervisor, while keeping it truthful and grounded in what they actually wrote.
Expand abbreviations, improve grammar, add professional vocabulary where appropriate, 
and structure it with a brief intro, body of activities, and a short reflective closing sentence.
Keep it between 200-400 words. Return only the refined log, no commentary.`,
      },
      { role: "user", content: rawLog },
    ],
  });
  return completion.choices[0].message.content ?? rawLog;
}

export async function transcribeVoice(filePath: string): Promise<string> {
  const { Readable } = await import("stream");
  const fs = await import("fs");
  const transcription = await openai.audio.transcriptions.create({
    file: fs.createReadStream(filePath),
    model: "whisper-1",
    prompt: "This is a Nigerian university student describing their daily industrial training (SIWES) work activities. Transcribe accurately, preserving their descriptions of technical tasks, tools used, and workplace experiences.",
  });
  return transcription.text;
}
```

### 8.2 — Refinement handler (`src/bot/aiFeatures.ts`)

On "✨ Refine with AI":

1. **Free user check:** query `user.freeAiRefinements`
   - If `> 0`: proceed, decrement count after success
   - If `=== 0`: show upsell message with "Go Pro 👑" button → stop
2. Send loading message: "Let me cook 🍳✨"
3. Call `refineLog(log.content)` 
4. Edit the loading message with the refined result
5. Present: `[✅ Use this version]` `[Keep original 📝]`
6. On confirm: `prisma.log.update({ where: { id }, data: { refinedContent } })`

### 8.3 — Voice log handler (Pro only)

On receiving a voice message:

```typescript
// 1. Check user.isPro — gate if not Pro
// 2. Get file_id from ctx.message.voice.file_id
// 3. Download via Telegram API: bot.api.getFile(file_id) → file_path
// 4. Download OGG file to /tmp using axios
// 5. Call transcribeVoice(localPath)
// 6. Show transcription with buttons:
//    [✅ Save this log] [✏️ Edit before saving] [🔄 Re-record]
```

---

## Phase 9 — Paystack Payments (`src/bot/payments.ts` + `src/services/paystack.ts`)

### 9.1 — Paystack service wrapper

```typescript
// src/services/paystack.ts
import axios from "axios";

const PAYSTACK_BASE = "https://api.paystack.co";
const headers = { Authorization: `Bearer ${process.env.PAYSTACK_SECRET_KEY}` };

export async function initializeTransaction(telegramId: bigint) {
  const res = await axios.post(`${PAYSTACK_BASE}/transaction/initialize`, {
    amount: 500000,  // ₦5,000 in kobo
    email: `${telegramId}@wisa.app`,
    metadata: { telegramId: telegramId.toString() },
  }, { headers });
  return res.data.data as { authorization_url: string; reference: string };
}
```

### 9.2 — Payment flow in bot

On "Go Pro 👑":
1. Show plan overview message
2. On "Pay with Paystack 💳": call `initializeTransaction(telegramId)`
3. Send Paystack link as inline URL button

### 9.3 — Paystack webhook (`src/index.ts`)

```typescript
import crypto from "crypto";

app.post("/webhook/paystack", async (req, res) => {
  const hash = crypto
    .createHmac("sha512", process.env.PAYSTACK_WEBHOOK_SECRET!)
    .update(JSON.stringify(req.body))
    .digest("hex");

  if (hash !== req.headers["x-paystack-signature"]) {
    return res.sendStatus(401);
  }

  if (req.body.event === "charge.success") {
    const telegramId = BigInt(req.body.data.metadata.telegramId);
    const ref = req.body.data.reference;

    await prisma.user.update({
      where: { telegramId },
      data: { isPro: true },
    });

    await prisma.subscription.create({
      data: {
        userId: (await prisma.user.findUnique({ where: { telegramId } }))!.id,
        paystackRef: ref,
        status: "active",
        startDate: new Date(),
        endDate: new Date(Date.now() + 30 * 24 * 60 * 60 * 1000), // +30 days
      },
    });

    await bot.api.sendMessage(Number(telegramId),
      `You're in! Welcome to the Pro squad 👑✨ Your logbook is about to be legendary.`
    );
  }

  res.sendStatus(200);
});
```

---

## Phase 10 — Keep-Active Strategy (`src/services/userActivity.ts`)

Implement 3 scheduled tasks using `node-cron`:

| Cron | Description |
|---|---|
| `0 9 1 * *` (9am on 1st of every month) | Monthly check-in ping to all users |
| `0 9 * * *` (daily 9am) | Find users with no interaction in 7+ days → send nudge |
| After every action | Always end bot messages with at least one inline button |

```typescript
// Monthly check-in
cron.schedule("0 9 1 * *", async () => {
  const users = await prisma.user.findMany({ where: { onboardingDone: true } });
  for (const user of users) {
    await bot.api.sendMessage(Number(user.telegramId),
      `Hey ${user.firstName}! 👋 New month, new logs 📅 Just tap below so I know you're still here 😊`,
      { reply_markup: { inline_keyboard: [[{ text: "I'm here! 👋", callback_data: "keepalive" }]] } }
    );
  }
});
```

---

## Phase 11 — Settings Menu

Handle the "⚙️ Settings" reply keyboard button:

Show inline menu:
- **⏰ Change reminder time** → re-show time picker (same as onboarding Step 3), update `User.reminderTime` in DB, re-generate upcoming `ReminderJob` entries
- **📅 Change log frequency** → re-show frequency picker, update `User.logFrequency`, re-generate `ReminderJob` entries
- **👑 Manage subscription** → show subscription status, expiry date, cancel option
- **❓ How this works** → send a text message explaining the bot

---

## Phase 12 — Ghibli Scene Images

### 12.1 — Generate all 8 images

| Scene | Context | When shown |
|---|---|---|
| Scene 1 | Welcome | `/start` for new user |
| Scene 2 | Frequency picker | Onboarding step 2 |
| Scene 3 | Time picker | Onboarding step 3 |
| Scene 4 | Setup complete | Onboarding done |
| Scene 5 | Reminder | Daily reminder message |
| Scene 6 | Final snooze nudge | 3rd snooze |
| Scene 7 | I'm listening | Starting to write a log |
| Scene 8 | Log saved | Log saved confirmation |

Use the exact prompts from the official plan with any image generation tool (DALL·E 3, Midjourney, etc.). Save as JPG at 1024×1024.

### 12.2 — Cache `file_id` in `src/utils/constants.ts`

```typescript
// On first bot send, capture the file_id returned by Telegram and store here
export const SCENE_FILE_IDS: Record<string, string> = {
  scene1: "",
  scene2: "",
  scene3: "",
  scene4: "",
  scene5: "",
  scene6: "",
  scene7: "",
  scene8: "",
};

// Helper
export async function sendScene(ctx: any, sceneKey: string, caption: string) {
  const fileId = SCENE_FILE_IDS[sceneKey];
  if (fileId) {
    await ctx.replyWithPhoto(fileId, { caption, parse_mode: "Markdown" });
  } else {
    // First time: upload from disk, cache the returned file_id
    const res = await ctx.replyWithPhoto(new InputFile(`./assets/${sceneKey}.jpg`), { caption });
    SCENE_FILE_IDS[sceneKey] = res.photo.at(-1)!.file_id;
  }
}
```

---

## Phase 13 — Railway Deployment

### 13.1 — Push to GitHub

```bash
git init
git add .
git commit -m "feat: initial wisa implementation"
git remote add origin <your-github-repo-url>
git push -u origin main
```

### 13.2 — Connect Railway to GitHub repo

1. In Railway project → **New Service → GitHub Repo**
2. Select your repo
3. Railway auto-detects Node.js via nixpacks

### 13.3 — Set environment variables in Railway

In the bot service's **Variables** tab, add all keys from `.env`:

```
TELEGRAM_BOT_TOKEN
DATABASE_URL         ← copy from Railway PostgreSQL service
OPENAI_API_KEY
PAYSTACK_SECRET_KEY
PAYSTACK_WEBHOOK_SECRET
PORT=3000
```

### 13.4 — Expose the webhook port

In Railway → bot service → **Settings → Networking → Generate Domain**. This gives you a public URL (e.g., `https://wisa.up.railway.app`).

### 13.5 — Register Paystack webhook

In Paystack dashboard → **Settings → Webhooks** → add:
```
https://wisa.up.railway.app/webhook/paystack
```

### 13.6 — Deploy

Railway auto-deploys on every `git push`. Monitor logs in the Railway dashboard.

---

## Phase 14 — Testing Checklist

Run through each flow manually using a test Telegram account:

- [ ] `/start` with a new user — onboarding completes, user saved to DB
- [ ] Frequency + time selection — saved correctly to `User` table
- [ ] `ReminderJob` entries created after onboarding
- [ ] Scheduler fires reminders at the right time
- [ ] Snooze up to 3 times — Scene 6 appears on 3rd snooze
- [ ] Skip reminder — status marked `skipped`
- [ ] Write a log (text) — saved to `Log` table
- [ ] Word count limit enforced at 1,500 words
- [ ] Calendar shows correct ✅ markers
- [ ] Tap a day → view log → edit → saved correctly
- [ ] AI refinement decrements `freeAiRefinements`
- [ ] AI refinement blocked at 0 for free users → upsell shown
- [ ] Pro gate blocks voice log for free users
- [ ] Voice log transcribes and saves correctly
- [ ] Paystack payment link generates
- [ ] Paystack webhook sets `isPro = true` and creates `Subscription`
- [ ] Monthly check-in cron fires (test by advancing system clock or calling function directly)
- [ ] Settings menu updates reminder time and regenerates jobs

---

## Implementation Order Summary

```
Phase 0  → Set up accounts and local tools
Phase 1  → Scaffold project, install deps, create file structure
Phase 2  → Define and migrate Prisma schema
Phase 3  → Boot bot core + Express server entry point
Phase 4  → Onboarding conversation flow
Phase 5  → Scheduler + reminder flow (snooze, skip, auto-snooze)
Phase 6  → Write/edit log flows
Phase 7  → Calendar view
Phase 8  → AI refinement + voice log
Phase 9  → Paystack subscription + webhook
Phase 10 → Keep-active cron jobs
Phase 11 → Settings menu
Phase 12 → Generate images + file_id caching
Phase 13 → Railway deployment
Phase 14 → End-to-end testing
```
