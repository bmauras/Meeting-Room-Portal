import type { GraphClient } from './graph.js';
import { graphToLocal } from './time.js';

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

/** Plage occupée, en heure locale. Le sujet des réunions n'est jamais exposé. */
export interface BusySlot {
  start: string;
  end: string;
}

interface GraphRoom {
  emailAddress: string;
  displayName: string;
  capacity?: number | null;
  building?: string | null;
  floorLabel?: string | null;
  isWheelChairAccessible?: boolean;
  videoDeviceName?: string | null;
  displayDeviceName?: string | null;
  bookingType?: string;
}

interface GraphSchedule {
  scheduleId: string;
  scheduleItems?: { status: string; start: { dateTime: string; timeZone: string }; end: { dateTime: string; timeZone: string } }[];
  error?: { message?: string; responseCode?: string };
}

const ROOMS_TTL_MS = 60 * 60 * 1000;
// Une liste vide est souvent transitoire (synchronisation Exchange → Places) : on la relit vite.
const EMPTY_ROOMS_TTL_MS = 2 * 60 * 1000;
const AVAILABILITY_TTL_MS = 30 * 1000;
const SCHEDULE_BATCH = 20;
const BUSY_STATUSES = new Set(['busy', 'tentative', 'oof']);
// Largement au-delà du délai de traitement d'une salle (quelques secondes à une minute).
const RECENT_CHANGE_TTL_MS = 10 * 60 * 1000;

interface RecentChange {
  kind: 'booked' | 'cancelled';
  room: string;
  start: string;
  end: string;
  at: number;
}

/** Salle relevée dans Exchange (runbook de synchronisation, ou étape Exchange du déploiement). */
export interface DirectoryRoom {
  email: string;
  name: string;
  capacity?: number | null;
  // Détails lus par le runbook (Get-Place) ; absents si ce droit n'est pas disponible.
  building?: string | null;
  floor?: string | null;
  accessible?: boolean | null;
  hasVideo?: boolean | null;
  hasDisplay?: boolean | null;
}

function placeToRoom(p: GraphRoom): Room {
  return {
    email: p.emailAddress.toLowerCase(),
    name: p.displayName,
    capacity: p.capacity ?? null,
    building: p.building ?? null,
    floor: p.floorLabel ?? null,
    accessible: p.isWheelChairAccessible ?? false,
    hasVideo: Boolean(p.videoDeviceName),
    hasDisplay: Boolean(p.displayDeviceName),
  };
}

/** Salle de l'annuaire Exchange : chaque valeur connue d'Exchange prime sur Places, qui peut être en retard. */
function directoryToRoom(d: DirectoryRoom, place: Room | undefined): Room {
  return {
    email: d.email,
    name: d.name,
    capacity: d.capacity ?? place?.capacity ?? null,
    building: d.building ?? place?.building ?? null,
    floor: d.floor ?? place?.floor ?? null,
    accessible: d.accessible ?? place?.accessible ?? false,
    hasVideo: d.hasVideo ?? place?.hasVideo ?? false,
    hasDisplay: d.hasDisplay ?? place?.hasDisplay ?? false,
  };
}

// Au-delà, le runbook (toutes les 15 min) est considéré en panne : retour à Places + annuaire.
const DIRECTORY_FRESH_MS = 2 * 60 * 60 * 1000;

export class RoomService {
  private rooms?: { at: number; value: Room[] };
  private loading?: Promise<Room[]>;
  private availability = new Map<string, { at: number; value: Map<string, BusySlot[] | null> }>();
  private recent = new Map<string, RecentChange>();
  private directorySyncedAt: number | null = null;

  constructor(
    private readonly graph: GraphClient,
    private readonly organizer: string,
    private readonly timeZone: string,
    private directory: DirectoryRoom[] = [],
  ) {}

  /** Annuaire Exchange à jour : pris en compte immédiatement. */
  setDirectory(rooms: DirectoryRoom[], syncedAt: number | null): void {
    this.directory = rooms;
    this.directorySyncedAt = syncedAt;
    this.rooms = undefined;
  }

