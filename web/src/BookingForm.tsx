import { useEffect, useId, useMemo, useRef, useState } from 'react';
import { api, ApiError, type Booking, type BusySlot, type Me, type Room } from './api';
import { addEmails, EmailChips } from './EmailChips';
import { availableStarts, latestEnd } from './slots';
import { formatDuration, fromMinutes, toMinutes } from './time';

const MAX_ATTENDEES = 10;
const DEFAULT_DURATION = 60;
const SUBJECT_MAX = 80;

interface Props {
  me: Me;
  rooms: Room[];
  date: string;
  initialRoom: string;
  /** Heure de début proposée ('HH:mm'), ou null pour le premier créneau libre. */
  initialStart: string | null;
  busyByRoom: Map<string, BusySlot[] | null>;
  /** Heure courante 'HH:mm' si `date` est aujourd'hui. */
  now: string | null;
  onCancel: () => void;
  onBooked: (booking: Booking) => void;
  /** Le créneau a été pris entre-temps : le planning doit être relu. */
  onConflict: () => void;
}

export function BookingForm({ me, rooms, date, initialRoom, initialStart, busyByRoom, now, onCancel, onBooked, onConflict }: Props) {
  const { rules } = me;
  const ids = { room: useId(), start: useId(), duration: useId(), subject: useId(), subjectHint: useId(), subjectError: useId() };

  const startsByRoom = useMemo(
    () => new Map(rooms.map((r) => [r.email, availableStarts(busyByRoom.get(r.email), date, now, rules)])),
    [rooms, busyByRoom, date, now, rules],
  );

  const [roomEmail, setRoomEmail] = useState(initialRoom);
  const starts = startsByRoom.get(roomEmail) ?? [];
  const [start, setStart] = useState(() => (initialStart && starts.includes(initialStart) ? initialStart : (starts[0] ?? '')));
  const [duration, setDuration] = useState(DEFAULT_DURATION);
  const [subject, setSubject] = useState('');
  const [attendees, setAttendees] = useState<string[]>([]);
  const [attendeeDraft, setAttendeeDraft] = useState('');
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [subjectError, setSubjectError] = useState<string | null>(null);

  const [slotNotice, setSlotNotice] = useState<string | null>(null);
  const previousRoom = useRef(roomEmail);

  // Le créneau choisi n'est plus libre : premier créneau libre. Si la salle n'a pas changé, c'est
  // qu'il vient d'être réservé par quelqu'un d'autre : on le dit plutôt que de changer en silence.
  useEffect(() => {
    const roomChanged = previousRoom.current !== roomEmail;
    previousRoom.current = roomEmail;
    if (starts.includes(start)) return;
    const next = starts[0] ?? '';
    if (!roomChanged && start) {
      setSlotNotice(
        next
          ? `Le créneau de ${start} vient d’être réservé par quelqu’un d’autre. Prochain créneau libre proposé : ${next}.`
          : `Le créneau de ${start} vient d’être réservé par quelqu’un d’autre, et il n’y a plus de créneau libre dans cette salle.`,
      );
    } else {
      setSlotNotice(null);
    }
    setStart(next);
  }, [starts, start, roomEmail]);

  const busy = busyByRoom.get(roomEmail) ?? [];
  const maxEnd = start ? latestEnd(busy, date, start, rules) : 0;
  const durations = useMemo(() => {
    const list: number[] = [];
    if (start) for (let d = rules.slotMinutes; toMinutes(start) + d <= maxEnd; d += rules.slotMinutes) list.push(d);
    return list;
  }, [start, maxEnd, rules.slotMinutes]);
  const effectiveDuration = durations.includes(duration) ? duration : (durations[durations.length - 1] ?? 0);
  const end = start ? fromMinutes(toMinutes(start) + effectiveDuration) : '';

  const selectedRoom = rooms.find((r) => r.email === roomEmail);
  const anyDomain = rules.allowedAttendeeDomains.includes('*');

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    const trimmed = subject.trim();
    if (trimmed.length < 3) {
      setSubjectError('Indiquez un objet d’au moins 3 caractères.');
      document.getElementById(ids.subject)?.focus();
      return;
    }
    // Adresse encore en cours de saisie : ajoutée avant l'envoi.
    let finalAttendees = attendees;
    if (attendeeDraft.trim()) {
      const result = addEmails(attendeeDraft, attendees, { allowedDomains: rules.allowedAttendeeDomains, max: MAX_ATTENDEES, self: me.user.email });
      if (result.error) {
        setError(result.error);
        return;
      }
      finalAttendees = result.emails;
      setAttendees(result.emails);
      setAttendeeDraft('');
    }

    setSubmitting(true);
    setError(null);
    try {
      const booking = await api.createBooking({ roomEmail, start: `${date}T${start}`, end: `${date}T${end}`, subject: trimmed, attendees: finalAttendees });
      onBooked(booking);
    } catch (err) {
      setSubmitting(false);
      if (err instanceof ApiError && err.status === 409) {
        // Réservé entre-temps : le planning est relu et le formulaire propose un autre créneau.
        setError(null);
        onConflict();
        return;
      }
      setError(err instanceof Error ? err.message : 'Erreur inattendue.');
    }
  }

  const noSlot = starts.length === 0;

  return (
    <form className="booking-form" onSubmit={submit} noValidate>
      <div className="form-grid">
        <div className="field span-2">
          <label htmlFor={ids.room}>Salle</label>
          <select id={ids.room} value={roomEmail} onChange={(e) => setRoomEmail(e.target.value)}>
            {rooms.map((r) => {
              const full = (startsByRoom.get(r.email) ?? []).length === 0;
              return (
                <option key={r.email} value={r.email} disabled={full}>
                  {r.name}
                  {r.capacity ? ` · ${r.capacity} pers.` : ''}
                  {full ? ' · complète' : ''}
                </option>
              );
            })}
          </select>
          {selectedRoom && (selectedRoom.hasVideo || selectedRoom.hasDisplay || selectedRoom.accessible || selectedRoom.building) && (
            <p className="hint">
              {[selectedRoom.building, selectedRoom.floor, selectedRoom.hasVideo && 'Visioconférence', selectedRoom.hasDisplay && 'Écran', selectedRoom.accessible && 'Accessible PMR']
                .filter(Boolean)
                .join(' · ')}
            </p>
          )}
        </div>

        {slotNotice && (
          <p className="callout callout-warning span-2" role="alert">
            {slotNotice}
          </p>
        )}

        {noSlot ? (
          <p className="callout callout-warning span-2">Plus aucun créneau libre dans cette salle ce jour-là. Choisissez une autre salle ou une autre date.</p>
        ) : (
          <>
            <div className="field">
              <label htmlFor={ids.start}>Début</label>
              <select id={ids.start} value={start} onChange={(e) => setStart(e.target.value)}>
                {starts.map((t) => (
                  <option key={t} value={t}>
                    {t}
                  </option>
                ))}
              </select>
            </div>
            <div className="field">
              <label htmlFor={ids.duration}>Durée</label>
              <select id={ids.duration} value={effectiveDuration} onChange={(e) => setDuration(Number(e.target.value))}>
                {durations.map((d) => (
                  <option key={d} value={d}>
                    {formatDuration(d)} · fin {fromMinutes(toMinutes(start) + d)}
                  </option>
                ))}
              </select>
            </div>
            {maxEnd < toMinutes(rules.dayEnd) && toMinutes(start) + rules.maxDurationMinutes > maxEnd && (
              <p className="hint span-2">La salle est réservée à partir de {fromMinutes(maxEnd)} : la durée est limitée en conséquence.</p>
            )}
          </>
        )}

        <div className="field span-2">
          <label htmlFor={ids.subject}>Objet de la réunion</label>
          <input
            id={ids.subject}
            data-autofocus
            value={subject}
            maxLength={SUBJECT_MAX}
            autoComplete="off"
            placeholder="Ex. : Point d’avancement projet"
            aria-invalid={Boolean(subjectError)}
            aria-describedby={`${ids.subjectHint}${subjectError ? ` ${ids.subjectError}` : ''}`}
            onChange={(e) => {
              setSubject(e.target.value);
              if (subjectError) setSubjectError(null);
            }}
          />
          <p id={ids.subjectHint} className="hint hint-split">
            <span>Visible par les participants. Sans lien ni mise en forme.</span>
            <span aria-hidden="true">
              {subject.length}/{SUBJECT_MAX}
            </span>
          </p>
          {subjectError && (
            <p id={ids.subjectError} className="field-error">
              {subjectError}
            </p>
          )}
        </div>

        <div className="span-2">
          <EmailChips
            label="Participants"
            value={attendees}
            onChange={setAttendees}
            draft={attendeeDraft}
            onDraftChange={setAttendeeDraft}
            allowedDomains={rules.allowedAttendeeDomains}
            max={MAX_ATTENDEES}
            self={me.user.email}
            hint={anyDomain ? 'Appuyez sur Entrée ou tapez une virgule après chaque adresse.' : `Domaines acceptés : ${rules.allowedAttendeeDomains.join(', ')}.`}
          />
        </div>
      </div>

      <div className="callout callout-info">
        <svg viewBox="0 0 24 24" width="18" height="18" aria-hidden="true">
          <circle cx="12" cy="12" r="10" fill="none" stroke="currentColor" strokeWidth="2" />
          <path d="M12 11v6m0-10h.01" stroke="currentColor" strokeWidth="2" strokeLinecap="round" />
        </svg>
        <p>
          Une réunion Teams est créée automatiquement. Vous et vos participants recevez l’invitation par e-mail. Pour annuler, passez par ce
          portail : refuser l’invitation dans Outlook ne libère pas la salle.
        </p>
      </div>

      {error && (
        <p className="callout callout-error" role="alert">
          {error}
        </p>
      )}

      <div className="dialog-actions">
        <button type="button" className="button button-ghost" onClick={onCancel} disabled={submitting}>
          Annuler
        </button>
        <button type="submit" className="button button-primary" disabled={submitting || noSlot || !end}>
          {submitting && <span className="spinner" aria-hidden="true" />}
          {submitting ? 'Réservation en cours…' : `Réserver${start && end ? ` de ${start} à ${end}` : ''}`}
        </button>
      </div>
    </form>
  );
}
