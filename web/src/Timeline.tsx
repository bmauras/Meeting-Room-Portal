import type { BusySlot, Room, Rules } from './api';
import { isFreeAt } from './slots';
import { slotKey, type RoomStatus } from './status';
import { fromMinutes, toMinutes } from './time';

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

/** Vue « liste » : une ligne par salle, la journée en abscisse. Adaptée aux petits écrans. */
export function Timeline({ rooms, busyByRoom, statusByRoom, mine, loading, rules, date, now, onSelect }: Props) {
  const dayStart = toMinutes(rules.dayStart);
  const dayEnd = toMinutes(rules.dayEnd);
  const span = dayEnd - dayStart;
  const pct = (minutes: number) => `${((Math.min(Math.max(minutes, dayStart), dayEnd) - dayStart) / span) * 100}%`;
  const hours: number[] = [];
  for (let m = Math.ceil(dayStart / 60) * 60; m <= dayEnd; m += 120) hours.push(m);
  const nowMin = now ? toMinutes(now) : null;

  function handleClick(e: React.MouseEvent<HTMLDivElement>, room: Room, busy: BusySlot[]) {
    const rect = e.currentTarget.getBoundingClientRect();
    const raw = dayStart + ((e.clientX - rect.left) / rect.width) * span;
    const start = Math.floor(raw / rules.slotMinutes) * rules.slotMinutes;
    if (start + rules.slotMinutes > dayEnd || (nowMin !== null && start <= nowMin) || !isFreeAt(busy, date, start)) return;
    onSelect(room.email, fromMinutes(start));
  }

  return (
    <div className="timeline" aria-busy={loading}>
      <div className="timeline-row timeline-header" aria-hidden="true">
        <div />
        <div className="timeline-track">
          {hours.map((m) => (
            <span key={m} className="timeline-hour" style={{ left: pct(m) }}>
              {fromMinutes(m)}
            </span>
          ))}
        </div>
      </div>
      {rooms.map((room) => {
        const busy = busyByRoom.get(room.email);
        const unavailable = !loading && busy === null;
        const status = statusByRoom.get(room.email);
        return (
          <div key={room.email} className="timeline-row">
            <div className="timeline-label">
              <div className="timeline-label-text">
                <span className="room-name" title={room.name}>
                  {room.name}
                </span>
                <span className="room-meta">
                  {room.capacity ? `${room.capacity} pers.` : ''}
                  {room.hasVideo ? ' · visio' : ''}
                </span>
                {status ? <span className={`room-status status-${status.tone}`}>{status.label}</span> : <span className="skeleton skeleton-pill" />}
              </div>
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
            <div
              aria-hidden="true"
              className={`timeline-track clickable${unavailable ? ' unavailable' : ''}${loading ? ' loading' : ''}`}
              onClick={(e) => busy && handleClick(e, room, busy)}
            >
              {hours.map((m) => (
                <span key={m} className="timeline-grid" style={{ left: pct(m) }} />
              ))}
              {nowMin !== null && nowMin > dayStart && <span className="timeline-past" style={{ width: pct(nowMin) }} />}
              {busy?.map((b, i) => {
                const s = b.start.slice(0, 10) < date ? dayStart : toMinutes(b.start.slice(11));
                const e = b.end.slice(0, 10) > date ? dayEnd : toMinutes(b.end.slice(11));
                if (e <= dayStart || s >= dayEnd) return null;
                const own = mine.has(slotKey({ roomEmail: room.email, start: b.start, end: b.end }));
                return <span key={i} className={own ? 'timeline-busy mine' : 'timeline-busy'} style={{ left: pct(s), width: `calc(${pct(e)} - ${pct(s)})` }} />;
              })}
            </div>
          </div>
        );
      })}
    </div>
  );
}
