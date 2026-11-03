import { useEffect, useMemo, useState } from 'react';
import { api, type Booking, type BusySlot, type Me, type Room } from './api';
import { formatDate, fromMinutes, timeSlots, toMinutes } from './time';

export interface Draft {
  roomEmail: string;
  date: string;
  start: string;
}

interface Props {
  me: Me;
  rooms: Room[];
  draft: Draft;
  busy: BusySlot[] | null;
  onCancel: () => void;
  onBooked: (booking: Booking) => void;
}

export function BookingForm({ me, rooms, draft, busy, onCancel, onBooked }: Props) {
  const { rules } = me;
  const [roomEmail, setRoomEmail] = useState(draft.roomEmail);
  const [start, setStart] = useState(draft.start);
  const [end, setEnd] = useState(() => defaultEnd(draft.start));
  const [subject, setSubject] = useState('');
  const [attendees, setAttendees] = useState('');
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  function defaultEnd(from: string) {
    return fromMinutes(Math.min(toMinutes(from) + 60, toMinutes(rules.dayEnd)));
  }

  useEffect(() => {
    setRoomEmail(draft.roomEmail);
    setStart(draft.start);
    setEnd(defaultEnd(draft.start));
    setError(null);
  }, [draft]);

  const slots = useMemo(() => timeSlots(rules.dayStart, rules.dayEnd, rules.slotMinutes), [rules]);
  const endSlots = slots.filter((t) => toMinutes(t) > toMinutes(start) && toMinutes(t) - toMinutes(start) <= rules.maxDurationMinutes);
  const conflict =
    roomEmail === draft.roomEmail &&
    busy?.some((b) => b.start < `${draft.date}T${end}` && b.end > `${draft.date}T${start}`);

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    setSubmitting(true);
    setError(null);
    try {
      const booking = await api.createBooking({
        roomEmail,
        start: `${draft.date}T${start}`,
        end: `${draft.date}T${end}`,
        subject,
        attendees: attendees.split(/[\s,;]+/).filter(Boolean),
      });
      onBooked(booking);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Erreur inattendue.');
    } finally {
      setSubmitting(false);
    }
  }

  return (
    <form className="card booking-form" onSubmit={submit}>
      <h2>Nouvelle réservation</h2>
      <p className="muted">{formatDate(draft.date)}</p>

      <label>
        Salle
        <select value={roomEmail} onChange={(e) => setRoomEmail(e.target.value)}>
          {rooms.map((r) => (
            <option key={r.email} value={r.email}>
              {r.name}
              {r.capacity ? ` (${r.capacity} pers.)` : ''}
            </option>
          ))}
        </select>
      </label>

      <div className="row">
        <label>
          Début
          <select
            value={start}
            onChange={(e) => {
              setStart(e.target.value);
              setEnd(defaultEnd(e.target.value));
            }}
          >
            {slots.slice(0, -1).map((t) => (
              <option key={t} value={t}>
                {t}
              </option>
            ))}
          </select>
        </label>
        <label>
          Fin
          <select value={end} onChange={(e) => setEnd(e.target.value)}>
            {endSlots.map((t) => (
              <option key={t} value={t}>
                {t}
              </option>
            ))}
          </select>
        </label>
      </div>

      <label>
        Objet
        <input value={subject} onChange={(e) => setSubject(e.target.value)} minLength={3} maxLength={80} required placeholder="Ex. : Réunion de suivi projet" />
      </label>

      <label>
        Participants supplémentaires <span className="muted small">(facultatif)</span>
        <textarea
          rows={2}
          value={attendees}
          onChange={(e) => setAttendees(e.target.value)}
          placeholder={`prenom.nom@${rules.allowedAttendeeDomains[0] ?? 'exemple.com'}`}
        />
        <span className="muted small">Domaines acceptés : {rules.allowedAttendeeDomains.join(', ')}</span>
      </label>

      <p className="muted small">
        Une réunion Teams est ajoutée automatiquement. L'invitation est envoyée à {me.user.email}. Pour annuler, utilisez ce portail
        (refuser l'invitation dans Outlook ne libère pas la salle).
      </p>

      {conflict && <p className="alert alert-warning">Ce créneau chevauche une réservation existante.</p>}
      {error && (
        <p className="alert alert-error" role="alert">
          {error}
        </p>
      )}

      <div className="row actions">
        <button type="button" className="button button-ghost" onClick={onCancel}>
          Annuler
        </button>
        <button type="submit" className="button button-primary" disabled={submitting || !end || Boolean(conflict)}>
          {submitting ? 'Réservation…' : 'Réserver'}
        </button>
      </div>
    </form>
  );
}