  async listRooms(): Promise<Room[]> {
    if (this.rooms && Date.now() - this.rooms.at < (this.rooms.value.length ? ROOMS_TTL_MS : EMPTY_ROOMS_TTL_MS)) {
      return this.rooms.value;
    }
    // Requêtes simultanées (salles + planning) : un seul appel Graph.
    this.loading ??= this.loadRooms().finally(() => {
      this.loading = undefined;
    });
    return this.loading;
  }

  private async loadRooms(): Promise<Room[]> {
    let fromPlaces: GraphRoom[] = [];
    try {
      fromPlaces = await this.fetchRooms();
    } catch (err) {
      // Places indisponible : l'annuaire Exchange suffit à afficher les salles.
      if (this.directory.length === 0) throw err;
      console.warn(JSON.stringify({ type: 'places_unavailable', message: (err as Error).message }));
    }
    // Les salles « reserved » sont en accès libre, sans réservation possible.
    const reserved = new Set(fromPlaces.filter((p) => p.bookingType === 'reserved').map((p) => p.emailAddress.toLowerCase()));
    const places = new Map(fromPlaces.filter((p) => p.emailAddress).map((p) => [p.emailAddress.toLowerCase(), placeToRoom(p)]));

    // Annuaire synchronisé récemment : il fait foi, pour la liste des salles (ajouts et suppressions)
    // comme pour leurs informations ; Places ne complète que ce qu'Exchange n'a pas fourni. Sinon :
    // Places, complété par l'annuaire pour les salles pas encore synchronisées.
    const authoritative = this.directory.length > 0 && this.directorySyncedAt !== null && Date.now() - this.directorySyncedAt < DIRECTORY_FRESH_MS;
    const fromDirectory = this.directory.filter((r) => !places.has(r.email));
    const merged = authoritative
      ? this.directory.map((d) => directoryToRoom(d, places.get(d.email)))
      : [...places.values(), ...fromDirectory.map((d) => directoryToRoom(d, undefined))];
    const value = merged.filter((r) => !reserved.has(r.email)).sort((a, b) => a.name.localeCompare(b.name, 'fr'));
    this.rooms = { at: Date.now(), value };
    console.log(
      JSON.stringify({ type: 'rooms_loaded', count: value.length, places: fromPlaces.length, directoryOnly: fromDirectory.length, source: authoritative ? 'directory' : 'places' }),
    );
    return value;
  }

  /** Toutes les salles de Places, y compris celles qui ne sont exposées qu'au travers d'une liste de salles. */
  private async fetchRooms(): Promise<GraphRoom[]> {
    const byEmail = new Map<string, GraphRoom>();
    const add = (rooms: GraphRoom[]) => {
      for (const room of rooms) if (room.emailAddress) byEmail.set(room.emailAddress.toLowerCase(), room);
    };

    add(await this.graph.getAll<GraphRoom>('/places/microsoft.graph.room?$top=100'));
    const lists = await this.graph.getAll<{ emailAddress?: string }>('/places/microsoft.graph.roomlist?$top=100');
    for (const list of lists) {
      if (!list.emailAddress) continue;
      add(await this.graph.getAll<GraphRoom>(`/places/${encodeURIComponent(list.emailAddress)}/microsoft.graph.roomlist/rooms?$top=100`));
    }
    return [...byEmail.values()];
  }

  async getRoom(email: string): Promise<Room | undefined> {
    const rooms = await this.listRooms();
    return rooms.find((r) => r.email === email.toLowerCase());
  }

  /** Occupation de toutes les salles sur une journée (mise en cache quelques secondes). */
  async getDayAvailability(date: string, dayStart: string, dayEnd: string): Promise<Map<string, BusySlot[] | null>> {
    const from = `${date}T${dayStart}`;
    const to = `${date}T${dayEnd}`;
    const cached = this.availability.get(date);
    if (cached && Date.now() - cached.at < AVAILABILITY_TTL_MS) return this.withRecentChanges(cached.value, from, to);
    const rooms = await this.listRooms();
    const value = await this.fetchBusySlots(
      rooms.map((r) => r.email),
      from,
      to,
    );
    this.availability.set(date, { at: Date.now(), value });
    return this.withRecentChanges(value, from, to);
  }

  /**
   * La salle accepte ou libère un créneau de façon asynchrone (Calendar Attendant) : pendant ce
   * délai, son calendrier ne reflète pas encore la réservation ou l'annulation faite via le portail.
   */
  recordBooking(roomEmail: string, start: string, end: string): void {
    this.recordChange('booked', roomEmail, start, end);
  }

