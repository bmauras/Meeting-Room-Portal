import type { BusySlot, Rules } from './api';
import { fromMinutes, toMinutes } from './time';

/** Le créneau qui commence à `minute` est-il libre ? */
export function isFreeAt(busy: BusySlot[], date: string, minute: number): boolean {
  const at = `${date}T${fromMinutes(minute)}`;
  return !busy.some((b) => b.start <= at && b.end > at);
}

/**
 * Heures de début réservables pour une salle : ni passées, ni occupées. `now` ('HH:mm') n'est
 * fourni que si `date` est aujourd'hui.
 */
export function availableStarts(busy: BusySlot[] | null | undefined, date: string, now: string | null, rules: Rules): string[] {
  if (!busy) return [];
  const step = rules.slotMinutes;
  const end = toMinutes(rules.dayEnd);
  const nowMin = now ? toMinutes(now) : -1;
  const starts: string[] = [];
  for (let m = toMinutes(rules.dayStart); m + step <= end; m += step) {
    if (m > nowMin && isFreeAt(busy, date, m)) starts.push(fromMinutes(m));
  }
  return starts;
}

/** Fin la plus tardive possible (en minutes) pour une réunion commençant à `start` : prochaine réunion, fermeture ou durée maximale. */
export function latestEnd(busy: BusySlot[], date: string, start: string, rules: Rules): number {
  const at = `${date}T${start}`;
  let limit = Math.min(toMinutes(rules.dayEnd), toMinutes(start) + rules.maxDurationMinutes);
  for (const b of busy) {
    if (b.start > at && b.start.slice(0, 10) === date) limit = Math.min(limit, toMinutes(b.start.slice(11)));
  }
  return limit;
}
