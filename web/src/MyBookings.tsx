import { useState } from 'react';
import { api, type Booking, type BookingStatus } from './api';
import { formatDate } from './time';

const STATUS: Record<BookingStatus, { label: string; className: string }> = {
  pending: { label: 'En attente', className: 'badge-pending' },
  confirmed: { label: 'Confirmée', className: 'badge-confirmed' },
  declined: { label: 'Refusée par la salle', className: 'badge-declined' },
  cancelled: { label: 'Annulée', className: 'badge-cancelled' },
};

interface Props {
  bookings: Booking[] | null;
  onCancelled: () => void;
  onError: (message: string) => void;
}

export function MyBookings({ bookings, onCancelled, onError }: Props) {
  const [pending, setPending] = useState<string | null>(null);

  async function cancel(booking: Booking) {
    if (!window.confirm(`Annuler la réservation « ${booking.subject} » (${booking.roomName}) ?`)) return;
    setPending(booking.id);
    try {
      await api.cancelBooking(booking.id);
      onCancelled();
    } catch (err) {
      onError(err instanceof Error ? err.message : 'Erreur inattendue.');
    } finally {
      setPending(null);
    }
  }

  return (
    <section className="card">
      <h2>Mes réservations</h2>
      {bookings === null && <p className="muted">Chargement…</p>}
      {bookings?.length === 0 && <p className="muted">Aucune réservation à venir. Cliquez sur un créneau libre pour réserver.</p>}
      <ul className="booking-list">
        {bookings?.map((b) => (
          <li key={b.id}>
            <div className="booking-head">
              <strong>{b.subject}</strong>
              <span className={`badge ${STATUS[b.status].className}`}>{STATUS[b.status].label}</span>
            </div>
            <div className="muted small">
              {b.roomName} · {formatDate(b.start.slice(0, 10))} · {b.start.slice(11)}–{b.end.slice(11)}
            </div>
            <div className="booking-actions">
              {b.joinUrl && b.status !== 'cancelled' && (
                <a href={b.joinUrl} target="_blank" rel="noopener noreferrer">
                  Rejoindre la réunion Teams
                </a>
              )}
              {b.status !== 'cancelled' && (
                <button className="link danger" disabled={pending === b.id} onClick={() => cancel(b)}>
                  {pending === b.id ? 'Annulation…' : 'Annuler'}
                </button>
              )}
            </div>
          </li>
        ))}
      </ul>
    </section>
  );
}
