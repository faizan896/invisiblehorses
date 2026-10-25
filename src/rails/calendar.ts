// US banking-day model for the ACH simulation. No live bank service is contacted.
const zone = 'America/New_York';
const formatter = new Intl.DateTimeFormat('en-US', { timeZone: zone, year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', hourCycle: 'h23' });
function parts(date: Date) {
  const p = Object.fromEntries(formatter.formatToParts(date).map((v) => [v.type, v.value]));
  return { year: Number(p.year), month: Number(p.month), day: Number(p.day), hour: Number(p.hour), minute: Number(p.minute) };
}
function dayKey(date: Date) { return date.toISOString().slice(0, 10); }
function observed(year: number, month: number, day: number) {
  const d = new Date(Date.UTC(year, month - 1, day));
  if (d.getUTCDay() === 6) d.setUTCDate(d.getUTCDate() - 1);
  if (d.getUTCDay() === 0) d.setUTCDate(d.getUTCDate() + 1);
  return dayKey(d);
}
function nthWeekday(year: number, month: number, weekday: number, nth: number) {
  const d = new Date(Date.UTC(year, month - 1, 1));
  d.setUTCDate(1 + (weekday - d.getUTCDay() + 7) % 7 + (nth - 1) * 7);
  return dayKey(d);
}
function holidays(year: number) {
  const memorial = new Date(Date.UTC(year, 5, 0));
  memorial.setUTCDate(memorial.getUTCDate() - (memorial.getUTCDay() - 1 + 7) % 7);
  return new Set([
    observed(year, 1, 1), observed(year + 1, 1, 1), nthWeekday(year, 1, 1, 3), nthWeekday(year, 2, 1, 3),
    dayKey(memorial), observed(year, 6, 19), observed(year, 7, 4), nthWeekday(year, 9, 1, 1),
    nthWeekday(year, 10, 1, 2), observed(year, 11, 11), nthWeekday(year, 11, 4, 4), observed(year, 12, 25),
  ]);
}
export function businessDay(date: Date) { return ![0, 6].includes(date.getUTCDay()) && !holidays(date.getUTCFullYear()).has(dayKey(date)); }
function addBusiness(date: Date, count: number) {
  const result = new Date(date);
  while (count > 0) { result.setUTCDate(result.getUTCDate() + 1); if (businessDay(result)) count--; }
  return result;
}
function atNewYork(day: Date, hour: number) {
  const target = Date.UTC(day.getUTCFullYear(), day.getUTCMonth(), day.getUTCDate(), hour);
  let guess = target;
  for (let i = 0; i < 3; i++) {
    const p = parts(new Date(guess));
    guess += target - Date.UTC(p.year, p.month - 1, p.day, p.hour, p.minute);
  }
  return new Date(guess).toISOString();
}
export function bankWindow(now: string) {
  const p = parts(new Date(now));
  let processing = new Date(Date.UTC(p.year, p.month - 1, p.day));
  const accepting = businessDay(processing) && p.hour >= 9 && p.hour < 16;
  if (!businessDay(processing) || p.hour >= 16) processing = addBusiness(processing, 1);
  return {
    accepting_now: accepting,
    processing_at: atNewYork(processing, p.hour < 9 ? 9 : 16),
    expected_at: atNewYork(addBusiness(processing, 1), 16),
    latest_at: atNewYork(addBusiness(processing, 2), 16),
  };
}
export function nextPayout(now: string, hours = 2) {
  const desired = new Date(Date.parse(now) + hours * 3600000);
  const p = parts(desired);
  let day = new Date(Date.UTC(p.year, p.month - 1, p.day));
  if (businessDay(day) && p.hour >= 9 && p.hour < 16) return desired.toISOString();
  if (!businessDay(day) || p.hour >= 16) day = addBusiness(day, 1);
  return atNewYork(day, 10);
}
