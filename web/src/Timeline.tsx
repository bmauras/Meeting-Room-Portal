import type { BusySlot, Room, Rules } from './api';
import type { Draft } from './BookingForm';
import { fromMinutes, toMinutes } from './time';

interface Props {
  rooms: Room[];
  busyByRoom: Map<string, BusySlot[] | null>;
  loading: boolean;
  rules: Rules;
  /** Heure courante 'HH:mm' si la date affichée est aujourd'hui. */
  now: string | null;
  selection: Draft | null;
  onSelect: (roomEmail: string, start: string) => void;
}

export function Timeline({ rooms, busyByRoom, loading, rules, now, selection, onSelect }: Props) {
  const dayStart = toMinutes(rules.dayStart);
  const dayEnd = toMinutes(rules.dayEnd);
  const span = dayEnd - dayStart;
  const pct = (minutes: number) => `${((Math.min(Math.max(minutes, dayStart), dayEnd) - dayStart) / span) * 100}%`;
  const hours: number[] = [];
  for (let m = Math.ceil(dayStart / 60) * 60; m <= dayEnd; m += 60) hours.push(m);
  const nowMin = now ? toMinutes(now) : null;

  if (!loading && rooms.length === 0) return <p className="muted">Aucune salle ne correspond aux critères.</p>;

  function handleClick(e: React.MouseEvent<HTMLDivElement>, room: Room, busy: BusySlot[]) {
    const rect = e.currentTarget.getBoundingClientRect();
    const raw = dayStart + ((e.clientX - rect.left) / rect.width) * span;
    const start = Math.floor(raw / rules.slotMinutes) * rules.slotMinutes;
    if (nowMin !== null && start <= nowMin) return;
    const startTime = fromMinutes(start);
    if (busy.some((b) => b.start.slice(11) <= startTime && b.end.slice(11) > startTime)) return;
    onSelect(room.email, startTime);
  }

  return (
    <div className="timeline" aria-busy={loading}>
      <div className="timeline-row timeline-header">
        <div className="timeline-label" />
        <div className="timeline-track">
          {hours.map((m) => (
            <span key={m} className="timeline-hour" style={{ left: pct(m) }}>
              {fromMinutes(m).slice(0, 2)}h
            </span>
          ))}
        </div>
      </div>
      {rooms.map((room) => {
        const busy = busyByRoom.get(room.email);
        const unavailable = !loading && busy === null;
        return (
          <div key={room.email} className="timeline-row">
            <div className="timeline-label">
              <span className="room-name">{room.name}</span>
              <span className="muted small">
                {room.capacity ? `${room.capacity} pers.` : ''}
                {room.hasVideo ? ' · visio' : ''}
                {room.accessible ? ' · ♿' : ''}
              </span>
            </div>
            <div
              className={`timeline-track clickable${unavailable ? ' unavailable' : ''}`}
              title={unavailable ? 'Disponibilité indisponible' : 'Cliquez sur un créneau libre pour réserver'}
              onClick={(e) => busy && handleClick(e, room, busy)}
            >
              {hours.map((m) => (
                <span key={m} className="timeline-grid" style={{ left: pct(m) }} />
              ))}
              {nowMin !== null && nowMin > dayStart && <span className="timeline-past" style={{ width: pct(nowMin) }} />}
              {busy?.map((b, i) => {
                const s = toMinutes(b.start.slice(11));
                const e = b.end.slice(0, 10) > b.start.slice(0, 10) ? dayEnd : toMinutes(b.end.slice(11));
                return (
                  <span
                    key={i}
                    className="timeline-busy"
                    style={{ left: pct(s), width: `calc(${pct(e)} - ${pct(s)})` }}
                    title={`Occupée ${b.start.slice(11)} – ${b.end.slice(11)}`}
                  />
                );
              })}
              {selection?.roomEmail === room.email && (
                <span className="timeline-selection" style={{ left: pct(toMinutes(selection.start)) }} />
              )}
            </div>
          </div>
        );
      })}
      {loading && <p className="muted small">Chargement des disponibilités…</p>}
    </div>
  );
}
