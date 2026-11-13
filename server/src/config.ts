import { z } from 'zod';

const hhmm = z.string().regex(/^([01]\d|2[0-3]):[0-5]\d$/, 'format HH:mm attendu');
const bool = (fallback: 'true' | 'false') =>
  z
    .enum(['true', 'false'])
    .default(fallback)
    .transform((v) => v === 'true');
const roomDirectory = z
  .string()
  .default('[]')
  .transform((s, ctx) => {
    try {
      return JSON.parse(s) as unknown;
    } catch {
      ctx.addIssue({ code: 'custom', message: 'JSON invalide' });
      return z.NEVER;
    }
  })
  .pipe(
    z.array(
      z.object({
        email: z.string().email().transform((e) => e.toLowerCase()),
        name: z.string().min(1),
        capacity: z.number().int().positive().nullable().optional(),
      }),
    ),
  );
const csv = z
  .string()
  .default('')
  .transform((s) => s.split(',').map((x) => x.trim().toLowerCase()).filter(Boolean));

const schema = z
  .object({
    NODE_ENV: z.enum(['development', 'production', 'test']).default('production'),
    PORT: z.coerce.number().int().positive().default(8080),
    PUBLIC_BASE_URL: z
      .string()
      .url()
      .transform((s) => s.replace(/\/+$/, '')),

    TENANT_ID: z.guid(),
    PARTNER_TENANT_ID: z.guid(),
    PARTNER_DISPLAY_NAME: z.string().min(1).max(40),
    ALLOW_INTERNAL_USERS: bool('false'),

    // App registration utilisée pour la connexion OIDC des utilisateurs.
    ENTRA_CLIENT_ID: z.guid(),
    // Développement uniquement : en Azure, la Managed Identity sert de credential fédéré.
    ENTRA_CLIENT_SECRET: z.string().min(1).optional(),
    // Client ID de la Managed Identity (user-assigned) en Azure.
    AZURE_CLIENT_ID: z.guid().optional(),

    ORGANIZER_UPN: z.string().email().transform((s) => s.toLowerCase()),
    // Salles relevées dans Exchange au déploiement, en complément de l'API Places.
    ROOM_DIRECTORY: roomDirectory,
    // Identité managée du runbook qui synchronise l'annuaire des salles (seule autorisée à le mettre à jour).
    SYNC_PRINCIPAL_ID: z.guid().optional(),
    ALLOWED_ATTENDEE_DOMAINS: csv,
    // Salles masquées du portail, séparées par des virgules : adresses exactes ou motifs avec « * ».
    EXCLUDED_ROOMS: csv,

    STORAGE_TABLE_ENDPOINT: z.string().url(),
    STORAGE_CONNECTION_STRING: z.string().optional(),

    SESSION_SECRET: z.string().min(32),

    TIME_ZONE: z.string().default('Europe/Paris'),
    BOOKING_DAY_START: hhmm.default('08:00'),
    BOOKING_DAY_END: hhmm.default('19:00'),
    BOOKING_SLOT_MINUTES: z.coerce.number().int().min(5).max(60).default(15),
    BOOKING_MAX_DURATION_MINUTES: z.coerce.number().int().positive().default(240),
    BOOKING_HORIZON_DAYS: z.coerce.number().int().positive().max(365).default(30),
    BOOKING_MAX_ACTIVE_PER_USER: z.coerce.number().int().positive().default(10),
    BOOKING_ALLOW_WEEKENDS: bool('false'),

    STATIC_DIR: z.string().optional(),
  })
  .superRefine((c, ctx) => {
    if (c.NODE_ENV === 'production') {
      if (!c.AZURE_CLIENT_ID) {
        ctx.addIssue({ code: 'custom', path: ['AZURE_CLIENT_ID'], message: 'requis en production (Managed Identity)' });
      }
      if (!c.PUBLIC_BASE_URL.startsWith('https://')) {
        ctx.addIssue({ code: 'custom', path: ['PUBLIC_BASE_URL'], message: 'HTTPS requis en production' });
      }
      if (c.STORAGE_CONNECTION_STRING) {
        ctx.addIssue({ code: 'custom', path: ['STORAGE_CONNECTION_STRING'], message: 'interdit en production (Managed Identity)' });
      }
    }
    if (c.BOOKING_DAY_START >= c.BOOKING_DAY_END) {
      ctx.addIssue({ code: 'custom', path: ['BOOKING_DAY_END'], message: 'doit être après BOOKING_DAY_START' });
    }
  });

export type Config = z.infer<typeof schema>;

export function loadConfig(env: NodeJS.ProcessEnv = process.env): Config {
  const result = schema.safeParse(env);
  if (!result.success) {
    // Ne jamais journaliser les valeurs : certaines sont des secrets.
    for (const issue of result.error.issues) {
      console.error(`Configuration invalide : ${issue.path.join('.')} — ${issue.message}`);
    }
    process.exit(1);
  }
  return result.data;
}
