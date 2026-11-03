import { odata, type TableClient } from '@azure/data-tables';

export interface BookingRecord {
  /** oid de l'utilisateur : toute lecture passe par sa partition, ce qui garantit l'appartenance. */
  partitionKey: string;
  rowKey: string;
  eventId: string;
  roomEmail: string;
  roomName: string;
  start: string;
  end: string;
  subject: string;
  bookerEmail: string;
  attendees: string;
  status: 'active' | 'cancelled';
  createdAt: string;
  cancelledAt?: string;
}

export class BookingStore {
  constructor(private readonly table: TableClient) {}

  async create(record: BookingRecord): Promise<void> {
    await this.table.createEntity(record);
  }

  async get(oid: string, id: string): Promise<BookingRecord | undefined> {
    try {
      return await this.table.getEntity<BookingRecord>(oid, id);
    } catch (err) {
      if ((err as { statusCode?: number }).statusCode === 404) return undefined;
      throw err;
    }
  }

  /** Réservations actives qui ne sont pas encore terminées. */
  async listUpcoming(oid: string, now: string): Promise<BookingRecord[]> {
    const items: BookingRecord[] = [];
    const iterator = this.table.listEntities<BookingRecord>({
      queryOptions: { filter: odata`PartitionKey eq ${oid} and status eq 'active' and end gt ${now}` },
    });
    for await (const entity of iterator) items.push(entity);
    return items.sort((a, b) => a.start.localeCompare(b.start));
  }

  async markCancelled(oid: string, id: string): Promise<void> {
    await this.table.updateEntity(
      { partitionKey: oid, rowKey: id, status: 'cancelled', cancelledAt: new Date().toISOString() },
      'Merge',
    );
  }
}
