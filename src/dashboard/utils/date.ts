export function startOfUtcDay(date: Date): Date {
  return new Date(Date.UTC(date.getUTCFullYear(), date.getUTCMonth(), date.getUTCDate(), 0, 0, 0, 0));
}

export function endOfUtcDay(date: Date): Date {
  return new Date(Date.UTC(date.getUTCFullYear(), date.getUTCMonth(), date.getUTCDate(), 23, 59, 59, 999));
}

export function addUtcDays(date: Date, days: number): Date {
  const next = new Date(date.getTime());
  next.setUTCDate(next.getUTCDate() + days);
  return next;
}

export function formatDateUtc(date: Date): string {
  return date.toISOString().slice(0, 10);
}

export function buildUtcDaySeries(days: number, endDate = new Date()): Array<{ date: string; start: Date; end: Date }> {
  const series: Array<{ date: string; start: Date; end: Date }> = [];
  for (let i = days - 1; i >= 0; i -= 1) {
    const day = addUtcDays(endDate, -i);
    const start = startOfUtcDay(day);
    const end = endOfUtcDay(day);
    series.push({ date: formatDateUtc(start), start, end });
  }
  return series;
}

export function formatHourLabelUtc(hour: number): string {
  const normalized = ((hour % 24) + 24) % 24;
  const suffix = normalized >= 12 ? "PM" : "AM";
  const display = normalized % 12 === 0 ? 12 : normalized % 12;
  return `${display}${suffix}`;
}
