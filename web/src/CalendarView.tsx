import { useState } from 'react';
import type { BusySlot, Room, Rules } from './api';
import { isFreeAt, latestEnd } from './slots';
import { slotKey, type RoomStatus } from './status';
import { fromMinutes, toMinutes } from './time';

/** Hauteur d'une heure en pixels. */
const HOUR_HEIGHT = 52;
const PREVIEW_MINUTES = 60;

interface Props {
  rooms: Room[];
  busyByRoom: Map<string, BusySlot[] | null>;
  statusByRoom: Map<string, RoomStatus>;
  /** Créneaux réservés par l'utilisateur (voir slotKey). */
  mine: Set<string>;
  loading: boolean;
  rules: Rules;
  date: string;
  /** Heure courante 'HH:mm' si la date affichée est aujourd'hui. */
  now: string | null;
  /** start = null : premier créneau libre de la salle. */
  onSelect: (roomEmail: string, start: string | null) => void;
}

/**
 * Vue « agenda » de la journée : une colonne par salle, les heures en ordonnée. La grille est une
 * aide visuelle (souris, tactile) ; au clavier et au lecteur d'écran, chaque salle a son bouton
 * « Réserver » et son statut textuel.
 */
export function CalendarView({ rooms, busyByRoom, statusByRoom, mine, loading, rules, date, now, onSelect }: Props) {
  const [hover, setHover] = useState<{ room: string; start: number } | null>(null);
  const dayStart = toMinutes(rules.dayStart);
  const dayEnd = toMinutes(rules.dayEnd);
  const clamp = (m: number) => Math.min(Math.max(m, dayStart), dayEnd);
  const px = (m: number) => ((clamp(m) - dayStart) * HOUR_HEIGHT) / 60;
  const height = px(dayEnd);
  const nowMin = now ? toMinutes(now) : null;

  const lines: { minute: number; hour: boolean }[] = [];
  for (let m = Math.ceil(dayStart / 30) * 30; m < dayEnd; m += 30) lines.push({ minute: m, hour: m % 60 === 0 });

  /** Début de créneau réservable sous le pointeur, ou null. */
  function slotAt(e: React.MouseEvent<HTMLDivElement>, busy: BusySlot[]): number | null {
    const rect = e.currentTarget.getBoundingClientRect();
    const minute = dayStart + ((e.clientY - rect.top) / HOUR_HEIGHT) * 60;
    const start = Math.floor(minute / rules.slotMinutes) * rules.slotMinutes;
    if (start < dayStart || start + rules.slotMinutes > dayEnd || (nowMin !== null && start <= nowMin)) return null;
    return isFreeAt(busy, date, start) ? start : null;
  }

  return (
    <div className="calendar" aria-busy={loading}>
      <div className="calendar-grid" style={{ gridTemplateColumns: `60px repeat(${rooms.length}, minmax(150px, 1fr))` }}>
        <div className="calendar-corner" />
        {rooms.map((room) => {
          const status = statusByRoom.get(room.email);
          return (
            <div key={room.email} className="calendar-head">
              <span className="room-name" title={room.name}>
                {room.name}
              </span>
              <span className="room-meta">
                {room.capacity ? `${room.capacity} pers.` : 'Capacité non renseignée'}
                {room.hasVideo ? ' · visio' : ''}
              </span>
              <div className="calendar-head-row">
                {status ? <span className={`room-status status-${status.tone}`}>{status.label}</span> : <span className="skeleton skeleton-pill" />}
                <button
                  type="button"
                  className="button button-secondary button-small"
                  disabled={!status?.bookable}
                  aria-label={`Réserver ${room.name}`}
                  onClick={() => onSelect(room.email, null)}
                >
                  Réserver
                </button>
              </div>
            </div>
          );
        })}

        <div className="calendar-times" style={{ height }} aria-hidden="true">
          {lines
            .filter((l) => l.hour)
            .map((l) => (
              <span key={l.minute} className="calendar-hour" style={{ top: px(l.minute) }}>
                {fromMinutes(l.minute)}
              </span>
            ))}
        </div>

        {rooms.map((room) => {
          const busy = busyByRoom.get(room.email);
          const unavailable = !loading && busy === null;
          const preview = hover?.room === room.email && busy ? hover.start : null;
          const previewEnd = preview !== null && busy ? Math.min(preview + PREVIEW_MINUTES, latestEnd(busy, date, fromMinutes(preview), rules)) : null;
          return (
            <div
              key={room.email}
              aria-hidden="true"
              className={`calendar-column${busy ? ' clickable' : ''}${unavailable ? ' unavailable' : ''}${loading ? ' loading' : ''}`}
              style={{ height }}
              onMouseMove={(e) => {
                if (!busy) return;
                const start = slotAt(e, busy);
                setHover(start === null ? null : { room: room.email, start });
              }}
              onMouseLeave={() => setHover(null)}
              onClick={(e) => {
                const start = busy ? slotAt(e, busy) : null;
                if (start !== null) onSelect(room.email, fromMinutes(start));
              }}
            >
              {lines.map((l) => (
                <span key={l.minute} className={l.hour ? 'calendar-line' : 'calendar-line half'} style={{ top: px(l.minute) }} />
              ))}
              {nowMin !== null && nowMin > dayStart && <span className="calendar-past" style={{ height: px(nowMin) }} />}
              {busy?.map((b, i) => {
                const s = b.start.slice(0, 10) < date ? dayStart : toMinutes(b.start.slice(11));
                const e = b.end.slice(0, 10) > date ? dayEnd : toMinutes(b.end.slice(11));
                if (e <= dayStart || s >= dayEnd) return null;
                const top = px(s);
                const blockHeight = px(e) - top;
                const own = mine.has(slotKey({ roomEmail: room.email, start: b.start, end: b.end }));
                return (
                  <span key={i} className={own ? 'calendar-busy mine' : 'calendar-busy'} style={{ top, height: blockHeight }}>
                    {blockHeight >= 20 && <strong>{own ? 'Votre réservation' : 'Occupée'}</strong>}
                    {blockHeight >= 36 && (
                      <span>
                        {fromMinutes(clamp(s))} – {fromMinutes(clamp(e))}
                      </span>
                    )}
                  </span>
                );
              })}
              {preview !== null && previewEnd !== null && (
                <span className="calendar-preview" style={{ top: px(preview), height: px(previewEnd) - px(preview) }}>
                  <strong>+ Réserver</strong>
                  <span>
                    {fromMinutes(preview)} – {fromMinutes(previewEnd)}
                  </span>
                </span>
              )}
              {nowMin !== null && nowMin > dayStart && nowMin < dayEnd && <span className="calendar-now" style={{ top: px(nowMin) }} />}
            </div>
          );
        })}
      </div>
    </div>
  );
}
