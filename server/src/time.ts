// Toutes les dates manipulées par l'application sont des heures locales du fuseau
// des salles, au format 'YYYY-MM-DDTHH:mm'. Ce format se compare lexicographiquement.

const DATE = /^(\d{4})-(\d{2})-(\d{2})$/;
const TIME = /^(\d{2}):(\d{2})$/;

export function nowLocal(timeZone: string, now: Date = new Date()): string {
  const parts = new Intl.DateTimeFormat('en-CA', {
    timeZone,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    hourCycle: 'h23',
  }).formatToParts(now);
  const get = (type: Intl.DateTimeFormatPartTypes) => parts.find((p) => p.type === type)?.value ?? '00';
  return `${get('year')}-${get('month')}-${get('day')}T${get('hour')}:${get('minute')}`;
}

export function isValidDate(date: string): boolean {
  const m = DATE.exec(date);
  if (!m) return false;
  const d = new Date(Date.UTC(Number(m[1]), Number(m[2]) - 1, Number(m[3])));
  return d.toISOString().slice(0, 10) === date;
}

export function addDays(date: string, days: number): string {
  const [y, m, d] = date.split('-').map(Number) as [number, number, number];
  return new Date(Date.UTC(y, m - 1, d + days)).toISOString().slice(0, 10);
}

export function isWeekend(date: string): boolean {
  const [y, m, d] = date.split('-').map(Number) as [number, number, number];
  const day = new Date(Date.UTC(y, m - 1, d)).getUTCDay();
  return day === 0 || day === 6;
}

/** 'YYYY-MM-DD' → « mercredi 4 novembre 2026 ». */
export function formatLongDate(date: string): string {
  const [y, m, d] = date.split('-').map(Number) as [number, number, number];
  return new Intl.DateTimeFormat('fr-FR', { weekday: 'long', day: 'numeric', month: 'long', year: 'numeric', timeZone: 'UTC' }).format(
    new Date(Date.UTC(y, m - 1, d)),
  );
}

export function toMinutes(time: string): number {
  const m = TIME.exec(time);
  if (!m) return Number.NaN;
  const h = Number(m[1]);
  const min = Number(m[2]);
  if (h > 23 || min > 59) return Number.NaN;
  return h * 60 + min;
}

/** Convertit une date Graph (dateTimeTimeZone) en heure locale 'YYYY-MM-DDTHH:mm'. */
export function graphToLocal(value: { dateTime: string; timeZone: string }, timeZone: string): string {
  if (value.timeZone.toUpperCase() === 'UTC') {
    return nowLocal(timeZone, new Date(`${value.dateTime.slice(0, 19)}Z`));
  }
  // Les appels Graph sont faits avec l'en-tête Prefer: outlook.timezone, les heures sont déjà locales.
  return value.dateTime.slice(0, 16);
}
