import { randomUUID } from 'node:crypto';
import { z } from 'zod';
import type { AuditLog } from './audit.js';
import type { SessionUser } from './authz.js';
import { GraphError, type GraphClient } from './graph.js';
import { overlaps, type RoomService } from './rooms.js';
import { normalizeAttendees, sanitizeSubject, validateSlot, type BookingRules } from './rules.js';
import type { BookingRecord, BookingStore } from './store.js';
import { nowLocal } from './time.js';

export class BookingError extends Error {
  constructor(
    readonly status: number,
    message: string,
  ) {
    super(message);
  }
}

export type BookingStatus = 'pending' | 'confirmed' | 'declined' | 'cancelled';

export interface BookingView {
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

const bookingInput = z.object({
  roomEmail: z.string().max(320),
  start: z.string().max(16),
  end: z.string().max(16),
  subject: z.string().max(500),
  attendees: z.array(z.string().max(320)).max(50).default([]),
});

interface GraphEvent {
  id: string;
  isCancelled?: boolean;
  attendees?: { type: string; emailAddress: { address: string }; status?: { response?: string } }[];
  onlineMeeting?: { joinUrl?: string } | null;
}

const ID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

export interface BookingServiceDeps {
  graph: GraphClient;
  rooms: RoomService;
  store: BookingStore;
  audit: AuditLog;
  rules: BookingRules;
  organizer: string;
  partnerDisplayName: string;
  publicBaseUrl: string;
  maxActivePerUser: number;
}

export class BookingService {
  constructor(private readonly deps: BookingServiceDeps) {}

  private get eventsPath(): string {
    return `/users/${encodeURIComponent(this.deps.organizer)}/events`;
  }

  async create(user: SessionUser, body: unknown, ip: string): Promise<BookingView> {
    const { rules, rooms, store, graph, audit } = this.deps;
    const parsed = bookingInput.safeParse(body);
    if (!parsed.success) throw new BookingError(400, 'Requête invalide.');
    const input = parsed.data;

    const now = nowLocal(rules.timeZone);
    const slotError = validateSlot(input.start, input.end, rules, now);
    if (slotError) throw new BookingError(400, slotError);

    const subject = sanitizeSubject(input.subject);
    if (!subject.ok) throw new BookingError(400, subject.error);

    const attendees = normalizeAttendees(input.attendees, rules, user.email);
    if (!attendees.ok) throw new BookingError(400, attendees.error);

    const room = await rooms.getRoom(input.roomEmail);
    if (!room) throw new BookingError(400, 'Salle inconnue.');

    const upcoming = await store.listUpcoming(user.oid, now);
    if (upcoming.length >= this.deps.maxActivePerUser) {
      throw new BookingError(409, `Vous avez atteint le maximum de ${this.deps.maxActivePerUser} réservations à venir.`);
    }

    const busy = (await rooms.getBusySlots([room.email], input.start, input.end)).get(room.email);
    if (busy === null || busy === undefined) throw new BookingError(503, "La disponibilité de cette salle n'a pas pu être vérifiée.");
    if (overlaps(busy, input.start, input.end)) throw new BookingError(409, "Ce créneau n'est plus disponible.");

    const id = randomUUID();
    // L'événement est créé dans la boîte organisatrice avec la salle en ressource : c'est le
    // Calendar Attendant de la salle qui accepte ou refuse, selon ses propres règles.
    const event = await graph.request<GraphEvent>('POST', this.eventsPath, {
      body: {
        subject: `[Externe – ${this.deps.partnerDisplayName}] ${subject.value}`,
        body: {
          contentType: 'text',
          content:
            `Réservation effectuée via le portail de réservation des salles par ${user.name} (${user.email}).\n` +
            `Pour modifier ou annuler cette réservation, utilisez le portail : ${this.deps.publicBaseUrl}`,
        },
        start: { dateTime: `${input.start}:00`, timeZone: rules.timeZone },
        end: { dateTime: `${input.end}:00`, timeZone: rules.timeZone },
        location: { displayName: room.name, locationEmailAddress: room.email, locationType: 'conferenceRoom' },
        attendees: [
          { type: 'resource', emailAddress: { address: room.email, name: room.name } },
          { type: 'required', emailAddress: { address: user.email, name: user.name } },
          ...attendees.value.map((address) => ({ type: 'required', emailAddress: { address } })),
        ],
        isOnlineMeeting: true,
        onlineMeetingProvider: 'teamsForBusiness',
        allowNewTimeProposals: false,
        responseRequested: true,
        transactionId: id,
      },
    });

    const record: BookingRecord = {
      partitionKey: user.oid,
      rowKey: id,
      eventId: event.id,
      roomEmail: room.email,
      roomName: room.name,
      start: input.start,
      end: input.end,
      subject: subject.value,
      bookerEmail: user.email,
      attendees: JSON.stringify(attendees.value),
      status: 'active',
      createdAt: new Date().toISOString(),
    };
    try {
      await store.create(record);
    } catch (err) {
      // Pas d'événement orphelin : sans trace en base, l'utilisateur ne pourrait pas l'annuler.
      await graph.request('POST', `${this.eventsPath}/${encodeURIComponent(event.id)}/cancel`, { body: { comment: 'Réservation annulée (erreur technique).' } }).catch(() => undefined);
      throw err;
    }

    rooms.invalidate(input.start.slice(0, 10));
    await audit.write({
      action: 'booking.create',
      outcome: 'success',
      userOid: user.oid,
      userEmail: user.email,
      homeTenantId: user.homeTenantId,
      ip,
      details: { bookingId: id, room: room.email, start: input.start, end: input.end, attendees: attendees.value.length },
    });

    return toView(record, 'pending', event.onlineMeeting?.joinUrl ?? null);
  }

