import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { api, type Availability, type Booking, type Me, type Room } from './api';
import { BookingForm } from './BookingForm';
import { CalendarView } from './CalendarView';
import { Dialog } from './Dialog';
import { MyBookings } from './MyBookings';
import { roomStatus, slotKey, type RoomStatus } from './status';
import { Timeline } from './Timeline';
import { ToastRegion, useToasts } from './Toasts';
import { addDays, formatDate, isWeekend, nowLocal, relativeDay } from './time';

type View = 'calendar' | 'list';
const VIEW_KEY = 'roomportal.view';
const CAPACITIES = [0, 2, 4, 6, 8, 10, 15, 20];

function readView(): View {
  try {
    const saved = localStorage.getItem(VIEW_KEY);
    if (saved === 'list' || saved === 'calendar') return saved;
  } catch {
    // stockage indisponible : valeur par défaut
  }
  // Petits écrans : la liste est plus lisible que les colonnes du calendrier.
  return window.matchMedia('(max-width: 640px)').matches ? 'list' : 'calendar';
}

/** Heure courante du fuseau des salles, mise à jour toutes les 30 s. */
function useClock(timeZone: string, initial: string): string {
  const [now, setNow] = useState(initial);
  useEffect(() => {
    const tick = () => setNow(nowLocal(timeZone));
    tick();
    const timer = window.setInterval(tick, 30_000);
    return () => window.clearInterval(timer);
  }, [timeZone]);
  return now;
}

interface Draft {
  roomEmail: string;
  start: string | null;
}

