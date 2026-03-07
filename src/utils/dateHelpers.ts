/**
 * Build a UTC Date for a given local time in a given IANA timezone.
 *
 * Example: localTimeToUtc("18:00", "Africa/Lagos", daysFromToday = 0)
 *   → Date representing 18:00 WAT today → 17:00 UTC today
 *
 * Works by formatting "today + daysFromToday" in the target timezone,
 * computing the UTC offset, and adjusting accordingly.
 */
export function localTimeToUtc(
  time: string,
  timezone: string,
  daysFromToday = 0,
): Date {
  const [hour, minute] = time.split(":").map(Number);

  // Start with a "base" date N days from now — use noon UTC to avoid DST edge cases
  const base = new Date();
  base.setUTCDate(base.getUTCDate() + daysFromToday);
  base.setUTCHours(12, 0, 0, 0);

  // Format that base date in the target timezone to find the UTC offset
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone: timezone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
    hour12: false,
  }).formatToParts(base);

  const get = (type: string) => parseInt(parts.find((p) => p.type === type)?.value ?? "0", 10);

  // Construct what the local date-time *would* be at the requested hour:minute
  const localDate = new Date(
    Date.UTC(get("year"), get("month") - 1, get("day"), hour, minute, 0, 0),
  );

  // The offset in ms = localDate(as-if-UTC) - what UTC actually is at that local time
  // We can derive it: base in UTC minus base in local (formatted)
  const baseLocal = new Date(
    Date.UTC(get("year"), get("month") - 1, get("day"), get("hour"), get("minute"), get("second")),
  );
  const offsetMs = baseLocal.getTime() - base.getTime();

  // Apply offset: UTC = local - offset
  return new Date(localDate.getTime() - offsetMs);
}

/**
 * Check whether a local time has already passed "today" in the given timezone.
 */
export function hasLocalTimePassed(time: string, timezone: string): boolean {
  const target = localTimeToUtc(time, timezone, 0);
  return new Date() >= target;
}

/**
 * Get the day-of-week (0 = Sunday, 6 = Saturday) for a Date in a given timezone.
 */
export function getLocalDayOfWeek(date: Date, timezone: string): number {
  const dayStr = new Intl.DateTimeFormat("en-US", {
    timeZone: timezone,
    weekday: "short",
  }).format(date);
  const map: Record<string, number> = { Sun: 0, Mon: 1, Tue: 2, Wed: 3, Thu: 4, Fri: 5, Sat: 6 };
  return map[dayStr] ?? 0;
}

/**
 * If the given date falls on a Saturday or Sunday (in the given timezone),
 * advance it to the next Monday at the same time.
 */
export function skipWeekend(date: Date, timezone: string): Date {
  const dow = getLocalDayOfWeek(date, timezone);
  if (dow === 6) return new Date(date.getTime() + 2 * 24 * 60 * 60 * 1000); // Sat → Mon
  if (dow === 0) return new Date(date.getTime() + 1 * 24 * 60 * 60 * 1000); // Sun → Mon
  return date;
}