  recordCancellation(roomEmail: string, start: string, end: string): void {
    this.recordChange('cancelled', roomEmail, start, end);
  }

  /**
   * Retient un créneau le temps de créer la réunion. Vérification et enregistrement sont faits sans
   * interruption (JavaScript est mono-thread) : de deux demandes simultanées sur le même créneau,
   * une seule obtient la réservation.
   */
  tryHold(roomEmail: string, start: string, end: string): boolean {
    const room = roomEmail.toLowerCase();
    const now = Date.now();
    for (const change of this.recent.values()) {
      if (change.kind === 'booked' && change.room === room && now - change.at <= RECENT_CHANGE_TTL_MS && change.start < end && change.end > start) {
        return false;
      }
    }
    this.recordChange('booked', room, start, end);
    return true;
  }

  /** Libère un créneau retenu dont la réservation a échoué. */
  releaseHold(roomEmail: string, start: string, end: string): void {
    const key = `${roomEmail.toLowerCase()}|${start}|${end}`;
    if (this.recent.get(key)?.kind === 'booked') {
      this.recent.delete(key);
      this.availability.delete(start.slice(0, 10));
    }
  }

  private recordChange(kind: RecentChange['kind'], roomEmail: string, start: string, end: string): void {
    const room = roomEmail.toLowerCase();
    this.recent.set(`${room}|${start}|${end}`, { kind, room, start, end, at: Date.now() });
    this.availability.delete(start.slice(0, 10));
  }

  /** Applique les réservations et annulations récentes qu'Exchange n'a peut-être pas encore traitées. */
  private withRecentChanges(value: Map<string, BusySlot[] | null>, from: string, to: string): Map<string, BusySlot[] | null> {
    const now = Date.now();
    for (const [key, change] of this.recent) if (now - change.at > RECENT_CHANGE_TTL_MS) this.recent.delete(key);
    if (this.recent.size === 0) return value;

    const result = new Map(value);
    for (const change of this.recent.values()) {
      if (change.end <= from || change.start >= to) continue;
      const busy = result.get(change.room);
      if (!busy) continue;
      if (change.kind === 'cancelled') {
        result.set(change.room, busy.filter((b) => b.start !== change.start || b.end !== change.end));
      } else if (!busy.some((b) => b.start === change.start && b.end === change.end)) {
        result.set(change.room, [...busy, { start: change.start, end: change.end }]);
      }
    }
    return result;
  }

  /** `null` pour une salle dont l'occupation n'a pas pu être lue. */
  async getBusySlots(emails: string[], from: string, to: string): Promise<Map<string, BusySlot[] | null>> {
    return this.withRecentChanges(await this.fetchBusySlots(emails, from, to), from, to);
  }

  private async fetchBusySlots(emails: string[], from: string, to: string): Promise<Map<string, BusySlot[] | null>> {
    const result = new Map<string, BusySlot[] | null>();
    for (let i = 0; i < emails.length; i += SCHEDULE_BATCH) {
      const batch = emails.slice(i, i + SCHEDULE_BATCH);
      const res = await this.graph.request<{ value: GraphSchedule[] }>(
        'POST',
        `/users/${encodeURIComponent(this.organizer)}/calendar/getSchedule`,
        {
          body: {
            schedules: batch,
            startTime: { dateTime: `${from}:00`, timeZone: this.timeZone },
            endTime: { dateTime: `${to}:00`, timeZone: this.timeZone },
            availabilityViewInterval: 15,
          },
        },
      );
      for (const schedule of res.value) {
        const email = schedule.scheduleId.toLowerCase();
        if (schedule.error) {
          result.set(email, null);
          continue;
        }
        result.set(
          email,
          (schedule.scheduleItems ?? [])
            .filter((item) => BUSY_STATUSES.has(item.status))
            .map((item) => ({ start: graphToLocal(item.start, this.timeZone), end: graphToLocal(item.end, this.timeZone) })),
        );
      }
    }
    return result;
  }
}

export function overlaps(busy: BusySlot[], start: string, end: string): boolean {
  return busy.some((b) => b.start < end && b.end > start);
}
