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
const AVAILABILITY_TTL_MS = 30 * 1000;
const SCHEDULE_BATCH = 20;
const BUSY_STATUSES = new Set(['busy', 'tentative', 'oof']);

export class RoomService {
  private rooms?: { at: number; value: Room[] };
  private availability = new Map<string, { at: number; value: Map<string, BusySlot[] | null> }>();

  constructor(
    private readonly graph: GraphClient,
    private readonly organizer: string,
    private readonly timeZone: string,
  ) {}

  async listRooms(): Promise<Room[]> {
    if (this.rooms && Date.now() - this.rooms.at < ROOMS_TTL_MS) return this.rooms.value;
    const raw = await this.graph.getAll<GraphRoom>('/places/microsoft.graph.room?$top=100');
    const value = raw
      // Les salles « reserved » sont en accès libre, sans réservation possible.
      .filter((r) => r.emailAddress && r.bookingType !== 'reserved')
      .map((r) => ({
        email: r.emailAddress.toLowerCase(),
        name: r.displayName,
        capacity: r.capacity ?? null,
        building: r.building ?? null,
        floor: r.floorLabel ?? null,
        accessible: r.isWheelChairAccessible ?? false,
        hasVideo: Boolean(r.videoDeviceName),
        hasDisplay: Boolean(r.displayDeviceName),
      }))
      .sort((a, b) => a.name.localeCompare(b.name, 'fr'));
    this.rooms = { at: Date.now(), value };
    return value;
  }

  async getRoom(email: string): Promise<Room | undefined> {
    const rooms = await this.listRooms();
    return rooms.find((r) => r.email === email.toLowerCase());
  }

  /** Occupation de toutes les salles sur une journée (mise en cache quelques secondes). */
  async getDayAvailability(date: string, dayStart: string, dayEnd: string): Promise<Map<string, BusySlot[] | null>> {
    const cached = this.availability.get(date);
    if (cached && Date.now() - cached.at < AVAILABILITY_TTL_MS) return cached.value;
    const rooms = await this.listRooms();
    const value = await this.getBusySlots(
      rooms.map((r) => r.email),
      `${date}T${dayStart}`,
      `${date}T${dayEnd}`,
    );
    this.availability.set(date, { at: Date.now(), value });
    return value;
  }

  invalidate(date: string): void {
    this.availability.delete(date);
  }

  /** `null` pour une salle dont l'occupation n'a pas pu être lue. */
  async getBusySlots(emails: string[], from: string, to: string): Promise<Map<string, BusySlot[] | null>> {
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
