import { useState } from 'react';
import { api, type Booking, type BookingStatus } from './api';
import { Dialog } from './Dialog';
import { relativeDay } from './time';

const STATUS: Record<BookingStatus, { label: string; className: string; hint?: string }> = {
  pending: { label: 'En attente', className: 'badge-pending', hint: 'La salle confirme automatiquement sous quelques instants.' },
  confirmed: { label: 'Confirmée', className: 'badge-confirmed' },
  declined: { label: 'Refusée', className: 'badge-declined', hint: 'Les règles de la salle n’autorisent pas ce créneau. Annulez-la et choisissez-en un autre.' },
  cancelled: { label: 'Annulée', className: 'badge-cancelled' },
};

interface Props {
  bookings: Booking[] | null;
  today: string;
  onCancelled: (booking: Booking) => void;
  notify: (tone: 'success' | 'error', title: string, message?: string) => void;
}

export function MyBookings({ bookings, today, onCancelled, notify }: Props) {
  const [confirming, setConfirming] = useState<Booking | null>(null);
  const [cancelling, setCancelling] = useState(false);

  async function cancel(booking: Booking) {
    setCancelling(true);
    try {
      await api.cancelBooking(booking.id);
      onCancelled(booking);
      notify('success', 'Réservation annulée', `${booking.roomName} est de nouveau disponible. Les participants sont prévenus.`);
      setConfirming(null);
    } catch (err) {
      notify('error', 'Annulation impossible', err instanceof Error ? err.message : undefined);
    } finally {
      setCancelling(false);
    }
  }

  const visible = (bookings ?? []).filter((b) => b.status !== 'cancelled');
  const groups = new Map<string, Booking[]>();
  for (const b of visible) groups.set(b.start.slice(0, 10), [...(groups.get(b.start.slice(0, 10)) ?? []), b]);

  return (
    <section className="card" aria-labelledby="my-bookings-title">
      <div className="card-header">
        <h2 id="my-bookings-title">Mes réservations</h2>
        {visible.length > 0 && <span className="count">{visible.length}</span>}
      </div>

      {bookings === null ? (
        <div className="skeleton-list" aria-busy="true" aria-label="Chargement des réservations">
          <span className="skeleton" />
          <span className="skeleton" />
        </div>
      ) : visible.length === 0 ? (
        <div className="empty">
          <svg viewBox="0 0 24 24" width="32" height="32" aria-hidden="true">
            <rect x="3" y="5" width="18" height="16" rx="2" fill="none" stroke="currentColor" strokeWidth="1.5" />
            <path d="M3 10h18M8 3v4M16 3v4" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" />
          </svg>
          <p>Aucune réservation à venir.</p>
          <p className="muted small">Choisissez un créneau libre dans le planning pour réserver une salle.</p>
        </div>
      ) : (
        [...groups.entries()].map(([day, items]) => (
          <div key={day} className="booking-group">
            <h3 className="group-title">{relativeDay(day, today)}</h3>
            <ul className="booking-list">
              {items.map((b) => {
                const status = STATUS[b.status];
                return (
                  <li key={b.id} className="booking-item">
                    <div className="booking-time">
                      <span>{b.start.slice(11)}</span>
                      <span className="muted">{b.end.slice(11)}</span>
                    </div>
                    <div className="booking-main">
                      <div className="booking-head">
                        <strong className="booking-subject">{b.subject}</strong>
                        <span className={`badge ${status.className}`}>{status.label}</span>
                      </div>
                      <p className="muted small">
                        {b.roomName}
                        {b.attendees.length > 0 && ` · ${b.attendees.length} participant${b.attendees.length > 1 ? 's' : ''}`}
                      </p>
                      {status.hint && <p className="hint">{status.hint}</p>}
                      <div className="booking-actions">
                        {b.joinUrl && b.status !== 'declined' && (
                          <a className="button button-secondary button-small" href={b.joinUrl} target="_blank" rel="noopener noreferrer">
                            Rejoindre sur Teams
                          </a>
                        )}
                        <button type="button" className="button button-ghost button-small danger" onClick={() => setConfirming(b)}>
                          Annuler
                        </button>
                      </div>
                    </div>
                  </li>
                );
              })}
            </ul>
          </div>
        ))
      )}

      <Dialog
        open={confirming !== null}
        size="small"
        title="Annuler cette réservation ?"
        description={confirming && `${confirming.subject} · ${confirming.roomName} · ${relativeDay(confirming.start.slice(0, 10), today)}, ${confirming.start.slice(11)}–${confirming.end.slice(11)}`}
        onClose={() => !cancelling && setConfirming(null)}
      >
        <p>La salle sera libérée et les participants recevront une annulation par e-mail.</p>
        <div className="dialog-actions">
          <button type="button" className="button button-ghost" data-autofocus onClick={() => setConfirming(null)} disabled={cancelling}>
            Conserver
          </button>
          <button type="button" className="button button-danger" onClick={() => confirming && cancel(confirming)} disabled={cancelling}>
            {cancelling && <span className="spinner" aria-hidden="true" />}
            {cancelling ? 'Annulation…' : 'Annuler la réservation'}
          </button>
        </div>
      </Dialog>
    </section>
  );
}
