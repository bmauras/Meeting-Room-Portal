import { randomUUID } from 'node:crypto';
import { z } from 'zod';
import type { AuditLog } from './audit.js';
import type { SessionUser } from './authz.js';
import { GraphError, type GraphClient } from './graph.js';
import { overlaps, type RoomService } from './rooms.js';
import { normalizeAttendees, sanitizeSubject, validateSlot, type BookingRules } from './rules.js';
import type { BookingRecord, BookingStore } from './store.js';
import { formatLongDate, nowLocal } from './time.js';

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
  isOnlineMeeting?: boolean;
  onlineMeetingProvider?: string;
  body?: { contentType?: string; content?: string };
}

function escapeHtml(value: string): string {
  return value.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;').replace(/'/g, '&#39;');
}

function teamsBlock(joinUrl: string): string {
  return (
    `<p><b>Réunion Microsoft Teams</b><br>` +
    `<a href="${escapeHtml(joinUrl)}">Rejoindre la réunion</a></p>`
  );
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

  /**
   * Exchange n'ajoute une réunion Teams aux événements que si la boîte organisatrice l'autorise
   * (allowedOnlineMeetingProviders) : sinon isOnlineMeeting est ignoré sans erreur.
   */
  async checkOrganizerOnlineMeetings(): Promise<void> {
    try {
      const calendar = await this.deps.graph.request<{ allowedOnlineMeetingProviders?: string[]; defaultOnlineMeetingProvider?: string }>(
        'GET',
        `/users/${encodeURIComponent(this.deps.organizer)}/calendar?$select=allowedOnlineMeetingProviders,defaultOnlineMeetingProvider`,
      );
      const allowed = calendar.allowedOnlineMeetingProviders ?? [];
      const entry = { type: 'organizer_calendar', organizer: this.deps.organizer, allowedOnlineMeetingProviders: allowed, defaultOnlineMeetingProvider: calendar.defaultOnlineMeetingProvider ?? null };
      if (allowed.includes('teamsForBusiness')) console.log(JSON.stringify(entry));
      else console.warn(JSON.stringify({ ...entry, warning: 'Teams non disponible pour la boîte organisatrice : les réservations seront créées sans lien Teams.' }));
    } catch (err) {
      console.warn(JSON.stringify({ type: 'organizer_calendar_check_failed', message: (err as Error).message }));
    }
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
    // Créneau retenu dès maintenant : une demande concurrente sur le même créneau est refusée
    // sans attendre la création de la réunion (plusieurs secondes).
    if (!rooms.tryHold(room.email, input.start, input.end)) {
      throw new BookingError(409, 'Ce créneau vient d’être réservé par quelqu’un d’autre.');
    }
    let reserved = false;
    try {
      return await this.createEvent(user, input, subject.value, attendees.value, room, ip).then((view) => {
        reserved = true;
        return view;
      });
    } finally {
      if (!reserved) rooms.releaseHold(room.email, input.start, input.end);
    }
  }

  private async createEvent(
    user: SessionUser,
    input: z.infer<typeof bookingInput>,
    subjectText: string,
    attendeeList: string[],
    room: { email: string; name: string },
    ip: string,
  ): Promise<BookingView> {
    const { rules, rooms, store, graph, audit } = this.deps;
    const subject = { value: subjectText };
    const attendees = { value: attendeeList };
    const id = randomUUID();
    const when = `${formatLongDate(input.start.slice(0, 10))}, ${input.start.slice(11)} – ${input.end.slice(11)}`;
    const intro = `<p>Votre réservation a bien été prise en compte : <b>${escapeHtml(room.name)}</b> | ${escapeHtml(when)}</p>`;
    const portal =
      `<p>Pour modifier ou annuler cette réservation, utilisez le portail : ` +
      `<a href="${escapeHtml(this.deps.publicBaseUrl)}">${escapeHtml(this.deps.publicBaseUrl)}</a></p>`;

    // 1. Événement créé SANS participants : aucune invitation ne part encore, Exchange crée la
    //    réunion Teams. La salle sera ajoutée en ressource : c'est son Calendar Attendant qui
    //    accepte ou refuse, selon ses propres règles.
    const event = await graph.request<GraphEvent>('POST', this.eventsPath, {
      body: {
        subject: `[Réservation de salle – ${this.deps.partnerDisplayName}] ${subject.value}`,
        body: { contentType: 'html', content: intro + portal },
        start: { dateTime: `${input.start}:00`, timeZone: rules.timeZone },
        end: { dateTime: `${input.end}:00`, timeZone: rules.timeZone },
        location: { displayName: room.name, locationEmailAddress: room.email, locationType: 'conferenceRoom' },
        isOnlineMeeting: true,
        onlineMeetingProvider: 'teamsForBusiness',
        allowNewTimeProposals: false,
        responseRequested: true,
        transactionId: id,
      },
    });
    const eventPath = `${this.eventsPath}/${encodeURIComponent(event.id)}`;

    // 2. Lien Teams dans le corps (si Exchange ne l'y a pas déjà mis), puis 3. ajout des
    //    participants : les invitations partent une seule fois, avec le lien de la réunion.
    let joinUrl: string | null;
    try {
      const created = await this.withOnlineMeeting(eventPath, event);
      joinUrl = created.onlineMeeting?.joinUrl ?? null;
      const patch: Record<string, unknown> = {
        attendees: [
          { type: 'resource', emailAddress: { address: room.email, name: room.name } },
          { type: 'required', emailAddress: { address: user.email, name: user.name } },
          ...attendees.value.map((address) => ({ type: 'required', emailAddress: { address } })),
        ],
      };
      if (joinUrl && !(created.body?.content ?? '').includes(joinUrl.split('?')[0]!)) {
        patch.body = { contentType: 'html', content: intro + teamsBlock(joinUrl) + portal };
      }
      if (!joinUrl) {
        console.warn(
          JSON.stringify({
            type: 'teams_link_missing',
            bookingId: id,
            isOnlineMeeting: created.isOnlineMeeting ?? null,
            onlineMeetingProvider: created.onlineMeetingProvider ?? null,
          }),
        );
      }
      await graph.request('PATCH', eventPath, { body: patch });
    } catch (err) {
      // Aucun participant n'a encore été invité : suppression silencieuse.
      await graph.request('DELETE', eventPath).catch(() => undefined);
      throw err;
    }

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

    rooms.recordBooking(room.email, input.start, input.end);
    await audit.write({
      action: 'booking.create',
      outcome: 'success',
      userOid: user.oid,
      userEmail: user.email,
      homeTenantId: user.homeTenantId,
      ip,
      // Adresses invitées conservées : le portail envoie des invitations depuis notre domaine.
      details: { bookingId: id, room: room.email, start: input.start, end: input.end, attendees: attendees.value },
    });

    return toView(record, 'pending', joinUrl);
  }

  /** La réunion Teams est parfois rattachée à l'événement quelques instants après sa création. */
  private async withOnlineMeeting(eventPath: string, event: GraphEvent): Promise<GraphEvent> {
    let current = event;
    for (let attempt = 0; !current.onlineMeeting?.joinUrl && attempt < 5; attempt++) {
      await new Promise((resolve) => setTimeout(resolve, 1000));
      current = await this.deps.graph.request<GraphEvent>('GET', `${eventPath}?$select=body,onlineMeeting,isOnlineMeeting,onlineMeetingProvider`);
    }
    return current;
  }

  async listUpcoming(user: SessionUser): Promise<BookingView[]> {
    const { store, graph, rules, rooms } = this.deps;
    const [stored, currentRooms] = await Promise.all([store.listUpcoming(user.oid, nowLocal(rules.timeZone)), rooms.listRooms().catch(() => [])]);
    // Nom actuel de la salle (renommée depuis la réservation), à défaut celui enregistré.
    const names = new Map(currentRooms.map((r) => [r.email, r.name]));
    const records = stored.map((r) => ({ ...r, roomName: names.get(r.roomEmail) ?? r.roomName }));
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
    rooms.recordCancellation(record.roomEmail, record.start, record.end);
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
