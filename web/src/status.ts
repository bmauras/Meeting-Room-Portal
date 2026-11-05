import type { BusySlot, Rules } from './api';
import { fromMinutes, toMinutes } from './time';

/** Identifie un créneau d'une salle : sert à reconnaître ses propres réservations dans le planning. */
export function slotKey(slot: { roomEmail: string; start: string; end: string }): string {
  return `${slot.roomEmail.toLowerCase()}|${slot.start}|${slot.end}`;
}

export type StatusTone = 'free' | 'partial' | 'busy' | 'closed' | 'unknown';

export interface RoomStatus {
  tone: StatusTone;
  label: string;
  /** Au moins un créneau libre reste réservable sur la journée affichée. */
  bookable: boolean;
}

/** Plages occupées fusionnées et ramenées à la journée affichée, en minutes. */
function busyMinutes(busy: BusySlot[], date: string, dayStart: number, dayEnd: number): [number, number][] {
  const ranges = busy
    .map(({ start, end }): [number, number] => [
      start.slice(0, 10) < date ? dayStart : toMinutes(start.slice(11)),
      end.slice(0, 10) > date ? dayEnd : toMinutes(end.slice(11)),
    ])
    .map(([s, e]): [number, number] => [Math.max(s, dayStart), Math.min(e, dayEnd)])
    .filter(([s, e]) => e > s)
    .sort((a, b) => a[0] - b[0]);

  const merged: [number, number][] = [];
  for (const range of ranges) {
    const last = merged[merged.length - 1];
    if (last && range[0] <= last[1]) last[1] = Math.max(last[1], range[1]);
    else merged.push([...range]);
  }
  return merged;
}

function formatFree(minutes: number): string {
  const h = Math.floor(minutes / 60);
  const m = minutes % 60;
  return h === 0 ? `${m} min` : m === 0 ? `${h} h` : `${h} h ${String(m).padStart(2, '0')}`;
}

/**
 * Statut d'une salle pour la journée affichée. `now` ('HH:mm') n'est fourni que si la date
 * affichée est aujourd'hui : le statut décrit alors la situation à l'instant présent.
 */
export function roomStatus(busy: BusySlot[] | null | undefined, date: string, now: string | null, rules: Rules): RoomStatus | null {
  if (busy === undefined) return null;
  if (busy === null) return { tone: 'unknown', label: 'Disponibilité inconnue', bookable: false };

  const dayStart = toMinutes(rules.dayStart);
  const dayEnd = toMinutes(rules.dayEnd);
  const from = now ? Math.max(toMinutes(now), dayStart) : dayStart;
  if (from >= dayEnd) return { tone: 'closed', label: 'Plus réservable aujourd’hui', bookable: false };

  const ranges = busyMinutes(busy, date, dayStart, dayEnd).filter(([, e]) => e > from);
  const busyTotal = ranges.reduce((sum, [s, e]) => sum + (e - Math.max(s, from)), 0);
  const freeTotal = dayEnd - from - busyTotal;
  if (freeTotal < rules.slotMinutes) return { tone: 'busy', label: now ? 'Occupée jusqu’à la fermeture' : 'Complète', bookable: false };

  if (now) {
    const current = ranges.find(([s, e]) => s <= from && e > from);
    if (current) return { tone: 'busy', label: `Occupée jusqu’à ${fromMinutes(current[1])}`, bookable: true };
    const next = ranges[0];
    return next
      ? { tone: 'partial', label: `Libre jusqu’à ${fromMinutes(next[0])}`, bookable: true }
      : { tone: 'free', label: `Libre jusqu’à ${rules.dayEnd}`, bookable: true };
  }

  return ranges.length === 0
    ? { tone: 'free', label: 'Libre toute la journée', bookable: true }
    : { tone: 'partial', label: `${formatFree(freeTotal)} libres`, bookable: true };
}
