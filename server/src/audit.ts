import { randomUUID } from 'node:crypto';
import type { TableClient } from '@azure/data-tables';

export interface AuditEntry {
  action: string;
  outcome: 'success' | 'denied' | 'failure';
  userOid?: string;
  userEmail?: string;
  homeTenantId?: string;
  ip?: string;
  details?: Record<string, unknown>;
}

/**
 * Journal d'audit : table dédiée (preuve durable, rétention maîtrisée) + sortie console
 * collectée par App Service → Log Analytics.
 */
export class AuditLog {
  constructor(private readonly table: TableClient) {}

  async write(entry: AuditEntry): Promise<void> {
    const at = new Date().toISOString();
    console.log(JSON.stringify({ type: 'audit', at, ...entry }));
    try {
      await this.table.createEntity({
        partitionKey: at.slice(0, 7),
        rowKey: `${at}_${randomUUID()}`,
        action: entry.action,
        outcome: entry.outcome,
        userOid: entry.userOid ?? '',
        userEmail: entry.userEmail ?? '',
        homeTenantId: entry.homeTenantId ?? '',
        ip: entry.ip ?? '',
        details: JSON.stringify(entry.details ?? {}),
      });
    } catch (err) {
      console.error(JSON.stringify({ type: 'audit_write_failed', at, message: (err as Error).message }));
    }
  }
}
