This is a great product instinct. The recap turns Wisa from a logging tool into something that actually reflects their week back at them — that's the kind of moment that makes people feel like the product genuinely cares. Here's the refined plan:

---

## The Saturday Feature — Weekly Recap + IT Wisdom

---

### How It Works

Every Saturday at 12PM, every user who has completed onboarding gets one message. It has two parts — their week in review, and one piece of advice from a former IT student.

One message. Two feelings — reflection and motivation.

---

### The Recap Section

Pull logs from Monday to Friday of that week. For each day, show either what they wrote or a missed day callout.

**The message:**

> 📋 **Your week in review, {firstName}**
> *{Mon DD} — {Fri DD} {Month}*
>
Monday — {first 100 chars of log} 📝
Tuesday — nothing logged that day 👀
Wednesday — {first 100 chars of log} 📝
Thursday — {first 100 chars of log} 📝
Friday — nothing logged that day 👀
>
> {logged N days out of 5} 
>
> _{if 5/5}: You logged every single day this week 🔥 Your logbook is going to be immaculate._
> _{if 3-4/5}: Solid week! The missed days can still be filled in - tap "See my logs" and catch up before you forget 🙏_
> _{if 1-2/5}: This week was rough - no judgement 😅 But go fill in what you remember before the details fade. Future you needs this._
> _{if 0/5}: No logs this week {firstName}. It happens — but tap "Past log" right now while the week is still fresh 👀_

---

### The Advice Footer

Below the recap, separated cleanly:

> ---
> 💬 **Advice from a former IT student**
>
> *"{quote}"*
>


---

### The Quotes — First 8 Weeks

For this first week this is all I have:
"No matter where you are doing your IT, even though it wasn't where you planned to do it, always look at it from the angle of God has put me here for a reason how can I be a blessing to this place and how can I be blessed also"
I will fill in the rest later

### What Needs to Be Built

**Database:** No new fields needed — just query logs where `logDate` falls between the Monday and Friday of the current week for each user.

**Scheduler:** Add a Saturday 12PM cron job that loops through all onboarded users and sends the recap.

**Quotes table:** Add a simple `WeeklyQuote` table in the DB with `weekNumber`, `quote`, `attribution`. Seed it manually. The scheduler picks the quote where `weekNumber` matches the current IT week, or cycles through them.

**One config value:** Store the IT start date (the Monday of week 1) so the scheduler always knows which week number it is and which quote to pull.

---

### Why This Works as a Retention Tool

The recap on its own makes people feel seen — "this app knows my week." But the missed days callout with a direct "tap Past log" button is also quietly one of your strongest re-engagement moments of the week. Someone who has been slipping will open that Saturday message, feel a mild guilt about the empty days, and go fill them in. That is exactly the behaviour that keeps them past the 16-log wall.

The advice footer keeps them opening the Saturday message even on weeks they logged perfectly — because there's always something new at the bottom. Over time that becomes a habit on its own.