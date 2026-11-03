import { useCallback, useEffect, useMemo, useState } from 'react';
import { api, type Availability, type Booking, type Me, type Room } from './api';
import { BookingForm, type Draft } from './BookingForm';
import { MyBookings } from './MyBookings';
import { Timeline } from './Timeline';
import { addDays, formatDate, isWeekend } from './time';

export function Portal({ me }: { me: Me }) {
  const [date, setDate] = useState(() => firstBookableDate(me));
  const [rooms, setRooms] = useState<Room[]>([]);
  const [availability, setAvailability] = useState<Availability | null>(null);
  const [bookings, setBookings] = useState<Booking[] | null>(null);
  const [minCapacity, setMinCapacity] = useState(0);
  const [search, setSearch] = useState('');
  const [draft, setDraft] = useState<Draft | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);

  const refreshAvailability = useCallback(() => {
    setAvailability(null);
    api.availability(date).then(setAvailability, (e: Error) => setError(e.message));
  }, [date]);
  const refreshBookings = useCallback(() => {
    api.bookings().then(setBookings, (e: Error) => setError(e.message));
  }, []);

  useEffect(() => {
    api.rooms().then(setRooms, (e: Error) => setError(e.message));
    refreshBookings();
  }, [refreshBookings]);
  useEffect(refreshAvailability, [refreshAvailability]);

  const visibleRooms = useMemo(() => {
    const q = search.trim().toLowerCase();
    return rooms.filter(
      (r) =>
        (r.capacity ?? 0) >= minCapacity &&
        (!q || r.name.toLowerCase().includes(q) || (r.building ?? '').toLowerCase().includes(q)),
    );
  }, [rooms, minCapacity, search]);

  const busyByRoom = useMemo(() => new Map(availability?.rooms.map((r) => [r.email, r.busy]) ?? []), [availability]);

  async function logout() {
    const { logoutUrl } = await api.logout();
    window.location.assign(logoutUrl);
  }

  function onBooked(booking: Booking) {
    setDraft(null);
    setNotice(
      `Demande envoyée pour « ${booking.roomName} ». La salle confirme automatiquement sous quelques instants ; l'invitation Teams arrive dans votre boîte ${me.user.email}.`,
    );
    refreshAvailability();
    refreshBookings();
  }

  const weekendBlocked = !me.rules.allowWeekends && isWeekend(date);

  return (
    <>
      <header className="topbar">
        <div>
          <strong>Réservation de salles</strong>
          <span className="muted"> · Accès {me.partnerDisplayName}</span>
        </div>
        <div className="topbar-user">
          <span>{me.user.name}</span>
          <button className="button button-ghost" onClick={logout}>
            Se déconnecter
          </button>
        </div>
      </header>

      <main className="layout">
        <section className="main-column">
          {error && (
            <p className="alert alert-error" role="alert">
              {error}{' '}
              <button className="link" onClick={() => setError(null)}>
                Fermer
              </button>
            </p>
          )}
          {notice && (
            <p className="alert alert-success" role="status">
              {notice}{' '}
              <button className="link" onClick={() => setNotice(null)}>
                Fermer
              </button>
            </p>
          )}

          <div className="card">
            <div className="toolbar">
              <label>
                Date
                <input
                  type="date"
                  value={date}
                  min={me.today}
                  max={me.maxDate}
                  onChange={(e) => e.target.value && setDate(e.target.value)}
                />
              </label>
              <label>
                Capacité min.
                <input type="number" min={0} max={200} value={minCapacity} onChange={(e) => setMinCapacity(Number(e.target.value) || 0)} />
              </label>
              <label className="grow">
                Rechercher
                <input type="search" placeholder="Salle, bâtiment…" value={search} onChange={(e) => setSearch(e.target.value)} />
              </label>
            </div>
            <h2 className="date-title">{formatDate(date)}</h2>
            {weekendBlocked ? (
              <p className="muted">Les réservations ne sont pas possibles le week-end.</p>
            ) : (
              <Timeline
                rooms={visibleRooms}
                busyByRoom={busyByRoom}
                loading={!availability}
                rules={me.rules}
                now={date === me.today ? me.now.slice(11) : null}
                selection={draft}
                onSelect={(roomEmail, start) => setDraft({ roomEmail, start, date })}
              />
            )}
          </div>
        </section>

        <aside className="side-column">
          {draft && (
            <BookingForm
              me={me}
              rooms={rooms}
              draft={draft}
              busy={busyByRoom.get(draft.roomEmail) ?? null}
              onCancel={() => setDraft(null)}
              onBooked={onBooked}
            />
          )}
          <MyBookings
            bookings={bookings}
            onCancelled={() => {
              refreshBookings();
              refreshAvailability();
            }}
            onError={setError}
          />
        </aside>
      </main>
    </>
  );
}

function firstBookableDate(me: Me): string {
  let date = me.today;
  while (!me.rules.allowWeekends && isWeekend(date) && date < me.maxDate) date = addDays(date, 1);
  return date;
}
