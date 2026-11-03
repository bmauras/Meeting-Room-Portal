export interface Rules {
  timeZone: string;
  dayStart: string;
  dayEnd: string;
  slotMinutes: number;
  maxDurationMinutes: number;
  horizonDays: number;
  allowWeekends: boolean;
  maxActivePerUser: number;
  allowedAttendeeDomains: string[];
}

export interface Me {
  user: { name: string; email: string };
  partnerDisplayName: string;
  now: string;
  today: string;
  maxDate: string;
  rules: Rules;
}

export interface Room {
  email: string;
  name: string;
  capacity: number | null;
  building: string | null;
  floor: string | null;
  accessible: boolean;
  hasVideo: boolean;
  hasDisplay: boolean;
}

export interface BusySlot {
  start: string;
  end: string;
}

export interface Availability {
  date: string;
  rooms: { email: string; busy: BusySlot[] | null }[];
}

export type BookingStatus = 'pending' | 'confirmed' | 'declined' | 'cancelled';

export interface Booking {
  id: string;
  roomEmail: string;
  roomName: string;
  start: string;
  end: string;
  subject: string;
  attendees: string[];
  status: BookingStatus;
  joinUrl: string | null;
}

export interface NewBooking {
  roomEmail: string;
  start: string;
  end: string;
  subject: string;
  attendees: string[];
}

export class ApiError extends Error {
  constructor(
    readonly status: number,
    message: string,
  ) {
    super(message);
  }
}

async function call<T>(method: string, url: string, body?: unknown): Promise<T> {
  const res = await fetch(url, {
    method,
    credentials: 'same-origin',
    headers: {
      Accept: 'application/json',
      'X-Requested-With': 'XMLHttpRequest',
      ...(body !== undefined ? { 'Content-Type': 'application/json' } : {}),
    },
    body: body !== undefined ? JSON.stringify(body) : undefined,
  });
  if (!res.ok) {
    const data = (await res.json().catch(() => ({}))) as { error?: string };
    throw new ApiError(res.status, data.error ?? 'Une erreur inattendue est survenue.');
  }
  if (res.status === 204) return undefined as T;
  return (await res.json()) as T;
}

export const api = {
  me: () => call<Me>('GET', '/api/me'),
  rooms: () => call<Room[]>('GET', '/api/rooms'),
  availability: (date: string) => call<Availability>('GET', `/api/availability?date=${encodeURIComponent(date)}`),
  bookings: () => call<Booking[]>('GET', '/api/bookings'),
  createBooking: (booking: NewBooking) => call<Booking>('POST', '/api/bookings', booking),
  cancelBooking: (id: string) => call<void>('DELETE', `/api/bookings/${encodeURIComponent(id)}`),
  logout: () => call<{ logoutUrl: string }>('POST', '/auth/logout'),
};