  async listUpcoming(user: SessionUser): Promise<BookingView[]> {
    const { store, graph, rules } = this.deps;
    const records = await store.listUpcoming(user.oid, nowLocal(rules.timeZone));
    return Promise.all(
      records.map(async (record) => {
        try {
          const event = await graph.request<GraphEvent>(
            'GET',
            `${this.eventsPath}/${encodeURIComponent(record.eventId)}?$select=isCancelled,attendees,onlineMeeting`,
          );
          return toView(record, statusOf(event, record.roomEmail), event.onlineMeeting?.joinUrl ?? null);
        } catch (err) {
          if (err instanceof GraphError && err.status === 404) {
            await store.markCancelled(user.oid, record.rowKey);
            return toView(record, 'cancelled', null);
          }
          throw err;
        }
      }),
    );
  }

  async cancel(user: SessionUser, id: string, ip: string): Promise<void> {
    const { store, graph, rooms, audit } = this.deps;
    // La recherche se fait dans la partition de l'utilisateur : impossible d'annuler la réservation d'un autre.
    const record = ID.test(id) ? await store.get(user.oid, id) : undefined;
    if (!record || record.status !== 'active') {
      await audit.write({ action: 'booking.cancel', outcome: 'denied', userOid: user.oid, userEmail: user.email, homeTenantId: user.homeTenantId, ip, details: { bookingId: id.slice(0, 64) } });
      throw new BookingError(404, 'Réservation introuvable.');
    }

    try {
      await graph.request('POST', `${this.eventsPath}/${encodeURIComponent(record.eventId)}/cancel`, {
        body: { comment: `Réunion annulée par ${user.name} via le portail de réservation.` },
      });
    } catch (err) {
      if (!(err instanceof GraphError && err.status === 404)) throw err;
    }
    await store.markCancelled(user.oid, id);
    rooms.invalidate(record.start.slice(0, 10));
    await audit.write({
      action: 'booking.cancel',
      outcome: 'success',
      userOid: user.oid,
      userEmail: user.email,
      homeTenantId: user.homeTenantId,
      ip,
      details: { bookingId: id, room: record.roomEmail, start: record.start },
    });
  }
}

function statusOf(event: GraphEvent, roomEmail: string): BookingStatus {
  if (event.isCancelled) return 'cancelled';
  const response = event.attendees?.find((a) => a.emailAddress.address.toLowerCase() === roomEmail)?.status?.response;
  if (response === 'accepted') return 'confirmed';
  if (response === 'declined') return 'declined';
  return 'pending';
}

function toView(record: BookingRecord, status: BookingStatus, joinUrl: string | null): BookingView {
  return {
    id: record.rowKey,
    roomEmail: record.roomEmail,
    roomName: record.roomName,
    start: record.start,
    end: record.end,
    subject: record.subject,
    attendees: JSON.parse(record.attendees) as string[],
    status,
    joinUrl,
  };
}