export function Portal({ me }: { me: Me }) {
  const clock = useClock(me.rules.timeZone, me.now);
  const today = clock.slice(0, 10);
  const [date, setDate] = useState(() => firstBookableDate(me, me.today));
  const [view, setView] = useState<View>(readView);
  const [rooms, setRooms] = useState<Room[] | null>(null);
  const [availability, setAvailability] = useState<Availability | null>(null);
  const [bookings, setBookings] = useState<Booking[] | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [onlyAvailable, setOnlyAvailable] = useState(false);
  const [minCapacity, setMinCapacity] = useState(0);
  const [draft, setDraft] = useState<Draft | null>(null);
  const { toasts, notify, dismiss } = useToasts();

  // Rafraîchissement en arrière-plan : l'affichage courant reste visible pendant le rechargement,
  // et une réponse arrivée après un changement de date est ignorée.
  const dateRef = useRef(date);
  dateRef.current = date;
  const refreshAvailability = useCallback(() => {
    const requested = dateRef.current;
    api.availability(requested).then(
      (result) => {
        if (dateRef.current !== requested) return;
        setAvailability(result);
        setLoadError(null);
      },
      (e: Error) => setLoadError(e.message),
    );
  }, []);
  const refreshBookings = useCallback(() => {
    api.bookings().then(setBookings, (e: Error) => setLoadError(e.message));
  }, []);
  const loadRooms = useCallback(() => {
    api.rooms().then(
      (list) => {
        setRooms(list);
        setLoadError(null);
      },
      (e: Error) => setLoadError(e.message),
    );
  }, []);

  useEffect(() => {
    loadRooms();
    refreshBookings();
  }, [loadRooms, refreshBookings]);
  useEffect(() => {
    setAvailability(null);
    refreshAvailability();
  }, [date, refreshAvailability]);

  // Passage à minuit : la date affichée ne peut pas rester dans le passé.
  useEffect(() => {
    if (date < today) setDate(firstBookableDate(me, today));
  }, [date, today, me]);

  // Planning tenu à jour pendant que la page est ouverte (réservations des autres utilisateurs) :
  // toutes les 30 s, et dès que l'utilisateur revient sur l'onglet après une absence.
  useEffect(() => {
    const timer = window.setInterval(() => document.visibilityState === 'visible' && refreshAvailability(), 30_000);
    const onReturn = () => document.visibilityState === 'visible' && refreshAvailability();
    document.addEventListener('visibilitychange', onReturn);
    window.addEventListener('focus', onReturn);
    return () => {
      window.clearInterval(timer);
      document.removeEventListener('visibilitychange', onReturn);
      window.removeEventListener('focus', onReturn);
    };
  }, [refreshAvailability]);

  // Tant qu'une salle n'a pas confirmé, le statut de « Mes réservations » est relu toutes les 10 s.
  const hasPending = bookings?.some((b) => b.status === 'pending') ?? false;
  useEffect(() => {
    if (!hasPending) return;
    const timer = window.setInterval(refreshBookings, 10_000);
    return () => window.clearInterval(timer);
  }, [hasPending, refreshBookings]);

  // Une réservation en attente refusée par la salle (créneau pris au même moment depuis Outlook,
  // par exemple) : l'utilisateur est prévenu, pas seulement par le badge.
  const previousStatuses = useRef(new Map<string, Booking['status']>());
  useEffect(() => {
    for (const b of bookings ?? []) {
      if (previousStatuses.current.get(b.id) === 'pending' && b.status === 'declined') {
        notify('error', `${b.roomName} n’a pas pu être réservée`, `Le créneau de ${b.start.slice(11)} a été pris au même moment. Annulez cette demande et choisissez un autre créneau.`);
        refreshAvailability();
      }
      previousStatuses.current.set(b.id, b.status);
    }
  }, [bookings, notify, refreshAvailability]);

  function openBooking(roomEmail: string, start: string | null) {
    setDraft({ roomEmail, start });
    // Disponibilités relues à l'ouverture : le formulaire part de l'état le plus récent.
    refreshAvailability();
  }

  const busyByRoom = useMemo(() => new Map(availability?.rooms.map((r) => [r.email, r.busy]) ?? []), [availability]);
  const mine = useMemo(
    () => new Set((bookings ?? []).filter((b) => b.status !== 'cancelled' && b.status !== 'declined').map(slotKey)),
    [bookings],
  );

  const now = date === today ? clock.slice(11) : null;
  const statusByRoom = useMemo(() => {
    const map = new Map<string, RoomStatus>();
    if (!availability) return map;
    for (const room of rooms ?? []) {
      const status = roomStatus(busyByRoom.get(room.email) ?? null, date, now, me.rules);
      if (status) map.set(room.email, status);
    }
    return map;
  }, [rooms, availability, busyByRoom, date, now, me.rules]);

  // Aujourd'hui : libre à l'instant présent. Autre jour : au moins un créneau libre.
  const isAvailable = useCallback(
    (status: RoomStatus | undefined) => Boolean(status && (now ? status.tone === 'free' || status.tone === 'partial' : status.bookable)),
    [now],
  );

  const visibleRooms = useMemo(
    () => (rooms ?? []).filter((r) => (r.capacity ?? 0) >= minCapacity && (!onlyAvailable || isAvailable(statusByRoom.get(r.email)))),
    [rooms, minCapacity, onlyAvailable, statusByRoom, isAvailable],
  );
  const availableCount = [...statusByRoom.values()].filter(isAvailable).length;
  const firstBookableRoom = visibleRooms.find((r) => statusByRoom.get(r.email)?.bookable);

  async function logout() {
    try {
      const { logoutUrl } = await api.logout();
      window.location.assign(logoutUrl);
    } catch {
      window.location.assign('/');
    }
  }

  function onBooked(booking: Booking) {
    setDraft(null);
    notify(
      'success',
      'Réservation envoyée',
      `${booking.roomName} · ${relativeDay(booking.start.slice(0, 10), today)}, ${booking.start.slice(11)}–${booking.end.slice(11)}. L’invitation Teams arrive par e-mail.`,
    );
    // Affichage immédiat, puis réconciliation avec le serveur.
    setBookings((prev) => [...(prev ?? []).filter((b) => b.id !== booking.id), booking].sort((a, b) => a.start.localeCompare(b.start)));
    setAvailability((prev) => updateSlot(prev, booking, 'add'));
    refreshAvailability();
    refreshBookings();
  }

  function onCancelled(booking: Booking) {
    setBookings((prev) => (prev ?? []).filter((b) => b.id !== booking.id));
    setAvailability((prev) => updateSlot(prev, booking, 'remove'));
    refreshAvailability();
    refreshBookings();
  }

  function changeView(next: View) {
    setView(next);
    try {
      localStorage.setItem(VIEW_KEY, next);
    } catch {
      // stockage indisponible (navigation privée) : la préférence n'est simplement pas retenue
    }
  }

  function retry() {
    setLoadError(null);
    if (!rooms) loadRooms();
    refreshAvailability();
    refreshBookings();
  }

  const weekendBlocked = !me.rules.allowWeekends && isWeekend(date);
  const previousDate = shiftDate(me, today, date, -1);
  const nextDate = shiftDate(me, today, date, 1);
  const homeDate = firstBookableDate(me, today);
  const draftRoom = draft && rooms?.find((r) => r.email === draft.roomEmail);

  const views = { rooms: visibleRooms, busyByRoom, statusByRoom, mine, loading: !availability, rules: me.rules, date, now, onSelect: openBooking };

  return (
    <>
      <a className="skip-link" href="#planning">
        Aller au planning
      </a>
      <header className="topbar">
        <div className="brand">
          <Logo />
          <span className="brand-name">Réservation de salles</span>
          <span className="brand-partner">{me.partnerDisplayName}</span>
        </div>
        <div className="topbar-user">
          <span className="avatar" aria-hidden="true">
            {initials(me.user.name)}
          </span>
          <span className="user-name">
            {me.user.name}
            <span className="user-email">{me.user.email}</span>
          </span>
          <button type="button" className="button button-ghost button-small" onClick={logout}>
            Se déconnecter
          </button>
        </div>
      </header>

      <main className="layout">
        <section className="card planning" id="planning" tabIndex={-1} aria-labelledby="planning-title">
          <div className="planning-header">
            <div className="date-nav">
              <button type="button" className="icon-button bordered" aria-label="Jour précédent" disabled={!previousDate} onClick={() => previousDate && setDate(previousDate)}>
                <Chevron direction="left" />
              </button>
              <div className="date-title-block">
                <h1 id="planning-title" className="date-title">
                  {relativeDay(date, today)}
                </h1>
                {(date === today || date === addDays(today, 1)) && <span className="muted small date-subtitle">{formatDate(date)}</span>}
              </div>
              <button type="button" className="icon-button bordered" aria-label="Jour suivant" disabled={!nextDate} onClick={() => nextDate && setDate(nextDate)}>
                <Chevron direction="right" />
              </button>
              {date !== homeDate && (
                <button type="button" className="button button-ghost button-small" onClick={() => setDate(homeDate)}>
                  Aujourd’hui
                </button>
              )}
            </div>
            <button
              type="button"
              className="button button-primary"
              disabled={!firstBookableRoom || weekendBlocked}
              onClick={() => firstBookableRoom && openBooking(firstBookableRoom.email, null)}
            >
              <svg viewBox="0 0 24 24" width="18" height="18" aria-hidden="true">
                <path d="M12 5v14M5 12h14" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" />
              </svg>
              Nouvelle réservation
            </button>
          </div>

          <div className="filters" role="group" aria-label="Filtres">
            <div className="field field-inline">
              <label htmlFor="filter-date">Date</label>
              <input id="filter-date" type="date" value={date} min={today} max={me.maxDate} onChange={(e) => e.target.value && setDate(e.target.value)} />
            </div>
            <div className="field field-inline">
              <label htmlFor="filter-capacity">Capacité</label>
              <select id="filter-capacity" value={minCapacity} onChange={(e) => setMinCapacity(Number(e.target.value))}>
                {CAPACITIES.map((c) => (
                  <option key={c} value={c}>
                    {c === 0 ? 'Toutes' : `${c} pers. et +`}
                  </option>
                ))}
              </select>
            </div>
            <label className="switch">
              <input type="checkbox" role="switch" checked={onlyAvailable} onChange={(e) => setOnlyAvailable(e.target.checked)} />
              <span className="switch-track" aria-hidden="true" />
              {now ? 'Libres maintenant' : 'Disponibles uniquement'}
            </label>
            <div className="segmented" role="group" aria-label="Affichage">
              <button type="button" className={view === 'calendar' ? 'active' : ''} aria-pressed={view === 'calendar'} onClick={() => changeView('calendar')}>
                Calendrier
              </button>
              <button type="button" className={view === 'list' ? 'active' : ''} aria-pressed={view === 'list'} onClick={() => changeView('list')}>
                Liste
              </button>
            </div>
          </div>

          <div className="planning-summary" aria-live="polite">
            {rooms && rooms.length > 0 && availability && !weekendBlocked && (
              <span>
                <strong>{availableCount}</strong> {now ? 'libre' : 'disponible'}
                {availableCount > 1 ? 's' : ''} sur {rooms.length} salle{rooms.length > 1 ? 's' : ''}
                {now ? ` à ${now}` : ''}
                {visibleRooms.length !== rooms.length && ` · ${visibleRooms.length} affichée${visibleRooms.length > 1 ? 's' : ''}`}
              </span>
            )}
          </div>

          {loadError ? (
            <div className="state state-error" role="alert">
              <p>
                <strong>Le planning n’a pas pu être chargé.</strong>
              </p>
              <p className="muted">{loadError}</p>
              <button type="button" className="button button-secondary" onClick={retry}>
                Réessayer
              </button>
            </div>
          ) : weekendBlocked ? (
            <div className="state">
              <p>Les salles ne sont pas réservables le week-end.</p>
              {nextDate && (
                <button type="button" className="button button-secondary" onClick={() => setDate(nextDate)}>
                  Voir le {formatDate(nextDate)}
                </button>
              )}
            </div>
          ) : rooms === null ? (
            <div className="skeleton-grid" aria-busy="true" aria-label="Chargement des salles">
              {Array.from({ length: 3 }, (_, i) => (
                <span key={i} className="skeleton" />
              ))}
            </div>
          ) : rooms.length === 0 ? (
            <div className="state">
              <p>Aucune salle n’est publiée pour le moment.</p>
              <p className="muted small">Les salles nouvellement créées apparaissent automatiquement, en général sous quelques heures.</p>
            </div>
          ) : visibleRooms.length === 0 ? (
            <div className="state">
              <p>Aucune salle ne correspond à vos filtres.</p>
              <button
                type="button"
                className="button button-secondary"
                onClick={() => {
                  setMinCapacity(0);
                  setOnlyAvailable(false);
                }}
              >
                Réinitialiser les filtres
              </button>
            </div>
          ) : (
            <>
              {view === 'calendar' ? <CalendarView {...views} /> : <Timeline {...views} />}
              <ul className="legend" aria-label="Légende">
                <li>
                  <span className="swatch swatch-free" /> Libre
                </li>
                <li>
                  <span className="swatch swatch-busy" /> Occupée
                </li>
                <li>
                  <span className="swatch swatch-mine" /> Votre réservation
                </li>
                {now && (
                  <li>
                    <span className="swatch swatch-past" /> Passé
                  </li>
                )}
                <li className="legend-tip">
                  {view === 'calendar' ? 'Cliquez sur un créneau libre pour le réserver.' : 'Cliquez sur la barre d’une salle pour réserver.'}
                </li>
              </ul>
            </>
          )}
        </section>

        <aside className="side-column">
          <MyBookings bookings={bookings} today={today} onCancelled={onCancelled} notify={notify} />
        </aside>
      </main>

      <Dialog
        open={draft !== null}
        title={draftRoom ? `Réserver ${draftRoom.name}` : 'Nouvelle réservation'}
        description={relativeDay(date, today) + (date === today || date === addDays(today, 1) ? ` · ${formatDate(date)}` : '')}
        onClose={() => setDraft(null)}
      >
        {draft && rooms && (
          <BookingForm
            me={me}
            rooms={rooms}
            date={date}
            initialRoom={draft.roomEmail}
            initialStart={draft.start}
            busyByRoom={busyByRoom}
            now={now}
            onCancel={() => setDraft(null)}
            onBooked={onBooked}
            onConflict={() => {
              notify('info', 'Créneau déjà réservé', 'Quelqu’un vient de réserver ce créneau. Le planning est mis à jour : choisissez un autre horaire.');
              refreshAvailability();
            }}
          />
        )}
      </Dialog>

      <ToastRegion toasts={toasts} dismiss={dismiss} />
    </>
  );
}

