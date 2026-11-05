import { Router, json } from 'express';
import { createRemoteJWKSet, jwtVerify, type JWTVerifyGetKey } from 'jose';
import { odata, type TableClient } from '@azure/data-tables';
import { z } from 'zod';
import type { AuditLog } from './audit.js';
import { clientIp, wrap } from './http.js';
import type { DirectoryRoom, RoomService } from './rooms.js';

export const SYNC_ROLE = 'RoomDirectory.Write';

const payload = z.object({
  rooms: z
    .array(
      z.object({
        email: z
          .string()
          .email()
          .max(320)
          .transform((e) => e.toLowerCase()),
        name: z.string().min(1).max(256),
        capacity: z.number().int().positive().max(10_000).nullable().optional(),
        building: z.string().max(256).nullable().optional(),
        floor: z.string().max(64).nullable().optional(),
        accessible: z.boolean().nullable().optional(),
        hasVideo: z.boolean().nullable().optional(),
        hasDisplay: z.boolean().nullable().optional(),
      }),
    )
    .max(5000),
});

export interface SyncAuthOptions {
  tenantId: string;
  clientId: string;
  syncPrincipalId: string;
  /** Clés de signature Entra ID (injectables pour les tests). */
  keys?: JWTVerifyGetKey;
}

/**
 * Vérifie le jeton présenté par le runbook de synchronisation : signé par notre tenant, émis pour
 * le portail, porteur du rôle RoomDirectory.Write et émis pour l'identité managée attendue.
 */
export function createSyncAuthenticator(opts: SyncAuthOptions) {
  const keys = opts.keys ?? createRemoteJWKSet(new URL(`https://login.microsoftonline.com/${opts.tenantId}/discovery/v2.0/keys`));
  const issuers = [`https://login.microsoftonline.com/${opts.tenantId}/v2.0`, `https://sts.windows.net/${opts.tenantId}/`];
  const audiences = [opts.clientId, `api://${opts.clientId}`];

  return async (authorization: string | undefined): Promise<boolean> => {
    const token = /^Bearer (\S+)$/.exec(authorization ?? '')?.[1];
    if (!token) return false;
    try {
      const { payload: claims } = await jwtVerify(token, keys, { issuer: issuers, audience: audiences, clockTolerance: 60 });
      const roles = Array.isArray(claims.roles) ? claims.roles : [];
      return (
        String(claims.tid).toLowerCase() === opts.tenantId.toLowerCase() &&
        String(claims.oid).toLowerCase() === opts.syncPrincipalId.toLowerCase() &&
        roles.includes(SYNC_ROLE)
      );
    } catch {
      return false;
    }
  };
}

/** Annuaire des salles persistant (une ligne par salle), alimenté par le runbook. */
export class DirectoryStore {
  constructor(private readonly table: TableClient) {}

  async load(): Promise<{ rooms: DirectoryRoom[]; syncedAt: number | null }> {
    const rooms: DirectoryRoom[] = [];
    let syncedAt: number | null = null;
    for await (const e of this.table.listEntities<{ partitionKey: string; email?: string; data?: string; syncedAt?: string }>({
      queryOptions: { filter: odata`PartitionKey eq 'room' or PartitionKey eq 'meta'` },
    })) {
      if (e.partitionKey === 'meta') syncedAt = e.syncedAt ? Date.parse(e.syncedAt) : null;
      else if (e.data) rooms.push(JSON.parse(e.data) as DirectoryRoom);
    }
    return { rooms, syncedAt };
  }

  /** Remplace l'annuaire ; renvoie les adresses ajoutées, modifiées et retirées. */
  async replace(next: DirectoryRoom[]): Promise<{ added: string[]; updated: string[]; removed: string[] }> {
    const { rooms: current } = await this.load();
    const before = new Map(current.map((r) => [r.email, serialize(r)]));
    const added: string[] = [];
    const updated: string[] = [];

    for (const room of next) {
      const data = serialize(room);
      const old = before.get(room.email);
      if (old === data) continue;
      (old === undefined ? added : updated).push(room.email);
      await this.table.upsertEntity({ partitionKey: 'room', rowKey: encodeURIComponent(room.email), email: room.email, data }, 'Replace');
    }
    const kept = new Set(next.map((r) => r.email));
    const removed = [...before.keys()].filter((email) => !kept.has(email));
    for (const email of removed) await this.table.deleteEntity('room', encodeURIComponent(email));
    await this.table.upsertEntity({ partitionKey: 'meta', rowKey: 'sync', syncedAt: new Date().toISOString(), count: next.length }, 'Replace');

    return { added, updated, removed };
  }
}

/** Forme canonique d'une salle : deux salles identiques donnent la même chaîne. */
function serialize(room: DirectoryRoom): string {
  return JSON.stringify({
    email: room.email,
    name: room.name,
    capacity: room.capacity ?? null,
    building: room.building ?? null,
    floor: room.floor ?? null,
    accessible: room.accessible ?? null,
    hasVideo: room.hasVideo ?? null,
    hasDisplay: room.hasDisplay ?? null,
  });
}

export function directoryRouter(deps: {
  authenticate: (authorization: string | undefined) => Promise<boolean>;
  store: DirectoryStore;
  rooms: RoomService;
  audit: AuditLog;
}): Router {
  const router = Router();
  // Annuaire de plusieurs milliers de salles : limite propre à cette route.
  router.post(
    '/room-directory',
    json({ limit: '1mb' }),
    wrap(async (req, res) => {
      res.set('Cache-Control', 'no-store');
      if (!(await deps.authenticate(req.get('authorization')))) {
        await deps.audit.write({ action: 'directory.sync', outcome: 'denied', ip: clientIp(req) });
        return res.status(401).json({ error: 'Non autorisé.' });
      }
      const parsed = payload.safeParse(req.body);
      if (!parsed.success) return res.status(400).json({ error: 'Annuaire invalide.' });

      const unique = [...new Map(parsed.data.rooms.map((r) => [r.email, r])).values()];
      const diff = await deps.store.replace(unique);
      deps.rooms.setDirectory(unique, Date.now());
      if (diff.added.length || diff.updated.length || diff.removed.length) {
        await deps.audit.write({ action: 'directory.sync', outcome: 'success', ip: clientIp(req), details: { count: unique.length, ...diff } });
      }
      res.json({ count: unique.length, added: diff.added.length, updated: diff.updated.length, removed: diff.removed.length });
    }),
  );
  return router;
}
