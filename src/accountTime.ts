/** Show elapsed 24-hour periods, not calendar-day boundaries. */
export function lastSignedIn(timestamp: number | null, now: number): string {
  if (timestamp === null || !Number.isFinite(timestamp) || timestamp > now)
    return "Not recorded";
  const days = Math.floor((now - timestamp) / 86_400_000);
  if (days < 1) return "Less than a day ago";
  return `${days} ${days === 1 ? "day" : "days"} ago`;
}