function Logo() {
  return (
    <svg className="logo" viewBox="0 0 32 32" width="28" height="28" aria-hidden="true">
      <rect width="32" height="32" rx="8" fill="currentColor" />
      <rect x="8" y="9" width="16" height="15" rx="2.5" fill="none" stroke="#fff" strokeWidth="2" />
      <path d="M8 14h16M12.5 7v4M19.5 7v4" stroke="#fff" strokeWidth="2" strokeLinecap="round" />
    </svg>
  );
}

function Chevron({ direction }: { direction: 'left' | 'right' }) {
  return (
    <svg viewBox="0 0 24 24" width="20" height="20" aria-hidden="true">
      <path d={direction === 'left' ? 'M15 6l-6 6 6 6' : 'M9 6l6 6-6 6'} stroke="currentColor" strokeWidth="2" fill="none" strokeLinecap="round" strokeLinejoin="round" />
    </svg>
  );
}

function initials(name: string): string {
  const parts = name.trim().split(/\s+/);
  return ((parts[0]?.[0] ?? '') + (parts.length > 1 ? (parts[parts.length - 1]?.[0] ?? '') : '')).toUpperCase() || '?';
}

function firstBookableDate(me: Me, today: string): string {
  let date = today;
  while (!me.rules.allowWeekends && isWeekend(date) && date < me.maxDate) date = addDays(date, 1);
  return date;
}

/** Ajoute ou retire localement le créneau d'une réservation, sans attendre le serveur. */
function updateSlot(availability: Availability | null, booking: Booking, action: 'add' | 'remove'): Availability | null {
  if (!availability || availability.date !== booking.start.slice(0, 10)) return availability;
  return {
    ...availability,
    rooms: availability.rooms.map((room) => {
      if (room.email !== booking.roomEmail.toLowerCase() || !room.busy) return room;
      const others = room.busy.filter((b) => b.start !== booking.start || b.end !== booking.end);
      return { ...room, busy: action === 'add' ? [...others, { start: booking.start, end: booking.end }] : others };
    }),
  };
}

/** Jour réservable précédent ou suivant (week-ends sautés si interdits), ou null hors de la fenêtre. */
function shiftDate(me: Me, today: string, date: string, direction: 1 | -1): string | null {
  let candidate = addDays(date, direction);
  while (!me.rules.allowWeekends && isWeekend(candidate)) candidate = addDays(candidate, direction);
  return candidate < today || candidate > me.maxDate ? null : candidate;
}
